export const GOAL_CONTRACT_V1_SCHEMA = "pi-xk.goal.contract.v1";

export const GOAL_CONTRACT_V2_SCHEMA = "pi-xk.goal.contract.v2";

/** @deprecated Use GOAL_CONTRACT_V1_SCHEMA or GOAL_CONTRACT_V2_SCHEMA explicitly. */
export const GOAL_CONTRACT_SCHEMA = GOAL_CONTRACT_V1_SCHEMA;

export const GOAL_EVENT_SCHEMA = "pi-xk.goal-event.v1";

export const GOAL_CONTRACT_PROJECTION_SCHEMA = "pi-xk.goal-contract-projection.v1";

export const GOAL_CHECKPOINT_V1_SCHEMA = "pi-xk.goal-checkpoint.v1";

export const GOAL_CHECKPOINT_SCHEMA = "pi-xk.goal-checkpoint.v2";

export const GOAL_CHECKPOINT_EVIDENCE_SCHEMA = "pi-xk.goal-checkpoint-evidence.v1";

export const GOAL_FILE_SCHEMA = "pi-xk.goal-file.v1";

export const GOAL_ARTIFACT_SCHEMA = "pi-xk.artifact.v1";

export const GOAL_ARTIFACT_REF_SCHEMA = "pi-xk.artifact-ref.v1";

export const GOAL_READ_MODEL_SCHEMA = "pi-xk.goal-read-model.v1";

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
	schema: typeof GOAL_CONTRACT_V1_SCHEMA;
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

export interface GoalContractV2 {
	schema: typeof GOAL_CONTRACT_V2_SCHEMA;
	goalId: string;
	title: string;
	objective: string;
	constraints: string[];
	acceptance: GoalAcceptance[];
	capabilities: GoalCapabilities;
	budgets: GoalBudgets;
	ownerSessionId: string;
	createdAt: string;
	schemaVersion: 2;
	nonGoals: string[];
	doneCondition: string;
	pauseCondition: string;
	finalReport: string;
	executionAuthorization: string;
}

/** Raw on-disk contract payloads preserve their original version for hash replay. */
export type GoalContract = GoalContractV1 | GoalContractV2;

export type GoalActor = "user" | "runtime" | "model" | "child-task" | "system";

export interface GoalHead {
	sequence: number;
	hash: string;
}

export type GoalArtifactContentType = "application/json" | "text/plain";

export type GoalArtifactSensitivity = "internal" | "redacted";

export type GoalArtifactRole = "checkpoint_evidence" | "compaction_source";

export interface GoalArtifactMetadata {
	schema: typeof GOAL_ARTIFACT_SCHEMA;
	artifactId: string;
	contentType: GoalArtifactContentType;
	bytes: number;
	createdAt: string;
	producer: string;
	sensitivity: GoalArtifactSensitivity;
	redactionVersion: string;
	sourceIds: string[];
}

export interface GoalArtifactReference {
	schema: typeof GOAL_ARTIFACT_REF_SCHEMA;
	artifactId: string;
	role: GoalArtifactRole;
}

export interface GoalCreatedEventPayload {
	contract: GoalContract;
}

export interface GoalContractUpdatedEventPayload {
	contract: GoalContract;
}

export type GoalCheckpointReason = "turn_end" | "session_before_compact";

export interface GoalCheckpointV1 {
	schema: typeof GOAL_CHECKPOINT_V1_SCHEMA;
	sessionId: string;
	leafId: string;
	turnIndex: number;
	toolResultCount: number;
	reason: "turn_end";
	createdAt: string;
}

export interface GoalCheckpointEvidence {
	schema: typeof GOAL_CHECKPOINT_EVIDENCE_SCHEMA;
	sourceEntryIds: string[];
	artifacts: GoalArtifactReference[];
}

export interface GoalCheckpointV2 {
	schema: typeof GOAL_CHECKPOINT_SCHEMA;
	sessionId: string;
	leafId: string;
	turnIndex?: number;
	toolResultCount?: number;
	reason: GoalCheckpointReason;
	createdAt: string;
	evidence: GoalCheckpointEvidence;
}

/** Raw checkpoint payloads preserve their original on-disk schema for hash replay. */
export type GoalCheckpoint = GoalCheckpointV1 | GoalCheckpointV2;

export interface GoalCheckpointedEventPayload {
	checkpoint: GoalCheckpoint;
}

export type GoalLifecycleEventType =
	| "goal_activated"
	| "goal_paused"
	| "goal_resumed"
	| "goal_ended"
	| "goal_run_started"
	| "goal_run_settled"
	| "goal_run_interrupted";

export interface GoalPauseAudit {
	unmetRequiredAcceptanceIds: string[];
	currentEvidence: string;
	incompleteConclusion: string;
}

export interface GoalPauseRecord {
	actor: GoalActor;
	reason: string;
	userRequest: string | null;
	nextBestAction: string;
	audit: GoalPauseAudit;
}

export interface GoalResumeRecord {
	actor: GoalActor;
	reason: string;
	resumeEvidence: string;
}

export interface GoalEndRecord {
	actor: GoalActor;
	outcome: string;
	reason: string;
	verifiedAcceptanceIds: string[];
	finalEvidence: string;
	finalSummary: string;
}

export interface GoalActivatedEventPayload {
	sessionId: string;
}

export interface GoalPausedEventPayload {
	reason?: string;
	userRequest?: string | null;
	nextBestAction?: string;
	audit?: GoalPauseAudit;
}

export interface GoalResumedEventPayload {
	reason?: string;
	resumeEvidence?: string;
}

export interface GoalEndedEventPayload {
	outcome: string;
	reason?: string;
	finalEvidence?: string;
	verifiedAcceptanceIds?: string[];
	finalSummary?: string;
}

export interface GoalRunStartedEventPayload {
	runId: string;
	sessionId: string;
}

export interface GoalRunSettledEventPayload {
	runId: string;
}

export interface GoalRunInterruptedEventPayload {
	runId: string;
	reason?: string;
	/** A newly loaded runtime closed a run it cannot time reliably. */
	recovered?: boolean;
}

export type GoalLifecycleEventPayload =
	| GoalActivatedEventPayload
	| GoalPausedEventPayload
	| GoalResumedEventPayload
	| GoalEndedEventPayload
	| GoalRunStartedEventPayload
	| GoalRunSettledEventPayload
	| GoalRunInterruptedEventPayload;

export type GoalLifecycleEventInput =
	| { eventType: "goal_activated"; payload: GoalActivatedEventPayload }
	| { eventType: "goal_paused"; payload: GoalPausedEventPayload }
	| { eventType: "goal_resumed"; payload: GoalResumedEventPayload }
	| { eventType: "goal_ended"; payload: GoalEndedEventPayload }
	| { eventType: "goal_run_started"; payload: GoalRunStartedEventPayload }
	| { eventType: "goal_run_settled"; payload: GoalRunSettledEventPayload }
	| { eventType: "goal_run_interrupted"; payload: GoalRunInterruptedEventPayload };

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

interface GoalLifecycleEventBase<TEventType extends GoalLifecycleEventType, TPayload> {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: TEventType;
	actor: GoalActor;
	timestamp: string;
	prevHash: string;
	payload: TPayload;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export type GoalLifecycleEvent =
	| GoalLifecycleEventBase<"goal_activated", GoalActivatedEventPayload>
	| GoalLifecycleEventBase<"goal_paused", GoalPausedEventPayload>
	| GoalLifecycleEventBase<"goal_resumed", GoalResumedEventPayload>
	| GoalLifecycleEventBase<"goal_ended", GoalEndedEventPayload>
	| GoalLifecycleEventBase<"goal_run_started", GoalRunStartedEventPayload>
	| GoalLifecycleEventBase<"goal_run_settled", GoalRunSettledEventPayload>
	| GoalLifecycleEventBase<"goal_run_interrupted", GoalRunInterruptedEventPayload>;

export type GoalEvent = GoalCreatedEvent | GoalContractUpdatedEvent | GoalCheckpointedEvent | GoalLifecycleEvent;

export type GoalLifecycleStatus = "inactive" | "active" | "paused" | "ended";

export type GoalRunStatus = "settled" | "interrupted";

export interface GoalRunProjection {
	runId: string;
	sessionId: string;
	startedAt: string;
	endedAt?: string;
	status: GoalRunStatus;
}

export interface GoalLifecycleProjection {
	status: GoalLifecycleStatus;
	activatedAt?: string;
	pausedAt?: string;
	endedAt?: string;
	/** Milliseconds from activation until end or replay time, including pauses. */
	wallElapsed: number;
	/** Milliseconds while active, excluding paused intervals. */
	activeElapsed: number;
	/** Milliseconds for explicitly closed runs only. */
	busyElapsed: number;
	runs: GoalRunProjection[];
	/** The log still has a run start without a corresponding terminal event. */
	openRunId?: string;
	/** The most recent pause request, including compatibility defaults for legacy events. */
	lastPause?: GoalPauseRecord;
	/** The most recent resume request, including compatibility defaults for legacy events. */
	lastResume?: GoalResumeRecord;
	/** The terminal result, including compatibility defaults for legacy events. */
	end?: GoalEndRecord;
}

export interface GoalContractProjection {
	schema: typeof GOAL_CONTRACT_PROJECTION_SCHEMA;
	goalId: string;
	sequence: number;
	baseHash: string;
	contract: GoalContractV2;
}

export type GoalArtifactDiagnosticStatus = "valid" | "missing" | "corrupt";

export interface GoalArtifactDiagnostic {
	artifactId: string;
	status: GoalArtifactDiagnosticStatus;
}

export interface GoalReadModelLatestCheckpoint {
	eventId: string;
	checkpoint: GoalCheckpointV2;
}

export interface GoalReadModel {
	schema: typeof GOAL_READ_MODEL_SCHEMA;
	goalId: string;
	sequence: number;
	baseHash: string;
	lifecycle: GoalLifecycleProjection;
	checkpointCount: number;
	latestCheckpoint?: GoalReadModelLatestCheckpoint;
	artifactDiagnostics: GoalArtifactDiagnostic[];
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

function requireAllowedKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) {
			throw new GoalValidationError(`${field} has unknown fields`);
		}
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

export function validateGoalContractV1(value: unknown): GoalContractV1 {
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
	if (value.schema !== GOAL_CONTRACT_V1_SCHEMA || value.schemaVersion !== 1) {
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
		schema: GOAL_CONTRACT_V1_SCHEMA,
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

export function validateGoalContractV2(value: unknown): GoalContractV2 {
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
			"nonGoals",
			"doneCondition",
			"pauseCondition",
			"finalReport",
			"executionAuthorization",
		],
		"Goal contract",
	);
	if (value.schema !== GOAL_CONTRACT_V2_SCHEMA || value.schemaVersion !== 2) {
		throw new GoalValidationError("Goal contract schema is unsupported");
	}
	const goalId = requireNonEmptyString(value.goalId, "goalId");
	assertGoalId(goalId);
	if (!Array.isArray(value.constraints) || value.constraints.some((constraint) => typeof constraint !== "string")) {
		throw new GoalValidationError("constraints must be a string array");
	}
	if (!Array.isArray(value.nonGoals) || value.nonGoals.some((nonGoal) => typeof nonGoal !== "string")) {
		throw new GoalValidationError("nonGoals must be a string array");
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
	if (!acceptance.some((item) => item.required)) {
		throw new GoalValidationError("Goal contract v2 requires at least one required acceptance");
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
		schema: GOAL_CONTRACT_V2_SCHEMA,
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
		schemaVersion: 2,
		nonGoals: [...value.nonGoals],
		doneCondition: requireNonEmptyString(value.doneCondition, "doneCondition"),
		pauseCondition: requireNonEmptyString(value.pauseCondition, "pauseCondition"),
		finalReport: requireNonEmptyString(value.finalReport, "finalReport"),
		executionAuthorization: requireNonEmptyString(value.executionAuthorization, "executionAuthorization"),
	};
}

export function validateGoalContract(value: unknown): GoalContract {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal contract must be an object");
	}
	if (value.schema === GOAL_CONTRACT_V1_SCHEMA) return validateGoalContractV1(value);
	if (value.schema === GOAL_CONTRACT_V2_SCHEMA) return validateGoalContractV2(value);
	throw new GoalValidationError("Goal contract schema is unsupported");
}

/** Converts a validated raw contract into the current in-memory representation without changing its source payload. */
export function upcastGoalContract(contract: GoalContract): GoalContractV2 {
	if (contract.schema === GOAL_CONTRACT_V2_SCHEMA) {
		return validateGoalContractV2(contract);
	}
	const legacy = validateGoalContractV1(contract);
	return {
		schema: GOAL_CONTRACT_V2_SCHEMA,
		goalId: legacy.goalId,
		title: legacy.title,
		objective: legacy.objective,
		constraints: [...legacy.constraints],
		acceptance: legacy.acceptance.map((item) => ({ ...item })),
		capabilities: { ...legacy.capabilities },
		budgets: { ...legacy.budgets },
		ownerSessionId: legacy.ownerSessionId,
		createdAt: legacy.createdAt,
		schemaVersion: 2,
		nonGoals: [],
		doneCondition: "All required acceptance criteria have verified evidence.",
		pauseCondition: "No in-scope action can continue without new input, external change, or evidence.",
		finalReport: "Report verified acceptance evidence, unresolved limits, and the next action.",
		executionAuthorization: "No execution authorization was recorded in this legacy Goal contract.",
	};
}

function requireArtifactId(value: unknown, field: string): string {
	const artifactId = requireNonEmptyString(value, field);
	if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) {
		throw new GoalValidationError(`${field} must use the sha256:<lowercase-hex> format`);
	}
	return artifactId;
}

export function validateGoalArtifactReference(value: unknown): GoalArtifactReference {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal artifact reference must be an object");
	}
	requireExactKeys(value, ["schema", "artifactId", "role"], "Goal artifact reference");
	if (value.schema !== GOAL_ARTIFACT_REF_SCHEMA) {
		throw new GoalValidationError("Goal artifact reference schema is unsupported");
	}
	const role = requireNonEmptyString(value.role, "artifact reference role");
	if (role !== "checkpoint_evidence" && role !== "compaction_source") {
		throw new GoalValidationError("Goal artifact reference role is unsupported");
	}
	return {
		schema: GOAL_ARTIFACT_REF_SCHEMA,
		artifactId: requireArtifactId(value.artifactId, "artifact reference artifactId"),
		role,
	};
}

function validateGoalCheckpointEvidence(value: unknown, leafId: string): GoalCheckpointEvidence {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal checkpoint evidence must be an object");
	}
	requireExactKeys(value, ["schema", "sourceEntryIds", "artifacts"], "Goal checkpoint evidence");
	if (value.schema !== GOAL_CHECKPOINT_EVIDENCE_SCHEMA) {
		throw new GoalValidationError("Goal checkpoint evidence schema is unsupported");
	}
	if (!Array.isArray(value.sourceEntryIds) || value.sourceEntryIds.length === 0) {
		throw new GoalValidationError("checkpoint evidence sourceEntryIds must be a non-empty string array");
	}
	const sourceEntryIds = value.sourceEntryIds.map((sourceEntryId, index) =>
		requireNonEmptyString(sourceEntryId, `checkpoint evidence sourceEntryIds[${index}]`),
	);
	if (new Set(sourceEntryIds).size !== sourceEntryIds.length) {
		throw new GoalValidationError("checkpoint evidence sourceEntryIds must be unique");
	}
	if (!sourceEntryIds.includes(leafId)) {
		throw new GoalValidationError("checkpoint evidence must include its leafId as a source entry");
	}
	if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
		throw new GoalValidationError("checkpoint evidence artifacts must be a non-empty array");
	}
	const artifacts = value.artifacts.map(validateGoalArtifactReference);
	const artifactIds = new Set<string>();
	for (const artifact of artifacts) {
		if (artifactIds.has(artifact.artifactId)) {
			throw new GoalValidationError("checkpoint evidence artifact IDs must be unique");
		}
		artifactIds.add(artifact.artifactId);
	}
	return { schema: GOAL_CHECKPOINT_EVIDENCE_SCHEMA, sourceEntryIds, artifacts };
}

function validateGoalCheckpointV1(value: Record<string, unknown>): GoalCheckpointV1 {
	requireExactKeys(
		value,
		["schema", "sessionId", "leafId", "turnIndex", "toolResultCount", "reason", "createdAt"],
		"Goal checkpoint v1",
	);
	if (value.reason !== "turn_end") {
		throw new GoalValidationError("Goal checkpoint v1 reason is unsupported");
	}
	const createdAt = requireNonEmptyString(value.createdAt, "checkpoint.createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new GoalValidationError("checkpoint.createdAt must be an ISO timestamp");
	}
	return {
		schema: GOAL_CHECKPOINT_V1_SCHEMA,
		sessionId: requireNonEmptyString(value.sessionId, "checkpoint.sessionId"),
		leafId: requireNonEmptyString(value.leafId, "checkpoint.leafId"),
		turnIndex: requireNonNegativeInteger(value.turnIndex, "checkpoint.turnIndex"),
		toolResultCount: requireNonNegativeInteger(value.toolResultCount, "checkpoint.toolResultCount"),
		reason: "turn_end",
		createdAt,
	};
}

function validateGoalCheckpointV2(value: Record<string, unknown>): GoalCheckpointV2 {
	const reason = requireNonEmptyString(value.reason, "checkpoint.reason");
	if (reason !== "turn_end" && reason !== "session_before_compact") {
		throw new GoalValidationError("Goal checkpoint v2 reason is unsupported");
	}
	if (reason === "turn_end") {
		requireExactKeys(
			value,
			["schema", "sessionId", "leafId", "turnIndex", "toolResultCount", "reason", "createdAt", "evidence"],
			"Goal checkpoint v2 turn_end",
		);
	} else {
		requireExactKeys(
			value,
			["schema", "sessionId", "leafId", "reason", "createdAt", "evidence"],
			"Goal checkpoint v2 session_before_compact",
		);
	}
	const sessionId = requireNonEmptyString(value.sessionId, "checkpoint.sessionId");
	const leafId = requireNonEmptyString(value.leafId, "checkpoint.leafId");
	const createdAt = requireNonEmptyString(value.createdAt, "checkpoint.createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new GoalValidationError("checkpoint.createdAt must be an ISO timestamp");
	}
	const evidence = validateGoalCheckpointEvidence(value.evidence, leafId);
	if (reason === "turn_end") {
		return {
			schema: GOAL_CHECKPOINT_SCHEMA,
			sessionId,
			leafId,
			turnIndex: requireNonNegativeInteger(value.turnIndex, "checkpoint.turnIndex"),
			toolResultCount: requireNonNegativeInteger(value.toolResultCount, "checkpoint.toolResultCount"),
			reason,
			createdAt,
			evidence,
		};
	}
	return {
		schema: GOAL_CHECKPOINT_SCHEMA,
		sessionId,
		leafId,
		reason,
		createdAt,
		evidence,
	};
}

export function validateGoalCheckpoint(value: unknown): GoalCheckpoint {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal checkpoint must be an object");
	}
	if (value.schema === GOAL_CHECKPOINT_V1_SCHEMA) {
		return validateGoalCheckpointV1(value);
	}
	if (value.schema === GOAL_CHECKPOINT_SCHEMA) {
		return validateGoalCheckpointV2(value);
	}
	throw new GoalValidationError("Goal checkpoint schema is unsupported");
}

export function upcastGoalCheckpoint(checkpoint: GoalCheckpoint): GoalCheckpointV2 {
	if (checkpoint.schema === GOAL_CHECKPOINT_SCHEMA) {
		return {
			...checkpoint,
			evidence: {
				...checkpoint.evidence,
				sourceEntryIds: [...checkpoint.evidence.sourceEntryIds],
				artifacts: checkpoint.evidence.artifacts.map((artifact) => ({ ...artifact })),
			},
		};
	}
	return {
		schema: GOAL_CHECKPOINT_SCHEMA,
		sessionId: checkpoint.sessionId,
		leafId: checkpoint.leafId,
		turnIndex: checkpoint.turnIndex,
		toolResultCount: checkpoint.toolResultCount,
		reason: "turn_end",
		createdAt: checkpoint.createdAt,
		evidence: {
			schema: GOAL_CHECKPOINT_EVIDENCE_SCHEMA,
			sourceEntryIds: [checkpoint.leafId],
			artifacts: [],
		},
	};
}

function requireOptionalNonEmptyString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requireNonEmptyString(value, field);
}

function requireOptionalNullableNonEmptyString(value: unknown, field: string): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	return requireNonEmptyString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new GoalValidationError(`${field} must be a string array`);
	}
	return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function validateGoalPauseAudit(value: unknown): GoalPauseAudit {
	if (!isRecord(value)) {
		throw new GoalValidationError("goal_paused.audit must be an object");
	}
	requireExactKeys(
		value,
		["unmetRequiredAcceptanceIds", "currentEvidence", "incompleteConclusion"],
		"goal_paused.audit",
	);
	return {
		unmetRequiredAcceptanceIds: requireStringArray(
			value.unmetRequiredAcceptanceIds,
			"goal_paused.audit.unmetRequiredAcceptanceIds",
		),
		currentEvidence: requireNonEmptyString(value.currentEvidence, "goal_paused.audit.currentEvidence"),
		incompleteConclusion: requireNonEmptyString(value.incompleteConclusion, "goal_paused.audit.incompleteConclusion"),
	};
}

function validateLifecyclePayloadRecord(
	value: unknown,
	keys: readonly string[],
	field: string,
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new GoalValidationError(`${field} must be an object`);
	}
	requireAllowedKeys(value, keys, field);
	return value;
}

export function validateGoalLifecycleEventInput(value: unknown): GoalLifecycleEventInput {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal lifecycle event input has unknown or missing fields");
	}
	requireExactKeys(value, ["eventType", "payload"], "Goal lifecycle event input");
	if (value.eventType === "goal_activated") {
		const payload = validateLifecyclePayloadRecord(value.payload, ["sessionId"], "goal_activated payload");
		return {
			eventType: "goal_activated",
			payload: { sessionId: requireNonEmptyString(payload.sessionId, "goal_activated.sessionId") },
		};
	}
	if (value.eventType === "goal_paused") {
		const payload = validateLifecyclePayloadRecord(
			value.payload,
			["reason", "userRequest", "nextBestAction", "audit"],
			"goal_paused payload",
		);
		return {
			eventType: "goal_paused",
			payload: {
				...(payload.reason === undefined
					? {}
					: { reason: requireOptionalNonEmptyString(payload.reason, "goal_paused.reason") }),
				...(payload.userRequest === undefined
					? {}
					: {
							userRequest: requireOptionalNullableNonEmptyString(payload.userRequest, "goal_paused.userRequest"),
						}),
				...(payload.nextBestAction === undefined
					? {}
					: {
							nextBestAction: requireOptionalNonEmptyString(
								payload.nextBestAction,
								"goal_paused.nextBestAction",
							),
						}),
				...(payload.audit === undefined ? {} : { audit: validateGoalPauseAudit(payload.audit) }),
			},
		};
	}
	if (value.eventType === "goal_resumed") {
		const payload = validateLifecyclePayloadRecord(
			value.payload,
			["reason", "resumeEvidence"],
			"goal_resumed payload",
		);
		return {
			eventType: "goal_resumed",
			payload: {
				...(payload.reason === undefined
					? {}
					: { reason: requireOptionalNonEmptyString(payload.reason, "goal_resumed.reason") }),
				...(payload.resumeEvidence === undefined
					? {}
					: {
							resumeEvidence: requireOptionalNonEmptyString(
								payload.resumeEvidence,
								"goal_resumed.resumeEvidence",
							),
						}),
			},
		};
	}
	if (value.eventType === "goal_ended") {
		const payload = validateLifecyclePayloadRecord(
			value.payload,
			["outcome", "reason", "finalEvidence", "verifiedAcceptanceIds", "finalSummary"],
			"goal_ended payload",
		);
		return {
			eventType: "goal_ended",
			payload: {
				outcome: requireNonEmptyString(payload.outcome, "goal_ended.outcome"),
				...(payload.reason === undefined
					? {}
					: { reason: requireOptionalNonEmptyString(payload.reason, "goal_ended.reason") }),
				...(payload.finalEvidence === undefined
					? {}
					: { finalEvidence: requireOptionalNonEmptyString(payload.finalEvidence, "goal_ended.finalEvidence") }),
				...(payload.verifiedAcceptanceIds === undefined
					? {}
					: {
							verifiedAcceptanceIds: requireStringArray(
								payload.verifiedAcceptanceIds,
								"goal_ended.verifiedAcceptanceIds",
							),
						}),
				...(payload.finalSummary === undefined
					? {}
					: { finalSummary: requireOptionalNonEmptyString(payload.finalSummary, "goal_ended.finalSummary") }),
			},
		};
	}
	if (value.eventType === "goal_run_started") {
		const payload = validateLifecyclePayloadRecord(value.payload, ["runId", "sessionId"], "goal_run_started payload");
		return {
			eventType: "goal_run_started",
			payload: {
				runId: requireNonEmptyString(payload.runId, "goal_run_started.runId"),
				sessionId: requireNonEmptyString(payload.sessionId, "goal_run_started.sessionId"),
			},
		};
	}
	if (value.eventType === "goal_run_settled") {
		const payload = validateLifecyclePayloadRecord(value.payload, ["runId"], "goal_run_settled payload");
		return {
			eventType: "goal_run_settled",
			payload: { runId: requireNonEmptyString(payload.runId, "goal_run_settled.runId") },
		};
	}
	if (value.eventType === "goal_run_interrupted") {
		const payload = validateLifecyclePayloadRecord(
			value.payload,
			["runId", "reason", "recovered"],
			"goal_run_interrupted payload",
		);
		if (payload.recovered !== undefined && typeof payload.recovered !== "boolean") {
			throw new GoalValidationError("goal_run_interrupted.recovered must be a boolean");
		}
		return {
			eventType: "goal_run_interrupted",
			payload: {
				runId: requireNonEmptyString(payload.runId, "goal_run_interrupted.runId"),
				...(payload.reason === undefined
					? {}
					: { reason: requireOptionalNonEmptyString(payload.reason, "goal_run_interrupted.reason") }),
				...(payload.recovered === undefined ? {} : { recovered: payload.recovered }),
			},
		};
	}
	throw new GoalValidationError("Goal lifecycle event type is unsupported");
}

function assertV2AcceptanceIds(
	acceptanceIds: readonly string[],
	contract: GoalContractV2,
	field: string,
	requiredOnly: boolean,
): void {
	if (new Set(acceptanceIds).size !== acceptanceIds.length) {
		throw new GoalValidationError(`${field} must not contain duplicate acceptance IDs`);
	}
	const eligible = new Set(
		contract.acceptance
			.filter((acceptance) => !requiredOnly || acceptance.required)
			.map((acceptance) => acceptance.id),
	);
	for (const acceptanceId of acceptanceIds) {
		if (!eligible.has(acceptanceId)) {
			throw new GoalValidationError(`${field} contains an unknown or ineligible acceptance ID: ${acceptanceId}`);
		}
	}
}

/**
 * Validates new lifecycle writes against a v2 contract. Legacy raw lifecycle payloads remain readable
 * through validateGoalLifecycleEventInput so their original event hashes can still replay.
 */
export function validateGoalLifecycleEventForContract(
	value: unknown,
	contract: GoalContract,
	actor?: GoalActor,
): GoalLifecycleEventInput {
	const input = validateGoalLifecycleEventInput(value);
	if (contract.schema !== GOAL_CONTRACT_V2_SCHEMA) return input;
	if (input.eventType === "goal_paused") {
		const { reason, userRequest, nextBestAction, audit } = input.payload;
		if (reason === undefined || userRequest === undefined || nextBestAction === undefined || audit === undefined) {
			throw new GoalValidationError(
				"Goal contract v2 pauses require reason, userRequest, nextBestAction, and audit",
			);
		}
		if (audit.unmetRequiredAcceptanceIds.length === 0) {
			throw new GoalValidationError("Goal contract v2 pause audit requires an unmet required acceptance ID");
		}
		assertV2AcceptanceIds(
			audit.unmetRequiredAcceptanceIds,
			contract,
			"goal_paused.audit.unmetRequiredAcceptanceIds",
			true,
		);
		return input;
	}
	if (input.eventType === "goal_resumed") {
		if (input.payload.reason === undefined || input.payload.resumeEvidence === undefined) {
			throw new GoalValidationError("Goal contract v2 resumes require reason and resumeEvidence");
		}
		return input;
	}
	if (input.eventType === "goal_ended") {
		const { reason, verifiedAcceptanceIds, finalEvidence, finalSummary } = input.payload;
		if (actor === "user" && input.payload.outcome === "ended_by_user") {
			if (reason === undefined) {
				throw new GoalValidationError("User Goal termination requires a reason");
			}
			return input;
		}
		if (
			reason === undefined ||
			verifiedAcceptanceIds === undefined ||
			finalEvidence === undefined ||
			finalSummary === undefined
		) {
			throw new GoalValidationError(
				"Goal contract v2 endings require reason, verifiedAcceptanceIds, finalEvidence, and finalSummary",
			);
		}
		assertV2AcceptanceIds(verifiedAcceptanceIds, contract, "goal_ended.verifiedAcceptanceIds", false);
		for (const requiredAcceptance of contract.acceptance.filter((acceptance) => acceptance.required)) {
			if (!verifiedAcceptanceIds.includes(requiredAcceptance.id)) {
				throw new GoalValidationError(
					`Goal contract v2 ending is missing required acceptance ID: ${requiredAcceptance.id}`,
				);
			}
		}
		return input;
	}
	return input;
}
