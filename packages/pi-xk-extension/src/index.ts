import type {
	AgentSettledEvent,
	ExtensionFactory,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { assertPiXkSessionLink, isPiXkSessionLink, type PiXkSessionLink } from "./session-link.ts";

export {
	assertPiXkSessionLink,
	createPiXkGoalBinding,
	isPiXkSessionLink,
	PI_XK_SESSION_LINK_KIND,
	PI_XK_SESSION_LINK_SCHEMA,
	type PiXkSessionLink,
} from "./session-link.ts";

export const PI_XK_SESSION_LINK_CUSTOM_TYPE = "pi-xk.session-link";

export type PiXkLifecycleEvent =
	| Pick<AgentSettledEvent, "type">
	| Pick<TurnEndEvent, "type" | "turnIndex">
	| Pick<SessionBeforeCompactEvent, "type" | "reason" | "willRetry">
	| Pick<SessionCompactEvent, "type" | "reason" | "willRetry" | "fromExtension">;

export interface PiXkExtensionOptions {
	/** SDK and test-only injection point; goal files are intentionally not read in Phase 0. */
	bindings?: readonly PiXkSessionLink[];
	/** Internal lifecycle observer; this extension does not persist checkpoints in Phase 0. */
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

export function createPiXkExtension(options: PiXkExtensionOptions = {}): ExtensionFactory {
	const bindings = options.bindings ?? [];
	for (const binding of bindings) {
		assertPiXkSessionLink(binding);
	}

	return (pi) => {
		pi.on("session_start", (_event, ctx) => {
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
		});
		pi.on("turn_end", (event) => {
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
		pi.on("agent_settled", (event) => {
			options.onLifecycle?.({ type: event.type });
		});
	};
}
