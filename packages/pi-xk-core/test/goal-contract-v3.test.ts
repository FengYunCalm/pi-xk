import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoalContractV2,
	type GoalContractV3,
	GoalRevisionConflictError,
	GoalStore,
	validateGoalContract,
} from "../src/index.ts";
import { stableJsonStringify } from "../src/stable-json.ts";

const tempDirs: string[] = [];

function createV2Contract(goalId: string): GoalContractV2 {
	return {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: "Legacy Goal",
		objective: "Complete the original objective.",
		constraints: ["Preserve verified behavior."],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "The focused tests pass.",
				required: true,
				command: "npm run test:pi-xk",
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "session-v3",
		createdAt: "2026-07-28T00:00:00.000Z",
		schemaVersion: 2,
		nonGoals: ["Do not add unrelated features."],
		doneCondition: "Every required acceptance has verified evidence.",
		pauseCondition: "No in-scope action can proceed without new input or evidence.",
		finalReport: "Report verified evidence and unresolved limits.",
		executionAuthorization: "In-scope implementation and verification are authorized.",
	};
}

function createV3Contract(goalId: string, revision = 1): GoalContractV3 {
	return {
		...createV2Contract(goalId),
		schema: "pi-xk.goal.contract.v3",
		schemaVersion: 3,
		revision,
		intentAnchor: "Deliver a complete and verified Goal workflow without changing the user's intended outcome.",
	};
}

async function createProjectRoot(): Promise<string> {
	const projectRoot = join(tmpdir(), `pi-xk-contract-v3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("Goal contract v3 revisions", () => {
	it("validates a new V3 contract with an intent anchor and positive revision", () => {
		const contract = createV3Contract("goal_v3_contract");
		expect(validateGoalContract(contract)).toEqual(contract);
		expect(() => validateGoalContract({ ...contract, revision: 0 })).toThrow("revision");
		expect(() => validateGoalContract({ ...contract, intentAnchor: "" })).toThrow("intentAnchor");
	});

	it("requires new V3 Goals to start at revision 1 and blocks the legacy V2 update path", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV3Contract("goal_v3_no_downgrade");

		await expect(
			store.createGoal(
				{ ...contract, revision: 2 },
				{
					eventId: "evt-invalid-create",
					idempotencyKey: "create:v3-invalid-revision",
				},
			),
		).rejects.toThrow("revision 1");

		const created = await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v3-no-downgrade",
		});
		await expect(
			store.updateGoalContract(createV2Contract(contract.goalId), {
				eventId: "evt-legacy-update",
				idempotencyKey: "update:v3-through-v2",
				expectedHead: created.head,
			}),
		).rejects.toThrow("V3");
		expect((await store.replayGoal(contract.goalId)).contract).toEqual(contract);
	});

	it("rejects a hash-valid legacy contract update after a V3 contract", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV3Contract("goal_v3_replay_downgrade");
		const created = await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v3-replay-downgrade",
		});
		const eventWithoutHash = {
			schema: "pi-xk.goal-event.v1",
			eventId: "evt-legacy-downgrade",
			goalId: contract.goalId,
			sequence: 2,
			eventType: "goal_contract_updated",
			actor: "runtime",
			timestamp: "2026-07-28T00:01:00.000Z",
			prevHash: created.head.hash,
			payload: { contract: createV2Contract(contract.goalId) },
			schemaVersion: 1,
			idempotencyKey: "update:v3-replay-downgrade",
		};
		const event = {
			...eventWithoutHash,
			hash: `sha256:${createHash("sha256").update(stableJsonStringify(eventWithoutHash)).digest("hex")}`,
		};
		await appendFile(
			join(projectRoot, ".pi-xk", "goals", contract.goalId, "events.jsonl"),
			`${stableJsonStringify(event)}\n`,
		);

		await expect(store.replayGoal(contract.goalId)).rejects.toThrow("V3");
	});

	it("publishes an automatic objective-only revision as a Goal event v2", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV3Contract("goal_v3_automatic");
		const created = await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v3-automatic",
			actor: "user",
			timestamp: contract.createdAt,
		});
		const candidate = {
			...contract,
			objective: "Complete the corrected implementation path and verify the same intended outcome.",
			revision: 2,
		};

		const updated = await store.reviseGoalContract(candidate, {
			eventId: "evt-revised",
			idempotencyKey: "revise:v3-automatic:2",
			actor: "model",
			timestamp: "2026-07-28T00:01:00.000Z",
			expectedHead: created.head,
			expectedRevision: 1,
			mode: "automatic-objective-refinement",
			reason: "The original module name no longer matches the repository.",
			evidence: "Repository inspection found the implementation under the corrected module.",
		});

		expect(updated.event).toMatchObject({
			schema: "pi-xk.goal-event.v2",
			schemaVersion: 2,
			eventType: "goal_contract_updated",
			payload: {
				fromRevision: 1,
				toRevision: 2,
				mode: "automatic-objective-refinement",
				changedFields: ["objective"],
			},
		});
		expect((await store.replayGoal(contract.goalId)).contract).toEqual(candidate);
	});

	it("rejects protected automatic changes and stale expected revisions", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV3Contract("goal_v3_protected");
		const created = await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v3-protected",
		});
		const options = {
			eventId: "evt-revised",
			idempotencyKey: "revise:v3-protected:2",
			expectedHead: created.head,
			expectedRevision: 1,
			mode: "automatic-objective-refinement" as const,
			reason: "Candidate refinement.",
			evidence: "Current repository evidence.",
		};

		await expect(
			store.reviseGoalContract(
				{ ...contract, constraints: ["Changed without confirmation."], revision: 2 },
				options,
			),
		).rejects.toThrow("objective");
		await expect(
			store.reviseGoalContract(
				{ ...contract, objective: "Refined objective.", revision: 2 },
				{
					...options,
					expectedRevision: 0,
				},
			),
		).rejects.toBeInstanceOf(GoalRevisionConflictError);
	});

	it("migrates V2 only through a user-confirmed revision and replays mixed v1/v2 events", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const legacy = createV2Contract("goal_v2_migration");
		const created = await store.createGoal(legacy, {
			eventId: "evt-created",
			idempotencyKey: "create:v2-migration",
			actor: "user",
			timestamp: legacy.createdAt,
		});
		const migrated = createV3Contract(legacy.goalId);

		await expect(
			store.reviseGoalContract(migrated, {
				eventId: "evt-auto-migration",
				idempotencyKey: "revise:v2-migration:auto",
				expectedHead: created.head,
				expectedRevision: 0,
				mode: "automatic-objective-refinement",
				reason: "Attempted automatic migration.",
				evidence: "No user confirmation exists.",
			}),
		).rejects.toThrow("user-confirmed");

		await store.reviseGoalContract(migrated, {
			eventId: "evt-confirmed-migration",
			idempotencyKey: "revise:v2-migration:confirmed",
			actor: "user",
			timestamp: "2026-07-28T00:02:00.000Z",
			expectedHead: created.head,
			expectedRevision: 0,
			mode: "user-confirmed",
			reason: "The user confirmed the immutable intent anchor and V3 contract.",
			evidence: "Visible contract diff was confirmed.",
		});

		const replay = await store.replayGoal(legacy.goalId);
		expect(replay.events.map((event) => event.schemaVersion)).toEqual([1, 2]);
		expect(replay.contract).toEqual(migrated);
		const raw = await readFile(join(projectRoot, ".pi-xk", "goals", legacy.goalId, "events.jsonl"), "utf8");
		expect(raw).toContain('"schema":"pi-xk.goal-event.v1"');
		expect(raw).toContain('"schema":"pi-xk.goal-event.v2"');
	});

	it("rejects unknown Goal event versions without rewriting prior bytes", async () => {
		const projectRoot = await createProjectRoot();
		const contract = createV3Contract("goal_unknown_event");
		const eventWithoutHash = {
			schema: "pi-xk.goal-event.v9",
			eventId: "evt-unknown",
			goalId: contract.goalId,
			sequence: 1,
			eventType: "goal_created",
			actor: "user",
			timestamp: contract.createdAt,
			prevHash: null,
			payload: { contract },
			schemaVersion: 9,
			idempotencyKey: "create:unknown",
		};
		const event = {
			...eventWithoutHash,
			hash: `sha256:${createHash("sha256").update(stableJsonStringify(eventWithoutHash)).digest("hex")}`,
		};
		const goalDirectory = join(projectRoot, ".pi-xk", "goals", contract.goalId);
		await mkdir(goalDirectory, { recursive: true });
		await writeFile(join(goalDirectory, "events.jsonl"), `${stableJsonStringify(event)}\n`);

		await expect(new GoalStore(projectRoot).replayGoal(contract.goalId)).rejects.toThrow("unsupported schema");
	});

	it("projects the V3 objective contract and diagnoses stale or unbounded execution state", async () => {
		const projectRoot = await createProjectRoot();
		const store = new GoalStore(projectRoot);
		const contract = createV3Contract("goal_v3_files");
		await store.createGoal(contract, {
			eventId: "evt-created",
			idempotencyKey: "create:v3-files",
		});
		const goalDirectory = join(projectRoot, ".pi-xk", "goals", contract.goalId);
		const objectivePath = join(goalDirectory, "goal-objective.md");
		const statePath = join(goalDirectory, "goal-state.md");
		const objective = await readFile(objectivePath, "utf8");
		const initialState = await readFile(statePath, "utf8");

		expect(objective).toContain("## Intent Anchor\n");
		expect(objective).toContain("## Current Objective\n");
		expect(objective).toContain(`## Title\n${contract.title}`);
		expect(objective).toContain(`- Goal ID: ${contract.goalId}`);
		expect(objective).toContain(`- Owner session: ${contract.ownerSessionId}`);
		expect(objective).toContain("## Capabilities\n");
		expect(objective).toContain("- filesystem: unrestricted");
		expect(objective).toContain("## Budgets\n");
		expect(objective).toContain("- tokens: 0");
		expect(objective).toContain("- A-1 (required, test): The focused tests pass.");
		expect(objective).toContain("  - Command: npm run test:pi-xk");
		expect(objective).toContain("## Canonical contract JSON\n");
		expect(objective).toContain(stableJsonStringify(contract));
		expect(objective).toContain("After the same method fails twice");
		expect(initialState).toContain("## contract_revision\n- 1");
		expect(initialState).toContain("## acceptance_matrix\n");
		expect(initialState).toContain("## recent_work_log\n");
		expect((await store.inspectGoalFiles(contract.goalId)).state.status).toBe("valid");

		await writeFile(statePath, initialState.replace("## contract_revision\n- 1", "## contract_revision\n- 0"));
		expect((await store.inspectGoalFiles(contract.goalId)).state).toMatchObject({
			status: "mismatched",
			detail: expect.stringContaining("contract revision"),
		});

		const workLog = Array.from({ length: 21 }, (_, index) => `- Important record ${index + 1}.`).join("\n");
		await writeFile(
			statePath,
			initialState.replace("## recent_work_log\n- Goal initialized.", `## recent_work_log\n${workLog}`),
		);
		expect((await store.inspectGoalFiles(contract.goalId)).state).toMatchObject({
			status: "mismatched",
			detail: expect.stringContaining("20"),
		});
	});
});
