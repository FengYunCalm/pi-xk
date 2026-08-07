import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "evaluate-pi-xk-capabilities.mjs");
const matrixPath = join(workspaceRoot, "evaluation", "capabilities", "capability-matrix.json");
const fixturePath = join(workspaceRoot, "evaluation", "capabilities", "fixtures", "first-public-parity-report.json");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-capability-eval-test-"),
);

try {
	const baseline = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", fixturePath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.equal(baseline.status, 0, baseline.stderr);
	const summary = JSON.parse(baseline.stdout);
	assert.deepEqual(summary.publicParity, []);
	assert.deepEqual(summary.publicCalibration, [
		{
			comparisonId: "aider-polyglot-python-phone-number-deepseek-chat-low",
			outcome: "tied",
			piNative: {
				reward: 1,
				inputTokensIncludingCache: 34997,
				outputTokens: 2610,
				costUsd: 0.004684283,
				elapsedSeconds: 247.466,
			},
			piXk: {
				reward: 1,
				inputTokensIncludingCache: 149515,
				outputTokens: 5200,
				costUsd: 0.009874529,
				elapsedSeconds: 310.194,
			},
		},
	]);
	assert.deepEqual(summary.workflow, []);
	assert.equal(summary.coverage.publicParity[0].covered, false);
	assert.equal(summary.coverage.publicParity[0].calibrated, true);
	assert.equal(summary.coverage.publicParity[0].comparisonCount, 0);
	assert.equal(summary.coverage.publicParity[0].minimumComparisons, 5);
	assert.equal(summary.coverage.publicParity[0].sufficient, false);
	assert.equal(summary.coverage.workflow.every((scenario) => scenario.covered === false), true);
	assert.deepEqual(summary.statistics, {
		publicParity: { comparisons: 0, piXkAdvantages: 0, piNativeAdvantages: 0, ties: 0 },
		publicCalibration: { comparisons: 1, piXkAdvantages: 0, piNativeAdvantages: 0, ties: 1 },
		workflow: { runs: 0, passed: 0, failed: 0, inconclusive: 0, other: 0 },
	});

	const calibrationReport = JSON.parse(await readFile(fixturePath, "utf8"));
	const calibrationPath = join(temporaryRoot, "calibration.json");
	await writeFile(calibrationPath, `${JSON.stringify(calibrationReport)}\n`);
	const calibration = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", calibrationPath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.equal(calibration.status, 0, calibration.stderr);
	const calibrationSummary = JSON.parse(calibration.stdout);
	assert.deepEqual(calibrationSummary.publicParity, []);
	assert.deepEqual(calibrationSummary.publicCalibration.map((comparison) => comparison.comparisonId), [
		"aider-polyglot-python-phone-number-deepseek-chat-low",
	]);
	assert.equal(calibrationSummary.coverage.publicParity[0].covered, false);
	assert.equal(calibrationSummary.coverage.publicParity[0].calibrated, true);

	const report = JSON.parse(await readFile(fixturePath, "utf8"));
	report.reportKind = "public-evaluation";
	report.runs[1].control.thinking = "medium";
	const mismatchedControlPath = join(temporaryRoot, "mismatched-control.json");
	await writeFile(mismatchedControlPath, `${JSON.stringify(report)}\n`);
	const mismatch = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", mismatchedControlPath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(mismatch.status, 0);
	assert.match(mismatch.stderr, /identical controls/u);

	report.runs[1].control.thinking = "low";
	const fauxEvaluation = structuredClone(report);
	fauxEvaluation.runs[0].execution = "faux-provider";
	const fauxEvaluationPath = join(temporaryRoot, "faux-evaluation.json");
	await writeFile(fauxEvaluationPath, `${JSON.stringify(fauxEvaluation)}\n`);
	const fauxEvaluationResult = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", fauxEvaluationPath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(fauxEvaluationResult.status, 0);
	assert.match(fauxEvaluationResult.stderr, /real provider/u);

	const nonIndependentEvaluation = structuredClone(report);
	nonIndependentEvaluation.runs[0].verification.independent = false;
	const nonIndependentEvaluationPath = join(temporaryRoot, "non-independent-evaluation.json");
	await writeFile(nonIndependentEvaluationPath, `${JSON.stringify(nonIndependentEvaluation)}\n`);
	const nonIndependentEvaluationResult = spawnSync(
		process.execPath,
		[scriptPath, "--matrix", matrixPath, "--report", nonIndependentEvaluationPath],
		{ cwd: workspaceRoot, encoding: "utf8" },
	);
	assert.notEqual(nonIndependentEvaluationResult.status, 0);
	assert.match(nonIndependentEvaluationResult.stderr, /independent verifier/u);

	report.runs[1].verification.apiKey = "must-be-rejected";
	const sensitivePath = join(temporaryRoot, "sensitive.json");
	await writeFile(sensitivePath, `${JSON.stringify(report)}\n`);
	const sensitive = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", sensitivePath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(sensitive.status, 0);
	assert.match(sensitive.stderr, /forbidden/u);

	delete report.runs[1].verification.apiKey;
	report.runs[1].title = "trajectory-bearing data must not be accepted";
	const unexpectedFieldPath = join(temporaryRoot, "unexpected-field.json");
	await writeFile(unexpectedFieldPath, `${JSON.stringify(report)}\n`);
	const unexpectedField = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", unexpectedFieldPath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(unexpectedField.status, 0);
	assert.match(unexpectedField.stderr, /forbidden/u);

	delete report.runs[1].title;
	const workflowRun = structuredClone(report.runs[0]);
	workflowRun.id = "faux-goal-contract-continuity";
	workflowRun.scenarioId = "goal-contract-continuity";
	workflowRun.agent = "pi-xk";
	workflowRun.execution = "faux-provider";
	workflowRun.control.model = "faux-provider";
	workflowRun.control.thinking = "not-applicable";
	workflowRun.verification.independent = false;
	delete workflowRun.comparisonId;
	const workflowReportPath = join(temporaryRoot, "workflow.json");
	await writeFile(
		workflowReportPath,
		`${JSON.stringify({ schema: report.schema, reportKind: "workflow-validation", generatedAt: report.generatedAt, runs: [workflowRun] })}\n`,
	);
	const workflow = spawnSync(process.execPath, [scriptPath, "--matrix", matrixPath, "--report", workflowReportPath], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.equal(workflow.status, 0, workflow.stderr);
	assert.equal(JSON.parse(workflow.stdout).workflow[0].scenarioId, "goal-contract-continuity");

	const combined = spawnSync(
		process.execPath,
		[scriptPath, "--matrix", matrixPath, "--report", fixturePath, "--report", workflowReportPath],
		{
			cwd: workspaceRoot,
			encoding: "utf8",
		},
	);
	assert.equal(combined.status, 0, combined.stderr);
	const combinedSummary = JSON.parse(combined.stdout);
	assert.equal(combinedSummary.publicParity.length, 0);
	assert.equal(combinedSummary.publicCalibration[0].outcome, "tied");
	assert.deepEqual(combinedSummary.statistics.workflow, {
		runs: 1,
		passed: 1,
		failed: 0,
		inconclusive: 0,
		other: 0,
	});
	assert.deepEqual(combinedSummary.workflow, [
		{
			id: "faux-goal-contract-continuity",
			scenarioId: "goal-contract-continuity",
			execution: "faux-provider",
			status: "passed",
			structural: true,
			independent: false,
		},
	]);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
