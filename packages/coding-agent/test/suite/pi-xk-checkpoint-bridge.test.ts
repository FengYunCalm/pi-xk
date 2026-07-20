import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, type GoalCheckpointV2, type GoalContractV1, GoalStore } from "../../../pi-xk-core/src/index.ts";
import {
	createPiXkExtension,
	createPiXkGoalBinding,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkCheckpointIntent,
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

async function createGoalStore(goalId: string): Promise<{ goalStore: GoalStore; projectRoot: string }> {
	const projectRoot = await mkdtemp(join(tmpdir(), "pi-xk-checkpoint-"));
	projectRoots.push(projectRoot);
	const goalStore = new GoalStore(projectRoot);
	await goalStore.createGoal(createContract(goalId), {
		eventId: `evt-create-${goalId}`,
		idempotencyKey: `create:${goalId}`,
	});
	return { goalStore, projectRoot };
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

function getCheckpointIntents(harness: Harness): PiXkCheckpointIntent[] {
	const intents: PiXkCheckpointIntent[] = [];
	for (const entry of harness.sessionManager.getEntries()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkCheckpointIntent(entry.data)
		) {
			intents.push(entry.data);
		}
	}
	return intents;
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
	it("requires an explicit checkpoint diagnostic receiver with a GoalStore", () => {
		const goalStore = new GoalStore("/tmp/pi-xk-checkpoint-diagnostic");

		expect(() =>
			createPiXkExtension({
				bindings: [createPiXkGoalBinding("goal_diagnostic", 0)],
				goalStore,
			}),
		).toThrow("onCheckpointError");
	});

	it("repairs a missing checkpoint ref on the next session start without duplication", async () => {
		const goalId = "goal_checkpoint_repair";
		const { goalStore, projectRoot } = await createGoalStore(goalId);
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
					onCheckpointError: () => {},
				}),
			],
		});
		harnesses.push(harness);
		const leafId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "checkpoint source" }],
			timestamp: Date.now(),
		});
		const artifact = await new ArtifactStore(projectRoot).put({
			contentType: "application/json",
			value: { sessionId: harness.sessionManager.getSessionId(), leafId, toolResultCount: 0 },
			producer: "pi-xk.checkpoint-evidence.v1",
			sensitivity: "redacted",
			sourceIds: [harness.sessionManager.getSessionId(), leafId],
			createdAt: "2026-07-19T00:00:01.000Z",
		});
		const checkpoint: GoalCheckpointV2 = {
			schema: "pi-xk.goal-checkpoint.v2",
			sessionId: harness.sessionManager.getSessionId(),
			leafId,
			turnIndex: 0,
			toolResultCount: 0,
			reason: "turn_end",
			createdAt: "2026-07-19T00:00:01.000Z",
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
		const beforeCheckpoint = await goalStore.replayGoal(goalId);
		await goalStore.appendCheckpoint(goalId, checkpoint, {
			eventId: "evt-checkpoint-repair",
			idempotencyKey: "checkpoint:repair",
			expectedHead: beforeCheckpoint.head,
		});

		await harness.session.bindExtensions({});
		expect(getCheckpointRefs(harness)).toHaveLength(1);
		await harness.session.reload();
		expect(getCheckpointRefs(harness)).toHaveLength(1);
	});

	it("persists tool-complete turns before appending deduplicated checkpoint refs", async () => {
		const goalId = "goal_checkpoint_bridge";
		const { goalStore, projectRoot } = await createGoalStore(goalId);
		const lifecycle: string[] = [];
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
					onCheckpointError: () => {},
					onLifecycle: (event) => lifecycle.push(event.type),
				}),
			],
		});
		harnesses.push(harness);
		const secret = "sk-secret-12345678901234567890";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: secret })], { stopReason: "toolUse" }),
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
		const checkpoint = toolCheckpoint?.payload.checkpoint;
		if (!checkpoint || checkpoint.schema !== "pi-xk.goal-checkpoint.v2") {
			throw new Error("tool checkpoint must use v2 evidence");
		}
		const artifactId = checkpoint.evidence.artifacts[0]?.artifactId;
		if (!artifactId) throw new Error("tool checkpoint evidence must reference an artifact");
		const artifact = await new ArtifactStore(projectRoot).read(artifactId);
		expect(artifact.content).toContain(checkpoint.leafId);
		expect(artifact.content).not.toContain(secret);

		await harness.session.reload();
		expect(getCheckpointRefs(harness)).toHaveLength(2);
		expect(lifecycle).toContain("agent_end");
		expect(lifecycle.indexOf("agent_end")).toBeLessThan(lifecycle.indexOf("agent_settled"));
	});

	it("drains a pending turn checkpoint before session shutdown completes", async () => {
		const goalId = "goal_shutdown_retry";
		const { goalStore } = await createGoalStore(goalId);
		const shutdownCheckpointCounts: number[] = [];
		const observer: ExtensionFactory = (pi) => {
			pi.on("session_shutdown", async () => {
				const replayed = await goalStore.replayGoal(goalId);
				shutdownCheckpointCounts.push(
					replayed.events.filter((event) => event.eventType === "goal_checkpointed").length,
				);
			});
		};
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
					onCheckpointError: () => {},
				}),
				observer,
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		const leafId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persist before shutdown" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkTurnCheckpointIntent(
				goalId,
				harness.sessionManager.getSessionId(),
				leafId,
				0,
				0,
				0,
				"2026-07-19T00:00:01.000Z",
			),
		);

		await harness.session.reload();

		expect(shutdownCheckpointCounts).toEqual([1]);
		expect(getCheckpointRefs(harness)).toHaveLength(1);
	});

	it("retries a persisted turn checkpoint after its Goal is created and the session reloads", async () => {
		const goalId = "goal_checkpoint_retry";
		const projectRoot = await mkdtemp(join(tmpdir(), "pi-xk-pending-checkpoint-"));
		projectRoots.push(projectRoot);
		const goalStore = new GoalStore(projectRoot);
		const errors: Error[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
					onCheckpointError: (error) => errors.push(error),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("retry this checkpoint")]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("write checkpoint before Goal creation");
		const pendingTurnIntent = getCheckpointIntents(harness).find((intent) => intent.reason === "turn_end");
		expect(pendingTurnIntent).toBeDefined();
		await goalStore.createGoal(createContract(goalId), {
			eventId: "evt-create-retry",
			idempotencyKey: "create:goal_checkpoint_retry",
		});
		await harness.session.reload();

		const replayed = await goalStore.replayGoal(goalId);
		const checkpoints = replayed.events.filter((event) => event.eventType === "goal_checkpointed");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.payload.checkpoint.leafId).toBe(pendingTurnIntent?.leafId);
		expect(getCheckpointRefs(harness)).toHaveLength(1);
		expect(errors.length).toBeGreaterThan(0);
	});

	it("writes a source-only checkpoint intent before native compaction", async () => {
		const goalId = "goal_compaction_intent";
		const { goalStore } = await createGoalStore(goalId);
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				createPiXkExtension({
					bindings: [createPiXkGoalBinding(goalId, 0)],
					goalStore,
					onCheckpointError: () => {},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("native Pi history summary"),
			fauxAssistantMessage("native Pi turn prefix"),
		]);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user message" }],
			timestamp: Date.now() - 3_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("first assistant message"));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second user message" }],
			timestamp: Date.now() - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("second assistant message"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await harness.session.bindExtensions({});
		const sourceLeafId = harness.sessionManager.getLeafId();
		await harness.session.compact();

		const compactionIntents = getCheckpointIntents(harness).filter(
			(intent) => intent.reason === "session_before_compact",
		);
		expect(compactionIntents).toHaveLength(1);
		expect(compactionIntents[0]).toMatchObject({
			goalId,
			leafId: sourceLeafId,
			reason: "session_before_compact",
		});
		const replayed = await goalStore.replayGoal(goalId);
		const compactionCheckpoint = replayed.events.find(
			(event) =>
				event.eventType === "goal_checkpointed" && event.payload.checkpoint.reason === "session_before_compact",
		);
		if (!compactionCheckpoint || compactionCheckpoint.eventType !== "goal_checkpointed") {
			throw new Error("compaction-before checkpoint was not persisted");
		}
		expect(compactionCheckpoint.payload.checkpoint).toMatchObject({
			schema: "pi-xk.goal-checkpoint.v2",
			leafId: sourceLeafId,
			reason: "session_before_compact",
		});
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

	it("contains checkpoint diagnostic receiver failures without changing the Pi lifecycle", async () => {
		let callbackCalls = 0;
		const recoveredGoalId = "goal_throwing_diagnostic_recovered";
		const { goalStore } = await createGoalStore(recoveredGoalId);
		const harness = await createHarness({
			extensionFactories: [
				createPiXkExtension({
					bindings: [
						createPiXkGoalBinding("goal_throwing_diagnostic_missing", 0),
						createPiXkGoalBinding(recoveredGoalId, 0),
					],
					goalStore,
					onCheckpointError: () => {
						callbackCalls += 1;
						throw new Error("host diagnostic receiver failed");
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Pi turn remains valid after diagnostic receiver failure")]);
		const leafId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "pending checkpoint for the second Goal" }],
			timestamp: Date.now(),
		});
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkTurnCheckpointIntent(
				recoveredGoalId,
				harness.sessionManager.getSessionId(),
				leafId,
				0,
				0,
				0,
				"2026-07-19T00:00:01.000Z",
			),
		);

		await expect(harness.session.bindExtensions({})).resolves.toBeUndefined();
		await expect(harness.session.prompt("continue despite diagnostic receiver failure")).resolves.toBeUndefined();

		const replayed = await goalStore.replayGoal(recoveredGoalId);
		const persistedPendingCheckpoint = replayed.events.find(
			(event) => event.eventType === "goal_checkpointed" && event.payload.checkpoint.leafId === leafId,
		);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
		expect(callbackCalls).toBeGreaterThan(0);
		expect(persistedPendingCheckpoint).toBeDefined();
		expect(getCheckpointRefs(harness).some((ref) => ref.eventId === persistedPendingCheckpoint?.eventId)).toBe(true);
	});
});
