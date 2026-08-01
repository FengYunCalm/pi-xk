import { describe, expect, it } from "vitest";
import {
	type CueNodeV1,
	type EvidenceRefV1,
	type MemoryChangeProposalV1,
	type MemoryEdgeV1,
	type MemoryRevisionV1,
	MemoryValidationError,
	validateCueNodeV1,
	validateEvidenceRefV1,
	validateMemoryChangeProposalV1,
	validateMemoryEdgeV1,
	validateMemoryRevisionV1,
} from "../src/index.ts";

const provenance = {
	producer: "model" as const,
	model: "faux/model",
	promptVersion: "pi-xk.memory-capture.v1",
	recordedAt: "2026-08-01T00:00:00.000Z",
};

function evidence(): EvidenceRefV1 {
	return {
		schema: "pi-xk.memory-evidence-ref.v1",
		evidenceId: "evidence_goal_checkpoint",
		sourceType: "goal_checkpoint",
		sourceId: "goal_example:checkpoint:evt_1",
		artifactId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		sourceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		recordedAt: "2026-08-01T00:00:00.000Z",
		locator: {
			goalId: "goal_example",
			checkpointEventId: "evt_1",
		},
	};
}

function revision(): MemoryRevisionV1 {
	return {
		schema: "pi-xk.memory-revision.v1",
		memoryId: "memory_goal_evidence",
		revision: 1,
		kind: "decision",
		title: "Canonical artifact summaries",
		statement: "Artifact Store read-back content is canonical.",
		applicability: "Session Chain rollover summaries.",
		trust: "model_inferred",
		lifecycle: "active",
		effectiveFrom: "2026-08-01T00:00:00.000Z",
		effectiveTo: null,
		cueIds: ["cue_session_chain"],
		evidenceRefs: [evidence()],
		freshnessBasis: null,
		sourceDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		supersedesRevision: null,
		provenance,
	};
}

function cue(): CueNodeV1 {
	return {
		schema: "pi-xk.memory-cue.v1",
		cueId: "cue_session_chain",
		revision: 1,
		kind: "component",
		key: "session-chain",
		label: "Session Chain",
		aliases: ["chain"],
		scope: {
			projectId: "project_pi_xk",
			goalId: null,
			chainId: null,
			branchId: null,
			paths: ["packages/pi-xk-core"],
		},
		sourceDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		provenance,
	};
}

function edge(): MemoryEdgeV1 {
	return {
		schema: "pi-xk.memory-edge.v1",
		edgeId: "edge_memory_to_cue",
		from: { kind: "memory", id: "memory_goal_evidence" },
		to: { kind: "cue", id: "cue_session_chain" },
		relation: "applies_to",
		effectiveFrom: "2026-08-01T00:00:00.000Z",
		effectiveTo: null,
		evidenceRefs: [evidence()],
		sourceDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		provenance,
	};
}

describe("Memory contracts", () => {
	it("strictly validates revisions, cues, edges, and evidence", () => {
		expect(validateEvidenceRefV1(evidence())).toEqual(evidence());
		expect(validateMemoryRevisionV1(revision())).toEqual(revision());
		expect(validateCueNodeV1(cue())).toEqual(cue());
		expect(validateMemoryEdgeV1(edge())).toEqual(edge());
		expect(() => validateMemoryRevisionV1({ ...revision(), freshness: "current" })).toThrow(MemoryValidationError);
		expect(() => validateCueNodeV1({ ...cue(), key: "Run this command\nnow" })).toThrow("cue key");
		expect(() => validateMemoryEdgeV1({ ...edge(), relation: "owns" })).toThrow("relation");
	});

	it("validates path-scoped Git freshness without persisting a computed freshness state", () => {
		const withGit: MemoryRevisionV1 = {
			...revision(),
			freshnessBasis: {
				schema: "pi-xk.memory-git-freshness.v1",
				repositoryId: "repo_pi_xk",
				baselineCommit: "3e731f00eb83cfa0b5930ca0c4c4893ac779823a",
				scopePaths: ["packages/pi-xk-core/src/artifact-store.ts"],
				pathDigests: [
					{
						path: "packages/pi-xk-core/src/artifact-store.ts",
						digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
					},
				],
			},
		};
		expect(validateMemoryRevisionV1(withGit)).toEqual(withGit);
		expect(() =>
			validateMemoryRevisionV1({
				...withGit,
				freshnessBasis: { ...withGit.freshnessBasis, scopePaths: ["../outside"] },
			}),
		).toThrow("project-relative");
	});

	it("requires model proposals to remain inferred and CAS-bound", () => {
		const proposal: MemoryChangeProposalV1 = {
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: "proposal_capture_1",
			captureId: "capture_goal_1",
			sourceDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			expectedEventHead: {
				sequence: 2,
				hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
			expectedRevisions: [],
			reason: "Preserve the accepted design decision.",
			operations: [
				{ kind: "publish_cue", cue: cue() },
				{ kind: "publish_revision", revision: revision() },
				{ kind: "publish_edge", edge: edge() },
			],
			provenance,
		};
		expect(validateMemoryChangeProposalV1(proposal)).toEqual(proposal);
		expect(() =>
			validateMemoryChangeProposalV1({
				...proposal,
				operations: [{ kind: "publish_revision", revision: { ...revision(), trust: "verified" } }],
			}),
		).toThrow("cannot publish verified");
	});
});
