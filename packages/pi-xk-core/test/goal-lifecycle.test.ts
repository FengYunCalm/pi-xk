import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoalContractV2,
	GoalHeadConflictError,
	type GoalLifecycleEventInput,
	GoalLifecycleTransitionError,
	GoalStore,
} from "../src/index.ts";

const tempDirs: string[] = [];

function createContract(goalId: string): GoalContractV2 {
	return {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: "Lifecycle test",
		objective: "Exercise the Goal lifecycle projection.",
		constraints: [],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "Exercise the Goal lifecycle projection.",
				command: "npm run test:pi-xk",
				required: true,
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-lifecycle",
		createdAt: "2026-07-20T00:00:00.000Z",
		schemaVersion: 2,
		nonGoals: [],
		doneCondition: "All required acceptance has verified evidence.",
		pauseCondition: "No in-scope action can proceed without new input or evidence.",
		finalReport: "Report verified acceptance evidence.",
		executionAuthorization: "In-scope edits are authorized.",
	};
}

async function createStore(): Promise<{ store: GoalStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new GoalStore(projectRoot), projectRoot };
}

async function appendLifecycle(
	store: GoalStore,
	goalId: string,
	input: GoalLifecycleEventInput,
	timestamp: string,
): Promise<void> {
	const replay = await store.replayGoal(goalId);
	await store.appendLifecycleEvent(goalId, input, {
		eventId: `evt-${input.eventType}-${replay.head.sequence}`,
		idempotencyKey: `lifecycle:${input.eventType}:${replay.head.sequence}`,
		expectedHead: replay.head,
		timestamp,
	});
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("Goal lifecycle and files", () => {
	it("projects active, paused, ended, and settled run timing from the event log", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_lifecycle");
		await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_lifecycle",
			timestamp: "2026-07-20T00:00:00.000Z",
		});

		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_activated", payload: { sessionId: "session-lifecycle" } },
			"2026-07-20T00:00:10.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_run_started", payload: { runId: "run-first", sessionId: "session-lifecycle" } },
			"2026-07-20T00:00:20.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_run_settled", payload: { runId: "run-first" } },
			"2026-07-20T00:00:30.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{
				eventType: "goal_paused",
				payload: {
					reason: "review",
					userRequest: null,
					nextBestAction: "Resume after review.",
					audit: {
						unmetRequiredAcceptanceIds: ["A-1"],
						currentEvidence: "The lifecycle timing run is not complete.",
						incompleteConclusion: "Acceptance A-1 remains open.",
					},
				},
			},
			"2026-07-20T00:00:40.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_resumed", payload: { reason: "continue", resumeEvidence: "Review completed." } },
			"2026-07-20T00:01:00.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_run_started", payload: { runId: "run-second", sessionId: "session-lifecycle" } },
			"2026-07-20T00:01:10.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_run_settled", payload: { runId: "run-second" } },
			"2026-07-20T00:01:20.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{
				eventType: "goal_ended",
				payload: {
					outcome: "completed",
					reason: "accepted",
					verifiedAcceptanceIds: ["A-1"],
					finalEvidence: "Lifecycle timing assertions passed.",
					finalSummary: "The lifecycle projection is complete.",
				},
			},
			"2026-07-20T00:01:30.000Z",
		);

		const replayed = await store.replayGoal(contract.goalId, { now: "2026-07-20T00:02:00.000Z" });
		expect(replayed.lifecycle).toMatchObject({
			status: "ended",
			wallElapsed: 80_000,
			activeElapsed: 60_000,
			busyElapsed: 20_000,
		});
		expect(replayed.lifecycle.runs).toEqual([
			{
				runId: "run-first",
				sessionId: "session-lifecycle",
				startedAt: "2026-07-20T00:00:20.000Z",
				endedAt: "2026-07-20T00:00:30.000Z",
				status: "settled",
			},
			{
				runId: "run-second",
				sessionId: "session-lifecycle",
				startedAt: "2026-07-20T00:01:10.000Z",
				endedAt: "2026-07-20T00:01:20.000Z",
				status: "settled",
			},
		]);
	});

	it("rejects invalid lifecycle transitions and preserves idempotent event retries", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_lifecycle_transition");
		const created = await store.createGoal(contract, {
			eventId: "evt-create",
			idempotencyKey: "create:goal_lifecycle_transition",
		});

		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{
					eventType: "goal_paused",
					payload: {
						reason: "invalid",
						userRequest: null,
						nextBestAction: "Do not pause an inactive Goal.",
						audit: {
							unmetRequiredAcceptanceIds: ["A-1"],
							currentEvidence: "The Goal was never activated.",
							incompleteConclusion: "Acceptance A-1 remains open.",
						},
					},
				},
				{
					eventId: "evt-invalid-pause",
					idempotencyKey: "lifecycle:invalid-pause",
					expectedHead: created.head,
				},
			),
		).rejects.toBeInstanceOf(GoalLifecycleTransitionError);

		const activated = await store.appendLifecycleEvent(
			contract.goalId,
			{ eventType: "goal_activated", payload: { sessionId: "session-lifecycle" } },
			{
				eventId: "evt-activate",
				idempotencyKey: "lifecycle:activate",
				expectedHead: created.head,
			},
		);
		const retry = await store.appendLifecycleEvent(
			contract.goalId,
			{ eventType: "goal_activated", payload: { sessionId: "session-lifecycle" } },
			{
				eventId: "evt-activate-retry",
				idempotencyKey: "lifecycle:activate",
				expectedHead: created.head,
			},
		);

		expect(retry).toEqual(activated);
		await expect(
			store.appendLifecycleEvent(
				contract.goalId,
				{
					eventType: "goal_paused",
					payload: {
						reason: "stale writer",
						userRequest: null,
						nextBestAction: "Retry from the current head.",
						audit: {
							unmetRequiredAcceptanceIds: ["A-1"],
							currentEvidence: "The Goal remains active.",
							incompleteConclusion: "Acceptance A-1 remains open.",
						},
					},
				},
				{
					eventId: "evt-stale-pause",
					idempotencyKey: "lifecycle:stale-pause",
					expectedHead: created.head,
				},
			),
		).rejects.toBeInstanceOf(GoalHeadConflictError);
	});

	it("marks a crashed open run as interrupted without inventing busy time", async () => {
		const { store } = await createStore();
		const contract = createContract("goal_crashed_run");
		await store.createGoal(contract, { eventId: "evt-create", idempotencyKey: "create:goal_crashed_run" });
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_activated", payload: { sessionId: "session-lifecycle" } },
			"2026-07-20T00:00:00.000Z",
		);
		await appendLifecycle(
			store,
			contract.goalId,
			{ eventType: "goal_run_started", payload: { runId: "run-crashed", sessionId: "session-lifecycle" } },
			"2026-07-20T00:00:10.000Z",
		);

		const replayed = await store.replayGoal(contract.goalId, { now: "2026-07-20T00:00:30.000Z" });
		expect(replayed.lifecycle.busyElapsed).toBe(0);
		expect(replayed.lifecycle.runs).toEqual([
			{
				runId: "run-crashed",
				sessionId: "session-lifecycle",
				startedAt: "2026-07-20T00:00:10.000Z",
				status: "interrupted",
			},
		]);
	});

	it("creates identity-protected objective and mutable state files without repairing damage", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_files");
		await store.createGoal(contract, { eventId: "evt-create", idempotencyKey: "create:goal_files" });
		const goalDirectory = join(projectRoot, ".pi-xk", "goals", contract.goalId);
		const objective = await readFile(join(goalDirectory, "goal-objective.md"), "utf8");
		const statePath = join(goalDirectory, "goal-state.md");
		const state = await readFile(statePath, "utf8");

		expect(objective).toContain("goal-objective.md is read-only");
		expect(objective).toContain("read goal-state.md before every new agent run");
		expect(objective).toContain("A normal assistant response does not end this Goal");
		expect(objective).toContain("pi_xk_end_goal");
		expect(state).toContain("## done");
		expect(state).toContain("## next_best_action");
		expect(await store.inspectGoalFiles(contract.goalId)).toMatchObject({
			objective: { status: "valid" },
			state: { status: "valid" },
		});

		await writeFile(statePath, "<!-- pi-xk-goal-file: invalid -->\n");
		expect(await store.inspectGoalFiles(contract.goalId)).toMatchObject({ state: { status: "corrupt" } });
		expect(await readFile(statePath, "utf8")).toBe("<!-- pi-xk-goal-file: invalid -->\n");
	});

	it("detects objective body tampering and refreshes it after a contract update", async () => {
		const { store, projectRoot } = await createStore();
		const contract = createContract("goal_objective_integrity");
		const created = await store.createGoal(contract, {
			eventId: "evt-create-objective-integrity",
			idempotencyKey: "create:goal_objective_integrity",
		});
		const objectivePath = join(projectRoot, ".pi-xk", "goals", contract.goalId, "goal-objective.md");
		const original = await readFile(objectivePath, "utf8");
		const header = original.split("\n", 1)[0];
		await writeFile(objectivePath, `${header}\n# Goal Objective\n\nTampered objective body.\n`);

		expect(await store.inspectGoalFiles(contract.goalId)).toMatchObject({ objective: { status: "mismatched" } });

		const updatedContract = {
			...contract,
			objective: "Use the updated contract objective.",
		};
		await store.updateGoalContract(updatedContract, {
			eventId: "evt-update-objective-integrity",
			idempotencyKey: "update:goal_objective_integrity",
			expectedHead: created.head,
		});

		const refreshed = await readFile(objectivePath, "utf8");
		expect(refreshed).toContain("Use the updated contract objective.");
		expect(refreshed).not.toContain("Tampered objective body.");
		expect(await store.inspectGoalFiles(contract.goalId)).toMatchObject({ objective: { status: "valid" } });
	});
});
