import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "prepare-pi-xk-harbor-probe.mjs");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-harbor-probe-test-"),
);
const sourceRoot = join(temporaryRoot, "source");
const exerciseRoot = join(sourceRoot, "python", "exercises", "practice", "phone-number");
const manifestPath = join(temporaryRoot, "manifest.json");
const outputRoot = join(temporaryRoot, "probe");

try {
	await mkdir(join(exerciseRoot, ".docs"), { recursive: true });
	await mkdir(join(exerciseRoot, ".meta"), { recursive: true });
	await writeFile(join(exerciseRoot, "phone_number.py"), "VALUE = 'starter'\n");
	await writeFile(join(exerciseRoot, "phone_number_test.py"), "assert True\n");
	await writeFile(join(exerciseRoot, ".docs", "instructions.md"), "Implement a phone number parser.\n");
	await writeFile(join(exerciseRoot, ".meta", "example.py"), "VALUE = 'reference implementation'\n");

	execFileSync("git", ["init", "-q", sourceRoot]);
	execFileSync("git", ["-C", sourceRoot, "config", "user.email", "probe@example.invalid"]);
	execFileSync("git", ["-C", sourceRoot, "config", "user.name", "Pi-XK Probe"]);
	execFileSync("git", ["-C", sourceRoot, "add", "."]);
	execFileSync("git", ["-C", sourceRoot, "commit", "-qm", "fixture"]);
	const commit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const manifest = {
		schema: "pi-xk.harbor-aider-polyglot-probe.v1",
		harness: {
			name: "Harbor",
			repository: "https://github.com/harbor-framework/harbor.git",
			commit: "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
			version: "0.20.0",
		},
		upstream: { repository: "https://example.invalid/polyglot.git", commit },
		agentAllowedHosts: ["api.deepseek.com"],
		agentTimeoutSeconds: 900,
		networkPolicyProfile: "portable-loopback-v1",
		tasks: [
			{
				id: "fixture-python-phone-number",
				language: "python",
				upstreamPath: "python/exercises/practice/phone-number",
				instructionFiles: [".docs/instructions.md"],
				oracleCopies: [{ from: ".meta/example.py", to: "phone_number.py" }],
				verifierCopies: [{ from: "phone_number_test.py", to: "phone_number_test.py" }],
				testCommand: 'PYTHONPATH="$APP_DIR" python3 "$TEST_DIR/phone_number_test.py"',
			},
			{
				id: "fixture-java-wrapper-timeout",
				language: "java",
				upstreamPath: "python/exercises/practice/phone-number",
				instructionFiles: [".docs/instructions.md"],
				oracleCopies: [{ from: ".meta/example.py", to: "phone_number.py" }],
				verifierCopies: [{ from: "phone_number_test.py", to: "phone_number_test.py" }],
				testCommand: "true",
			},
		],
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

	const result = spawnSync(process.execPath, [scriptPath, "--manifest", manifestPath, "--source", sourceRoot, "--out", outputRoot], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const taskRoot = join(outputRoot, "fixture-python-phone-number");
	const workspace = join(taskRoot, "environment", "workspace");
	assert.equal(await readFile(join(workspace, "phone_number.py"), "utf8"), "VALUE = 'starter'\n");
	await assert.rejects(readFile(join(workspace, ".meta", "example.py"), "utf8"));
	assert.equal(await readFile(join(taskRoot, "solution", "oracle", "phone_number.py"), "utf8"), "VALUE = 'reference implementation'\n");
	assert.match(await readFile(join(taskRoot, "instruction.md"), "utf8"), /phone number parser/u);
	assert.match(await readFile(join(taskRoot, "tests", "test.sh"), "utf8"), /reward\.txt/u);
	const taskToml = await readFile(join(taskRoot, "task.toml"), "utf8");
	assert.match(taskToml, /network_mode = "allowlist"/u);
	assert.match(taskToml, /allowed_hosts = \["api\.deepseek\.com"\]/u);
	assert.match(taskToml, /\[agent\][\s\S]*timeout_sec = 900\.0/u);
	assert.match(taskToml, /network_mode = "no-network"/u);
	const networkCompose = await readFile(join(taskRoot, "environment", "docker-compose.yaml"), "utf8");
	assert.match(networkCompose, /harbor-docker-egress-control-sidecar/u);
	assert.match(networkCompose, /network-policy-portable-loopback-v1/u);
	assert.match(networkCompose, /read_only: true/u);
	const networkPolicy = await readFile(
		join(taskRoot, "environment", "network-policy-portable-loopback-v1"),
		"utf8",
	);
	assert.doesNotMatch(networkPolicy, /^\s*fib daddr/mu);
	assert.match(networkPolicy, /ip daddr 127\.0\.0\.0\/8/u);
	assert.match(networkPolicy, /ip6 daddr ::1/u);
	const javaDockerfile = await readFile(
		join(outputRoot, "fixture-java-wrapper-timeout", "environment", "Dockerfile"),
		"utf8",
	);
	assert.match(javaDockerfile, /networkTimeout=600000/u);
	assert.match(javaDockerfile, /gradlew --no-daemon --init-script [^\n]+ testClasses piXkResolveTestRuntime/u);
	assert.match(javaDockerfile, /testRuntimeClasspath/u);
	assert.match(javaDockerfile, /\.resolve\(\)/u);

	const oracleApp = join(temporaryRoot, "oracle-app");
	await cp(workspace, oracleApp, { recursive: true });
	const oracle = spawnSync("bash", [join(taskRoot, "solution", "solve.sh")], {
		env: { ...process.env, APP_DIR: oracleApp, SOLUTION_DIR: join(taskRoot, "solution") },
		encoding: "utf8",
	});
	assert.equal(oracle.status, 0, oracle.stderr);
	assert.equal(await readFile(join(oracleApp, "phone_number.py"), "utf8"), "VALUE = 'reference implementation'\n");
	const verifierLogs = join(temporaryRoot, "verifier-logs");
	const verifier = spawnSync("bash", [join(taskRoot, "tests", "test.sh")], {
		env: {
			...process.env,
			APP_DIR: oracleApp,
			TEST_DIR: join(taskRoot, "tests"),
			LOGS_DIR: verifierLogs,
		},
		encoding: "utf8",
	});
	assert.equal(verifier.status, 0, verifier.stderr);
	assert.equal(await readFile(join(verifierLogs, "verifier", "reward.txt"), "utf8"), "1\n");

	const wrongPinManifest = join(temporaryRoot, "wrong-pin.json");
	await writeFile(wrongPinManifest, `${JSON.stringify({ ...manifest, upstream: { ...manifest.upstream, commit: "a".repeat(40) } })}\n`);
	const wrongPin = spawnSync(process.execPath, [scriptPath, "--manifest", wrongPinManifest, "--source", sourceRoot, "--out", join(temporaryRoot, "wrong-pin")], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(wrongPin.status, 0);
	assert.match(wrongPin.stderr, /source commit mismatch/u);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
