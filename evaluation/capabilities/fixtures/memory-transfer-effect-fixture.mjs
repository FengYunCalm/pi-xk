import { createHash } from "node:crypto";
import { memoryTransferPlanDigest } from "../../../scripts/evaluate-pi-xk-memory-transfer.mjs";

function digest(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function run(plan, attempt, arm, episodeId) {
	const learned = arm.id === "pi-xk-learned";
	const placebo = arm.id === "pi-xk-placebo";
	const seeded = (learned || placebo) && episodeId !== "learning";
	const recallEpisode = ["exact-reuse", "similar-transfer", "changed-rule"].includes(episodeId);
	const inputTokens =
		episodeId === "learning" ? 10_000 : learned && episodeId === "exact-reuse" ? 6_000 : learned ? 8_500 : placebo ? 10_000 : 9_500;
	const passed = true;
	return {
		id: `fixture-${attempt}-${arm.id}-${episodeId}`,
		attemptId: `attempt-${String(attempt).padStart(2, "0")}`,
		arm: arm.id,
		episodeId,
		status: "passed",
		control: {
			model: `${plan.controls.provider}/${plan.controls.model}`,
			thinking: plan.controls.thinking,
			piVersion: "0.80.10",
			runtimeId: "pi-0.80.10-runtime-sha256:deterministic-fixture",
			taskDigest: digest(`memory-transfer-task-v1:${episodeId}`),
			budget: { wallSeconds: plan.controls.wallSeconds, toolPolicy: plan.controls.toolPolicy },
		},
		setup: {
			memorySetup: arm.memorySetup,
			seededMemories: seeded ? 1 : 0,
			seedUtf8Bytes: seeded ? 512 : 0,
			captureVerified: seeded,
		},
		metrics: {
			inputTokensIncludingCache: inputTokens,
			outputTokens: 900,
			cacheReadTokens: 1_000,
			costUsd: inputTokens / 10_000_000,
			elapsedSeconds: episodeId === "learning" ? 50 : learned && episodeId === "exact-reuse" ? 30 : learned ? 42 : 50,
			toolCalls: learned && recallEpisode ? 6 : 9,
			explorationCalls: learned && recallEpisode ? 2 : 5,
			fileReadCalls: learned && recallEpisode ? 1 : 3,
			duplicateFileReads: learned && recallEpisode ? 0 : 1,
			firstRelevantEvidenceSeconds: recallEpisode ? (learned ? 4 : 18) : null,
		},
		recall: {
				d1SearchCalls: learned && recallEpisode ? 1 : placebo && recallEpisode ? 1 : 0,
				d2ReadCalls: learned && recallEpisode ? 1 : placebo && recallEpisode ? 1 : 0,
				d3EvidenceCalls: 0,
				d1CandidateCount: learned && recallEpisode ? 1 : placebo && recallEpisode ? 1 : 0,
				reviewCalls: learned && episodeId === "changed-rule" ? 1 : 0,
				relatedMemoryRead: learned && recallEpisode,
				relatedCandidateExposed: learned && recallEpisode,
				publishedReview: learned && episodeId === "changed-rule",
				reviewPublication: learned && episodeId === "changed-rule" ? "applied" : "none",
				reviewFailureCode: null,
				reviewAction: learned && episodeId === "changed-rule" ? "revise" : null,
		},
		verification: {
			independent: true,
			passed,
			reward: 1,
			verifierDigest: digest(`memory-transfer-verifier-v1:${episodeId}`),
		},
	};
}

export function buildMemoryTransferEffectFixture(plan) {
	return {
		schema: "pi-xk.memory-transfer-report.v2",
		reportKind: "deterministic-fixture",
		generatedAt: "2026-08-07T00:00:00.000Z",
		planDigest: memoryTransferPlanDigest(plan),
		runs: Array.from({ length: plan.minimumAttempts }, (_, index) => index + 1).flatMap((attempt) =>
			plan.episodes.flatMap((episode) => plan.arms.map((arm) => run(plan, attempt, arm, episode.id))),
		),
	};
}
