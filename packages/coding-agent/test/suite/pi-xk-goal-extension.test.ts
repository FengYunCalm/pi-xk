import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStore } from "../../../pi-xk-core/src/index.ts";
import {
	createPiXkGoalExtension,
	isPiXkGoalCapture,
	isPiXkSessionLink,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkGoalCapture,
	type PiXkSessionLink,
} from "../../../pi-xk-extension/src/index.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

type GoalBindingEntry = CustomEntry<PiXkSessionLink> & { data: PiXkSessionLink };
type GoalCaptureEntry = CustomEntry<PiXkGoalCapture> & { data: PiXkGoalCapture };

function isGoalBindingEntry(entry: SessionEntry): entry is GoalBindingEntry {
	return (
		entry.type === "custom" && entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE && isPiXkSessionLink(entry.data)
	);
}

function isGoalCaptureEntry(entry: SessionEntry): entry is GoalCaptureEntry {
	return (
		entry.type === "custom" && entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE && isPiXkGoalCapture(entry.data)
	);
}

function getCurrentGoalId(harness: Harness): string | undefined {
	for (const entry of [...harness.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkSessionLink(entry.data)
		) {
			return entry.data.goalId;
		}
	}
	return undefined;
}

function getGoalBindings(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter(isGoalBindingEntry)
		.map((entry) => entry.data);
}

async function waitForAgent(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
}

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("Pi-XK Goal extension", () => {
	it("creates a Goal from /goal without sending the raw objective and injects only an objective L0", async () => {
		const rawObjective = "Ship the release without leaking this objective.";
		let providerSystemPrompt = "";
		let providerText = "";
		let activeTurnSystemPrompt = "";
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => "goal_direct",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				providerText = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage("kickoff complete");
			},
			(context) => {
				activeTurnSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("active turn complete");
			},
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt(`/goal ${rawObjective}`);
		await waitForAgent(harness);

		const goalId = getCurrentGoalId(harness);
		expect(goalId).toBe("goal_direct");
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(providerText).not.toContain(rawObjective);
		expect(providerText).toContain("goal-objective.md");
		expect(providerText).not.toContain("goal-state.md");
		expect(providerText.match(/goal-objective\.md/g)).toHaveLength(1);
		expect(providerSystemPrompt).not.toContain("goal-state.md");
		expect(providerSystemPrompt).not.toContain(rawObjective);
		await harness.session.prompt("continue the active Goal");
		await waitForAgent(harness);
		expect(activeTurnSystemPrompt).toContain("goal-objective.md");
		expect(activeTurnSystemPrompt).not.toContain("goal-state.md");
		expect(activeTurnSystemPrompt.match(/goal-objective\.md/g)).toHaveLength(1);

		const goalStore = new GoalStore(harness.tempDir);
		const replayed = await goalStore.replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("active");
		expect(replayed.events.map((event) => event.eventType)).toContain("goal_run_started");
		expect(replayed.events.map((event) => event.eventType)).toContain("goal_run_settled");
		await expect(
			readFile(join(harness.tempDir, ".pi-xk", "goals", goalId!, "goal-objective.md"), "utf8"),
		).resolves.toContain(rawObjective);
	});

	it("cancels capture, supports reserved-word objectives, and replaces only the branch binding", async () => {
		const goalIds = ["goal_reserved", "goal_replacement"];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => goalIds.shift()! })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("ordinary after cancelled capture"),
			fauxAssistantMessage("reserved objective kickoff"),
			fauxAssistantMessage("replacement kickoff"),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal");
		await harness.session.prompt("/goal");
		const captures = harness.sessionManager
			.getBranch()
			.filter(isGoalCaptureEntry)
			.map((entry) => entry.data.state);
		expect(captures).toEqual(["open", "cancelled"]);

		await harness.session.prompt("ordinary after cancelled capture");
		await waitForAgent(harness);
		expect(getCurrentGoalId(harness)).toBeUndefined();

		await harness.session.prompt("/goal -- pause release until reviewed");
		await waitForAgent(harness);
		await harness.session.prompt("/goal replacement objective");
		await waitForAgent(harness);

		expect(getGoalBindings(harness)).toEqual([
			expect.objectContaining({ goalId: "goal_reserved", generation: 0 }),
			expect.objectContaining({ goalId: "goal_replacement", generation: 1 }),
		]);
		expect(getCurrentGoalId(harness)).toBe("goal_replacement");
		await expect(
			readFile(join(harness.tempDir, ".pi-xk", "goals", "goal_reserved", "goal-objective.md"), "utf8"),
		).resolves.toContain("pause release until reviewed");
	});

	it("captures a multiline objective, keeps pause sticky, and stops injection after end", async () => {
		const goalIds = ["goal_capture", "goal_unused"];
		const requestTexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => goalIds.shift()! })],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage("captured kickoff");
			},
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage("paused normal turn");
			},
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage("resumed kickoff");
			},
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage("ended normal turn");
			},
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal");
		expect(harness.getPendingResponseCount()).toBe(4);
		await harness.session.prompt("First line\nSecond line");
		await waitForAgent(harness);
		const goalId = getCurrentGoalId(harness);
		expect(goalId).toBe("goal_capture");

		await harness.session.prompt("/goal pause inspect state");
		await harness.session.prompt("ordinary paused prompt");
		await waitForAgent(harness);
		await harness.session.prompt("/goal start");
		await waitForAgent(harness);
		await harness.session.prompt("/goal end accepted");
		await harness.session.prompt("ordinary ended prompt");
		await waitForAgent(harness);

		expect(requestTexts).toHaveLength(4);
		expect(requestTexts[0]).toContain("goal-objective.md");
		expect(requestTexts[1]).not.toContain("goal-objective.md");
		expect(requestTexts[2]).toContain("goal-objective.md");
		expect(requestTexts[3]).not.toContain("goal-objective.md");
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("ended");
	});

	it("records model pause only after the final checkpoint and prevents later Goal checkpoints", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_model_pause" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("pi_xk_pause_goal", { reason: "need review", nextBestAction: "inspect evidence" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ordinary paused response"),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal Pause through the model tool");
		await waitForAgent(harness);
		const goalId = getCurrentGoalId(harness);
		const goalStore = new GoalStore(harness.tempDir);
		const paused = await goalStore.replayGoal(goalId!);
		const eventTypes = paused.events.map((event) => event.eventType);
		expect(paused.lifecycle.status).toBe("paused");
		expect(eventTypes.indexOf("goal_checkpointed")).toBeGreaterThan(-1);
		expect(eventTypes.indexOf("goal_checkpointed")).toBeLessThan(eventTypes.indexOf("goal_run_interrupted"));
		expect(eventTypes.indexOf("goal_run_interrupted")).toBeLessThan(eventTypes.indexOf("goal_paused"));
		const checkpointCount = eventTypes.filter((eventType) => eventType === "goal_checkpointed").length;

		await harness.session.prompt("ordinary prompt while paused");
		await waitForAgent(harness);
		const afterOrdinaryPrompt = await goalStore.replayGoal(goalId!);
		expect(afterOrdinaryPrompt.events.filter((event) => event.eventType === "goal_checkpointed")).toHaveLength(
			checkpointCount,
		);
	});

	it("records model end after the final checkpoint and preserves final outcome evidence", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_model_end" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "all checks passed",
						finalEvidence: "targeted tests are green",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal End through the model tool");
		await waitForAgent(harness);
		const goalId = getCurrentGoalId(harness);
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		const eventTypes = replayed.events.map((event) => event.eventType);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(eventTypes.indexOf("goal_checkpointed")).toBeLessThan(eventTypes.indexOf("goal_run_interrupted"));
		expect(eventTypes.indexOf("goal_run_interrupted")).toBeLessThan(eventTypes.indexOf("goal_ended"));
		expect(replayed.events.find((event) => event.eventType === "goal_ended")?.payload).toMatchObject({
			outcome: "accepted",
			reason: "all checks passed",
			finalEvidence: "targeted tests are green",
		});
	});
});
