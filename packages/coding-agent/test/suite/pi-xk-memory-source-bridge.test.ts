import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArtifactStore,
	type GoalContractV3,
	GoalStore,
	MemoryService,
	SessionChainStore,
} from "../../../pi-xk-core/src/index.ts";
import {
	type MemoryCaptureRequest,
	MemoryController,
	type MemoryGenerationHost,
} from "../../../pi-xk-extension/src/memory-controller.ts";
import { MEMORY_CAPTURE_RESPONSE_SCHEMA } from "../../../pi-xk-extension/src/memory-prompt.ts";
import { MemorySourceBridge } from "../../../pi-xk-extension/src/memory-source-bridge.ts";
import { SessionChainRollupManager } from "../../../pi-xk-extension/src/session-chain-rollup.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const services: MemoryService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function contract(goalId: string, ownerSessionId: string): GoalContractV3 {
	return {
		schema: "pi-xk.goal.contract.v3",
		goalId,
		title: "Memory bridge Goal",
		intentAnchor: "Preserve durable Goal evidence for later project work.",
		objective: "Capture stable Goal evidence into project Memory.",
		constraints: ["Do not copy the transcript."],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "The bridge captures canonical evidence.",
				required: true,
				command: "memory bridge focused test",
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId,
		createdAt: "2026-08-01T00:00:00.000Z",
		schemaVersion: 3,
		revision: 1,
		nonGoals: ["Do not add a second task ledger."],
		doneCondition: "Every required acceptance has verified evidence.",
		pauseCondition: "No in-scope action can proceed.",
		finalReport: "Report evidence and remaining limits.",
		executionAuthorization: "In-scope implementation and verification are authorized.",
	};
}

async function createCheckpoint(
	projectRoot: string,
	ownerSessionId: string,
	suffix = "",
	transformState: (state: string) => string = (state) => state,
) {
	const store = new GoalStore(projectRoot);
	const goal = contract(`goal_memory_bridge${suffix}`, ownerSessionId);
	const created = await store.createGoal(goal, {
		eventId: `evt_goal_created${suffix}`,
		idempotencyKey: `goal:create:memory-bridge${suffix}`,
		actor: "user",
		timestamp: goal.createdAt,
	});
	const evidence = await store.putArtifact({
		contentType: "application/json",
		value: {
			schema: "pi-xk.checkpoint-evidence.v2",
			goalId: goal.goalId,
			sessionId: ownerSessionId,
			leafId: `leaf_checkpoint${suffix}`,
			turnIndex: 1,
			toolResultCount: 0,
			reason: "turn_end",
			contractRevision: goal.revision,
			goalState: transformState(
				await readFile(join(projectRoot, ".pi-xk", "goals", goal.goalId, "goal-state.md"), "utf8"),
			),
			createdAt: "2026-08-01T00:01:00.000Z",
		},
		producer: "pi-xk.checkpoint-evidence.v2",
		sensitivity: "redacted",
		sourceIds: [goal.goalId, ownerSessionId, `leaf_checkpoint${suffix}`],
		createdAt: "2026-08-01T00:01:00.000Z",
	});
	return await store.appendCheckpoint(
		goal.goalId,
		{
			schema: "pi-xk.goal-checkpoint.v2",
			sessionId: ownerSessionId,
			leafId: `leaf_checkpoint${suffix}`,
			turnIndex: 1,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-08-01T00:01:00.000Z",
			evidence: {
				schema: "pi-xk.goal-checkpoint-evidence.v1",
				sourceEntryIds: [`leaf_checkpoint${suffix}`],
				artifacts: [
					{
						schema: "pi-xk.artifact-ref.v1",
						artifactId: evidence.artifactId,
						role: "checkpoint_evidence",
					},
				],
			},
		},
		{
			eventId: `evt_goal_checkpoint${suffix}`,
			idempotencyKey: `goal:checkpoint:memory-bridge${suffix}`,
			actor: "runtime",
			timestamp: "2026-08-01T00:01:00.000Z",
			expectedHead: created.head,
		},
	);
}

function durableMemoryEnvelope(title: string): string {
	return JSON.stringify({
		schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
		reason: "The Goal checkpoint contains a durable project fact.",
		cues: [],
		memories: [
			{
				memoryId: null,
				expectedRevision: null,
				kind: "fact",
				title,
				statement: `${title} remains recoverable after a retryable source failure.`,
				applicability: "Pi-XK Memory stable-source recovery.",
				trust: "model_inferred",
				effectiveFrom: "2026-08-01T00:01:00.000Z",
				cueKeys: [],
			},
		],
		edges: [],
	});
}

describe("Pi-XK Memory source bridge", () => {
	it("does not create or advance capture cursors while Memory is off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		await service.setConfig({ enabled: false });
		const capture = vi.fn();
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: { getService: () => service, capture, resumePublications: async () => [] },
		});

		await bridge.initialize();
		expect(await bridge.captureStableSources({ model: undefined, generate: vi.fn() })).toEqual([]);
		await expect(bridge.backfill({ model: undefined, generate: vi.fn() })).rejects.toThrow(/disabled|read-only/i);
		expect(capture).not.toHaveBeenCalled();
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("builds a Goal checkpoint request from canonical Artifact Store content", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const captured: MemoryCaptureRequest[] = [];
		const resumePublications = vi.fn(async () => []);
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: {
				getService: () => service,
				resumePublications,
				capture: async (request) => {
					captured.push(request);
					return { captureId: "capture_test", status: "applied", proposalId: null, confirmationRequired: false };
				},
			},
		});
		await bridge.initialize();
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"))).resolves.toBeDefined();
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId());
		await writeFile(
			join(harness.tempDir, ".pi-xk", "goals", "goal_memory_bridge", "goal-state.md"),
			"later mutable state that must not become checkpoint evidence\n",
		);

		await bridge.captureStableSources({ model: undefined, generate: vi.fn() });

		expect(resumePublications).toHaveBeenCalledTimes(1);
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			trigger: "goal_checkpoint",
			sourceType: "goal_checkpoint",
			sourceId: "evt_goal_checkpoint",
			locator: { goalId: "goal_memory_bridge", checkpointEventId: "evt_goal_checkpoint" },
			scope: { goalId: "goal_memory_bridge", chainId: null, branchId: null, paths: [] },
		});
		const request = captured[0]!;
		expect(request.sourceDigest).toBe(request.artifactId);
		expect((await new ArtifactStore(harness.tempDir).read(request.artifactId)).content).toBe(request.content);
		expect(JSON.parse(request.content)).toMatchObject({
			schema: "pi-xk.memory-goal-source.v1",
			contractRevision: 1,
			event: { eventId: "evt_goal_checkpoint", eventType: "goal_checkpointed" },
			state: expect.stringContaining("# Goal State"),
		});
		expect(request.content).toContain("# Goal State");
		expect(request.content).not.toContain("later mutable state");
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"))).resolves.toBeDefined();
	});

	it("builds Goal completion Memory from the final event-time checkpoint State", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const captured: MemoryCaptureRequest[] = [];
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: {
				getService: () => service,
				resumePublications: async () => [],
				capture: async (request) => {
					captured.push(request);
					return {
						captureId: `capture_${request.sourceId}`,
						status: "applied",
						proposalId: null,
						confirmationRequired: false,
					};
				},
			},
		});
		await bridge.initialize();
		const completeState = (state: string): string =>
			state
				.replace(
					"- A-1: required; unverified; evidence: not recorded.",
					"- A-1: required; verified; evidence: targeted Memory bridge test passed.",
				)
				.replace(
					'- {"evidence":"","summary":"","verifiedAcceptanceIds":[]}',
					'- {"evidence":"targeted tests are green","summary":"Goal evidence is complete.","verifiedAcceptanceIds":["A-1"]}',
				);
		const checkpoint = await createCheckpoint(
			harness.tempDir,
			harness.sessionManager.getSessionId(),
			"_completion",
			completeState,
		);
		const store = new GoalStore(harness.tempDir);
		const activated = await store.appendLifecycleEvent(
			"goal_memory_bridge_completion",
			{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
			{
				eventId: "evt_goal_activated_completion",
				idempotencyKey: "goal:activate:memory-bridge-completion",
				expectedHead: checkpoint.head,
				actor: "user",
				timestamp: "2026-08-01T00:02:00.000Z",
			},
		);
		await store.appendLifecycleEvent(
			"goal_memory_bridge_completion",
			{
				eventType: "goal_ended",
				payload: {
					outcome: "accepted",
					reason: "all required evidence is verified",
					verifiedAcceptanceIds: ["A-1"],
					finalEvidence: "targeted tests are green",
					finalSummary: "Goal evidence is complete.",
				},
			},
			{
				eventId: "evt_goal_ended_completion",
				idempotencyKey: "goal:end:memory-bridge-completion",
				expectedHead: activated.head,
				actor: "user",
				timestamp: "2026-08-01T00:03:00.000Z",
			},
		);
		const statePath = join(harness.tempDir, ".pi-xk", "goals", "goal_memory_bridge_completion", "goal-state.md");
		await writeFile(
			statePath,
			completeState(await readFile(statePath, "utf8")).replace(
				"- Goal initialized.\n\n## pause_audit",
				"- Goal initialized.\n- later mutable state that is not completion evidence\n\n## pause_audit",
			),
		);

		await bridge.captureStableSources({ model: undefined, generate: vi.fn() });

		const completion = captured.find((request) => request.sourceType === "goal_completion");
		expect(completion).toBeDefined();
		expect(completion?.content).toContain("targeted Memory bridge test passed");
		expect(completion?.content).not.toContain("later mutable state that is not completion evidence");
	});

	it("advances past a checkpoint whose event-time State is not synchronized with its contract", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const capture = vi.fn();
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: { getService: () => service, capture, resumePublications: async () => [] },
		});
		await bridge.initialize();
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_stale", (state) =>
			state.replace("## contract_revision\n- 1", "## contract_revision\n- 2"),
		);

		await expect(bridge.captureStableSources({ model: undefined, generate: vi.fn() })).resolves.toEqual([]);
		expect(capture).not.toHaveBeenCalled();
		const cursor = JSON.parse(
			await readFile(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"), "utf8"),
		) as { goals: Record<string, { sequence: number; hash: string }> };
		expect(cursor.goals.goal_memory_bridge_stale?.sequence).toBe(2);
	});

	it("baselines historical sources without creating Memory state or backfilling them", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_historical");
		const captured: MemoryCaptureRequest[] = [];
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: {
				getService: () => service,
				resumePublications: async () => [],
				capture: async (request) => {
					captured.push(request);
					return { captureId: "capture_new", status: "applied", proposalId: null, confirmationRequired: false };
				},
			},
		});

		await bridge.initialize();
		expect(await bridge.captureStableSources({ model: undefined, generate: vi.fn() })).toEqual([]);
		expect(captured).toEqual([]);
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"))).resolves.toBeDefined();

		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_new");
		await bridge.captureStableSources({ model: undefined, generate: vi.fn() });
		expect(captured.map((request) => request.sourceId)).toEqual(["evt_goal_checkpoint_new"]);
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json"))).resolves.toBeDefined();
	});

	it("recovers a persisted baseline cursor after restart without skipping a later source", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_baseline");
		const capture = vi.fn(async (request: MemoryCaptureRequest) => ({
			captureId: `capture_${request.sourceId}`,
			status: "applied" as const,
			proposalId: null,
			confirmationRequired: false,
		}));
		const controller = { getService: () => service, capture, resumePublications: async () => [] };
		await new MemorySourceBridge({ projectRoot: harness.tempDir, controller }).initialize();

		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_after_restart");
		const restarted = new MemorySourceBridge({ projectRoot: harness.tempDir, controller });
		await restarted.initialize();
		await restarted.captureStableSources({ model: undefined, generate: vi.fn() });

		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture.mock.calls[0]?.[0]).toMatchObject({ sourceId: "evt_goal_checkpoint_after_restart" });
	});

	it("retries a failed retryable source after its source cursor has advanced", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		class RetryOnceMemoryService extends MemoryService {
			private shouldFailSearch = true;

			override async search(input: Parameters<MemoryService["search"]>[0]) {
				if (this.shouldFailSearch) {
					this.shouldFailSearch = false;
					throw new Error("simulated transient Memory index failure");
				}
				return await super.search(input);
			}
		}
		const service = new RetryOnceMemoryService(harness.tempDir);
		services.push(service);
		const controller = new MemoryController({ projectRoot: harness.tempDir, service });
		const bridge = new MemorySourceBridge({ projectRoot: harness.tempDir, controller });
		await bridge.initialize();
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_retryable_source");
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Retryable source recovery"),
			model: { provider: "faux", modelId: "faux" },
		}));
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		};

		await expect(bridge.captureStableSources(host)).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
		const cursorPath = join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json");
		const advanced = JSON.parse(await readFile(cursorPath, "utf8")) as {
			goals: Record<string, { sequence: number }>;
		};
		expect(advanced.goals.goal_memory_bridge_retryable_source?.sequence).toBe(2);

		await expect(bridge.captureStableSources(host)).resolves.toEqual([
			expect.objectContaining({ status: "applied" }),
		]);
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("rejects a source cursor that advances beyond its Goal event log", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_cursor_head");
		const controller = { getService: () => service, capture: vi.fn(), resumePublications: async () => [] };
		const bridge = new MemorySourceBridge({ projectRoot: harness.tempDir, controller });
		await bridge.initialize();
		const cursorPath = join(harness.tempDir, ".pi-xk", "memory", "source-cursors.json");
		const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as {
			goals: Record<string, { sequence: number; hash: string }>;
		};
		cursor.goals.goal_memory_bridge_cursor_head!.sequence = 999;
		await writeFile(cursorPath, `${JSON.stringify(cursor)}\n`, "utf8");

		await expect(bridge.doctor("deep")).resolves.toEqual([
			expect.objectContaining({ code: "source_cursor_invalid", repairable: false }),
		]);
		await expect(bridge.captureStableSources({ model: undefined, generate: vi.fn() })).rejects.toThrow(
			/cursor.*(?:ahead|event log|match)/i,
		);
		expect(controller.capture).not.toHaveBeenCalled();
	});

	it("backfills one earliest source by default and honors the explicit limit without repeats", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_one");
		await createCheckpoint(harness.tempDir, harness.sessionManager.getSessionId(), "_two");
		let captureIndex = 0;
		const captured: MemoryCaptureRequest[] = [];
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: {
				getService: () => service,
				resumePublications: async () => [],
				capture: async (request) => {
					captured.push(request);
					captureIndex += 1;
					const replay = await service.getStore().replay();
					await service.getStore().scheduleCapture(
						{
							schema: "pi-xk.memory-capture-source.v1",
							captureId: `capture_backfill_${captureIndex}`,
							trigger: "backfill",
							sourceIds: [request.sourceId, request.artifactId],
							sourceDigest: request.artifactId,
							promptVersion: "pi-xk.memory-capture.v1",
							createdAt: request.recordedAt,
						},
						{
							eventId: `evt_memory_backfill_${captureIndex}`,
							idempotencyKey: `memory:backfill:${captureIndex}`,
							expectedHead: replay.head,
						},
					);
					return {
						captureId: `capture_backfill_${captureIndex}`,
						status: "scheduled",
						proposalId: null,
						confirmationRequired: false,
					};
				},
			},
		});
		const host = { model: undefined, generate: vi.fn() };

		expect(await bridge.backfill(host)).toHaveLength(1);
		expect(await bridge.backfill(host, 20)).toHaveLength(1);
		expect(await bridge.backfill(host, 20)).toEqual([]);
		expect(captured.map((request) => request.sourceId)).toEqual([
			"evt_goal_checkpoint_one",
			"evt_goal_checkpoint_two",
		]);
	});

	it("does not silently skip corrupted Goal evidence during explicit backfill", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const checkpoint = await createCheckpoint(
			harness.tempDir,
			harness.sessionManager.getSessionId(),
			"_corrupt_backfill",
		);
		if (checkpoint.event.eventType !== "goal_checkpointed") throw new Error("checkpoint fixture type is invalid");
		const checkpointPayload = checkpoint.event.payload.checkpoint;
		if (checkpointPayload.schema !== "pi-xk.goal-checkpoint.v2")
			throw new Error("checkpoint fixture schema is invalid");
		const reference = checkpointPayload.evidence.artifacts.find(
			(artifact) => artifact.role === "checkpoint_evidence",
		);
		if (!reference) throw new Error("missing checkpoint evidence fixture");
		const digest = reference.artifactId.slice("sha256:".length);
		await writeFile(
			join(harness.tempDir, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`),
			"{}\n",
		);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: { getService: () => service, capture: vi.fn(), resumePublications: async () => [] },
		});

		await expect(bridge.backfill({ model: undefined, generate: vi.fn() })).rejects.toThrow(
			/artifact|digest|integrity/i,
		);
	});

	it("rejects a capture request whose body or digest is not the canonical source artifact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const artifacts = new ArtifactStore(harness.tempDir);
		const stored = await artifacts.put({
			contentType: "text/plain",
			text: "canonical source",
			producer: "pi-xk.memory-source-test.v1",
			sensitivity: "internal",
			sourceIds: ["source_test"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate: vi.fn(),
		};
		const request: MemoryCaptureRequest = {
			trigger: "backfill",
			sourceType: "task_result",
			sourceId: "task_test",
			artifactId: stored.artifactId,
			sourceDigest: stored.artifactId,
			locator: { taskId: "task_test" },
			recordedAt: "2026-08-01T00:00:00.000Z",
			query: "canonical source",
			content: "tampered source",
			scope: { goalId: null, chainId: null, branchId: null, paths: [] },
		};

		await expect(controller.capture(request, host)).rejects.toThrow(/canonical/i);
		await expect(
			controller.capture(
				{ ...request, content: "canonical source", sourceDigest: `sha256:${"f".repeat(64)}` },
				host,
			),
		).rejects.toThrow(/digest/i);
		await controller.close();
	});

	it("requires a published L2 event before constructing a rollup capture", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const controller = { getService: () => service, capture: vi.fn(), resumePublications: async () => [] };
		const bridge = new MemorySourceBridge({ projectRoot: harness.tempDir, controller });
		const store = new SessionChainStore(harness.tempDir);
		await store.createChain(
			{
				schema: "pi-xk.session-chain.spec.v1",
				chainId: "chain_memory",
				title: "Memory test chain",
				cwd: harness.tempDir,
				rootBranchId: "branch_memory",
				rootSegment: {
					segmentId: "segment_memory",
					ordinal: 1,
					location: { kind: "external-root", absolutePath: join(harness.tempDir, "segment-memory.jsonl") },
					predecessorSegmentId: null,
					summaryInArtifactId: null,
					createdAt: "2026-08-01T00:00:00.000Z",
				},
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			{
				eventId: "evt_chain_created",
				idempotencyKey: "chain:create:memory-test",
				actor: "user",
				timestamp: "2026-08-01T00:00:00.000Z",
			},
		);
		const artifactId = await store.putChainRollup({
			schema: "pi-xk.session-chain-rollup.v1",
			chainId: "chain_memory",
			branchId: "branch_memory",
			windowIndex: 1,
			startOrdinal: 1,
			endOrdinal: 1,
			segmentIds: ["segment_memory"],
			summaryArtifactIds: [`sha256:${"a".repeat(64)}`],
			sourceDigest: `sha256:${"b".repeat(64)}`,
			rollup: { state: "state", decisions: [], constraints: [], completed: [], unresolved: [], nextActions: [] },
			provenance: {
				generator: "pi-xk",
				model: "faux/faux",
				promptVersion: "session-chain-rollup-v3",
				generatedAt: "2026-08-01T00:00:00.000Z",
			},
		});

		await expect(
			bridge.capturePublishedRollup(
				{ chainId: "chain_memory", branchId: "branch_memory", windowIndex: 1, artifactId },
				{ model: undefined, generate: vi.fn() },
			),
		).rejects.toThrow(/published event/i);
		expect(controller.capture).not.toHaveBeenCalled();
	});

	it("rebuilds project history cues with chain ranges and compaction locators", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const service = new MemoryService(harness.tempDir);
		services.push(service);
		const bridge = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: { getService: () => service, capture: vi.fn(), resumePublications: async () => [] },
		});
		const sessionPath = join(harness.tempDir, "history-cue-segment.jsonl");
		const session = SessionManager.createAt(harness.tempDir, sessionPath, { id: "session_history_cue" });
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Optimize the artifact read path." }],
			timestamp: Date.parse("2026-08-01T00:00:00.000Z"),
		});
		const firstKeptEntryId = session.getLeafId();
		if (!firstKeptEntryId) throw new Error("history cue fixture has no first kept entry");
		session.appendCompaction(
			"Artifact read path context was compacted.",
			firstKeptEntryId,
			20_000,
			undefined,
			false,
			{
				title: "Artifact read path optimization",
				reason: "manual",
				recoveryPromptVersion: "compaction-recovery-v1",
			},
		);
		session.flushDurable();
		const store = new SessionChainStore(harness.tempDir);
		const created = await store.createChain(
			{
				schema: "pi-xk.session-chain.spec.v1",
				chainId: "chain_history",
				title: "History cue chain",
				cwd: harness.tempDir,
				rootBranchId: "branch_history",
				rootSegment: {
					segmentId: "segment_history",
					ordinal: 1,
					location: { kind: "external-root", absolutePath: sessionPath },
					predecessorSegmentId: null,
					summaryInArtifactId: null,
					createdAt: "2026-08-01T00:00:00.000Z",
				},
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			{
				eventId: "evt_history_chain_created",
				idempotencyKey: "chain:create:history-cue",
				actor: "user",
				timestamp: "2026-08-01T00:00:00.000Z",
			},
		);
		const summaryArtifactId = await store.putSegmentSummary({
			schema: "pi-xk.segment-summary.v2",
			title: "Canonical artifact verification",
			chainId: "chain_history",
			branchId: "branch_history",
			sourceSegmentId: "segment_history",
			sourceLeafId: "leaf_history",
			targetSegmentId: "segment_history_next",
			baseSummaryArtifactId: null,
			sourceRange: {
				firstEntryId: firstKeptEntryId,
				lastEntryId: "leaf_history",
				entryCount: 2,
				entriesHash: `sha256:${"a".repeat(64)}`,
			},
			segmentDeltaMarkdown: "Validated canonical artifact reads.",
			carryForwardMarkdown: "Continue using canonical artifact content.",
			generator: {
				provider: "faux",
				modelId: "faux",
				promptVersion: "session-chain-summary-v3",
				inputTokens: 100,
				outputTokens: 50,
				generatedAt: "2026-08-01T00:01:00.000Z",
			},
		});
		const prepared = await store.appendRolloverPrepared(
			"chain_history",
			{
				branchId: "branch_history",
				sourceSegmentId: "segment_history",
				sourceLeafId: "leaf_history",
				targetSegment: {
					segmentId: "segment_history_next",
					ordinal: 2,
					location: { kind: "managed", fileName: "000002_segment_history_next.jsonl" },
					predecessorSegmentId: "segment_history",
					summaryInArtifactId: summaryArtifactId,
					createdAt: "2026-08-01T00:02:00.000Z",
				},
				summaryArtifactId,
				reason: "history cue fixture",
			},
			{
				eventId: "evt_history_prepared",
				idempotencyKey: "chain:history:prepared",
				expectedHead: created.head,
				actor: "runtime",
				timestamp: "2026-08-01T00:02:00.000Z",
			},
		);
		await store.appendRolloverCommitted(
			"chain_history",
			{
				branchId: "branch_history",
				sourceSegmentId: "segment_history",
				targetSegmentId: "segment_history_next",
				sourceSeal: {
					bytes: 1,
					fileHash: `sha256:${"b".repeat(64)}`,
					leafId: "summary_out_history",
					summaryArtifactId,
					summaryOutEntryId: "summary_out_history",
				},
				targetMarkers: { chainLinkEntryId: "chain_link_history", summaryInEntryId: "summary_in_history" },
			},
			{
				eventId: "evt_history_committed",
				idempotencyKey: "chain:history:committed",
				expectedHead: prepared.head,
				actor: "runtime",
				timestamp: "2026-08-01T00:03:00.000Z",
			},
		);
		const onRollupPublished = vi.fn();
		const rollups = new SessionChainRollupManager({
			projectRoot: harness.tempDir,
			store,
			now: () => "2026-08-01T00:04:00.000Z",
			verifyL1SummaryEvidence: async (_chainId, _branch, segment) => {
				if (!segment.seal) throw new Error("sealed fixture has no summary artifact");
				return await store.readSegmentSummary(segment.seal.summaryArtifactId);
			},
			onRollupPublished,
		});
		await rollups.setConfig({ enabled: true, interval: 1 });
		await rollups.backfill(
			{
				sessionManager: session,
				model: { provider: "faux", id: "faux", contextWindow: 100_000 },
				summarizeSessionContext: async () => ({
					summary: JSON.stringify({
						schema: "pi.summary-evidence.v1",
						kind: "session-chain-l2",
						payload: {
							state: "Canonical artifact verification is complete.",
							decisions: [],
							constraints: ["Use canonical artifact content."],
							completed: ["Verified the artifact read path."],
							unresolved: [],
							nextActions: [],
						},
					}),
					model: { provider: "faux", modelId: "faux" },
					thinkingLevel: "medium",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
				}),
				rolloverSession: async () => ({ cancelled: true }),
			},
			"chain_history",
			"branch_history",
			1,
		);
		expect(onRollupPublished).toHaveBeenCalledWith(
			expect.objectContaining({ chainId: "chain_history", branchId: "branch_history", windowIndex: 1 }),
			expect.any(Object),
		);

		const cues = await bridge.refreshHistoryCues();
		expect(cues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceType: "segment_summary",
					sourceId: summaryArtifactId,
					title: "Canonical artifact verification",
					chainId: "chain_history",
					branchId: "branch_history",
					segmentId: "segment_history",
					ordinal: 1,
					sessionId: null,
				}),
				expect.objectContaining({
					sourceType: "compaction",
					title: "Artifact read path optimization",
					sessionId: "session_history_cue",
					segmentId: "segment_history",
				}),
			]),
		);
		expect(cues).toHaveLength(2);
		const historyCursorPath = join(harness.tempDir, ".pi-xk", "memory", "history-cue-cursor.json");
		await expect(stat(historyCursorPath)).resolves.toBeDefined();
		await writeFile(historyCursorPath, "{}\n", "utf8");
		const restarted = new MemorySourceBridge({
			projectRoot: harness.tempDir,
			controller: { getService: () => service, capture: vi.fn(), resumePublications: async () => [] },
		});
		await expect(restarted.refreshHistoryCues()).rejects.toThrow(/cursor is invalid|repair-projections/i);
		await expect(restarted.refreshHistoryCues({ forceRebuild: true })).resolves.toEqual(cues);
		const persistedCursor = await readFile(historyCursorPath, "utf8");
		const tamperedCursor = JSON.parse(persistedCursor) as { cues: Array<{ title: string }> };
		tamperedCursor.cues[0]!.title = "tampered projection title";
		await writeFile(historyCursorPath, `${JSON.stringify(tamperedCursor)}\n`, "utf8");
		await expect(restarted.doctor("quick")).resolves.toEqual([
			expect.objectContaining({ code: "history_cue_cursor_invalid", repairable: true }),
		]);
		await expect(restarted.refreshHistoryCues()).rejects.toThrow(/cursor.*(?:digest|invalid)/i);
		await expect(restarted.refreshHistoryCues({ forceRebuild: true })).resolves.toEqual(cues);
		await rm(sessionPath);
		await expect(restarted.refreshHistoryCues()).resolves.toEqual(cues);
		const repairedCursor = JSON.parse(await readFile(historyCursorPath, "utf8")) as Record<string, unknown>;
		const originalCursor = JSON.parse(persistedCursor) as Record<string, unknown>;
		expect({ ...repairedCursor, updatedAt: originalCursor.updatedAt }).toEqual(originalCursor);
		const result = await service.search({ query: "Artifact read path", includeHistoryCues: true });
		expect(result.items).toEqual([]);
		expect(result.historyCues[0]).toMatchObject({ sourceType: "compaction", sessionId: "session_history_cue" });
		expect((await service.status()).index?.historyCueCount).toBe(2);
	});
});
