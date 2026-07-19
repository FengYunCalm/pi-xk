export const GOAL_CONTRACT_SCHEMA = "pi-xk.goal.contract.v1";

export const GOAL_EVENT_SCHEMA = "pi-xk.goal-event.v1";

export const GOAL_CONTRACT_PROJECTION_SCHEMA = "pi-xk.goal-contract-projection.v1";

export const GOAL_CHECKPOINT_SCHEMA = "pi-xk.goal-checkpoint.v1";

export type GoalAcceptanceKind = "command" | "test" | "artifact" | "approval";

export interface GoalAcceptance {
	id: string;
	kind: GoalAcceptanceKind;
	description: string;
	required: boolean;
	command?: string;
}

export interface GoalCapabilities {
	filesystem: string;
	network: string;
	spawn: string;
}

export interface GoalBudgets {
	tokens: number;
	costCents: number;
	wallSeconds: number;
}

export interface GoalContractV1 {
	schema: typeof GOAL_CONTRACT_SCHEMA;
	goalId: string;
	title: string;
	objective: string;
	constraints: string[];
	acceptance: GoalAcceptance[];
	capabilities: GoalCapabilities;
	budgets: GoalBudgets;
	ownerSessionId: string;
	createdAt: string;
	schemaVersion: 1;
}

export type GoalActor = "user" | "runtime" | "model" | "child-task" | "system";

export interface GoalHead {
	sequence: number;
	hash: string;
}

export interface GoalCreatedEventPayload {
	contract: GoalContractV1;
}

export interface GoalContractUpdatedEventPayload {
	contract: GoalContractV1;
}

export interface GoalCheckpoint {
	schema: typeof GOAL_CHECKPOINT_SCHEMA;
	sessionId: string;
	leafId: string;
	turnIndex: number;
	toolResultCount: number;
	reason: "turn_end";
	createdAt: string;
}

export interface GoalCheckpointedEventPayload {
	checkpoint: GoalCheckpoint;
}

export interface GoalCreatedEvent {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: "goal_created";
	actor: GoalActor;
	timestamp: string;
	prevHash: null;
	payload: GoalCreatedEventPayload;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export interface GoalContractUpdatedEvent {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: "goal_contract_updated";
	actor: GoalActor;
	timestamp: string;
	prevHash: string;
	payload: GoalContractUpdatedEventPayload;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export interface GoalCheckpointedEvent {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: "goal_checkpointed";
	actor: GoalActor;
	timestamp: string;
	prevHash: string;
	payload: GoalCheckpointedEventPayload;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export type GoalEvent = GoalCreatedEvent | GoalContractUpdatedEvent | GoalCheckpointedEvent;

export interface GoalContractProjection {
	schema: typeof GOAL_CONTRACT_PROJECTION_SCHEMA;
	goalId: string;
	sequence: number;
	baseHash: string;
	contract: GoalContractV1;
}

export class GoalValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GoalValidationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new GoalValidationError(`${field} must be a non-negative integer`);
	}
	return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new GoalValidationError(`${field} has unknown or missing fields`);
	}
}

function validateGoalAcceptance(value: unknown, index: number): GoalAcceptance {
	if (!isRecord(value)) {
		throw new GoalValidationError(`acceptance[${index}] must be an object`);
	}
	const kind = requireNonEmptyString(value.kind, `acceptance[${index}].kind`);
	if (kind !== "command" && kind !== "test" && kind !== "artifact" && kind !== "approval") {
		throw new GoalValidationError(`acceptance[${index}].kind is invalid`);
	}
	const hasCommand = "command" in value;
	if (kind === "command" || kind === "test") {
		requireExactKeys(value, ["id", "kind", "description", "required", "command"], `acceptance[${index}]`);
	} else if (hasCommand) {
		throw new GoalValidationError(`acceptance[${index}].command is only valid for command and test acceptance`);
	} else {
		requireExactKeys(value, ["id", "kind", "description", "required"], `acceptance[${index}]`);
	}
	if (typeof value.required !== "boolean") {
		throw new GoalValidationError(`acceptance[${index}].required must be a boolean`);
	}
	return {
		id: requireNonEmptyString(value.id, `acceptance[${index}].id`),
		kind,
		description: requireNonEmptyString(value.description, `acceptance[${index}].description`),
		required: value.required,
		...(hasCommand ? { command: requireNonEmptyString(value.command, `acceptance[${index}].command`) } : {}),
	};
}

export function assertGoalId(goalId: string): void {
	if (!/^goal_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(goalId)) {
		throw new GoalValidationError("goalId must use the goal_<safe-id> format");
	}
}

export function validateGoalContract(value: unknown): GoalContractV1 {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal contract must be an object");
	}
	requireExactKeys(
		value,
		[
			"schema",
			"goalId",
			"title",
			"objective",
			"constraints",
			"acceptance",
			"capabilities",
			"budgets",
			"ownerSessionId",
			"createdAt",
			"schemaVersion",
		],
		"Goal contract",
	);
	if (value.schema !== GOAL_CONTRACT_SCHEMA || value.schemaVersion !== 1) {
		throw new GoalValidationError("Goal contract schema is unsupported");
	}
	const goalId = requireNonEmptyString(value.goalId, "goalId");
	assertGoalId(goalId);
	if (!Array.isArray(value.constraints) || value.constraints.some((constraint) => typeof constraint !== "string")) {
		throw new GoalValidationError("constraints must be a string array");
	}
	if (!Array.isArray(value.acceptance)) {
		throw new GoalValidationError("acceptance must be an array");
	}
	const acceptance = value.acceptance.map(validateGoalAcceptance);
	const acceptanceIds = new Set<string>();
	for (const item of acceptance) {
		if (acceptanceIds.has(item.id)) {
			throw new GoalValidationError("acceptance IDs must be unique");
		}
		acceptanceIds.add(item.id);
	}
	if (!isRecord(value.capabilities)) {
		throw new GoalValidationError("capabilities must be an object");
	}
	requireExactKeys(value.capabilities, ["filesystem", "network", "spawn"], "capabilities");
	if (!isRecord(value.budgets)) {
		throw new GoalValidationError("budgets must be an object");
	}
	requireExactKeys(value.budgets, ["tokens", "costCents", "wallSeconds"], "budgets");
	const createdAt = requireNonEmptyString(value.createdAt, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new GoalValidationError("createdAt must be an ISO timestamp");
	}
	return {
		schema: GOAL_CONTRACT_SCHEMA,
		goalId,
		title: requireNonEmptyString(value.title, "title"),
		objective: requireNonEmptyString(value.objective, "objective"),
		constraints: [...value.constraints],
		acceptance,
		capabilities: {
			filesystem: requireNonEmptyString(value.capabilities.filesystem, "capabilities.filesystem"),
			network: requireNonEmptyString(value.capabilities.network, "capabilities.network"),
			spawn: requireNonEmptyString(value.capabilities.spawn, "capabilities.spawn"),
		},
		budgets: {
			tokens: requireNonNegativeInteger(value.budgets.tokens, "budgets.tokens"),
			costCents: requireNonNegativeInteger(value.budgets.costCents, "budgets.costCents"),
			wallSeconds: requireNonNegativeInteger(value.budgets.wallSeconds, "budgets.wallSeconds"),
		},
		ownerSessionId: requireNonEmptyString(value.ownerSessionId, "ownerSessionId"),
		createdAt,
		schemaVersion: 1,
	};
}

export function validateGoalCheckpoint(value: unknown): GoalCheckpoint {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal checkpoint must be an object");
	}
	requireExactKeys(
		value,
		["schema", "sessionId", "leafId", "turnIndex", "toolResultCount", "reason", "createdAt"],
		"Goal checkpoint",
	);
	if (value.schema !== GOAL_CHECKPOINT_SCHEMA || value.reason !== "turn_end") {
		throw new GoalValidationError("Goal checkpoint schema or reason is unsupported");
	}
	const createdAt = requireNonEmptyString(value.createdAt, "checkpoint.createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new GoalValidationError("checkpoint.createdAt must be an ISO timestamp");
	}
	return {
		schema: GOAL_CHECKPOINT_SCHEMA,
		sessionId: requireNonEmptyString(value.sessionId, "checkpoint.sessionId"),
		leafId: requireNonEmptyString(value.leafId, "checkpoint.leafId"),
		turnIndex: requireNonNegativeInteger(value.turnIndex, "checkpoint.turnIndex"),
		toolResultCount: requireNonNegativeInteger(value.toolResultCount, "checkpoint.toolResultCount"),
		reason: "turn_end",
		createdAt,
	};
}
