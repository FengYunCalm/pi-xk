import { randomUUID } from "node:crypto";
import type {
	AgentEndEvent,
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type GoalCheckpointV2,
	type GoalContractV1,
	GoalHeadConflictError,
	type GoalLifecycleEventInput,
	GoalStore,
} from "pi-xk-core";
import { Type } from "typebox";
import {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	createPiXkCompactionCheckpointIntent,
	createPiXkGoalBinding,
	createPiXkGoalCapture,
	createPiXkGoalLifecycleIntent,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	isPiXkGoalCapture,
	isPiXkGoalLifecycleIntent,
	isPiXkSessionLink,
	type PiXkCheckpointIntent,
	type PiXkGoalCapture,
	type PiXkGoalLifecycleIntent,
	type PiXkSessionLink,
} from "./session-link.ts";

export {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	createPiXkCompactionCheckpointIntent,
	createPiXkGoalBinding,
	createPiXkGoalCapture,
	createPiXkGoalLifecycleIntent,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	isPiXkGoalCapture,
	isPiXkGoalLifecycleIntent,
	isPiXkSessionLink,
	PI_XK_CHECKPOINT_INTENT_KIND,
	PI_XK_CHECKPOINT_REF_KIND,
	PI_XK_GOAL_CAPTURE_KIND,
	PI_XK_GOAL_LIFECYCLE_INTENT_KIND,
	PI_XK_SESSION_LINK_KIND,
	PI_XK_SESSION_LINK_SCHEMA,
	type PiXkCheckpointIntent,
	type PiXkCheckpointRef,
	type PiXkCompactionCheckpointIntent,
	type PiXkGoalCapture,
	type PiXkGoalCaptureState,
	type PiXkGoalLifecycleIntent,
	type PiXkGoalLifecycleIntentAction,
	type PiXkGoalLifecycleIntentState,
	type PiXkSessionLink,
	type PiXkTurnCheckpointIntent,
} from "./session-link.ts";

export const PI_XK_SESSION_LINK_CUSTOM_TYPE = "pi-xk.session-link";

export type PiXkLifecycleEvent =
	| Pick<AgentEndEvent, "type">
	| Pick<AgentSettledEvent, "type">
	| Pick<TurnEndEvent, "type" | "turnIndex">
	| Pick<SessionBeforeCompactEvent, "type" | "reason" | "willRetry">
	| Pick<SessionCompactEvent, "type" | "reason" | "willRetry" | "fromExtension">
	| Pick<SessionShutdownEvent, "type" | "reason">;

export interface PiXkExtensionOptions {
	/** SDK and test-only injection point; goal files are intentionally not read by the extension. */
	bindings?: readonly PiXkSessionLink[];
	/** Optional Goal event store used to persist turn checkpoints for injected bindings. */
	goalStore?: GoalStore;
	/** Dynamic bindings already persisted on the current Pi branch. */
	resolveBindings?: (ctx: ExtensionContext) => readonly PiXkSessionLink[];
	/** Dynamic Goal store lookup for package-installed extensions. */
	resolveGoalStore?: (ctx: ExtensionContext) => GoalStore | undefined;
	/** Restricts persistence to bindings whose Goal lifecycle is currently active. */
	shouldPersistBinding?: (binding: PiXkSessionLink, ctx: ExtensionContext) => boolean | Promise<boolean>;
	/** Required with goalStore so the SDK host can surface non-fatal checkpoint diagnostics. */
	onCheckpointError?: (error: Error) => void;
	/** Internal lifecycle observer; this extension does not persist checkpoints unless goalStore is injected. */
	onLifecycle?: (event: PiXkLifecycleEvent) => void;
}

function getGoalStore(options: PiXkExtensionOptions, ctx: ExtensionContext): GoalStore | undefined {
	return options.goalStore ?? options.resolveGoalStore?.(ctx);
}

function getResolvedBindings(options: PiXkExtensionOptions, ctx: ExtensionContext): PiXkSessionLink[] {
	const bindings: PiXkSessionLink[] = [];
	for (const binding of [...(options.bindings ?? []), ...(options.resolveBindings?.(ctx) ?? [])]) {
		assertPiXkSessionLink(binding);
		if (!bindings.some((existing) => isSameBinding(existing, binding))) {
			bindings.push(binding);
		}
	}
	return bindings;
}

async function getCheckpointBindings(options: PiXkExtensionOptions, ctx: ExtensionContext): Promise<PiXkSessionLink[]> {
	const bindings = getResolvedBindings(options, ctx);
	if (!options.shouldPersistBinding) return bindings;
	const eligible: PiXkSessionLink[] = [];
	for (const binding of bindings) {
		if (await options.shouldPersistBinding(binding, ctx)) eligible.push(binding);
	}
	return eligible;
}

function isSameBinding(left: PiXkSessionLink, right: PiXkSessionLink): boolean {
	return (
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.goalId === right.goalId &&
		left.generation === right.generation
	);
}

function isSameCheckpointIntent(left: PiXkCheckpointIntent, right: PiXkCheckpointIntent): boolean {
	if (
		left.goalId !== right.goalId ||
		left.sessionId !== right.sessionId ||
		left.leafId !== right.leafId ||
		left.reason !== right.reason ||
		left.generation !== right.generation
	) {
		return false;
	}
	if (left.reason !== "turn_end" || right.reason !== "turn_end") return true;
	return left.turnIndex === right.turnIndex && left.toolResultCount === right.toolResultCount;
}

function reportCheckpointError(options: PiXkExtensionOptions, error: unknown): void {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	if (!options.onCheckpointError) {
		throw new Error("Pi-XK checkpoint errors require an onCheckpointError receiver", { cause: normalizedError });
	}
	try {
		options.onCheckpointError(normalizedError);
	} catch {
		// Host diagnostics must not interrupt other Goal bindings in the same Pi lifecycle event.
	}
}

function checkpointTimestamp(event: TurnEndEvent): string {
	const timestamp =
		"timestamp" in event.message && typeof event.message.timestamp === "number"
			? event.message.timestamp
			: Date.now();
	return new Date(timestamp).toISOString();
}

function hasCheckpointRef(ctx: ExtensionContext, binding: PiXkSessionLink, eventId: string): boolean {
	return ctx.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry.data)
		.filter(isPiXkCheckpointRef)
		.some((ref) => ref.goalId === binding.goalId && ref.eventId === eventId && ref.generation === binding.generation);
}

function hasCheckpointIntent(ctx: ExtensionContext, intent: PiXkCheckpointIntent): boolean {
	return ctx.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry.data)
		.filter(isPiXkCheckpointIntent)
		.some((existing) => isSameCheckpointIntent(existing, intent));
}

function appendCheckpointRef(pi: ExtensionAPI, ctx: ExtensionContext, binding: PiXkSessionLink, eventId: string): void {
	if (!hasCheckpointRef(ctx, binding, eventId)) {
		pi.appendEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkCheckpointRef(binding.goalId, eventId, binding.generation),
		);
	}
}

function appendCheckpointIntent(pi: ExtensionAPI, ctx: ExtensionContext, intent: PiXkCheckpointIntent): void {
	if (!hasCheckpointIntent(ctx, intent)) {
		pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, intent);
	}
}

function getCheckpointIntents(
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	sessionId: string,
): PiXkCheckpointIntent[] {
	return ctx.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry.data)
		.filter(isPiXkCheckpointIntent)
		.filter(
			(intent) =>
				intent.goalId === binding.goalId &&
				intent.generation === binding.generation &&
				intent.sessionId === sessionId,
		);
}

function checkpointEventId(intent: PiXkCheckpointIntent): string {
	if (intent.reason === "turn_end") {
		return `evt_checkpoint_${intent.goalId}_${intent.sessionId}_${intent.leafId}`;
	}
	return `evt_checkpoint_compaction_${intent.goalId}_${intent.sessionId}_${intent.leafId}`;
}

function checkpointIdempotencyKey(intent: PiXkCheckpointIntent): string {
	return `checkpoint:${intent.goalId}:${intent.sessionId}:${intent.leafId}:${intent.reason}`;
}

async function checkpointFromIntent(goalStore: GoalStore, intent: PiXkCheckpointIntent): Promise<GoalCheckpointV2> {
	const artifact = await goalStore.putArtifact({
		contentType: "application/json",
		value:
			intent.reason === "turn_end"
				? {
						schema: "pi-xk.checkpoint-evidence.v1",
						goalId: intent.goalId,
						sessionId: intent.sessionId,
						leafId: intent.leafId,
						turnIndex: intent.turnIndex,
						toolResultCount: intent.toolResultCount,
						reason: intent.reason,
						createdAt: intent.createdAt,
					}
				: {
						schema: "pi-xk.compaction-source.v1",
						goalId: intent.goalId,
						sessionId: intent.sessionId,
						leafId: intent.leafId,
						reason: intent.reason,
						createdAt: intent.createdAt,
					},
		producer: intent.reason === "turn_end" ? "pi-xk.checkpoint-evidence.v1" : "pi-xk.compaction-source.v1",
		sensitivity: "redacted",
		sourceIds: [intent.sessionId, intent.leafId],
		createdAt: intent.createdAt,
	});
	const evidence = {
		schema: "pi-xk.goal-checkpoint-evidence.v1" as const,
		sourceEntryIds: [intent.leafId],
		artifacts: [
			{
				schema: "pi-xk.artifact-ref.v1" as const,
				artifactId: artifact.artifactId,
				role: intent.reason === "turn_end" ? ("checkpoint_evidence" as const) : ("compaction_source" as const),
			},
		],
	};
	if (intent.reason === "turn_end") {
		return {
			schema: "pi-xk.goal-checkpoint.v2",
			sessionId: intent.sessionId,
			leafId: intent.leafId,
			turnIndex: intent.turnIndex,
			toolResultCount: intent.toolResultCount,
			reason: "turn_end",
			createdAt: intent.createdAt,
			evidence,
		};
	}
	return {
		schema: "pi-xk.goal-checkpoint.v2",
		sessionId: intent.sessionId,
		leafId: intent.leafId,
		reason: "session_before_compact",
		createdAt: intent.createdAt,
		evidence,
	};
}

async function persistCheckpointIntent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	intent: PiXkCheckpointIntent,
	options: PiXkExtensionOptions,
): Promise<void> {
	const goalStore = getGoalStore(options, ctx);
	if (!goalStore) return;
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const replay = await goalStore.loadGoal(binding.goalId);
				const result = await goalStore.appendCheckpoint(
					binding.goalId,
					await checkpointFromIntent(goalStore, intent),
					{
						eventId: checkpointEventId(intent),
						idempotencyKey: checkpointIdempotencyKey(intent),
						expectedHead: replay.head,
					},
				);
				appendCheckpointRef(pi, ctx, binding, result.event.eventId);
				return;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
	} catch (error) {
		reportCheckpointError(options, error);
	}
}

async function synchronizeCheckpointRefs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	options: PiXkExtensionOptions,
): Promise<void> {
	const goalStore = getGoalStore(options, ctx);
	if (!goalStore) return;
	try {
		const replay = await goalStore.replayGoal(binding.goalId);
		if (replay.tailDiagnostic) {
			throw new Error(`Goal recovery is required before checkpoint refs can be synchronized: ${binding.goalId}`);
		}
		const sessionId = ctx.sessionManager.getSessionId();
		for (const event of replay.events) {
			if (event.eventType !== "goal_checkpointed" || event.payload.checkpoint.sessionId !== sessionId) continue;
			appendCheckpointRef(pi, ctx, binding, event.eventId);
		}
	} catch (error) {
		reportCheckpointError(options, error);
	}
}

async function synchronizeCheckpointState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: PiXkExtensionOptions,
): Promise<void> {
	if (!getGoalStore(options, ctx)) return;
	const sessionId = ctx.sessionManager.getSessionId();
	for (const binding of await getCheckpointBindings(options, ctx)) {
		for (const intent of getCheckpointIntents(ctx, binding, sessionId)) {
			await persistCheckpointIntent(pi, ctx, binding, intent, options);
		}
		await synchronizeCheckpointRefs(pi, ctx, binding, options);
	}
}

async function appendTurnCheckpointIntent(
	pi: ExtensionAPI,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	options: PiXkExtensionOptions,
): Promise<void> {
	if (!getGoalStore(options, ctx)) return;
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) return;
	try {
		const intent = createPiXkTurnCheckpointIntent(
			binding.goalId,
			ctx.sessionManager.getSessionId(),
			leafId,
			event.turnIndex,
			event.toolResults.length,
			binding.generation,
			checkpointTimestamp(event),
		);
		appendCheckpointIntent(pi, ctx, intent);
		await persistCheckpointIntent(pi, ctx, binding, intent, options);
	} catch (error) {
		reportCheckpointError(options, error);
	}
}

async function appendCompactionCheckpointIntent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	options: PiXkExtensionOptions,
): Promise<void> {
	if (!getGoalStore(options, ctx)) return;
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) return;
	try {
		const intent = createPiXkCompactionCheckpointIntent(
			binding.goalId,
			ctx.sessionManager.getSessionId(),
			leafId,
			binding.generation,
			new Date().toISOString(),
		);
		appendCheckpointIntent(pi, ctx, intent);
		await persistCheckpointIntent(pi, ctx, binding, intent, options);
	} catch (error) {
		reportCheckpointError(options, error);
	}
}

export function createPiXkExtension(options: PiXkExtensionOptions = {}): ExtensionFactory {
	const bindings = options.bindings ?? [];
	for (const binding of bindings) {
		assertPiXkSessionLink(binding);
	}
	if ((options.goalStore || options.resolveGoalStore) && !options.onCheckpointError) {
		throw new Error("Pi-XK checkpoint persistence requires an onCheckpointError receiver");
	}

	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			const existingBindings = ctx.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom")
				.map((entry) => entry.data)
				.filter(isPiXkSessionLink);

			for (const binding of bindings) {
				if (!existingBindings.some((existing) => isSameBinding(existing, binding))) {
					pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, binding);
					existingBindings.push(binding);
				}
			}
			await synchronizeCheckpointState(pi, ctx, options);
		});
		pi.on("turn_end", async (event, ctx) => {
			for (const binding of await getCheckpointBindings(options, ctx)) {
				await appendTurnCheckpointIntent(pi, event, ctx, binding, options);
			}
			options.onLifecycle?.({ type: event.type, turnIndex: event.turnIndex });
		});
		pi.on("session_before_compact", async (event, ctx) => {
			await synchronizeCheckpointState(pi, ctx, options);
			for (const binding of await getCheckpointBindings(options, ctx)) {
				await appendCompactionCheckpointIntent(pi, ctx, binding, options);
			}
			options.onLifecycle?.({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
		pi.on("session_compact", (event) => {
			options.onLifecycle?.({
				type: event.type,
				reason: event.reason,
				willRetry: event.willRetry,
				fromExtension: event.fromExtension,
			});
		});
		pi.on("agent_end", async (event, ctx) => {
			await synchronizeCheckpointState(pi, ctx, options);
			options.onLifecycle?.({ type: event.type });
		});
		pi.on("agent_settled", async (event, ctx) => {
			await synchronizeCheckpointState(pi, ctx, options);
			options.onLifecycle?.({ type: event.type });
		});
		pi.on("session_shutdown", async (event, ctx) => {
			await synchronizeCheckpointState(pi, ctx, options);
			options.onLifecycle?.({ type: event.type, reason: event.reason });
		});
	};
}

const PI_XK_GOAL_KICKOFF_CUSTOM_TYPE = "pi-xk.goal-kickoff.v1";

interface GoalLifecycleWrite {
	eventId: string;
	idempotencyKey: string;
	actor: "user" | "model" | "runtime";
	timestamp: string;
}

export interface PiXkGoalExtensionOptions {
	/** Test and SDK injection point for deterministic Goal IDs. */
	createGoalId?: () => string;
	/** Test and SDK injection point for lifecycle timestamps. */
	now?: () => Date;
	/** Test and SDK injection point for the project-local GoalStore. */
	createGoalStore?: (projectRoot: string) => GoalStore;
	/** Optional non-fatal diagnostic receiver for Goal command and lifecycle errors. */
	onGoalError?: (error: Error) => void;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function goalNow(options: PiXkGoalExtensionOptions): string {
	return (options.now?.() ?? new Date()).toISOString();
}

function newGoalId(options: PiXkGoalExtensionOptions): string {
	return options.createGoalId?.() ?? `goal_${randomUUID().replaceAll("-", "")}`;
}

function findCurrentGoalBinding(ctx: ExtensionContext): PiXkSessionLink | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkSessionLink(entry.data)
		) {
			return entry.data;
		}
	}
	return undefined;
}

function findCurrentGoalCapture(ctx: ExtensionContext): PiXkGoalCapture | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkGoalCapture(entry.data)
		) {
			return entry.data;
		}
	}
	return undefined;
}

function findPendingGoalLifecycleIntent(
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
): PiXkGoalLifecycleIntent | undefined {
	const settledIntentIds = new Set<string>();
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== PI_XK_SESSION_LINK_CUSTOM_TYPE ||
			!isPiXkGoalLifecycleIntent(entry.data) ||
			entry.data.goalId !== binding.goalId ||
			entry.data.generation !== binding.generation
		) {
			continue;
		}
		if (settledIntentIds.has(entry.data.intentId)) continue;
		settledIntentIds.add(entry.data.intentId);
		if (entry.data.state === "requested") return entry.data;
	}
	return undefined;
}

function notifyGoalError(ctx: ExtensionContext, options: PiXkGoalExtensionOptions, error: unknown): void {
	const normalized = normalizeError(error);
	try {
		options.onGoalError?.(normalized);
	} catch {
		// Host diagnostics must not break Pi command or agent lifecycles.
	}
	ctx.ui.notify(`Pi-XK Goal: ${normalized.message}`, "error");
}

function objectiveTitle(objective: string): string {
	const firstLine = objective.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

function kickoffGoal(pi: ExtensionAPI, goalId: string): void {
	pi.sendMessage(
		{
			customType: PI_XK_GOAL_KICKOFF_CUSTOM_TYPE,
			content: "Continue the active Pi-XK Goal according to its contract.",
			display: false,
			details: { goalId },
		},
		{ triggerTurn: true },
	);
}

async function appendGoalLifecycle(
	store: GoalStore,
	goalId: string,
	input: GoalLifecycleEventInput,
	write: GoalLifecycleWrite,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const replay = await store.replayGoal(goalId);
		try {
			await store.appendLifecycleEvent(goalId, input, {
				eventId: write.eventId,
				idempotencyKey: write.idempotencyKey,
				actor: write.actor,
				timestamp: write.timestamp,
				expectedHead: replay.head,
			});
			return;
		} catch (error) {
			if (error instanceof GoalHeadConflictError && attempt < 2) continue;
			throw error;
		}
	}
}

function lifecycleWrite(
	goalId: string,
	label: string,
	actor: GoalLifecycleWrite["actor"],
	timestamp: string,
	stableId = randomUUID().replaceAll("-", ""),
): GoalLifecycleWrite {
	return {
		eventId: `evt_${label}_${goalId}_${stableId}`,
		idempotencyKey: `lifecycle:${goalId}:${label}:${stableId}`,
		actor,
		timestamp,
	};
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function createGoalContract(
	goalId: string,
	objective: string,
	ownerSessionId: string,
	createdAt: string,
): GoalContractV1 {
	return {
		schema: "pi-xk.goal.contract.v1",
		goalId,
		title: objectiveTitle(objective),
		objective,
		constraints: [],
		acceptance: [],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId,
		createdAt,
		schemaVersion: 1,
	};
}

function createGoalStoreResolver(options: PiXkGoalExtensionOptions): (projectRoot: string) => GoalStore {
	const stores = new Map<string, GoalStore>();
	return (projectRoot) => {
		const existing = stores.get(projectRoot);
		if (existing) return existing;
		const store = options.createGoalStore?.(projectRoot) ?? new GoalStore(projectRoot);
		stores.set(projectRoot, store);
		return store;
	};
}

async function recoverOpenGoalRun(
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return;
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active" || !replay.lifecycle.openRunId) return;
	const timestamp = goalNow(options);
	await appendGoalLifecycle(
		store,
		binding.goalId,
		{
			eventType: "goal_run_interrupted",
			payload: { runId: replay.lifecycle.openRunId, reason: "session recovered", recovered: true },
		},
		lifecycleWrite(binding.goalId, "run_recovered", "runtime", timestamp),
	);
}

async function startGoalRun(
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return;
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active") return;
	if (replay.lifecycle.openRunId) {
		await recoverOpenGoalRun(ctx, storeFor, options);
	}
	const afterRecovery = await store.replayGoal(binding.goalId);
	if (afterRecovery.lifecycle.status !== "active" || afterRecovery.lifecycle.openRunId) return;
	const timestamp = goalNow(options);
	const runId = `run_${randomUUID().replaceAll("-", "")}`;
	await appendGoalLifecycle(
		store,
		binding.goalId,
		{ eventType: "goal_run_started", payload: { runId, sessionId: ctx.sessionManager.getSessionId() } },
		lifecycleWrite(binding.goalId, "run_started", "runtime", timestamp, runId),
	);
}

async function settleGoalRun(
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return;
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active" || !replay.lifecycle.openRunId) return;
	const timestamp = goalNow(options);
	await appendGoalLifecycle(
		store,
		binding.goalId,
		{ eventType: "goal_run_settled", payload: { runId: replay.lifecycle.openRunId } },
		lifecycleWrite(binding.goalId, "run_settled", "runtime", timestamp, replay.lifecycle.openRunId),
	);
}

async function settleGoalLifecycleIntent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<boolean> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return false;
	const intent = findPendingGoalLifecycleIntent(ctx, binding);
	if (!intent) return false;
	const store = storeFor(ctx.cwd);
	let replay = await store.replayGoal(binding.goalId);
	const timestamp = goalNow(options);
	if (intent.runId.length > 0 && replay.lifecycle.openRunId) {
		if (intent.runId !== replay.lifecycle.openRunId) {
			throw new Error(`lifecycle intent ${intent.intentId} does not match the active Goal run`);
		}
		await appendGoalLifecycle(
			store,
			binding.goalId,
			{ eventType: "goal_run_interrupted", payload: { runId: intent.runId, reason: intent.reason } },
			lifecycleWrite(binding.goalId, "run_interrupted", intent.actor, timestamp, intent.intentId),
		);
		replay = await store.replayGoal(binding.goalId);
	}
	if (intent.action === "pause" && replay.lifecycle.status === "active") {
		await appendGoalLifecycle(
			store,
			binding.goalId,
			{
				eventType: "goal_paused",
				payload: {
					reason: intent.reason,
					...(intent.nextBestAction.length > 0 ? { nextBestAction: intent.nextBestAction } : {}),
				},
			},
			lifecycleWrite(binding.goalId, "paused", intent.actor, timestamp, intent.intentId),
		);
	} else if (
		intent.action === "end" &&
		(replay.lifecycle.status === "active" || replay.lifecycle.status === "paused")
	) {
		await appendGoalLifecycle(
			store,
			binding.goalId,
			{
				eventType: "goal_ended",
				payload: {
					outcome: intent.outcome,
					...(intent.reason.length > 0 ? { reason: intent.reason } : {}),
					...(intent.finalEvidence.length > 0 ? { finalEvidence: intent.finalEvidence } : {}),
				},
			},
			lifecycleWrite(binding.goalId, "ended", intent.actor, timestamp, intent.intentId),
		);
	}
	pi.appendEntry(
		PI_XK_SESSION_LINK_CUSTOM_TYPE,
		createPiXkGoalLifecycleIntent({ ...intent, state: "committed", createdAt: timestamp }),
	);
	return true;
}

async function requestGoalLifecycleAction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
	action: PiXkGoalLifecycleIntent["action"],
	actor: PiXkGoalLifecycleIntent["actor"],
	reason: string,
	values: { nextBestAction?: string; outcome?: string; finalEvidence?: string } = {},
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) throw new Error("no Goal is bound to the current session branch");
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (action === "pause" && replay.lifecycle.status !== "active") {
		throw new Error("only an active Goal can be paused");
	}
	if (action === "end" && replay.lifecycle.status !== "active" && replay.lifecycle.status !== "paused") {
		throw new Error("only an active or paused Goal can be ended");
	}
	const timestamp = goalNow(options);
	const intentId = `intent_${randomUUID().replaceAll("-", "")}`;
	pi.appendEntry(
		PI_XK_SESSION_LINK_CUSTOM_TYPE,
		createPiXkGoalLifecycleIntent({
			intentId,
			goalId: binding.goalId,
			generation: binding.generation,
			actor,
			action,
			state: "requested",
			runId: ctx.isIdle() ? "" : (replay.lifecycle.openRunId ?? ""),
			reason,
			nextBestAction: values.nextBestAction ?? "",
			outcome: values.outcome ?? "ended",
			finalEvidence: values.finalEvidence ?? "",
			createdAt: timestamp,
		}),
	);
	if (ctx.isIdle()) {
		await settleGoalLifecycleIntent(pi, ctx, storeFor, options);
		return;
	}
	ctx.abort();
}

async function createGoalFromObjective(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
	objectiveInput: string,
	captureId?: string,
): Promise<void> {
	const objective = objectiveInput.trim();
	if (objective.length === 0) throw new Error("a Goal objective is required");
	const goalId = newGoalId(options);
	const timestamp = goalNow(options);
	const store = storeFor(ctx.cwd);
	const contract = createGoalContract(goalId, objective, ctx.sessionManager.getSessionId(), timestamp);
	await store.createGoal(contract, {
		eventId: `evt_goal_created_${goalId}`,
		idempotencyKey: `goal-created:${goalId}`,
		actor: "user",
		timestamp,
	});
	await appendGoalLifecycle(
		store,
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: ctx.sessionManager.getSessionId() } },
		lifecycleWrite(goalId, "activated", "user", timestamp),
	);
	const previous = findCurrentGoalBinding(ctx);
	const binding = createPiXkGoalBinding(goalId, previous ? previous.generation + 1 : 0);
	pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, binding);
	if (captureId) {
		pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalCapture(captureId, "consumed", timestamp));
	}
	kickoffGoal(pi, goalId);
}

async function startCurrentGoal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) throw new Error("no Goal is bound to the current session branch");
	if (!ctx.isIdle()) throw new Error("the agent is still busy");
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status === "paused") {
		const timestamp = goalNow(options);
		await appendGoalLifecycle(
			store,
			binding.goalId,
			{ eventType: "goal_resumed", payload: { reason: "started by user" } },
			lifecycleWrite(binding.goalId, "resumed", "user", timestamp),
		);
	} else if (replay.lifecycle.status !== "active") {
		throw new Error("only an active or paused Goal can be started");
	}
	kickoffGoal(pi, binding.goalId);
}

async function getActiveGoalObjectivePath(
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
): Promise<string | undefined> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return undefined;
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active") return undefined;
	const files = await store.inspectGoalFiles(binding.goalId);
	if (files.objective.status !== "valid" || files.state.status !== "valid") {
		throw new Error(`Goal files require repair: objective ${files.objective.status}, state ${files.state.status}`);
	}
	return files.objective.path;
}

function findCurrentKickoffMessageIndex(messages: readonly { role: string; customType?: string }[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user") return -1;
		if (message.role === "custom") {
			return message.customType === PI_XK_GOAL_KICKOFF_CUSTOM_TYPE ? index : -1;
		}
	}
	return -1;
}

async function showGoalStatus(
	ctx: ExtensionCommandContext,
	storeFor: (projectRoot: string) => GoalStore,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) {
		ctx.ui.notify("Pi-XK Goal: no Goal is bound to the current session branch", "info");
		return;
	}
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	const files = await store.inspectGoalFiles(binding.goalId);
	ctx.ui.notify(
		`Pi-XK Goal ${binding.goalId}: ${replay.lifecycle.status}; wall ${formatDuration(replay.lifecycle.wallElapsed)}, active ${formatDuration(replay.lifecycle.activeElapsed)}, busy ${formatDuration(replay.lifecycle.busyElapsed)}; objective ${files.objective.status}, state ${files.state.status}`,
		"info",
	);
}

export function createPiXkGoalExtension(options: PiXkGoalExtensionOptions = {}): ExtensionFactory {
	const storeFor = createGoalStoreResolver(options);
	return (pi) => {
		createPiXkExtension({
			resolveBindings: (ctx) => {
				const binding = findCurrentGoalBinding(ctx);
				return binding ? [binding] : [];
			},
			resolveGoalStore: (ctx) => storeFor(ctx.cwd),
			shouldPersistBinding: async (binding, ctx) => {
				const current = findCurrentGoalBinding(ctx);
				if (!current || !isSameBinding(current, binding)) return false;
				const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId);
				return replay.lifecycle.status === "active";
			},
			onCheckpointError: (error) => {
				try {
					options.onGoalError?.(error);
				} catch {
					// Host diagnostics must not interrupt Pi lifecycle events.
				}
			},
		})(pi);

		pi.registerTool({
			name: "pi_xk_pause_goal",
			label: "Pause Goal",
			description:
				"Pause the active Pi-XK Goal after you have updated goal-state.md with the current evidence and next best action.",
			parameters: Type.Object({
				reason: Type.String({ description: "Why this Goal should pause" }),
				nextBestAction: Type.Optional(Type.String({ description: "The next action to record in goal-state.md" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					await requestGoalLifecycleAction(pi, ctx, storeFor, options, "pause", "model", params.reason, {
						nextBestAction: params.nextBestAction,
					});
					return { content: [{ type: "text", text: "Goal pause requested." }], details: {} };
				} catch (error) {
					return {
						content: [{ type: "text", text: `Goal pause failed: ${normalizeError(error).message}` }],
						details: {},
					};
				}
			},
		});
		pi.registerTool({
			name: "pi_xk_end_goal",
			label: "End Goal",
			description: "End the active Pi-XK Goal after you have updated goal-state.md with final evidence and outcome.",
			parameters: Type.Object({
				outcome: Type.String({ description: "The final Goal outcome" }),
				reason: Type.String({ description: "Why this Goal is ending" }),
				finalEvidence: Type.Optional(Type.String({ description: "Final evidence recorded in goal-state.md" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					await requestGoalLifecycleAction(pi, ctx, storeFor, options, "end", "model", params.reason, {
						outcome: params.outcome,
						finalEvidence: params.finalEvidence,
					});
					return { content: [{ type: "text", text: "Goal end requested." }], details: {} };
				} catch (error) {
					return {
						content: [{ type: "text", text: `Goal end failed: ${normalizeError(error).message}` }],
						details: {},
					};
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			try {
				await recoverOpenGoalRun(ctx, storeFor, options);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("before_agent_start", async (event, ctx) => {
			if (event.systemPrompt.includes("<pi-xk-goal>")) return;
			try {
				const objectivePath = await getActiveGoalObjectivePath(ctx, storeFor);
				if (!objectivePath) return;
				return {
					systemPrompt: `${event.systemPrompt}\n\n<pi-xk-goal>\nAn active Pi-XK Goal is bound to this session. Read ${objectivePath} and follow its contract.\n</pi-xk-goal>`,
				};
			} catch (error) {
				notifyGoalError(ctx, options, error);
				return;
			}
		});
		pi.on("context", async (event, ctx) => {
			const kickoffIndex = findCurrentKickoffMessageIndex(event.messages);
			if (kickoffIndex < 0) return;
			try {
				const objectivePath = await getActiveGoalObjectivePath(ctx, storeFor);
				if (!objectivePath) return;
				return {
					messages: event.messages.map((message, index) =>
						index === kickoffIndex && message.role === "custom"
							? {
									...message,
									content: `An active Pi-XK Goal is bound to this session. Read ${objectivePath} and follow its contract.`,
								}
							: message,
					),
				};
			} catch (error) {
				notifyGoalError(ctx, options, error);
				return;
			}
		});
		pi.on("agent_start", async (_event, ctx) => {
			try {
				await startGoalRun(ctx, storeFor, options);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("agent_settled", async (_event, ctx) => {
			try {
				if (!(await settleGoalLifecycleIntent(pi, ctx, storeFor, options))) {
					await settleGoalRun(ctx, storeFor, options);
				}
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("input", async (event, ctx) => {
			const capture = findCurrentGoalCapture(ctx);
			if (!capture || capture.state !== "open") return { action: "continue" };
			try {
				await createGoalFromObjective(pi, ctx, storeFor, options, event.text, capture.captureId);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
			return { action: "handled" };
		});
		pi.registerCommand("goal", {
			description: "Create, control, or inspect the current Pi-XK Goal",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				try {
					if (trimmed.length === 0) {
						const capture = findCurrentGoalCapture(ctx);
						const timestamp = goalNow(options);
						if (capture?.state === "open") {
							pi.appendEntry(
								PI_XK_SESSION_LINK_CUSTOM_TYPE,
								createPiXkGoalCapture(capture.captureId, "cancelled", timestamp),
							);
							ctx.ui.notify("Pi-XK Goal objective capture cancelled", "info");
						} else {
							pi.appendEntry(
								PI_XK_SESSION_LINK_CUSTOM_TYPE,
								createPiXkGoalCapture(`capture_${randomUUID().replaceAll("-", "")}`, "open", timestamp),
							);
							ctx.ui.notify("Pi-XK Goal objective capture is ready", "info");
						}
						return;
					}
					if (trimmed === "status") {
						await showGoalStatus(ctx, storeFor);
						return;
					}
					if (trimmed === "start") {
						await startCurrentGoal(pi, ctx, storeFor, options);
						return;
					}
					if (trimmed === "pause" || trimmed.startsWith("pause ")) {
						const reason = trimmed.slice("pause".length).trim() || "paused by user";
						await requestGoalLifecycleAction(pi, ctx, storeFor, options, "pause", "user", reason);
						return;
					}
					if (trimmed === "end" || trimmed.startsWith("end ")) {
						const reason = trimmed.slice("end".length).trim() || "ended by user";
						await requestGoalLifecycleAction(pi, ctx, storeFor, options, "end", "user", reason, {
							outcome: "ended_by_user",
						});
						return;
					}
					const objective = trimmed.startsWith("--") ? trimmed.slice(2).trimStart() : args;
					await createGoalFromObjective(pi, ctx, storeFor, options, objective);
				} catch (error) {
					notifyGoalError(ctx, options, error);
				}
			},
		});
	};
}
