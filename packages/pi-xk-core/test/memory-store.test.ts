import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactNotFoundError,
	ArtifactStore,
	type MemoryCaptureSourceV1,
	type MemoryChangeProposalV1,
	MemoryCorruptionError,
	type MemoryEventV1,
	MemoryHeadConflictError,
	MemoryLockedError,
	MemoryNotFoundError,
	MemoryRecoveryRequiredError,
	MemoryStore,
	MemoryValidationError,
	stableJsonStringify,
} from "../src/index.ts";

const tempDirs: string[] = [];

async function createStore(): Promise<{ projectRoot: string; store: MemoryStore }> {
	const projectRoot = join(tmpdir(), `pi-xk-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { projectRoot, store: new MemoryStore(projectRoot) };
}

function source(): MemoryCaptureSourceV1 {
	return {
		schema: "pi-xk.memory-capture-source.v1",
		captureId: "capture_goal_checkpoint_1",
		trigger: "goal_checkpoint",
		sourceIds: ["goal_example", "evt_checkpoint_1"],
		sourceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		promptVersion: "pi-xk.memory-capture.v1",
		createdAt: "2026-08-01T00:00:00.000Z",
	};
}

function proposal(expectedEventHead: { sequence: number; hash: string | null }): MemoryChangeProposalV1 {
	const evidence = {
		schema: "pi-xk.memory-evidence-ref.v1" as const,
		evidenceId: "evidence_goal_checkpoint",
		sourceType: "explicit" as const,
		sourceId: "command_memory_store_fixture",
		artifactId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		sourceDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		recordedAt: "2026-08-01T00:00:00.000Z",
		locator: { commandId: "command_memory_store_fixture" },
	};
	const provenance = {
		producer: "model" as const,
		model: "faux/model",
		promptVersion: "pi-xk.memory-capture.v1",
		recordedAt: "2026-08-01T00:00:01.000Z",
	};
	return {
		schema: "pi-xk.memory-change-proposal.v1",
		proposalId: "proposal_goal_checkpoint_1",
		captureId: source().captureId,
		sourceDigest: source().sourceDigest,
		expectedEventHead,
		expectedRevisions: [],
		reason: "Preserve a durable Session Chain decision.",
		operations: [
			{
				kind: "publish_cue",
				cue: {
					schema: "pi-xk.memory-cue.v1",
					cueId: "cue_session_chain",
					revision: 1,
					kind: "component",
					key: "session-chain",
					label: "Session Chain",
					aliases: ["chain"],
					scope: {
						projectId: "project_pi_xk",
						goalId: "goal_example",
						chainId: null,
						branchId: null,
						paths: ["packages/pi-xk-core"],
					},
					sourceDigest: source().sourceDigest,
					provenance,
				},
			},
			{
				kind: "publish_revision",
				revision: {
					schema: "pi-xk.memory-revision.v1",
					memoryId: "memory_canonical_summary",
					revision: 1,
					kind: "decision",
					title: "Canonical summary content",
					statement: "Use token=secretvalue123 as a fixture.",
					applicability: "Session Chain rollover summaries.",
					trust: "model_inferred",
					lifecycle: "active",
					effectiveFrom: "2026-08-01T00:00:00.000Z",
					effectiveTo: null,
					cueIds: ["cue_session_chain"],
					evidenceRefs: [evidence],
					freshnessBasis: null,
					sourceDigest: source().sourceDigest,
					supersedesRevision: null,
					provenance,
				},
			},
			{
				kind: "publish_edge",
				edge: {
					schema: "pi-xk.memory-edge.v1",
					edgeId: "edge_canonical_to_chain",
					from: { kind: "memory", id: "memory_canonical_summary" },
					to: { kind: "cue", id: "cue_session_chain" },
					relation: "applies_to",
					effectiveFrom: "2026-08-01T00:00:00.000Z",
					effectiveTo: null,
					evidenceRefs: [evidence],
					sourceDigest: source().sourceDigest,
					provenance,
				},
			},
		],
		provenance,
	};
}

async function publishMemoryWithoutEdges(
	projectRoot: string,
	store: MemoryStore,
): Promise<{ sequence: number; hash: string | null }> {
	const scheduled = await store.scheduleCapture(source(), {
		eventId: "evt_schedule_1",
		idempotencyKey: "schedule:capture_goal_checkpoint_1",
		expectedHead: { sequence: 0, hash: null },
	});
	const generating = await store.markGenerationStarted(source().captureId, 1, {
		eventId: "evt_generation_1",
		idempotencyKey: "generation:capture_goal_checkpoint_1:1",
		expectedHead: scheduled.head,
	});
	const evidenceArtifact = await new ArtifactStore(projectRoot).put({
		contentType: "text/plain",
		text: "checkpoint evidence",
		producer: "pi-xk.memory-explicit.v1",
		sensitivity: "internal",
		sourceIds: ["command_memory_store_fixture"],
		createdAt: "2026-08-01T00:00:00.000Z",
	});
	const generated = proposal(generating.head);
	generated.operations = generated.operations.filter((operation) => operation.kind === "publish_revision");
	const revisionOperation = generated.operations[0];
	if (!revisionOperation || revisionOperation.kind !== "publish_revision") throw new Error("missing revision fixture");
	revisionOperation.revision.cueIds = [];
	revisionOperation.revision.evidenceRefs[0] = {
		...revisionOperation.revision.evidenceRefs[0],
		artifactId: evidenceArtifact.artifactId,
		sourceDigest: evidenceArtifact.artifactId,
	};
	const resultArtifact = await new ArtifactStore(projectRoot).put({
		contentType: "application/json",
		value: { schema: "pi-xk.memory-generator-result.v1", proposal: generated },
		producer: "pi-xk.memory-capture.v1",
		sensitivity: "internal",
		sourceIds: [source().captureId],
		createdAt: "2026-08-01T00:00:01.000Z",
	});
	const recorded = await store.recordProposal(generated, resultArtifact.artifactId, {
		eventId: "evt_proposal_1",
		idempotencyKey: "proposal:proposal_goal_checkpoint_1",
		expectedHead: generating.head,
	});
	return (
		await store.applyProposal(recorded.proposalArtifactId, {
			eventId: "evt_apply_1",
			idempotencyKey: "apply:proposal_goal_checkpoint_1",
			expectedHead: recorded.write.head,
		})
	).write.head;
}

async function publishMemorySharingEvidence(
	projectRoot: string,
	store: MemoryStore,
	expectedEventHead: { sequence: number; hash: string | null },
): Promise<{ head: { sequence: number; hash: string | null }; evidenceArtifactId: string }> {
	const original = await store.readMemory("memory_canonical_summary");
	const evidence = original.revision.evidenceRefs[0];
	if (evidence?.schema !== "pi-xk.memory-evidence-ref.v1" || !evidence.artifactId) {
		throw new Error("missing shared V1 evidence fixture");
	}
	const sourceDigest = `sha256:${"d".repeat(64)}`;
	const recordedAt = "2026-08-01T00:02:00.000Z";
	const sharedProposal: MemoryChangeProposalV1 = {
		schema: "pi-xk.memory-change-proposal.v1",
		proposalId: "proposal_shared_evidence_memory",
		captureId: null,
		sourceDigest,
		expectedEventHead,
		expectedRevisions: [],
		reason: "Publish another Memory that relies on the same retained evidence.",
		operations: [
			{
				kind: "publish_revision",
				revision: {
					schema: "pi-xk.memory-revision.v1",
					memoryId: "memory_shared_evidence",
					revision: 1,
					kind: "lesson",
					title: "Shared evidence remains readable",
					statement: "Evidence shared by two Memory records must outlive either record independently.",
					applicability: "Memory purge cleanup.",
					trust: "model_inferred",
					lifecycle: "active",
					effectiveFrom: recordedAt,
					effectiveTo: null,
					cueIds: [],
					evidenceRefs: [evidence],
					freshnessBasis: null,
					sourceDigest,
					supersedesRevision: null,
					provenance: {
						producer: "model",
						model: "faux/model",
						promptVersion: "pi-xk.memory-model-proposal.v1",
						recordedAt,
					},
				},
			},
		],
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.memory-model-proposal.v1",
			recordedAt,
		},
	};
	const resultArtifact = await new ArtifactStore(projectRoot).put({
		contentType: "application/json",
		value: sharedProposal,
		producer: "pi-xk.memory-model-proposal.v1",
		sensitivity: "internal",
		sourceIds: [sharedProposal.proposalId],
		createdAt: recordedAt,
	});
	const recorded = await store.recordProposal(sharedProposal, resultArtifact.artifactId, {
		eventId: "evt_proposal_shared_evidence_memory",
		idempotencyKey: "memory:proposal:shared-evidence-memory",
		expectedHead: expectedEventHead,
	});
	const applied = await store.applyProposal(recorded.proposalArtifactId, {
		eventId: "evt_apply_shared_evidence_memory",
		idempotencyKey: "memory:apply:shared-evidence-memory",
		expectedHead: recorded.write.head,
	});
	return { head: applied.write.head, evidenceArtifactId: evidence.artifactId };
}

async function rewriteLastMemoryEvent(
	eventsPath: string,
	mutate: (event: MemoryEventV1) => MemoryEventV1,
): Promise<void> {
	const lines = (await readFile(eventsPath, "utf8")).split("\n").filter((line) => line.length > 0);
	const lastIndex = lines.length - 1;
	const raw = lines[lastIndex];
	if (!raw) throw new Error("missing Memory event fixture");
	const mutated = mutate(JSON.parse(raw) as MemoryEventV1);
	const { hash: _hash, ...hashable } = mutated;
	lines[lastIndex] = stableJsonStringify({
		...hashable,
		hash: `sha256:${createHash("sha256").update(stableJsonStringify(hashable)).digest("hex")}`,
	});
	await writeFile(eventsPath, `${lines.join("\n")}\n`);
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const directory = tempDirs.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("Memory Store", () => {
	it("serializes capture generation across store instances", async () => {
		const { projectRoot, store: first } = await createStore();
		const second = new MemoryStore(projectRoot);
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const owner = first.withCaptureGenerationLock("capture_generation_lock", async () => {
			entered?.();
			await gate;
			return "owner";
		});
		await started;

		await expect(
			second.withCaptureGenerationLock("capture_generation_lock", async () => "contender"),
		).rejects.toThrow(/generation|locked/i);
		release?.();
		await expect(owner).resolves.toBe("owner");
		expect(await first.inspectCaptureGenerationLock("capture_generation_lock")).toBeUndefined();
	});

	it("serializes projection mutations across store instances and releases the lock", async () => {
		const { projectRoot, store: first } = await createStore();
		const second = new MemoryStore(projectRoot);
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const owner = first.withProjectionLock(async () => {
			entered?.();
			await gate;
			return "owner";
		});
		await started;

		await expect(second.withProjectionLock(async () => "contender")).rejects.toThrow(/projection|locked/i);
		release?.();
		await expect(owner).resolves.toBe("owner");
		await expect(second.withProjectionLock(async () => "next")).resolves.toBe("next");
	});

	it("does not create project state until the first capture is scheduled", async () => {
		const { projectRoot, store } = await createStore();
		expect(await store.replay()).toMatchObject({ head: { sequence: 0, hash: null }, events: [] });
		await expect(readFile(join(projectRoot, ".pi-xk", "memory", "events.jsonl"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

		const scheduled = await store.scheduleCapture(source(), {
			eventId: "evt_schedule_1",
			idempotencyKey: "schedule:capture_goal_checkpoint_1",
			expectedHead: { sequence: 0, hash: null },
		});
		expect(scheduled.event.eventType).toBe("capture_scheduled");
		expect(scheduled.event.payload.sourceArtifactId).toMatch(/^sha256:/);
		expect((await store.replay()).captures.get(source().captureId)?.status).toBe("scheduled");
	});

	it("deduplicates capture scheduling and enforces event-head CAS", async () => {
		const { store } = await createStore();
		const scheduled = await store.scheduleCapture(source(), {
			eventId: "evt_schedule_1",
			idempotencyKey: "schedule:capture_goal_checkpoint_1",
			expectedHead: { sequence: 0, hash: null },
		});
		await expect(
			store.scheduleCapture(source(), {
				eventId: "evt_schedule_retry",
				idempotencyKey: "schedule:capture_goal_checkpoint_1",
				expectedHead: { sequence: 0, hash: null },
			}),
		).resolves.toEqual(scheduled);
		await expect(
			store.markGenerationStarted(source().captureId, 1, {
				eventId: "evt_generation_1",
				idempotencyKey: "generation:capture_goal_checkpoint_1:1",
				expectedHead: { sequence: 0, hash: null },
			}),
		).rejects.toBeInstanceOf(MemoryHeadConflictError);
	});

	it("validates capture transitions before appending an event", async () => {
		const { store } = await createStore();
		await expect(
			store.markGenerationStarted("capture_missing", 1, {
				eventId: "evt_generation_missing",
				idempotencyKey: "generation:capture_missing:1",
				expectedHead: { sequence: 0, hash: null },
			}),
		).rejects.toBeInstanceOf(MemoryValidationError);
		expect((await store.replay()).events).toEqual([]);
	});

	it("classifies capture failures and records each memory access at most once per run", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const access = await store.recordAccess(
			{ runId: "run_memory_1", memoryIds: ["memory_canonical_summary"], evidenceIds: ["evidence_goal_checkpoint"] },
			{
				eventId: "evt_access_1",
				idempotencyKey: "access:run_memory_1",
				expectedHead: head,
			},
		);
		head = access.head;
		await expect(
			store.recordAccess(
				{ runId: "run_memory_2", memoryIds: ["memory_missing"], evidenceIds: [] },
				{
					eventId: "evt_access_missing",
					idempotencyKey: "access:run_memory_2",
					expectedHead: head,
				},
			),
		).rejects.toBeInstanceOf(MemoryValidationError);
		expect((await store.replay()).head).toEqual(head);

		const fresh = await createStore();
		const scheduled = await fresh.store.scheduleCapture(source(), {
			eventId: "evt_schedule_failure",
			idempotencyKey: "schedule:failure",
			expectedHead: { sequence: 0, hash: null },
		});
		const generating = await fresh.store.markGenerationStarted(source().captureId, 1, {
			eventId: "evt_generation_failure",
			idempotencyKey: "generation:failure:1",
			expectedHead: scheduled.head,
		});
		const failed = await fresh.store.markCaptureFailed(
			{
				captureId: source().captureId,
				stage: "validation",
				errorCode: "invalid-evidence",
				retryable: false,
				message: "Evidence provenance is invalid.",
			},
			{
				eventId: "evt_failure_1",
				idempotencyKey: "failure:capture_goal_checkpoint_1:1",
				expectedHead: generating.head,
			},
		);
		await expect(
			fresh.store.markGenerationStarted(source().captureId, 2, {
				eventId: "evt_generation_failure_2",
				idempotencyKey: "generation:failure:2",
				expectedHead: failed.head,
			}),
		).rejects.toBeInstanceOf(MemoryValidationError);
		expect((await fresh.store.replay()).head).toEqual(failed.head);
	});

	it("recovers an appended access event from the verified event tail", async () => {
		const { projectRoot, store } = await createStore();
		const publishedHead = await publishMemoryWithoutEdges(projectRoot, store);
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		const readModelPath = join(memoryDirectory, "memory-read-model.json");
		const checkpointPath = join(memoryDirectory, "memory-read-model.checkpoint.json");
		const eventsPath = join(memoryDirectory, "events.jsonl");
		const originalReadModel = await readFile(readModelPath, "utf8");
		const originalCheckpoint = await readFile(checkpointPath, "utf8");

		await store.recordAccess(
			{ runId: "run_memory_tail", memoryIds: ["memory_canonical_summary"], evidenceIds: [] },
			{
				eventId: "evt_access_tail",
				idempotencyKey: "access:run_memory_tail",
				expectedHead: publishedHead,
				timestamp: "2026-08-01T00:10:00.000Z",
			},
		);
		await writeFile(readModelPath, originalReadModel);
		await writeFile(checkpointPath, originalCheckpoint);

		const recovered = await store.loadReadModelSnapshot();
		expect(recovered.diagnostic.mode).toBe("tail");
		expect(recovered.diagnostic.bytesRead).toBeLessThanOrEqual((await stat(eventsPath)).size);
		expect(recovered.readModel.accesses).toEqual([
			{
				memoryId: "memory_canonical_summary",
				accessCount: 1,
				lastAccessedAt: "2026-08-01T00:10:00.000Z",
			},
		]);

		const fast = await store.loadReadModelSnapshot();
		expect(fast.diagnostic.mode).toBe("fast");
		expect(fast.diagnostic.bytesRead).toBeLessThan((await stat(eventsPath)).size);
	});

	it("falls back to full replay when the event log is shorter than its checkpoint", async () => {
		const { projectRoot, store } = await createStore();
		await publishMemoryWithoutEdges(projectRoot, store);
		const eventsPath = join(projectRoot, ".pi-xk", "memory", "events.jsonl");
		const raw = await readFile(eventsPath, "utf8");
		const lines = raw.split("\n").filter((line) => line.length > 0);
		await writeFile(eventsPath, `${lines.slice(0, 2).join("\n")}\n`);

		const recovered = await store.loadReadModelSnapshot();
		expect(recovered.diagnostic).toMatchObject({ mode: "full", fallbackReason: "event-log-shortened" });
		expect(recovered.readModel.head.sequence).toBe(2);
		expect(recovered.readModel.memories).toEqual([]);
	});

	it("applies lifecycle, evidence detach, and purge events through the read-model tail", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		const readModelPath = join(memoryDirectory, "memory-read-model.json");
		const checkpointPath = join(memoryDirectory, "memory-read-model.checkpoint.json");
		const originalReadModel = await readFile(readModelPath, "utf8");
		const originalCheckpoint = await readFile(checkpointPath, "utf8");
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "No longer current.", {
				eventId: "evt_tail_lifecycle",
				idempotencyKey: "lifecycle:tail:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Source retention ended.",
				{
					eventId: "evt_tail_detach",
					idempotencyKey: "detach:tail:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_tail_purge",
			idempotencyKey: "purge:tail:3",
			expectedHead: head,
			confirmed: true,
		});
		await writeFile(readModelPath, originalReadModel);
		await writeFile(checkpointPath, originalCheckpoint);

		const recovered = await store.loadReadModelSnapshot();
		expect(recovered.diagnostic.mode).toBe("tail");
		expect(recovered.readModel.memories).toEqual([]);
		expect(recovered.readModel.edges).toEqual([]);
		expect(recovered.readModel.accesses).toEqual([]);
		expect(recovered.readModel.purgedSourceDigests).toEqual([source().sourceDigest]);
	});

	it("rejects a standalone purge whose source digest does not match the current Memory", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "No longer current.", {
				eventId: "evt_purge_digest_lifecycle",
				idempotencyKey: "lifecycle:purge-digest:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Source retention ended.",
				{
					eventId: "evt_purge_digest_detach",
					idempotencyKey: "detach:purge-digest:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_purge_digest",
			idempotencyKey: "purge:digest:3",
			expectedHead: head,
			confirmed: true,
		});
		const eventsPath = join(projectRoot, ".pi-xk", "memory", "events.jsonl");
		await rewriteLastMemoryEvent(eventsPath, (event) => {
			if (event.eventType !== "memory_purged") throw new Error("missing purge event fixture");
			return { ...event, payload: { ...event.payload, sourceDigest: `sha256:${"f".repeat(64)}` } };
		});

		await expect(store.replay()).rejects.toBeInstanceOf(MemoryCorruptionError);
	});

	it("rejects a standalone purge tail that omits the current revision artifact", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		const readModelPath = join(memoryDirectory, "memory-read-model.json");
		const checkpointPath = join(memoryDirectory, "memory-read-model.checkpoint.json");
		const eventsPath = join(memoryDirectory, "events.jsonl");
		const originalReadModel = await readFile(readModelPath, "utf8");
		const originalCheckpoint = await readFile(checkpointPath, "utf8");
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "No longer current.", {
				eventId: "evt_purge_artifact_lifecycle",
				idempotencyKey: "lifecycle:purge-artifact:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Source retention ended.",
				{
					eventId: "evt_purge_artifact_detach",
					idempotencyKey: "detach:purge-artifact:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_purge_artifact",
			idempotencyKey: "purge:artifact:3",
			expectedHead: head,
			confirmed: true,
		});
		await rewriteLastMemoryEvent(eventsPath, (event) => {
			if (event.eventType !== "memory_purged") throw new Error("missing purge event fixture");
			return {
				...event,
				payload: { ...event.payload, revisionArtifactIds: [`sha256:${"e".repeat(64)}`] },
			};
		});
		await writeFile(readModelPath, originalReadModel);
		await writeFile(checkpointPath, originalCheckpoint);

		await expect(store.loadReadModelSnapshot()).rejects.toBeInstanceOf(MemoryCorruptionError);
	});

	it("fails closed on a trailing partial event and repairs it explicitly", async () => {
		const { projectRoot, store } = await createStore();
		await store.scheduleCapture(source(), {
			eventId: "evt_schedule_1",
			idempotencyKey: "schedule:capture_goal_checkpoint_1",
			expectedHead: { sequence: 0, hash: null },
		});
		const eventsPath = join(projectRoot, ".pi-xk", "memory", "events.jsonl");
		await appendFile(eventsPath, '{"schema":"pi-xk.memory-event.v1"');
		const replay = await store.replay();
		expect(replay.tailDiagnostic?.discardedBytes).toBeGreaterThan(0);
		await expect(
			store.markGenerationStarted(source().captureId, 1, {
				eventId: "evt_generation_1",
				idempotencyKey: "generation:capture_goal_checkpoint_1:1",
				expectedHead: replay.head,
			}),
		).rejects.toBeInstanceOf(MemoryRecoveryRequiredError);
		expect((await store.repairTrailingPartialEvent()).tailDiagnostic).toBeUndefined();
	});

	it("detects and explicitly repairs an abandoned write lock", async () => {
		const { projectRoot, store } = await createStore();
		await mkdir(join(projectRoot, ".pi-xk", "memory"), { recursive: true });
		await writeFile(
			join(projectRoot, ".pi-xk", "memory", ".write.lock"),
			`${JSON.stringify({ pid: 999_999_999, nonce: "abandoned-memory", createdAt: "2026-08-01T00:00:00.000Z" })}\n`,
		);
		await expect(
			store.scheduleCapture(source(), {
				eventId: "evt_schedule_locked",
				idempotencyKey: "schedule:locked",
				expectedHead: { sequence: 0, hash: null },
			}),
		).rejects.toBeInstanceOf(MemoryLockedError);
		expect(await store.inspectWriteLock()).toMatchObject({ nonce: "abandoned-memory", ownerState: "missing" });
		await expect(store.repairAbandonedWriteLock("abandoned-memory")).resolves.toBe(true);
	});

	it("publishes canonical revisions, cues, and edges through one atomic event", async () => {
		const { projectRoot, store } = await createStore();
		const scheduled = await store.scheduleCapture(source(), {
			eventId: "evt_schedule_1",
			idempotencyKey: "schedule:capture_goal_checkpoint_1",
			expectedHead: { sequence: 0, hash: null },
		});
		const generating = await store.markGenerationStarted(source().captureId, 1, {
			eventId: "evt_generation_1",
			idempotencyKey: "generation:capture_goal_checkpoint_1:1",
			expectedHead: scheduled.head,
		});
		const evidenceArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "text/plain",
			text: "verified checkpoint evidence",
			producer: "pi-xk.memory-explicit.v1",
			sensitivity: "internal",
			sourceIds: ["command_memory_store_fixture"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const generated = proposal(generating.head);
		const evidenceOperation = generated.operations.find((operation) => operation.kind === "publish_revision");
		if (!evidenceOperation || evidenceOperation.kind !== "publish_revision")
			throw new Error("missing revision fixture");
		evidenceOperation.revision.evidenceRefs[0] = {
			...evidenceOperation.revision.evidenceRefs[0],
			artifactId: evidenceArtifact.artifactId,
			sourceDigest: evidenceArtifact.artifactId,
		};
		const edgeOperation = generated.operations.find((operation) => operation.kind === "publish_edge");
		if (!edgeOperation || edgeOperation.kind !== "publish_edge") throw new Error("missing edge fixture");
		edgeOperation.edge.evidenceRefs[0] = {
			...edgeOperation.edge.evidenceRefs[0],
			artifactId: evidenceArtifact.artifactId,
			sourceDigest: evidenceArtifact.artifactId,
		};
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: { schema: "pi-xk.memory-generator-result.v1", proposal: generated },
			producer: "pi-xk.memory-capture.v1",
			sensitivity: "internal",
			sourceIds: [source().captureId],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		const recorded = await store.recordProposal(generated, resultArtifact.artifactId, {
			eventId: "evt_proposal_1",
			idempotencyKey: "proposal:proposal_goal_checkpoint_1",
			expectedHead: generating.head,
		});
		const applied = await store.applyProposal(recorded.proposalArtifactId, {
			eventId: "evt_apply_1",
			idempotencyKey: "apply:proposal_goal_checkpoint_1",
			expectedHead: recorded.write.head,
		});

		expect(applied.write.event.eventType).toBe("memory_change_applied");
		expect(applied.write.event.payload.revisions).toHaveLength(1);
		expect(applied.write.event.payload.cues).toHaveLength(1);
		expect(applied.write.event.payload.edges).toHaveLength(1);
		const read = await store.readMemory("memory_canonical_summary");
		expect(read.revision.statement).toBe("Use token=[REDACTED] as a fixture.");
		expect(read.state).toEqual({ trust: "model_inferred", freshness: "unknown", lifecycle: "active" });
		expect((await store.replay()).captures.get(source().captureId)?.status).toBe("applied");

		let head = applied.write.head;
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "Prepare outbound-edge purge.", {
				eventId: "evt_outbound_edge_lifecycle",
				idempotencyKey: "lifecycle:outbound-edge:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detach before outbound-edge purge.",
				{
					eventId: "evt_outbound_edge_detach",
					idempotencyKey: "detach:outbound-edge:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		await expect(
			store.purgeMemory("memory_canonical_summary", 3, "Purge owns its outbound graph edge.", {
				eventId: "evt_outbound_edge_purge",
				idempotencyKey: "purge:outbound-edge:3",
				expectedHead: head,
				confirmed: true,
			}),
		).resolves.toBeDefined();
		expect((await store.inspectDeep()).orphanArtifactIds).toEqual([]);
	});

	it("rejects stale proposal bases and revision conflicts before publishing artifacts", async () => {
		const { projectRoot, store } = await createStore();
		const scheduled = await store.scheduleCapture(source(), {
			eventId: "evt_schedule_1",
			idempotencyKey: "schedule:capture_goal_checkpoint_1",
			expectedHead: { sequence: 0, hash: null },
		});
		const generated = proposal({ sequence: 0, hash: null });
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "text/plain",
			text: "generator output",
			producer: "pi-xk.memory-capture.v1",
			sensitivity: "internal",
			sourceIds: [source().captureId],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		await expect(
			store.recordProposal(generated, resultArtifact.artifactId, {
				eventId: "evt_proposal_stale",
				idempotencyKey: "proposal:stale",
				expectedHead: scheduled.head,
			}),
		).rejects.toBeInstanceOf(MemoryHeadConflictError);
		await expect(store.readMemory("memory_missing")).rejects.toBeInstanceOf(MemoryNotFoundError);
	});

	it("requires user confirmation before revising an existing inferred Memory", async () => {
		const { projectRoot, store } = await createStore();
		const head = await publishMemoryWithoutEdges(projectRoot, store);
		const current = await store.readMemory("memory_canonical_summary");
		if (current.revision.schema !== "pi-xk.memory-revision.v1") throw new Error("missing V1 Memory fixture");
		const revisionProposal: MemoryChangeProposalV1 = {
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: "proposal_existing_inferred_revision",
			captureId: null,
			sourceDigest: `sha256:${"c".repeat(64)}`,
			expectedEventHead: head,
			expectedRevisions: [{ memoryId: current.revision.memoryId, revision: current.revision.revision }],
			reason: "New evidence proposes a different inferred statement.",
			operations: [
				{
					kind: "publish_revision",
					revision: {
						...current.revision,
						revision: 2,
						statement: "Use a revised inferred statement only after user confirmation.",
						sourceDigest: `sha256:${"c".repeat(64)}`,
						supersedesRevision: 1,
						provenance: {
							producer: "model",
							model: "faux/model",
							promptVersion: "pi-xk.memory-model-proposal.v1",
							recordedAt: "2026-08-01T00:02:00.000Z",
						},
					},
				},
			],
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.memory-model-proposal.v1",
				recordedAt: "2026-08-01T00:02:00.000Z",
			},
		};
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: revisionProposal,
			producer: "pi-xk.memory-model-proposal.v1",
			sensitivity: "internal",
			sourceIds: [revisionProposal.proposalId],
			createdAt: revisionProposal.provenance.recordedAt,
		});
		const recorded = await store.recordProposal(revisionProposal, resultArtifact.artifactId, {
			eventId: "evt_proposal_existing_inferred_revision",
			idempotencyKey: "memory:proposal:existing-inferred-revision",
			expectedHead: head,
		});

		expect(recorded.write.event.payload.confirmationRequired).toBe(true);
		await expect(
			store.applyProposal(recorded.proposalArtifactId, {
				eventId: "evt_apply_existing_inferred_revision",
				idempotencyKey: "memory:apply:existing-inferred-revision",
				expectedHead: recorded.write.head,
			}),
		).rejects.toBeInstanceOf(MemoryValidationError);
	});

	it("applies confirmed lifecycle, evidence detach, and purge proposal operations atomically", async () => {
		const { projectRoot, store } = await createStore();
		const head = await publishMemoryWithoutEdges(projectRoot, store);
		const current = await store.readMemory("memory_canonical_summary");
		if (current.revision.schema !== "pi-xk.memory-revision.v1") throw new Error("missing V1 Memory fixture");
		const destructiveProposal: MemoryChangeProposalV1 = {
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: "proposal_confirmed_destructive_change",
			captureId: null,
			sourceDigest: `sha256:${"e".repeat(64)}`,
			expectedEventHead: head,
			expectedRevisions: [{ memoryId: current.revision.memoryId, revision: current.revision.revision }],
			reason: "Archive, detach the retained source, and purge the Memory after explicit confirmation.",
			operations: [
				{
					kind: "change_lifecycle",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					lifecycle: "archived",
					reason: "The user requested archival before purge.",
				},
				{
					kind: "detach_evidence",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					evidenceId: "evidence_goal_checkpoint",
					reason: "The user confirmed evidence detachment.",
				},
				{
					kind: "purge_memory",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					reason: "The user confirmed permanent removal.",
				},
			],
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.memory-model-proposal.v1",
				recordedAt: "2026-08-01T00:03:00.000Z",
			},
		};
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: destructiveProposal,
			producer: "pi-xk.memory-model-proposal.v1",
			sensitivity: "internal",
			sourceIds: [destructiveProposal.proposalId],
			createdAt: destructiveProposal.provenance.recordedAt,
		});
		const recorded = await store.recordProposal(destructiveProposal, resultArtifact.artifactId, {
			eventId: "evt_proposal_confirmed_destructive_change",
			idempotencyKey: "memory:proposal:confirmed-destructive-change",
			expectedHead: head,
		});
		const memoryDirectory = join(projectRoot, ".pi-xk", "memory");
		const readModelPath = join(memoryDirectory, "memory-read-model.json");
		const checkpointPath = join(memoryDirectory, "memory-read-model.checkpoint.json");
		const beforeApplyReadModel = await readFile(readModelPath, "utf8");
		const beforeApplyCheckpoint = await readFile(checkpointPath, "utf8");

		expect(recorded.write.event.payload.confirmationRequired).toBe(true);
		const applied = await store.applyProposal(recorded.proposalArtifactId, {
			eventId: "evt_apply_confirmed_destructive_change",
			idempotencyKey: "memory:apply:confirmed-destructive-change",
			expectedHead: recorded.write.head,
			actor: "user",
			timestamp: "2026-08-01T00:04:00.000Z",
			confirmed: true,
		});

		expect(applied.write.event.eventType).toBe("memory_change_applied");
		expect(applied.write.event.payload.purges).toEqual([
			expect.objectContaining({ memoryId: "memory_canonical_summary" }),
		]);
		await writeFile(readModelPath, beforeApplyReadModel);
		await writeFile(checkpointPath, beforeApplyCheckpoint);
		const tailRecovered = await store.loadReadModelSnapshot();
		expect(tailRecovered.diagnostic.mode).toBe("tail");
		expect(tailRecovered.readModel).toEqual(await store.rebuildReadModel());
		await expect(store.readMemory("memory_canonical_summary")).rejects.toBeInstanceOf(MemoryNotFoundError);
		expect(
			(await store.replay()).events.some(
				(event) =>
					event.eventType === "memory_change_applied" &&
					event.payload.proposalId === destructiveProposal.proposalId,
			),
		).toBe(true);
	});

	it("requires explicit lifecycle, evidence detach, and purge preconditions", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		await expect(
			store.changeMemoryLifecycle("memory_canonical_summary", 1, "invalidated", "Evidence was withdrawn.", {
				eventId: "evt_lifecycle_unconfirmed",
				idempotencyKey: "lifecycle:memory_canonical_summary:2",
				expectedHead: head,
			}),
		).rejects.toBeInstanceOf(MemoryValidationError);
		const invalidated = await store.changeMemoryLifecycle(
			"memory_canonical_summary",
			1,
			"invalidated",
			"Evidence was withdrawn.",
			{
				eventId: "evt_lifecycle_1",
				idempotencyKey: "lifecycle:memory_canonical_summary:2",
				expectedHead: head,
				confirmed: true,
			},
		);
		head = invalidated.head;
		const detached = await store.detachMemoryEvidence(
			"memory_canonical_summary",
			2,
			"evidence_goal_checkpoint",
			"The source is no longer retained.",
			{
				eventId: "evt_detach_1",
				idempotencyKey: "detach:memory_canonical_summary:3:evidence_goal_checkpoint",
				expectedHead: head,
				confirmed: true,
			},
		);
		head = detached.head;
		expect((await store.readMemory("memory_canonical_summary")).revision.evidenceRefs).toEqual([]);
		await mkdir(join(projectRoot, ".pi-xk", "memory"), { recursive: true });
		await writeFile(
			join(projectRoot, ".pi-xk", "memory", "index.sqlite-wal"),
			`derived ${String((await store.replay()).memories.get("memory_canonical_summary")?.artifactId)}`,
		);
		const purged = await store.purgeMemory("memory_canonical_summary", 3, "User requested permanent removal.", {
			eventId: "evt_purge_1",
			idempotencyKey: "purge:memory_canonical_summary:3",
			expectedHead: head,
			confirmed: true,
		});
		await expect(store.readMemory("memory_canonical_summary")).rejects.toBeInstanceOf(MemoryNotFoundError);
		expect(purged.cleanupDiagnostics).toEqual([]);
		for (const artifactId of purged.write.event.payload.revisionArtifactIds) {
			await expect(new ArtifactStore(projectRoot).read(artifactId)).rejects.toBeInstanceOf(ArtifactNotFoundError);
		}

		await expect(
			store.scheduleCapture(
				{ ...source(), captureId: "capture_goal_checkpoint_after_purge" },
				{
					eventId: "evt_schedule_after_purge",
					idempotencyKey: "schedule:after-purge",
					expectedHead: purged.write.head,
				},
			),
		).rejects.toBeInstanceOf(MemoryValidationError);
		expect((await store.replay()).head).toEqual(purged.write.head);
	});

	it("rejects an edge published for a Memory purged by the same proposal", async () => {
		const { projectRoot, store } = await createStore();
		const head = await publishMemoryWithoutEdges(projectRoot, store);
		const current = await store.readMemory("memory_canonical_summary");
		if (current.revision.schema !== "pi-xk.memory-revision.v1") throw new Error("missing V1 Memory fixture");
		const sourceDigest = `sha256:${"e".repeat(64)}`;
		const provenance = {
			producer: "model" as const,
			model: "faux/model",
			promptVersion: "pi-xk.memory-model-proposal.v1",
			recordedAt: "2026-08-01T00:03:00.000Z",
		};
		const conflicting: MemoryChangeProposalV1 = {
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: "proposal_edge_for_purged_memory",
			captureId: null,
			sourceDigest,
			expectedEventHead: head,
			expectedRevisions: [{ memoryId: current.revision.memoryId, revision: current.revision.revision }],
			reason: "Exercise the atomic graph and purge invariant.",
			operations: [
				{
					kind: "publish_cue",
					cue: {
						schema: "pi-xk.memory-cue.v1",
						cueId: "cue_purge_conflict",
						revision: 1,
						kind: "topic",
						key: "purge-conflict",
						label: "Purge conflict",
						aliases: [],
						scope: {
							projectId: "project_pi_xk",
							goalId: null,
							chainId: null,
							branchId: null,
							paths: [],
						},
						sourceDigest,
						provenance,
					},
				},
				{
					kind: "publish_edge",
					edge: {
						schema: "pi-xk.memory-edge.v1",
						edgeId: "edge_purge_conflict",
						from: { kind: "memory", id: current.revision.memoryId },
						to: { kind: "cue", id: "cue_purge_conflict" },
						relation: "related_to",
						effectiveFrom: provenance.recordedAt,
						effectiveTo: null,
						evidenceRefs: current.revision.evidenceRefs,
						sourceDigest,
						provenance,
					},
				},
				{
					kind: "change_lifecycle",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					lifecycle: "archived",
					reason: "Prepare the Memory for purge.",
				},
				{
					kind: "detach_evidence",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					evidenceId: current.revision.evidenceRefs[0]!.evidenceId,
					reason: "Detach evidence before purge.",
				},
				{
					kind: "purge_memory",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					reason: "Purge the Memory.",
				},
			],
			provenance,
		};
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: conflicting,
			producer: "pi-xk.memory-model-proposal.v1",
			sensitivity: "internal",
			sourceIds: [conflicting.proposalId],
			createdAt: provenance.recordedAt,
		});
		const recorded = await store.recordProposal(conflicting, resultArtifact.artifactId, {
			eventId: "evt_proposal_edge_for_purged_memory",
			idempotencyKey: "memory:proposal:edge-for-purged-memory",
			expectedHead: head,
		});
		await expect(
			store.applyProposal(recorded.proposalArtifactId, {
				eventId: "evt_apply_edge_for_purged_memory",
				idempotencyKey: "memory:apply:edge-for-purged-memory",
				expectedHead: recorded.write.head,
				actor: "user",
				timestamp: "2026-08-01T00:04:00.000Z",
				confirmed: true,
			}),
		).rejects.toThrow(/cannot publish edge .* purged Memory/i);
		expect((await store.replay()).head).toEqual(recorded.write.head);
	});

	it("retains evidence shared by another Memory during direct purge", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const shared = await publishMemorySharingEvidence(projectRoot, store, head);
		head = shared.head;
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "Archived before purge.", {
				eventId: "evt_shared_memory_lifecycle",
				idempotencyKey: "lifecycle:shared-memory:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detached from only the Memory being purged.",
				{
					eventId: "evt_shared_memory_detach",
					idempotencyKey: "detach:shared-memory:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;

		const purged = await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_shared_memory_purge",
			idempotencyKey: "purge:shared-memory:3",
			expectedHead: head,
			confirmed: true,
		});

		expect(purged.retainedArtifactIds).toContain(shared.evidenceArtifactId);
		await expect(new ArtifactStore(projectRoot).read(shared.evidenceArtifactId)).resolves.toBeDefined();
		await expect(store.readMemory("memory_shared_evidence")).resolves.toMatchObject({
			revision: {
				evidenceRefs: [expect.objectContaining({ artifactId: shared.evidenceArtifactId })],
			},
		});
	});

	it("deletes exclusive proposal and model-result content after a direct purge", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const proposalEvent = (await store.replay()).events.find(
			(event) =>
				event.eventType === "proposal_recorded" && event.payload.proposalId === "proposal_goal_checkpoint_1",
		);
		if (!proposalEvent || proposalEvent.eventType !== "proposal_recorded") {
			throw new Error("missing proposal content fixture");
		}
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "Archived before purge.", {
				eventId: "evt_content_cleanup_lifecycle",
				idempotencyKey: "lifecycle:content-cleanup:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detach evidence before deleting exclusive content.",
				{
					eventId: "evt_content_cleanup_detach",
					idempotencyKey: "detach:content-cleanup:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;

		const purged = await store.purgeMemory("memory_canonical_summary", 3, "Delete exclusive Memory content.", {
			eventId: "evt_content_cleanup_purge",
			idempotencyKey: "purge:content-cleanup:3",
			expectedHead: head,
			confirmed: true,
		});

		expect(purged.removedArtifactIds).toEqual(
			expect.arrayContaining([proposalEvent.payload.proposalArtifactId, proposalEvent.payload.resultArtifactId]),
		);
		await expect(
			new ArtifactStore(projectRoot).read(proposalEvent.payload.proposalArtifactId),
		).rejects.toBeInstanceOf(ArtifactNotFoundError);
		await expect(new ArtifactStore(projectRoot).read(proposalEvent.payload.resultArtifactId)).rejects.toBeInstanceOf(
			ArtifactNotFoundError,
		);
		await expect(store.inspectDeep()).resolves.toMatchObject({ purgedArtifactIdsPresent: [] });
	});

	it("retains evidence shared by another Memory during proposal purge", async () => {
		const { projectRoot, store } = await createStore();
		const initialHead = await publishMemoryWithoutEdges(projectRoot, store);
		const shared = await publishMemorySharingEvidence(projectRoot, store, initialHead);
		const current = await store.readMemory("memory_canonical_summary");
		const destructiveProposal: MemoryChangeProposalV1 = {
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: "proposal_purge_with_shared_evidence",
			captureId: null,
			sourceDigest: `sha256:${"e".repeat(64)}`,
			expectedEventHead: shared.head,
			expectedRevisions: [{ memoryId: current.revision.memoryId, revision: current.revision.revision }],
			reason: "Purge one Memory without deleting evidence retained by another Memory.",
			operations: [
				{
					kind: "change_lifecycle",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					lifecycle: "archived",
					reason: "Archive before purge.",
				},
				{
					kind: "detach_evidence",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					evidenceId: "evidence_goal_checkpoint",
					reason: "Detach only from the Memory being purged.",
				},
				{
					kind: "purge_memory",
					memoryId: current.revision.memoryId,
					expectedRevision: current.revision.revision,
					reason: "Permanent removal was confirmed.",
				},
			],
			provenance: {
				producer: "model",
				model: "faux/model",
				promptVersion: "pi-xk.memory-model-proposal.v1",
				recordedAt: "2026-08-01T00:03:00.000Z",
			},
		};
		const resultArtifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: destructiveProposal,
			producer: "pi-xk.memory-model-proposal.v1",
			sensitivity: "internal",
			sourceIds: [destructiveProposal.proposalId],
			createdAt: destructiveProposal.provenance.recordedAt,
		});
		const recorded = await store.recordProposal(destructiveProposal, resultArtifact.artifactId, {
			eventId: "evt_proposal_purge_with_shared_evidence",
			idempotencyKey: "memory:proposal:purge-with-shared-evidence",
			expectedHead: shared.head,
		});
		await store.applyProposal(recorded.proposalArtifactId, {
			eventId: "evt_apply_purge_with_shared_evidence",
			idempotencyKey: "memory:apply:purge-with-shared-evidence",
			expectedHead: recorded.write.head,
			actor: "user",
			confirmed: true,
			timestamp: "2026-08-01T00:04:00.000Z",
		});

		await expect(new ArtifactStore(projectRoot).read(shared.evidenceArtifactId)).resolves.toBeDefined();
		await expect(store.readMemory("memory_shared_evidence")).resolves.toMatchObject({
			revision: {
				evidenceRefs: [expect.objectContaining({ artifactId: shared.evidenceArtifactId })],
			},
		});
	});

	it("retains a purged revision artifact that another project domain still references", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		head = (
			await store.changeMemoryLifecycle(
				"memory_canonical_summary",
				1,
				"archived",
				"Archived before explicit purge.",
				{
					eventId: "evt_shared_lifecycle",
					idempotencyKey: "lifecycle:shared:2",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detached before explicit purge.",
				{
					eventId: "evt_shared_detach",
					idempotencyKey: "detach:shared:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		const revisionArtifactId = (await store.replay()).memories.get("memory_canonical_summary")?.artifactId;
		if (!revisionArtifactId) throw new Error("missing revision artifact fixture");
		const taskDirectory = join(projectRoot, ".pi-xk", "tasks", "task_external_reference");
		await mkdir(taskDirectory, { recursive: true });
		await writeFile(join(taskDirectory, "result.json"), `${JSON.stringify({ artifactId: revisionArtifactId })}\n`);

		await store.purgeMemory("memory_canonical_summary", 3, "User requested permanent removal.", {
			eventId: "evt_shared_purge",
			idempotencyKey: "purge:shared:3",
			expectedHead: head,
			confirmed: true,
		});
		await expect(new ArtifactStore(projectRoot).read(revisionArtifactId)).resolves.toMatchObject({
			metadata: { artifactId: revisionArtifactId },
		});
		expect((await store.inspectDeep()).purgedArtifactIdsPresent).not.toContain(revisionArtifactId);
	});

	it("retains artifacts referenced by another domain artifact", async () => {
		const { projectRoot, store } = await createStore();
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "archived", "Archived before purge.", {
				eventId: "evt_artifact_ref_lifecycle",
				idempotencyKey: "lifecycle:artifact-ref:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detached before purge.",
				{
					eventId: "evt_artifact_ref_detach",
					idempotencyKey: "detach:artifact-ref:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;
		const revisionArtifactId = (await store.replay()).memories.get("memory_canonical_summary")?.artifactId;
		if (!revisionArtifactId) throw new Error("missing revision artifact fixture");
		await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: { referencedArtifactId: revisionArtifactId },
			producer: "pi-xk.task-result.v1",
			sensitivity: "internal",
			sourceIds: ["task_external_reference", revisionArtifactId],
			createdAt: "2026-08-01T00:20:00.000Z",
		});

		const purged = await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_artifact_ref_purge",
			idempotencyKey: "purge:artifact-ref:3",
			expectedHead: head,
			confirmed: true,
		});
		expect(purged.retainedArtifactIds).toContain(revisionArtifactId);
		await expect(new ArtifactStore(projectRoot).read(revisionArtifactId)).resolves.toBeDefined();
	});

	it("reports cleanup failure after committing the purge tombstone", async () => {
		const projectRoot = join(tmpdir(), `pi-xk-memory-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(projectRoot, { recursive: true });
		tempDirs.push(projectRoot);
		class FailingCleanupArtifactStore extends ArtifactStore {
			override async remove(): Promise<boolean> {
				throw Object.assign(new Error("simulated artifact cleanup failure"), { code: "EIO" });
			}
		}
		const artifacts = new FailingCleanupArtifactStore(projectRoot);
		const store = new MemoryStore(projectRoot, { artifactStore: artifacts });
		let head = await publishMemoryWithoutEdges(projectRoot, store);
		const evidenceArtifactId = (await store.readMemory("memory_canonical_summary")).revision.evidenceRefs[0]
			?.artifactId;
		if (!evidenceArtifactId) throw new Error("missing cleanup evidence fixture");
		head = (
			await store.changeMemoryLifecycle("memory_canonical_summary", 1, "invalidated", "Invalidated before purge.", {
				eventId: "evt_cleanup_lifecycle",
				idempotencyKey: "lifecycle:cleanup:2",
				expectedHead: head,
				confirmed: true,
			})
		).head;
		head = (
			await store.detachMemoryEvidence(
				"memory_canonical_summary",
				2,
				"evidence_goal_checkpoint",
				"Detached before purge.",
				{
					eventId: "evt_cleanup_detach",
					idempotencyKey: "detach:cleanup:3",
					expectedHead: head,
					confirmed: true,
				},
			)
		).head;

		const purged = await store.purgeMemory("memory_canonical_summary", 3, "Explicit purge.", {
			eventId: "evt_cleanup_purge",
			idempotencyKey: "purge:cleanup:3",
			expectedHead: head,
			confirmed: true,
		});
		expect(purged.write.event.eventType).toBe("memory_purged");
		expect(purged.cleanupDiagnostics).not.toEqual([]);
		expect(purged.cleanupDiagnostics.every((entry) => entry.errorCode === "EIO")).toBe(true);
		await expect(store.readMemory("memory_canonical_summary")).rejects.toBeInstanceOf(MemoryNotFoundError);
		expect((await store.replay()).head).toEqual(purged.write.head);
		expect((await store.inspectDeep()).purgedArtifactIdsPresent).toContain(evidenceArtifactId);
	});
});
