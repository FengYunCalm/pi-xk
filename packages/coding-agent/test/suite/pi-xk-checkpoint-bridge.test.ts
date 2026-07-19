import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type GoalContractV1, GoalStore } from "../../../pi-xk-core/src/index.ts";
import {
	createPiXkExtension,
	createPiXkGoalBinding,
	isPiXkCheckpointRef,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkCheckpointRef,
} from "../../../pi-xk-extension/src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const projectRoots: string[] = [];
const harnesses: Harness[] = [];

function createContract(goalId: string): GoalContractV1 {
	return {
		schema: "pi-xk.goal.contract.v1",
		goalId,
		title: "Checkpoint bridge",
		objective: "Persist Pi turn checkpoints.",
		constraints: [],
		acceptance: [],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: "owner-session",
		createdAt: "2026-07-19T00:00:00.000Z",
		schemaVersion: 1,
	};
}

async function createGoalStore(goalId: string): Promise<GoalStore> {
	const projectRoot = await mkdtemp(join(tmpdir(), "pi-xk-checkpoint-"));
	projectRoots.push(projectRoot);
	const goalStore = new GoalStore(projectRoot);
	await goalStore.createGoal(createContract(goalId), {
		eventId: `evt-create-${goalId}`,
		idempotencyKey: `create:${goalId}`,
	});
	return goalStore;
}

function getCheckpointRefs(harness: Harness): PiXkCheckpointRef[] {
	const refs: PiXkCheckpointRef[] = [];
	for (const entry of harness.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkCheckpointRef(entry.data)
		) {
			refs.push(entry.data);
		}
	}
	return refs;
}

afterEach(async () => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	while (projectRoots.length > 0) {
		const projectRoot = projectRoots.pop();
		if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
	}
});

describe("Pi-XK checkpoint bridge", () => {
	it("repairs a missing checkpoint ref on the next session start without duplication", async () => {
		const goalId = "goal_checkpoint_repair";
		const goalStore = await createGoalStore(goalId);
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
				}),
			],
		});
		harnesses.push(harness);
		const leafId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "checkpoint source" }],
			timestamp: Date.now(),
		});
		const beforeCheckpoint = await goalStore.replayGoal(goalId);
		await goalStore.appendCheckpoint(
			goalId,
			{
				schema: "pi-xk.goal-checkpoint.v1",
				sessionId: harness.sessionManager.getSessionId(),
				leafId,
				turnIndex: 0,
				toolResultCount: 0,
				reason: "turn_end",
				createdAt: "2026-07-19T00:00:01.000Z",
			},
			{
				eventId: "evt-checkpoint-repair",
				idempotencyKey: "checkpoint:repair",
				expectedHead: beforeCheckpoint.head,
			},
		);

		await harness.session.bindExtensions({});
		expect(getCheckpointRefs(harness)).toHaveLength(1);
		await harness.session.reload();
		expect(getCheckpointRefs(harness)).toHaveLength(1);
	});

	it("persists tool-complete turns before appending deduplicated checkpoint refs", async () => {
		const goalId = "goal_checkpoint_bridge";
		const goalStore = await createGoalStore(goalId);
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("run echo");

		const replayed = await goalStore.replayGoal(goalId);
		const checkpoints = replayed.events.filter((event) => event.eventType === "goal_checkpointed");
		const checkpointRefs = getCheckpointRefs(harness);

		expect(checkpoints).toHaveLength(2);
		expect(checkpointRefs).toHaveLength(2);
		const toolCheckpoint = checkpoints.find((event) => event.payload.checkpoint.toolResultCount === 1);
		expect(toolCheckpoint).toBeDefined();
		const toolResultEntry = harness.sessionManager.getEntry(toolCheckpoint?.payload.checkpoint.leafId ?? "");
		expect(toolResultEntry).toMatchObject({ type: "message", message: { role: "toolResult" } });

		await harness.session.reload();
		expect(getCheckpointRefs(harness)).toHaveLength(2);
	});

	it("reports checkpoint persistence failures without changing the Pi turn", async () => {
		const errors: Error[] = [];
		const missingGoalRoot = await mkdtemp(join(tmpdir(), "pi-xk-missing-goal-"));
		projectRoots.push(missingGoalRoot);
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding("goal_missing", 0)],
					goalStore: new GoalStore(missingGoalRoot),
					onCheckpointError: (error) => errors.push(error),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Pi turn remains valid")]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("continue despite checkpoint failure");

		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(errors.length).toBeGreaterThan(0);
		expect(getCheckpointRefs(harness)).toEqual([]);
	});
});
