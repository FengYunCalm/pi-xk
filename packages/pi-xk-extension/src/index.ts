import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { GoalCheckpoint, GoalStore } from "pi-xk-core";
import {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	isPiXkCheckpointRef,
	isPiXkSessionLink,
	type PiXkSessionLink,
} from "./session-link.ts";

export {
	assertPiXkSessionLink,
	createPiXkCheckpointRef,
	createPiXkGoalBinding,
	isPiXkCheckpointRef,
	isPiXkSessionLink,
	PI_XK_CHECKPOINT_REF_KIND,
	PI_XK_SESSION_LINK_KIND,
	PI_XK_SESSION_LINK_SCHEMA,
	type PiXkCheckpointRef,
	type PiXkSessionLink,
} from "./session-link.ts";

export const PI_XK_SESSION_LINK_CUSTOM_TYPE = "pi-xk.session-link";

export type PiXkLifecycleEvent =
	| Pick<AgentSettledEvent, "type">
	| Pick<TurnEndEvent, "type" | "turnIndex">
	| Pick<SessionBeforeCompactEvent, "type" | "reason" | "willRetry">
	| Pick<SessionCompactEvent, "type" | "reason" | "willRetry" | "fromExtension">;

export interface PiXkExtensionOptions {
	/** SDK and test-only injection point; goal files are intentionally not read by the extension. */
	bindings?: readonly PiXkSessionLink[];
	/** Optional Goal event store used to persist turn checkpoints for injected bindings. */
	goalStore?: GoalStore;
	/** Receives checkpoint persistence errors without interrupting Pi's session lifecycle. */
	onCheckpointError?: (error: Error) => void;
	/** Internal lifecycle observer; this extension does not persist checkpoints unless goalStore is injected. */
	onLifecycle?: (event: PiXkLifecycleEvent) => void;
}

function isSameBinding(left: PiXkSessionLink, right: PiXkSessionLink): boolean {
	return (
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.goalId === right.goalId &&
		left.generation === right.generation
	);
}

function reportCheckpointError(options: PiXkExtensionOptions, error: unknown): void {
	const normalizedError = error instanceof Error ? error : new Error(String(error));
	try {
		options.onCheckpointError?.(normalizedError);
	} catch {
		// Checkpoint diagnostics must not interrupt the Pi lifecycle.
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

function appendCheckpointRef(pi: ExtensionAPI, ctx: ExtensionContext, binding: PiXkSessionLink, eventId: string): void {
	if (!hasCheckpointRef(ctx, binding, eventId)) {
		pi.appendEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkCheckpointRef(binding.goalId, eventId, binding.generation),
		);
	}
}

async function synchronizeCheckpointRefs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	bindings: readonly PiXkSessionLink[],
	options: PiXkExtensionOptions,
): Promise<void> {
	if (!options.goalStore) return;
	const sessionId = ctx.sessionManager.getSessionId();
	for (const binding of bindings) {
		try {
			const replay = await options.goalStore.replayGoal(binding.goalId);
			if (replay.tailDiagnostic) {
				throw new Error(`Goal recovery is required before checkpoint refs can be synchronized: ${binding.goalId}`);
			}
			for (const event of replay.events) {
				if (event.eventType !== "goal_checkpointed" || event.payload.checkpoint.sessionId !== sessionId) continue;
				appendCheckpointRef(pi, ctx, binding, event.eventId);
			}
		} catch (error) {
			reportCheckpointError(options, error);
		}
	}
}

async function persistTurnCheckpoint(
	pi: ExtensionAPI,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	binding: PiXkSessionLink,
	options: PiXkExtensionOptions,
): Promise<void> {
	if (!options.goalStore) return;
	const sessionId = ctx.sessionManager.getSessionId();
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) return;
	const checkpoint: GoalCheckpoint = {
		schema: "pi-xk.goal-checkpoint.v1",
		sessionId,
		leafId,
		turnIndex: event.turnIndex,
		toolResultCount: event.toolResults.length,
		reason: "turn_end",
		createdAt: checkpointTimestamp(event),
	};
	const eventId = `evt_checkpoint_${binding.goalId}_${sessionId}_${leafId}`;
	const idempotencyKey = `checkpoint:${binding.goalId}:${sessionId}:${leafId}:turn_end`;

	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const replay = await options.goalStore.loadGoal(binding.goalId);
			try {
				const result = await options.goalStore.appendCheckpoint(binding.goalId, checkpoint, {
					eventId,
					idempotencyKey,
					expectedHead: replay.head,
				});
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

export function createPiXkExtension(options: PiXkExtensionOptions = {}): ExtensionFactory {
	const bindings = options.bindings ?? [];
	for (const binding of bindings) {
		assertPiXkSessionLink(binding);
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
			await synchronizeCheckpointRefs(pi, ctx, bindings, options);
		});
		pi.on("turn_end", async (event, ctx) => {
			for (const binding of bindings) {
				await persistTurnCheckpoint(pi, event, ctx, binding, options);
			}
			options.onLifecycle?.({ type: event.type, turnIndex: event.turnIndex });
		});
		pi.on("session_before_compact", (event) => {
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
		pi.on("agent_settled", async (event, ctx) => {
			await synchronizeCheckpointRefs(pi, ctx, bindings, options);
			options.onLifecycle?.({ type: event.type });
		});
	};
}
