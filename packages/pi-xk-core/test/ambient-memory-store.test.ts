import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EvidenceRefV2,
	MemoryCorruptionError,
	MemoryIdempotencyConflictError,
	type MemoryReconstructionTraceV1,
	type MemoryReviewDecisionV1,
	MemoryRevisionConflictError,
	MemoryService,
	stableJsonStringify,
} from "../src/index.ts";

const tempDirs: string[] = [];

async function createService(): Promise<{ projectRoot: string; service: MemoryService }> {
	const projectRoot = join(tmpdir(), `pi-xk-ambient-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { projectRoot, service: new MemoryService(projectRoot) };
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function trace(
	runId: string,
	readRevisions: Array<{ memoryId: string; revision: number }>,
	evidenceIds: string[],
	outcome: MemoryReconstructionTraceV1["outcome"] = "succeeded",
): MemoryReconstructionTraceV1 {
	return {
		schema: "pi-xk.memory-reconstruction-trace.v1",
		runId,
		sessionId: "session_ambient_1",
		startedAt: "2026-08-03T01:00:00.000Z",
		settledAt: "2026-08-03T01:00:01.000Z",
		queryDigests: [digest("ambient query")],
		candidateIds: readRevisions.map((entry) => entry.memoryId),
		readRevisions,
		evidenceIds,
		decisions: [`review_${runId}`],
		budgetUsage: {
			totalKnowledgeActions: 2,
			memoryActions: 2,
			memorySearchCalls: 1,
			uniqueMemoryReads: readRevisions.length,
			evidenceReads: evidenceIds.length,
			skillCandidateActions: 0,
		},
		stopReason: outcome === "succeeded" ? "sufficient" : "run_failed",
		outcome,
	};
}

function reviseDecision(
	runId: string,
	memoryId: string,
	expectedRevision: number,
	evidenceIds: string[],
): MemoryReviewDecisionV1 {
	return {
		schema: "pi-xk.memory-review-decision.v1",
		decisionId: `review_${runId}`,
		runId,
		action: "revise",
		sourceMemories: [{ memoryId, expectedRevision }],
		replacement: {
			kind: "decision",
			title: "Publish ambient changes at settled",
			statement: "Ambient Memory revisions publish only after a successful settled run.",
			applicability: "Pi-XK model-led Memory evolution.",
			effectiveFrom: "2026-08-03T01:00:01.000Z",
			cueIds: [],
		},
		evidenceIds,
		reason: "The settled boundary was verified in the current run.",
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.memory-review-v1",
			recordedAt: "2026-08-03T01:00:01.000Z",
		},
	};
}

function semanticDecision(
	runId: string,
	action: "supersede" | "dispute",
	sources: Array<{ memoryId: string; expectedRevision: number }>,
	evidenceIds: string[],
): MemoryReviewDecisionV1 {
	return {
		schema: "pi-xk.memory-review-decision.v1",
		decisionId: `review_${runId}`,
		runId,
		action,
		sourceMemories: sources,
		replacement: {
			kind: action === "dispute" ? "open_question" : "decision",
			title: action === "dispute" ? "Conflicting publication boundary evidence" : "Unified publication boundary",
			statement:
				action === "dispute"
					? "Available evidence conflicts about whether semantic publication can precede settlement."
					: "Memory and Skill semantic changes publish at the successful settled boundary.",
			applicability: "Pi-XK ambient knowledge evolution.",
			effectiveFrom: "2026-08-03T01:00:01.000Z",
			cueIds: [],
		},
		evidenceIds,
		reason:
			action === "dispute"
				? "Current evidence contradicts the previously read Memory."
				: "The two read Memories describe one publication rule and should be replaced together.",
		provenance: {
			producer: "model",
			model: "faux/model",
			promptVersion: "pi-xk.memory-review-v1",
			recordedAt: "2026-08-03T01:00:01.000Z",
		},
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("Ambient Memory store", () => {
	it("records a body-free reconstruction trace and replays mixed v1/v2 events", async () => {
		const { projectRoot, service } = await createService();
		const remembered = await service.remember("Use a settled boundary for semantic publication.", {
			commandId: "command_ambient_fixture",
			recordedAt: "2026-08-03T00:59:00.000Z",
			kind: "decision",
		});
		const evidenceIds = remembered.revision.evidenceRefs.map((entry) => entry.evidenceId);
		const store = service.getStore();
		const before = await store.replay();
		const recorded = await store.recordReconstruction(
			trace("run_ambient_1", [{ memoryId: remembered.revision.memoryId, revision: 1 }], evidenceIds),
			{
				eventId: "evt_reconstruction_ambient_1",
				idempotencyKey: "memory:reconstruction:run_ambient_1",
				expectedHead: before.head,
				actor: "runtime",
				timestamp: "2026-08-03T01:00:01.000Z",
			},
		);

		expect(recorded.write.event.schema).toBe("pi-xk.memory-event.v2");
		expect(recorded.traceArtifactId).toMatch(/^sha256:/);
		const raw = await readFile(join(projectRoot, ".pi-xk", "memory", "events.jsonl"), "utf8");
		expect(raw).not.toContain("Use a settled boundary");
		expect(raw).not.toContain("ambient query");
		const replay = await store.replay();
		expect(replay.events.some((event) => event.schema === "pi-xk.memory-event.v1")).toBe(true);
		expect(replay.events.at(-1)).toMatchObject({
			schema: "pi-xk.memory-event.v2",
			eventType: "reconstruction_recorded",
			payload: { runId: "run_ambient_1", outcome: "succeeded" },
		});
	});

	it("publishes a V2 revision from a reviewed V1 Memory and preserves both timeline entries", async () => {
		const { service } = await createService();
		const remembered = await service.remember("The first revision is a V1 explicit Memory.", {
			commandId: "command_ambient_revision",
			recordedAt: "2026-08-03T00:59:00.000Z",
			kind: "decision",
		});
		const store = service.getStore();
		const evidenceRefs: EvidenceRefV2[] = remembered.revision.evidenceRefs;
		const evidenceIds = evidenceRefs.map((entry) => entry.evidenceId);
		const runTrace = trace(
			"run_ambient_revision",
			[{ memoryId: remembered.revision.memoryId, revision: 1 }],
			evidenceIds,
		);
		const recorded = await store.recordReconstruction(runTrace, {
			eventId: "evt_reconstruction_revision",
			idempotencyKey: "memory:reconstruction:run_ambient_revision",
			expectedHead: (await store.replay()).head,
			timestamp: runTrace.settledAt,
		});
		const applied = await store.applyMemoryReviews(
			[reviseDecision(runTrace.runId, remembered.revision.memoryId, 1, evidenceIds)],
			evidenceRefs,
			recorded.traceArtifactId,
			{
				eventId: "evt_review_revision",
				idempotencyKey: "memory:review:run_ambient_revision",
				expectedHead: recorded.write.head,
				actor: "model",
				timestamp: runTrace.settledAt,
			},
		);

		expect(applied.revisions).toHaveLength(1);
		expect(applied.revisions[0]).toMatchObject({
			schema: "pi-xk.memory-revision.v2",
			memoryId: remembered.revision.memoryId,
			revision: 2,
			trust: "model_inferred",
			transition: { mode: "revise", trustDerivation: "model-reconstruction" },
		});
		const current = await store.readMemory(remembered.revision.memoryId);
		expect(current.revision.schema).toBe("pi-xk.memory-revision.v2");
		const timeline = await store.readMemoryTimeline(remembered.revision.memoryId);
		expect(timeline.map((entry) => entry.revision.schema)).toEqual([
			"pi-xk.memory-revision.v1",
			"pi-xk.memory-revision.v2",
		]);
	});

	it("atomically supersedes multiple read Memories and retains their revision histories", async () => {
		const { service } = await createService();
		const first = await service.remember("Memory changes publish after a successful settled run.", {
			commandId: "command_ambient_supersede_first",
			recordedAt: "2026-08-03T00:58:00.000Z",
			kind: "decision",
		});
		const second = await service.remember("Skill changes publish only at the settled boundary.", {
			commandId: "command_ambient_supersede_second",
			recordedAt: "2026-08-03T00:59:00.000Z",
			kind: "decision",
		});
		const store = service.getStore();
		const sources = [first, second].map((entry) => ({ memoryId: entry.revision.memoryId, expectedRevision: 1 }));
		const evidenceRefs: EvidenceRefV2[] = [...first.revision.evidenceRefs, ...second.revision.evidenceRefs];
		const evidenceIds = evidenceRefs.map((entry) => entry.evidenceId);
		const runTrace = trace(
			"run_ambient_supersede",
			sources.map((source) => ({ memoryId: source.memoryId, revision: source.expectedRevision })),
			evidenceIds,
		);
		const recorded = await store.recordReconstruction(runTrace, {
			eventId: "evt_reconstruction_supersede",
			idempotencyKey: "memory:reconstruction:run_ambient_supersede",
			expectedHead: (await store.replay()).head,
			timestamp: runTrace.settledAt,
		});
		const applied = await store.applyMemoryReviews(
			[semanticDecision(runTrace.runId, "supersede", sources, evidenceIds)],
			evidenceRefs,
			recorded.traceArtifactId,
			{
				eventId: "evt_review_supersede",
				idempotencyKey: "memory:review:run_ambient_supersede",
				expectedHead: recorded.write.head,
				timestamp: runTrace.settledAt,
			},
		);

		const replacement = applied.revisions.find((revision) => revision.lifecycle === "active");
		const sourceRevisions = sources.map((source) => ({
			memoryId: source.memoryId,
			revision: source.expectedRevision,
		}));
		expect(replacement).toMatchObject({
			schema: "pi-xk.memory-revision.v2",
			revision: 1,
			transition: { mode: "supersede", sourceRevisions },
		});
		expect(applied.revisions.filter((revision) => revision.lifecycle === "superseded")).toHaveLength(2);
		expect(applied.edges).toHaveLength(2);
		expect(applied.edges.every((edge) => edge.relation === "supersedes")).toBe(true);
		for (const source of sources) {
			expect((await store.readMemory(source.memoryId)).revision.lifecycle).toBe("superseded");
			expect((await store.readMemoryTimeline(source.memoryId)).map((entry) => entry.revision.revision)).toEqual([
				1, 2,
			]);
		}
		if (!replacement) throw new Error("missing superseding Memory fixture");
		expect((await store.readMemory(replacement.memoryId)).revision.lifecycle).toBe("active");
	});

	it("publishes disputed evidence as a new Memory linked by a contradicts edge", async () => {
		const { service } = await createService();
		const original = await service.remember("Semantic publication may happen before agent settlement.", {
			commandId: "command_ambient_dispute",
			recordedAt: "2026-08-03T00:59:00.000Z",
			kind: "decision",
		});
		const store = service.getStore();
		const sources = [{ memoryId: original.revision.memoryId, expectedRevision: 1 }];
		const evidenceRefs: EvidenceRefV2[] = original.revision.evidenceRefs;
		const evidenceIds = evidenceRefs.map((entry) => entry.evidenceId);
		const runTrace = trace(
			"run_ambient_dispute",
			sources.map((source) => ({ memoryId: source.memoryId, revision: source.expectedRevision })),
			evidenceIds,
		);
		const recorded = await store.recordReconstruction(runTrace, {
			eventId: "evt_reconstruction_dispute",
			idempotencyKey: "memory:reconstruction:run_ambient_dispute",
			expectedHead: (await store.replay()).head,
			timestamp: runTrace.settledAt,
		});
		const applied = await store.applyMemoryReviews(
			[semanticDecision(runTrace.runId, "dispute", sources, evidenceIds)],
			evidenceRefs,
			recorded.traceArtifactId,
			{
				eventId: "evt_review_dispute",
				idempotencyKey: "memory:review:run_ambient_dispute",
				expectedHead: recorded.write.head,
				timestamp: runTrace.settledAt,
			},
		);

		expect(applied.revisions).toHaveLength(1);
		expect(applied.revisions[0]).toMatchObject({
			revision: 1,
			trust: "disputed",
			lifecycle: "active",
			transition: {
				mode: "dispute",
				trustDerivation: "conflict-detected",
				sourceRevisions: sources.map((source) => ({
					memoryId: source.memoryId,
					revision: source.expectedRevision,
				})),
			},
		});
		expect(applied.edges).toHaveLength(1);
		expect(applied.edges[0]).toMatchObject({
			from: { kind: "memory", id: applied.revisions[0]?.memoryId },
			to: { kind: "memory", id: original.revision.memoryId },
			relation: "contradicts",
		});
		expect((await store.readMemory(original.revision.memoryId)).revision.lifecycle).toBe("active");
	});

	it("is idempotent for identical trace decisions and rejects reused IDs with different content", async () => {
		const { service } = await createService();
		const store = service.getStore();
		const runTrace = trace("run_idempotent", [], [], "succeeded");
		const options = {
			eventId: "evt_reconstruction_idempotent",
			idempotencyKey: "memory:reconstruction:run_idempotent",
			expectedHead: (await store.replay()).head,
			timestamp: runTrace.settledAt,
		};
		const first = await store.recordReconstruction(runTrace, options);
		const retry = await store.recordReconstruction(runTrace, options);
		expect(retry.write.head).toEqual(first.write.head);
		await expect(
			store.recordReconstruction(
				{ ...runTrace, stopReason: "not_needed" },
				{ ...options, expectedHead: first.write.head },
			),
		).rejects.toBeInstanceOf(MemoryIdempotencyConflictError);
	});

	it("rejects semantic publication after failed runs and on stale revisions", async () => {
		const { service } = await createService();
		const remembered = await service.remember("Keep failed runs diagnostic-only.", {
			commandId: "command_ambient_failed",
			recordedAt: "2026-08-03T00:59:00.000Z",
		});
		const store = service.getStore();
		const evidenceRefs: EvidenceRefV2[] = remembered.revision.evidenceRefs;
		const evidenceIds = evidenceRefs.map((entry) => entry.evidenceId);
		const failedTrace = trace(
			"run_failed",
			[{ memoryId: remembered.revision.memoryId, revision: 1 }],
			evidenceIds,
			"error",
		);
		const failed = await store.recordReconstruction(failedTrace, {
			eventId: "evt_reconstruction_failed",
			idempotencyKey: "memory:reconstruction:run_failed",
			expectedHead: (await store.replay()).head,
			timestamp: failedTrace.settledAt,
		});
		await expect(
			store.applyMemoryReviews(
				[reviseDecision(failedTrace.runId, remembered.revision.memoryId, 1, evidenceIds)],
				evidenceRefs,
				failed.traceArtifactId,
				{
					eventId: "evt_review_failed",
					idempotencyKey: "memory:review:run_failed",
					expectedHead: failed.write.head,
					timestamp: failedTrace.settledAt,
				},
			),
		).rejects.toThrow("successful");

		const succeededTrace = trace("run_stale", [{ memoryId: remembered.revision.memoryId, revision: 1 }], evidenceIds);
		const succeeded = await store.recordReconstruction(succeededTrace, {
			eventId: "evt_reconstruction_stale",
			idempotencyKey: "memory:reconstruction:run_stale",
			expectedHead: (await store.replay()).head,
			timestamp: succeededTrace.settledAt,
		});
		await expect(
			store.applyMemoryReviews(
				[reviseDecision(succeededTrace.runId, remembered.revision.memoryId, 2, evidenceIds)],
				evidenceRefs,
				succeeded.traceArtifactId,
				{
					eventId: "evt_review_stale",
					idempotencyKey: "memory:review:run_stale",
					expectedHead: succeeded.write.head,
					timestamp: succeededTrace.settledAt,
				},
			),
		).rejects.toBeInstanceOf(MemoryRevisionConflictError);
	});

	it("rejects an unknown future Memory event version", async () => {
		const { projectRoot, service } = await createService();
		await service.remember("Create the legacy event prefix.", {
			commandId: "command_ambient_unknown",
			recordedAt: "2026-08-03T00:59:00.000Z",
		});
		const store = service.getStore();
		const replay = await store.replay();
		const previous = replay.events.at(-1);
		if (!previous) throw new Error("missing legacy event fixture");
		const withoutHash = {
			schema: "pi-xk.memory-event.v3",
			eventId: "evt_unknown_v3",
			sequence: previous.sequence + 1,
			eventType: "future_event",
			actor: "runtime",
			timestamp: "2026-08-03T01:00:00.000Z",
			prevHash: previous.hash,
			payload: {},
			schemaVersion: 3,
			idempotencyKey: "memory:future:v3",
		};
		const unknown = {
			...withoutHash,
			hash: `sha256:${createHash("sha256").update(stableJsonStringify(withoutHash)).digest("hex")}`,
		};
		await appendFile(join(projectRoot, ".pi-xk", "memory", "events.jsonl"), `${stableJsonStringify(unknown)}\n`);
		await expect(store.replay()).rejects.toBeInstanceOf(MemoryCorruptionError);
	});
});
