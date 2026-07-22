import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type TaskChildInfoV1,
	type TaskReplay,
	type TaskResultEnvelopeV1,
	type TaskRole,
	type TaskSpecV1,
	type TaskStatus,
	TaskStore,
} from "pi-xk-core";
import { type Static, Type } from "typebox";

const finishParameters = Type.Object({
	status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
	summary: Type.String({ minLength: 1 }),
	evidence: Type.Array(
		Type.Object({
			kind: Type.Union([Type.Literal("file"), Type.Literal("command"), Type.Literal("text")]),
			value: Type.String({ minLength: 1 }),
		}),
	),
	artifactIds: Type.Array(Type.String()),
	error: Type.Union([
		Type.Null(),
		Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
	]),
});

type FinishTaskInput = Static<typeof finishParameters>;

export interface TaskRunnerStartInput {
	role: TaskRole;
	prompt: string;
	expectedResult: string;
	parentSessionId: string;
	parentEntryId: string;
	parentGoalId: string | null;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	builtinTools?: string[];
	actor?: "user" | "model";
	onEvent?: (replay: TaskReplay, eventId: string) => void | Promise<void>;
}

export interface TaskRunnerOptions {
	projectRoot: string;
	agentDir?: string;
	modelRuntime?: ModelRuntime;
	settingsManager?: SettingsManager;
	store?: TaskStore;
	onSettled?: (taskId: string, status: TaskStatus) => void | Promise<void>;
}

export interface TaskRunnerHandle {
	taskId: string;
	childSessionId: string;
	childSessionFile: string;
	completion: Promise<TaskStatus>;
	cancel(reason?: string): Promise<void>;
}

interface ActiveChild {
	taskId: string;
	session: AgentSession;
	child: TaskChildInfoV1;
	onEvent: TaskRunnerStartInput["onEvent"];
	settling: Promise<TaskStatus>;
	settled: boolean;
	detached: boolean;
	terminalWrite?: Promise<void>;
}

function taskPrompt(spec: TaskSpecV1): string {
	const goalContext =
		spec.parentGoalId === null
			? []
			: [
					`Parent Goal objective: ${join(taskProjectGoalDirectory(spec.parentGoalId), "goal-objective.md")}`,
					`Parent Goal state: ${join(taskProjectGoalDirectory(spec.parentGoalId), "goal-state.md")}`,
				];
	return [
		"You are an independent Pi-XK Task child.",
		"Complete only the TaskSpec below. Do not start a Goal or another Task, and do not edit Task/Goal event files.",
		"Continue until you have succeeded, failed clearly, or cannot proceed.",
		"You must call pi_xk_finish_task exactly once; ordinary text is not a completion signal.",
		"Do not commit or push unless the TaskSpec explicitly authorizes it.",
		"",
		`Task ID: ${spec.taskId}`,
		`Role: ${spec.role}`,
		`Expected result: ${spec.expectedResult}`,
		...goalContext,
		"Task prompt:",
		spec.prompt,
	].join("\n");
}

function taskProjectGoalDirectory(goalId: string): string {
	return join(".pi-xk", "goals", goalId);
}

export class TaskRunner {
	private readonly projectRoot: string;
	private readonly agentDir: string;
	private readonly modelRuntime: ModelRuntime | undefined;
	private readonly settingsManager: SettingsManager | undefined;
	private readonly store: TaskStore;
	private readonly onSettled: ((taskId: string, status: TaskStatus) => void | Promise<void>) | undefined;
	private readonly active = new Map<string, ActiveChild>();

	constructor(options: TaskRunnerOptions) {
		this.projectRoot = options.projectRoot;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.modelRuntime = options.modelRuntime;
		this.settingsManager = options.settingsManager;
		this.store = options.store ?? new TaskStore(options.projectRoot);
		this.onSettled = options.onSettled;
	}

	getStore(): TaskStore {
		return this.store;
	}

	getActiveTaskId(): string | undefined {
		return [...this.active.values()].find((child) => !child.settled)?.taskId;
	}

	async start(input: TaskRunnerStartInput): Promise<TaskRunnerHandle> {
		if (this.getActiveTaskId()) throw new Error("A Task is already running for this parent session");
		const taskId = `task_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		const spec: TaskSpecV1 = {
			schema: "pi-xk.task.spec.v1",
			taskId,
			parentSessionId: input.parentSessionId,
			parentEntryId: input.parentEntryId,
			parentGoalId: input.parentGoalId,
			role: input.role,
			prompt: input.prompt,
			expectedResult: input.expectedResult,
			workspaceMode: "same-workspace",
			allowNestedSpawn: false,
			createdAt: new Date().toISOString(),
		};
		const created = await this.store.createTask(spec, {
			eventId: `${taskId}:created`,
			idempotencyKey: `${taskId}:created`,
			actor: input.actor ?? "model",
		});
		await input.onEvent?.(await this.store.replayTask(taskId), created.event.eventId);
		let childSession: AgentSession | undefined;
		try {
			const sessionDir = join(this.projectRoot, ".pi-xk", "tasks", taskId, "session");
			const sessionManager = SessionManager.create(this.projectRoot, sessionDir);
			const settingsManager = this.settingsManager ?? SettingsManager.create(this.projectRoot, this.agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: this.projectRoot,
				agentDir: this.agentDir,
				settingsManager,
				noExtensions: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const childInfoBase = {
				childSessionId: sessionManager.getSessionId(),
				childSessionFile: sessionManager.getSessionFile() ?? join(sessionDir, "child.jsonl"),
				provider: input.model.provider,
				modelId: input.model.id,
				thinkingLevel: input.thinkingLevel,
				builtinTools: [...(input.builtinTools ?? ["read", "bash", "edit", "write"])],
				attempt: 1 as const,
			};
			const finishTool: ToolDefinition<typeof finishParameters> = {
				name: "pi_xk_finish_task",
				label: "Finish Task",
				description: "Submit the one structured terminal result for this Task.",
				promptSnippet: "Finish the current Task with a structured result.",
				parameters: finishParameters,
				execute: async (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
					const active = this.active.get(taskId);
					if (!active || active.settled) {
						return {
							content: [{ type: "text", text: "Task is already terminal." }],
							details: {},
							terminate: true,
						};
					}
					await this.finishFromChild(taskId, active, params);
					return { content: [{ type: "text", text: `Task ${taskId} recorded.` }], details: {}, terminate: true };
				},
			};
			const result = await createAgentSession({
				cwd: this.projectRoot,
				agentDir: this.agentDir,
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				modelRuntime: this.modelRuntime,
				settingsManager,
				resourceLoader,
				sessionManager,
				tools: [...childInfoBase.builtinTools, "pi_xk_finish_task"],
				customTools: [finishTool],
			});
			childSession = result.session;
			const childInfo: TaskChildInfoV1 = {
				...childInfoBase,
				childSessionFile: sessionManager.getSessionFile() ?? childInfoBase.childSessionFile,
			};
			const started = await this.store.appendTaskStarted(taskId, childInfo, {
				eventId: `${taskId}:started`,
				idempotencyKey: `${taskId}:started`,
				expectedHead: created.head,
				actor: "runtime",
			});
			await input.onEvent?.(await this.store.replayTask(taskId), started.event.eventId);
			const active: ActiveChild = {
				taskId,
				session: childSession,
				child: childInfo,
				onEvent: input.onEvent,
				settling: Promise.resolve("running"),
				settled: false,
				detached: false,
			};
			this.active.set(taskId, active);
			active.settling = this.runChild(spec, active);
			return {
				taskId,
				childSessionId: childInfo.childSessionId,
				childSessionFile: childInfo.childSessionFile,
				completion: active.settling,
				cancel: async (reason = "Task cancelled by user") => this.cancel(taskId, reason),
			};
		} catch (error) {
			childSession?.dispose();
			const recovered = await this.store.recoverTaskOnStartup(
				taskId,
				error instanceof Error ? error.message : String(error),
			);
			const terminal = recovered.events.at(-1);
			if (terminal) await input.onEvent?.(recovered, terminal.eventId);
			throw error;
		}
	}

	private async runChild(spec: TaskSpecV1, active: ActiveChild): Promise<TaskStatus> {
		let finalStatus: TaskStatus = "running";
		try {
			await active.session.prompt(taskPrompt(spec));
			if (!active.settled) {
				const replay = await this.store.replayTask(spec.taskId);
				if (replay.status === "running") {
					const lastAssistant = [...active.session.messages]
						.reverse()
						.find((message) => message.role === "assistant");
					if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
						await this.finishProviderError(
							spec.taskId,
							active,
							replay,
							new Error(lastAssistant.errorMessage ?? "Child provider returned an error"),
						);
					} else {
						await this.finishMissingResult(spec.taskId, active, replay);
					}
				}
			}
		} catch (error) {
			if (!active.settled) {
				const replay = await this.store.replayTask(spec.taskId);
				if (replay.status === "running") await this.finishProviderError(spec.taskId, active, replay, error);
			}
		} finally {
			await active.terminalWrite?.catch(() => {});
			active.settled = true;
			this.active.delete(spec.taskId);
			active.session.dispose();
			finalStatus = (await this.store.replayTask(spec.taskId)).status;
			if (!active.detached) {
				try {
					await this.onSettled?.(spec.taskId, finalStatus);
				} catch {
					// Delivery is recoverable from the terminal event and must not change Task facts.
				}
			}
		}
		return finalStatus;
	}

	private async publishEvent(active: ActiveChild, eventId: string): Promise<void> {
		if (!active.onEvent) return;
		try {
			await active.onEvent(await this.store.replayTask(active.taskId), eventId);
		} catch {
			// Session links are recoverable projections and must not change Task facts.
		}
	}

	private async finishFromChild(taskId: string, active: ActiveChild, params: FinishTaskInput): Promise<void> {
		if (active.settled) return;
		const replay = await this.store.replayTask(taskId);
		if (replay.status !== "running") return;
		const error =
			params.status === "succeeded"
				? null
				: (params.error ?? { code: "child_reported_failure", message: params.summary });
		const result: TaskResultEnvelopeV1 = {
			schema: "pi-xk.task-result.v1",
			taskId,
			status: params.status,
			attempt: 1,
			summary: params.summary,
			evidence: params.evidence,
			artifactIds: params.artifactIds,
			childSessionId: active.child.childSessionId,
			childSessionFile: active.child.childSessionFile,
			startedAt: replay.events.find((event) => event.eventType === "task_started")?.timestamp ?? null,
			endedAt: new Date().toISOString(),
			error,
		};
		const written = await this.store.appendTaskResult(taskId, result, {
			eventId: `${taskId}:result`,
			idempotencyKey: `${taskId}:result`,
			expectedHead: replay.head,
			actor: "runtime",
		});
		active.settled = true;
		await this.publishEvent(active, written.event.eventId);
	}

	private async finishMissingResult(taskId: string, active: ActiveChild, replay: TaskReplay): Promise<void> {
		const result: TaskResultEnvelopeV1 = {
			schema: "pi-xk.task-result.v1",
			taskId,
			status: "failed",
			attempt: 1,
			summary: "Child ended without pi_xk_finish_task.",
			evidence: [],
			artifactIds: [],
			childSessionId: active.child.childSessionId,
			childSessionFile: active.child.childSessionFile,
			startedAt: replay.events.find((event) => event.eventType === "task_started")?.timestamp ?? null,
			endedAt: new Date().toISOString(),
			error: { code: "missing_task_result", message: "Child ended without pi_xk_finish_task." },
		};
		const written = await this.store.appendTaskResult(taskId, result, {
			eventId: `${taskId}:missing-result`,
			idempotencyKey: `${taskId}:missing-result`,
			expectedHead: replay.head,
			actor: "runtime",
		});
		active.settled = true;
		await this.publishEvent(active, written.event.eventId);
	}

	private async finishProviderError(
		taskId: string,
		active: ActiveChild,
		replay: TaskReplay,
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const result: TaskResultEnvelopeV1 = {
			schema: "pi-xk.task-result.v1",
			taskId,
			status: "failed",
			attempt: 1,
			summary: `Child provider error: ${message}`,
			evidence: [],
			artifactIds: [],
			childSessionId: active.child.childSessionId,
			childSessionFile: active.child.childSessionFile,
			startedAt: replay.events.find((event) => event.eventType === "task_started")?.timestamp ?? null,
			endedAt: new Date().toISOString(),
			error: { code: "provider_error", message },
		};
		const written = await this.store.appendTaskResult(taskId, result, {
			eventId: `${taskId}:provider-error`,
			idempotencyKey: `${taskId}:provider-error`,
			expectedHead: replay.head,
			actor: "runtime",
		});
		active.settled = true;
		await this.publishEvent(active, written.event.eventId);
	}

	async cancel(taskId: string, reason = "Task cancelled by user"): Promise<void> {
		const active = this.active.get(taskId);
		if (!active) return;
		if (active.terminalWrite) {
			await active.terminalWrite;
			return;
		}
		if (active.settled) return;
		active.settled = true;
		active.terminalWrite = (async () => {
			await active.session.abort();
			if (active.detached) return;
			const replay = await this.store.replayTask(taskId);
			if (replay.status !== "running") return;
			const written = await this.store.appendTaskCancelled(taskId, reason, {
				eventId: `${taskId}:cancelled`,
				idempotencyKey: `${taskId}:cancelled`,
				expectedHead: replay.head,
				actor: "user",
			});
			await this.publishEvent(active, written.event.eventId);
		})();
		await active.terminalWrite;
		await active.settling;
		active.session.dispose();
		this.active.delete(taskId);
	}

	async orphan(taskId: string, reason: string): Promise<void> {
		const active = this.active.get(taskId);
		if (active) {
			active.settled = true;
			active.detached = true;
		}
		const replay = await this.store.replayTask(taskId);
		if (replay.status === "running") {
			const written = await this.store.appendTaskOrphaned(taskId, reason, {
				eventId: `${taskId}:orphaned`,
				idempotencyKey: `${taskId}:orphaned:${replay.head.hash}`,
				expectedHead: replay.head,
				actor: "runtime",
			});
			if (active) await this.publishEvent(active, written.event.eventId);
		}
		if (!active) return;
		this.active.delete(taskId);
		active.session.dispose();
	}

	async cancelAll(reason: string): Promise<void> {
		for (const taskId of [...this.active.keys()]) await this.cancel(taskId, reason);
	}
}
