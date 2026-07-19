import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoalCheckpoint,
	type GoalContractV1,
	GoalCorruptionError,
	GoalHeadConflictError,
	GoalIdempotencyConflictError,
	GoalRecoveryRequiredError,
	GoalStore,
	GoalValidationError,
} from "../src/index.ts";

const tempDirs: string[] = [];

function createContract(goalId: string, title = "Implement Goal Store"): GoalContractV1 {
	return {
		schema: "pi-xk.goal.contract.v1",
		goalId,
		title,
		objective: "Persist and replay a Goal contract.",
		constraints: ["No Pi core patch"],
		acceptance: [
			{
				id: "A-1",
				kind: "command",
				description: "Run static checks",
				command: "npm run check",
				required: true,
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 100_000, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-123",
		createdAt: "2026-07-19T00:00:00.000Z",
		schemaVersion: 1,
	};
}

async function createStore(): Promise<{ store: GoalStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-core-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new GoalStore(projectRoot), projectRoot };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("GoalStore", () => {
	it("creates a hash-chained Goal and atomically projects its contract", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_store");

		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_store",
		});
		const replayed = await store.replayGoal(contract.goalId);
		const projection = JSON.parse(
			await readFile(join(projectRoot, ".pi-xk", "goals", contract.goalId, "contract.json"), "utf8"),
		) as { sequence: number; hash: string; contract: GoalContractV1 };

		expect(created.head).toEqual({ sequence: 1, hash: created.event.hash });
		expect(replayed.events).toHaveLength(1);
		expect(replayed.events[0]?.prevHash).toBeNull();
		expect(projection).toMatchObject({ sequence: 1, baseHash: created.event.hash, contract });
	});

	it("updates a contract only from its current head and replays the latest projection", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_update");
		const created = await store.createGoal(contract, { eventId: "evt-create", idempotencyKey: "create:goal_update" });
		const nextContract = { ...contract, title: "Updated Goal Store" };

		const updated = await store.updateGoalContract(nextContract, {
			eventId: "evt-update",
			idempotencyKey: "update:goal_update:1",
			expectedHead: created.head,
		});
		const replayed = await store.replayGoal(contract.goalId);

		expect(updated.head.sequence).toBe(2);
		expect(updated.event.prevHash).toBe(created.head.hash);
		expect(replayed.contract.title).toBe("Updated Goal Store");
		await expect(
			store.updateGoalContract(contract, {
				eventId: "evt-stale",
				idempotencyKey: "update:goal_update:stale",
				expectedHead: created.head,
			}),
		).rejects.toBeInstanceOf(GoalHeadConflictError);
	});

	it("deduplicates matching retries and rejects reused keys with different payloads", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_idempotency");
		const options = { eventId: "evt-create", idempotencyKey: "create:goal_idempotency" };

		const first = await store.createGoal(contract, options);
		const retry = await store.createGoal(contract, { ...options, eventId: "evt-retry" });

		expect(retry).toEqual(first);
		await expect(store.createGoal({ ...contract, title: "Different payload" }, options)).rejects.toBeInstanceOf(
			GoalIdempotencyConflictError,
		);
	});

	it("appends an idempotent checkpoint without changing the current contract", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_checkpoint");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_checkpoint",
		});
		const checkpoint: GoalCheckpoint = {
			schema: "pi-xk.goal-checkpoint.v1",
			sessionId: "session-checkpoint",
			leafId: "leaf-tool-result",
			turnIndex: 0,
			toolResultCount: 1,
			reason: "turn_end",
			createdAt: "2026-07-19T00:00:01.000Z",
		};

		const first = await store.appendCheckpoint(contract.goalId, checkpoint, {
			eventId: "evt-checkpoint",
			idempotencyKey: "checkpoint:session-checkpoint:leaf-tool-result",
			expectedHead: created.head,
		});
		const retry = await store.appendCheckpoint(contract.goalId, checkpoint, {
			eventId: "evt-checkpoint-retry",
			idempotencyKey: "checkpoint:session-checkpoint:leaf-tool-result",
			expectedHead: created.head,
		});
		const replayed = await store.replayGoal(contract.goalId);
		const projection = JSON.parse(
			await readFile(join(projectRoot, ".pi-xk", "goals", contract.goalId, "contract.json"), "utf8"),
		) as { sequence: number; baseHash: string; contract: GoalContractV1 };

		expect(first.event.eventType).toBe("goal_checkpointed");
		expect(retry).toEqual(first);
		expect(replayed.events).toHaveLength(2);
		expect(replayed.contract).toEqual(contract);
		expect(projection).toMatchObject({ sequence: 2, baseHash: first.event.hash, contract });
	});

	it("serializes concurrent writes without duplicate sequences", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_concurrent");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_concurrent",
		});
		const firstUpdate = { ...contract, title: "First update" };
		const secondUpdate = { ...contract, title: "Second update" };

		const [first, second] = await Promise.allSettled([
			store.updateGoalContract(firstUpdate, {
				eventId: "evt-first",
				idempotencyKey: "update:goal_concurrent:first",
				expectedHead: created.head,
			}),
			store.updateGoalContract(secondUpdate, {
				eventId: "evt-second",
				idempotencyKey: "update:goal_concurrent:second",
				expectedHead: created.head,
			}),
		]);

		expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect([first, second].filter((result) => result.status === "rejected")).toHaveLength(1);
		const replayed = await store.replayGoal(contract.goalId);
		expect(replayed.events.map((event) => event.sequence)).toEqual([1, 2]);
	});

	it("rebuilds a missing projection after its write fails", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_projection");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_projection",
		});
		const projectionPath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "contract.json");
		await rm(projectionPath);
		await mkdir(projectionPath);

		await expect(
			store.updateGoalContract(
				{ ...contract, title: "Persisted despite projection failure" },
				{
					eventId: "evt-update",
					idempotencyKey: "update:goal_projection:1",
					expectedHead: created.head,
				},
			),
		).rejects.toThrow();

		await rm(projectionPath, { recursive: true });
		const rebuilt = await store.rebuildContractProjection(contract.goalId);
		expect(rebuilt.contract.title).toBe("Persisted despite projection failure");
	});

	it("diagnoses and explicitly repairs a trailing partial event", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_tail");
		const created = await store.createGoal(contract, { eventId: "evt-create", idempotencyKey: "create:goal_tail" });
		const eventsPath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "events.jsonl");
		await appendFile(eventsPath, '{"schema":"pi-xk.goal-event.v1"');

		const replayed = await store.replayGoal(contract.goalId);
		expect(replayed.tailDiagnostic?.discardedBytes).toBeGreaterThan(0);
		await expect(
			store.updateGoalContract(
				{ ...contract, title: "Blocked by tail" },
				{
					eventId: "evt-update",
					idempotencyKey: "update:goal_tail:1",
					expectedHead: created.head,
				},
			),
		).rejects.toBeInstanceOf(GoalRecoveryRequiredError);

		const repaired = await store.repairTrailingPartialEvent(contract.goalId);
		expect(repaired.tailDiagnostic).toBeUndefined();
		expect(repaired.head).toEqual(created.head);
	});

	it("rejects malformed complete events and unsafe Goal IDs", async () => {
		const { store, projectRoot } = await createStore();
		await expect(
			store.createGoal(createContract("../unsafe"), { eventId: "evt-unsafe", idempotencyKey: "unsafe" }),
		).rejects.toThrow("goalId");
		await expect(
			store.createGoal(
				{ ...createContract("goal_invalid_contract"), budgets: { tokens: -1, costCents: 0, wallSeconds: 0 } },
				{ eventId: "evt-invalid-contract", idempotencyKey: "invalid-contract" },
			),
		).rejects.toBeInstanceOf(GoalValidationError);

		const contract = createContract("goal_corrupt");
		await store.createGoal(contract, { eventId: "evt-create", idempotencyKey: "create:goal_corrupt" });
		await appendFile(join(projectRoot, ".pi-xk", "goals", contract.goalId, "events.jsonl"), "not-json\n");
		await expect(store.replayGoal(contract.goalId)).rejects.toBeInstanceOf(GoalCorruptionError);
	});
});
