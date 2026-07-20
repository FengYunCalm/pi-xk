import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactStore,
	type GoalCheckpointV1,
	type GoalCheckpointV2,
	type GoalContractV1,
	GoalReadModelStaleError,
	GoalStore,
	upcastGoalCheckpoint,
} from "../src/index.ts";
import { stableJsonStringify } from "../src/stable-json.ts";

const tempDirs: string[] = [];

function createContract(goalId: string): GoalContractV1 {
	return {
		schema: "pi-xk.goal.contract.v1",
		goalId,
		title: "Read model test",
		objective: "Rebuild a read model from Goal facts.",
		constraints: [],
		acceptance: [],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-read-model",
		createdAt: "2026-07-20T00:00:00.000Z",
		schemaVersion: 1,
	};
}

async function createStore(): Promise<{ store: GoalStore; artifacts: ArtifactStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-read-model-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new GoalStore(projectRoot), artifacts: new ArtifactStore(projectRoot), projectRoot };
}

async function createEvidenceCheckpoint(
	artifacts: ArtifactStore,
	sessionId: string,
	leafId: string,
): Promise<GoalCheckpointV2> {
	const artifact = await artifacts.put({
		contentType: "application/json",
		value: { schema: "pi-xk.checkpoint-evidence.v1", sessionId, leafId, toolResultCount: 1 },
		producer: "pi-xk.checkpoint-evidence.v1",
		sensitivity: "redacted",
		sourceIds: [sessionId, leafId],
		createdAt: "2026-07-20T00:00:01.000Z",
	});
	return {
		schema: "pi-xk.goal-checkpoint.v2",
		sessionId,
		leafId,
		turnIndex: 1,
		toolResultCount: 1,
		reason: "turn_end",
		createdAt: "2026-07-20T00:00:01.000Z",
		evidence: {
			schema: "pi-xk.goal-checkpoint-evidence.v1",
			sourceEntryIds: [leafId],
			artifacts: [
				{
					schema: "pi-xk.artifact-ref.v1",
					artifactId: artifact.artifactId,
					role: "checkpoint_evidence",
				},
			],
		},
	};
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("Goal read model", () => {
	it("writes and rebuilds a read model from checkpoint evidence without reading goal-state.md", async () => {
		const { store, artifacts, projectRoot } = await createStore();
		const contract = createContract("goal_read_model");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_read_model",
		});
		const checkpoint = await createEvidenceCheckpoint(artifacts, "session-read-model", "leaf-tool-result");
		const appended = await store.appendCheckpoint(contract.goalId, checkpoint, {
			eventId: "evt-checkpoint",
			idempotencyKey: "checkpoint:goal_read_model:leaf-tool-result",
			expectedHead: created.head,
		});
		const statePath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "goal-state.md");
		await writeFile(statePath, "model-only-state-secret\n");

		const loaded = await store.loadGoalReadModel(contract.goalId);
		const projectionPath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "goal-read-model.json");
		const persisted = await readFile(projectionPath, "utf8");

		expect(loaded).toMatchObject({
			schema: "pi-xk.goal-read-model.v1",
			goalId: contract.goalId,
			sequence: appended.head.sequence,
			baseHash: appended.head.hash,
			checkpointCount: 1,
			latestCheckpoint: { eventId: "evt-checkpoint", checkpoint },
			artifactDiagnostics: [{ artifactId: checkpoint.evidence.artifacts[0]?.artifactId, status: "valid" }],
		});
		expect(persisted).not.toContain("model-only-state-secret");

		await rm(projectionPath);
		const rebuilt = await store.rebuildGoalReadModel(contract.goalId);
		expect(rebuilt).toEqual(loaded);
	});

	it("reports changed artifact availability instead of serving a stale read model", async () => {
		const { store, artifacts, projectRoot } = await createStore();
		const contract = createContract("goal_missing_artifact");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_missing_artifact",
		});
		const checkpoint = await createEvidenceCheckpoint(artifacts, "session-read-model", "leaf-missing");
		await store.appendCheckpoint(contract.goalId, checkpoint, {
			eventId: "evt-checkpoint",
			idempotencyKey: "checkpoint:goal_missing_artifact:leaf-missing",
			expectedHead: created.head,
		});
		const artifactId = checkpoint.evidence.artifacts[0]?.artifactId;
		if (!artifactId) throw new Error("test checkpoint has no artifact");
		const digest = artifactId.slice("sha256:".length);
		await rm(join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2)), {
			recursive: true,
		});

		await expect(store.loadGoalReadModel(contract.goalId)).rejects.toBeInstanceOf(GoalReadModelStaleError);
		const rebuilt = await store.rebuildGoalReadModel(contract.goalId);
		expect(rebuilt.artifactDiagnostics).toEqual([expect.objectContaining({ artifactId, status: "missing" })]);
		await expect(store.loadGoalReadModel(contract.goalId)).resolves.toEqual(rebuilt);
	});

	it("keeps a historical v1 checkpoint hash intact while rebuilding a v2 read model", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_legacy_checkpoint");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_legacy_checkpoint",
		});
		const legacy: GoalCheckpointV1 = {
			schema: "pi-xk.goal-checkpoint.v1",
			sessionId: "session-legacy",
			leafId: "leaf-legacy",
			turnIndex: 0,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-07-20T00:00:01.000Z",
		};
		const eventWithoutHash = {
			schema: "pi-xk.goal-event.v1" as const,
			eventId: "evt-legacy-checkpoint",
			goalId: contract.goalId,
			sequence: 2,
			eventType: "goal_checkpointed" as const,
			actor: "runtime" as const,
			timestamp: legacy.createdAt,
			prevHash: created.head.hash,
			payload: { checkpoint: legacy },
			schemaVersion: 1 as const,
			idempotencyKey: "checkpoint:legacy",
		};
		const event = {
			...eventWithoutHash,
			hash: `sha256:${createHash("sha256").update(stableJsonStringify(eventWithoutHash)).digest("hex")}`,
		};
		await appendFile(
			join(projectRoot, ".pi-xk", "goals", contract.goalId, "events.jsonl"),
			`${stableJsonStringify(event)}\n`,
		);

		const replayed = await store.replayGoal(contract.goalId);
		const legacyEvent = replayed.events[1];
		if (!legacyEvent || legacyEvent.eventType !== "goal_checkpointed") {
			throw new Error("legacy checkpoint event did not replay");
		}
		expect(legacyEvent.payload.checkpoint).toEqual(legacy);
		const rebuilt = await store.rebuildGoalReadModel(contract.goalId);
		expect(rebuilt.latestCheckpoint?.checkpoint).toEqual(upcastGoalCheckpoint(legacy));
	});

	it("keeps a checkpoint event durable when its read-model projection fails", async () => {
		const { store, artifacts, projectRoot } = await createStore();
		const contract = createContract("goal_read_model_write_failure");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_read_model_write_failure",
		});
		const checkpoint = await createEvidenceCheckpoint(artifacts, "session-read-model", "leaf-projection-failure");
		const projectionPath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "goal-read-model.json");
		await rm(projectionPath);
		await mkdir(projectionPath);

		await expect(
			store.appendCheckpoint(contract.goalId, checkpoint, {
				eventId: "evt-checkpoint",
				idempotencyKey: "checkpoint:goal_read_model_write_failure:leaf-projection-failure",
				expectedHead: created.head,
			}),
		).rejects.toThrow();
		expect((await store.replayGoal(contract.goalId)).events).toHaveLength(2);
		await expect(store.loadGoalReadModel(contract.goalId)).rejects.toBeInstanceOf(GoalReadModelStaleError);

		await rm(projectionPath, { recursive: true });
		await expect(store.rebuildGoalReadModel(contract.goalId)).resolves.toMatchObject({ checkpointCount: 1 });
	});

	it("upcasts legacy v1 checkpoint payloads only while reading", () => {
		const legacy: GoalCheckpointV1 = {
			schema: "pi-xk.goal-checkpoint.v1",
			sessionId: "session-legacy",
			leafId: "leaf-legacy",
			turnIndex: 0,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-07-20T00:00:01.000Z",
		};

		expect(upcastGoalCheckpoint(legacy)).toEqual({
			schema: "pi-xk.goal-checkpoint.v2",
			sessionId: "session-legacy",
			leafId: "leaf-legacy",
			turnIndex: 0,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-07-20T00:00:01.000Z",
			evidence: {
				schema: "pi-xk.goal-checkpoint-evidence.v1",
				sourceEntryIds: ["leaf-legacy"],
				artifacts: [],
			},
		});
	});
});
