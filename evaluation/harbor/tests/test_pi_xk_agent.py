import json
import os
import subprocess
from hashlib import sha256
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from harbor.environments.base import ExecResult
from harbor_pi_xk.agent import PiNative, PiXk, _harbor_runtime_identity


GLOBAL_NODE_MODULES = "/usr/local/lib/node_modules"
RUNTIME_ARCHIVES = (
    "pi-agent-core.tgz",
    "pi-ai.tgz",
    "pi-tui.tgz",
    "pi-coding-agent.tgz",
)


def make_bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "bundle"
    (bundle / "node_modules" / "pi-xk-core").mkdir(parents=True)
    (bundle / "extension.js").write_text("export default function () {}\n")
    (bundle / "harbor-telemetry.mjs").write_text("process.stdin.resume();\n")
    (bundle / "node_modules" / "pi-xk-core" / "package.json").write_text("{}\n")
    (bundle / "node_modules" / "typebox").mkdir()
    (bundle / "node_modules" / "typebox" / "package.json").write_text("{}\n")
    for archive in RUNTIME_ARCHIVES:
        (bundle / archive).write_bytes(b"pi-runtime-archive")
    files = []
    for path in sorted(bundle.rglob("*")):
        if path.is_file():
            files.append(
                {
                    "path": path.relative_to(bundle).as_posix(),
                    "sha256": sha256(path.read_bytes()).hexdigest(),
                }
            )
    (bundle / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "pi-xk.harbor-extension-bundle.v2",
                "sourceCommit": "a" * 40,
                "piVersion": "0.80.10",
                "files": files,
            }
        )
    )
    return bundle


def make_telemetry_script(tmp_path: Path) -> Path:
    telemetry = tmp_path / "harbor-telemetry.mjs"
    telemetry.write_text("process.stdin.resume();\n")
    return telemetry


def successful_environment() -> AsyncMock:
    environment = AsyncMock()
    environment.exec.return_value = ExecResult(
        return_code=0,
        stdout=f"{GLOBAL_NODE_MODULES}\n",
        stderr="",
    )
    return environment


def test_harbor_runtime_identity_rejects_untracked_checkout(tmp_path: Path) -> None:
    source_root = tmp_path / "harbor"
    package_file = source_root / "src" / "harbor" / "__init__.py"
    package_file.parent.mkdir(parents=True)
    package_file.write_text("\n")
    subprocess.run(["git", "init", "-q", str(source_root)], check=True)
    subprocess.run(
        ["git", "-C", str(source_root), "config", "user.email", "adapter@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(source_root), "config", "user.name", "Pi-XK Adapter"],
        check=True,
    )
    subprocess.run(["git", "-C", str(source_root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(source_root), "commit", "-qm", "fixture"], check=True)

    with (
        patch("harbor_pi_xk.agent.harbor.__file__", str(package_file)),
        patch("harbor_pi_xk.agent.package_version", return_value="0.20.0"),
    ):
        version, commit = _harbor_runtime_identity()
        assert version == "0.20.0"
        assert len(commit) == 40
        (source_root / "untracked.txt").write_text("must make checkout dirty\n")
        with pytest.raises(ValueError, match="checkout must be clean"):
            _harbor_runtime_identity()


@pytest.mark.asyncio
async def test_pi_xk_installs_the_pinned_pi_version_from_the_probe_runtime(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    agent = PiXk(logs_dir=tmp_path / "logs", extension_bundle_dir=bundle)
    environment = successful_environment()

    await agent.install(environment)

    assert agent._version == "0.80.10"
    environment.upload_dir.assert_awaited_once_with(bundle, "/opt/pi-xk-extension")
    commands = [call.kwargs["command"] for call in environment.exec.call_args_list]
    install_command = next(command for command in commands if "npm install -g --ignore-scripts" in command)
    staging_command = next(command for command in commands if "test -f /opt/pi-xk-extension/extension.js" in command)
    runtime_command = environment.exec.call_args_list[-1].kwargs["command"]
    assert "node --version" in install_command
    for archive in RUNTIME_ARCHIVES:
        assert f"/opt/pi-xk-extension/{archive}" in install_command
    assert "nvm" not in install_command
    assert "test -f /opt/pi-xk-extension/extension.js" in staging_command
    assert "test -f /opt/pi-xk-extension/harbor-telemetry.mjs" in staging_command
    assert any("npm root -g" in command for command in commands)
    assert f"{GLOBAL_NODE_MODULES}/pi-xk-harbor-extension" in runtime_command
    assert "await import(process.argv[1])" in runtime_command


@pytest.mark.asyncio
async def test_pi_xk_uses_per_trial_profile_and_sanitized_stream(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    agent = PiXk(
        logs_dir=tmp_path / "logs",
        model_name="deepseek/deepseek-chat",
        extension_bundle_dir=bundle,
        extra_env={"DEEPSEEK_API_KEY": "configured-deepseek-key"},
    )
    agent.session_id = "polyglot-phone-number__agent"
    environment = successful_environment()

    with patch.dict(
        os.environ,
        {
            "DEEPSEEK_API_KEY": "host-deepseek-key",
            "UNRELATED_EVALUATION_SECRET": "must-not-be-forwarded",
        },
        clear=False,
    ):
        await agent.install(environment)
        await agent.run("Implement the task", environment, AsyncMock())

    call = environment.exec.call_args_list[-1]
    command = call.kwargs["command"]
    assert "--provider deepseek --model deepseek-chat" in command
    assert "--no-extensions" in command
    assert f"--extension {GLOBAL_NODE_MODULES}/pi-xk-harbor-extension/extension.js" in command
    assert "--extension /opt/pi-xk-extension/extension.js" not in command
    assert "--session-dir /logs/agent/pi-xk/sessions" in command
    assert "PI_CODING_AGENT_DIR" in command
    assert "PI_SKIP_VERSION_CHECK=1" in command
    assert "unset PI_OFFLINE" in command
    assert "PI_OFFLINE=1" not in command
    assert "harbor-telemetry.mjs" in command
    assert "2>&1" not in command
    assert call.kwargs["env"] == {"DEEPSEEK_API_KEY": "configured-deepseek-key"}


@pytest.mark.asyncio
async def test_native_pi_uses_the_same_trial_controls_without_loading_pi_xk(tmp_path: Path) -> None:
    telemetry = make_telemetry_script(tmp_path)
    bundle = make_bundle(tmp_path)
    agent = PiNative(
        logs_dir=tmp_path / "logs",
        telemetry_path=telemetry,
        pi_runtime_bundle_dir=bundle,
        model_name="deepseek/deepseek-chat",
        extra_env={
            "DEEPSEEK_API_KEY": "configured-deepseek-key",
            "UNRELATED_EVALUATION_SECRET": "must-not-be-forwarded",
        },
    )
    agent.session_id = "polyglot-phone-number__agent"
    environment = successful_environment()

    await agent.install(environment)
    await agent.run("Implement the task", environment, AsyncMock())

    commands = [call.kwargs["command"] for call in environment.exec.call_args_list]
    install_command = next(command for command in commands if "npm install -g --ignore-scripts" in command)
    assert "node --version" in install_command
    for archive in RUNTIME_ARCHIVES:
        assert f"/opt/pi-xk-evaluation/runtime/{archive}" in install_command
    assert "nvm" not in install_command
    uploaded_paths = [call.args[1] for call in environment.upload_file.call_args_list]
    assert "/opt/pi-xk-evaluation/harbor-telemetry.mjs" in uploaded_paths
    for archive in RUNTIME_ARCHIVES:
        assert f"/opt/pi-xk-evaluation/runtime/{archive}" in uploaded_paths
    call = environment.exec.call_args_list[-1]
    command = call.kwargs["command"]
    assert "--provider deepseek --model deepseek-chat" in command
    assert "--no-extensions" in command
    assert "--extension" not in command
    assert "--session-dir /logs/agent/pi-native/sessions" in command
    assert "PI_CODING_AGENT_DIR" in command
    assert "PI_SKIP_VERSION_CHECK=1" in command
    assert "unset PI_OFFLINE" in command
    assert "PI_OFFLINE=1" not in command
    assert "harbor-telemetry.mjs" in command
    assert "2>&1" not in command
    assert call.kwargs["env"] == {"DEEPSEEK_API_KEY": "configured-deepseek-key"}


@pytest.mark.asyncio
async def test_pi_xk_rejects_an_ambiguous_global_node_modules_path(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    agent = PiXk(logs_dir=tmp_path / "logs", extension_bundle_dir=bundle)
    environment = successful_environment()
    environment.exec.return_value = ExecResult(
        return_code=0,
        stdout=f"{GLOBAL_NODE_MODULES}\n/other/node_modules\n",
        stderr="",
    )

    with pytest.raises(ValueError, match="ambiguous global node_modules path"):
        await agent.install(environment)


def test_pi_xk_rejects_a_requested_version_that_differs_from_the_bundle(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Pi version"):
        PiXk(
            logs_dir=tmp_path / "logs",
            extension_bundle_dir=make_bundle(tmp_path),
            version="0.80.9",
        )


@pytest.mark.asyncio
async def test_pi_xk_requires_install_before_running(tmp_path: Path) -> None:
    agent = PiXk(
        logs_dir=tmp_path / "logs",
        model_name="deepseek/deepseek-chat",
        extension_bundle_dir=make_bundle(tmp_path),
    )

    with pytest.raises(RuntimeError, match="installed before it can run"):
        await agent.run("Implement the task", successful_environment(), AsyncMock())


def test_pi_xk_rejects_incomplete_bundle(tmp_path: Path) -> None:
    bundle = tmp_path / "incomplete"
    bundle.mkdir()
    with pytest.raises(ValueError, match="bundle"):
        PiXk(logs_dir=tmp_path / "logs", extension_bundle_dir=bundle)


def test_pi_xk_rejects_a_tampered_bundle(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    (bundle / "extension.js").write_text("tampered\n")
    with pytest.raises(ValueError, match="digest mismatch"):
        PiXk(logs_dir=tmp_path / "logs", extension_bundle_dir=bundle)


def test_native_pi_rejects_a_tampered_runtime_archive(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    (bundle / "pi-coding-agent.tgz").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="archive digest mismatch"):
        PiNative(
            logs_dir=tmp_path / "logs",
            telemetry_path=make_telemetry_script(tmp_path),
            pi_runtime_bundle_dir=bundle,
        )


def test_native_pi_rejects_a_tampered_non_runtime_bundle_file(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    (bundle / "extension.js").write_text("tampered\n")
    with pytest.raises(ValueError, match="file digest mismatch"):
        PiNative(
            logs_dir=tmp_path / "logs",
            telemetry_path=make_telemetry_script(tmp_path),
            pi_runtime_bundle_dir=bundle,
        )


def test_pi_xk_discards_unrelated_trial_environment_values(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    agent = PiXk(
        logs_dir=tmp_path / "logs",
        model_name="deepseek/deepseek-chat",
        extension_bundle_dir=bundle,
        extra_env={
            "DEEPSEEK_API_KEY": "fixture-deepseek-key",
            "UNRELATED_EVALUATION_SECRET": "must-not-be-forwarded",
        },
    )

    assert agent.extra_env == {"DEEPSEEK_API_KEY": "fixture-deepseek-key"}


def test_pi_xk_summary_never_persists_prompt_or_api_key(tmp_path: Path) -> None:
    bundle = make_bundle(tmp_path)
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "pi-xk-telemetry.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "schema": "pi-xk.harbor-telemetry.v1",
                        "event": "assistant_usage",
                        "input_tokens": 21,
                        "output_tokens": 34,
                        "cache_read_tokens": 5,
                        "cost_usd": 0.004,
                        "prompt": "sensitive prompt must be ignored",
                    }
                ),
                json.dumps(
                    {
                        "schema": "pi-xk.harbor-telemetry.v1",
                        "event": "stream_summary",
                        "assistant_messages": 1,
                        "api_key": "fixture-key-must-not-persist",
                    }
                ),
            ]
        )
        + "\n"
    )
    agent = PiXk(logs_dir=logs, extension_bundle_dir=bundle, model_name="deepseek/deepseek-chat")
    context = AsyncMock()
    agent.populate_context_post_run(context)

    summary = (logs / "pi-xk-summary.json").read_text()
    assert "sensitive prompt" not in summary
    assert "fixture-key" not in summary
    assert '"bundle_source_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' in summary
    assert '"bundle_content_digest":' in summary
    assert '"pi_version": "0.80.10"' in summary
    assert '"runtime_archive_digest":' in summary
    assert '"harbor_version": "0.20.0"' in summary
    assert '"harbor_source_commit": "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc"' in summary
    assert context.n_input_tokens == 26
    assert context.n_output_tokens == 34
    assert context.n_cache_tokens == 5


def test_native_pi_summary_never_persists_prompt_or_api_key(tmp_path: Path) -> None:
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "pi-native-telemetry.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "schema": "pi-xk.harbor-telemetry.v1",
                        "event": "assistant_usage",
                        "input_tokens": 21,
                        "output_tokens": 34,
                        "cache_read_tokens": 5,
                        "cost_usd": 0.004,
                        "prompt": "sensitive prompt must be ignored",
                    }
                ),
                json.dumps(
                    {
                        "schema": "pi-xk.harbor-telemetry.v1",
                        "event": "stream_summary",
                        "assistant_messages": 1,
                        "api_key": "fixture-key-must-not-persist",
                    }
                ),
            ]
        )
        + "\n"
    )
    agent = PiNative(
        logs_dir=logs,
        telemetry_path=make_telemetry_script(tmp_path),
        pi_runtime_bundle_dir=make_bundle(tmp_path),
        model_name="deepseek/deepseek-chat",
    )
    context = AsyncMock()
    agent.populate_context_post_run(context)

    summary = (logs / "pi-native-summary.json").read_text()
    assert "sensitive prompt" not in summary
    assert "fixture-key" not in summary
    assert '"agent": "pi-native"' in summary
    assert '"bundle_source_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' in summary
    assert '"bundle_content_digest":' in summary
    assert '"pi_version": "0.80.10"' in summary
    assert '"runtime_archive_digest":' in summary
    assert '"harbor_version": "0.20.0"' in summary
    assert '"harbor_source_commit": "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc"' in summary
    assert context.n_input_tokens == 26
    assert context.n_output_tokens == 34
    assert context.n_cache_tokens == 5
