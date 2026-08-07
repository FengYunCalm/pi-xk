import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildHarborTrialArgs,
	buildPublicParitySchedule,
	markExecutionAborted,
	resolveRegisteredProbeManifest,
	verifyDockerBuildx,
	verifyDockerCompose,
	verifyHarborTrialResult,
	verifyHarborRuntime,
} from "../../../scripts/run-pi-xk-public-parity.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const plan = JSON.parse(
	await readFile(`${workspaceRoot}/evaluation/capabilities/public-parity-plan.json`, "utf8"),
);

const schedule = buildPublicParitySchedule(plan);
assert.equal(schedule.length, 10);
assert.deepEqual(
	schedule.slice(0, 4).map((entry) => `${entry.attemptId}:${entry.agent}`),
	["pair-01:pi-native", "pair-01:pi-xk", "pair-02:pi-xk", "pair-02:pi-native"],
);

const args = buildHarborTrialArgs({
	entry: schedule[0],
	plan,
	taskRoot: "/tmp/probe/task",
	trialsRoot: "/tmp/results/trials",
	bundleRoot: "/tmp/bundle",
});
assert.deepEqual(args.slice(0, 2), ["trials", "start"]);
assert.ok(args.includes("harbor_pi_xk.agent:PiNative"));
assert.ok(args.includes("deepseek/deepseek-chat"));
assert.ok(args.includes("900"));
assert.ok(args.includes("--agent-setup-timeout"));
assert.equal(args[args.indexOf("--agent-setup-timeout") + 1], "900");
assert.ok(args.includes("thinking=low"));
assert.ok(args.includes("telemetry_path=/tmp/bundle/harbor-telemetry.mjs"));
assert.ok(args.includes("pi_runtime_bundle_dir=/tmp/bundle"));
assert.equal(args.some((argument) => argument.includes("DEEPSEEK_API_KEY")), false);

const xkArgs = buildHarborTrialArgs({
	entry: schedule[1],
	plan,
	taskRoot: "/tmp/probe/task",
	trialsRoot: "/tmp/results/trials",
	bundleRoot: "/tmp/bundle",
});
assert.ok(xkArgs.includes("harbor_pi_xk.agent:PiXk"));
assert.ok(xkArgs.includes("extension_bundle_dir=/tmp/bundle"));
assert.equal(xkArgs[xkArgs.indexOf("--agent-setup-timeout") + 1], "900");
assert.equal(xkArgs.some((argument) => argument.includes("telemetry_path=")), false);

const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-public-parity-runner-test-"),
);
try {
	const planRoot = join(temporaryRoot, "plan-root");
	await mkdir(planRoot);
	await writeFile(join(planRoot, "probe.json"), "{}\n");
	assert.equal(
		await resolveRegisteredProbeManifest({ benchmark: { probeManifest: "probe.json" } }, planRoot),
		join(planRoot, "probe.json"),
	);
	await assert.rejects(
		resolveRegisteredProbeManifest({ benchmark: { probeManifest: "../outside.json" } }, planRoot),
		/probeManifest must stay inside/u,
	);

	const harborRoot = join(temporaryRoot, "harbor");
	await mkdir(harborRoot);
	await writeFile(join(harborRoot, "pyproject.toml"), 'version = "0.20.0"\n');
	const harborBin = join(harborRoot, "harbor");
	await writeFile(harborBin, "#!/usr/bin/env sh\nexit 0\n");
	await chmod(harborBin, 0o755);
	execFileSync("git", ["init", "-q", harborRoot]);
	execFileSync("git", ["-C", harborRoot, "config", "user.email", "runner@example.invalid"]);
	execFileSync("git", ["-C", harborRoot, "config", "user.name", "Pi-XK Runner"]);
	execFileSync("git", ["-C", harborRoot, "add", "."]);
	execFileSync("git", ["-C", harborRoot, "commit", "-qm", "fixture"]);
	const harborCommit = execFileSync("git", ["-C", harborRoot, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	await verifyHarborRuntime(harborRoot, harborBin, { commit: harborCommit, version: "0.20.0" });
	await writeFile(join(harborRoot, "untracked.txt"), "must make checkout dirty\n");
	await assert.rejects(
		verifyHarborRuntime(harborRoot, harborBin, { commit: harborCommit, version: "0.20.0" }),
		/checkout must be clean/u,
	);

	await verifyDockerBuildx(async () => "github.com/docker/buildx 0.30.1");
	await assert.rejects(
		verifyDockerBuildx(async () => {
			throw new Error("docker: unknown command: docker buildx");
		}),
		/Docker Buildx is unavailable/u,
	);
	await verifyDockerCompose(async () => "Docker Compose version v2.40.3");
	await assert.rejects(
		verifyDockerCompose(async () => {
			throw new Error("docker: unknown command: docker compose");
		}),
		/Docker Compose is unavailable/u,
	);

	const trialRoot = join(temporaryRoot, "trial");
	await mkdir(trialRoot);
	const successfulTrial = {
		trial_name: "pair-01-pi-native",
		agent_result: {},
		verifier_result: { rewards: { reward: 0 } },
		exception_info: null,
	};
	await writeFile(join(trialRoot, "result.json"), `${JSON.stringify(successfulTrial)}\n`);
	await verifyHarborTrialResult(trialRoot, "pair-01-pi-native");
	await writeFile(
		join(trialRoot, "result.json"),
		`${JSON.stringify({ ...successfulTrial, exception_info: { exception_type: "RuntimeError" } })}\n`,
	);
	await assert.rejects(
		verifyHarborTrialResult(trialRoot, "pair-01-pi-native"),
		/Harbor trial pair-01-pi-native reported RuntimeError/u,
	);

	const state = {
		status: "running",
		finishedAt: null,
		entries: [
			{ status: "completed", finishedAt: "2026-08-06T00:00:00.000Z" },
			{ status: "running", finishedAt: null },
		],
	};
	markExecutionAborted(state, "2026-08-06T00:01:00.000Z");
	assert.equal(state.status, "aborted");
	assert.equal(state.finishedAt, "2026-08-06T00:01:00.000Z");
	assert.equal(state.entries[0].status, "completed");
	assert.equal(state.entries[1].status, "failed");
	assert.equal(state.entries[1].finishedAt, "2026-08-06T00:01:00.000Z");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
