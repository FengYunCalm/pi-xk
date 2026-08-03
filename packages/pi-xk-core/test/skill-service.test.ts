import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentRunEvidenceRefV2,
	ArtifactStore,
	captureGitFreshnessBasis,
	type EvidenceRefV2,
	type SkillCandidateV1,
	type SkillHead,
	type SkillReviewDecisionV1,
	SkillService,
	SkillStore,
	stableJsonStringify,
} from "../src/index.ts";

const roots: string[] = [];
const now = "2026-08-03T00:00:00.000Z";
const execFile = promisify(execFileCallback);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function mutation(head: SkillHead, suffix: string) {
	return {
		eventId: `evt_${suffix}`,
		idempotencyKey: `skill:${suffix}`,
		expectedHead: head,
		actor: "model" as const,
		timestamp: now,
	};
}

async function runEvidence(root: string): Promise<AgentRunEvidenceRefV2> {
	const sessionId = "session_skill_service";
	const sessionFile = join(root, "skill-service-session.jsonl");
	const range = [
		{
			type: "message",
			id: "entry_request",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: [{ type: "text", text: "Create an evidence-backed Skill." }], timestamp: 0 },
		},
		{
			type: "message",
			id: "entry_assistant",
			parentId: "entry_request",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The Skill is ready." }],
				stopReason: "stop",
				timestamp: 1,
			},
		},
	];
	const rangeDigest = digest(stableJsonStringify(range));
	await writeFile(
		sessionFile,
		[
			JSON.stringify({ type: "session", id: sessionId, cwd: root, timestamp: now }),
			...range.map((entry) => JSON.stringify(entry)),
			"",
		].join("\n"),
		"utf8",
	);
	return {
		schema: "pi-xk.memory-evidence-ref.v2",
		evidenceId: "evidence_agent_run_skill_service",
		sourceType: "agent_run",
		sourceId: `${sessionId}:entry_request`,
		artifactId: null,
		sourceDigest: rangeDigest,
		recordedAt: now,
		locator: {
			projectId: "project_test",
			sessionId,
			sessionFile,
			chainId: null,
			branchId: null,
			segmentId: null,
			requestEntryId: "entry_request",
			terminalAssistantEntryId: "entry_assistant",
			toolResultEntryIds: [],
			rangeDigest,
		},
	};
}

async function createCandidate(root: string, store: SkillStore): Promise<SkillCandidateV1> {
	const commandId = "command_skill_service";
	const explicit = await new ArtifactStore(root).put({
		contentType: "text/plain",
		text: "Validated reusable release workflow.",
		producer: "pi-xk.memory-explicit.v1",
		sensitivity: "internal",
		sourceIds: [commandId],
		createdAt: now,
	});
	const bundle = await store.createBundle(
		{
			candidateId: "candidate_release-audit",
			skillId: "skill_release-audit",
			name: "release-audit",
			description: "Audit isolated release artifacts.",
			applicability: "Use for release smoke checks.",
			divergenceConditions: ["No release artifact exists."],
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.skill-review-v1",
				recordedAt: now,
			},
		},
		{
			instructions: {
				steps: "Run supported package and binary checks.",
				validation: "Require deterministic command evidence.",
				failureHandling: "Stop on a reproducible blocker.",
			},
			resources: [],
		},
	);
	return {
		schema: "pi-xk.skill-candidate.v1",
		candidateId: "candidate_release-audit",
		skillId: "skill_release-audit",
		targetScope: "project",
		expectedRevision: null,
		name: "release-audit",
		description: "Audit isolated release artifacts.",
		applicability: "Use for release smoke checks.",
		divergenceConditions: ["No release artifact exists."],
		bundleArtifactId: bundle.bundleArtifactId,
		evidenceRefs: [
			{
				schema: "pi-xk.skill-source-evidence.v1",
				evidenceId: "skill_evidence_release",
				projectId: "project_test",
				runId: "run_release",
				outcome: "success",
				evidenceRefs: [
					{
						schema: "pi-xk.memory-evidence-ref.v1",
						evidenceId: "evidence_release",
						sourceType: "explicit",
						sourceId: commandId,
						artifactId: explicit.artifactId,
						sourceDigest: explicit.artifactId,
						recordedAt: now,
						locator: { commandId },
					},
				],
				freshnessBasis: null,
				recordedAt: now,
			},
		],
		sourceDigest: digest("release-candidate"),
		provenance: { producer: "model", model: "faux/model", promptVersion: "pi-xk.skill-review-v1", recordedAt: now },
	};
}

describe("SkillService", () => {
	it("rebuilds a missing index from facts and returns D1 metadata plus controlled D2 bundle reads", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-service-"));
		roots.push(root);
		const store = new SkillStore(root, { projectId: "project_test", now: () => now });
		const service = new SkillService(root, {}, store);
		const candidate = await createCandidate(root, store);
		const recorded = await store.recordCandidate(candidate, mutation({ sequence: 0, hash: null }, "candidate"));
		await store.applyCandidate(candidate.candidateId, mutation(recorded.head, "apply"));

		const result = await service.search({ query: "release checks", includeCandidates: true });
		expect(result.skills.map((skill) => skill.name)).toEqual(["release-audit"]);
		expect(result.skills[0]).not.toHaveProperty("instructions");
		const read = await service.readSkill(candidate.skillId);
		expect(read.files.find((file) => file.path === "SKILL.md")?.content).toContain("## Steps");
		await service.close();

		await rm(join(root, ".pi-xk", "skills", "index.sqlite"), { force: true });
		const restarted = new SkillService(root, {}, new SkillStore(root, { projectId: "project_test", now: () => now }));
		expect((await restarted.search({ query: "release" })).skills).toHaveLength(1);
		expect((await restarted.status()).indexState).toBe("current");
		await restarted.close();
	});

	it("keeps existing Skill facts readable when automatic evolution is disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-service-"));
		roots.push(root);
		const service = new SkillService(root, { projectId: "project_test", now: () => now });
		await service.setConfig(false);
		expect(await service.getConfig()).toEqual({ enabled: false });
		expect(await service.search({ query: "anything" })).toEqual({ skills: [], candidates: [], hasMore: false });
		await service.close();
	});

	it("preserves expanded review evidence in the published Skill revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-service-"));
		roots.push(root);
		const service = new SkillService(root, { projectId: "project_test", now: () => now });
		const explicitArtifact = await new ArtifactStore(root).put({
			contentType: "text/plain",
			text: "The current run verified the reusable workflow against explicit evidence.",
			producer: "pi-xk.memory-explicit.v1",
			sensitivity: "internal",
			sourceIds: ["command_skill_review_evidence"],
			createdAt: now,
		});
		const expandedEvidence: EvidenceRefV2 = {
			schema: "pi-xk.memory-evidence-ref.v1",
			evidenceId: "evidence_skill_review_explicit",
			sourceType: "explicit",
			sourceId: "command_skill_review_evidence",
			artifactId: explicitArtifact.artifactId,
			sourceDigest: explicitArtifact.artifactId,
			recordedAt: now,
			locator: { commandId: "command_skill_review_evidence" },
		};
		const decision: SkillReviewDecisionV1 = {
			schema: "pi-xk.skill-review-decision.v1",
			decisionId: "skill_review_with_expanded_evidence",
			runId: "run_skill_review_evidence",
			action: "create",
			sourceSkills: [],
			uses: [],
			replacement: {
				targetScope: "project",
				name: "evidence-backed-workflow",
				description: "Apply a reusable workflow only with verified current-run evidence.",
				applicability: "Use when a project workflow requires explicit supporting evidence.",
				divergenceConditions: ["The supporting evidence cannot be resolved."],
				instructions: {
					steps: "Read and apply the evidence-backed workflow.",
					validation: "Resolve every referenced evidence item.",
					failureHandling: "Stop when evidence validation fails.",
				},
				resources: [],
			},
			evidenceIds: [expandedEvidence.evidenceId],
			reason: "The current run established a reusable evidence requirement.",
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.skill-review-v1",
				recordedAt: now,
			},
		};

		const agentRunEvidence = await runEvidence(root);
		const published = await service.publishReview(decision, agentRunEvidence, [expandedEvidence]);
		if (!published.skillId) throw new Error("Skill review did not publish a Skill");
		const revision = (await service.readSkill(published.skillId)).revision;
		const sourceEvidence = revision.evidenceRefs.find(
			(evidence) => evidence.schema === "pi-xk.skill-source-evidence.v1",
		);
		expect(sourceEvidence?.evidenceRefs.map((evidence) => evidence.evidenceId)).toEqual([
			agentRunEvidence.evidenceId,
			expandedEvidence.evidenceId,
		]);
		await service.close();
	});

	it("keeps an open index current across Skill publication and use evidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-service-"));
		roots.push(root);
		const service = new SkillService(root, { projectId: "project_test", now: () => now });
		expect(await service.search({ query: "empty index" })).toEqual({
			skills: [],
			candidates: [],
			hasMore: false,
		});
		const decision: SkillReviewDecisionV1 = {
			schema: "pi-xk.skill-review-decision.v1",
			decisionId: "skill_review_incremental_index",
			runId: "run_skill_incremental_index",
			action: "create",
			sourceSkills: [],
			uses: [],
			replacement: {
				targetScope: "project",
				name: "incremental-index-workflow",
				description: "Keep the Skill index current without a full rebuild.",
				applicability: "Use when publishing or reviewing Skill evidence.",
				divergenceConditions: ["The fact head is not contiguous."],
				instructions: {
					steps: "Publish only the affected Skill index records.",
					validation: "Verify the index head matches the Skill fact head.",
					failureHandling: "Fall back to an explicit projection rebuild.",
				},
				resources: [],
			},
			evidenceIds: [],
			reason: "The current run established a reusable incremental publication path.",
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.skill-review-v1",
				recordedAt: now,
			},
		};
		const run = await runEvidence(root);
		const published = await service.publishReview(decision, run);
		if (!published.skillId || !published.revision) throw new Error("Skill review was not published");
		expect(await service.status()).toMatchObject({
			indexState: "current",
			index: { skillCount: 1, candidateCount: 0, head: published.head },
		});

		let head = published.head;
		for (const suffix of ["first", "second"]) {
			const use = {
				schema: "pi-xk.skill-use-evidence.v1" as const,
				useId: `skill_use_incremental_${suffix}`,
				skillId: published.skillId,
				revision: published.revision,
				projectId: await service.getEvidenceProjectId(),
				runId: `run_skill_incremental_${suffix}`,
				outcome: "failure" as const,
				evidenceRefs: [run],
				divergenceObserved: "The reusable procedure diverged from the current project state.",
				recordedAt: now,
			};
			head = await service.recordUse(use, mutation(head, `use_${suffix}`));
		}
		const refreshed = await service.refreshDerivedState([published.skillId]);
		expect(refreshed.changedSkills).toEqual([
			{ skillId: published.skillId, revision: published.revision, projected: false },
		]);
		expect(await service.status()).toMatchObject({
			indexState: "current",
			facts: { needsReview: 1 },
			index: { needsReviewCount: 1, head },
		});
		await service.close();
	});

	it("suppresses a project Skill after its Git scope becomes stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-service-"));
		roots.push(root);
		await writeFile(join(root, "workflow.ts"), "export const version = 1;\n", "utf8");
		await execFile("git", ["init", "--quiet"], { cwd: root });
		await execFile("git", ["config", "user.email", "pi-xk@example.invalid"], { cwd: root });
		await execFile("git", ["config", "user.name", "Pi-XK Test"], { cwd: root });
		await execFile("git", ["add", "workflow.ts"], { cwd: root });
		await execFile("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
		const basis = await captureGitFreshnessBasis(root, ["workflow.ts"]);
		const gitEvidence: EvidenceRefV2 = {
			schema: "pi-xk.memory-evidence-ref.v1",
			evidenceId: "evidence_skill_workflow_git",
			sourceType: "git",
			sourceId: basis.baselineCommit,
			artifactId: null,
			sourceDigest: digest(stableJsonStringify(basis)),
			recordedAt: now,
			locator: {
				repositoryId: basis.repositoryId,
				baselineCommit: basis.baselineCommit,
				scopePaths: basis.scopePaths,
			},
		};
		const decision: SkillReviewDecisionV1 = {
			schema: "pi-xk.skill-review-decision.v1",
			decisionId: "skill_review_git_freshness",
			runId: "run_skill_git_freshness",
			action: "create",
			sourceSkills: [],
			uses: [],
			replacement: {
				targetScope: "project",
				name: "workflow-maintenance",
				description: "Maintain the current project workflow implementation.",
				applicability: "Use while workflow.ts matches its validated baseline.",
				divergenceConditions: ["workflow.ts changed after validation."],
				instructions: {
					steps: "Inspect workflow.ts and apply its validated maintenance procedure.",
					validation: "Verify workflow.ts still matches the captured content digest.",
					failureHandling: "Stop and revise this Skill after workflow.ts changes.",
				},
				resources: [],
			},
			evidenceIds: [gitEvidence.evidenceId],
			reason: "The run validated a reusable workflow for the current source path.",
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.skill-review-v1",
				recordedAt: now,
			},
		};
		const service = new SkillService(root, { projectId: "project_test", now: () => now });
		const published = await service.publishReview(decision, await runEvidence(root), [gitEvidence]);
		expect(published.status).toBe("applied");
		expect((await service.refreshDerivedState()).changed).toBe(false);
		expect((await service.status()).facts.stale).toBe(0);

		await writeFile(join(root, "workflow.ts"), "export const version = 2;\n", "utf8");
		expect((await service.refreshDerivedState()).changed).toBe(true);
		expect((await service.status()).facts.stale).toBe(1);
		await expect(stat(join(root, ".pi", "skills", "workflow-maintenance"))).rejects.toMatchObject({ code: "ENOENT" });
		await service.close();
	});
});
