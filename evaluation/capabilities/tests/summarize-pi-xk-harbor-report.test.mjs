import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "summarize-pi-xk-harbor-report.mjs");
const planPath = join(workspaceRoot, "evaluation", "capabilities", "public-parity-plan.json");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-harbor-summary-test-"),
);

async function writeTrial(
	directory,
	agent,
	reward,
	costUsd,
	{
		bundleSourceCommit = "a".repeat(40),
		bundleContentDigest = "d".repeat(64),
		runtimeArchiveDigest = "b".repeat(64),
		harnessVersion = "0.20.0",
		harnessSourceCommit = "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
		taskChecksum = "a".repeat(64),
	} = {},
) {
	const startedAt = agent === "pi-native" ? "2026-08-05T00:00:00.000Z" : "2026-08-05T00:00:03.000Z";
	const finishedAt = agent === "pi-native" ? "2026-08-05T00:00:02.000Z" : "2026-08-05T00:00:05.000Z";
	await mkdir(join(directory, "agent"), { recursive: true });
	await writeFile(
		join(directory, "result.json"),
		`${JSON.stringify({
			task_checksum: taskChecksum,
			task_name: "pi-xk-evaluation/aider-polyglot-python-phone-number",
			started_at: startedAt,
			finished_at: finishedAt,
			exception_info: null,
			agent_result: {
				n_input_tokens: 100,
				n_output_tokens: 20,
				n_cache_tokens: 40,
				cost_usd: costUsd,
			},
			verifier_result: { rewards: { reward } },
		})}\n`,
	);
	await writeFile(
		join(directory, "agent", `${agent}-summary.json`),
		`${JSON.stringify({
			agent,
			model: "deepseek/deepseek-chat",
			pi_version: "0.80.10",
			bundle_source_commit: bundleSourceCommit,
			bundle_content_digest: bundleContentDigest,
			runtime_archive_digest: runtimeArchiveDigest,
			harbor_version: harnessVersion,
			harbor_source_commit: harnessSourceCommit,
		})}\n`,
	);
}

try {
	const native = join(temporaryRoot, "native");
	const xk = join(temporaryRoot, "xk");
	const output = join(temporaryRoot, "report.json");
	await writeTrial(native, "pi-native", 1, 0.01);
	await writeTrial(xk, "pi-xk", 0, 0.02);

	const result = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			native,
			"--xk",
			xk,
		"--out",
		output,
		"--thinking",
		"low",
		"--plan",
		planPath,
		"--attempt",
		"pair-01",
	],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(await readFile(output, "utf8"));
	assert.equal(report.schema, "pi-xk.capability-report.v1");
	assert.equal(report.reportKind, "public-evaluation");
	assert.equal(report.runs.length, 2);
	assert.equal(report.runs[0].status, "passed");
	assert.equal(report.runs[1].status, "failed");
	assert.match(report.runs[0].comparisonId, /-pair-01$/u);
	assert.match(report.runs[0].id, /-pair-01$/u);
	assert.equal(
		report.runs[0].control.runtimeId,
		`harbor-0.20.0-${"459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc"}-pi-0.80.10-${"a".repeat(40)}-${"d".repeat(64)}-${"b".repeat(64)}`,
	);
	assert.equal(report.runs[0].metrics.inputTokensIncludingCache, 100);
	assert.equal(report.runs[0].metrics.cacheReadTokens, 40);
	assert.equal(JSON.stringify(report).includes("api_key"), false);
	assert.equal(JSON.stringify(report).includes("prompt"), false);

	const mismatchedRuntime = join(temporaryRoot, "mismatched-runtime");
	await writeTrial(mismatchedRuntime, "pi-xk", 1, 0.02, { runtimeArchiveDigest: "c".repeat(64) });
	const mismatch = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			native,
			"--xk",
			mismatchedRuntime,
		"--out",
		join(temporaryRoot, "mismatch.json"),
		"--thinking",
		"low",
		"--plan",
		planPath,
		"--attempt",
		"pair-01",
	],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stderr, /same Pi runtime control/u);

	const mismatchedBundle = join(temporaryRoot, "mismatched-bundle");
	await writeTrial(mismatchedBundle, "pi-xk", 1, 0.02, { bundleContentDigest: "c".repeat(64) });
	const bundleMismatch = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			native,
			"--xk",
			mismatchedBundle,
			"--out",
			join(temporaryRoot, "mismatch-bundle.json"),
			"--thinking",
			"low",
			"--plan",
			planPath,
			"--attempt",
			"pair-01",
		],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(bundleMismatch.status, 0);
	assert.match(bundleMismatch.stderr, /same Pi runtime control/u);

	const invalidChecksum = join(temporaryRoot, "invalid-checksum");
	await writeTrial(invalidChecksum, "pi-native", 1, 0.01, { taskChecksum: "not-a-digest" });
	const invalidChecksumResult = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			invalidChecksum,
			"--xk",
			xk,
			"--out",
			join(temporaryRoot, "invalid-checksum.json"),
			"--thinking",
			"low",
			"--plan",
			planPath,
			"--attempt",
			"pair-01",
		],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(invalidChecksumResult.status, 0);
	assert.match(invalidChecksumResult.stderr, /task_checksum must be a lowercase hexadecimal digest/u);

	const mismatchedHarness = join(temporaryRoot, "mismatched-harness");
	await writeTrial(mismatchedHarness, "pi-xk", 1, 0.02, {
		harnessSourceCommit: "c".repeat(40),
	});
	const harnessMismatch = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			native,
			"--xk",
			mismatchedHarness,
			"--out",
			join(temporaryRoot, "mismatch-harness.json"),
			"--thinking",
			"low",
			"--plan",
			planPath,
			"--attempt",
			"pair-01",
		],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(harnessMismatch.status, 0);
	assert.match(harnessMismatch.stderr, /harness commit/u);

	const wrongAttempt = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--native",
			native,
			"--xk",
			xk,
			"--out",
			join(temporaryRoot, "wrong-attempt.json"),
			"--thinking",
			"low",
			"--plan",
			planPath,
			"--attempt",
			"pair-02",
		],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(wrongAttempt.status, 0);
	assert.match(wrongAttempt.stderr, /does not register task/u);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
