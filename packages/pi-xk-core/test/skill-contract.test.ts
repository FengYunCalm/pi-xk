import { describe, expect, it } from "vitest";
import {
	type SkillCandidateV1,
	type SkillReviewDecisionV1,
	type SkillRevisionV1,
	type SkillUseEvidenceV1,
	SkillValidationError,
	validateSkillCandidateV1,
	validateSkillReviewDecisionV1,
	validateSkillRevisionV1,
	validateSkillUseEvidenceV1,
} from "../src/index.ts";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const provenance = {
	producer: "model" as const,
	model: "faux/model",
	promptVersion: "pi-xk.skill-review-v1",
	recordedAt: "2026-08-03T00:00:00.000Z",
};

function evidence(): SkillUseEvidenceV1 {
	return {
		schema: "pi-xk.skill-use-evidence.v1",
		useId: "skill_use_1",
		skillId: "skill_memory-review",
		revision: 1,
		projectId: "project_pi_xk",
		runId: "run_1",
		outcome: "success",
		evidenceRefs: [],
		divergenceObserved: null,
		recordedAt: "2026-08-03T00:00:00.000Z",
	};
}

function candidate(): SkillCandidateV1 {
	return {
		schema: "pi-xk.skill-candidate.v1",
		candidateId: "skill_candidate_1",
		skillId: "skill_memory-review",
		targetScope: "project",
		expectedRevision: null,
		name: "memory-review",
		description: "Review retrieved project Memory before applying it to current work.",
		applicability: "Use after reading a Pi-XK D2 Memory.",
		divergenceConditions: ["Do not use for unrelated one-off questions."],
		bundleArtifactId: digest("a"),
		evidenceRefs: [evidence()],
		sourceDigest: digest("b"),
		provenance,
	};
}

function revision(): SkillRevisionV1 {
	return {
		schema: "pi-xk.skill-revision.v1",
		skillId: "skill_memory-review",
		revision: 1,
		scope: "project",
		lifecycle: "active",
		name: "memory-review",
		description: "Review retrieved project Memory before applying it to current work.",
		applicability: "Use after reading a Pi-XK D2 Memory.",
		divergenceConditions: ["Do not use for unrelated one-off questions."],
		files: [
			{ path: "SKILL.md", digest: digest("c"), executable: false },
			{ path: "scripts/check.mjs", digest: digest("d"), executable: true },
		],
		evidenceRefs: [evidence()],
		supersedesRevisions: [],
		sourceDigest: digest("e"),
		provenance,
	};
}

describe("Skill contracts", () => {
	it("strictly validates candidates, revisions, and use evidence", () => {
		expect(validateSkillUseEvidenceV1(evidence())).toEqual(evidence());
		expect(validateSkillCandidateV1(candidate())).toEqual(candidate());
		expect(validateSkillRevisionV1(revision())).toEqual(revision());
	});

	it("rejects invalid names, unsafe paths, duplicate files, and oversized descriptions", () => {
		expect(() => validateSkillCandidateV1({ ...candidate(), name: "Memory Review" })).toThrow(SkillValidationError);
		expect(() =>
			validateSkillRevisionV1({
				...revision(),
				files: [{ path: "../SKILL.md", digest: digest("f"), executable: false }],
			}),
		).toThrow("relative");
		expect(() =>
			validateSkillRevisionV1({ ...revision(), files: [revision().files[0]!, revision().files[0]!] }),
		).toThrow("unique");
		expect(() => validateSkillCandidateV1({ ...candidate(), description: "x".repeat(1_025) })).toThrow("description");
	});

	it("requires an SKILL.md entry and matching revision lineage", () => {
		expect(() => validateSkillRevisionV1({ ...revision(), files: revision().files.slice(1) })).toThrow("SKILL.md");
		expect(() => validateSkillCandidateV1({ ...candidate(), expectedRevision: 0 })).toThrow("revision");
	});

	it("strictly validates high-level Skill reviews without Host-owned artifact identifiers", () => {
		const decision: SkillReviewDecisionV1 = {
			schema: "pi-xk.skill-review-decision.v1",
			decisionId: "skill_review_1",
			runId: "run_1",
			action: "revise",
			sourceSkills: [{ skillId: "skill_memory-review", expectedRevision: 1 }],
			uses: [
				{
					skillId: "skill_memory-review",
					expectedRevision: 1,
					outcome: "success",
					divergenceObserved: null,
				},
			],
			replacement: {
				targetScope: "project",
				name: "memory-review",
				description: "Review retrieved project Memory before applying it to current work.",
				applicability: "Use after reading a Pi-XK D2 Memory.",
				divergenceConditions: ["Do not use without retrieved Memory."],
				instructions: {
					steps: "Read the candidate and compare it with current evidence.",
					validation: "Require source-backed conclusions.",
					failureHandling: "Stop when evidence cannot be resolved.",
				},
				resources: [],
			},
			evidenceIds: ["evidence_agent_run_1"],
			reason: "Current use found a reusable validation step.",
			provenance,
		};
		expect(validateSkillReviewDecisionV1(decision)).toEqual(decision);
		expect(() => validateSkillReviewDecisionV1({ ...decision, artifactId: digest("f") })).toThrow("unknown");
		expect(() => validateSkillReviewDecisionV1({ ...decision, replacement: null })).toThrow("replacement");
	});
});
