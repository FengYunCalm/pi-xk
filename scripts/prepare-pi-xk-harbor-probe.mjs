import { execFileSync } from "node:child_process";
import { cp, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = join(workspaceRoot, "evaluation", "harbor", "aider-polyglot-probe.json");
const probeSchema = "pi-xk.harbor-aider-polyglot-probe.v1";
const networkPolicyProfile = "portable-loopback-v1";
const networkPolicyFilename = `network-policy-${networkPolicyProfile}`;
const networkPolicySource = join(workspaceRoot, "evaluation", "harbor", networkPolicyFilename);
const languageSetup = {
	python: { packages: ["python3"], postCopy: "" },
	go: { packages: ["golang-go"], postCopy: "" },
	rust: { packages: ["cargo", "rustc"], postCopy: "" },
	cpp: { packages: ["build-essential", "cmake"], postCopy: "" },
	java: {
		packages: ["openjdk-17-jdk"],
		postCopy: [
			"RUN sed -i '/^networkTimeout=/d' /app/gradle/wrapper/gradle-wrapper.properties",
			"&& printf '\\nnetworkTimeout=600000\\n' >> /app/gradle/wrapper/gradle-wrapper.properties",
			"&& printf '%s\\n' 'allprojects { tasks.register(\"piXkResolveTestRuntime\") { doLast { configurations.getByName(\"testRuntimeClasspath\").resolve() } } }' > /tmp/pi-xk-resolve-test-runtime.gradle",
			"&& chmod +x /app/gradlew",
			"&& /app/gradlew --no-daemon --init-script /tmp/pi-xk-resolve-test-runtime.gradle testClasses piXkResolveTestRuntime",
		].join(" "),
	},
};

function usage() {
	console.log(`Usage: node scripts/prepare-pi-xk-harbor-probe.mjs --source <aider-polyglot-dir> --out <dir> [--manifest <path>] [--force]

The source checkout must match the manifest's pinned commit. The generated task directory is always outside this repository.`);
}

function parseArgs(argv) {
	let source;
	let out;
	let manifest = defaultManifestPath;
	let force = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--source") {
			source = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--out") {
			out = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--manifest") {
			manifest = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") return { help: true };
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!source) throw new Error("--source is required");
	if (!out) throw new Error("--out is required");
	return {
		help: false,
		source: resolve(source),
		out: resolve(out),
		manifest: resolve(manifest),
		force,
	};
}

async function assertDirectory(path, label) {
	try {
		const stat = await lstat(path);
		if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	} catch (error) {
		throw new Error(`${label} is missing: ${path}`, { cause: error });
	}
}

async function assertFile(path, label) {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	} catch (error) {
		throw new Error(`${label} is missing: ${path}`, { cause: error });
	}
}

function assertSafeOutput(target) {
	const disallowed = new Set([resolve("/"), workspaceRoot, resolve(homedir())]);
	if (disallowed.has(target)) throw new Error(`Refusing unsafe probe output directory: ${target}`);
	if (isPathInsideRoot(workspaceRoot, target)) {
		throw new Error("Harbor probe output must be outside the repository worktree");
	}
}

function isLowercaseHex(value, length) {
	return typeof value === "string" && value.length === length && /^[0-9a-f]+$/u.test(value);
}

function isSafeRelativePath(value) {
	if (typeof value !== "string" || !value || value.includes("\\")) return false;
	const normalized = posix.normalize(value);
	return (
		normalized === value &&
		!value.startsWith("/") &&
		value !== "." &&
		!value.startsWith("../") &&
		/^[A-Za-z0-9._/-]+$/u.test(value)
	);
}

function assertCopyEntries(value, field, taskId) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`Probe task ${taskId} ${field} must be a non-empty array`);
	}
	for (const entry of value) {
		if (
			!entry ||
			typeof entry !== "object" ||
			!isSafeRelativePath(entry.from) ||
			!isSafeRelativePath(entry.to)
		) {
			throw new Error(`Probe task ${taskId} has an unsafe ${field} entry`);
		}
	}
}

function assertAgentAllowedHosts(value) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Aider Polyglot probe manifest agentAllowedHosts must be a non-empty array");
	}
	const hosts = new Set();
	for (const host of value) {
		if (
			typeof host !== "string" ||
			!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) ||
			hosts.has(host)
		) {
			throw new Error("Aider Polyglot probe manifest agentAllowedHosts is invalid");
		}
		hosts.add(host);
	}
	return [...hosts];
}

function validateHarness(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Aider Polyglot probe manifest harness is invalid");
	}
	if (
		value.name !== "Harbor" ||
		value.repository !== "https://github.com/harbor-framework/harbor.git" ||
		!isLowercaseHex(value.commit, 40) ||
		typeof value.version !== "string" ||
		!/^\d+\.\d+\.\d+$/u.test(value.version)
	) {
		throw new Error("Aider Polyglot probe manifest harness pin is invalid");
	}
	return { name: value.name, repository: value.repository, commit: value.commit, version: value.version };
}

function validateManifest(manifest) {
	if (!manifest || typeof manifest !== "object" || manifest.schema !== probeSchema) {
		throw new Error("Aider Polyglot probe manifest schema is invalid");
	}
	if (!manifest.upstream || typeof manifest.upstream !== "object") {
		throw new Error("Aider Polyglot probe manifest upstream is missing");
	}
	const harness = validateHarness(manifest.harness);
	if (typeof manifest.upstream.repository !== "string" || !isLowercaseHex(manifest.upstream.commit, 40)) {
		throw new Error("Aider Polyglot probe manifest upstream pin is invalid");
	}
	const agentAllowedHosts = assertAgentAllowedHosts(manifest.agentAllowedHosts);
	if (manifest.networkPolicyProfile !== networkPolicyProfile) {
		throw new Error(`Aider Polyglot probe manifest networkPolicyProfile must be ${networkPolicyProfile}`);
	}
	if (!Number.isInteger(manifest.agentTimeoutSeconds) || manifest.agentTimeoutSeconds <= 0) {
		throw new Error("Aider Polyglot probe manifest agentTimeoutSeconds must be a positive integer");
	}
	if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
		throw new Error("Aider Polyglot probe manifest has no tasks");
	}
	const ids = new Set();
	for (const task of manifest.tasks) {
		if (!task || typeof task !== "object" || !/^[a-z0-9-]+$/u.test(task.id ?? "")) {
			throw new Error("Aider Polyglot probe manifest task id is invalid");
		}
		if (ids.has(task.id)) throw new Error(`Aider Polyglot probe task id is duplicated: ${task.id}`);
		ids.add(task.id);
		if (!Object.hasOwn(languageSetup, task.language)) {
			throw new Error(`Aider Polyglot probe task ${task.id} has an unsupported language`);
		}
		if (!isSafeRelativePath(task.upstreamPath)) {
			throw new Error(`Aider Polyglot probe task ${task.id} has an unsafe upstream path`);
		}
		if (!Array.isArray(task.instructionFiles) || task.instructionFiles.length === 0) {
			throw new Error(`Aider Polyglot probe task ${task.id} has no instruction files`);
		}
		for (const instruction of task.instructionFiles) {
			if (!isSafeRelativePath(instruction)) {
				throw new Error(`Aider Polyglot probe task ${task.id} has an unsafe instruction path`);
			}
		}
		assertCopyEntries(task.oracleCopies, "oracleCopies", task.id);
		assertCopyEntries(task.verifierCopies, "verifierCopies", task.id);
		if (typeof task.testCommand !== "string" || !task.testCommand.trim()) {
			throw new Error(`Aider Polyglot probe task ${task.id} has no test command`);
		}
	}
	return { ...manifest, harness, agentAllowedHosts, agentTimeoutSeconds: manifest.agentTimeoutSeconds };
}

function sourceCommit(sourceRoot) {
	try {
		return execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	} catch (error) {
		throw new Error(`Unable to read Aider Polyglot source commit from ${sourceRoot}`, { cause: error });
	}
}

async function assertTreeHasNoLinks(root) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Source tree contains a symbolic link: ${path}`);
		if (entry.isDirectory()) {
			await assertTreeHasNoLinks(path);
			continue;
		}
		if (!entry.isFile()) throw new Error(`Source tree contains an unsupported entry: ${path}`);
	}
}

async function copyWorkspaceSource(source, destination) {
	await assertTreeHasNoLinks(source);
	await mkdir(destination, { recursive: true });
	for (const entry of await readdir(source, { withFileTypes: true })) {
		if ([".docs", ".git", ".meta"].includes(entry.name)) continue;
		await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, force: false });
	}
}

async function copyEntries(source, destination, entries, label) {
	for (const entry of entries) {
		const from = join(source, entry.from);
		const to = join(destination, entry.to);
		await assertFile(from, `${label} source ${entry.from}`);
		await mkdir(dirname(to), { recursive: true });
		await cp(from, to, { force: false });
	}
}

async function renderInstruction(source, task) {
	const parts = [];
	for (const instructionFile of task.instructionFiles) {
		const path = join(source, instructionFile);
		await assertFile(path, `Instruction ${instructionFile}`);
		parts.push((await readFile(path, "utf8")).trim());
	}
	parts.push(
		"Implement the incomplete starter code in the provided repository. Preserve the public API and project structure, and make the implementation correct for the described behavior.",
	);
	return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function dockerfileFor(language) {
	const setup = languageSetup[language];
	return [
		"FROM node:22-bookworm",
		"",
		"ARG DEBIAN_FRONTEND=noninteractive",
		`RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git tmux ${setup.packages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
		"",
		"WORKDIR /app",
		"COPY workspace/ ./",
		setup.postCopy,
		"",
	].filter(Boolean).join("\n");
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function renderVerifier(task) {
	const copyLines = task.verifierCopies.flatMap((entry) => [
		`mkdir -p \"$APP_DIR\"/${shellQuote(dirname(entry.to))}`,
		`cp \"$TEST_DIR\"/${shellQuote(entry.to)} \"$APP_DIR\"/${shellQuote(entry.to)}`,
	]);
	return [
		"#!/usr/bin/env bash",
		"set -Eeuo pipefail",
		"",
		'APP_DIR="${APP_DIR:-/app}"',
		'TEST_DIR="${TEST_DIR:-/tests}"',
		'LOGS_DIR="${LOGS_DIR:-/logs}"',
		"mkdir -p \"$LOGS_DIR/verifier\"",
		...copyLines,
		"cd \"$APP_DIR\"",
		"set +e",
		task.testCommand,
		"status=$?",
		"set -e",
		"if [ \"$status\" -eq 0 ]; then",
		"  printf '1\\n' > \"$LOGS_DIR/verifier/reward.txt\"",
		"else",
		"  printf '0\\n' > \"$LOGS_DIR/verifier/reward.txt\"",
		"fi",
		"exit 0",
		"",
	].join("\n");
}

function renderOracle(task) {
	const copyLines = task.oracleCopies.flatMap((entry) => [
		`mkdir -p \"$APP_DIR\"/${shellQuote(dirname(entry.to))}`,
		`cp \"$SOLUTION_DIR\"/oracle/${shellQuote(entry.to)} \"$APP_DIR\"/${shellQuote(entry.to)}`,
	]);
	return [
		"#!/usr/bin/env bash",
		"set -Eeuo pipefail",
		"",
		'APP_DIR="${APP_DIR:-/app}"',
		'SOLUTION_DIR="${SOLUTION_DIR:-/solution}"',
		...copyLines,
		"",
	].join("\n");
}

function renderTaskToml(task, agentAllowedHosts, agentTimeoutSeconds) {
	const hosts = JSON.stringify(agentAllowedHosts);
	return `schema_version = "1.4"

[task]
name = "pi-xk-evaluation/${task.id}"
version = "1.0.0"
description = "A deterministic multi-language code-editing task."
authors = [{ name = "Pi-XK" }]
keywords = ["coding", "polyglot"]

[metadata]
language = "${task.language}"
source = "aider-polyglot-parity-probe"

[environment]
build_timeout_sec = 1800.0
cpus = 1
memory_mb = 4096
storage_mb = 10240
gpus = 0

[agent]
network_mode = "allowlist"
allowed_hosts = ${hosts}
timeout_sec = ${agentTimeoutSeconds.toFixed(1)}

[verifier]
network_mode = "no-network"
timeout_sec = 1800.0
`;
}

function renderNetworkPolicyCompose() {
	return `services:
  harbor-docker-egress-control-sidecar:
    volumes:
      - type: bind
        source: ./${networkPolicyFilename}
        target: /usr/local/bin/network-policy
        read_only: true
`;
}

async function generateTask(stageRoot, sourceRoot, task, agentAllowedHosts, agentTimeoutSeconds) {
	const source = join(sourceRoot, task.upstreamPath);
	await assertDirectory(source, `Aider Polyglot task ${task.id}`);
	const taskRoot = join(stageRoot, task.id);
	const environmentRoot = join(taskRoot, "environment");
	const workspace = join(environmentRoot, "workspace");
	const solutionRoot = join(taskRoot, "solution");
	const testsRoot = join(taskRoot, "tests");
	await copyWorkspaceSource(source, workspace);
	await copyEntries(source, join(solutionRoot, "oracle"), task.oracleCopies, "Oracle");
	await copyEntries(source, testsRoot, task.verifierCopies, "Verifier");
	await writeFile(join(taskRoot, "instruction.md"), await renderInstruction(source, task), "utf8");
	await writeFile(
		join(taskRoot, "task.toml"),
		renderTaskToml(task, agentAllowedHosts, agentTimeoutSeconds),
		"utf8",
	);
	await writeFile(join(environmentRoot, "Dockerfile"), dockerfileFor(task.language), "utf8");
	await writeFile(join(environmentRoot, "docker-compose.yaml"), renderNetworkPolicyCompose(), "utf8");
	await cp(networkPolicySource, join(environmentRoot, networkPolicyFilename), { force: false });
	await writeFile(join(solutionRoot, "solve.sh"), renderOracle(task), "utf8");
	await writeFile(join(testsRoot, "test.sh"), renderVerifier(task), "utf8");
	await chmod(join(solutionRoot, "solve.sh"), 0o755);
	await chmod(join(testsRoot, "test.sh"), 0o755);
	await chmod(join(environmentRoot, networkPolicyFilename), 0o755);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	assertSafeOutput(options.out);
	await assertDirectory(options.source, "Aider Polyglot source directory");
	await assertFile(options.manifest, "Aider Polyglot probe manifest");
	await assertFile(networkPolicySource, "Portable Harbor network policy");
	const manifest = validateManifest(JSON.parse(await readFile(options.manifest, "utf8")));
	const actualCommit = sourceCommit(options.source);
	if (actualCommit !== manifest.upstream.commit) {
		throw new Error(`Aider Polyglot source commit mismatch: expected ${manifest.upstream.commit}, got ${actualCommit}`);
	}

	await mkdir(dirname(options.out), { recursive: true });
	const stage = await mkdtemp(join(dirname(options.out), `.${basename(options.out)}.`));
	try {
		for (const task of manifest.tasks) {
			await generateTask(stage, options.source, task, manifest.agentAllowedHosts, manifest.agentTimeoutSeconds);
		}
		await writeFile(
			join(stage, "probe-manifest.json"),
			`${JSON.stringify(
				{
					schema: probeSchema,
					harness: manifest.harness,
					upstream: manifest.upstream,
					agentAllowedHosts: manifest.agentAllowedHosts,
					agentTimeoutSeconds: manifest.agentTimeoutSeconds,
					networkPolicyProfile: manifest.networkPolicyProfile,
					tasks: manifest.tasks.map((task) => task.id),
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		try {
			await lstat(options.out);
			if (!options.force) throw new Error(`Output already exists: ${options.out}; pass --force to replace it`);
			await rm(options.out, { recursive: true, force: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				// The requested output does not exist.
			} else if (error instanceof Error && error.message.startsWith("Output already exists")) {
				throw error;
			} else if (error) {
				throw error;
			}
		}
		await rename(stage, options.out);
		console.log(`Pi-XK Harbor probe created at ${options.out}`);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
