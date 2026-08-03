import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactStore,
	SKILL_SOURCE_EVIDENCE_SCHEMA,
	type SkillCandidateV1,
	SkillCorruptionError,
	type SkillHead,
	SkillProjectionCollisionError,
	type SkillSourceEvidenceV1,
	SkillStore,
	stableJsonStringify,
} from "../src/index.ts";

const roots: string[] = [];
const now = "2026-08-03T00:00:00.000Z";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-store-"));
	roots.push(root);
	return root;
}

async function explicitEvidence(root: string, commandId: string): Promise<SkillSourceEvidenceV1> {
	const artifact = await new ArtifactStore(root).put({
		contentType: "text/plain",
		text: `Validated workflow from ${commandId}`,
		producer: "pi-xk.memory-explicit.v1",
		sensitivity: "internal",
		sourceIds: [commandId],
		createdAt: now,
	});
	return {
		schema: SKILL_SOURCE_EVIDENCE_SCHEMA,
		evidenceId: `skill_evidence_${commandId}`,
		projectId: "project_test",
		runId: `run_${commandId}`,
		outcome: "success",
		evidenceRefs: [
			{
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: `evidence_${commandId}`,
				sourceType: "explicit",
				sourceId: commandId,
				artifactId: artifact.artifactId,
				sourceDigest: artifact.artifactId,
				recordedAt: now,
				locator: { commandId },
			},
		],
		freshnessBasis: null,
		recordedAt: now,
	};
}

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function mutation(head: SkillHead, suffix: string) {
	return {
		eventId: `evt_${suffix}`,
		idempotencyKey: `skill:${suffix}`,
		expectedHead: head,
		actor: "user" as const,
		timestamp: now,
	};
}

async function candidate(
	root: string,
	store: SkillStore,
	suffix = "one",
	overrides: Partial<
		Pick<SkillCandidateV1, "skillId" | "name" | "expectedRevision" | "targetScope" | "evidenceRefs">
	> = {},
): Promise<SkillCandidateV1> {
	const evidence = await explicitEvidence(root, `command_${suffix}`);
	const skillId = overrides.skillId ?? "skill_release-audit";
	const name = overrides.name ?? "release-audit";
	const bundle = await store.createBundle(
		{
			candidateId: `candidate_${suffix}`,
			skillId,
			name,
			description: "Audit a local release with explicit evidence and deterministic checks.",
			applicability: "Use when validating a local Pi release candidate.",
			divergenceConditions: ["Do not use when no release artifact exists."],
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.skill-review-v1",
				recordedAt: now,
			},
		},
		{
			instructions: {
				steps: "Inspect the artifact and run its supported smoke checks.",
				validation: "Require every declared smoke check to pass.",
				failureHandling: "Stop and report the first reproducible failure.",
			},
			resources: [{ path: "references/checks.md", content: "# Checks\n\nRun help and version.", executable: false }],
		},
	);
	return {
		schema: "pi-xk.skill-candidate.v1",
		candidateId: `candidate_${suffix}`,
		skillId,
		targetScope: overrides.targetScope ?? "project",
		expectedRevision: overrides.expectedRevision ?? null,
		name,
		description: "Audit a local release with explicit evidence and deterministic checks.",
		applicability: "Use when validating a local Pi release candidate.",
		divergenceConditions: ["Do not use when no release artifact exists."],
		bundleArtifactId: bundle.bundleArtifactId,
		evidenceRefs: overrides.evidenceRefs ?? [evidence],
		sourceDigest: digest(`candidate:${suffix}`),
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.skill-review-v1",
			recordedAt: now,
		},
	};
}

describe("SkillStore", () => {
	it("creates a canonical bundle before recording and applying its candidate", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		const draft = await candidate(root, store);
		const recorded = await store.recordCandidate(draft, mutation({ sequence: 0, hash: null }, "candidate"));
		const applied = await store.applyCandidate("candidate_one", mutation(recorded.head, "apply"));

		expect(applied.revision.revision).toBe(1);
		expect(applied.projectionPublished).toBe(true);
		expect(await readFile(join(root, ".pi", "skills", "release-audit", "SKILL.md"), "utf8")).toContain(
			"## Failure Handling",
		);
		expect((await store.timeline("skill_release-audit")).map((entry) => entry.revision.revision)).toEqual([1]);
	});

	it("rejects a hash-valid event whose payload contains an unknown field", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		const draft = await candidate(root, store);
		await store.recordCandidate(draft, mutation({ sequence: 0, hash: null }, "candidate"));
		const eventsPath = join(root, ".pi-xk", "skills", "events.jsonl");
		const event = JSON.parse((await readFile(eventsPath, "utf8")).trim()) as Record<string, unknown>;
		const payload = event.payload as Record<string, unknown>;
		payload.unexpected = true;
		delete event.hash;
		event.hash = digest(stableJsonStringify(event));
		await writeFile(eventsPath, `${stableJsonStringify(event)}\n`, "utf8");

		await expect(store.replay()).rejects.toThrow(SkillCorruptionError);
	});

	it("archives and rolls back by publishing new immutable revisions", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		const draft = await candidate(root, store);
		const recorded = await store.recordCandidate(draft, mutation({ sequence: 0, hash: null }, "candidate"));
		const applied = await store.applyCandidate("candidate_one", mutation(recorded.head, "apply"));
		const archived = await store.archive(
			"skill_release-audit",
			"No longer active",
			mutation(applied.head, "archive"),
		);
		expect(archived.revision.lifecycle).toBe("archived");
		await expect(readFile(join(root, ".pi", "skills", "release-audit", "SKILL.md"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const rolledBack = await store.rollback(
			"skill_release-audit",
			1,
			"Restore the validated first revision",
			mutation(archived.head, "rollback"),
		);
		expect(rolledBack.revision.revision).toBe(3);
		expect(rolledBack.revision.lifecycle).toBe("active");
		expect((await store.timeline("skill_release-audit")).map((entry) => entry.revision.lifecycle)).toEqual([
			"active",
			"archived",
			"active",
		]);
	});

	it("never overwrites a non-managed Skill directory", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		await mkdir(join(root, ".pi", "skills", "release-audit"), { recursive: true });
		await writeFile(join(root, ".pi", "skills", "release-audit", "SKILL.md"), "user owned", "utf8");
		const draft = await candidate(root, store);
		const recorded = await store.recordCandidate(draft, mutation({ sequence: 0, hash: null }, "candidate"));

		await expect(store.applyCandidate("candidate_one", mutation(recorded.head, "apply"))).rejects.toThrow(
			SkillProjectionCollisionError,
		);
		expect(await readFile(join(root, ".pi", "skills", "release-audit", "SKILL.md"), "utf8")).toBe("user owned");
	});

	it("atomically supersedes multiple active Skills while retaining every revision", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		let head: SkillHead = { sequence: 0, hash: null };
		for (const [suffix, skillId, name] of [
			["alpha", "skill_alpha", "alpha-workflow"],
			["beta", "skill_beta", "beta-workflow"],
		] as const) {
			const draft = await candidate(root, store, suffix, { skillId, name });
			const recorded = await store.recordCandidate(draft, mutation(head, `candidate_${suffix}`));
			const applied = await store.applyCandidate(draft.candidateId, mutation(recorded.head, `apply_${suffix}`));
			head = applied.head;
		}
		const merged = await candidate(root, store, "merged", {
			skillId: "skill_merged",
			name: "merged-workflow",
		});
		const recorded = await store.recordCandidate(merged, mutation(head, "candidate_merged"));
		const applied = await store.applyCandidate(merged.candidateId, mutation(recorded.head, "apply_merged"), [
			{ skillId: "skill_alpha", revision: 1 },
			{ skillId: "skill_beta", revision: 1 },
		]);

		expect((await store.readRevision("skill_alpha")).revision.lifecycle).toBe("superseded");
		expect((await store.readRevision("skill_beta")).revision.lifecycle).toBe("superseded");
		expect((await store.readRevision("skill_merged")).revision.lifecycle).toBe("active");
		expect((await store.timeline("skill_alpha")).map((entry) => entry.revision.lifecycle)).toEqual([
			"active",
			"superseded",
		]);
		expect(applied.head.sequence).toBe(6);
	});

	it("purges only an archived unreferenced Skill and keeps a tombstone", async () => {
		const root = await projectRoot();
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		const draft = await candidate(root, store);
		const recorded = await store.recordCandidate(draft, mutation({ sequence: 0, hash: null }, "candidate"));
		const applied = await store.applyCandidate(draft.candidateId, mutation(recorded.head, "apply"));
		await expect(store.purge(draft.skillId, mutation(applied.head, "purge_active"))).rejects.toThrow("archived");
		const archived = await store.archive(draft.skillId, "Retire", mutation(applied.head, "archive"));
		const purged = await store.purge(draft.skillId, mutation(archived.head, "purge"));

		expect(purged.removedArtifactIds.length).toBeGreaterThan(0);
		expect((await store.loadReadModel()).purgedSkillIds).toContain(draft.skillId);
		await expect(store.readRevision(draft.skillId)).rejects.toThrow("not found");
		const replacement = await candidate(root, store, "replacement");
		await expect(store.recordCandidate(replacement, mutation(purged.head, "recreate"))).rejects.toThrow("purged");
	});

	it("promotes a global candidate only after three successes across two projects", async () => {
		const root = await projectRoot();
		const agentDir = join(root, "agent");
		const store = new SkillStore(root, {
			scope: "global",
			agentDir,
			projectId: "project_origin",
			now: () => now,
		});
		const uses = [`repo_${"a".repeat(32)}`, `repo_${"a".repeat(32)}`, `repo_${"b".repeat(32)}`].map(
			(project, index) => ({
				schema: "pi-xk.skill-use-evidence.v1" as const,
				useId: `use_${index}`,
				skillId: "skill_release-audit",
				revision: 1,
				projectId: project,
				runId: `run_${index}`,
				outcome: "success" as const,
				evidenceRefs: [],
				divergenceObserved: null,
				recordedAt: now,
			}),
		);
		const insufficient = await candidate(root, store, "global_insufficient", {
			targetScope: "global",
			evidenceRefs: uses.slice(0, 2),
		});
		let recorded = await store.recordCandidate(
			insufficient,
			mutation({ sequence: 0, hash: null }, "global_insufficient"),
		);
		await expect(
			store.promoteCandidate(insufficient.candidateId, mutation(recorded.head, "promote_insufficient")),
		).rejects.toThrow("three successful uses");
		await store.rejectCandidate(
			insufficient.candidateId,
			"Insufficient evidence",
			mutation(recorded.head, "reject_insufficient"),
		);
		const eligible = await candidate(root, store, "global_eligible", {
			targetScope: "global",
			evidenceRefs: uses,
		});
		recorded = await store.recordCandidate(eligible, mutation((await store.loadReadModel()).head, "global_eligible"));
		const promoted = await store.promoteCandidate(eligible.candidateId, mutation(recorded.head, "promote_eligible"));

		expect(promoted.revision.scope).toBe("global");
		expect((await store.loadReadModel()).promotedCandidateIds).toContain(eligible.candidateId);
		expect(await readFile(join(agentDir, "skills", "release-audit", "SKILL.md"), "utf8")).toContain("## Validation");
	});
});
