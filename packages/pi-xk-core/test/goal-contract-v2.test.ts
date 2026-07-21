import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoalContractV1,
	type GoalContractV2,
	GoalStore,
	GoalValidationError,
	upcastGoalContract,
	validateGoalContract,
} from "../src/index.ts";
import { stableJsonStringify } from "../src/stable-json.ts";

const tempDirs: string[] = [];

function createV1Contract(goalId: string): GoalContractV1 {
	return {
		schema: "pi-xk.goal.contract.v1",
		goalId,
		title: "Legacy contract",
		objective: "Keep its on-disk bytes and hash intact.",
		constraints: ["Preserve legacy facts."],
		acceptance: [],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-v1",
		createdAt: "2026-07-21T00:00:00.000Z",
		schemaVersion: 1,
	};
}

function createV2Contract(goalId: string): GoalContractV2 {
	return {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: "V2 contract",
		objective: "Verify v2 Goal contracts and lifecycle facts.",
		constraints: ["Preserve raw v1 event hashes."],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "Run the focused tests.",
				command: "npm run test:pi-xk",
				required: true,
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-v2",
		createdAt: "2026-07-21T00:00:00.000Z",
		schemaVersion: 2,
		nonGoals: ["Do not modify legacy event bytes."],
		doneCondition: "Every required acceptance has verified evidence.",
		pauseCondition: "No in-scope action can continue without new input or evidence.",
		finalReport: "Report verified acceptance evidence and any remaining limits.",
		executionAuthorization: "In-scope code, test, script, and formal-document edits are authorized.",
	};
}

async function createProjectRoot(): Promise<string> {
	const projectRoot = join(tmpdir(), `pi-xk-contract-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return projectRoot;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("Goal contract v2", () => {
	it("upcasts a raw v1 event only in memory while preserving its bytes and hash", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const legacy = createV1Contract("goal_v1_replay");
		const eventWithoutHash = {
			schema: "pi-xk.goal-event.v1" as const,
			eventId: "evt-v1-created",
			goalId: legacy.goalId,
			sequence: 1,
			eventType: "goal_created" as const,
			actor: "user" as const,
			timestamp: legacy.createdAt,
			prevHash: null,
			payload: { contract: legacy },
			schemaVersion: 1 as const,
			idempotencyKey: "create:v1-replay",
		};
		const event = {
			...eventWithoutHash,
			hash: `sha256:${createHash("sha256").update(stableJsonStringify(eventWithoutHash)).digest("hex")}`,
		};
		const eventsPath = join(projectRoot, ".pi-xk", "goals", legacy.goalId, "events.jsonl");
		const rawEvents = `${stableJsonStringify(event)}\n`;
		await mkdir(join(projectRoot, ".pi-xk", "goals", legacy.goalId), { recursive: true });
		await writeFile(eventsPath, rawEvents);

		const replayed = await store.replayGoal(legacy.goalId);

		expect(replayed.events[0]?.payload).toEqual({ contract: legacy });
		expect(replayed.sourceContract).toEqual(legacy);
		expect(replayed.contract).toEqual(upcastGoalContract(legacy));
		expect(await readFile(eventsPath, "utf8")).toBe(rawEvents);

		await store.rebuildContractProjection(legacy.goalId);
		const projection = JSON.parse(
			await readFile(join(projectRoot, ".pi-xk", "goals", legacy.goalId, "contract.json"), "utf8"),
		) as { contract: GoalContractV2 };
		expect(projection.contract).toEqual(upcastGoalContract(legacy));
	});

	it("accepts only v2 contracts for new Goals and requires a required acceptance", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const v2 = createV2Contract("goal_v2_writer");

		expect(validateGoalContract(v2)).toEqual(v2);
		expect(() =>
			validateGoalContract({
				...v2,
				acceptance: [{ ...v2.acceptance[0], required: false }],
			}),
		).toThrow("required acceptance");
		await expect(
			store.createGoal(createV1Contract("goal_v1_writer") as never, {
				eventId: "evt-v1-writer",
				idempotencyKey: "create:v1-writer",
			}),
		).rejects.toBeInstanceOf(GoalValidationError);
		await expect(
			store.createGoal(v2, {
				eventId: "evt-v2-writer",
				idempotencyKey: "create:v2-writer",
			}),
		).resolves.toMatchObject({ head: { sequence: 1 } });
	});

	it("requires pause audits and end acceptance evidence for v2 lifecycle events", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV2Contract("goal_v2_lifecycle");
		const created = await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v2-lifecycle",
		});
		const activated = await store.appendLifecycleEvent(
			contract.goalId,
			{ eventType: "goal_activated", payload: { sessionId: "session-v2" } },
			{ eventId: "evt-activated", idempotencyKey: "activate:v2-lifecycle", expectedHead: created.head },
		);

		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{ eventType: "goal_paused", payload: { reason: "needs input" } },
				{ eventId: "evt-invalid-pause", idempotencyKey: "pause:invalid", expectedHead: activated.head },
			),
		).rejects.toBeInstanceOf(GoalValidationError);

		const paused = await store.appendLifecycleEvent(
			contract.goalId,
			{
				eventType: "goal_paused",
				payload: {
					reason: "needs user input",
					userRequest: "Provide the target environment.",
					nextBestAction: "Resume after the target is supplied.",
					audit: {
						unmetRequiredAcceptanceIds: ["A-1"],
						currentEvidence: "No target environment has been supplied.",
						incompleteConclusion: "The required test cannot run yet.",
					},
				},
			},
			{ eventId: "evt-paused", idempotencyKey: "pause:valid", expectedHead: activated.head },
		);
		expect((await store.replayGoal(contract.goalId)).lifecycle.lastPause).toMatchObject({
			actor: "runtime",
			audit: { unmetRequiredAcceptanceIds: ["A-1"] },
		});

		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{ eventType: "goal_resumed", payload: { reason: "input arrived" } },
				{ eventId: "evt-invalid-resume", idempotencyKey: "resume:invalid", expectedHead: paused.head },
			),
		).rejects.toBeInstanceOf(GoalValidationError);

		const resumed = await store.appendLifecycleEvent(
			contract.goalId,
			{
				eventType: "goal_resumed",
				payload: { reason: "input arrived", resumeEvidence: "Target environment is available." },
			},
			{ eventId: "evt-resumed", idempotencyKey: "resume:valid", expectedHead: paused.head },
		);
		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{
					eventType: "goal_ended",
					payload: {
						outcome: "completed",
						reason: "test passed",
						verifiedAcceptanceIds: [],
						finalEvidence: "npm run test:pi-xk passed",
						finalSummary: "All work is complete.",
					},
				},
				{ eventId: "evt-invalid-end", idempotencyKey: "end:invalid", expectedHead: resumed.head },
			),
		).rejects.toBeInstanceOf(GoalValidationError);

		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{
					eventType: "goal_ended",
					payload: {
						outcome: "completed",
						reason: "test passed",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "npm run test:pi-xk passed",
						finalSummary: "All required acceptance is verified.",
					},
				},
				{ eventId: "evt-ended", idempotencyKey: "end:valid", expectedHead: resumed.head },
			),
		).resolves.toMatchObject({ head: { sequence: 5 } });
	});
});
