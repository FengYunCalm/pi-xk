export const PI_XK_SESSION_LINK_SCHEMA = "pi-xk.session-link.v1";

export const PI_XK_SESSION_LINK_KIND = "goal_binding";

export const PI_XK_CHECKPOINT_REF_KIND = "checkpoint_ref";

export const PI_XK_CHECKPOINT_INTENT_KIND = "checkpoint_intent";

export const PI_XK_GOAL_CAPTURE_KIND = "goal_capture";

export const PI_XK_GOAL_LIFECYCLE_INTENT_KIND = "goal_lifecycle_intent";

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

export interface PiXkTurnCheckpointIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_INTENT_KIND;
	goalId: string;
	sessionId: string;
	leafId: string;
	turnIndex: number;
	toolResultCount: number;
	reason: "turn_end";
	createdAt: string;
	generation: number;
}

export interface PiXkCompactionCheckpointIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_INTENT_KIND;
	goalId: string;
	sessionId: string;
	leafId: string;
	reason: "session_before_compact";
	createdAt: string;
	generation: number;
}

export type PiXkCheckpointIntent = PiXkTurnCheckpointIntent | PiXkCompactionCheckpointIntent;

export type PiXkGoalCaptureState = "open" | "cancelled" | "consumed";

export interface PiXkGoalCapture {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_CAPTURE_KIND;
	captureId: string;
	state: PiXkGoalCaptureState;
	createdAt: string;
}

export type PiXkGoalLifecycleIntentAction = "pause" | "end";

export type PiXkGoalLifecycleIntentState = "requested" | "committed";

export interface PiXkGoalLifecycleIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_LIFECYCLE_INTENT_KIND;
	intentId: string;
	goalId: string;
	generation: number;
	actor: "user" | "model";
	action: PiXkGoalLifecycleIntentAction;
	state: PiXkGoalLifecycleIntentState;
	runId: string;
	reason: string;
	nextBestAction: string;
	outcome: string;
	finalEvidence: string;
	createdAt: string;
}

const GOAL_ID_PATTERN = /^goal_[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isGoalId(value: unknown): value is string {
	if (!isNonEmptyString(value)) return false;
	return GOAL_ID_PATTERN.test(value);
}

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
	return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function assertGoalIdValue(value: string): string {
	if (!isGoalId(value)) {
		throw new Error("Pi-XK session link goalId must use the goal_<safe-id> format");
	}
	return value;
}

function assertNonEmptyString(value: string, field: string): string {
	if (!isNonEmptyString(value)) {
		throw new Error(`Pi-XK checkpoint ${field} must be a non-empty string`);
	}
	return value;
}

function assertString(value: string, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`Pi-XK lifecycle intent ${field} must be a string`);
	}
	return value;
}

function assertTimestamp(value: string): string {
	if (!isTimestamp(value)) {
		throw new Error("Pi-XK checkpoint createdAt must be an ISO timestamp");
	}
	return value;
}

function assertGeneration(value: number): number {
	if (!isGeneration(value)) {
		throw new Error("Pi-XK session link generation must be a non-negative integer");
	}
	return value;
}

function assertNonNegativeInteger(value: number, field: string): number {
	if (!isGeneration(value)) {
		throw new Error(`Pi-XK checkpoint ${field} must be a non-negative integer`);
	}
	return value;
}

export function isPiXkSessionLink(value: unknown): value is PiXkSessionLink {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "kind", "goalId", "generation"])) {
		return false;
	}
	return (
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_SESSION_LINK_KIND &&
		isGoalId(value.goalId) &&
		isGeneration(value.generation)
	);
}

export function isPiXkCheckpointRef(value: unknown): value is PiXkCheckpointRef {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "kind", "goalId", "eventId", "generation"])) {
		return false;
	}
	return (
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_CHECKPOINT_REF_KIND &&
		isGoalId(value.goalId) &&
		isNonEmptyString(value.eventId) &&
		isGeneration(value.generation)
	);
}

export function isPiXkCheckpointIntent(value: unknown): value is PiXkCheckpointIntent {
	if (!isRecord(value)) return false;
	if (
		value.schema !== PI_XK_SESSION_LINK_SCHEMA ||
		value.kind !== PI_XK_CHECKPOINT_INTENT_KIND ||
		!isGoalId(value.goalId) ||
		!isNonEmptyString(value.sessionId) ||
		!isNonEmptyString(value.leafId) ||
		!isTimestamp(value.createdAt) ||
		!isGeneration(value.generation)
	) {
		return false;
	}
	if (value.reason === "turn_end") {
		return (
			hasExactKeys(value, [
				"schema",
				"kind",
				"goalId",
				"sessionId",
				"leafId",
				"turnIndex",
				"toolResultCount",
				"reason",
				"createdAt",
				"generation",
			]) &&
			isGeneration(value.turnIndex) &&
			isGeneration(value.toolResultCount)
		);
	}
	return (
		value.reason === "session_before_compact" &&
		hasExactKeys(value, ["schema", "kind", "goalId", "sessionId", "leafId", "reason", "createdAt", "generation"])
	);
}

export function isPiXkGoalCapture(value: unknown): value is PiXkGoalCapture {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schema", "kind", "captureId", "state", "createdAt"]) &&
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_GOAL_CAPTURE_KIND &&
		isNonEmptyString(value.captureId) &&
		(value.state === "open" || value.state === "cancelled" || value.state === "consumed") &&
		isTimestamp(value.createdAt)
	);
}

export function isPiXkGoalLifecycleIntent(value: unknown): value is PiXkGoalLifecycleIntent {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"schema",
			"kind",
			"intentId",
			"goalId",
			"generation",
			"actor",
			"action",
			"state",
			"runId",
			"reason",
			"nextBestAction",
			"outcome",
			"finalEvidence",
			"createdAt",
		]) &&
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_GOAL_LIFECYCLE_INTENT_KIND &&
		isNonEmptyString(value.intentId) &&
		isGoalId(value.goalId) &&
		isGeneration(value.generation) &&
		(value.actor === "user" || value.actor === "model") &&
		(value.action === "pause" || value.action === "end") &&
		(value.state === "requested" || value.state === "committed") &&
		typeof value.runId === "string" &&
		typeof value.reason === "string" &&
		typeof value.nextBestAction === "string" &&
		typeof value.outcome === "string" &&
		typeof value.finalEvidence === "string" &&
		isTimestamp(value.createdAt)
	);
}

export function createPiXkGoalBinding(goalId: string, generation: number): PiXkSessionLink {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_SESSION_LINK_KIND,
		goalId: assertGoalIdValue(goalId),
		generation: assertGeneration(generation),
	};
}

export function createPiXkCheckpointRef(goalId: string, eventId: string, generation: number): PiXkCheckpointRef {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_REF_KIND,
		goalId: assertGoalIdValue(goalId),
		eventId: assertNonEmptyString(eventId, "eventId"),
		generation: assertGeneration(generation),
	};
}

export function createPiXkTurnCheckpointIntent(
	goalId: string,
	sessionId: string,
	leafId: string,
	turnIndex: number,
	toolResultCount: number,
	generation: number,
	createdAt: string,
): PiXkTurnCheckpointIntent {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_INTENT_KIND,
		goalId: assertGoalIdValue(goalId),
		sessionId: assertNonEmptyString(sessionId, "sessionId"),
		leafId: assertNonEmptyString(leafId, "leafId"),
		turnIndex: assertNonNegativeInteger(turnIndex, "turnIndex"),
		toolResultCount: assertNonNegativeInteger(toolResultCount, "toolResultCount"),
		reason: "turn_end",
		createdAt: assertTimestamp(createdAt),
		generation: assertGeneration(generation),
	};
}

export function createPiXkCompactionCheckpointIntent(
	goalId: string,
	sessionId: string,
	leafId: string,
	generation: number,
	createdAt: string,
): PiXkCompactionCheckpointIntent {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_INTENT_KIND,
		goalId: assertGoalIdValue(goalId),
		sessionId: assertNonEmptyString(sessionId, "sessionId"),
		leafId: assertNonEmptyString(leafId, "leafId"),
		reason: "session_before_compact",
		createdAt: assertTimestamp(createdAt),
		generation: assertGeneration(generation),
	};
}

export function createPiXkGoalCapture(
	captureId: string,
	state: PiXkGoalCaptureState,
	createdAt: string,
): PiXkGoalCapture {
	if (state !== "open" && state !== "cancelled" && state !== "consumed") {
		throw new Error("Pi-XK Goal capture state is invalid");
	}
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_GOAL_CAPTURE_KIND,
		captureId: assertNonEmptyString(captureId, "captureId"),
		state,
		createdAt: assertTimestamp(createdAt),
	};
}

export function createPiXkGoalLifecycleIntent(
	intent: Omit<PiXkGoalLifecycleIntent, "schema" | "kind">,
): PiXkGoalLifecycleIntent {
	if (intent.action !== "pause" && intent.action !== "end") {
		throw new Error("Pi-XK Goal lifecycle intent action is invalid");
	}
	if (intent.state !== "requested" && intent.state !== "committed") {
		throw new Error("Pi-XK Goal lifecycle intent state is invalid");
	}
	if (intent.actor !== "user" && intent.actor !== "model") {
		throw new Error("Pi-XK Goal lifecycle intent actor is invalid");
	}
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_GOAL_LIFECYCLE_INTENT_KIND,
		intentId: assertNonEmptyString(intent.intentId, "intentId"),
		goalId: assertGoalIdValue(intent.goalId),
		generation: assertGeneration(intent.generation),
		actor: intent.actor,
		action: intent.action,
		state: intent.state,
		runId: assertString(intent.runId, "runId"),
		reason: assertString(intent.reason, "reason"),
		nextBestAction: assertString(intent.nextBestAction, "nextBestAction"),
		outcome: assertString(intent.outcome, "outcome"),
		finalEvidence: assertString(intent.finalEvidence, "finalEvidence"),
		createdAt: assertTimestamp(intent.createdAt),
	};
}

export function assertPiXkSessionLink(value: unknown): asserts value is PiXkSessionLink {
	if (!isPiXkSessionLink(value)) {
		throw new Error("Pi-XK session link must use the pi-xk.session-link.v1 goal_binding schema");
	}
}
