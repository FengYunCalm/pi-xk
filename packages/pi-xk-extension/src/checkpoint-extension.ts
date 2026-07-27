import type {
	AgentEndEvent,
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { GoalCheckpointV2, GoalStore } from "pi-xk-core";
import {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	createPiXkCompactionCheckpointIntent,
	createPiXkTurnCheckpointIntent,
	isPiXkCheckpointIntent,
	isPiXkCheckpointRef,
	isPiXkSessionLink,
	type PiXkCheckpointIntent,
	type PiXkSessionLink,
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

export function isSameBinding(left: PiXkSessionLink, right: PiXkSessionLink): boolean {
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

export function checkpointEventId(intent: PiXkCheckpointIntent): string {
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

export async function synchronizeCheckpointState(
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
