import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type GoalContractV2, GoalStore } from "../../../pi-xk-core/src/index.ts";
import {
	createPiXkGoalBinding,
	createPiXkGoalExtension,
	isPiXkGoalCapture,
	isPiXkGoalDraft,
	isPiXkGoalLifecycleIntent,
	isPiXkSessionLink,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkGoalCapture,
	type PiXkGoalDraft,
	type PiXkGoalLifecycleIntent,
	type PiXkSessionLink,
} from "../../../pi-xk-extension/src/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

type GoalBindingEntry = CustomEntry<PiXkSessionLink> & { data: PiXkSessionLink };
type GoalCaptureEntry = CustomEntry<PiXkGoalCapture> & { data: PiXkGoalCapture };
type GoalDraftEntry = CustomEntry<PiXkGoalDraft> & { data: PiXkGoalDraft };
type GoalLifecycleIntentEntry = CustomEntry<PiXkGoalLifecycleIntent> & { data: PiXkGoalLifecycleIntent };

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

function isGoalDraftEntry(entry: SessionEntry): entry is GoalDraftEntry {
	return entry.type === "custom" && entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE && isPiXkGoalDraft(entry.data);
}

function isGoalLifecycleIntentEntry(entry: SessionEntry): entry is GoalLifecycleIntentEntry {
	return (
		entry.type === "custom" &&
		entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
		isPiXkGoalLifecycleIntent(entry.data)
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

function getGoalLifecycleIntents(harness: Harness): PiXkGoalLifecycleIntent[] {
	return harness.sessionManager
		.getEntries()
		.filter(isGoalLifecycleIntentEntry)
		.map((entry) => entry.data);
}

function getCurrentGoalDraft(harness: Harness): PiXkGoalDraft | undefined {
	return harness.sessionManager.getEntries().filter(isGoalDraftEntry).at(-1)?.data;
}

function draftProposal(objective: string) {
	return {
		title: "Verify drafted Goal",
		objective,
		constraints: ["Keep the test isolated."],
		acceptance: [
			{
				id: "A-1",
				kind: "test" as const,
				description: "The declared verification passes.",
				required: true,
				command: "npm run test:pi-xk",
			},
		],
		nonGoals: ["Do not create a Goal before confirmation."],
		doneCondition: "Required acceptance A-1 has verification evidence.",
		pauseCondition: "A user decision or external evidence is required.",
		finalReport: "Report the verified acceptance evidence.",
		executionAuthorization: "In-scope test and implementation edits are authorized.",
	};
}

function draftResponse(objective: string) {
	return fauxAssistantMessage([fauxToolCall("pi_xk_submit_goal_draft", draftProposal(objective))], {
		stopReason: "toolUse",
	});
}

function createUiContext(overrides: {
	select?: ExtensionUIContext["select"];
	input?: ExtensionUIContext["input"];
	notify?: ExtensionUIContext["notify"];
}): ExtensionUIContext {
	return {
		select: overrides.select ?? (async () => undefined),
		confirm: async () => false,
		input: overrides.input ?? (async () => undefined),
		notify: overrides.notify ?? (() => {}),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching is unavailable in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

async function waitForAgent(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
}

async function waitForProviderCalls(harness: Harness, minimumCalls: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (harness.faux.state.callCount >= minimumCalls) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`expected ${minimumCalls} provider calls, received ${harness.faux.state.callCount}`);
}

async function requestAndConfirmGoal(harness: Harness, objective: string): Promise<void> {
	await harness.session.prompt(`/goal ${objective}`);
	await waitForAgent(harness);
	expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "proposed", goalId: null });
	await harness.session.prompt("/goal confirm");
	await waitForAgent(harness);
}

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("Pi-XK Goal extension", () => {
	it("keeps a submitted Goal draft in the session until the user confirms it", async () => {
		const objective = "Draft a Goal without creating it immediately.";
		const draftPrompts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_confirmed_draft" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				draftPrompts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[fauxToolCall("pi_xk_submit_goal_draft", draftProposal("Confirm the drafted Goal."))],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the draft was confirmed and verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The confirmation flow completed.",
						finalSummary: "The confirmed Goal completed.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt(`/goal ${objective}`);
		await waitForAgent(harness);

		expect(getCurrentGoalId(harness)).toBeUndefined();
		expect(existsSync(join(harness.tempDir, ".pi-xk", "goals"))).toBe(false);
		expect(getCurrentGoalDraft(harness)).toMatchObject({
			state: "proposed",
			goalId: null,
			proposal: { objective: "Confirm the drafted Goal." },
		});
		expect(draftPrompts).toHaveLength(1);
		expect(draftPrompts[0]).toContain("Draft the contract only");
		expect(draftPrompts[0]).toContain("Do not put changing progress");
		expect(draftPrompts[0]).toContain("commit/push");
		expect(draftPrompts[0]).toContain(objective);

		await harness.session.prompt("/goal confirm");
		await waitForAgent(harness);

		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "confirmed", goalId: "goal_confirmed_draft" });
		expect((await new GoalStore(harness.tempDir).replayGoal("goal_confirmed_draft")).lifecycle.status).toBe("ended");
	});

	it("uses native UI to revise a draft and confirm the revised contract", async () => {
		const selectTitles: string[] = [];
		const selectOptions: string[][] = [];
		const inputCalls: Array<{ title: string; placeholder: string | undefined }> = [];
		const revisionPrompts: string[] = [];
		const choices = ["修改草案", "确认，启动 Goal"];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_ui_draft" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				revisionPrompts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return draftResponse("Initial drafted objective.");
			},
			(context) => {
				revisionPrompts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return draftResponse("Revised drafted objective.");
			},
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the revised contract was verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The revised contract passed verification.",
						finalSummary: "The revised Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const uiContext = createUiContext({
			select: async (title, options) => {
				selectTitles.push(title);
				selectOptions.push(options);
				return choices.shift();
			},
			input: async (title, placeholder) => {
				inputCalls.push({ title, placeholder });
				return "Require explicit release evidence.";
			},
		});

		await harness.session.bindExtensions({ uiContext, mode: "tui" });
		await harness.session.prompt("/goal Prepare a release Goal.");
		await waitForAgent(harness);

		expect(selectTitles).toHaveLength(2);
		expect(selectTitles[0]).toContain("# Goal Draft");
		expect(selectTitles[0]).not.toContain("passes..");
		expect(selectTitles[1]).toContain("Revised drafted objective.");
		expect(selectOptions).toEqual([
			["确认，启动 Goal", "修改草案"],
			["确认，启动 Goal", "修改草案"],
		]);
		expect(inputCalls).toEqual([{ title: "修改 Goal 草案", placeholder: "" }]);
		expect(revisionPrompts[1]).toContain("Revision feedback:\nRequire explicit release evidence.");
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "confirmed", goalId: "goal_ui_draft" });
		const replayed = await new GoalStore(harness.tempDir).replayGoal("goal_ui_draft");
		expect(replayed.contract.objective).toBe("Revised drafted objective.");
		expect(replayed.lifecycle.status).toBe("ended");
	});

	it("supports no-UI review, revise, and cancel without creating Goal files", async () => {
		let revisionPrompt = "";
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_cancelled_draft" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Initial no-UI draft."),
			(context) => {
				revisionPrompt = context.messages.map((message) => getMessageText(message)).join("\n");
				return draftResponse("Revised no-UI draft.");
			},
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal Prepare a no-UI Goal.");
		await waitForAgent(harness);
		await harness.session.prompt("/goal review");
		expect(harness.session.messages.map((message) => getMessageText(message)).join("\n")).toContain("# Goal Draft");

		await harness.session.prompt("/goal revise add explicit release evidence");
		await waitForAgent(harness);
		expect(revisionPrompt).toContain("Revision feedback:\nadd explicit release evidence");
		expect(revisionPrompt).not.toContain("# Goal Draft");
		expect(getCurrentGoalDraft(harness)).toMatchObject({
			state: "proposed",
			proposal: { objective: "Revised no-UI draft." },
		});

		await harness.session.prompt("/goal cancel");
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "cancelled", goalId: null });
		expect(existsSync(join(harness.tempDir, ".pi-xk", "goals"))).toBe(false);
	});

	it("keeps draft confirmation idempotent after the Goal has been created", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_idempotent_draft" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Confirm this draft once."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the Goal is complete",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The Goal completed after one confirmation.",
						finalSummary: "The Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Confirm this draft once.");
		const before = await new GoalStore(harness.tempDir).replayGoal("goal_idempotent_draft");
		const bindingCount = getGoalBindings(harness).length;

		await harness.session.prompt("/goal confirm");

		const after = await new GoalStore(harness.tempDir).replayGoal("goal_idempotent_draft");
		expect(after.events).toEqual(before.events);
		expect(getGoalBindings(harness)).toHaveLength(bindingCount);
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "confirmed", goalId: "goal_idempotent_draft" });
	});

	it("blocks every non-draft tool during a draft kickoff", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_isolated_draft" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_pause_goal", {
						reason: "invalid draft lifecycle request",
						userRequest: null,
						nextBestAction: "Submit the draft instead.",
						audit: {
							unmetRequiredAcceptanceIds: ["A-1"],
							currentEvidence: "No Goal exists.",
							incompleteConclusion: "The draft has not been confirmed.",
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
			draftResponse("Tool-isolated draft."),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal Isolate draft tools.");
		await waitForAgent(harness);

		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual([
			"A Goal draft kickoff only permits pi_xk_submit_goal_draft.",
			"A Goal draft kickoff only permits pi_xk_submit_goal_draft.",
			"Goal draft submitted for user review.",
		]);
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "proposed", goalId: null });
		expect(existsSync(join(harness.tempDir, ".pi-xk", "goals"))).toBe(false);
	});

	it("suppresses an existing active Goal while a replacement draft is pending", async () => {
		const goalId = "goal_existing_active";
		let draftRequest = "";
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_replacement_draft" })],
		});
		harnesses.push(harness);
		const store = new GoalStore(harness.tempDir);
		const contract: GoalContractV2 = {
			schema: "pi-xk.goal.contract.v2",
			goalId,
			title: "Existing active Goal",
			objective: "Remain active while a replacement draft is reviewed.",
			constraints: [],
			acceptance: [{ id: "A-1", kind: "artifact", description: "Verify replacement handling.", required: true }],
			capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
			budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
			ownerSessionId: harness.sessionManager.getSessionId(),
			createdAt: "2026-07-21T00:00:00.000Z",
			schemaVersion: 2,
			nonGoals: [],
			doneCondition: "Acceptance A-1 is verified.",
			pauseCondition: "External input is required.",
			finalReport: "Report replacement handling evidence.",
			executionAuthorization: "In-scope test and implementation edits are authorized.",
		};
		const created = await store.createGoal(contract, {
			eventId: "evt-create-existing-active",
			idempotencyKey: "create:existing-active",
			actor: "user",
		});
		await store.appendLifecycleEvent(
			goalId,
			{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
			{
				eventId: "evt-activate-existing-active",
				idempotencyKey: "activate:existing-active",
				actor: "user",
				expectedHead: created.head,
			},
		);
		harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
		harness.setResponses([
			(context) => {
				draftRequest = context.messages.map((message) => getMessageText(message)).join("\n");
				return draftResponse("Replacement draft objective.");
			},
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "invalid lifecycle change during draft review",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "No evidence should be committed.",
						finalSummary: "The old Goal must remain active.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The pending draft remains isolated."),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal Prepare a replacement Goal.");
		await waitForAgent(harness);
		await harness.session.prompt("Try to end the old Goal while the draft is pending.");
		await waitForAgent(harness);

		const replayed = await store.replayGoal(goalId);
		expect(replayed.lifecycle.status).toBe("active");
		expect(replayed.events.map((event) => event.eventType)).toEqual(["goal_created", "goal_activated"]);
		expect(draftRequest).toContain("Draft the contract only");
		expect(draftRequest).not.toContain("An active Pi-XK Goal is bound to this session.");
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toContain("Pi-XK Goal lifecycle tools are unavailable while a Goal draft is awaiting review.");
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "proposed", goalId: null });
	});

	it("keeps an active Goal running until the model explicitly ends it and exposes the termination contract", async () => {
		const requestTexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_continuous" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Continue until the model has verified completion."),
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage("The first concrete action is complete.");
			},
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "accepted",
							reason: "the acceptance evidence is complete",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "state and verification are current",
							finalSummary: "The declared acceptance is verified.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Continue until the model has verified completion.");

		expect(requestTexts).toHaveLength(2);
		for (const requestText of requestTexts) {
			expect(requestText).toContain("A normal assistant response does not end this Goal");
			expect(requestText).toContain("Do not repeat work already recorded as done");
			expect(requestText).toContain("pi_xk_end_goal");
		}
		const goalId = getCurrentGoalId(harness);
		const objective = await readFile(join(harness.tempDir, ".pi-xk", "goals", goalId!, "goal-objective.md"), "utf8");
		expect(objective).toContain("A normal assistant response does not end this Goal");
		expect(objective).toContain("pi_xk_end_goal");
		expect((await new GoalStore(harness.tempDir).replayGoal(goalId!)).lifecycle.status).toBe("ended");
	});

	it("backs off provider failures without ending the Goal before the model decides to end it", async () => {
		const retryCounts: number[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => "goal_retry",
					retryDelayMs: (failureCount) => {
						retryCounts.push(failureCount);
						return 0;
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Retry until the model confirms completion."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "temporary provider failure" }),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "recovered and verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The retry completed its verification.",
						finalSummary: "The recovered Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Retry until the model confirms completion.");
		await waitForProviderCalls(harness, 3);
		await waitForAgent(harness);

		const goalId = getCurrentGoalId(harness);
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(retryCounts).toEqual([1]);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(replayed.events.filter((event) => event.eventType === "goal_run_started")).toHaveLength(2);
	});

	it("drafts before creating a Goal and injects only Goal file paths into active runs", async () => {
		const rawObjective = "Ship the release without leaking this objective.";
		let draftText = "";
		let activeSystemPrompt = "";
		let activeKickoffText = "";
		let activeTurnText = "";
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
				draftText = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage(
					[fauxToolCall("pi_xk_submit_goal_draft", draftProposal("Ship the confirmed release."))],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				activeSystemPrompt = context.systemPrompt ?? "";
				activeKickoffText = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage("kickoff complete");
			},
			(context) => {
				activeTurnText = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_pause_goal", {
							reason: "verify the injected contract",
							userRequest: null,
							nextBestAction: "Resume after the contract review.",
							audit: {
								unmetRequiredAcceptanceIds: ["A-1"],
								currentEvidence: "The injected contract still needs review.",
								incompleteConclusion: "Acceptance A-1 remains open.",
							},
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, rawObjective);

		const goalId = getCurrentGoalId(harness);
		expect(goalId).toBe("goal_direct");
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(draftText).toContain(rawObjective);
		expect(draftText).toContain("Draft the contract only");
		expect(activeKickoffText).not.toContain(rawObjective);
		expect(activeKickoffText).toContain("goal-objective.md");
		expect(activeKickoffText).toContain("goal-state.md");
		expect(activeKickoffText.match(/goal-objective\.md/g)).toHaveLength(1);
		expect(activeSystemPrompt).not.toContain("goal-state.md");
		expect(activeSystemPrompt).not.toContain(rawObjective);
		expect(activeTurnText).toContain("goal-objective.md");
		expect(activeTurnText).toContain("A normal assistant response does not end this Goal");
		expect(activeTurnText).toContain("goal-state.md");
		expect(activeTurnText.match(/goal-objective\.md/g)).toHaveLength(1);

		const goalStore = new GoalStore(harness.tempDir);
		const replayed = await goalStore.replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.events.map((event) => event.eventType)).toContain("goal_run_started");
		expect(replayed.events.map((event) => event.eventType)).toContain("goal_run_settled");
		await expect(
			readFile(join(harness.tempDir, ".pi-xk", "goals", goalId!, "goal-objective.md"), "utf8"),
		).resolves.toContain("Ship the confirmed release.");
	});

	it("cancels capture, supports reserved-word objectives, and replaces only the branch binding", async () => {
		const goalIds = ["goal_reserved", "goal_replacement"];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => goalIds.shift()! })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("ordinary after cancelled capture"),
			draftResponse("Pause release until reviewed."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "reserved complete",
						reason: "reserved objective checked",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The reserved objective was checked.",
						finalSummary: "The reserved Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			draftResponse("Replacement objective."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "replacement complete",
						reason: "replacement checked",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The replacement objective was checked.",
						finalSummary: "The replacement Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
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
		await harness.session.prompt("/goal confirm");
		await waitForAgent(harness);
		await harness.session.prompt("/goal replacement objective");
		await waitForAgent(harness);
		await harness.session.prompt("/goal confirm");
		await waitForAgent(harness);

		expect(getGoalBindings(harness)).toEqual([
			expect.objectContaining({ goalId: "goal_reserved", generation: 0 }),
			expect.objectContaining({ goalId: "goal_replacement", generation: 1 }),
		]);
		expect(getCurrentGoalId(harness)).toBe("goal_replacement");
		await expect(
			readFile(join(harness.tempDir, ".pi-xk", "goals", "goal_reserved", "goal-objective.md"), "utf8"),
		).resolves.toContain("Pause release until reviewed.");
	});

	it("captures a multiline objective, keeps pause sticky, and stops injection after end", async () => {
		const goalIds = ["goal_capture", "goal_unused"];
		const goalErrors: string[] = [];
		const requestTexts: string[] = [];
		const requestSystemPrompts: string[] = [];
		let resumed = false;
		let pauseRequested = false;
		let endRequested = false;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => goalIds.shift()!,
					onGoalError: (error) => goalErrors.push(error.message),
				}),
			],
		});
		harnesses.push(harness);
		const respond: FauxResponseFactory = (context) => {
			const requestText = context.messages.map((message) => getMessageText(message)).join("\n");
			requestTexts.push(requestText);
			requestSystemPrompts.push(context.systemPrompt ?? "");
			if (!pauseRequested) {
				pauseRequested = true;
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_pause_goal", {
							reason: "inspect state",
							userRequest: null,
							nextBestAction: "resume after review",
							audit: {
								unmetRequiredAcceptanceIds: ["A-1"],
								currentEvidence: "The state review has not finished.",
								incompleteConclusion: "Acceptance A-1 remains open.",
							},
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (resumed && !endRequested) {
				endRequested = true;
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "accepted",
							reason: "review complete",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The state review is complete.",
							finalSummary: "The Goal is complete after review.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("ordinary response");
		};
		harness.setResponses([draftResponse("First line\nSecond line"), ...Array.from({ length: 8 }, () => respond)]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal");
		expect(harness.getPendingResponseCount()).toBe(9);
		await harness.session.prompt("First line\nSecond line");
		await waitForAgent(harness);
		await harness.session.prompt("/goal confirm");
		await waitForAgent(harness);
		const goalId = getCurrentGoalId(harness);
		expect(goalId).toBe("goal_capture");
		expect(goalErrors).toEqual([]);
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual(["Goal draft submitted for user review.", "Goal pause requested."]);
		expect(getGoalLifecycleIntents(harness)).toContainEqual(
			expect.objectContaining({ action: "pause", actor: "model", state: "committed" }),
		);
		expect((await new GoalStore(harness.tempDir).replayGoal(goalId!)).lifecycle.status).toBe("paused");

		await harness.session.prompt("ordinary paused prompt");
		await waitForAgent(harness);
		const pausedRequestIndex = requestTexts.findIndex((requestText) =>
			requestText.includes("ordinary paused prompt"),
		);
		expect(pausedRequestIndex).toBeGreaterThanOrEqual(0);
		expect(requestTexts[pausedRequestIndex]).not.toContain("goal-objective.md");
		const pausedSystemPrompt = requestSystemPrompts[pausedRequestIndex] ?? "";
		expect(pausedSystemPrompt).toContain("goal-objective.md");
		expect(pausedSystemPrompt).toContain("goal-state.md");
		expect(pausedSystemPrompt).toContain("Do not perform Goal work while this Goal remains paused.");

		resumed = true;
		await harness.session.prompt("/goal start");
		await waitForAgent(harness);
		expect((await new GoalStore(harness.tempDir).replayGoal(goalId!)).lifecycle.status).toBe("ended");

		await harness.session.prompt("ordinary ended prompt");
		await waitForAgent(harness);

		expect(requestTexts[0]).toContain("goal-objective.md");
		const endedRequest = requestTexts.find((requestText) => requestText.includes("ordinary ended prompt"));
		expect(endedRequest).toBeDefined();
		expect(endedRequest).not.toContain("goal-objective.md");
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("ended");
	});

	it("records model pause only after the final checkpoint and prevents later Goal checkpoints", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_model_pause" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Pause through the model tool."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_pause_goal", {
						reason: "need review",
						userRequest: null,
						nextBestAction: "inspect evidence",
						audit: {
							unmetRequiredAcceptanceIds: ["A-1"],
							currentEvidence: "The required evidence still needs review.",
							incompleteConclusion: "Acceptance A-1 remains open.",
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ordinary paused response"),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Pause through the model tool");
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

	it("lets the model resume a model-paused Goal only through a fresh active kickoff", async () => {
		const requestTexts: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_model_resume" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Pause until external evidence is available."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_pause_goal", {
						reason: "need external evidence",
						userRequest: null,
						nextBestAction: "Resume after the evidence arrives.",
						audit: {
							unmetRequiredAcceptanceIds: ["A-1"],
							currentEvidence: "The required evidence is unavailable.",
							incompleteConclusion: "Acceptance A-1 remains open.",
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_start_goal", {
							reason: "the requested evidence arrived",
							resumeEvidence: "The user supplied the external evidence.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requestTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "accepted",
							reason: "the resumed verification is complete",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The supplied evidence was verified.",
							finalSummary: "The resumed Goal is complete.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Pause until external evidence is available");
		const goalId = getCurrentGoalId(harness);
		expect((await new GoalStore(harness.tempDir).replayGoal(goalId!)).lifecycle.status).toBe("paused");

		await harness.session.prompt("The external evidence is now available.");
		await waitForAgent(harness);

		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual([
			"Goal draft submitted for user review.",
			"Goal pause requested.",
			"Goal start requested.",
			"Goal end requested.",
		]);
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(replayed.events.find((event) => event.eventType === "goal_resumed")?.actor).toBe("model");
		expect(replayed.events.find((event) => event.eventType === "goal_resumed")?.payload).toMatchObject({
			reason: "the requested evidence arrived",
			resumeEvidence: "The user supplied the external evidence.",
		});
		const pausedTurnIndex = requestTexts.findIndex((requestText) =>
			requestText.includes("The external evidence is now available."),
		);
		expect(pausedTurnIndex).toBeGreaterThanOrEqual(0);
		expect(requestTexts).toHaveLength(2);
		expect(requestTexts[pausedTurnIndex + 1]).toContain("Goal start requested.");
		expect(requestTexts[pausedTurnIndex + 1]).toContain("An active Pi-XK Goal is bound to this session.");
		expect(replayed.events.filter((event) => event.eventType === "goal_run_started")).toHaveLength(2);
	});

	it("rejects model starts for active and ended Goals", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_reject_start" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Reject invalid model starts."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_start_goal", {
						reason: "attempt to resume an active Goal",
						resumeEvidence: "No pause occurred.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the active Goal was verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The required evidence was verified.",
						finalSummary: "The Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_start_goal", {
						reason: "attempt to restart an ended Goal",
						resumeEvidence: "No restart is allowed.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The ended Goal remains historical."),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Reject invalid model starts");
		const goalId = getCurrentGoalId(harness);
		expect((await new GoalStore(harness.tempDir).replayGoal(goalId!)).lifecycle.status).toBe("ended");

		await harness.session.prompt("Try to restart the ended Goal.");
		await waitForAgent(harness);

		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual([
			"Goal draft submitted for user review.",
			"Goal start failed: only a paused Goal can be started",
			"Goal end requested.",
			"Goal start failed: only a paused Goal can be started",
		]);
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(replayed.events.filter((event) => event.eventType === "goal_resumed")).toHaveLength(0);
	});

	it("rejects model lifecycle acceptance IDs outside the current contract", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_reject_acceptance" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Reject unknown lifecycle acceptance IDs."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_pause_goal", {
						reason: "attempt to pause with an unknown acceptance",
						userRequest: null,
						nextBestAction: "Use a declared acceptance ID.",
						audit: {
							unmetRequiredAcceptanceIds: ["A-unknown"],
							currentEvidence: "The declared evidence is incomplete.",
							incompleteConclusion: "The Goal remains incomplete.",
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "attempt to end with an unknown acceptance",
						verifiedAcceptanceIds: ["A-unknown"],
						finalEvidence: "The evidence is present.",
						finalSummary: "The Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the required acceptance was verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The required evidence was verified.",
						finalSummary: "The Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Reject unknown lifecycle acceptance IDs");

		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual([
			"Goal draft submitted for user review.",
			"Goal pause failed: goal_paused.audit.unmetRequiredAcceptanceIds contains an unknown or ineligible acceptance ID: A-unknown",
			"Goal end failed: goal_ended.verifiedAcceptanceIds contains an unknown or ineligible acceptance ID: A-unknown",
			"Goal end requested.",
		]);
		const goalId = getCurrentGoalId(harness);
		const replayed = await new GoalStore(harness.tempDir).replayGoal(goalId!);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(replayed.events.filter((event) => event.eventType === "goal_paused")).toHaveLength(0);
		expect(replayed.events.filter((event) => event.eventType === "goal_ended")).toHaveLength(1);
	});

	it("lets the model resume a user-paused Goal after new evidence", async () => {
		const goalId = "goal_user_pause_resume";
		let recoverySystemPrompt = "";
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		const store = new GoalStore(harness.tempDir);
		const contract: GoalContractV2 = {
			schema: "pi-xk.goal.contract.v2",
			goalId,
			title: "Resume a user-paused Goal",
			objective: "Verify model recovery after an explicit user pause.",
			constraints: [],
			acceptance: [
				{
					id: "A-1",
					kind: "artifact",
					description: "Verify the resumed Goal outcome.",
					required: true,
				},
			],
			capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
			budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
			ownerSessionId: harness.sessionManager.getSessionId(),
			createdAt: "2026-07-21T00:00:00.000Z",
			schemaVersion: 2,
			nonGoals: [],
			doneCondition: "The required acceptance has verified evidence.",
			pauseCondition: "New user evidence is required.",
			finalReport: "Report the verified recovery evidence.",
			executionAuthorization: "In-scope test and implementation edits are authorized.",
		};
		const created = await store.createGoal(contract, {
			eventId: "evt-create-user-pause",
			idempotencyKey: "create:user-pause",
			actor: "user",
		});
		await store.appendLifecycleEvent(
			goalId,
			{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
			{
				eventId: "evt-activate-user-pause",
				idempotencyKey: "activate:user-pause",
				actor: "user",
				expectedHead: created.head,
			},
		);
		harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
		harness.setResponses([
			(context) => {
				recoverySystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_start_goal", {
							reason: "the user supplied the requested evidence",
							resumeEvidence: "The user provided the missing target environment.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the user evidence was verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The target environment was verified.",
						finalSummary: "The resumed Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("/goal pause wait for the user target environment");
		const paused = await store.replayGoal(goalId);
		expect(paused.lifecycle.status).toBe("paused");
		expect(paused.lifecycle.lastPause).toMatchObject({
			actor: "user",
			userRequest: "wait for the user target environment",
			audit: { unmetRequiredAcceptanceIds: ["A-1"] },
		});

		await harness.session.prompt("The target environment is now available.");
		await waitForAgent(harness);

		expect(recoverySystemPrompt).toContain("A paused Pi-XK Goal is bound to this session.");
		expect(recoverySystemPrompt).toContain("Do not perform Goal work while this Goal remains paused.");
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message)),
		).toEqual(["Goal start requested.", "Goal end requested."]);
		const replayed = await store.replayGoal(goalId);
		expect(replayed.lifecycle.status).toBe("ended");
		expect(replayed.events.find((event) => event.eventType === "goal_resumed")?.actor).toBe("model");
	});

	it("records model end after the final checkpoint and preserves final outcome evidence", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ createGoalId: () => "goal_model_end" })],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("End through the model tool."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "all checks passed",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "targeted tests are green",
						finalSummary: "All required acceptance is verified.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "End through the model tool");
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
