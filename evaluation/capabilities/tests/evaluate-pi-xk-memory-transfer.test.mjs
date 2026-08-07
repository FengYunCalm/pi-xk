import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const evaluatorUrl = pathToFileURL(join(workspaceRoot, "scripts", "evaluate-pi-xk-memory-transfer.mjs")).href;
const { evaluateMemoryTransferReport, memoryTransferPlanDigest, validateMemoryTransferPlan } = await import(evaluatorUrl);

const arms = ["pi-native", "pi-xk-memory-off", "pi-xk-placebo", "pi-xk-learned"];
const episodes = ["learning", "exact-reuse", "similar-transfer", "changed-rule", "unrelated"];

function planFixture() {
	return {
		schema: "pi-xk.memory-transfer-plan.v1",
		title: "Memory retention and transfer fixture",
		minimumAttempts: 3,
		controls: {
			provider: "deepseek",
			model: "deepseek-chat",
			thinking: "low",
			wallSeconds: 300,
			toolPolicy: "pi-default",
		},
		arms: [
			{ id: "pi-native", agent: "pi-native", memorySetup: "none" },
			{ id: "pi-xk-memory-off", agent: "pi-xk", memorySetup: "disabled" },
			{ id: "pi-xk-placebo", agent: "pi-xk", memorySetup: "placebo" },
			{ id: "pi-xk-learned", agent: "pi-xk", memorySetup: "learned" },
		],
		episodes: [
			{ id: "learning", kind: "learning", relevantRecallExpected: false },
			{ id: "exact-reuse", kind: "exact-reuse", relevantRecallExpected: true },
			{ id: "similar-transfer", kind: "similar-transfer", relevantRecallExpected: true },
			{ id: "changed-rule", kind: "changed-rule", relevantRecallExpected: true },
			{ id: "unrelated", kind: "unrelated", relevantRecallExpected: false },
		],
		thresholds: {
			exactRecallRateMin: 0.8,
			similarRecallRateMin: 0.67,
			changedRulePassRateMin: 0.8,
			changedRuleRevisionRateMin: 0.67,
			unrelatedD1RateMax: 0.34,
			exactVerifierDeltaMin: 0,
			similarVerifierDeltaMin: 0,
			exactEfficiencyGainMin: 0.1,
			medianOverheadMax: 0.25,
		},
	};
}

function taskDigest(episodeId) {
	return `sha256:${episodeId.padEnd(64, "0").slice(0, 64)}`;
}

function runFixture(attempt, arm, episodeId) {
	const learned = arm === "pi-xk-learned";
	const placebo = arm === "pi-xk-placebo";
	const seeded = (learned || placebo) && episodeId !== "learning";
	const isRecallEpisode = episodeId === "exact-reuse" || episodeId === "similar-transfer" || episodeId === "changed-rule";
	const inputTokens =
		episodeId === "learning"
			? 10_000
			: learned && episodeId === "exact-reuse"
				? 6_000
				: learned
					? 8_500
					: placebo
						? 10_000
						: 9_500;
	const elapsedSeconds =
		episodeId === "learning" ? 50 : learned && episodeId === "exact-reuse" ? 30 : learned ? 42 : 50;
	return {
		id: `attempt-${attempt}-${arm}-${episodeId}`,
		attemptId: `attempt-${attempt}`,
		arm,
		episodeId,
		status: "passed",
		control: {
			model: "deepseek/deepseek-chat",
			thinking: "low",
			piVersion: "0.80.10",
			runtimeId: "pi-0.80.10-runtime-sha256:fixture",
			taskDigest: taskDigest(episodeId),
			budget: { wallSeconds: 300, toolPolicy: "pi-default" },
		},
		setup: {
			memorySetup:
				arm === "pi-native" ? "none" : arm === "pi-xk-memory-off" ? "disabled" : placebo ? "placebo" : "learned",
			seededMemories: seeded ? 1 : 0,
			seedUtf8Bytes: seeded ? 512 : 0,
			captureVerified: seeded,
		},
		metrics: {
			inputTokensIncludingCache: inputTokens,
			outputTokens: 900,
			cacheReadTokens: 1_000,
			costUsd: inputTokens / 10_000_000,
			elapsedSeconds,
			toolCalls: learned && isRecallEpisode ? 6 : 9,
			explorationCalls: learned && isRecallEpisode ? 2 : 5,
			fileReadCalls: learned && isRecallEpisode ? 1 : 3,
			duplicateFileReads: learned && isRecallEpisode ? 0 : 1,
			firstRelevantEvidenceSeconds: isRecallEpisode ? (learned ? 4 : 18) : null,
		},
		recall: {
			d1SearchCalls: learned && isRecallEpisode ? 1 : placebo && isRecallEpisode ? 1 : 0,
			d2ReadCalls: learned && isRecallEpisode ? 1 : placebo && isRecallEpisode ? 1 : 0,
			d3EvidenceCalls: 0,
			d1CandidateCount: learned && isRecallEpisode ? 1 : placebo && isRecallEpisode ? 1 : 0,
			reviewCalls: learned && episodeId === "changed-rule" ? 1 : 0,
			relatedMemoryRead: learned && isRecallEpisode,
			relatedCandidateExposed: learned && isRecallEpisode,
			publishedReview: learned && episodeId === "changed-rule",
			reviewPublication: learned && episodeId === "changed-rule" ? "applied" : "none",
			reviewFailureCode: null,
			reviewAction: learned && episodeId === "changed-rule" ? "revise" : null,
		},
		verification: {
			independent: true,
			passed: true,
			reward: 1,
			verifierDigest: taskDigest(`verifier-${episodeId}`),
		},
	};
}

function reportFixture() {
	return {
			schema: "pi-xk.memory-transfer-report.v2",
		reportKind: "deterministic-fixture",
		generatedAt: "2026-08-07T00:00:00.000Z",
		planDigest: memoryTransferPlanDigest(planFixture()),
		runs: Array.from({ length: 3 }, (_, index) => index + 1).flatMap((attempt) =>
			arms.flatMap((arm) => episodes.map((episodeId) => runFixture(attempt, arm, episodeId))),
		),
	};
}

const plan = validateMemoryTransferPlan(planFixture());
const summary = evaluateMemoryTransferReport(plan, reportFixture());
assert.equal(summary.schema, "pi-xk.memory-transfer-summary.v2");
assert.equal(summary.coverage.attempts, 3);
assert.equal(summary.coverage.complete, true);
assert.equal(summary.retention.exactReuse.relevantRecallRate, 1);
assert.equal(summary.retention.exactReuse.candidateExposureRate, 1);
assert.equal(summary.retention.exactReuse.candidateToReadRate, 1);
assert.equal(summary.retention.exactReuse.d1CandidateCountMedian, 1);
assert.equal(summary.retention.similarTransfer.relevantRecallRate, 1);
assert.equal(summary.effects.sameTask.learnedPassRate, 1);
assert.equal(summary.effects.sameTask.inputTokenDeltaRatioVsPlacebo, -0.4);
assert.equal(summary.effects.similarTask.retention.relatedCandidateReadRate, 1);
assert.equal(summary.retention.changedRule.passRate, 1);
assert.equal(summary.retention.changedRule.revisionRate, 1);
assert.equal(summary.retention.changedRule.reviewPublicationRate, 1);
assert.equal(summary.retention.unrelated.d1Rate, 0);
assert.equal(summary.comparisons.exactReuse.learnedVsPlacebo.verifierDelta, 0);
assert.equal(summary.comparisons.exactReuse.learnedVsPlacebo.inputTokenDeltaRatio, -0.4);
assert.equal(summary.comparisons.exactReuse.learningToLearned.inputTokenDeltaRatio, -0.4);
assert.equal(summary.thresholds.every((threshold) => threshold.passed), true);
assert.equal(summary.claimReady, true);

const missingArm = reportFixture();
missingArm.runs = missingArm.runs.filter(
	(run) => !(run.attemptId === "attempt-2" && run.arm === "pi-xk-placebo" && run.episodeId === "similar-transfer"),
);
assert.throws(() => evaluateMemoryTransferReport(plan, missingArm), /exactly one run/u);

const mismatchedControl = reportFixture();
mismatchedControl.runs.find(
	(run) => run.attemptId === "attempt-1" && run.arm === "pi-native" && run.episodeId === "exact-reuse",
).control.thinking = "medium";
assert.throws(() => evaluateMemoryTransferReport(plan, mismatchedControl), /identical controls/u);

const falseRecall = reportFixture();
for (const run of falseRecall.runs) {
	if (run.arm === "pi-xk-learned" && run.episodeId === "similar-transfer") run.recall.relatedMemoryRead = false;
}
const falseRecallSummary = evaluateMemoryTransferReport(plan, falseRecall);
assert.equal(falseRecallSummary.retention.similarTransfer.relevantRecallRate, 0);
assert.equal(falseRecallSummary.claimReady, false);

const impossibleExposure = reportFixture();
const impossibleExposureRun = impossibleExposure.runs.find(
	(run) => run.arm === "pi-xk-learned" && run.episodeId === "exact-reuse",
);
impossibleExposureRun.recall.d1CandidateCount = 0;
assert.throws(() => evaluateMemoryTransferReport(plan, impossibleExposure), /relatedCandidateExposed requires a D1 candidate/u);

const sensitive = reportFixture();
sensitive.runs[0].prompt = "must not enter a sanitized report";
assert.throws(() => evaluateMemoryTransferReport(plan, sensitive), /forbidden/u);

const leakedMemory = reportFixture();
leakedMemory.runs[0].memoryStatement = "must not enter a sanitized report";
assert.throws(() => evaluateMemoryTransferReport(plan, leakedMemory), /forbidden/u);

const legacyReport = reportFixture();
legacyReport.schema = "pi-xk.memory-transfer-report.v1";
for (const run of legacyReport.runs) {
	delete run.recall.d1CandidateCount;
	delete run.recall.relatedCandidateExposed;
	delete run.recall.reviewPublication;
	delete run.recall.reviewFailureCode;
}
const legacySummary = evaluateMemoryTransferReport(plan, legacyReport);
assert.equal(legacySummary.claimReady, false);
assert.equal(legacySummary.retention.exactReuse.candidateExposureRate, 0);
assert.match(legacySummary.limitations.at(-1), /Legacy v1 reports/u);
