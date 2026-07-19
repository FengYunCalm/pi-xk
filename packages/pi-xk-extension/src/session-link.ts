export const PI_XK_SESSION_LINK_SCHEMA = "pi-xk.session-link.v1";

export const PI_XK_SESSION_LINK_KIND = "goal_binding";

export const PI_XK_CHECKPOINT_REF_KIND = "checkpoint_ref";

export interface PiXkSessionLink {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_SESSION_LINK_KIND;
	goalId: string;
	generation: number;
}

export interface PiXkCheckpointRef {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_REF_KIND;
	goalId: string;
	eventId: string;
	generation: number;
}

function isNonEmptyGoalId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isPiXkSessionLink(value: unknown): value is PiXkSessionLink {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return (
		candidate.schema === PI_XK_SESSION_LINK_SCHEMA &&
		candidate.kind === PI_XK_SESSION_LINK_KIND &&
		isNonEmptyGoalId(candidate.goalId) &&
		isGeneration(candidate.generation)
	);
}

export function isPiXkCheckpointRef(value: unknown): value is PiXkCheckpointRef {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return (
		candidate.schema === PI_XK_SESSION_LINK_SCHEMA &&
		candidate.kind === PI_XK_CHECKPOINT_REF_KIND &&
		isNonEmptyGoalId(candidate.goalId) &&
		typeof candidate.eventId === "string" &&
		candidate.eventId.trim().length > 0 &&
		isGeneration(candidate.generation)
	);
}

export function createPiXkGoalBinding(goalId: string, generation: number): PiXkSessionLink {
	if (!isNonEmptyGoalId(goalId)) {
		throw new Error("Pi-XK session link goalId must be a non-empty string");
	}
	if (!isGeneration(generation)) {
		throw new Error("Pi-XK session link generation must be a non-negative integer");
	}

	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_SESSION_LINK_KIND,
		goalId: goalId.trim(),
		generation,
	};
}

export function createPiXkCheckpointRef(goalId: string, eventId: string, generation: number): PiXkCheckpointRef {
	if (!isNonEmptyGoalId(goalId)) {
		throw new Error("Pi-XK checkpoint ref goalId must be a non-empty string");
	}
	if (typeof eventId !== "string" || eventId.trim().length === 0) {
		throw new Error("Pi-XK checkpoint ref eventId must be a non-empty string");
	}
	if (!isGeneration(generation)) {
		throw new Error("Pi-XK checkpoint ref generation must be a non-negative integer");
	}

	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_REF_KIND,
		goalId: goalId.trim(),
		eventId: eventId.trim(),
		generation,
	};
}

export function assertPiXkSessionLink(value: unknown): asserts value is PiXkSessionLink {
	if (!isPiXkSessionLink(value)) {
		throw new Error("Pi-XK session link must use the pi-xk.session-link.v1 goal_binding schema");
	}
}
