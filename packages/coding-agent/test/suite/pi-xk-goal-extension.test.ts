import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type GoalCheckpointV2,
	type GoalContractUpdateOptions,
	type GoalContractV2,
	type GoalContractV3,
	GoalStore,
	type GoalWriteResult,
} from "../../../pi-xk-core/src/index.ts";
import { createGoalDraftReviewComponent } from "../../../pi-xk-extension/src/goal-ui.ts";
import {
	createPiXkGoalBinding,
	createPiXkGoalDraft,
	createPiXkGoalExtension,
	createPiXkGoalLifecycleIntent,
	createPiXkGoalRevision,
	isPiXkGoalCapture,
	isPiXkGoalDraft,
	isPiXkGoalLifecycleIntent,
	isPiXkGoalRevision,
	isPiXkSessionLink,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkGoalCapture,
	type PiXkGoalDraft,
	type PiXkGoalLifecycleIntent,
	type PiXkGoalRevision,
	type PiXkSessionLink,
} from "../../../pi-xk-extension/src/index.ts";
import type { ExtensionUIContext, KeybindingsManager } from "../../src/core/extensions/index.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

type GoalBindingEntry = CustomEntry<PiXkSessionLink> & { data: PiXkSessionLink };
type GoalCaptureEntry = CustomEntry<PiXkGoalCapture> & { data: PiXkGoalCapture };
type GoalDraftEntry = CustomEntry<PiXkGoalDraft> & { data: PiXkGoalDraft };
type GoalLifecycleIntentEntry = CustomEntry<PiXkGoalLifecycleIntent> & { data: PiXkGoalLifecycleIntent };
type CustomUiOptions = Parameters<ExtensionUIContext["custom"]>[1];
type CustomUiComponent = Component & { dispose?(): void };
type CustomUiFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => CustomUiComponent | Promise<CustomUiComponent>;

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

function getCurrentGoalRevision(harness: Harness): PiXkGoalRevision | undefined {
	for (const entry of [...harness.sessionManager.getEntries()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkGoalRevision(entry.data)
		) {
			return entry.data;
		}
	}
	return undefined;
}

function draftProposal(objective: string) {
	return {
		title: "Verify drafted Goal",
		intentAnchor: "Deliver the user-confirmed Goal outcome with verified evidence.",
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

async function createActiveGoal(harness: Harness, goalId: string): Promise<GoalStore> {
	const store = new GoalStore(harness.tempDir);
	const proposal = draftProposal(`Exercise lifecycle behavior for ${goalId}.`);
	const contract: GoalContractV2 = {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: proposal.title,
		objective: proposal.objective,
		constraints: proposal.constraints,
		acceptance: proposal.acceptance,
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: harness.sessionManager.getSessionId(),
		createdAt: "2026-07-21T00:00:00.000Z",
		schemaVersion: 2,
		nonGoals: proposal.nonGoals,
		doneCondition: proposal.doneCondition,
		pauseCondition: proposal.pauseCondition,
		finalReport: proposal.finalReport,
		executionAuthorization: proposal.executionAuthorization,
	};
	const created = await store.createGoal(contract, {
		eventId: `evt-create-${goalId}`,
		idempotencyKey: `create:${goalId}`,
		actor: "user",
		timestamp: contract.createdAt,
	});
	await store.appendLifecycleEvent(
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
		{
			eventId: `evt-activate-${goalId}`,
			idempotencyKey: `activate:${goalId}`,
			actor: "user",
			timestamp: contract.createdAt,
			expectedHead: created.head,
		},
	);
	harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
	return store;
}

async function createActiveV3Goal(
	harness: Harness,
	goalId: string,
): Promise<{ store: GoalStore; contract: GoalContractV3 }> {
	const store = new GoalStore(harness.tempDir);
	const proposal = draftProposal(`Exercise V3 revision behavior for ${goalId}.`);
	const contract: GoalContractV3 = {
		schema: "pi-xk.goal.contract.v3",
		goalId,
		title: proposal.title,
		intentAnchor: proposal.intentAnchor,
		objective: proposal.objective,
		constraints: proposal.constraints,
		acceptance: proposal.acceptance,
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: harness.sessionManager.getSessionId(),
		createdAt: "2026-07-28T00:00:00.000Z",
		schemaVersion: 3,
		revision: 1,
		nonGoals: proposal.nonGoals,
		doneCondition: proposal.doneCondition,
		pauseCondition: proposal.pauseCondition,
		finalReport: proposal.finalReport,
		executionAuthorization: proposal.executionAuthorization,
	};
	const created = await store.createGoal(contract, {
		eventId: `evt-create-${goalId}`,
		idempotencyKey: `create:${goalId}`,
		actor: "user",
		timestamp: contract.createdAt,
	});
	await store.appendLifecycleEvent(
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
		{
			eventId: `evt-activate-${goalId}`,
			idempotencyKey: `activate:${goalId}`,
			actor: "user",
			timestamp: contract.createdAt,
			expectedHead: created.head,
		},
	);
	harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
	return { store, contract };
}

function createUiContext(overrides: {
	select?: ExtensionUIContext["select"];
	input?: ExtensionUIContext["input"];
	notify?: ExtensionUIContext["notify"];
	setStatus?: ExtensionUIContext["setStatus"];
	custom?: ExtensionUIContext["custom"];
	editor?: ExtensionUIContext["editor"];
}): ExtensionUIContext {
	return {
		select: overrides.select ?? (async () => undefined),
		confirm: async () => false,
		input: overrides.input ?? (async () => undefined),
		notify: overrides.notify ?? (() => {}),
		onTerminalInput: () => () => {},
		setStatus: overrides.setStatus ?? (() => {}),
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: overrides.custom ?? (async <T>() => undefined as T),
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: overrides.editor ?? (async () => undefined),
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

function createPlainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

async function waitForAgent(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
}

async function waitForProviderCalls(harness: Harness, minimumCalls: number): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
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
	vi.useRealTimers();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("Pi-XK Goal extension", () => {
	it("reports and explicitly repairs an abandoned Goal write lock", async () => {
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createUiContext({ notify: (message) => notifications.push(message) }),
		});
		const goalId = "goal_doctor_abandoned_lock";
		const store = await createActiveGoal(harness, goalId);
		await writeFile(
			join(harness.tempDir, ".pi-xk", "goals", goalId, ".write.lock"),
			`${JSON.stringify({
				pid: 999_999_999,
				nonce: "abandoned-goal-command",
				createdAt: "2026-07-25T00:00:00.000Z",
			})}\n`,
		);

		await harness.session.prompt("/goal doctor");
		expect(notifications.at(-1)).toContain("write lock owner PID 999999999 is missing");
		expect(notifications.at(-1)).toContain("/goal doctor repair-lock abandoned-goal-command");

		await harness.session.prompt("/goal doctor repair-lock abandoned-goal-command");
		expect(notifications.at(-1)).toContain("repaired abandoned write lock");
		expect(await store.inspectWriteLock(goalId)).toBeUndefined();
	});

	it("reports stale V3 state revisions and reads the V3 acceptance matrix in status", async () => {
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createUiContext({ notify: (message) => notifications.push(message) }),
		});
		const goalId = "goal_v3_state_doctor";
		await createActiveV3Goal(harness, goalId);

		await harness.session.prompt("/goal status");
		expect(notifications.at(-1)).toContain("Acceptance ledger: A-1: required; unverified; evidence not recorded.");

		const statePath = join(harness.tempDir, ".pi-xk", "goals", goalId, "goal-state.md");
		const state = await readFile(statePath, "utf8");
		await writeFile(statePath, state.replace("## contract_revision\n- 1", "## contract_revision\n- 0"));

		await harness.session.prompt("/goal doctor");
		const doctor = notifications.at(-1) ?? "";
		expect(doctor).toContain("write lock clear");
		expect(doctor).toContain(`${statePath}: mismatched`);
		expect(doctor).toContain("state contract revision 0 does not match current revision 1");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("pauses an active Goal recovered at session startup instead of continuing it", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const store = await createActiveGoal(harness, "goal_recovered_paused");

		await harness.session.bindExtensions({});

		const replayed = await store.replayGoal("goal_recovered_paused");
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.lifecycle.lastPause).toMatchObject({
			actor: "runtime",
			reason: expect.stringContaining("session start"),
			audit: { unmetRequiredAcceptanceIds: ["A-1"] },
		});
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("rejects an uncommitted start intent during startup and keeps the Goal paused", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		const goalId = "goal_stale_start_intent";
		const store = await createActiveGoal(harness, goalId);
		const active = await store.replayGoal(goalId);
		await store.appendLifecycleEvent(
			goalId,
			{
				eventType: "goal_paused",
				payload: {
					reason: "wait for explicit restart",
					userRequest: null,
					nextBestAction: "Run /goal start manually.",
					audit: {
						unmetRequiredAcceptanceIds: ["A-1"],
						currentEvidence: "The Goal is not complete.",
						incompleteConclusion: "Manual recovery is required.",
					},
				},
			},
			{
				eventId: "evt-pause-stale-start-intent",
				idempotencyKey: "pause:stale-start-intent",
				actor: "runtime",
				timestamp: "2026-07-21T00:01:00.000Z",
				expectedHead: active.head,
			},
		);
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalLifecycleIntent({
				intentId: "intent-stale-start",
				goalId,
				generation: 0,
				actor: "model",
				action: "start",
				state: "requested",
				runId: "",
				reason: "resume before the process stopped",
				resumeEvidence: "Evidence from the interrupted process.",
				userRequest: null,
				nextBestAction: "",
				audit: { unmetRequiredAcceptanceIds: [], currentEvidence: "", incompleteConclusion: "" },
				outcome: "",
				verifiedAcceptanceIds: [],
				finalEvidence: "",
				finalSummary: "",
				createdAt: "2026-07-21T00:01:30.000Z",
			}),
		);

		await harness.session.bindExtensions({});

		const replayed = await store.replayGoal(goalId);
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.events.filter((event) => event.eventType === "goal_resumed")).toHaveLength(0);
		expect(
			getGoalLifecycleIntents(harness)
				.filter((intent) => intent.intentId === "intent-stale-start")
				.map((intent) => intent.state),
		).toEqual(["requested", "rejected"]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("pauses an active Goal despite a stale draft and retires that draft after reload", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const goalId = "goal_shutdown_with_stale_draft";
		const store = await createActiveGoal(harness, goalId);
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalDraft({
				draftId: "draft_stale_during_shutdown",
				state: "requested",
				objective: "This stale draft must not block Goal shutdown.",
				revisionFeedback: null,
				proposal: null,
				goalId: null,
				createdAt: "2026-07-21T00:01:00.000Z",
			}),
		);

		await harness.session.reload();

		expect((await store.replayGoal(goalId)).lifecycle.status).toBe("paused");
		expect(getCurrentGoalDraft(harness)?.state).toBe("cancelled");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("pauses an active Goal on graceful shutdown and leaves it paused after reload", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createUiContext({}) });
		const store = await createActiveGoal(harness, "goal_shutdown_paused");

		await harness.session.reload();

		const replayed = await store.replayGoal("goal_shutdown_paused");
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.lifecycle.lastPause).toMatchObject({
			actor: "runtime",
			reason: expect.stringContaining("session shutdown: reload"),
		});
		expect(replayed.events.filter((event) => event.eventType === "goal_paused")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("pauses an active Goal when its agent run is aborted", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const store = await createActiveGoal(harness, "goal_agent_aborted");
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

		await harness.session.prompt("Start a Goal run that will be aborted.");
		await waitForAgent(harness);

		const replayed = await store.replayGoal("goal_agent_aborted");
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.lifecycle.lastPause).toMatchObject({
			actor: "runtime",
			reason: expect.stringContaining("agent run aborted"),
		});
		expect(replayed.lifecycle.runs.at(-1)?.status).toBe("interrupted");
	});

	it("commits a pending user pause for a busy open Goal run", async () => {
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait_for_user_pause",
			label: "Wait for user pause",
			description: "Hold the Goal run open until the test releases it.",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const goalId = "goal_user_pause_during_abort";
		const store = await createActiveGoal(harness, goalId);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_user_pause", {})], { stopReason: "toolUse" }),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "tool_execution_start" || event.toolName !== "wait_for_user_pause") return;
				unsubscribe();
				resolve();
			});
		});

		const promptPromise = harness.session.prompt("Start a Goal run that the user will pause.");
		await sawToolStart;
		const running = await store.replayGoal(goalId);
		if (!running.lifecycle.openRunId) throw new Error("Goal run did not open before the abort");
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalLifecycleIntent({
				intentId: "intent_user_pause_during_abort",
				goalId,
				generation: 0,
				actor: "user",
				action: "pause",
				state: "requested",
				runId: running.lifecycle.openRunId,
				reason: "the user paused the busy Goal",
				resumeEvidence: "",
				userRequest: "the user paused the busy Goal",
				nextBestAction: "Wait for /goal start.",
				audit: {
					unmetRequiredAcceptanceIds: ["A-1"],
					currentEvidence: "The active run was interrupted by the user.",
					incompleteConclusion: "Acceptance A-1 remains incomplete.",
				},
				outcome: "ended",
				verifiedAcceptanceIds: [],
				finalEvidence: "",
				finalSummary: "",
				createdAt: "2026-07-21T00:01:00.000Z",
			}),
		);
		const abortPromise = harness.session.abort();
		releaseTool?.();
		await abortPromise;
		await promptPromise;

		const replayed = await store.replayGoal(goalId);
		expect(replayed.lifecycle.lastPause).toMatchObject({
			actor: "user",
			reason: "the user paused the busy Goal",
		});
		expect(
			getGoalLifecycleIntents(harness)
				.filter((intent) => intent.intentId === "intent_user_pause_during_abort")
				.map((intent) => intent.state),
		).toEqual(["requested", "committed"]);
	});

	it("pauses and preserves the current Goal binding across session tree undo", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("baseline response")]);
		await harness.session.bindExtensions({});
		await harness.session.prompt("Create a branch point before the Goal binding.");
		await waitForAgent(harness);
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!target) throw new Error("tree navigation target is missing");
		const store = await createActiveGoal(harness, "goal_tree_undo");

		await harness.session.navigateTree(target.id);

		const replayed = await store.replayGoal("goal_tree_undo");
		expect(replayed.lifecycle.status).toBe("paused");
		expect(replayed.lifecycle.lastPause?.reason).toContain("session tree navigation");
		expect(getCurrentGoalId(harness)).toBe("goal_tree_undo");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps Goal lifecycle and binding unchanged when the user switches models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
			],
			extensionFactories: [createPiXkGoalExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const store = await createActiveGoal(harness, "goal_model_switch");
		const before = await store.replayGoal("goal_model_switch");

		await harness.session.setModel(harness.getModel("faux-2")!);

		const after = await store.replayGoal("goal_model_switch");
		expect(after.lifecycle.status).toBe("active");
		expect(after.events).toEqual(before.events);
		expect(getGoalBindings(harness)).toEqual([
			expect.objectContaining({ goalId: "goal_model_switch", generation: 0 }),
		]);
	});

	it("shows live active Goal time in the native footer and freezes it while paused", async () => {
		vi.useFakeTimers();
		let now = new Date("2026-07-21T00:01:05.000Z");
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ now: () => now })],
		});
		harnesses.push(harness);
		const uiContext = createUiContext({
			setStatus: (key, text) => statuses.push({ key, text }),
			notify: (message) => notifications.push(message),
		});
		await harness.session.bindExtensions({ uiContext, mode: "tui" });
		const goalId = "goal_live_footer";
		const store = new GoalStore(harness.tempDir);
		const contract: GoalContractV2 = {
			schema: "pi-xk.goal.contract.v2",
			goalId,
			title: "Show live Goal time",
			objective: "Display active Goal execution time without replacing Pi's footer.",
			constraints: [],
			acceptance: [{ id: "A-1", kind: "artifact", description: "Show Goal time.", required: true }],
			capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
			budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
			ownerSessionId: harness.sessionManager.getSessionId(),
			createdAt: "2026-07-21T00:00:00.000Z",
			schemaVersion: 2,
			nonGoals: [],
			doneCondition: "The footer reports active execution time.",
			pauseCondition: "The user pauses the Goal.",
			finalReport: "Report the displayed times.",
			executionAuthorization: "In-scope test and implementation edits are authorized.",
		};
		const created = await store.createGoal(contract, {
			eventId: "evt-create-live-footer",
			idempotencyKey: "create:live-footer",
			actor: "user",
			timestamp: contract.createdAt,
		});
		await store.appendLifecycleEvent(
			goalId,
			{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
			{
				eventId: "evt-activate-live-footer",
				idempotencyKey: "activate:live-footer",
				actor: "user",
				timestamp: contract.createdAt,
				expectedHead: created.head,
			},
		);
		harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
		await harness.session.prompt("/goal status");
		expect(statuses.at(-1)).toEqual({ key: "pi-xk-goal", text: "Goal active · 1m 5s" });

		now = new Date("2026-07-21T00:02:00.000Z");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(statuses.at(-1)).toEqual({ key: "pi-xk-goal", text: "Goal active · 2m 0s" });

		await harness.session.prompt("/goal pause inspect the footer");
		expect(statuses.at(-1)).toEqual({ key: "pi-xk-goal", text: "Goal paused · 2m 0s" });

		now = new Date("2026-07-21T00:03:00.000Z");
		const statusCount = statuses.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(statuses).toHaveLength(statusCount);

		await harness.session.prompt("/goal status");
		const statusNotification = notifications.at(-1) ?? "";
		expect(statusNotification).toContain("Pi-XK Goal Show live Goal time");
		expect(statusNotification).toContain("wall 3m 0s, active 2m 0s, busy 0s");
		expect(statusNotification).toContain("A-1=missing");
		expect(statusNotification).toContain("goal-state.md:");
		expect(statusNotification).toContain("Next action:");
		expect(statusNotification).toContain("Acceptance ledger: Required acceptance evidence has not been audited yet.");
	});

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
		expect(draftPrompts[0]).toContain("Intent Anchor");
		expect(draftPrompts[0]).toContain("Do not put changing progress");
		expect(draftPrompts[0]).toContain("commit/push");
		expect(draftPrompts[0]).toContain(objective);

		await harness.session.prompt("/goal confirm");
		await waitForAgent(harness);

		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "confirmed", goalId: "goal_confirmed_draft" });
		const replay = await new GoalStore(harness.tempDir).replayGoal("goal_confirmed_draft");
		expect(replay.lifecycle.status).toBe("ended");
		expect(replay.contract).toMatchObject({
			schema: "pi-xk.goal.contract.v3",
			revision: 1,
			intentAnchor: draftProposal("unused").intentAnchor,
		});
	});

	it("applies an objective-only V3 revision automatically and reports stale state to the next run", async () => {
		const prompts: string[] = [];
		const goalErrors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkGoalExtension({ onGoalError: (error) => goalErrors.push(error.message) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { store, contract } = await createActiveV3Goal(harness, "goal_auto_revision");
		const candidate = {
			...contract,
			objective: "Use the corrected implementation path while preserving the confirmed outcome.",
			revision: 2,
		};
		harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_propose_goal_revision", {
							expectedRevision: 1,
							reason: "Repository evidence invalidated the old path wording.",
							evidence: "The implementation now lives under the corrected module.",
							candidate,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "completed",
							reason: "revision behavior verified",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The objective-only revision event was verified.",
							finalSummary: "The V3 Goal revision completed.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("Continue using the latest repository evidence.");
		await waitForAgent(harness);

		const replay = await store.replayGoal(contract.goalId);
		expect(goalErrors).toEqual([]);
		expect(replay.contract).toEqual(candidate);
		expect(replay.events.find((event) => event.eventType === "goal_contract_updated")).toMatchObject({
			schemaVersion: 2,
			actor: "model",
			payload: { mode: "automatic-objective-refinement", changedFields: ["objective"] },
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(prompts[1]).toContain("contract_revision is 2");
		expect(prompts[1]).toContain("State synchronization required");
	});

	it("clears superseded revision feedback after an objective-only revision applies", async () => {
		const continuationSystemPrompts: string[] = [];
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { store, contract } = await createActiveV3Goal(harness, "goal_revision_feedback");
		const protectedCandidate = {
			...contract,
			constraints: [...contract.constraints, "Require an obsolete implementation path."],
			revision: 2,
		};
		const objectiveCandidate = {
			...contract,
			objective: "Use the verified replacement path while preserving the confirmed outcome.",
			revision: 2,
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_propose_goal_revision", {
						expectedRevision: 1,
						reason: "A protected implementation constraint is proposed.",
						evidence: "The candidate needs explicit user review.",
						candidate: protectedCandidate,
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				continuationSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_propose_goal_revision", {
							expectedRevision: 1,
							reason: "Verified repository evidence invalidated the obsolete path.",
							evidence: "The replacement module is the active implementation.",
							candidate: objectiveCandidate,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				continuationSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "completed",
							reason: "revision feedback lifecycle verified",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The applied revision replaced the superseded feedback state.",
							finalSummary: "The Goal revision feedback lifecycle completed.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("Propose the protected Goal revision.");
		await waitForAgent(harness);
		expect(getCurrentGoalRevision(harness)?.state).toBe("proposed");

		await harness.session.prompt("/goal revision revise Keep the protected fields unchanged.");
		await waitForAgent(harness);

		expect((await store.replayGoal(contract.goalId)).contract).toEqual(objectiveCandidate);
		expect(continuationSystemPrompts).toHaveLength(2);
		expect(continuationSystemPrompts[0]).toContain("User revision feedback: Keep the protected fields unchanged.");
		expect(continuationSystemPrompts[1]).not.toContain("User revision feedback:");
		expect(getCurrentGoalRevision(harness)).toMatchObject({
			state: "confirmed",
			expectedRevision: 1,
			changedFields: ["objective"],
			revisionFeedback: null,
			candidate: objectiveCandidate,
		});
	});

	it("ignores superseded feedback when the contract event committed before the session terminal entry", async () => {
		let continuationSystemPrompt = "";
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { store, contract } = await createActiveV3Goal(harness, "goal_revision_feedback_crash_window");
		const protectedCandidate = {
			...contract,
			constraints: [...contract.constraints, "Require an obsolete implementation path."],
			revision: 2,
		};
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalRevision({
				revisionId: "revision_crash_window",
				goalId: contract.goalId,
				generation: 0,
				state: "superseded",
				expectedRevision: 1,
				reason: "A protected implementation constraint was proposed.",
				evidence: "The candidate needed explicit user review.",
				changedFields: ["constraints"],
				revisionFeedback: "Keep the protected fields unchanged.",
				candidate: protectedCandidate,
				createdAt: "2026-07-28T00:01:00.000Z",
			}),
		);
		const replay = await store.replayGoal(contract.goalId);
		const objectiveCandidate = {
			...contract,
			objective: "Use the verified replacement path while preserving the confirmed outcome.",
			revision: 2,
		};
		await store.reviseGoalContract(objectiveCandidate, {
			eventId: "evt_revision_crash_window",
			idempotencyKey: "goal-revision:crash-window",
			actor: "model",
			timestamp: "2026-07-28T00:02:00.000Z",
			expectedHead: replay.head,
			expectedRevision: 1,
			mode: "automatic-objective-refinement",
			reason: "Verified repository evidence invalidated the obsolete path.",
			evidence: "The replacement module is the active implementation.",
		});
		harness.setResponses([
			(context) => {
				continuationSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "completed",
							reason: "crash-window feedback handling verified",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The stale feedback was excluded after the contract event committed.",
							finalSummary: "The crash-window revision behavior completed.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("Continue after recovering the revision event.");
		await waitForAgent(harness);

		expect(continuationSystemPrompt).toContain("contract_revision is 2");
		expect(continuationSystemPrompt).not.toContain("User revision feedback:");
		expect(getCurrentGoalRevision(harness)).toMatchObject({
			state: "superseded",
			expectedRevision: 1,
		});
	});

	it("ignores a proposed revision from a previously bound Goal", async () => {
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { contract: previousContract } = await createActiveV3Goal(harness, "goal_previous_revision");
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalRevision({
				revisionId: "revision_previous_goal",
				goalId: previousContract.goalId,
				generation: 0,
				state: "proposed",
				expectedRevision: 1,
				reason: "The previous Goal proposed a protected change.",
				evidence: "The previous Goal required user confirmation.",
				changedFields: ["constraints"],
				revisionFeedback: null,
				candidate: {
					...previousContract,
					constraints: [...previousContract.constraints, "Previous Goal-only constraint."],
					revision: 2,
				},
				createdAt: "2026-07-28T00:03:00.000Z",
			}),
		);
		const { store, contract } = await createActiveV3Goal(harness, "goal_current_revision");
		harness.setResponses([
			fauxAssistantMessage("The current Goal made one verified step."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "completed",
						reason: "current Goal continuation verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The current Goal continued past the previous Goal revision.",
						finalSummary: "The current Goal completed without cross-Goal revision interference.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("Continue only the currently bound Goal.");
		await waitForAgent(harness);

		expect(harness.faux.state.callCount).toBe(2);
		expect((await store.replayGoal(contract.goalId)).lifecycle.status).toBe("ended");
	});

	it("ignores superseded revision feedback from an earlier binding generation", async () => {
		let currentSystemPrompt = "";
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { store, contract } = await createActiveV3Goal(harness, "goal_rebound_revision");
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalRevision({
				revisionId: "revision_previous_generation",
				goalId: contract.goalId,
				generation: 0,
				state: "superseded",
				expectedRevision: 1,
				reason: "The previous binding proposed a protected change.",
				evidence: "The previous binding required user confirmation.",
				changedFields: ["constraints"],
				revisionFeedback: "Do not leak this feedback into the rebound Goal.",
				candidate: {
					...contract,
					constraints: [...contract.constraints, "Previous binding-only constraint."],
					revision: 2,
				},
				createdAt: "2026-07-28T00:04:00.000Z",
			}),
		);
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalBinding(contract.goalId, 1),
		);
		harness.setResponses([
			(context) => {
				currentSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "completed",
							reason: "binding generation isolation verified",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The rebound Goal excluded feedback from generation zero.",
							finalSummary: "Revision feedback remained scoped to its original binding.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("Continue the rebound Goal binding.");
		await waitForAgent(harness);

		expect(currentSystemPrompt).not.toContain("User revision feedback:");
		expect(currentSystemPrompt).not.toContain("Do not leak this feedback");
		expect((await store.replayGoal(contract.goalId)).lifecycle.status).toBe("ended");
	});

	it("uses the existing Goal kickoff once after threshold compaction", async () => {
		const continuationSystemPrompts: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 20 } },
			extensionFactories: [
				createPiXkGoalExtension(),
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "Active Goal threshold context",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const goalId = "goal_threshold_compaction";
		const store = await createActiveGoal(harness, goalId);
		harness.setResponses([
			{
				...fauxAssistantMessage("threshold reached"),
				usage: {
					input: 81,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 81,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			(context) => {
				continuationSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "verified",
							reason: "threshold continuation verified",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "One Goal kickoff resumed after threshold compaction.",
							finalSummary: "Threshold recovery used the existing Goal continuation.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("advance the active Goal through compaction");
		await waitForAgent(harness);

		expect(harness.faux.state.callCount).toBe(2);
		expect(continuationSystemPrompts).toHaveLength(1);
		expect(continuationSystemPrompts[0]).toContain("Context compaction is not a new user request");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "pi-xk.goal-kickoff.v1",
			),
		).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect((await store.replayGoal(goalId)).lifecycle.status).toBe("ended");
	});

	it("holds protected V3 changes for explicit revision confirmation", async () => {
		const continuationMessages: string[] = [];
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { store, contract } = await createActiveV3Goal(harness, "goal_protected_revision");
		const candidate = {
			...contract,
			constraints: [...contract.constraints, "Require a user-visible migration report."],
			revision: 2,
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_propose_goal_revision", {
						expectedRevision: 1,
						reason: "A protected constraint change is proposed.",
						evidence: "The user must review this contract expansion.",
						candidate,
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				continuationMessages.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "completed",
							reason: "protected revision confirmed",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The protected revision was user-confirmed.",
							finalSummary: "The confirmed revision completed.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.prompt("Review the protected contract change.");
		await waitForAgent(harness);

		expect((await store.replayGoal(contract.goalId)).contract).toMatchObject({ revision: 1 });
		expect(getCurrentGoalRevision(harness)).toMatchObject({
			state: "proposed",
			expectedRevision: 1,
			changedFields: ["constraints"],
		});
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("/goal revision show");
		expect(harness.faux.state.callCount).toBe(1);
		await harness.session.prompt("/goal revision confirm");
		await waitForAgent(harness);

		const replay = await store.replayGoal(contract.goalId);
		expect(continuationMessages).toHaveLength(1);
		expect(continuationMessages[0]).not.toContain("# Goal Revision");
		expect(continuationMessages[0]).not.toContain("## Candidate contract");
		expect(replay.contract).toEqual(candidate);
		expect(getCurrentGoalRevision(harness)?.state).toBe("confirmed");
		expect(replay.events.find((event) => event.eventType === "goal_contract_updated")).toMatchObject({
			actor: "user",
			payload: { mode: "user-confirmed", changedFields: ["constraints"] },
		});
	});

	it("confirms a protected V3 revision through the native review dialog", async () => {
		const dialogRenders: string[] = [];
		const harness = await createHarness({ extensionFactories: [createPiXkGoalExtension()] });
		harnesses.push(harness);
		const custom = async <T>(factory: CustomUiFactory<T>): Promise<T> => {
			const component = await factory(
				{ terminal: { rows: 24 }, requestRender: () => {} } as never,
				createPlainTheme(),
				{ matches: (data: string, key: string) => data === key } as unknown as KeybindingsManager,
				() => {},
			);
			const renders = [component.render(80).join("\n")];
			for (let page = 0; page < 8; page++) {
				component.handleInput?.("tui.select.pageDown");
				renders.push(component.render(80).join("\n"));
			}
			dialogRenders.push(renders.join("\n"));
			return "confirm" as T;
		};
		await harness.session.bindExtensions({ uiContext: createUiContext({ custom }), mode: "tui" });
		const { store, contract } = await createActiveV3Goal(harness, "goal_ui_revision");
		const candidate = {
			...contract,
			constraints: [...contract.constraints, "Require native revision review evidence."],
			revision: 2,
		};
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_propose_goal_revision", {
						expectedRevision: 1,
						reason: "A protected constraint requires native review.",
						evidence: "The review dialog must expose the complete candidate.",
						candidate,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "completed",
						reason: "native revision review verified",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The native dialog confirmed the protected revision.",
						finalSummary: "The protected revision completed after native review.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("Review the protected revision in the native dialog.");
		await waitForAgent(harness);

		expect(dialogRenders).toHaveLength(1);
		expect(dialogRenders[0]).toContain("Goal Revision");
		expect(dialogRenders[0]).toContain("Require native revision review evidence.");
		expect(dialogRenders[0]).toContain("确认合同修订");
		expect(dialogRenders[0]).toContain("修改候选");
		expect((await store.replayGoal(contract.goalId)).contract).toEqual(candidate);
		expect((await store.replayGoal(contract.goalId)).lifecycle.status).toBe("ended");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("uses native UI to revise a draft and confirm the revised contract", async () => {
		const dialogRenders: string[] = [];
		const dialogOptions: Array<{ overlay?: boolean; overlayOptions?: unknown } | undefined> = [];
		const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];
		const notifications: string[] = [];
		const revisionPrompts: string[] = [];
		const choices = ["revise", "confirm"];
		const dialogTheme = createPlainTheme();
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
		const custom = async <T>(factory: CustomUiFactory<T>, options?: CustomUiOptions): Promise<T> => {
			dialogOptions.push(options);
			const component = await factory(
				{
					terminal: { rows: 24 },
					requestRender: () => {},
				} as never,
				dialogTheme,
				{ matches: () => false } as unknown as KeybindingsManager,
				() => {},
			);
			dialogRenders.push(component.render(80).join("\n"));
			return choices.shift() as T;
		};
		const uiContext = createUiContext({
			notify: (message) => notifications.push(message),
			select: async () => {
				throw new Error("Goal draft review must not use ctx.ui.select");
			},
			input: async () => {
				throw new Error("Goal draft revision must not use ctx.ui.input");
			},
			custom,
			editor: async (title, prefill) => {
				editorCalls.push({ title, prefill });
				return "Require explicit release evidence.";
			},
		});

		await harness.session.bindExtensions({ uiContext, mode: "tui" });
		await harness.session.prompt("/goal Prepare a release Goal.");
		await waitForAgent(harness);

		expect(notifications).toEqual([]);
		expect(dialogRenders).toHaveLength(2);
		expect(dialogRenders[0]).toContain("Goal Draft");
		expect(dialogRenders[0].match(/Goal Draft/g)).toHaveLength(1);
		expect(dialogRenders[0]).toContain("Initial drafted objective.");
		expect(dialogRenders[0]).toContain("确认，启动 Goal");
		expect(dialogRenders[0]).toContain("修改草案");
		expect(dialogRenders[1]).toContain("Revised drafted objective.");
		expect(dialogOptions).toEqual([
			expect.objectContaining({ overlay: true }),
			expect.objectContaining({ overlay: true }),
		]);
		expect(editorCalls).toEqual([{ title: "修改 Goal 草案", prefill: "" }]);
		expect(revisionPrompts[1]).toContain("Revision feedback:\nRequire explicit release evidence.");
		expect(getCurrentGoalDraft(harness)).toMatchObject({ state: "confirmed", goalId: "goal_ui_draft" });
		const replayed = await new GoalStore(harness.tempDir).replayGoal("goal_ui_draft");
		expect(replayed.contract.objective).toBe("Revised drafted objective.");
		expect(replayed.lifecycle.status).toBe("ended");
	});

	it("supports scrolling, action selection, and cancellation in the Goal draft dialog", () => {
		const results: string[] = [];
		const keybindings = {
			matches: (data: string, key: string) => data === key,
		} as unknown as KeybindingsManager;
		const tui = {
			terminal: { rows: 12 },
			requestRender: () => {},
		};
		const component = createGoalDraftReviewComponent({
			markdown: Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`).join("\n"),
			tui,
			theme: createPlainTheme(),
			keybindings,
			done: (result) => results.push(result),
		});

		expect(component.render(60).join("\n")).toContain("Line 1");
		component.handleInput("tui.select.pageDown");
		expect(component.render(60).join("\n")).toContain("Line 4");
		tui.terminal.rows = 6;
		const compactRender = component.render(60);
		expect(compactRender).toHaveLength(6);
		expect(compactRender.join("\n")).toContain("确认，启动 Goal");
		expect(compactRender.join("\n")).toContain("修改草案");
		component.handleInput("tui.select.down");
		component.handleInput("tui.select.confirm");
		expect(results).toEqual(["revise"]);

		const cancelled = createGoalDraftReviewComponent({
			markdown: "Draft",
			tui,
			theme: createPlainTheme(),
			keybindings,
			done: (result) => results.push(result),
		});
		cancelled.handleInput("tui.select.cancel");
		expect(results).toEqual(["revise", "cancel"]);
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

	it("rejects a replacement draft while the current Goal is still active", async () => {
		const goalId = "goal_existing_active";
		const goalErrors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => "goal_replacement_draft",
					onGoalError: (error) => goalErrors.push(error.message),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
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
		harness.setResponses([draftResponse("Replacement draft objective.")]);

		await harness.session.prompt("/goal Prepare a replacement Goal.");

		const replayed = await store.replayGoal(goalId);
		expect(replayed.lifecycle.status).toBe("active");
		expect(replayed.events.map((event) => event.eventType)).toEqual(["goal_created", "goal_activated"]);
		expect(goalErrors).toEqual(["end the current Goal before drafting another Goal"]);
		expect(getCurrentGoalDraft(harness)).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("keeps a model end pending until its final checkpoint is durable", async () => {
		class ControllableCheckpointGoalStore extends GoalStore {
			checkpointWritesAllowed = false;

			override async appendCheckpoint(
				goalId: string,
				checkpointInput: GoalCheckpointV2,
				options: GoalContractUpdateOptions,
			): Promise<GoalWriteResult> {
				if (!this.checkpointWritesAllowed) throw new Error("injected checkpoint failure");
				return await super.appendCheckpoint(goalId, checkpointInput, options);
			}
		}

		let controlledStore: ControllableCheckpointGoalStore | undefined;
		const checkpointErrors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => "goal_checkpoint_gated_end",
					createGoalStore: (projectRoot) => {
						controlledStore ??= new ControllableCheckpointGoalStore(projectRoot);
						return controlledStore;
					},
					onGoalError: (error) => checkpointErrors.push(error.message),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("End only after a durable final checkpoint."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the acceptance evidence is complete",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The final checkpoint must be durable.",
						finalSummary: "The Goal is complete after checkpoint persistence.",
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Gate lifecycle settlement on checkpoint persistence.");
		if (!controlledStore) throw new Error("controlled Goal store was not created");

		const blocked = await controlledStore.replayGoal("goal_checkpoint_gated_end");
		expect(blocked.lifecycle.status).toBe("active");
		expect(blocked.events.some((event) => event.eventType === "goal_ended")).toBe(false);
		expect(getGoalLifecycleIntents(harness)).toContainEqual(
			expect.objectContaining({ action: "end", state: "requested" }),
		);
		expect(checkpointErrors).toContain("injected checkpoint failure");

		controlledStore.checkpointWritesAllowed = true;
		await harness.session.reload();

		const recovered = await controlledStore.replayGoal("goal_checkpoint_gated_end");
		expect({
			status: recovered.lifecycle.status,
			events: recovered.events.map((event) => event.eventType),
			intents: getGoalLifecycleIntents(harness).map((intent) => ({
				action: intent.action,
				state: intent.state,
			})),
			errors: checkpointErrors,
		}).toMatchObject({
			status: "ended",
			events: expect.arrayContaining(["goal_checkpointed", "goal_ended"]),
			intents: expect.arrayContaining([expect.objectContaining({ action: "end", state: "committed" })]),
		});
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
		expect(activeSystemPrompt).toContain("goal-objective.md");
		expect(activeSystemPrompt).toContain("goal-state.md");
		expect(activeSystemPrompt.match(/goal-objective\.md/g)).toHaveLength(1);
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

	it("retires a stale requested lifecycle intent instead of retrying it forever", async () => {
		const goalErrors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkGoalExtension({
					createGoalId: () => "goal_stale_intent",
					onGoalError: (error) => goalErrors.push(error.message),
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			draftResponse("Reject stale lifecycle intents."),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_end_goal", {
						outcome: "accepted",
						reason: "the Goal is complete",
						verifiedAcceptanceIds: ["A-1"],
						finalEvidence: "The required evidence was verified.",
						finalSummary: "The Goal is complete.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Process the stale intent without changing the ended Goal."),
		]);

		await harness.session.bindExtensions({});
		await requestAndConfirmGoal(harness, "Reject stale lifecycle intents.");
		const binding = getGoalBindings(harness).at(-1);
		if (!binding) throw new Error("Goal binding is missing");
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalLifecycleIntent({
				intentId: "intent_stale_pause",
				goalId: binding.goalId,
				generation: binding.generation,
				actor: "model",
				action: "pause",
				state: "requested",
				runId: "",
				reason: "stale pause after end",
				resumeEvidence: "",
				userRequest: null,
				nextBestAction: "Do not apply this stale action.",
				audit: {
					unmetRequiredAcceptanceIds: ["A-1"],
					currentEvidence: "The Goal has already ended.",
					incompleteConclusion: "This intent is stale.",
				},
				outcome: "",
				verifiedAcceptanceIds: [],
				finalEvidence: "",
				finalSummary: "",
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);

		await harness.session.prompt("Process the stale lifecycle intent.");
		await waitForAgent(harness);

		const staleStates = getGoalLifecycleIntents(harness)
			.filter((intent) => intent.intentId === "intent_stale_pause")
			.map((intent) => intent.state);
		expect({ staleStates, goalErrors }).toMatchObject({ staleStates: ["requested", "rejected"] });
		expect((await new GoalStore(harness.tempDir).replayGoal(binding.goalId)).lifecycle.status).toBe("ended");
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
		await harness.session.bindExtensions({});
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
