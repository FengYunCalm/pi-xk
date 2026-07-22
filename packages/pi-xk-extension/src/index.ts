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
	type GoalContractV2,
	GoalHeadConflictError,
	type GoalLifecycleEventInput,
	type GoalLifecycleStatus,
	GoalStore,
	validateGoalLifecycleEventForContract,
} from "pi-xk-core";
import { Type } from "typebox";
import { createGoalDraftReviewComponent, type GoalDraftReviewAction } from "./goal-ui.ts";

export { TaskRunner, type TaskRunnerHandle, type TaskRunnerOptions, type TaskRunnerStartInput } from "./task-runner.ts";

import {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	createPiXkCompactionCheckpointIntent,
	createPiXkGoalBinding,
	createPiXkGoalCapture,
	createPiXkGoalDraft,
	createPiXkGoalLifecycleIntent,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	isPiXkGoalCapture,
	isPiXkGoalDraft,
	isPiXkGoalLifecycleIntent,
	isPiXkSessionLink,
	normalizePiXkGoalLifecycleIntent,
	type PiXkCheckpointIntent,
	type PiXkGoalCapture,
	type PiXkGoalDraft,
	type PiXkGoalDraftProposal,
	type PiXkGoalLifecycleIntent,
	type PiXkGoalPauseAudit,
	type PiXkSessionLink,
	type PiXkStoredGoalLifecycleIntent,
} from "./session-link.ts";

export {
	assertPiXkSessionLink,
	assertPiXkTaskLink,
	createPiXkCheckpointRef,
	createPiXkCompactionCheckpointIntent,
	createPiXkGoalBinding,
	createPiXkGoalCapture,
	createPiXkGoalDraft,
	createPiXkGoalLifecycleIntent,
	createPiXkTaskLink,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	isPiXkGoalCapture,
	isPiXkGoalDraft,
	isPiXkGoalLifecycleIntent,
	isPiXkSessionLink,
	isPiXkTaskLink,
	normalizePiXkGoalLifecycleIntent,
	PI_XK_CHECKPOINT_INTENT_KIND,
	PI_XK_CHECKPOINT_REF_KIND,
	PI_XK_GOAL_CAPTURE_KIND,
	PI_XK_GOAL_DRAFT_KIND,
	PI_XK_GOAL_LIFECYCLE_INTENT_KIND,
	PI_XK_SESSION_LINK_KIND,
	PI_XK_SESSION_LINK_SCHEMA,
	PI_XK_TASK_LINK_KIND,
	type PiXkCheckpointIntent,
	type PiXkCheckpointRef,
	type PiXkCompactionCheckpointIntent,
	type PiXkGoalCapture,
	type PiXkGoalCaptureState,
	type PiXkGoalDraft,
	type PiXkGoalDraftAcceptance,
	type PiXkGoalDraftAcceptanceKind,
	type PiXkGoalDraftProposal,
	type PiXkGoalDraftState,
	type PiXkGoalLifecycleIntent,
	type PiXkGoalLifecycleIntentAction,
	type PiXkGoalLifecycleIntentState,
	type PiXkGoalPauseAudit,
	type PiXkSessionLink,
	type PiXkStoredGoalLifecycleIntent,
	type PiXkTaskLink,
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
	/** Internal composition switch for hosts that serialize session recovery themselves. */
	synchronizeOnSessionStart?: boolean;
	/** Internal composition switch for hosts that settle lifecycle intents during shutdown. */
	synchronizeOnSessionShutdown?: boolean;
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
): Promise<boolean> {
	const goalStore = getGoalStore(options, ctx);
	if (!goalStore) return true;
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
				return true;
			} catch (error) {
				if (attempt === 1) throw error;
			}
		}
	} catch (error) {
		reportCheckpointError(options, error);
		return false;
	}
	return false;
}

async function synchronizeCheckpointRefs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	options: PiXkExtensionOptions,
): Promise<boolean> {
	const goalStore = getGoalStore(options, ctx);
	if (!goalStore) return true;
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
		return true;
	} catch (error) {
		reportCheckpointError(options, error);
		return false;
	}
}

async function synchronizeCheckpointState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: PiXkExtensionOptions,
): Promise<boolean> {
	if (!getGoalStore(options, ctx)) return true;
	let synchronized = true;
	const sessionId = ctx.sessionManager.getSessionId();
	for (const binding of await getCheckpointBindings(options, ctx)) {
		for (const intent of getCheckpointIntents(ctx, binding, sessionId)) {
			if (!(await persistCheckpointIntent(pi, ctx, binding, intent, options))) synchronized = false;
		}
		if (!(await synchronizeCheckpointRefs(pi, ctx, binding, options))) synchronized = false;
	}
	return synchronized;
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
			if (options.synchronizeOnSessionStart !== false) {
				await synchronizeCheckpointState(pi, ctx, options);
			}
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
			if (options.synchronizeOnSessionShutdown !== false) {
				await synchronizeCheckpointState(pi, ctx, options);
			}
			options.onLifecycle?.({ type: event.type, reason: event.reason });
		});
	};
}

const PI_XK_GOAL_KICKOFF_CUSTOM_TYPE = "pi-xk.goal-kickoff.v1";

const PI_XK_GOAL_DRAFT_KICKOFF_CUSTOM_TYPE = "pi-xk.goal-draft-kickoff.v1";

const PI_XK_GOAL_DRAFT_REVIEW_CUSTOM_TYPE = "pi-xk.goal-draft-review.v1";

const PI_XK_GOAL_STATUS_KEY = "pi-xk-goal";

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
	/** Test and SDK injection point for retry delays after provider failures. */
	retryDelayMs?: (consecutiveFailureCount: number) => number;
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

function findCurrentGoalDraft(ctx: ExtensionContext): PiXkGoalDraft | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkGoalDraft(entry.data)
		) {
			return entry.data;
		}
	}
	return undefined;
}

function isOutstandingGoalDraft(draft: PiXkGoalDraft | undefined): boolean {
	return draft?.state === "requested" || draft?.state === "proposed" || draft?.state === "confirming";
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
			!isPiXkGoalLifecycleIntent(entry.data)
		) {
			continue;
		}
		const intent = normalizePiXkGoalLifecycleIntent(entry.data as PiXkStoredGoalLifecycleIntent);
		if (intent.goalId !== binding.goalId || intent.generation !== binding.generation) continue;
		if (settledIntentIds.has(intent.intentId)) continue;
		settledIntentIds.add(intent.intentId);
		if (intent.state === "requested") return intent;
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
	try {
		ctx.ui.notify(`Pi-XK Goal: ${normalized.message}`, "error");
	} catch {
		// A delayed retry can outlive a replaced extension context; diagnostics must not leak an unhandled rejection.
	}
}

function goalRuntimePrompt(objectivePath: string, statePath: string): string {
	return [
		`An active Pi-XK Goal is bound to this session. Read ${objectivePath} and ${statePath} before substantive work.`,
		"Audit every required acceptance against verification evidence before deciding whether to continue, pause, or end.",
		"Treat goal-state.md as the authoritative execution state. Do not repeat work already recorded as done or retry a rejected path unless code, inputs, evidence, or assumptions changed. Update done, open, rejected paths, evidence, next action, assumptions, and blockers whenever they materially change.",
		"A normal assistant response does not end this Goal: Pi-XK continues active Goals into another run.",
		"Continue whenever an in-scope action can still advance an unmet required acceptance. Ordinary text, partial results, token use, run count, or a written plan are never pause or end reasons.",
		"Before calling pi_xk_pause_goal, update the state and record unmet required acceptance IDs, current evidence, an incomplete conclusion, blockers, any user request, and the next best action.",
		"Call pi_xk_end_goal only after all required acceptance criteria have verification evidence; update the state with verified IDs, final evidence, and a final summary first.",
	].join("\n");
}

function goalDraftRuntimePrompt(draft: PiXkGoalDraft): string {
	return [
		"A Pi-XK Goal draft is pending user confirmation. Draft the contract only; do not perform Goal work, create a Goal, write files, or call pi_xk_start_goal, pi_xk_pause_goal, or pi_xk_end_goal.",
		"Turn the requested objective into one durable, concise contract. Keep stable outcome, verification, constraints, authorization, and stopping rules separate from changing execution state. Do not put changing progress, completed work, failed attempts, current blockers, or the next action into the contract.",
		"Define at least one required acceptance with an observable verification path. State constraints, non-goals, a done condition requiring verified evidence for every required acceptance, a pause condition that applies only when no meaningful in-scope action can proceed without new input or external change, and final report expectations.",
		"Execution authorization must preserve any explicit user authorization. Unless the request says otherwise, authorize direct in-scope code, test, script, and formal-document edits, but require separate user approval for destructive operations, scope expansion, commit/push, deployment, or other external-state changes.",
		"Use pi_xk_submit_goal_draft exactly once after reasoning. It is the only Goal-related tool available for this draft kickoff.",
		`Requested objective:\n${draft.objective}`,
		...(draft.revisionFeedback === null ? [] : [`Revision feedback:\n${draft.revisionFeedback}`]),
	].join("\n\n");
}

function pausedGoalRecoveryPrompt(objectivePath: string, statePath: string): string {
	return [
		`A paused Pi-XK Goal is bound to this session. Read ${objectivePath} and ${statePath}, including the latest pause audit, before deciding whether the new user input changes the blocker.`,
		"Do not perform Goal work while this Goal remains paused.",
		"Call pi_xk_start_goal only when this input, an external change, or new evidence actually removes the recorded blocker. If you call start, stop this ordinary turn immediately; Pi-XK will begin a new active Goal kickoff.",
	].join("\n");
}

function kickoffGoal(pi: ExtensionAPI, goalId: string): void {
	pi.sendMessage(
		{
			customType: PI_XK_GOAL_KICKOFF_CUSTOM_TYPE,
			content: "Continue the active Pi-XK Goal according to its durable contract.",
			display: false,
			details: { goalId },
		},
		{ triggerTurn: true },
	);
}

function kickoffGoalDraft(pi: ExtensionAPI, draftId: string): void {
	pi.sendMessage(
		{
			customType: PI_XK_GOAL_DRAFT_KICKOFF_CUSTOM_TYPE,
			content: "Prepare the requested Pi-XK Goal draft.",
			display: false,
			details: { draftId },
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

function appendRejectedGoalLifecycleIntent(pi: ExtensionAPI, intent: PiXkGoalLifecycleIntent, timestamp: string): void {
	pi.appendEntry(
		PI_XK_SESSION_LINK_CUSTOM_TYPE,
		createPiXkGoalLifecycleIntent({ ...intent, state: "rejected", createdAt: timestamp }),
	);
}

function rejectGoalLifecycleIntent(
	pi: ExtensionAPI,
	intent: PiXkGoalLifecycleIntent,
	timestamp: string,
	message: string,
): never {
	appendRejectedGoalLifecycleIntent(pi, intent, timestamp);
	throw new Error(message);
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

interface GoalStatusSnapshot {
	status: GoalLifecycleStatus;
	activeElapsed: number;
	observedAt: number;
}

function activeElapsedForStatus(snapshot: GoalStatusSnapshot, now: number): number {
	if (snapshot.status !== "active") return snapshot.activeElapsed;
	return snapshot.activeElapsed + Math.max(0, now - snapshot.observedAt);
}

function formatGoalFooterStatus(snapshot: GoalStatusSnapshot, now: number): string {
	return `Goal ${snapshot.status} · ${formatDuration(activeElapsedForStatus(snapshot, now))}`;
}

function createGoalContract(
	goalId: string,
	proposal: PiXkGoalDraftProposal,
	ownerSessionId: string,
	createdAt: string,
): GoalContractV2 {
	return {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: proposal.title,
		objective: proposal.objective,
		constraints: [...proposal.constraints],
		acceptance: proposal.acceptance.map((acceptance) => ({ ...acceptance })),
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId,
		createdAt,
		schemaVersion: 2,
		nonGoals: [...proposal.nonGoals],
		doneCondition: proposal.doneCondition,
		pauseCondition: proposal.pauseCondition,
		finalReport: proposal.finalReport,
		executionAuthorization: proposal.executionAuthorization,
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
	if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return;
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
	if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return;
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
	if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return;
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

type GoalRunOutcome = "continue" | "error" | "aborted";

function goalRunOutcome(event: AgentEndEvent): GoalRunOutcome {
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "error") return "error";
		if (message.stopReason === "aborted") return "aborted";
		return "continue";
	}
	return "aborted";
}

async function continueActiveGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
): Promise<void> {
	if (!ctx.isIdle()) return;
	if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return;
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return;
	const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active" || replay.lifecycle.openRunId) return;
	kickoffGoal(pi, binding.goalId);
}

interface GoalLifecycleActionValues {
	resumeEvidence?: string;
	userRequest?: string | null;
	nextBestAction?: string;
	audit?: PiXkGoalPauseAudit;
	outcome?: string;
	verifiedAcceptanceIds?: string[];
	finalEvidence?: string;
	finalSummary?: string;
}

function requiredAcceptanceIds(contract: GoalContractV2): string[] {
	return contract.acceptance.filter((acceptance) => acceptance.required).map((acceptance) => acceptance.id);
}

function defaultUserPauseAudit(contract: GoalContractV2): PiXkGoalPauseAudit {
	return {
		unmetRequiredAcceptanceIds: requiredAcceptanceIds(contract),
		currentEvidence: "The user paused the Goal before all required acceptance evidence was recorded.",
		incompleteConclusion: "The Goal remains incomplete until the required acceptance evidence is verified.",
	};
}

function lifecycleInputForIntent(intent: PiXkGoalLifecycleIntent): GoalLifecycleEventInput {
	if (intent.action === "start") {
		return {
			eventType: "goal_resumed",
			payload: { reason: intent.reason, resumeEvidence: intent.resumeEvidence },
		};
	}
	if (intent.action === "pause") {
		return {
			eventType: "goal_paused",
			payload: {
				reason: intent.reason,
				userRequest: intent.userRequest,
				nextBestAction: intent.nextBestAction,
				audit: intent.audit,
			},
		};
	}
	return {
		eventType: "goal_ended",
		payload: {
			outcome: intent.outcome,
			...(intent.reason.length > 0 ? { reason: intent.reason } : {}),
			...(intent.verifiedAcceptanceIds.length > 0
				? { verifiedAcceptanceIds: [...intent.verifiedAcceptanceIds] }
				: {}),
			...(intent.finalEvidence.length > 0 ? { finalEvidence: intent.finalEvidence } : {}),
			...(intent.finalSummary.length > 0 ? { finalSummary: intent.finalSummary } : {}),
		},
	};
}

function hasFinalRunCheckpoint(
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	replay: Awaited<ReturnType<GoalStore["replayGoal"]>>,
	intent: PiXkGoalLifecycleIntent,
): boolean {
	if (intent.runId.length === 0) return false;
	const runStart = replay.events.find(
		(event) => event.eventType === "goal_run_started" && event.payload.runId === intent.runId,
	);
	if (!runStart || runStart.eventType !== "goal_run_started") return false;
	let lifecycleIntentSeen = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PI_XK_SESSION_LINK_CUSTOM_TYPE) continue;
		if (isPiXkGoalLifecycleIntent(entry.data)) {
			const storedIntent = normalizePiXkGoalLifecycleIntent(entry.data);
			if (storedIntent.intentId === intent.intentId && storedIntent.state === "requested") {
				lifecycleIntentSeen = true;
			}
			continue;
		}
		if (!lifecycleIntentSeen || !isPiXkCheckpointIntent(entry.data) || entry.data.reason !== "turn_end") continue;
		if (
			entry.data.goalId !== binding.goalId ||
			entry.data.generation !== binding.generation ||
			entry.data.sessionId !== runStart.payload.sessionId
		) {
			continue;
		}
		const expectedEventId = checkpointEventId(entry.data);
		if (
			replay.events.some(
				(event) =>
					event.eventType === "goal_checkpointed" &&
					event.eventId === expectedEventId &&
					event.payload.checkpoint.reason === "turn_end",
			)
		) {
			return true;
		}
	}
	return false;
}

function lifecycleIntentStateError(intent: PiXkGoalLifecycleIntent, status: GoalLifecycleStatus): string | undefined {
	if (intent.action === "start" && status !== "paused") return "only a paused Goal can be started";
	if (intent.action === "pause" && status !== "active") return "only an active Goal can be paused";
	if (intent.action === "end" && status !== "active" && status !== "paused") {
		return "only an active or paused Goal can be ended";
	}
	return undefined;
}

async function isLifecycleIntentCheckpointReady(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	checkpointOptions: PiXkExtensionOptions,
	goalOptions: PiXkGoalExtensionOptions,
	intent: PiXkGoalLifecycleIntent,
): Promise<boolean> {
	if (intent.actor !== "model" || intent.action === "start") return true;
	if (!(await synchronizeCheckpointState(pi, ctx, checkpointOptions))) return false;
	const binding = findCurrentGoalBinding(ctx);
	if (!binding || binding.goalId !== intent.goalId || binding.generation !== intent.generation) return false;
	const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId);
	if (hasFinalRunCheckpoint(ctx, binding, replay, intent)) return true;
	notifyGoalError(ctx, goalOptions, new Error("model lifecycle intent is waiting for a durable final checkpoint"));
	return false;
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
	if (intent.action === "start") {
		if (replay.lifecycle.status !== "paused") {
			rejectGoalLifecycleIntent(pi, intent, timestamp, "only a paused Goal can be started");
		}
		await appendGoalLifecycle(
			store,
			binding.goalId,
			lifecycleInputForIntent(intent),
			lifecycleWrite(binding.goalId, "resumed", intent.actor, timestamp, intent.intentId),
		);
		pi.appendEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalLifecycleIntent({ ...intent, state: "committed", createdAt: timestamp }),
		);
		kickoffGoal(pi, binding.goalId);
		return true;
	}
	if (intent.runId.length > 0 && replay.lifecycle.openRunId) {
		if (intent.runId !== replay.lifecycle.openRunId) {
			rejectGoalLifecycleIntent(
				pi,
				intent,
				timestamp,
				`lifecycle intent ${intent.intentId} does not match the active Goal run`,
			);
		}
		await appendGoalLifecycle(
			store,
			binding.goalId,
			{ eventType: "goal_run_interrupted", payload: { runId: intent.runId, reason: intent.reason } },
			lifecycleWrite(binding.goalId, "run_interrupted", intent.actor, timestamp, intent.intentId),
		);
		replay = await store.replayGoal(binding.goalId);
	}
	if (intent.action === "pause") {
		if (replay.lifecycle.status !== "active") {
			rejectGoalLifecycleIntent(pi, intent, timestamp, "only an active Goal can be paused");
		}
		await appendGoalLifecycle(
			store,
			binding.goalId,
			lifecycleInputForIntent(intent),
			lifecycleWrite(binding.goalId, "paused", intent.actor, timestamp, intent.intentId),
		);
	} else if (intent.action === "end") {
		if (replay.lifecycle.status !== "active" && replay.lifecycle.status !== "paused") {
			rejectGoalLifecycleIntent(pi, intent, timestamp, "only an active or paused Goal can be ended");
		}
		await appendGoalLifecycle(
			store,
			binding.goalId,
			lifecycleInputForIntent(intent),
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
	values: GoalLifecycleActionValues = {},
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) throw new Error("no Goal is bound to the current session branch");
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (action === "pause" && replay.lifecycle.status !== "active") {
		throw new Error("only an active Goal can be paused");
	}
	if (action === "start" && replay.lifecycle.status !== "paused") {
		throw new Error("only a paused Goal can be started");
	}
	if (action === "end" && replay.lifecycle.status !== "active" && replay.lifecycle.status !== "paused") {
		throw new Error("only an active or paused Goal can be ended");
	}
	const timestamp = goalNow(options);
	const intentId = `intent_${randomUUID().replaceAll("-", "")}`;
	const intent = createPiXkGoalLifecycleIntent({
		intentId,
		goalId: binding.goalId,
		generation: binding.generation,
		actor,
		action,
		state: "requested",
		runId: action === "start" ? "" : (replay.lifecycle.openRunId ?? ""),
		reason,
		resumeEvidence: values.resumeEvidence ?? "",
		userRequest: values.userRequest ?? (actor === "user" && action === "pause" ? reason : null),
		nextBestAction:
			values.nextBestAction ??
			(actor === "user" && action === "pause" ? "Wait for a user command or new evidence." : ""),
		audit:
			values.audit ??
			(actor === "user" && action === "pause"
				? defaultUserPauseAudit(replay.contract)
				: { unmetRequiredAcceptanceIds: [], currentEvidence: "", incompleteConclusion: "" }),
		outcome: values.outcome ?? (actor === "user" && action === "end" ? "ended_by_user" : "ended"),
		verifiedAcceptanceIds: values.verifiedAcceptanceIds ?? [],
		finalEvidence: values.finalEvidence ?? "",
		finalSummary:
			values.finalSummary ?? (actor === "user" && action === "end" ? "Goal ended by explicit user request." : ""),
		createdAt: timestamp,
	});
	validateGoalLifecycleEventForContract(lifecycleInputForIntent(intent), replay.sourceContract, actor);
	pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, intent);
	if (actor === "user") {
		if (ctx.isIdle()) {
			await settleGoalLifecycleIntent(pi, ctx, storeFor, options);
		} else {
			ctx.abort();
		}
	}
}

function renderGoalDraftMarkdown(draft: PiXkGoalDraft): string {
	if (draft.proposal === null) {
		return ["# Goal Draft", "", "## Requested objective", draft.objective || "Awaiting the next user input."].join(
			"\n",
		);
	}
	const proposal = draft.proposal;
	return [
		"# Goal Draft",
		"",
		`## ${proposal.title}`,
		"",
		"## Objective",
		proposal.objective,
		"",
		"## Constraints",
		...(proposal.constraints.length > 0
			? proposal.constraints.map((constraint) => `- ${constraint}`)
			: ["- None declared."]),
		"",
		"## Non-goals",
		...(proposal.nonGoals.length > 0 ? proposal.nonGoals.map((nonGoal) => `- ${nonGoal}`) : ["- None declared."]),
		"",
		"## Acceptance",
		...proposal.acceptance.map((acceptance) => {
			const command = acceptance.command === undefined ? "" : ` Verify: ${acceptance.command}`;
			const description = acceptance.description.endsWith(".")
				? acceptance.description
				: `${acceptance.description}.`;
			return `- ${acceptance.id} (${acceptance.required ? "required" : "optional"}): ${description}${command}`;
		}),
		"",
		"## Done condition",
		proposal.doneCondition,
		"",
		"## Pause condition",
		proposal.pauseCondition,
		"",
		"## Final report",
		proposal.finalReport,
		"",
		"## Execution authorization",
		proposal.executionAuthorization,
	].join("\n");
}

function appendGoalDraft(pi: ExtensionAPI, draft: PiXkGoalDraft): void {
	pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, draft);
}

async function assertGoalDraftAllowed(
	ctx: ExtensionCommandContext | ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
): Promise<void> {
	if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) {
		throw new Error("a Goal draft is already awaiting review");
	}
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return;
	const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId);
	if (replay.lifecycle.status === "active" || replay.lifecycle.status === "paused") {
		throw new Error("end the current Goal before drafting another Goal");
	}
}

async function requestGoalDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
	objectiveInput: string,
	captureId?: string,
): Promise<void> {
	if (!ctx.isIdle()) throw new Error("the agent is still busy");
	const objective = objectiveInput.trim();
	if (objective.length === 0) throw new Error("a Goal objective is required");
	await assertGoalDraftAllowed(ctx, storeFor);
	const timestamp = goalNow(options);
	const draft = createPiXkGoalDraft({
		draftId: `draft_${randomUUID().replaceAll("-", "")}`,
		state: "requested",
		objective,
		revisionFeedback: null,
		proposal: null,
		goalId: null,
		createdAt: timestamp,
	});
	appendGoalDraft(pi, draft);
	if (captureId) {
		pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalCapture(captureId, "consumed", timestamp));
	}
	kickoffGoalDraft(pi, draft.draftId);
}

function submitGoalDraft(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: PiXkGoalExtensionOptions,
	proposal: PiXkGoalDraftProposal,
): void {
	const draft = findCurrentGoalDraft(ctx);
	if (!draft || draft.state !== "requested" || draft.objective.length === 0) {
		throw new Error("no requested Goal draft is awaiting model submission");
	}
	appendGoalDraft(
		pi,
		createPiXkGoalDraft({
			draftId: draft.draftId,
			state: "proposed",
			objective: proposal.objective,
			revisionFeedback: null,
			proposal,
			goalId: null,
			createdAt: goalNow(options),
		}),
	);
}

function reviseGoalDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	options: PiXkGoalExtensionOptions,
	feedbackInput: string,
): void {
	if (!ctx.isIdle()) throw new Error("the agent is still busy");
	const feedback = feedbackInput.trim();
	if (feedback.length === 0) throw new Error("Goal draft revision feedback is required");
	const draft = findCurrentGoalDraft(ctx);
	if (!draft || draft.state !== "proposed" || draft.proposal === null) {
		throw new Error("a proposed Goal draft is required before revision");
	}
	const timestamp = goalNow(options);
	appendGoalDraft(
		pi,
		createPiXkGoalDraft({
			draftId: draft.draftId,
			state: "superseded",
			objective: draft.objective,
			revisionFeedback: feedback,
			proposal: draft.proposal,
			goalId: null,
			createdAt: timestamp,
		}),
	);
	const revised = createPiXkGoalDraft({
		draftId: draft.draftId,
		state: "requested",
		objective: draft.proposal.objective,
		revisionFeedback: feedback,
		proposal: null,
		goalId: null,
		createdAt: timestamp,
	});
	appendGoalDraft(pi, revised);
	kickoffGoalDraft(pi, revised.draftId);
}

function cancelGoalDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	options: PiXkGoalExtensionOptions,
): void {
	const draft = findCurrentGoalDraft(ctx);
	if (!draft || draft.state === "confirmed" || draft.state === "cancelled") {
		throw new Error("no cancellable Goal draft is pending");
	}
	if (draft.state === "confirming") {
		throw new Error("Goal draft confirmation is already in progress");
	}
	appendGoalDraft(
		pi,
		createPiXkGoalDraft({
			draftId: draft.draftId,
			state: "cancelled",
			objective: draft.objective,
			revisionFeedback: draft.revisionFeedback,
			proposal: draft.proposal,
			goalId: null,
			createdAt: goalNow(options),
		}),
	);
	if (!ctx.isIdle()) ctx.abort();
}

async function confirmGoalDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	if (!ctx.isIdle()) throw new Error("the agent is still busy");
	const current = findCurrentGoalDraft(ctx);
	if (!current) throw new Error("no Goal draft is pending confirmation");
	if (current.state === "confirmed") return;
	let confirming: PiXkGoalDraft;
	if (current.state === "proposed" && current.proposal !== null) {
		confirming = createPiXkGoalDraft({
			draftId: current.draftId,
			state: "confirming",
			objective: current.objective,
			revisionFeedback: null,
			proposal: current.proposal,
			goalId: newGoalId(options),
			createdAt: goalNow(options),
		});
		appendGoalDraft(pi, confirming);
	} else if (current.state === "confirming" && current.proposal !== null && current.goalId !== null) {
		confirming = current;
	} else {
		throw new Error("a proposed Goal draft is required before confirmation");
	}

	const goalId = confirming.goalId;
	const proposal = confirming.proposal;
	if (goalId === null || proposal === null) throw new Error("Goal draft confirmation state is invalid");
	const contract = createGoalContract(goalId, proposal, ctx.sessionManager.getSessionId(), confirming.createdAt);
	const store = storeFor(ctx.cwd);
	await store.createGoal(contract, {
		eventId: `evt_goal_created_${goalId}`,
		idempotencyKey: `goal-created:${goalId}`,
		actor: "user",
		timestamp: confirming.createdAt,
	});
	await appendGoalLifecycle(
		store,
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: ctx.sessionManager.getSessionId() } },
		lifecycleWrite(goalId, "activated", "user", confirming.createdAt, confirming.draftId),
	);
	const previous = findCurrentGoalBinding(ctx);
	if (!previous || previous.goalId !== goalId) {
		const binding = createPiXkGoalBinding(goalId, previous ? previous.generation + 1 : 0);
		pi.appendEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, binding);
	}
	appendGoalDraft(
		pi,
		createPiXkGoalDraft({
			draftId: confirming.draftId,
			state: "confirmed",
			objective: confirming.objective,
			revisionFeedback: null,
			proposal: confirming.proposal,
			goalId,
			createdAt: goalNow(options),
		}),
	);
	kickoffGoal(pi, goalId);
}

function showGoalDraftReview(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const draft = findCurrentGoalDraft(ctx);
	if (!draft || draft.state !== "proposed" || draft.proposal === null) {
		throw new Error("no proposed Goal draft is available for review");
	}
	pi.sendMessage(
		{
			customType: PI_XK_GOAL_DRAFT_REVIEW_CUSTOM_TYPE,
			content: renderGoalDraftMarkdown(draft),
			display: true,
			details: { draftId: draft.draftId },
		},
		{ triggerTurn: false },
	);
}

async function reviewGoalDraftWithUi(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const draft = findCurrentGoalDraft(ctx);
	if (ctx.mode !== "tui" || !ctx.hasUI || !draft || draft.state !== "proposed" || draft.proposal === null) return;
	const choice = await ctx.ui.custom<GoalDraftReviewAction>(
		(tui, theme, keybindings, done) =>
			createGoalDraftReviewComponent({
				markdown: renderGoalDraftMarkdown(draft),
				tui,
				theme,
				keybindings,
				done,
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: { left: 0, right: 0, bottom: 0 },
			},
		},
	);
	if (choice === "confirm") {
		await confirmGoalDraft(pi, ctx, storeFor, options);
		return;
	}
	if (choice !== "revise") return;
	const feedback = await ctx.ui.editor("修改 Goal 草案", "");
	if (!feedback?.trim()) return;
	reviseGoalDraft(pi, ctx, options, feedback);
}

async function startCurrentGoal(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	if (!ctx.isIdle()) throw new Error("the agent is still busy");
	await requestGoalLifecycleAction(pi, ctx, storeFor, options, "start", "user", "started by user", {
		resumeEvidence: "The user explicitly requested Goal recovery.",
	});
}

interface GoalFilePaths {
	status: "active" | "paused";
	objectivePath: string;
	statePath: string;
}

async function getCurrentGoalFilePaths(
	ctx: ExtensionContext,
	storeFor: (projectRoot: string) => GoalStore,
): Promise<GoalFilePaths | undefined> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) return undefined;
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId);
	if (replay.lifecycle.status !== "active" && replay.lifecycle.status !== "paused") return undefined;
	const files = await store.inspectGoalFiles(binding.goalId);
	if (files.objective.status !== "valid" || files.state.status !== "valid") {
		throw new Error(`Goal files require repair: objective ${files.objective.status}, state ${files.state.status}`);
	}
	return { status: replay.lifecycle.status, objectivePath: files.objective.path, statePath: files.state.path };
}

function findCurrentKickoffMessageIndex(
	messages: readonly { role: string; customType?: string }[],
	kickoffCustomType: string,
): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user") return -1;
		if (message.role === "custom") {
			return message.customType === kickoffCustomType ? index : -1;
		}
	}
	return -1;
}

async function showGoalStatus(
	ctx: ExtensionCommandContext,
	storeFor: (projectRoot: string) => GoalStore,
	options: PiXkGoalExtensionOptions,
): Promise<void> {
	const binding = findCurrentGoalBinding(ctx);
	if (!binding) {
		ctx.ui.notify("Pi-XK Goal: no Goal is bound to the current session branch", "info");
		return;
	}
	const store = storeFor(ctx.cwd);
	const replay = await store.replayGoal(binding.goalId, { now: goalNow(options) });
	const files = await store.inspectGoalFiles(binding.goalId);
	ctx.ui.notify(
		`Pi-XK Goal ${binding.goalId}: ${replay.lifecycle.status}; wall ${formatDuration(replay.lifecycle.wallElapsed)}, active ${formatDuration(replay.lifecycle.activeElapsed)}, busy ${formatDuration(replay.lifecycle.busyElapsed)}; objective ${files.objective.status}, state ${files.state.status}`,
		"info",
	);
}

export function createPiXkGoalExtension(options: PiXkGoalExtensionOptions = {}): ExtensionFactory {
	const storeFor = createGoalStoreResolver(options);
	return (pi) => {
		let consecutiveGoalFailures = 0;
		let lastGoalRunOutcome: GoalRunOutcome = "aborted";
		let currentRunKind: "draft" | "goal" | "other" = "other";
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let goalStatusTimer: ReturnType<typeof setInterval> | undefined;
		let goalStatusContext: ExtensionContext | undefined;
		let goalStatusSnapshot: GoalStatusSnapshot | undefined;

		const clearRetryTimer = () => {
			if (retryTimer === undefined) return;
			clearTimeout(retryTimer);
			retryTimer = undefined;
		};

		const clearGoalStatusTimer = () => {
			if (goalStatusTimer === undefined) return;
			clearInterval(goalStatusTimer);
			goalStatusTimer = undefined;
		};

		const renderGoalStatus = () => {
			if (!goalStatusContext?.hasUI) return;
			goalStatusContext.ui.setStatus(
				PI_XK_GOAL_STATUS_KEY,
				goalStatusSnapshot
					? formatGoalFooterStatus(goalStatusSnapshot, (options.now?.() ?? new Date()).getTime())
					: undefined,
			);
		};

		const synchronizeGoalStatusTimer = () => {
			if (goalStatusSnapshot?.status === "active" && goalStatusContext?.hasUI) {
				if (goalStatusTimer !== undefined) return;
				goalStatusTimer = setInterval(renderGoalStatus, 1_000);
				goalStatusTimer.unref?.();
				return;
			}
			clearGoalStatusTimer();
		};

		const refreshGoalStatus = async (ctx: ExtensionContext): Promise<void> => {
			goalStatusContext = ctx;
			const binding = findCurrentGoalBinding(ctx);
			if (!binding) {
				goalStatusSnapshot = undefined;
				renderGoalStatus();
				synchronizeGoalStatusTimer();
				return;
			}
			const observedAt = (options.now?.() ?? new Date()).getTime();
			const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId, {
				now: new Date(observedAt).toISOString(),
			});
			goalStatusSnapshot = {
				status: replay.lifecycle.status,
				activeElapsed: replay.lifecycle.activeElapsed,
				observedAt,
			};
			renderGoalStatus();
			synchronizeGoalStatusTimer();
		};

		const retryDelay = (failureCount: number): number => {
			const configured = options.retryDelayMs?.(failureCount);
			if (configured !== undefined) return Math.max(0, configured);
			return Math.min(1_000 * 2 ** Math.min(failureCount - 1, 6), 60_000);
		};

		const scheduleRetry = (ctx: ExtensionContext, delayMs: number) => {
			clearRetryTimer();
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				void continueActiveGoal(pi, ctx, storeFor).catch((error) => notifyGoalError(ctx, options, error));
			}, delayMs);
		};

		const checkpointOptions: PiXkExtensionOptions = {
			synchronizeOnSessionStart: false,
			synchronizeOnSessionShutdown: false,
			resolveBindings: (ctx) => {
				const binding = findCurrentGoalBinding(ctx);
				return binding ? [binding] : [];
			},
			resolveGoalStore: (ctx) => storeFor(ctx.cwd),
			shouldPersistBinding: async (binding, ctx) => {
				if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return false;
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
		};
		createPiXkExtension(checkpointOptions)(pi);

		const processPendingGoalLifecycleIntent = async (ctx: ExtensionContext): Promise<boolean> => {
			const binding = findCurrentGoalBinding(ctx);
			if (!binding) return false;
			const intent = findPendingGoalLifecycleIntent(ctx, binding);
			if (!intent) return false;
			const replay = await storeFor(ctx.cwd).replayGoal(binding.goalId);
			const stateError = lifecycleIntentStateError(intent, replay.lifecycle.status);
			if (stateError) {
				appendRejectedGoalLifecycleIntent(pi, intent, goalNow(options));
				notifyGoalError(ctx, options, new Error(stateError));
				return true;
			}
			if (!(await isLifecycleIntentCheckpointReady(pi, ctx, storeFor, checkpointOptions, options, intent))) {
				return true;
			}
			await settleGoalLifecycleIntent(pi, ctx, storeFor, options);
			return true;
		};

		pi.registerTool({
			name: "pi_xk_submit_goal_draft",
			label: "Submit Goal Draft",
			description:
				"Submit a proposed Pi-XK Goal contract for user review. Use only during a Goal draft kickoff; this does not create or start a Goal.",
			executionMode: "sequential",
			parameters: Type.Object({
				title: Type.String({ description: "Concise Goal title" }),
				objective: Type.String({ description: "Stable, observable Goal objective" }),
				constraints: Type.Array(Type.String()),
				acceptance: Type.Array(
					Type.Union([
						Type.Object({
							id: Type.String(),
							kind: Type.Literal("command"),
							description: Type.String(),
							required: Type.Boolean(),
							command: Type.String(),
						}),
						Type.Object({
							id: Type.String(),
							kind: Type.Literal("test"),
							description: Type.String(),
							required: Type.Boolean(),
							command: Type.String(),
						}),
						Type.Object({
							id: Type.String(),
							kind: Type.Literal("artifact"),
							description: Type.String(),
							required: Type.Boolean(),
						}),
						Type.Object({
							id: Type.String(),
							kind: Type.Literal("approval"),
							description: Type.String(),
							required: Type.Boolean(),
						}),
					]),
				),
				nonGoals: Type.Array(Type.String()),
				doneCondition: Type.String(),
				pauseCondition: Type.String(),
				finalReport: Type.String(),
				executionAuthorization: Type.String(),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					submitGoalDraft(pi, ctx, options, params);
					return {
						content: [{ type: "text", text: "Goal draft submitted for user review." }],
						details: {},
						terminate: true,
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Goal draft submission failed: ${normalizeError(error).message}` }],
						details: {},
					};
				}
			},
		});

		pi.on("tool_call", (event, ctx) => {
			if (currentRunKind === "draft") {
				if (event.toolName === "pi_xk_submit_goal_draft") return;
				return {
					block: true,
					reason: "A Goal draft kickoff only permits pi_xk_submit_goal_draft.",
				};
			}
			if (event.toolName === "pi_xk_submit_goal_draft") {
				return {
					block: true,
					reason: "pi_xk_submit_goal_draft is only available during a Goal draft kickoff.",
				};
			}
			if (
				isOutstandingGoalDraft(findCurrentGoalDraft(ctx)) &&
				(event.toolName === "pi_xk_start_goal" ||
					event.toolName === "pi_xk_pause_goal" ||
					event.toolName === "pi_xk_end_goal")
			) {
				return {
					block: true,
					reason: "Pi-XK Goal lifecycle tools are unavailable while a Goal draft is awaiting review.",
				};
			}
		});

		pi.registerTool({
			name: "pi_xk_start_goal",
			label: "Start Goal",
			description:
				"Resume a paused Pi-XK Goal only when new user input, an external change, or new evidence removes its recorded blocker. Do not perform Goal work before calling this tool.",
			executionMode: "sequential",
			parameters: Type.Object({
				reason: Type.String({ description: "Why the recorded blocker is now removed" }),
				resumeEvidence: Type.String({
					description: "New input, external change, or evidence that justifies resuming",
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					await requestGoalLifecycleAction(pi, ctx, storeFor, options, "start", "model", params.reason, {
						resumeEvidence: params.resumeEvidence,
					});
					return { content: [{ type: "text", text: "Goal start requested." }], details: {}, terminate: true };
				} catch (error) {
					return {
						content: [{ type: "text", text: `Goal start failed: ${normalizeError(error).message}` }],
						details: {},
					};
				}
			},
		});
		pi.registerTool({
			name: "pi_xk_pause_goal",
			label: "Pause Goal",
			description:
				"Pause an active Pi-XK Goal only after auditing incomplete required acceptance criteria in goal-state.md. The audit must name unmet IDs, current evidence, and the incomplete conclusion.",
			executionMode: "sequential",
			parameters: Type.Object({
				reason: Type.String({ description: "Why this Goal must pause" }),
				userRequest: Type.Union([Type.String(), Type.Null()], {
					description: "The user response needed next, or null when waiting only on an external change",
				}),
				nextBestAction: Type.String({ description: "The next action after the blocker is removed" }),
				audit: Type.Object({
					unmetRequiredAcceptanceIds: Type.Array(Type.String()),
					currentEvidence: Type.String(),
					incompleteConclusion: Type.String(),
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					await requestGoalLifecycleAction(pi, ctx, storeFor, options, "pause", "model", params.reason, {
						userRequest: params.userRequest === "" ? null : params.userRequest,
						nextBestAction: params.nextBestAction,
						audit: params.audit,
					});
					return { content: [{ type: "text", text: "Goal pause requested." }], details: {}, terminate: true };
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
			description:
				"End an active Pi-XK Goal only after every required acceptance has verification evidence and goal-state.md records the final summary. A normal response does not end the Goal.",
			executionMode: "sequential",
			parameters: Type.Object({
				outcome: Type.String({ description: "The final Goal outcome" }),
				reason: Type.String({ description: "Why this Goal is ending" }),
				verifiedAcceptanceIds: Type.Array(Type.String(), {
					description: "Acceptance IDs with verified evidence; every required ID must be present",
				}),
				finalEvidence: Type.String({ description: "Final verification evidence recorded in goal-state.md" }),
				finalSummary: Type.String({ description: "Concise final summary recorded in goal-state.md" }),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				try {
					await requestGoalLifecycleAction(pi, ctx, storeFor, options, "end", "model", params.reason, {
						outcome: params.outcome,
						verifiedAcceptanceIds: params.verifiedAcceptanceIds,
						finalEvidence: params.finalEvidence,
						finalSummary: params.finalSummary,
					});
					return { content: [{ type: "text", text: "Goal end requested." }], details: {}, terminate: true };
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
				await synchronizeCheckpointState(pi, ctx, checkpointOptions);
				await recoverOpenGoalRun(ctx, storeFor, options);
				await processPendingGoalLifecycleIntent(ctx);
				await refreshGoalStatus(ctx);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("before_agent_start", async (event, ctx) => {
			if (event.systemPrompt.includes("<pi-xk-goal>") || event.systemPrompt.includes("<pi-xk-goal-recovery>")) {
				return;
			}
			try {
				if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) return;
				const files = await getCurrentGoalFilePaths(ctx, storeFor);
				if (!files) return;
				const prompt =
					files.status === "active"
						? `<pi-xk-goal>\n${goalRuntimePrompt(files.objectivePath, files.statePath)}\n</pi-xk-goal>`
						: `<pi-xk-goal-recovery>\n${pausedGoalRecoveryPrompt(files.objectivePath, files.statePath)}\n</pi-xk-goal-recovery>`;
				return {
					systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
				};
			} catch (error) {
				notifyGoalError(ctx, options, error);
				return;
			}
		});
		pi.on("context", async (event, ctx) => {
			const draftKickoffIndex = findCurrentKickoffMessageIndex(event.messages, PI_XK_GOAL_DRAFT_KICKOFF_CUSTOM_TYPE);
			const goalKickoffIndex = findCurrentKickoffMessageIndex(event.messages, PI_XK_GOAL_KICKOFF_CUSTOM_TYPE);
			let draftKickoffPrompt: string | undefined;
			let goalKickoffPrompt: string | undefined;
			try {
				if (draftKickoffIndex >= 0) {
					const draft = findCurrentGoalDraft(ctx);
					if (draft?.state === "requested") draftKickoffPrompt = goalDraftRuntimePrompt(draft);
				} else if (goalKickoffIndex >= 0 && !isOutstandingGoalDraft(findCurrentGoalDraft(ctx))) {
					const files = await getCurrentGoalFilePaths(ctx, storeFor);
					if (files?.status === "active") {
						goalKickoffPrompt = goalRuntimePrompt(files.objectivePath, files.statePath);
					}
				}
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
			currentRunKind = draftKickoffIndex >= 0 ? "draft" : goalKickoffIndex >= 0 ? "goal" : "other";
			const messages = event.messages.map((message, index) => {
				if (message.role !== "custom") return message;
				if (message.customType === PI_XK_GOAL_DRAFT_REVIEW_CUSTOM_TYPE) {
					return { ...message, content: "" };
				}
				if (message.customType === PI_XK_GOAL_DRAFT_KICKOFF_CUSTOM_TYPE) {
					return {
						...message,
						content: index === draftKickoffIndex && draftKickoffPrompt ? draftKickoffPrompt : "",
					};
				}
				if (message.customType === PI_XK_GOAL_KICKOFF_CUSTOM_TYPE) {
					return {
						...message,
						content: index === goalKickoffIndex && goalKickoffPrompt ? goalKickoffPrompt : "",
					};
				}
				return message;
			});
			if (messages.some((message, index) => message !== event.messages[index])) return { messages };
		});
		pi.on("agent_start", async (_event, ctx) => {
			try {
				lastGoalRunOutcome = "aborted";
				await startGoalRun(ctx, storeFor, options);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("agent_end", (event, ctx) => {
			if (isOutstandingGoalDraft(findCurrentGoalDraft(ctx)) || !findCurrentGoalBinding(ctx)) return;
			lastGoalRunOutcome = goalRunOutcome(event);
		});
		pi.on("agent_settled", async (_event, ctx) => {
			try {
				const settledRunKind = currentRunKind;
				currentRunKind = "other";
				const draft = findCurrentGoalDraft(ctx);
				if (isOutstandingGoalDraft(draft)) {
					if (settledRunKind === "draft" && draft?.state === "proposed") {
						await reviewGoalDraftWithUi(pi, ctx, storeFor, options);
					}
					await refreshGoalStatus(ctx);
					return;
				}
				if (await processPendingGoalLifecycleIntent(ctx)) {
					await refreshGoalStatus(ctx);
					return;
				}
				await settleGoalRun(ctx, storeFor, options);
				if (lastGoalRunOutcome === "aborted") {
					await refreshGoalStatus(ctx);
					return;
				}
				if (lastGoalRunOutcome === "error") {
					consecutiveGoalFailures += 1;
					scheduleRetry(ctx, retryDelay(consecutiveGoalFailures));
					await refreshGoalStatus(ctx);
					return;
				}
				consecutiveGoalFailures = 0;
				await continueActiveGoal(pi, ctx, storeFor);
				await refreshGoalStatus(ctx);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			}
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			clearRetryTimer();
			clearGoalStatusTimer();
			try {
				await synchronizeCheckpointState(pi, ctx, checkpointOptions);
				await processPendingGoalLifecycleIntent(ctx);
			} catch (error) {
				notifyGoalError(ctx, options, error);
			} finally {
				goalStatusSnapshot = undefined;
				renderGoalStatus();
				goalStatusContext = undefined;
			}
		});
		pi.on("input", async (event, ctx) => {
			const capture = findCurrentGoalCapture(ctx);
			if (!capture || capture.state !== "open") return { action: "continue" };
			try {
				await requestGoalDraft(pi, ctx, storeFor, options, event.text, capture.captureId);
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
							await assertGoalDraftAllowed(ctx, storeFor);
							pi.appendEntry(
								PI_XK_SESSION_LINK_CUSTOM_TYPE,
								createPiXkGoalCapture(`capture_${randomUUID().replaceAll("-", "")}`, "open", timestamp),
							);
							ctx.ui.notify("Pi-XK Goal objective capture is ready", "info");
						}
						return;
					}
					if (trimmed === "status") {
						await showGoalStatus(ctx, storeFor, options);
						return;
					}
					if (trimmed === "review") {
						showGoalDraftReview(pi, ctx);
						return;
					}
					if (trimmed === "confirm") {
						await confirmGoalDraft(pi, ctx, storeFor, options);
						return;
					}
					if (trimmed === "cancel") {
						cancelGoalDraft(pi, ctx, options);
						return;
					}
					if (trimmed === "revise" || trimmed.startsWith("revise ")) {
						reviseGoalDraft(pi, ctx, options, trimmed.slice("revise".length));
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
					await requestGoalDraft(pi, ctx, storeFor, options, objective);
				} catch (error) {
					notifyGoalError(ctx, options, error);
				} finally {
					try {
						await refreshGoalStatus(ctx);
					} catch (error) {
						notifyGoalError(ctx, options, error);
					}
				}
			},
		});
	};
}
