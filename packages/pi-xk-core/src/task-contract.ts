export const TASK_SPEC_SCHEMA = "pi-xk.task.spec.v1";
export const TASK_RESULT_SCHEMA = "pi-xk.task-result.v1";
export const TASK_EVENT_SCHEMA = "pi-xk.task-event.v1";
export const TASK_READ_MODEL_SCHEMA = "pi-xk.task-read-model.v1";

export type TaskRole = "research" | "implementation" | "verification" | "review";
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "orphaned";
export type TaskTerminalStatus = Exclude<TaskStatus, "pending" | "running">;
export type TaskEvidenceKind = "file" | "command" | "text";

export interface TaskSpecV1 {
	schema: typeof TASK_SPEC_SCHEMA;
	taskId: string;
	parentSessionId: string;
	parentEntryId: string;
	parentGoalId: string | null;
	role: TaskRole;
	prompt: string;
	expectedResult: string;
	workspaceMode: "same-workspace";
	allowNestedSpawn: false;
	createdAt: string;
}

export interface TaskEvidence {
	kind: TaskEvidenceKind;
	value: string;
}

export interface TaskResultError {
	code: string;
	message: string;
}

export interface TaskResultEnvelopeV1 {
	schema: typeof TASK_RESULT_SCHEMA;
	taskId: string;
	status: TaskTerminalStatus;
	attempt: 1;
	summary: string;
	evidence: TaskEvidence[];
	artifactIds: string[];
	childSessionId: string;
	childSessionFile: string;
	startedAt: string | null;
	endedAt: string;
	error: TaskResultError | null;
}

export interface TaskChildInfoV1 {
	childSessionId: string;
	childSessionFile: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	builtinTools: string[];
	attempt: 1;
}

export interface TaskCreatedEventPayload {
	spec: TaskSpecV1;
}

export interface TaskStartedEventPayload {
	child: TaskChildInfoV1;
}

export interface TaskTerminalEventPayload {
	status: TaskTerminalStatus;
	resultArtifactId: string;
	summary: string;
	artifactIds: string[];
	error: TaskResultError | null;
}

export type TaskEventType =
	| "task_created"
	| "task_started"
	| "task_succeeded"
	| "task_failed"
	| "task_cancelled"
	| "task_orphaned";

export type TaskActor = "user" | "model" | "runtime" | "system";

interface TaskEventBase<TEventType extends TaskEventType, TPayload> {
	schema: typeof TASK_EVENT_SCHEMA;
	eventId: string;
	taskId: string;
	sequence: number;
	eventType: TEventType;
	actor: TaskActor;
	timestamp: string;
	prevHash: string | null;
	payload: TPayload;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export type TaskEvent =
	| TaskEventBase<"task_created", TaskCreatedEventPayload>
	| TaskEventBase<"task_started", TaskStartedEventPayload>
	| TaskEventBase<"task_succeeded", TaskTerminalEventPayload>
	| TaskEventBase<"task_failed", TaskTerminalEventPayload>
	| TaskEventBase<"task_cancelled", TaskTerminalEventPayload>
	| TaskEventBase<"task_orphaned", TaskTerminalEventPayload>;

export interface TaskHead {
	sequence: number;
	hash: string;
}

export interface TaskTerminalProjection {
	eventId: string;
	status: TaskTerminalStatus;
	resultArtifactId: string;
	summary: string;
	artifactIds: string[];
	error: TaskResultError | null;
	endedAt: string;
}

export interface TaskReadModel {
	schema: typeof TASK_READ_MODEL_SCHEMA;
	taskId: string;
	sequence: number;
	baseHash: string;
	spec: TaskSpecV1;
	status: TaskStatus;
	createdAt: string;
	startedAt?: string;
	child?: TaskChildInfoV1;
	result?: TaskTerminalProjection & { artifactStatus: "valid" | "missing" | "corrupt" };
}

export class TaskValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TaskValidationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireIso(value: unknown, field: string): string {
	const timestamp = requireNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(timestamp))) throw new TaskValidationError(`${field} must be an ISO timestamp`);
	return timestamp;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new TaskValidationError(`${field} has unknown or missing fields`);
	}
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new TaskValidationError(`${field} must be a string array`);
	return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function requireArtifactIds(value: unknown, field: string): string[] {
	const artifactIds = requireStringArray(value, field);
	for (const artifactId of artifactIds) {
		if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) {
			throw new TaskValidationError(`${field} must contain sha256 artifact IDs`);
		}
	}
	if (new Set(artifactIds).size !== artifactIds.length) {
		throw new TaskValidationError(`${field} must not contain duplicate artifact IDs`);
	}
	return artifactIds;
}

export function assertTaskId(taskId: string): void {
	if (!/^task_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) {
		throw new TaskValidationError("taskId must use the task_<safe-id> format");
	}
}

export function validateTaskSpecV1(value: unknown): TaskSpecV1 {
	if (!isRecord(value)) throw new TaskValidationError("Task spec must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"taskId",
			"parentSessionId",
			"parentEntryId",
			"parentGoalId",
			"role",
			"prompt",
			"expectedResult",
			"workspaceMode",
			"allowNestedSpawn",
			"createdAt",
		],
		"Task spec",
	);
	if (value.schema !== TASK_SPEC_SCHEMA) throw new TaskValidationError("Task spec schema is unsupported");
	const taskId = requireNonEmptyString(value.taskId, "taskId");
	assertTaskId(taskId);
	const role = requireNonEmptyString(value.role, "role");
	if (role !== "research" && role !== "implementation" && role !== "verification" && role !== "review") {
		throw new TaskValidationError("role is invalid");
	}
	if (value.parentGoalId !== null && typeof value.parentGoalId !== "string") {
		throw new TaskValidationError("parentGoalId must be a string or null");
	}
	if (value.workspaceMode !== "same-workspace") throw new TaskValidationError("workspaceMode is invalid");
	if (value.allowNestedSpawn !== false) throw new TaskValidationError("nested spawn is disabled");
	return {
		schema: TASK_SPEC_SCHEMA,
		taskId,
		parentSessionId: requireNonEmptyString(value.parentSessionId, "parentSessionId"),
		parentEntryId: requireNonEmptyString(value.parentEntryId, "parentEntryId"),
		parentGoalId: (() => {
			if (value.parentGoalId === null) return null;
			const goalId = requireNonEmptyString(value.parentGoalId, "parentGoalId");
			if (!/^goal_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(goalId)) {
				throw new TaskValidationError("parentGoalId must use the goal_<safe-id> format");
			}
			return goalId;
		})(),
		role,
		prompt: requireNonEmptyString(value.prompt, "prompt"),
		expectedResult: requireNonEmptyString(value.expectedResult, "expectedResult"),
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: requireIso(value.createdAt, "createdAt"),
	};
}

function validateEvidence(value: unknown): TaskEvidence[] {
	if (!Array.isArray(value)) throw new TaskValidationError("evidence must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new TaskValidationError(`evidence[${index}] must be an object`);
		requireExactKeys(item, ["kind", "value"], `evidence[${index}]`);
		const kind = requireNonEmptyString(item.kind, `evidence[${index}].kind`);
		if (kind !== "file" && kind !== "command" && kind !== "text")
			throw new TaskValidationError("evidence kind is invalid");
		return { kind, value: requireNonEmptyString(item.value, `evidence[${index}].value`) };
	});
}

function validateError(value: unknown, field: string): TaskResultError | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new TaskValidationError(`${field} must be an object or null`);
	requireExactKeys(value, ["code", "message"], field);
	return {
		code: requireNonEmptyString(value.code, `${field}.code`),
		message: requireNonEmptyString(value.message, `${field}.message`),
	};
}

export function validateTaskResultEnvelopeV1(value: unknown): TaskResultEnvelopeV1 {
	if (!isRecord(value)) throw new TaskValidationError("Task result must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"taskId",
			"status",
			"attempt",
			"summary",
			"evidence",
			"artifactIds",
			"childSessionId",
			"childSessionFile",
			"startedAt",
			"endedAt",
			"error",
		],
		"Task result",
	);
	if (value.schema !== TASK_RESULT_SCHEMA) throw new TaskValidationError("Task result schema is unsupported");
	const taskId = requireNonEmptyString(value.taskId, "taskId");
	assertTaskId(taskId);
	const status = requireNonEmptyString(value.status, "status");
	if (status !== "succeeded" && status !== "failed" && status !== "cancelled" && status !== "orphaned") {
		throw new TaskValidationError("status is invalid");
	}
	if (value.attempt !== 1) throw new TaskValidationError("attempt must be 1 in Task v1");
	const startedAt = value.startedAt === null ? null : requireIso(value.startedAt, "startedAt");
	const error = validateError(value.error, "error");
	if ((status === "succeeded" && error !== null) || (status !== "succeeded" && error === null)) {
		throw new TaskValidationError(`${status} result error field is invalid`);
	}
	return {
		schema: TASK_RESULT_SCHEMA,
		taskId,
		status,
		attempt: 1,
		summary: requireNonEmptyString(value.summary, "summary"),
		evidence: validateEvidence(value.evidence),
		artifactIds: requireArtifactIds(value.artifactIds, "artifactIds"),
		childSessionId: requireNonEmptyString(value.childSessionId, "childSessionId"),
		childSessionFile: requireNonEmptyString(value.childSessionFile, "childSessionFile"),
		startedAt,
		endedAt: requireIso(value.endedAt, "endedAt"),
		error,
	};
}

export function validateTaskChildInfo(value: unknown): TaskChildInfoV1 {
	if (!isRecord(value)) throw new TaskValidationError("Task child info must be an object");
	requireExactKeys(
		value,
		["childSessionId", "childSessionFile", "provider", "modelId", "thinkingLevel", "builtinTools", "attempt"],
		"Task child info",
	);
	if (value.attempt !== 1) throw new TaskValidationError("Task child attempt must be 1");
	return {
		childSessionId: requireNonEmptyString(value.childSessionId, "childSessionId"),
		childSessionFile: requireNonEmptyString(value.childSessionFile, "childSessionFile"),
		provider: requireNonEmptyString(value.provider, "provider"),
		modelId: requireNonEmptyString(value.modelId, "modelId"),
		thinkingLevel: requireNonEmptyString(value.thinkingLevel, "thinkingLevel"),
		builtinTools: requireStringArray(value.builtinTools, "builtinTools"),
		attempt: 1,
	};
}

export function validateTaskReadModel(value: unknown): TaskReadModel {
	if (!isRecord(value)) throw new TaskValidationError("Task read model must be an object");
	const allowed = [
		"schema",
		"taskId",
		"sequence",
		"baseHash",
		"spec",
		"status",
		"createdAt",
		"startedAt",
		"child",
		"result",
	];
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) throw new TaskValidationError("Task read model has unknown fields");
	if (value.schema !== TASK_READ_MODEL_SCHEMA) throw new TaskValidationError("Task read model schema is unsupported");
	const status = requireNonEmptyString(value.status, "status");
	if (!["pending", "running", "succeeded", "failed", "cancelled", "orphaned"].includes(status))
		throw new TaskValidationError("status is invalid");
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1)
		throw new TaskValidationError("sequence is invalid");
	if (typeof value.baseHash !== "string" || !value.baseHash.startsWith("sha256:"))
		throw new TaskValidationError("baseHash is invalid");
	let result: TaskReadModel["result"];
	if (value.result !== undefined) {
		if (!isRecord(value.result)) throw new TaskValidationError("Task read model result must be an object");
		requireExactKeys(
			value.result,
			["eventId", "status", "resultArtifactId", "summary", "artifactIds", "error", "endedAt", "artifactStatus"],
			"Task read model result",
		);
		const terminalStatus = requireNonEmptyString(value.result.status, "result.status");
		if (
			terminalStatus !== "succeeded" &&
			terminalStatus !== "failed" &&
			terminalStatus !== "cancelled" &&
			terminalStatus !== "orphaned"
		) {
			throw new TaskValidationError("result.status is invalid");
		}
		const artifactStatus = requireNonEmptyString(value.result.artifactStatus, "result.artifactStatus");
		if (artifactStatus !== "valid" && artifactStatus !== "missing" && artifactStatus !== "corrupt") {
			throw new TaskValidationError("result.artifactStatus is invalid");
		}
		const resultArtifactId = requireArtifactIds([value.result.resultArtifactId], "result.resultArtifactId")[0];
		if (!resultArtifactId) throw new TaskValidationError("result.resultArtifactId is invalid");
		result = {
			eventId: requireNonEmptyString(value.result.eventId, "result.eventId"),
			status: terminalStatus,
			resultArtifactId,
			summary: requireNonEmptyString(value.result.summary, "result.summary"),
			artifactIds: requireArtifactIds(value.result.artifactIds, "result.artifactIds"),
			error: validateError(value.result.error, "result.error"),
			endedAt: requireIso(value.result.endedAt, "result.endedAt"),
			artifactStatus,
		};
	}
	return {
		schema: TASK_READ_MODEL_SCHEMA,
		taskId: (() => {
			const taskId = requireNonEmptyString(value.taskId, "taskId");
			assertTaskId(taskId);
			return taskId;
		})(),
		sequence: value.sequence,
		baseHash: value.baseHash,
		spec: validateTaskSpecV1(value.spec),
		status: status as TaskStatus,
		createdAt: requireIso(value.createdAt, "createdAt"),
		...(value.startedAt === undefined ? {} : { startedAt: requireIso(value.startedAt, "startedAt") }),
		...(value.child === undefined ? {} : { child: validateTaskChildInfo(value.child) }),
		...(result === undefined ? {} : { result }),
	};
}
