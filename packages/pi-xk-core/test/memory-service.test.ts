import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactStore,
	captureGitFreshnessBasis,
	type EvidenceRefV1,
	type GoalContractV3,
	GoalStore,
	type MemoryCaptureSourceV1,
	type MemoryChangeProposalV1,
	MemoryNotFoundError,
	MemoryService,
	MemoryStore,
	MemoryValidationError,
	SessionChainStore,
	TaskStore,
} from "../src/index.ts";

const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

async function createService(): Promise<{ projectRoot: string; service: MemoryService }> {
	const projectRoot = join(tmpdir(), `pi-xk-memory-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { projectRoot, service: new MemoryService(projectRoot) };
}

async function publishMemoryWithEvidence(
	projectRoot: string,
	service: MemoryService,
	memoryId: string,
	evidence: EvidenceRefV1,
): Promise<void> {
	const suffix = memoryId.replace(/^memory_/u, "");
	const source: MemoryCaptureSourceV1 = {
		schema: "pi-xk.memory-capture-source.v1",
		captureId: `capture_${suffix}`,
		trigger: "backfill",
		sourceIds: [evidence.sourceId],
		sourceDigest: `sha256:${"a".repeat(64)}`,
		promptVersion: "pi-xk.memory-capture-v1",
		createdAt: evidence.recordedAt,
	};
	const initialHead = (await service.getStore().replay()).head;
	const scheduled = await service.getStore().scheduleCapture(source, {
		eventId: `evt_memory_schedule_${suffix}`,
		idempotencyKey: `memory:schedule:${source.captureId}`,
		expectedHead: initialHead,
		timestamp: evidence.recordedAt,
	});
	const generating = await service.getStore().markGenerationStarted(source.captureId, 1, {
		eventId: `evt_memory_generation_${suffix}`,
		idempotencyKey: `memory:generation:${source.captureId}:1`,
		expectedHead: scheduled.head,
		timestamp: evidence.recordedAt,
	});
	const proposal: MemoryChangeProposalV1 = {
		schema: "pi-xk.memory-change-proposal.v1",
		proposalId: `proposal_${suffix}`,
		captureId: source.captureId,
		sourceDigest: source.sourceDigest,
		expectedEventHead: generating.head,
		expectedRevisions: [],
		reason: "Publish a provenance validation fixture.",
		operations: [
			{
				kind: "publish_revision",
				revision: {
					schema: "pi-xk.memory-revision.v1",
					memoryId,
					revision: 1,
					kind: "fact",
					title: `Evidence fixture ${suffix}`,
					statement: "This Memory is readable only while its complete evidence provenance remains valid.",
					applicability: "Pi-XK Memory D2 and D3 provenance validation.",
					trust: "model_inferred",
					lifecycle: "active",
					effectiveFrom: evidence.recordedAt,
					effectiveTo: null,
					cueIds: [],
					evidenceRefs: [evidence],
					freshnessBasis: null,
					sourceDigest: source.sourceDigest,
					supersedesRevision: null,
					provenance: {
						producer: "model",
						model: "faux/faux",
						promptVersion: "pi-xk.memory-capture-v1",
						recordedAt: evidence.recordedAt,
					},
				},
			},
		],
		provenance: {
			producer: "model",
			model: "faux/faux",
			promptVersion: "pi-xk.memory-capture-v1",
			recordedAt: evidence.recordedAt,
		},
	};
	const resultArtifact = await new ArtifactStore(projectRoot).put({
		contentType: "application/json",
		value: { schema: "pi-xk.memory-provenance-test-result.v1", proposal },
		producer: "pi-xk.memory-capture-v1",
		sensitivity: "internal",
		sourceIds: [source.captureId],
		createdAt: evidence.recordedAt,
	});
	const recorded = await service.getStore().recordProposal(proposal, resultArtifact.artifactId, {
		eventId: `evt_memory_proposal_${suffix}`,
		idempotencyKey: `memory:proposal:${proposal.proposalId}`,
		expectedHead: generating.head,
		timestamp: evidence.recordedAt,
	});
	await service.getStore().applyProposal(recorded.proposalArtifactId, {
		eventId: `evt_memory_apply_${suffix}`,
		idempotencyKey: `memory:apply:${proposal.proposalId}`,
		expectedHead: recorded.write.head,
		timestamp: evidence.recordedAt,
	});
}

async function createGoalCompletionEvidence(
	projectRoot: string,
	suffix: string,
	sourceState: string,
): Promise<{ evidence: EvidenceRefV1; checkpointArtifactId: string }> {
	const recordedAt = "2026-08-01T00:00:00.000Z";
	const goalId = `goal_completion_evidence_${suffix}`;
	const sessionId = `session_completion_evidence_${suffix}`;
	const leafId = `leaf_completion_evidence_${suffix}`;
	const checkpointState = "# Canonical event-time Goal State\n";
	const contract: GoalContractV3 = {
		schema: "pi-xk.goal.contract.v3",
		goalId,
		title: "Goal completion Memory evidence",
		intentAnchor: "Preserve the final event-time Goal State as canonical Memory evidence.",
		objective: "Validate Goal completion evidence against its final checkpoint.",
		constraints: [],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "The final checkpoint remains canonical completion evidence.",
				required: true,
				command: "memory-service focused provenance test",
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: sessionId,
		createdAt: recordedAt,
		schemaVersion: 3,
		revision: 1,
		nonGoals: [],
		doneCondition: "The completion evidence remains bound to its final checkpoint.",
		pauseCondition: "No valid checkpoint evidence is available.",
		finalReport: "Report the evidence integrity result.",
		executionAuthorization: "Run local Memory evidence validation.",
	};
	const goals = new GoalStore(projectRoot);
	const created = await goals.createGoal(contract, {
		eventId: `evt_goal_completion_created_${suffix}`,
		idempotencyKey: `goal:completion-evidence:create:${suffix}`,
		actor: "user",
		timestamp: recordedAt,
	});
	const checkpointArtifact = await goals.putArtifact({
		contentType: "application/json",
		value: {
			schema: "pi-xk.checkpoint-evidence.v2",
			goalId,
			sessionId,
			leafId,
			turnIndex: 1,
			toolResultCount: 0,
			reason: "turn_end",
			contractRevision: 1,
			goalState: checkpointState,
			createdAt: "2026-08-01T00:01:00.000Z",
		},
		producer: "pi-xk.checkpoint-evidence.v2",
		sensitivity: "redacted",
		sourceIds: [goalId, sessionId, leafId],
		createdAt: "2026-08-01T00:01:00.000Z",
	});
	const checkpoint = await goals.appendCheckpoint(
		goalId,
		{
			schema: "pi-xk.goal-checkpoint.v2",
			sessionId,
			leafId,
			turnIndex: 1,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-08-01T00:01:00.000Z",
			evidence: {
				schema: "pi-xk.goal-checkpoint-evidence.v1",
				sourceEntryIds: [leafId],
				artifacts: [
					{
						schema: "pi-xk.artifact-ref.v1",
						artifactId: checkpointArtifact.artifactId,
						role: "checkpoint_evidence",
					},
				],
			},
		},
		{
			eventId: `evt_goal_completion_checkpoint_${suffix}`,
			idempotencyKey: `goal:completion-evidence:checkpoint:${suffix}`,
			expectedHead: created.head,
			actor: "runtime",
			timestamp: "2026-08-01T00:01:00.000Z",
		},
	);
	const activated = await goals.appendLifecycleEvent(
		goalId,
		{ eventType: "goal_activated", payload: { sessionId } },
		{
			eventId: `evt_goal_completion_activated_${suffix}`,
			idempotencyKey: `goal:completion-evidence:activate:${suffix}`,
			expectedHead: checkpoint.head,
			actor: "user",
			timestamp: "2026-08-01T00:02:00.000Z",
		},
	);
	const ended = await goals.appendLifecycleEvent(
		goalId,
		{
			eventType: "goal_ended",
			payload: {
				outcome: "accepted",
				reason: "Completion evidence fixture accepted.",
				verifiedAcceptanceIds: ["A-1"],
				finalEvidence: "Canonical checkpoint fixture.",
				finalSummary: "Goal completion evidence is available.",
			},
		},
		{
			eventId: `evt_goal_completion_ended_${suffix}`,
			idempotencyKey: `goal:completion-evidence:end:${suffix}`,
			expectedHead: activated.head,
			actor: "user",
			timestamp: "2026-08-01T00:03:00.000Z",
		},
	);
	const source = await new ArtifactStore(projectRoot).put({
		contentType: "application/json",
		value: {
			schema: "pi-xk.memory-goal-source.v1",
			goalId,
			contractRevision: 1,
			event: ended.event,
			state: sourceState,
		},
		producer: "pi-xk.memory-goal-source.v1",
		sensitivity: "internal",
		sourceIds: [goalId, ended.event.eventId],
		createdAt: ended.event.timestamp,
	});
	return {
		evidence: {
			schema: "pi-xk.memory-evidence-ref.v1",
			evidenceId: `evidence_goal_completion_${suffix}`,
			sourceType: "goal_completion",
			sourceId: ended.event.eventId,
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			recordedAt: ended.event.timestamp,
			locator: { goalId, eventId: ended.event.eventId },
		},
		checkpointArtifactId: checkpointArtifact.artifactId,
	};
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const directory = tempDirs.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("Memory Service", () => {
	it("reads the revision that was effective at asOf instead of the current revision", async () => {
		const { service } = await createService();
		const remembered = await service.remember("Historical lifecycle queries must return the effective revision.", {
			commandId: "command_memory_as_of_revision",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		const replay = await service.getStore().replay();
		await service
			.getStore()
			.changeMemoryLifecycle(
				remembered.revision.memoryId,
				1,
				"archived",
				"Archive after the historical query point.",
				{
					eventId: "evt_memory_as_of_archive",
					idempotencyKey: "memory:as-of:archive",
					expectedHead: replay.head,
					actor: "user",
					timestamp: "2026-08-02T00:00:00.000Z",
					confirmed: true,
				},
			);

		const historical = await service.read({
			memoryIds: [remembered.revision.memoryId],
			asOf: "2026-08-01T12:00:00.000Z",
		});
		expect(historical.memories[0]?.revision).toMatchObject({ revision: 1, lifecycle: "active" });
		const historicalSearch = await service.search({
			query: "Historical lifecycle queries",
			asOf: "2026-08-01T12:00:00.000Z",
			graphDepth: 0,
		});
		expect(historicalSearch.items).toEqual([
			expect.objectContaining({
				memoryId: remembered.revision.memoryId,
				revision: 1,
				state: expect.objectContaining({ lifecycle: "active" }),
			}),
		]);
		await service.close();
	});

	it("keeps historical search available after an unrelated Memory is purged", async () => {
		const { service } = await createService();
		const purgeTarget = await service.remember("This Memory will be permanently purged.", {
			commandId: "command_memory_as_of_purge_target",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		const retained = await service.remember("Historical retrieval remains available for retained Memory.", {
			commandId: "command_memory_as_of_retained",
			recordedAt: "2026-08-01T00:01:00.000Z",
		});
		await service.changeLifecycle(purgeTarget.revision.memoryId, "archived", "Archive before purge.");
		const evidenceId = purgeTarget.revision.evidenceRefs[0]?.evidenceId;
		if (!evidenceId) throw new Error("missing purge evidence fixture");
		await service.detachEvidence(
			purgeTarget.revision.memoryId,
			evidenceId,
			"Detach the exclusively owned evidence before purge.",
		);
		await service.purge(purgeTarget.revision.memoryId, "Explicit permanent removal.");

		await expect(service.timeline(purgeTarget.revision.memoryId)).rejects.toBeInstanceOf(MemoryNotFoundError);
		const historical = await service.search({
			query: "Historical retrieval remains available",
			asOf: "2026-08-01T00:02:00.000Z",
			graphDepth: 0,
		});
		expect(historical.items).toEqual([
			expect.objectContaining({ memoryId: retained.revision.memoryId, revision: 1 }),
		]);
		await service.close();
	});

	it("rejects invalid evidence ownership before publishing a Memory fact", async () => {
		const { projectRoot, service } = await createService();
		const artifact = await new ArtifactStore(projectRoot).put({
			contentType: "text/plain",
			text: "This artifact is not owned by the claimed Goal checkpoint.",
			producer: "pi-xk.test.invalid-evidence.v1",
			sensitivity: "internal",
			sourceIds: ["unrelated_source"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});

		await expect(
			publishMemoryWithEvidence(projectRoot, service, "memory_invalid_apply_evidence", {
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: "evidence_invalid_apply_evidence",
				sourceType: "goal_checkpoint",
				sourceId: "evt_missing_checkpoint",
				artifactId: artifact.artifactId,
				sourceDigest: artifact.artifactId,
				recordedAt: "2026-08-01T00:00:00.000Z",
				locator: { goalId: "goal_missing", checkpointEventId: "evt_missing_checkpoint" },
			}),
		).rejects.toThrow(/Goal not found|Goal event/i);
		expect((await service.getStore().replay()).memories.has("memory_invalid_apply_evidence")).toBe(false);
		await service.close();
	});

	it("binds Goal completion evidence to the final event-time checkpoint State", async () => {
		const { projectRoot, service } = await createService();
		const mismatched = await createGoalCompletionEvidence(
			projectRoot,
			"mismatched_state",
			"# Later mutable Goal State\n",
		);
		await expect(
			publishMemoryWithEvidence(
				projectRoot,
				service,
				"memory_goal_completion_mismatched_state",
				mismatched.evidence,
			),
		).rejects.toThrow(/checkpoint State snapshot/i);

		const canonical = await createGoalCompletionEvidence(
			projectRoot,
			"damaged_checkpoint",
			"# Canonical event-time Goal State\n",
		);
		await publishMemoryWithEvidence(
			projectRoot,
			service,
			"memory_goal_completion_damaged_checkpoint",
			canonical.evidence,
		);
		const digest = canonical.checkpointArtifactId.slice("sha256:".length);
		await writeFile(
			join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`),
			"{}\n",
		);
		await expect(service.read({ memoryIds: ["memory_goal_completion_damaged_checkpoint"] })).rejects.toThrow(
			/artifact|digest|integrity/i,
		);
		await expect(service.expandEvidence({ memoryId: "memory_goal_completion_damaged_checkpoint" })).rejects.toThrow(
			/artifact|digest|integrity/i,
		);
		await service.close();
	});

	it("provides D1-D3 retrieval and rebuilds a deleted SQLite projection", async () => {
		const { projectRoot, service } = await createService();
		const remembered = await service.remember("Prefer canonical Artifact Store read-back for summaries.", {
			commandId: "command_remember_1",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		expect(remembered.state).toEqual({ trust: "verified", freshness: "unknown", lifecycle: "active" });

		const search = await service.search({ query: "canonical Artifact Store", limit: 12 });
		expect(search.items).toHaveLength(1);
		expect(search.items[0]).toMatchObject({
			memoryId: remembered.revision.memoryId,
			title: "Prefer canonical Artifact Store read-back for summaries.",
			state: { trust: "verified", freshness: "unknown", lifecycle: "active" },
		});
		expect(search.items[0]).not.toHaveProperty("statement");

		const read = await service.read({ memoryIds: [remembered.revision.memoryId] });
		expect(read.memories[0]?.revision.statement).toBe("Prefer canonical Artifact Store read-back for summaries.");
		const expanded = await service.expandEvidence({ memoryId: remembered.revision.memoryId });
		expect(expanded.evidence[0]).toMatchObject({
			evidenceId: expect.stringMatching(/^evidence_/),
			historicalEvidence: true,
			content: "Prefer canonical Artifact Store read-back for summaries.",
		});
		await service.close();

		await rm(join(projectRoot, ".pi-xk", "memory", "index.sqlite"), { force: true });
		const restarted = new MemoryService(projectRoot);
		try {
			expect((await restarted.search({ query: "canonical Artifact Store" })).items).toHaveLength(1);
			expect((await restarted.status()).indexState).toBe("current");
		} finally {
			await restarted.close();
		}
	});

	it("rebuilds SQLite in bounded batches without requesting complete fact arrays", async () => {
		const { projectRoot, service } = await createService();
		await service.remember("Stream index rebuild artifacts in bounded batches.", {
			commandId: "command_stream_index_rebuild",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.close();
		await rm(join(projectRoot, ".pi-xk", "memory", "index.sqlite"), { force: true });

		class RejectFullFactReadsStore extends MemoryStore {
			override async readMemories(memoryIds?: readonly string[]) {
				if (!memoryIds) throw new Error("full Memory fact array requested");
				return await super.readMemories(memoryIds);
			}

			override async readCues(cueIds?: readonly string[]) {
				if (!cueIds) throw new Error("full Cue fact array requested");
				return await super.readCues(cueIds);
			}

			override async readEdges(edgeIds?: readonly string[]) {
				if (!edgeIds) throw new Error("full Edge fact array requested");
				return await super.readEdges(edgeIds);
			}
		}

		const restarted = new MemoryService(projectRoot, new RejectFullFactReadsStore(projectRoot));
		try {
			expect((await restarted.search({ query: "bounded batches" })).items).toHaveLength(1);
		} finally {
			await restarted.close();
		}
	});

	it("removes temporary SQLite files when a streamed rebuild fails", async () => {
		const { projectRoot, service } = await createService();
		await service.remember("Failed streamed rebuilds leave no temporary index files.", {
			commandId: "command_failed_stream_index_rebuild",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.close();
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		await rm(join(memoryDirectory, "index.sqlite"), { force: true });

		class FailingBatchStore extends MemoryStore {
			override async readMemoriesByReferences(): Promise<never> {
				throw new Error("simulated streamed artifact read failure");
			}
		}

		const restarted = new MemoryService(projectRoot, new FailingBatchStore(projectRoot));
		try {
			await expect(restarted.search({ query: "temporary index files" })).rejects.toThrow(
				"simulated streamed artifact read failure",
			);
		} finally {
			await restarted.close();
		}
		expect((await readdir(memoryDirectory)).filter((entry) => entry.startsWith(".index-"))).toEqual([]);
	});

	it("uses canonical Artifact Store read-back for explicit Memory identity and content", async () => {
		const { service } = await createService();
		const remembered = await service.remember("Remember token=secret-value-123456789 for the canonical fixture.", {
			commandId: "command_remember_canonical",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		const evidence = remembered.revision.evidenceRefs[0];
		if (!evidence?.artifactId) throw new Error("explicit Memory fixture has no evidence artifact");

		expect(remembered.revision.statement).toContain("token=[REDACTED]");
		expect(remembered.revision.statement).not.toContain("secret-value-123456789");
		expect(remembered.revision.sourceDigest).toBe(evidence.artifactId);
		expect(evidence.sourceDigest).toBe(evidence.artifactId);
		expect((await service.expandEvidence({ memoryId: remembered.revision.memoryId })).evidence[0]?.content).toBe(
			remembered.revision.statement,
		);
		await service.close();
	});

	it("stops capture when disabled while retaining read-only retrieval", async () => {
		const { service } = await createService();
		const remembered = await service.remember("Keep existing memory readable while capture is off.", {
			commandId: "command_remember_off",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.setConfig({ enabled: false });
		await expect(
			service.remember("This must not be captured.", {
				commandId: "command_remember_disabled",
				recordedAt: "2026-08-01T00:00:01.000Z",
			}),
		).rejects.toBeInstanceOf(MemoryValidationError);
		await expect(
			service.changeLifecycle(remembered.revision.memoryId, "archived", "must remain read-only"),
		).rejects.toThrow(/read-only/i);
		await expect(
			service.detachEvidence(
				remembered.revision.memoryId,
				remembered.revision.evidenceRefs[0]?.evidenceId ?? "missing",
				"must remain read-only",
			),
		).rejects.toThrow(/read-only/i);
		const beforeAccess = (await service.getStore().replay()).head;
		await expect(
			service.recordAccess(
				{
					runId: "run_memory_disabled",
					memoryIds: [remembered.revision.memoryId],
					evidenceIds: [],
				},
				{
					eventId: "evt_memory_access_disabled",
					idempotencyKey: "memory:access:disabled",
					expectedHead: beforeAccess,
					timestamp: "2026-08-01T00:00:02.000Z",
				},
			),
		).resolves.toBeNull();
		expect((await service.getStore().replay()).head).toEqual(beforeAccess);
		expect((await service.read({ memoryIds: [remembered.revision.memoryId] })).memories).toHaveLength(1);
		expect((await service.search({ query: "capture is off" })).items).toHaveLength(1);
		await service.close();
	});

	it("updates access heat and the SQLite event head without a full projection rebuild", async () => {
		const { service } = await createService();
		const remembered = await service.remember("Access heat should use an incremental index update.", {
			commandId: "command_access_incremental",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		expect((await service.status()).indexState).toBe("current");
		const replay = await service.getStore().replay();
		const write = await service.recordAccess(
			{
				runId: "run_memory_access_incremental",
				memoryIds: [remembered.revision.memoryId],
				evidenceIds: [],
			},
			{
				eventId: "evt_memory_access_incremental",
				idempotencyKey: "memory:access:incremental",
				expectedHead: replay.head,
				timestamp: "2026-08-01T00:01:00.000Z",
			},
		);
		if (!write) throw new Error("enabled Memory access was not recorded");
		const status = await service.status();
		expect(status.indexState).toBe("current");
		expect(status.index?.head).toEqual(write.head);
		await service.close();
	});

	it("reports missing derived projections without repairing them during quick doctor", async () => {
		const { projectRoot, service } = await createService();
		const remembered = await service.remember("Doctor projections remain derived state.", {
			commandId: "command_doctor_projection",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.repairProjections();
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		const checkpointPath = join(memoryDirectory, "memory-read-model.checkpoint.json");
		const markdownPath = join(memoryDirectory, "projections", "memories", `${remembered.revision.memoryId}.md`);
		await rm(checkpointPath);
		await rm(markdownPath);

		const quick = await service.doctor("quick");
		expect(quick.ok).toBe(false);
		expect(quick.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "read_model_checkpoint_missing", repairable: true })]),
		);
		const deep = await service.doctor("deep");
		expect(deep.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "markdown_missing", repairable: true })]),
		);
		await expect(stat(checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });

		await service.repairProjections();
		await expect(stat(checkpointPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
		await expect(stat(markdownPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
		await service.close();
	});

	it("reports retryable failures and indeterminate generation in doctor", async () => {
		const { service } = await createService();
		const store = service.getStore();
		const first = await store.scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId: "capture_doctor_retryable",
				trigger: "backfill",
				sourceIds: ["source_doctor_retryable"],
				sourceDigest: `sha256:${"1".repeat(64)}`,
				promptVersion: "pi-xk.memory-capture-v1",
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			{
				eventId: "evt_memory_doctor_retryable_scheduled",
				idempotencyKey: "memory:doctor:retryable:scheduled",
				expectedHead: { sequence: 0, hash: null },
			},
		);
		const generating = await store.markGenerationStarted("capture_doctor_retryable", 1, {
			eventId: "evt_memory_doctor_retryable_generating",
			idempotencyKey: "memory:doctor:retryable:generation:1",
			expectedHead: first.head,
		});
		const failed = await store.markCaptureFailed(
			{
				captureId: "capture_doctor_retryable",
				stage: "source",
				errorCode: "memory_capture_context_failed",
				retryable: true,
				message: "Transient Memory index failure.",
			},
			{
				eventId: "evt_memory_doctor_retryable_failed",
				idempotencyKey: "memory:doctor:retryable:failed:1",
				expectedHead: generating.head,
			},
		);
		const second = await store.scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId: "capture_doctor_indeterminate",
				trigger: "backfill",
				sourceIds: ["source_doctor_indeterminate"],
				sourceDigest: `sha256:${"2".repeat(64)}`,
				promptVersion: "pi-xk.memory-capture-v1",
				createdAt: "2026-08-01T00:01:00.000Z",
			},
			{
				eventId: "evt_memory_doctor_indeterminate_scheduled",
				idempotencyKey: "memory:doctor:indeterminate:scheduled",
				expectedHead: failed.head,
			},
		);
		await store.markGenerationStarted("capture_doctor_indeterminate", 1, {
			eventId: "evt_memory_doctor_indeterminate_generating",
			idempotencyKey: "memory:doctor:indeterminate:generation:1",
			expectedHead: second.head,
		});

		const report = await service.doctor("quick");
		expect(report.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "capture_failed_retryable", repairable: false }),
				expect.objectContaining({ code: "capture_indeterminate", repairable: false }),
			]),
		);
		await service.close();
	});

	it("keeps quick doctor on the verified checkpoint path", async () => {
		const projectRoot = join(
			tmpdir(),
			`pi-xk-memory-doctor-fast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(projectRoot, { recursive: true });
		tempDirs.push(projectRoot);
		let fullReplays = 0;
		const service = new MemoryService(
			projectRoot,
			new MemoryStore(projectRoot, {
				onFullReplay: () => {
					fullReplays += 1;
				},
			}),
		);
		await service.remember("Quick doctor must not replay the complete Memory event log.", {
			commandId: "command_doctor_fast",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.repairProjections();
		fullReplays = 0;

		const report = await service.doctor("quick");
		expect(report.ok).toBe(true);
		expect(report.checked.bytesRead).toBeGreaterThan(0);
		expect(fullReplays).toBe(0);
		await service.close();
	});

	it("validates projection manifest metadata and Markdown digests", async () => {
		const { projectRoot, service } = await createService();
		const remembered = await service.remember("Projection manifests prove derived Markdown freshness.", {
			commandId: "command_projection_manifest",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.repairProjections();
		const projections = join(projectRoot, ".pi-xk", "memory", "projections");
		const manifestPath = join(projections, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		await writeFile(manifestPath, `${JSON.stringify({ ...manifest, unexpected: true })}\n`);
		expect((await service.doctor("quick")).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "projection_manifest_invalid", repairable: true })]),
		);

		await service.repairProjections();
		await writeFile(join(projections, "index.md"), "# stale index\n");
		expect((await service.doctor("quick")).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "markdown_index_stale", repairable: true })]),
		);

		await service.repairProjections();
		await writeFile(
			join(projections, "memories", `${remembered.revision.memoryId}.md`),
			"# stale memory projection\n",
		);
		expect((await service.doctor("deep")).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "markdown_stale", repairable: true })]),
		);
		await service.close();
	}, 15_000);

	it("does not rebuild the SQLite projection when history cues are unchanged", async () => {
		const { service } = await createService();
		await service.remember("History cue equality avoids redundant index rebuilds.", {
			commandId: "command_history_cue_equality",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		const cues = [
			{
				cueId: "history_same_cue",
				sourceType: "segment_summary" as const,
				sourceId: `sha256:${"d".repeat(64)}`,
				title: "Stable history cue",
				recordedAt: "2026-08-01T00:00:00.000Z",
				chainId: "chain_history",
				branchId: "branch_history",
				segmentId: "segment_history",
				ordinal: 1,
				sessionId: null,
			},
		];
		service.setHistoryCues(cues);
		expect((await service.status()).indexState).toBe("rebuilt");

		service.setHistoryCues(cues);
		expect((await service.status()).indexState).toBe("current");
		await service.close();
	});

	it("keeps a stable history-cue snapshot while an index rebuild is in flight", async () => {
		const projectRoot = join(
			tmpdir(),
			`pi-xk-memory-history-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(projectRoot, { recursive: true });
		tempDirs.push(projectRoot);
		let pauseReferenceRead = false;
		let markReferenceReadStarted: (() => void) | undefined;
		let releaseReferenceRead: (() => void) | undefined;
		const referenceReadStarted = new Promise<void>((resolve) => {
			markReferenceReadStarted = resolve;
		});
		const referenceReadGate = new Promise<void>((resolve) => {
			releaseReferenceRead = resolve;
		});
		class PausingReferenceStore extends MemoryStore {
			override async readMemoriesByReferences(
				references: Parameters<MemoryStore["readMemoriesByReferences"]>[0],
				cueExists: Parameters<MemoryStore["readMemoriesByReferences"]>[1],
			) {
				const memories = await super.readMemoriesByReferences(references, cueExists);
				if (pauseReferenceRead) {
					pauseReferenceRead = false;
					markReferenceReadStarted?.();
					await referenceReadGate;
				}
				return memories;
			}
		}
		const service = new MemoryService(projectRoot, new PausingReferenceStore(projectRoot));
		await service.remember("History cue rebuilds must use one immutable input snapshot.", {
			commandId: "command_history_cue_snapshot",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		service.setHistoryCues([
			{
				cueId: "history_snapshot_1",
				sourceType: "segment_summary",
				sourceId: `sha256:${"1".repeat(64)}`,
				title: "First stable cue",
				recordedAt: "2026-08-01T00:00:00.000Z",
				chainId: "chain_history_snapshot",
				branchId: "branch_history_snapshot",
				segmentId: "segment_history_snapshot_1",
				ordinal: 1,
				sessionId: null,
			},
		]);
		pauseReferenceRead = true;
		const rebuilding = service.status();
		await referenceReadStarted;
		service.setHistoryCues([
			{
				cueId: "history_snapshot_1",
				sourceType: "segment_summary",
				sourceId: `sha256:${"1".repeat(64)}`,
				title: "First stable cue",
				recordedAt: "2026-08-01T00:00:00.000Z",
				chainId: "chain_history_snapshot",
				branchId: "branch_history_snapshot",
				segmentId: "segment_history_snapshot_1",
				ordinal: 1,
				sessionId: null,
			},
			{
				cueId: "history_snapshot_2",
				sourceType: "compaction",
				sourceId: "compaction_history_snapshot_2",
				title: "Second stable cue",
				recordedAt: "2026-08-01T00:01:00.000Z",
				chainId: "chain_history_snapshot",
				branchId: "branch_history_snapshot",
				segmentId: "segment_history_snapshot_2",
				ordinal: 2,
				sessionId: "session_history_snapshot_2",
			},
		]);
		releaseReferenceRead?.();

		await expect(rebuilding).resolves.toMatchObject({ index: { historyCueCount: 2 } });
		expect((await service.status()).index?.historyCueCount).toBe(2);
		await service.close();
	});

	it("serializes concurrent projection rebuilds and retrieval", async () => {
		const { service } = await createService();
		await service.remember("Concurrent projection maintenance must preserve searchable Memory.", {
			commandId: "command_concurrent_projection_rebuild",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});

		const operations = Array.from({ length: 12 }, (_, index) =>
			index % 3 === 0
				? service.repairProjections().then(() => undefined)
				: service.search({ query: "Concurrent projection maintenance" }).then((result) => {
						expect(result.items).toHaveLength(1);
					}),
		);
		await Promise.all(operations);
		expect((await service.search({ query: "Concurrent projection maintenance" })).items).toHaveLength(1);
		await service.close();
	}, 30_000);

	it("fully validates compaction provenance before D2 reads and resolves the D3 entry", async () => {
		const { projectRoot, service } = await createService();
		const sessionId = "session_memory_compaction";
		const segmentId = "segment_memory_compaction";
		const entryId = "compaction_memory_1";
		const title = "Memory provenance compaction";
		const sessionPath = join(projectRoot, "memory-compaction.jsonl");
		await writeFile(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-08-01T00:00:00.000Z",
				cwd: projectRoot,
			})}\n${JSON.stringify({
				type: "compaction",
				id: entryId,
				parentId: null,
				timestamp: "2026-08-01T00:01:00.000Z",
				summary: "Compaction evidence body.",
				firstKeptEntryId: "leaf_after_compaction",
				tokensBefore: 20_000,
				title,
			})}\n`,
		);
		await new SessionChainStore(projectRoot).createChain(
			{
				schema: "pi-xk.session-chain.spec.v1",
				chainId: "chain_memory_compaction",
				title: "Memory compaction provenance",
				cwd: projectRoot,
				rootBranchId: "branch_memory_compaction",
				rootSegment: {
					segmentId,
					ordinal: 1,
					location: { kind: "external-root", absolutePath: sessionPath },
					predecessorSegmentId: null,
					summaryInArtifactId: null,
					createdAt: "2026-08-01T00:00:00.000Z",
				},
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			{
				eventId: "evt_memory_compaction_chain_created",
				idempotencyKey: "chain:create:memory-compaction-provenance",
				actor: "user",
				timestamp: "2026-08-01T00:00:00.000Z",
			},
		);
		const evidence: EvidenceRefV1 = {
			schema: "pi-xk.memory-evidence-ref.v1",
			evidenceId: "evidence_memory_compaction",
			sourceType: "compaction",
			sourceId: entryId,
			artifactId: null,
			sourceDigest: `sha256:${"b".repeat(64)}`,
			recordedAt: "2026-08-01T00:01:00.000Z",
			locator: { sessionId, entryId, title },
		};
		await publishMemoryWithEvidence(projectRoot, service, "memory_compaction_provenance", evidence);

		expect((await service.read({ memoryIds: ["memory_compaction_provenance"] })).memories).toHaveLength(1);
		const expanded = await service.expandEvidence({ memoryId: "memory_compaction_provenance" });
		expect(expanded.evidence[0]).toMatchObject({ unavailableReason: null });
		expect(expanded.evidence[0]?.content).toContain(entryId);
		expect(expanded.evidence[0]?.content).toContain("Compaction evidence body");

		await rm(sessionPath);
		await expect(service.read({ memoryIds: ["memory_compaction_provenance"] })).rejects.toThrow(
			"source file is missing",
		);

		await writeFile(sessionPath, "{malformed jsonl\n");
		await expect(service.read({ memoryIds: ["memory_compaction_provenance"] })).rejects.toThrow("JSONL is malformed");
		expect((await service.doctor("deep")).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "fact_provenance_invalid", repairable: false })]),
		);
		await service.close();
	}, 15_000);

	it("expands Git evidence from the verified baseline commit", async () => {
		const { projectRoot, service } = await createService();
		await execFile("git", ["init", "-q"], { cwd: projectRoot });
		await execFile("git", ["config", "user.email", "memory-test@example.invalid"], { cwd: projectRoot });
		await execFile("git", ["config", "user.name", "Memory Test"], { cwd: projectRoot });
		await writeFile(join(projectRoot, "memory-source.txt"), "Canonical Git evidence body.\n");
		await execFile("git", ["add", "memory-source.txt"], { cwd: projectRoot });
		await execFile("git", ["commit", "-q", "-m", "memory evidence fixture"], { cwd: projectRoot });
		const basis = await captureGitFreshnessBasis(projectRoot, ["memory-source.txt"]);
		const evidence: EvidenceRefV1 = {
			schema: "pi-xk.memory-evidence-ref.v1",
			evidenceId: "evidence_memory_git",
			sourceType: "git",
			sourceId: basis.baselineCommit,
			artifactId: null,
			sourceDigest: `sha256:${"c".repeat(64)}`,
			recordedAt: "2026-08-01T00:00:00.000Z",
			locator: {
				repositoryId: basis.repositoryId,
				baselineCommit: basis.baselineCommit,
				scopePaths: basis.scopePaths,
			},
		};
		await publishMemoryWithEvidence(projectRoot, service, "memory_git_evidence", evidence);

		const expanded = await service.expandEvidence({ memoryId: "memory_git_evidence" });
		expect(expanded.evidence[0]).toMatchObject({ unavailableReason: null });
		expect(expanded.evidence[0]?.content).toContain("memory-source.txt");
		expect(expanded.evidence[0]?.content).toContain("Canonical Git evidence body.");
		expect(expanded.evidence[0]?.content).toContain(basis.baselineCommit);
		await service.close();
	});

	it("rejects Goal, Chain, and Task evidence whose canonical artifact digest does not match", async () => {
		const { projectRoot, service } = await createService();
		const recordedAt = "2026-08-01T00:00:00.000Z";
		const goalId = "goal_memory_evidence";
		const goal: GoalContractV3 = {
			schema: "pi-xk.goal.contract.v3",
			goalId,
			title: "Memory evidence Goal",
			intentAnchor: "Validate canonical Goal evidence.",
			objective: "Publish one checkpoint for Memory evidence validation.",
			constraints: [],
			acceptance: [
				{
					id: "A-1",
					kind: "test",
					description: "Canonical evidence provenance is validated.",
					required: true,
					command: "memory evidence fixture",
				},
			],
			capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
			budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
			ownerSessionId: "session_memory_evidence",
			createdAt: recordedAt,
			schemaVersion: 3,
			revision: 1,
			nonGoals: [],
			doneCondition: "The evidence validator rejects mismatched provenance.",
			pauseCondition: "No in-scope validation can continue.",
			finalReport: "Report the integrity result.",
			executionAuthorization: "Run local evidence validation.",
		};
		const goals = new GoalStore(projectRoot);
		const goalCreated = await goals.createGoal(goal, {
			eventId: "evt_goal_memory_evidence_created",
			idempotencyKey: "goal:memory-evidence:create",
			actor: "user",
			timestamp: recordedAt,
		});
		const checkpointArtifact = await goals.putArtifact({
			contentType: "text/plain",
			text: "Goal checkpoint evidence.",
			producer: "pi-xk.memory-evidence-test.v1",
			sensitivity: "internal",
			sourceIds: [goalId, "leaf_memory_evidence"],
			createdAt: recordedAt,
		});
		const checkpoint = await goals.appendCheckpoint(
			goalId,
			{
				schema: "pi-xk.goal-checkpoint.v2",
				sessionId: "session_memory_evidence",
				leafId: "leaf_memory_evidence",
				turnIndex: 1,
				toolResultCount: 0,
				reason: "turn_end",
				createdAt: recordedAt,
				evidence: {
					schema: "pi-xk.goal-checkpoint-evidence.v1",
					sourceEntryIds: ["leaf_memory_evidence"],
					artifacts: [
						{
							schema: "pi-xk.artifact-ref.v1",
							artifactId: checkpointArtifact.artifactId,
							role: "checkpoint_evidence",
						},
					],
				},
			},
			{
				eventId: "evt_goal_memory_evidence_checkpoint",
				idempotencyKey: "goal:memory-evidence:checkpoint",
				expectedHead: goalCreated.head,
				actor: "runtime",
				timestamp: recordedAt,
			},
		);
		const goalSource = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: {
				schema: "pi-xk.memory-goal-source.v1",
				goalId,
				contractRevision: 1,
				event: checkpoint.event,
				state: "# Goal State\n",
			},
			producer: "pi-xk.memory-goal-source.v1",
			sensitivity: "internal",
			sourceIds: [goalId, checkpoint.event.eventId],
			createdAt: recordedAt,
		});
		await expect(
			publishMemoryWithEvidence(projectRoot, service, "memory_invalid_goal_digest", {
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: "evidence_invalid_goal_digest",
				sourceType: "goal_checkpoint",
				sourceId: checkpoint.event.eventId,
				artifactId: goalSource.artifactId,
				sourceDigest: `sha256:${"d".repeat(64)}`,
				recordedAt,
				locator: { goalId, checkpointEventId: checkpoint.event.eventId },
			}),
		).rejects.toThrow(/digest/i);
		const goalSchemaSource = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: {
				schema: "pi-xk.memory-goal-source.v1",
				goalId,
				contractRevision: 1,
				event: checkpoint.event,
				state: "# Goal State\n",
				unexpected: true,
			},
			producer: "pi-xk.memory-goal-source.v1",
			sensitivity: "internal",
			sourceIds: [goalId, checkpoint.event.eventId],
			createdAt: recordedAt,
		});
		await expect(
			publishMemoryWithEvidence(projectRoot, service, "memory_invalid_goal_schema", {
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: "evidence_invalid_goal_schema",
				sourceType: "goal_checkpoint",
				sourceId: checkpoint.event.eventId,
				artifactId: goalSchemaSource.artifactId,
				sourceDigest: goalSchemaSource.artifactId,
				recordedAt,
				locator: { goalId, checkpointEventId: checkpoint.event.eventId },
			}),
		).rejects.toThrow(/schema/i);

		const chains = new SessionChainStore(projectRoot);
		const chainCreated = await chains.createChain(
			{
				schema: "pi-xk.session-chain.spec.v1",
				chainId: "chain_memory_evidence",
				title: "Memory evidence chain",
				cwd: projectRoot,
				rootBranchId: "branch_memory_evidence",
				rootSegment: {
					segmentId: "segment_memory_evidence",
					ordinal: 1,
					location: { kind: "external-root", absolutePath: join(projectRoot, "segment-memory-evidence.jsonl") },
					predecessorSegmentId: null,
					summaryInArtifactId: null,
					createdAt: recordedAt,
				},
				createdAt: recordedAt,
			},
			{
				eventId: "evt_chain_memory_evidence_created",
				idempotencyKey: "chain:memory-evidence:create",
				actor: "user",
				timestamp: recordedAt,
			},
		);
		const summaryArtifactId = await chains.putSegmentSummary({
			schema: "pi-xk.segment-summary.v2",
			title: "Memory evidence validation",
			chainId: "chain_memory_evidence",
			branchId: "branch_memory_evidence",
			sourceSegmentId: "segment_memory_evidence",
			sourceLeafId: "leaf_memory_evidence",
			targetSegmentId: "segment_memory_evidence_next",
			baseSummaryArtifactId: null,
			sourceRange: {
				firstEntryId: "leaf_memory_evidence",
				lastEntryId: "leaf_memory_evidence",
				entryCount: 1,
				entriesHash: `sha256:${"e".repeat(64)}`,
			},
			segmentDeltaMarkdown: "Validate canonical evidence.",
			carryForwardMarkdown: "Continue evidence validation.",
			generator: {
				provider: "faux",
				modelId: "faux",
				promptVersion: "session-chain-summary-v3",
				inputTokens: 1,
				outputTokens: 1,
				generatedAt: recordedAt,
			},
		});
		const prepared = await chains.appendRolloverPrepared(
			"chain_memory_evidence",
			{
				branchId: "branch_memory_evidence",
				sourceSegmentId: "segment_memory_evidence",
				sourceLeafId: "leaf_memory_evidence",
				targetSegment: {
					segmentId: "segment_memory_evidence_next",
					ordinal: 2,
					location: { kind: "managed", fileName: "000002_segment_memory_evidence_next.jsonl" },
					predecessorSegmentId: "segment_memory_evidence",
					summaryInArtifactId: summaryArtifactId,
					createdAt: recordedAt,
				},
				summaryArtifactId,
				reason: "Memory evidence fixture",
			},
			{
				eventId: "evt_chain_memory_evidence_prepared",
				idempotencyKey: "chain:memory-evidence:prepared",
				expectedHead: chainCreated.head,
				actor: "runtime",
				timestamp: recordedAt,
			},
		);
		await chains.appendRolloverCommitted(
			"chain_memory_evidence",
			{
				branchId: "branch_memory_evidence",
				sourceSegmentId: "segment_memory_evidence",
				targetSegmentId: "segment_memory_evidence_next",
				sourceSeal: {
					bytes: 1,
					fileHash: `sha256:${"f".repeat(64)}`,
					leafId: "summary_out_memory_evidence",
					summaryArtifactId,
					summaryOutEntryId: "summary_out_memory_evidence",
				},
				targetMarkers: {
					chainLinkEntryId: "chain_link_memory_evidence",
					summaryInEntryId: "summary_in_memory_evidence",
				},
			},
			{
				eventId: "evt_chain_memory_evidence_committed",
				idempotencyKey: "chain:memory-evidence:committed",
				expectedHead: prepared.head,
				actor: "runtime",
				timestamp: recordedAt,
			},
		);
		await expect(
			publishMemoryWithEvidence(projectRoot, service, "memory_invalid_chain_digest", {
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: "evidence_invalid_chain_digest",
				sourceType: "chain_summary",
				sourceId: summaryArtifactId,
				artifactId: summaryArtifactId,
				sourceDigest: `sha256:${"1".repeat(64)}`,
				recordedAt,
				locator: {
					chainId: "chain_memory_evidence",
					branchId: "branch_memory_evidence",
					level: "l1",
					segmentId: "segment_memory_evidence",
					ordinal: 1,
					windowIndex: null,
				},
			}),
		).rejects.toThrow(/sourceDigest/i);

		const tasks = new TaskStore(projectRoot);
		const taskCreated = await tasks.createTask(
			{
				schema: "pi-xk.task.spec.v1",
				taskId: "task_memory_evidence",
				parentSessionId: "session_memory_evidence",
				parentEntryId: "entry_memory_evidence",
				parentGoalId: null,
				role: "verification",
				prompt: "Validate Task evidence.",
				expectedResult: "A canonical Task result.",
				workspaceMode: "same-workspace",
				allowNestedSpawn: false,
				createdAt: recordedAt,
			},
			{
				eventId: "evt_task_memory_evidence_created",
				idempotencyKey: "task:memory-evidence:create",
				actor: "user",
				timestamp: recordedAt,
			},
		);
		const taskStarted = await tasks.appendTaskStarted(
			"task_memory_evidence",
			{
				childSessionId: "session_task_memory_evidence",
				childSessionFile: join(projectRoot, "task-memory-evidence.jsonl"),
				provider: "faux",
				modelId: "faux",
				thinkingLevel: "medium",
				builtinTools: [],
				attempt: 1,
			},
			{
				eventId: "evt_task_memory_evidence_started",
				idempotencyKey: "task:memory-evidence:start",
				expectedHead: taskCreated.head,
				actor: "runtime",
				timestamp: recordedAt,
			},
		);
		const taskResult = await tasks.appendTaskResult(
			"task_memory_evidence",
			{
				schema: "pi-xk.task-result.v1",
				taskId: "task_memory_evidence",
				status: "succeeded",
				attempt: 1,
				summary: "Task evidence is available.",
				evidence: [],
				artifactIds: [],
				childSessionId: "session_task_memory_evidence",
				childSessionFile: join(projectRoot, "task-memory-evidence.jsonl"),
				startedAt: recordedAt,
				endedAt: recordedAt,
				error: null,
			},
			{
				eventId: "evt_task_memory_evidence_succeeded",
				idempotencyKey: "task:memory-evidence:result",
				expectedHead: taskStarted.head,
				actor: "runtime",
				timestamp: recordedAt,
			},
		);
		if (taskResult.event.eventType !== "task_succeeded") throw new Error("Task evidence fixture did not succeed");
		await expect(
			publishMemoryWithEvidence(projectRoot, service, "memory_invalid_task_digest", {
				schema: "pi-xk.memory-evidence-ref.v1",
				evidenceId: "evidence_invalid_task_digest",
				sourceType: "task_result",
				sourceId: taskResult.event.eventId,
				artifactId: taskResult.event.payload.resultArtifactId,
				sourceDigest: `sha256:${"2".repeat(64)}`,
				recordedAt,
				locator: { taskId: "task_memory_evidence" },
			}),
		).rejects.toThrow(/sourceDigest/i);
		await service.close();
	}, 30_000);

	it("detects tampered Memory artifacts during deep doctor", async () => {
		const { projectRoot, service } = await createService();
		const remembered = await service.remember("Deep doctor validates the complete artifact provenance chain.", {
			commandId: "command_doctor_deep",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.repairProjections();
		await new ArtifactStore(projectRoot).put({
			contentType: "text/plain",
			text: "unpublished generator output",
			producer: "pi-xk.memory-orphan-test.v1",
			sensitivity: "internal",
			sourceIds: ["orphan_test"],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		const digest = remembered.artifactId.slice("sha256:".length);
		const dataPath = join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`);
		const content = await readFile(dataPath, "utf8");
		await writeFile(dataPath, `${content.startsWith("{") ? "[" : "{"}${content.slice(1)}`);

		const report = await service.doctor("deep");
		expect(report.ok).toBe(false);
		expect(report.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "fact_provenance_invalid", repairable: false })]),
		);
		await service.close();
	});

	it("reports unpublished Memory artifacts as deep-doctor orphans", async () => {
		const { projectRoot, service } = await createService();
		await service.remember("Published Memory remains connected to its event facts.", {
			commandId: "command_doctor_orphan",
			recordedAt: "2026-08-01T00:00:00.000Z",
		});
		await service.repairProjections();
		await new ArtifactStore(projectRoot).put({
			contentType: "text/plain",
			text: "unpublished generator output",
			producer: "pi-xk.memory-orphan-test.v1",
			sensitivity: "internal",
			sourceIds: ["orphan_test"],
			createdAt: "2026-08-01T00:00:01.000Z",
		});

		const report = await service.doctor("deep");
		expect(report.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "orphan_memory_artifact", repairable: false })]),
		);
		await service.close();
	});
});
