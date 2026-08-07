from __future__ import annotations

import hashlib
import json
import re
import shlex
import subprocess
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path, PurePosixPath
from typing import Any, override

import harbor
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_BUNDLE_FILES = (
    "extension.js",
    "harbor-telemetry.mjs",
    "node_modules/pi-xk-core/package.json",
    "node_modules/typebox/package.json",
    "pi-agent-core.tgz",
    "pi-ai.tgz",
    "pi-tui.tgz",
    "pi-coding-agent.tgz",
)
_BUNDLE_MANIFEST_FILENAME = "manifest.json"
_BUNDLE_MANIFEST_SCHEMA = "pi-xk.harbor-extension-bundle.v2"
_PROBE_NODE_MAJOR = 22
_PI_RUNTIME_ARCHIVES = (
    "pi-agent-core.tgz",
    "pi-ai.tgz",
    "pi-tui.tgz",
    "pi-coding-agent.tgz",
)
_PROVIDER_ENV_KEYS: dict[str, tuple[str, ...]] = {
    "amazon-bedrock": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"),
    "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "github-copilot": ("GITHUB_TOKEN",),
    "google": (
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_API_KEY",
    ),
    "groq": ("GROQ_API_KEY",),
    "huggingface": ("HF_TOKEN",),
    "mistral": ("MISTRAL_API_KEY",),
    "openai": ("OPENAI_API_KEY", "OPENAI_BASE_URL"),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
}


def _harbor_runtime_identity() -> tuple[str, str]:
    try:
        version = package_version("harbor")
    except PackageNotFoundError as error:
        raise ValueError("Harbor package metadata is unavailable") from error

    package_path = Path(harbor.__file__).resolve()
    source_root = next((parent for parent in package_path.parents if (parent / ".git").exists()), None)
    if source_root is None:
        raise ValueError("Harbor must run from a pinned Git checkout")
    try:
        commit = subprocess.run(
            ["git", "-C", str(source_root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", str(source_root), "status", "--porcelain", "--untracked-files=all"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("Unable to verify the Harbor source checkout") from error
    if not _is_lowercase_hex(commit, length=40):
        raise ValueError("Harbor source commit is invalid")
    if dirty:
        raise ValueError("Harbor source checkout must be clean")
    return version, commit


async def _install_probe_pi(
    agent: Pi,
    environment: BaseEnvironment,
    version: str,
    archives: tuple[str, ...],
) -> None:
    if not archives:
        raise ValueError("Pi runtime package archives are required")
    archive_args = " ".join(shlex.quote(archive) for archive in archives)
    await agent.exec_as_agent(
        environment,
        command=(
            "set -euo pipefail; "
            f"node --version | grep -Eq '^v{_PROBE_NODE_MAJOR}\\.'; "
            "npm --version; "
            f"npm install -g --ignore-scripts {archive_args}; "
            f"test \"$(pi --version)\" = {shlex.quote(version)}"
        ),
    )


class PiXk(Pi):
    """Harbor adapter that loads one verified Pi-XK bundle per isolated trial."""

    _OUTPUT_FILENAME = "pi-xk-telemetry.jsonl"
    _SUMMARY_FILENAME = "pi-xk-summary.json"
    _BUNDLE_TARGET = "/opt/pi-xk-extension"
    _RUNTIME_EXTENSION_DIRECTORY = "pi-xk-harbor-extension"
    _SESSION_DIR = "/logs/agent/pi-xk/sessions"

    def __init__(
        self,
        logs_dir: Path,
        extension_bundle_dir: Path | str,
        extension_target: str = _BUNDLE_TARGET,
        *args: Any,
        model_name: str | None = None,
        version: str | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        self._extension_bundle_dir = Path(extension_bundle_dir).resolve()
        self._extension_target = extension_target.rstrip("/")
        self._runtime_extension_target: str | None = None
        (
            self._bundle_source_commit,
            self._bundle_pi_version,
            self._runtime_archive_digest,
            self._bundle_content_digest,
        ) = self._validate_bundle()
        self._harbor_version, self._harbor_source_commit = _harbor_runtime_identity()
        self._pi_runtime_archives = _runtime_archive_paths(self._extension_bundle_dir)
        if version is not None and version != self._bundle_pi_version:
            raise ValueError(
                "Pi-XK bundle Pi version does not match the requested Pi version"
            )
        provider = model_name.split("/", 1)[0] if model_name else ""
        provider_env = _PROVIDER_ENV_KEYS.get(provider, ())
        filtered_extra_env = {
            key: value for key, value in (extra_env or {}).items() if key in provider_env
        }
        super().__init__(
            logs_dir,
            *args,
            model_name=model_name,
            version=self._bundle_pi_version,
            extra_env=filtered_extra_env,
            **kwargs,
        )

    @staticmethod
    @override
    def name() -> str:
        return "pi-xk"

    def _validate_bundle(self) -> tuple[str, str, str, str]:
        if not self._extension_bundle_dir.is_dir():
            raise ValueError("Pi-XK bundle directory does not exist")

        manifest_path = self._extension_bundle_dir / _BUNDLE_MANIFEST_FILENAME
        try:
            manifest = json.loads(manifest_path.read_text())
        except FileNotFoundError as error:
            raise ValueError("Pi-XK bundle is missing manifest.json") from error
        except json.JSONDecodeError as error:
            raise ValueError("Pi-XK bundle manifest is not valid JSON") from error

        if not isinstance(manifest, dict) or manifest.get("schema") != _BUNDLE_MANIFEST_SCHEMA:
            raise ValueError("Pi-XK bundle manifest schema is invalid")
        source_commit = manifest.get("sourceCommit")
        if not isinstance(source_commit, str) or not _is_lowercase_hex(source_commit, length=40):
            raise ValueError("Pi-XK bundle manifest sourceCommit is invalid")
        pi_version = manifest.get("piVersion")
        if not isinstance(pi_version, str) or not _is_package_version(pi_version):
            raise ValueError("Pi-XK bundle manifest piVersion is invalid")
        manifest_files = manifest.get("files")
        if not isinstance(manifest_files, list) or not manifest_files:
            raise ValueError("Pi-XK bundle manifest files are invalid")

        listed_files: dict[str, str] = {}
        for entry in manifest_files:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
                raise ValueError("Pi-XK bundle manifest file entry is invalid")
            relative_path = entry["path"]
            digest = entry["sha256"]
            if not isinstance(relative_path, str) or not _is_bundle_relative_path(relative_path):
                raise ValueError("Pi-XK bundle manifest contains an unsafe file path")
            if not isinstance(digest, str) or not _is_lowercase_hex(digest, length=64):
                raise ValueError("Pi-XK bundle manifest contains an invalid file digest")
            if relative_path in listed_files:
                raise ValueError("Pi-XK bundle manifest contains duplicate file paths")
            listed_files[relative_path] = digest

        actual_files = _bundle_files_on_disk(self._extension_bundle_dir, "Pi-XK bundle")
        missing = [relative_path for relative_path in _BUNDLE_FILES if relative_path not in actual_files]
        if missing:
            raise ValueError(f"Pi-XK bundle is incomplete: {', '.join(missing)}")
        if set(listed_files) != set(actual_files):
            raise ValueError("Pi-XK bundle manifest file list does not match bundle contents")
        for relative_path, expected_digest in listed_files.items():
            actual_digest = _sha256_file(self._extension_bundle_dir / relative_path)
            if actual_digest != expected_digest:
                raise ValueError(f"Pi-XK bundle file digest mismatch: {relative_path}")
        return (
            source_commit,
            pi_version,
            _runtime_archive_digest(listed_files),
            _bundle_content_digest(listed_files),
        )

    def _trial_profile_suffix(self) -> str:
        identity = self.session_id or self.logs_dir.as_posix()
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]

    def _provider_env(self, provider: str) -> dict[str, str]:
        return {
            key: value
            for key in _PROVIDER_ENV_KEYS.get(provider, ())
            if (value := self._get_env(key))
        }

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await environment.upload_dir(self._extension_bundle_dir, self._extension_target)
        staging_extension = shlex.quote(f"{self._extension_target}/extension.js")
        staging_telemetry = shlex.quote(f"{self._extension_target}/harbor-telemetry.mjs")
        staging_archives = " && ".join(
            f"test -f {shlex.quote(f'{self._extension_target}/{archive.name}')}"
            for archive in self._pi_runtime_archives
        )
        await self.exec_as_root(
            environment,
            command=(
                f"test -f {staging_extension} && "
                f"test -f {staging_telemetry} && "
                f"{staging_archives} && "
                f"chmod -R a+rX {shlex.quote(self._extension_target)}"
            ),
        )
        await _install_probe_pi(
            self,
            environment,
            self._bundle_pi_version,
            tuple(f"{self._extension_target}/{archive.name}" for archive in self._pi_runtime_archives),
        )
        node_modules_result = await self.exec_as_agent(
            environment,
            command="command -v npm >/dev/null; npm root -g",
        )
        node_modules_root = _parse_global_node_modules_root(node_modules_result.stdout)
        runtime_target = f"{node_modules_root}/{self._RUNTIME_EXTENSION_DIRECTORY}"
        runtime_extension = shlex.quote(f"{runtime_target}/extension.js")
        runtime_telemetry = shlex.quote(f"{runtime_target}/harbor-telemetry.mjs")
        await self.exec_as_agent(
            environment,
            command=(
                f"test -d {shlex.quote(node_modules_root)} && "
                f"rm -rf {shlex.quote(runtime_target)} && "
                f"mkdir -p {shlex.quote(runtime_target)} && "
                f"cp -a {shlex.quote(self._extension_target)}/. {shlex.quote(runtime_target)}/ && "
                f"test -f {runtime_extension} && "
                f"test -f {runtime_telemetry} && "
                f"chmod -R a+rX {shlex.quote(runtime_target)} && "
                f"node --input-type=module --eval {shlex.quote('await import(process.argv[1])')} {runtime_extension}"
            ),
        )
        self._runtime_extension_target = runtime_target

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")
        if self._runtime_extension_target is None:
            raise RuntimeError("Pi-XK must be installed before it can run")

        provider, model = self.model_name.split("/", 1)
        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags = f"{cli_flags} "
        resume_flag = "--continue " if self._resume else ""
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)

        extension = shlex.quote(f"{self._runtime_extension_target}/extension.js")
        telemetry = shlex.quote(f"{self._runtime_extension_target}/harbor-telemetry.mjs")
        output = shlex.quote(f"/logs/agent/{self._OUTPUT_FILENAME}")
        profile_suffix = self._trial_profile_suffix()
        escaped_instruction = shlex.quote(instruction)
        command = (
            "command -v pi >/dev/null; "
            f'profile_dir="$HOME/.pi-xk-harbor/{profile_suffix}"; '
            'mkdir -p "$profile_dir"; '
            "unset PI_OFFLINE; "
            "PI_CODING_AGENT_DIR=\"$profile_dir\" PI_SKIP_VERSION_CHECK=1 "
            "pi --print --mode json "
            f"--session-dir {self._SESSION_DIR} "
            "--no-extensions "
            f"--extension {extension} "
            f"{resume_flag}"
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f"{cli_flags}"
            f"{escaped_instruction} "
            f"| node {telemetry} | stdbuf -oL tee {output}"
        )
        await self.exec_as_agent(environment, command=command, env=self._provider_env(provider))

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        input_tokens = 0
        output_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0
        cost_usd = 0.0
        assistant_messages = 0
        tool_calls = 0

        if output_file.exists():
            for raw_line in output_file.read_text().splitlines():
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if event.get("schema") != "pi-xk.harbor-telemetry.v1":
                    continue
                if event.get("event") == "assistant_usage":
                    input_tokens += self._safe_int(event.get("input_tokens"))
                    output_tokens += self._safe_int(event.get("output_tokens"))
                    cache_read_tokens += self._safe_int(event.get("cache_read_tokens"))
                    cache_write_tokens += self._safe_int(event.get("cache_write_tokens"))
                    cost_usd += self._safe_float(event.get("cost_usd"))
                elif event.get("event") == "stream_summary":
                    assistant_messages = self._safe_int(event.get("assistant_messages"))
                    tool_calls = self._safe_int(event.get("tool_calls"))

        context.n_input_tokens = input_tokens + cache_read_tokens
        context.n_output_tokens = output_tokens
        context.n_cache_tokens = cache_read_tokens
        context.cost_usd = cost_usd if cost_usd > 0 else None
        summary = {
            "schema": "pi-xk.harbor-run-summary.v1",
            "agent": self.name(),
            "model": self.model_name,
            "profile_scope": "trial",
            "session_scope": "trial",
            "bundle_source_commit": self._bundle_source_commit,
            "bundle_content_digest": self._bundle_content_digest,
            "pi_version": self._bundle_pi_version,
            "runtime_archive_digest": self._runtime_archive_digest,
            "harbor_version": self._harbor_version,
            "harbor_source_commit": self._harbor_source_commit,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "cost_usd": cost_usd,
            },
            "assistant_messages": assistant_messages,
            "tool_calls": tool_calls,
        }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / self._SUMMARY_FILENAME).write_text(
            f"{json.dumps(summary, sort_keys=True)}\n"
        )

    @staticmethod
    def _safe_int(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0
        return max(0, int(value))

    @staticmethod
    def _safe_float(value: object) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0.0
        return max(0.0, float(value))


def _is_lowercase_hex(value: str, *, length: int) -> bool:
    return len(value) == length and all(character in "0123456789abcdef" for character in value)


def _is_package_version(value: str) -> bool:
    return re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", value) is not None


def _is_bundle_relative_path(value: str) -> bool:
    if value == _BUNDLE_MANIFEST_FILENAME or "\\" in value:
        return False
    path = PurePosixPath(value)
    return (
        bool(value)
        and bool(path.parts)
        and path.as_posix() == value
        and not path.is_absolute()
        and "." not in path.parts
        and ".." not in path.parts
    )


def _parse_global_node_modules_root(stdout: str | None) -> str:
    if not isinstance(stdout, str):
        raise ValueError("npm root -g did not return a global node_modules path")
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("npm root -g returned an ambiguous global node_modules path")
    path = PurePosixPath(lines[0])
    if (
        not path.is_absolute()
        or path.name != "node_modules"
        or "." in path.parts
        or ".." in path.parts
    ):
        raise ValueError("npm root -g returned an unsafe global node_modules path")
    return path.as_posix()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_files_on_disk(bundle_dir: Path, label: str) -> set[str]:
    files: set[str] = set()
    for path in bundle_dir.rglob("*"):
        relative_path = path.relative_to(bundle_dir).as_posix()
        if relative_path == _BUNDLE_MANIFEST_FILENAME:
            continue
        if path.is_symlink():
            raise ValueError(f"{label} contains a symbolic link: {relative_path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"{label} contains an unsupported entry: {relative_path}")
        files.add(relative_path)
    return files


def _runtime_archive_paths(bundle_dir: Path) -> tuple[Path, ...]:
    return tuple(bundle_dir / archive for archive in _PI_RUNTIME_ARCHIVES)


def _runtime_archive_digest(digests: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for archive in _PI_RUNTIME_ARCHIVES:
        archive_digest = digests.get(archive)
        if archive_digest is None:
            raise ValueError(f"Pi runtime bundle is missing {archive}")
        digest.update(archive.encode("ascii"))
        digest.update(b"\0")
        digest.update(archive_digest.encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _bundle_content_digest(digests: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for relative_path in sorted(digests):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(digests[relative_path].encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _validate_pi_runtime_bundle(
    bundle_dir: Path,
) -> tuple[str, str, tuple[Path, ...], str, str]:
    if not bundle_dir.is_dir():
        raise ValueError("Pi runtime bundle directory does not exist")
    manifest_path = bundle_dir / _BUNDLE_MANIFEST_FILENAME
    try:
        manifest = json.loads(manifest_path.read_text())
    except FileNotFoundError as error:
        raise ValueError("Pi runtime bundle is missing manifest.json") from error
    except json.JSONDecodeError as error:
        raise ValueError("Pi runtime bundle manifest is not valid JSON") from error
    if not isinstance(manifest, dict) or manifest.get("schema") != _BUNDLE_MANIFEST_SCHEMA:
        raise ValueError("Pi runtime bundle manifest schema is invalid")
    source_commit = manifest.get("sourceCommit")
    if not isinstance(source_commit, str) or not _is_lowercase_hex(source_commit, length=40):
        raise ValueError("Pi runtime bundle manifest sourceCommit is invalid")
    pi_version = manifest.get("piVersion")
    if not isinstance(pi_version, str) or not _is_package_version(pi_version):
        raise ValueError("Pi runtime bundle manifest piVersion is invalid")
    manifest_files = manifest.get("files")
    if not isinstance(manifest_files, list):
        raise ValueError("Pi runtime bundle manifest files are invalid")
    digests: dict[str, str] = {}
    for entry in manifest_files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ValueError("Pi runtime bundle manifest file entry is invalid")
        relative_path = entry["path"]
        digest = entry["sha256"]
        if not isinstance(relative_path, str) or not _is_bundle_relative_path(relative_path):
            raise ValueError("Pi runtime bundle manifest contains an unsafe file path")
        if not isinstance(digest, str) or not _is_lowercase_hex(digest, length=64):
            raise ValueError("Pi runtime bundle manifest contains an invalid file digest")
        if relative_path in digests:
            raise ValueError("Pi runtime bundle manifest contains duplicate file paths")
        digests[relative_path] = digest
    archives = _runtime_archive_paths(bundle_dir)
    for archive in archives:
        expected_digest = digests.get(archive.name)
        if expected_digest is None:
            raise ValueError(f"Pi runtime bundle is missing {archive.name}")
        if archive.is_symlink() or not archive.is_file():
            raise ValueError(f"Pi runtime bundle archive is invalid: {archive.name}")
        if _sha256_file(archive) != expected_digest:
            raise ValueError(f"Pi runtime bundle archive digest mismatch: {archive.name}")
    actual_files = _bundle_files_on_disk(bundle_dir, "Pi runtime bundle")
    if set(digests) != actual_files:
        raise ValueError("Pi runtime bundle manifest file list does not match bundle contents")
    for relative_path, expected_digest in digests.items():
        if _sha256_file(bundle_dir / relative_path) != expected_digest:
            raise ValueError(f"Pi runtime bundle file digest mismatch: {relative_path}")
    return (
        source_commit,
        pi_version,
        archives,
        _runtime_archive_digest(digests),
        _bundle_content_digest(digests),
    )


class PiNative(Pi):
    """Controlled native-Pi baseline with Pi-XK-equivalent provider plumbing."""

    _OUTPUT_FILENAME = "pi-native-telemetry.jsonl"
    _SUMMARY_FILENAME = "pi-native-summary.json"
    _TELEMETRY_TARGET = "/opt/pi-xk-evaluation/harbor-telemetry.mjs"
    _SESSION_DIR = "/logs/agent/pi-native/sessions"

    def __init__(
        self,
        logs_dir: Path,
        telemetry_path: Path | str,
        pi_runtime_bundle_dir: Path | str,
        *args: Any,
        model_name: str | None = None,
        version: str | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        self._telemetry_path = Path(telemetry_path).resolve()
        self._validate_telemetry_path()
        self._pi_runtime_bundle_dir = Path(pi_runtime_bundle_dir).resolve()
        (
            self._pi_runtime_source_commit,
            self._pi_runtime_version,
            self._pi_runtime_archives,
            self._pi_runtime_archive_digest,
            self._bundle_content_digest,
        ) = _validate_pi_runtime_bundle(self._pi_runtime_bundle_dir)
        self._harbor_version, self._harbor_source_commit = _harbor_runtime_identity()
        if version is not None and version != self._pi_runtime_version:
            raise ValueError("Native Pi version does not match the requested Pi version")
        provider = model_name.split("/", 1)[0] if model_name else ""
        provider_env = _PROVIDER_ENV_KEYS.get(provider, ())
        filtered_extra_env = {
            key: value for key, value in (extra_env or {}).items() if key in provider_env
        }
        super().__init__(
            logs_dir,
            *args,
            model_name=model_name,
            version=self._pi_runtime_version,
            extra_env=filtered_extra_env,
            **kwargs,
        )

    @staticmethod
    @override
    def name() -> str:
        return "pi-native"

    def _validate_telemetry_path(self) -> None:
        if self._telemetry_path.is_symlink() or not self._telemetry_path.is_file():
            raise ValueError("Native Pi telemetry script must be a regular file")

    def _trial_profile_suffix(self) -> str:
        identity = self.session_id or self.logs_dir.as_posix()
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]

    def _provider_env(self, provider: str) -> dict[str, str]:
        return {
            key: value
            for key in _PROVIDER_ENV_KEYS.get(provider, ())
            if (value := self._get_env(key))
        }

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        runtime_target = "/opt/pi-xk-evaluation/runtime"
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {shlex.quote(runtime_target)}",
        )
        for archive in self._pi_runtime_archives:
            await environment.upload_file(archive, f"{runtime_target}/{archive.name}")
        await environment.upload_file(self._telemetry_path, self._TELEMETRY_TARGET)
        telemetry = shlex.quote(self._TELEMETRY_TARGET)
        runtime_archives = tuple(f"{runtime_target}/{archive.name}" for archive in self._pi_runtime_archives)
        archive_checks = " && ".join(f"test -f {shlex.quote(archive)}" for archive in runtime_archives)
        await self.exec_as_root(
            environment,
            command=(
                f"{archive_checks} && "
                f"test -f {telemetry} && "
                f"chmod a+r {telemetry}"
            ),
        )
        await _install_probe_pi(self, environment, self._pi_runtime_version, runtime_archives)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model = self.model_name.split("/", 1)
        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags = f"{cli_flags} "
        resume_flag = "--continue " if self._resume else ""
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command)

        telemetry = shlex.quote(self._TELEMETRY_TARGET)
        output = shlex.quote(f"/logs/agent/{self._OUTPUT_FILENAME}")
        profile_suffix = self._trial_profile_suffix()
        escaped_instruction = shlex.quote(instruction)
        command = (
            "command -v pi >/dev/null; "
            f'profile_dir="$HOME/.pi-xk-harbor/{profile_suffix}"; '
            'mkdir -p "$profile_dir"; '
            "unset PI_OFFLINE; "
            "PI_CODING_AGENT_DIR=\"$profile_dir\" PI_SKIP_VERSION_CHECK=1 "
            "pi --print --mode json "
            f"--session-dir {self._SESSION_DIR} "
            "--no-extensions "
            f"{resume_flag}"
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f"{cli_flags}"
            f"{escaped_instruction} "
            f"| node {telemetry} | stdbuf -oL tee {output}"
        )
        await self.exec_as_agent(environment, command=command, env=self._provider_env(provider))

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        input_tokens = 0
        output_tokens = 0
        cache_read_tokens = 0
        cache_write_tokens = 0
        cost_usd = 0.0
        assistant_messages = 0
        tool_calls = 0

        if output_file.exists():
            for raw_line in output_file.read_text().splitlines():
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if event.get("schema") != "pi-xk.harbor-telemetry.v1":
                    continue
                if event.get("event") == "assistant_usage":
                    input_tokens += PiXk._safe_int(event.get("input_tokens"))
                    output_tokens += PiXk._safe_int(event.get("output_tokens"))
                    cache_read_tokens += PiXk._safe_int(event.get("cache_read_tokens"))
                    cache_write_tokens += PiXk._safe_int(event.get("cache_write_tokens"))
                    cost_usd += PiXk._safe_float(event.get("cost_usd"))
                elif event.get("event") == "stream_summary":
                    assistant_messages = PiXk._safe_int(event.get("assistant_messages"))
                    tool_calls = PiXk._safe_int(event.get("tool_calls"))

        context.n_input_tokens = input_tokens + cache_read_tokens
        context.n_output_tokens = output_tokens
        context.n_cache_tokens = cache_read_tokens
        context.cost_usd = cost_usd if cost_usd > 0 else None
        summary = {
            "schema": "pi-xk.harbor-run-summary.v1",
            "agent": self.name(),
            "model": self.model_name,
            "profile_scope": "trial",
            "session_scope": "trial",
            "bundle_source_commit": self._pi_runtime_source_commit,
            "bundle_content_digest": self._bundle_content_digest,
            "pi_version": self._version,
            "runtime_archive_digest": self._pi_runtime_archive_digest,
            "harbor_version": self._harbor_version,
            "harbor_source_commit": self._harbor_source_commit,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_tokens": cache_read_tokens,
                "cache_write_tokens": cache_write_tokens,
                "cost_usd": cost_usd,
            },
            "assistant_messages": assistant_messages,
            "tool_calls": tool_calls,
        }
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / self._SUMMARY_FILENAME).write_text(
            f"{json.dumps(summary, sort_keys=True)}\n"
        )
