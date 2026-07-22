import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type GoalContractV2,
	GoalStore,
	type TaskChildInfoV1,
	type TaskSpecV1,
	TaskStore,
} from "../../../pi-xk-core/src/index.ts";
import {
	createPiXkGoalBinding,
	createPiXkGoalDraft,
	createPiXkGoalExtension,
	createPiXkTaskLink,
	isPiXkTaskLink,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	PI_XK_TASK_RESULT_CUSTOM_TYPE,
	type PiXkGoalExtensionOptions,
	TaskRunner,
} from "../../../pi-xk-extension/src/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const pendingReleases: Array<() => void> = [];

afterEach(() => {
	while (pendingReleases.length > 0) pendingReleases.pop()?.();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function taskExtension(getHarness: () => Harness, options: PiXkGoalExtensionOptions = {}) {
	return createPiXkGoalExtension({
		...options,
		createTaskRunner: (projectRoot, onSettled) => {
			const harness = getHarness();
			return new TaskRunner({
				projectRoot,
				agentDir: join(projectRoot, "agent"),
				modelRuntime: harness.modelRuntime,
				settingsManager: harness.settingsManager,
				onSettled,
			});
		},
	});
}

function testUi(notifications: string[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => {
			notifications.push(message);
		},
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
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching unavailable in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

async function waitFor(description: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function within<T>(description: string, promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out during ${description}`)), 5_000);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function taskLinks(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE && isPiXkTaskLink(entry.data)
				? [entry.data]
				: [],
		);
}

function taskResultEntries(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === PI_XK_TASK_RESULT_CUSTOM_TYPE);
}

async function createActiveGoal(harness: Harness, goalId: string): Promise<GoalStore> {
	const store = new GoalStore(harness.tempDir);
	const createdAt = "2026-07-22T00:00:00.000Z";
	const contract: GoalContractV2 = {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: "Exercise Task integration",
		objective: "Exercise one child Task and verify its parent integration.",
		constraints: ["Keep the test isolated."],
		acceptance: [{ id: "A-1", kind: "artifact", description: "Task integration passes.", required: true }],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: harness.sessionManager.getSessionId(),
		createdAt,
		schemaVersion: 2,
		nonGoals: ["Do not run a nested Task."],
		doneCondition: "Acceptance A-1 has verification evidence.",
		pauseCondition: "No in-scope action can proceed without new evidence.",
		finalReport: "Report the Task result and acceptance evidence.",
		executionAuthorization: "In-scope implementation and test work is authorized.",
	};
	const created = await store.createGoal(contract, {
		eventId: `${goalId}:created`,
		idempotencyKey: `${goalId}:created`,
		actor: "user",
		timestamp: createdAt,
	});
	await store.appendLifecycleEvent(
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
		{
			eventId: `${goalId}:activated`,
			idempotencyKey: `${goalId}:activated`,
			actor: "user",
			timestamp: createdAt,
			expectedHead: created.head,
		},
	);
	harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
	return store;
}

function finishTaskResponse(summary = "Child completed the bounded Task.") {
	return fauxAssistantMessage(
		[
			fauxToolCall("pi_xk_finish_task", {
				status: "succeeded",
				summary,
				evidence: [{ kind: "text", value: "faux-provider Task evidence" }],
				artifactIds: [],
				error: null,
			}),
		],
		{ stopReason: "toolUse" },
	);
}

function abortResponse() {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			const abort = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
		});
}

function taskSpec(taskId: string, parentSessionId: string): TaskSpecV1 {
	return {
		schema: "pi-xk.task.spec.v1",
		taskId,
		parentSessionId,
		parentEntryId: "entry_parent",
		parentGoalId: null,
		role: "verification",
		prompt: "Verify startup recovery.",
		expectedResult: "A recovered terminal Task.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("Pi-XK Task extension", () => {
	it("exposes the parent start tool and child-only finish tool, then resumes the Goal once", async () => {
		let harness: Harness;
		const parentToolSets: string[][] = [];
		const childToolSets: string[][] = [];
		const parentRecoveryTexts: string[] = [];
		let releaseChild: (() => void) | undefined;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		pendingReleases.push(() => releaseChild?.());
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				parentToolSets.push(context.tools?.map((tool) => tool.name) ?? []);
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_start_task", {
							role: "verification",
							prompt: "Verify the bounded child behavior.",
							expectedResult: "Return structured evidence.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			async (context) => {
				childToolSets.push(context.tools?.map((tool) => tool.name) ?? []);
				await childGate;
				return finishTaskResponse();
			},
			(context) => {
				parentToolSets.push(context.tools?.map((tool) => tool.name) ?? []);
				parentRecoveryTexts.push(context.messages.map((message) => getMessageText(message)).join("\n"));
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "accepted",
							reason: "the Task result verified the acceptance",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "The structured child Task result is durable.",
							finalSummary: "Task integration is complete.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toContain("pi_xk_start_task");
		expect(harness.session.getActiveToolNames()).not.toContain("pi_xk_finish_task");
		const goalStore = await createActiveGoal(harness, "goal_task_barrier");

		await harness.session.prompt("Delegate one bounded verification Task.");
		await waitFor("the child provider request", () => harness.faux.state.callCount === 2);
		expect(harness.session.isIdle).toBe(true);
		expect((await goalStore.replayGoal("goal_task_barrier")).lifecycle.status).toBe("active");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.faux.state.callCount).toBe(2);

		releaseChild?.();
		await waitFor(
			"the resumed parent Goal to end",
			async () => (await goalStore.replayGoal("goal_task_barrier")).lifecycle.status === "ended",
		);
		await harness.session.waitForIdle();

		const store = new TaskStore(harness.tempDir);
		const tasks = await store.listTasks();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.status).toBe("succeeded");
		expect(parentToolSets).toHaveLength(2);
		expect(parentToolSets[0]).toContain("pi_xk_start_task");
		expect(parentToolSets[0]).not.toContain("pi_xk_finish_task");
		expect(childToolSets).toHaveLength(1);
		expect(childToolSets[0]).toContain("pi_xk_finish_task");
		expect(childToolSets[0]).not.toContain("pi_xk_start_task");
		expect(childToolSets[0]).not.toContain("pi_xk_start_goal");
		expect(parentRecoveryTexts[0]).toContain("Child completed the bounded Task.");
		expect(taskResultEntries(harness)).toHaveLength(1);
		expect(taskLinks(harness).map((link) => link.eventId)).toEqual(tasks[0]?.events.map((event) => event.eventId));
		expect(taskLinks(harness).map((link) => link.generation)).toEqual([0, 1, 2]);
		const childFile = tasks[0]?.events.find((event) => event.eventType === "task_started")?.payload.child
			.childSessionFile;
		expect(childFile && existsSync(childFile)).toBe(true);
		const transcript = readFileSync(childFile!, "utf8");
		expect(transcript).toContain("pi_xk_finish_task");
		expect(transcript).not.toContain("pi_xk_start_task");
	});

	it("makes same-workspace child changes visible to the resumed parent", async () => {
		let harness: Harness;
		let parentObservedChildFile = false;
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_start_task", {
						role: "implementation",
						prompt: "Create task-output.txt with the requested content.",
						expectedResult: "The file exists in the shared project workspace.",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("write", { path: "task-output.txt", content: "written by child\n" })], {
				stopReason: "toolUse",
			}),
			finishTaskResponse("Child created task-output.txt."),
			() => {
				parentObservedChildFile =
					readFileSync(join(harness.tempDir, "task-output.txt"), "utf8") === "written by child\n";
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_end_goal", {
							outcome: "accepted",
							reason: "the resumed parent observed the child workspace change",
							verifiedAcceptanceIds: ["A-1"],
							finalEvidence: "task-output.txt contains the expected child content.",
							finalSummary: "The child change is visible to the parent.",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		await harness.session.bindExtensions({});
		const goalStore = await createActiveGoal(harness, "goal_task_workspace");

		await harness.session.prompt("Delegate the bounded workspace change.");
		await waitFor(
			"the resumed parent to verify the child file",
			async () => (await goalStore.replayGoal("goal_task_workspace")).lifecycle.status === "ended",
		);
		await harness.session.waitForIdle();

		expect(parentObservedChildFile).toBe(true);
		expect(readFileSync(join(harness.tempDir, "task-output.txt"), "utf8")).toBe("written by child\n");
	});

	it("blocks ordinary parent input and pauses an active Goal when the user cancels", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([abortResponse()]);
		await harness.session.bindExtensions({ uiContext: testUi(notifications) });
		const goalStore = await createActiveGoal(harness, "goal_user_task_cancel");

		await harness.session.prompt("/task start Hold until the user cancels.");
		const taskStore = new TaskStore(harness.tempDir);
		await waitFor("the user Task to run", async () =>
			(await taskStore.listTasks()).some((task) => task.status === "running"),
		);
		const callsBeforeInput = harness.faux.state.callCount;
		await harness.session.prompt("This input must not reach the parent model.");
		expect(harness.faux.state.callCount).toBe(callsBeforeInput);
		expect(notifications.at(-1)).toContain("Use /task status or /task cancel");
		await harness.session.prompt("/task start A second concurrent Task must be rejected.");
		expect(notifications.at(-1)).toContain("already running");
		expect(await taskStore.listTasks()).toHaveLength(1);

		await harness.session.prompt("/task status");
		expect(notifications.at(-1)).toContain("status=running");
		await harness.session.prompt("/task cancel user requested cancellation");
		const task = (await taskStore.listTasks())[0];
		expect(task?.status).toBe("cancelled");
		expect((await goalStore.replayGoal("goal_user_task_cancel")).lifecycle).toMatchObject({
			status: "paused",
			lastPause: { actor: "runtime", audit: { unmetRequiredAcceptanceIds: ["A-1"] } },
		});
		expect(taskResultEntries(harness)).toHaveLength(0);
	});

	it("rejects Task starts during a Goal draft and after a Goal is paused or ended", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: testUi(notifications) });
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalDraft({
				draftId: "draft_task_block",
				state: "requested",
				objective: "Draft before running a Task.",
				revisionFeedback: null,
				proposal: null,
				goalId: null,
				createdAt: "2026-07-22T00:00:00.000Z",
			}),
		);

		await harness.session.prompt("/task start must be rejected during draft");
		expect(notifications.at(-1)).toContain("awaiting review");
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalDraft({
				draftId: "draft_task_block",
				state: "cancelled",
				objective: "Draft before running a Task.",
				revisionFeedback: null,
				proposal: null,
				goalId: null,
				createdAt: "2026-07-22T00:01:00.000Z",
			}),
		);
		const goalStore = await createActiveGoal(harness, "goal_task_state_gate");
		const active = await goalStore.replayGoal("goal_task_state_gate");
		await goalStore.appendLifecycleEvent(
			"goal_task_state_gate",
			{
				eventType: "goal_paused",
				payload: {
					reason: "pause for state gate test",
					userRequest: null,
					nextBestAction: "Resume before starting a Task.",
					audit: {
						unmetRequiredAcceptanceIds: ["A-1"],
						currentEvidence: "The acceptance is still open.",
						incompleteConclusion: "The Goal is incomplete.",
					},
				},
			},
			{
				eventId: "goal_task_state_gate:paused",
				idempotencyKey: "goal_task_state_gate:paused",
				actor: "user",
				timestamp: "2026-07-22T00:02:00.000Z",
				expectedHead: active.head,
			},
		);

		await harness.session.prompt("/task start must be rejected while paused");
		expect(notifications.at(-1)).toContain("current Goal is paused");
		const paused = await goalStore.replayGoal("goal_task_state_gate");
		await goalStore.appendLifecycleEvent(
			"goal_task_state_gate",
			{
				eventType: "goal_ended",
				payload: {
					outcome: "ended_by_test",
					reason: "exercise ended state",
					verifiedAcceptanceIds: ["A-1"],
					finalEvidence: "Acceptance A-1 is treated as verified for the ended-state gate test.",
					finalSummary: "The test Goal ended without starting a Task.",
				},
			},
			{
				eventId: "goal_task_state_gate:ended",
				idempotencyKey: "goal_task_state_gate:ended",
				actor: "user",
				timestamp: "2026-07-22T00:03:00.000Z",
				expectedHead: paused.head,
			},
		);

		await harness.session.prompt("/task start must be rejected after end");
		expect(notifications.at(-1)).toContain("current Goal is ended");
		expect(await new TaskStore(harness.tempDir).listTasks()).toEqual([]);
	});

	it("recovers pending and running Task facts on startup without triggering the parent model", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		const store = new TaskStore(harness.tempDir);
		const pendingSpec = taskSpec("task_pending_recovery", harness.sessionManager.getSessionId());
		const pending = await store.createTask(pendingSpec, {
			eventId: "task_pending_recovery:created",
			idempotencyKey: "task_pending_recovery:created",
			actor: "user",
		});
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkTaskLink(pendingSpec.taskId, null, pending.event.eventId, 0),
		);

		const runningSpec = taskSpec("task_running_recovery", harness.sessionManager.getSessionId());
		const running = await store.createTask(runningSpec, {
			eventId: "task_running_recovery:created",
			idempotencyKey: "task_running_recovery:created",
			actor: "model",
		});
		const child: TaskChildInfoV1 = {
			childSessionId: "child_recovery",
			childSessionFile: join(harness.tempDir, "child-recovery.jsonl"),
			provider: harness.getModel().provider,
			modelId: harness.getModel().id,
			thinkingLevel: "off",
			builtinTools: ["read"],
			attempt: 1,
		};
		const started = await store.appendTaskStarted(runningSpec.taskId, child, {
			eventId: "task_running_recovery:started",
			idempotencyKey: "task_running_recovery:started",
			expectedHead: running.head,
			actor: "runtime",
		});
		harness.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkTaskLink(runningSpec.taskId, null, started.event.eventId, 0),
		);

		await harness.session.bindExtensions({ uiContext: testUi(notifications) });

		expect((await store.replayTask(pendingSpec.taskId)).status).toBe("cancelled");
		expect((await store.replayTask(runningSpec.taskId)).status).toBe("orphaned");
		expect(taskResultEntries(harness)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(0);
		await harness.session.prompt(`/task status ${pendingSpec.taskId}`);
		expect(notifications.at(-1)).toContain("status=cancelled");
		await harness.session.prompt(`/task status ${runningSpec.taskId}`);
		expect(notifications.at(-1)).toContain("status=orphaned");
	});

	it("reports a failed user Task without automatically starting a parent turn", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("I stopped without submitting a structured Task result.")]);
		await harness.session.bindExtensions({ uiContext: testUi(notifications) });

		await harness.session.prompt("/task start Exercise a missing child result.");
		const store = new TaskStore(harness.tempDir);
		await waitFor("the user Task to fail", async () =>
			(await store.listTasks()).some((task) => task.status === "failed"),
		);
		await harness.session.prompt("/task status");

		expect(notifications.at(-1)).toContain("status=failed");
		expect(harness.faux.state.callCount).toBe(1);
		expect(taskResultEntries(harness)).toHaveLength(0);
	});

	it("keeps the child model snapshot when the parent switches models", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		let childModelId: string | undefined;
		let releaseChild: (() => void) | undefined;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		pendingReleases.push(() => releaseChild?.());
		harness = await createHarness({
			models: [
				{ id: "faux-parent-one", name: "Parent One" },
				{ id: "faux-parent-two", name: "Parent Two" },
			],
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([
			async (_context, _options, _state, model) => {
				childModelId = model.id;
				await childGate;
				return finishTaskResponse("Child retained its launch model.");
			},
		]);
		await harness.session.bindExtensions({ uiContext: testUi(notifications) });

		await harness.session.prompt("/task start Verify the model snapshot.");
		await waitFor("the child model snapshot", () => childModelId !== undefined);
		await harness.session.setModel(harness.getModel("faux-parent-two")!);
		releaseChild?.();
		const store = new TaskStore(harness.tempDir);
		await waitFor("the snapshot Task to succeed", async () =>
			(await store.listTasks()).some((task) => task.status === "succeeded"),
		);
		await waitFor("the snapshot Task terminal link", () => taskLinks(harness).length === 3);

		const task = (await store.listTasks())[0];
		const started = task?.events.find((event) => event.eventType === "task_started");
		expect(childModelId).toBe("faux-parent-one");
		expect(started?.eventType === "task_started" && started.payload.child.modelId).toBe("faux-parent-one");
		expect(harness.session.model?.id).toBe("faux-parent-two");
		expect(taskResultEntries(harness)).toHaveLength(0);
		await harness.session.prompt("/task status");
		expect(notifications.at(-1)).toContain("status=succeeded");
	});

	it("cancels a running Task on reload and does not rerun it", async () => {
		let harness: Harness;
		const notifications: string[] = [];
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([abortResponse()]);
		await within(
			"binding extensions before reload",
			harness.session.bindExtensions({ uiContext: testUi(notifications) }),
		);
		const store = new TaskStore(harness.tempDir);

		await within("starting the pre-reload Task", harness.session.prompt("/task start Wait for reload."));
		await waitFor("the pre-reload Task to run", async () =>
			(await store.listTasks()).some((task) => task.status === "running"),
		);
		await within("session reload", harness.session.reload());
		expect((await store.listTasks()).map((task) => task.status)).toEqual(["cancelled"]);
		expect(harness.session.getActiveToolNames()).toContain("pi_xk_start_task");
		expect(taskLinks(harness).map((link) => link.eventId)).toHaveLength(3);
		await waitFor("the recovered Task result message", () => taskResultEntries(harness).length === 1);
		expect(harness.faux.state.callCount).toBe(1);
		await within("second session reload", harness.session.reload());
		expect(taskResultEntries(harness)).toHaveLength(1);
		expect(taskLinks(harness).map((link) => link.eventId)).toHaveLength(3);
	});

	it("cancels a running Task before session tree navigation", async () => {
		let harness: Harness;
		harness = await createHarness({
			extensionFactories: [taskExtension(() => harness)],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Create a navigation target."), abortResponse()]);
		await harness.session.bindExtensions({});
		await harness.session.prompt("Create a branch point.");
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!target) throw new Error("Task tree navigation target is missing");
		const store = new TaskStore(harness.tempDir);

		await harness.session.prompt("/task start Wait for tree navigation.");
		await waitFor("the tree navigation Task to run", async () =>
			(await store.listTasks()).some((task) => task.status === "running"),
		);
		await harness.session.navigateTree(target.id);

		expect((await store.listTasks())[0]?.status).toBe("cancelled");
		expect(harness.sessionManager.getBranch().some((entry) => entry.id === target.id)).toBe(true);
	});
});
