import { describe, expect, it } from "vitest";
import {
	type AgentRunEvidenceRefV2,
	type MemoryReconstructionTraceV1,
	type MemoryReviewDecisionV1,
	type MemoryRevisionV2,
	MemoryValidationError,
	validateMemoryReconstructionTraceV1,
	validateMemoryReviewDecisionV1,
	validateMemoryRevisionV2,
} from "../src/index.ts";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function agentRunEvidence(): AgentRunEvidenceRefV2 {
	return {
		schema: "pi-xk.memory-evidence-ref.v2",
		evidenceId: "evidence_agent_run_1",
		sourceType: "agent_run",
		sourceId: "session_1:request_1",
		artifactId: null,
		sourceDigest: digest("a"),
		recordedAt: "2026-08-03T00:00:00.000Z",
		locator: {
			projectId: "project_pi_xk",
			sessionId: "session_1",
			sessionFile: "/tmp/pi-xk/session_1.jsonl",
			chainId: "chain_1",
			branchId: "branch_1",
			segmentId: "segment_1",
			requestEntryId: "entry_user_1",
			terminalAssistantEntryId: "entry_assistant_1",
			toolResultEntryIds: ["entry_tool_1"],
			rangeDigest: digest("b"),
		},
	};
}

function reviewDecision(): MemoryReviewDecisionV1 {
	return {
		schema: "pi-xk.memory-review-decision.v1",
		decisionId: "review_run_1_memory_1",
		runId: "run_1",
		action: "revise",
		sourceMemories: [{ memoryId: "memory_1", expectedRevision: 1 }],
		replacement: {
			kind: "decision",
			title: "Use settled publication",
			statement: "Semantic Memory changes publish only after a successful settled run.",
			applicability: "Pi-XK ambient Memory runs.",
			effectiveFrom: "2026-08-03T00:00:00.000Z",
			cueIds: ["cue_memory"],
		},
		evidenceIds: ["evidence_agent_run_1"],
		reason: "The current implementation established a stronger publication boundary.",
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.memory-review-v1",
			recordedAt: "2026-08-03T00:00:00.000Z",
		},
	};
}

function revision(): MemoryRevisionV2 {
	return {
		schema: "pi-xk.memory-revision.v2",
		memoryId: "memory_1",
		revision: 2,
		kind: "decision",
		title: "Use settled publication",
		statement: "Semantic Memory changes publish only after a successful settled run.",
		applicability: "Pi-XK ambient Memory runs.",
		trust: "model_inferred",
		lifecycle: "active",
		effectiveFrom: "2026-08-03T00:00:00.000Z",
		effectiveTo: null,
		cueIds: ["cue_memory"],
		evidenceRefs: [agentRunEvidence()],
		freshnessBasis: null,
		sourceDigest: digest("c"),
		supersedesRevision: 1,
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.memory-review-v1",
			recordedAt: "2026-08-03T00:00:00.000Z",
		},
		transition: {
			mode: "revise",
			reviewId: "review_run_1_memory_1",
			sourceRevisions: [{ memoryId: "memory_1", revision: 1 }],
			trustDerivation: "model-reconstruction",
		},
	};
}

function trace(): MemoryReconstructionTraceV1 {
	return {
		schema: "pi-xk.memory-reconstruction-trace.v1",
		runId: "run_1",
		sessionId: "session_1",
		startedAt: "2026-08-03T00:00:00.000Z",
		settledAt: "2026-08-03T00:00:01.000Z",
		queryDigests: [digest("d")],
		candidateIds: ["memory_1"],
		readRevisions: [{ memoryId: "memory_1", revision: 1 }],
		evidenceIds: ["evidence_agent_run_1"],
		decisions: ["review_run_1_memory_1"],
		budgetUsage: {
			totalKnowledgeActions: 3,
			memoryActions: 3,
			memorySearchCalls: 1,
			uniqueMemoryReads: 1,
			evidenceReads: 1,
			skillCandidateActions: 0,
		},
		stopReason: "sufficient",
		outcome: "succeeded",
	};
}

describe("Ambient Memory contracts", () => {
	it("validates review decisions, traces, agent-run evidence, and v2 revisions", () => {
		expect(validateMemoryReviewDecisionV1(reviewDecision())).toEqual(reviewDecision());
		expect(validateMemoryReconstructionTraceV1(trace())).toEqual(trace());
		expect(validateMemoryRevisionV2(revision())).toEqual(revision());
	});

	it("rejects destructive model review actions and unsupported verified derivations", () => {
		expect(() => validateMemoryReviewDecisionV1({ ...reviewDecision(), action: "purge" })).toThrow(
			MemoryValidationError,
		);
		expect(() =>
			validateMemoryRevisionV2({
				...revision(),
				trust: "verified",
				transition: { ...revision().transition, trustDerivation: "model-reconstruction" },
			}),
		).toThrow("verified");
	});

	it("rejects trace bodies and over-budget usage", () => {
		expect(() => validateMemoryReconstructionTraceV1({ ...trace(), prompt: "do not persist me" })).toThrow(
			MemoryValidationError,
		);
		expect(() =>
			validateMemoryReconstructionTraceV1({
				...trace(),
				budgetUsage: { ...trace().budgetUsage, memorySearchCalls: 4 },
			}),
		).toThrow("budget");
	});
});
