import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ArtifactStore, type ArtifactWriteInput } from "./artifact-store.ts";
import {
	assertGoalId,
	GOAL_CHECKPOINT_SCHEMA,
	GOAL_CONTRACT_PROJECTION_SCHEMA,
	GOAL_EVENT_SCHEMA,
	type GoalActor,
	type GoalArtifactMetadata,
	type GoalCheckpoint,
	type GoalCheckpointedEvent,
	type GoalCheckpointV2,
	type GoalContract,
	type GoalContractProjection,
	type GoalContractUpdatedEvent,
	type GoalContractV2,
	type GoalCreatedEvent,
	type GoalEvent,
	type GoalHead,
	type GoalLifecycleEvent,
	type GoalLifecycleEventInput,
	type GoalLifecycleEventType,
	type GoalLifecycleProjection,
	type GoalReadModel,
	type GoalRunProjection,
	GoalValidationError,
	upcastGoalContract,
	validateGoalCheckpoint,
	validateGoalContract,
	validateGoalContractV2,
	validateGoalLifecycleEventForContract,
	validateGoalLifecycleEventInput,
} from "./contract.ts";
import {
	createGoalFiles,
	type GoalFilesDiagnostic,
	inspectGoalFiles as inspectGoalFileArtifacts,
	writeGoalObjectiveProjection,
} from "./goal-files.ts";
import {
	buildGoalReadModel,
	GoalReadModelStaleError,
	sameGoalReadModel,
	validateGoalReadModel,
} from "./goal-read-model.ts";
import { stableJsonStringify } from "./stable-json.ts";
import {
	type FileWriteLockOptions,
	inspectFileWriteLock,
	repairAbandonedFileWriteLock,
	type WriteLockDiagnostic,
	type WriteLockFailure,
	type WriteLockOwnerState,
	withFileWriteLock,
} from "./write-lock.ts";

export class GoalStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalStoreError";
	}
}

export class GoalNotFoundError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal not found: ${goalId}`);
		this.name = "GoalNotFoundError";
	}
}

export class GoalAlreadyExistsError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal already exists: ${goalId}`);
		this.name = "GoalAlreadyExistsError";
	}
}

export class GoalHeadConflictError extends GoalStoreError {
	constructor(expected: GoalHead, actual: GoalHead) {
		super(
			`Goal head conflict: expected ${expected.sequence}/${expected.hash}, got ${actual.sequence}/${actual.hash}`,
		);
		this.name = "GoalHeadConflictError";
	}
}

export class GoalIdempotencyConflictError extends GoalStoreError {
	constructor(idempotencyKey: string) {
		super(`Idempotency key was reused with different event content: ${idempotencyKey}`);
		this.name = "GoalIdempotencyConflictError";
	}
}

export class GoalRecoveryRequiredError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal recovery is required before writing: ${goalId}`);
		this.name = "GoalRecoveryRequiredError";
	}
}

export class GoalCorruptionError extends GoalStoreError {
	constructor(message: string) {
		super(message);
		this.name = "GoalCorruptionError";
	}
}

export class GoalLockedError extends GoalStoreError {
	constructor(goalId: string, operation = "writing") {
		super(`Goal is locked while ${operation}: ${goalId}`);
		this.name = "GoalLockedError";
	}
}

export class GoalLockRecoveryError extends GoalStoreError {
	constructor(goalId: string, message: string) {
		super(`Goal write-lock recovery failed for ${goalId}: ${message}`);
		this.name = "GoalLockRecoveryError";
	}
}

export class GoalLockRecoveryConflictError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal write-lock recovery conflicted with a different lock owner: ${goalId}`);
		this.name = "GoalLockRecoveryConflictError";
	}
}

export class GoalLifecycleTransitionError extends GoalStoreError {
	constructor(message: string) {
		super(`Goal lifecycle transition is invalid: ${message}`);
		this.name = "GoalLifecycleTransitionError";
	}
}

interface GoalPaths {
	goalDirectory: string;
	eventsPath: string;
	projectionPath: string;
	readModelProjectionPath: string;
	lockPath: string;
	recoveryLockPath: string;
}

export type GoalLockOwnerState = WriteLockOwnerState;

export type GoalWriteLockDiagnostic = WriteLockDiagnostic;

export interface GoalTailDiagnostic {
	discardedBytes: number;
}

export interface GoalReplay {
	goalId: string;
	/** The current contract projected into the v2 in-memory representation. */
	contract: GoalContractV2;
	/** The exact latest on-disk contract payload used to validate the event hash chain. */
	sourceContract: GoalContract;
	head: GoalHead;
	events: GoalEvent[];
	lifecycle: GoalLifecycleProjection;
	tailDiagnostic?: GoalTailDiagnostic;
}

export interface GoalReplayOptions {
	/** ISO timestamp used for open wall/active elapsed calculations. */
	now?: string;
}

export interface GoalMutationOptions {
	eventId: string;
	idempotencyKey: string;
	actor?: GoalActor;
	timestamp?: string;
}

export interface GoalContractUpdateOptions extends GoalMutationOptions {
	expectedHead: GoalHead;
}

export interface GoalWriteResult {
	event: GoalEvent;
	head: GoalHead;
}

interface EventInput {
	eventId: string;
	goalId: string;
	eventType: GoalEvent["eventType"];
	actor: GoalActor;
	timestamp: string;
	prevHash: string | null;
	payload: GoalEvent["payload"];
	sequence: number;
	idempotencyKey: string;
}

type GoalContractEventType = "goal_created" | "goal_contract_updated";

interface GoalEventHashInput {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: GoalEvent["eventType"];
	actor: GoalActor;
	timestamp: string;
	prevHash: string | null;
	payload: GoalEvent["payload"];
	schemaVersion: 1;
	idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function assertNonEmptyString(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new GoalValidationError(`${field} must be a non-empty string`);
	}
}

function assertIsoTimestamp(value: string, field: string): void {
	assertNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(value))) {
		throw new GoalValidationError(`${field} must be an ISO timestamp`);
	}
}

function assertActor(value: GoalActor): void {
	if (value !== "user" && value !== "runtime" && value !== "model" && value !== "child-task" && value !== "system") {
		throw new GoalValidationError("actor is invalid");
	}
}

function eventHashInput(event: GoalEventHashInput): string {
	return stableJsonStringify(event);
}

function calculateEventHash(event: GoalEventHashInput): string {
	return `sha256:${createHash("sha256").update(eventHashInput(event)).digest("hex")}`;
}

function getContractFromPayload(payload: GoalEvent["payload"]): GoalContract {
	if (!("contract" in payload)) {
		throw new GoalValidationError("Goal event requires a contract payload");
	}
	return payload.contract;
}

function getCheckpointFromPayload(payload: GoalEvent["payload"]): GoalCheckpoint {
	if (!("checkpoint" in payload)) {
		throw new GoalValidationError("Goal checkpoint event requires a checkpoint payload");
	}
	return payload.checkpoint;
}

function isGoalLifecycleEventType(eventType: GoalEvent["eventType"]): eventType is GoalLifecycleEventType {
	return (
		eventType === "goal_activated" ||
		eventType === "goal_paused" ||
		eventType === "goal_resumed" ||
		eventType === "goal_ended" ||
		eventType === "goal_run_started" ||
		eventType === "goal_run_settled" ||
		eventType === "goal_run_interrupted"
	);
}

function getLifecycleEventInput(
	eventType: GoalLifecycleEventType,
	payload: GoalEvent["payload"],
): GoalLifecycleEventInput {
	return validateGoalLifecycleEventInput({ eventType, payload });
}

function createLifecycleEvent(
	input: EventInput & { eventType: GoalLifecycleEventType; prevHash: string },
): GoalLifecycleEvent {
	const lifecycle = getLifecycleEventInput(input.eventType, input.payload);
	const eventWithoutHash: GoalEventHashInput = {
		schema: GOAL_EVENT_SCHEMA,
		eventId: input.eventId,
		goalId: input.goalId,
		sequence: input.sequence,
		eventType: lifecycle.eventType,
		actor: input.actor,
		timestamp: input.timestamp,
		prevHash: input.prevHash,
		payload: lifecycle.payload,
		schemaVersion: 1 as const,
		idempotencyKey: input.idempotencyKey,
	};
	return {
		...eventWithoutHash,
		hash: calculateEventHash(eventWithoutHash),
	} as GoalLifecycleEvent;
}

function createEvent(input: EventInput): GoalEvent {
	if (input.eventType === "goal_created") {
		if (input.prevHash !== null) {
			throw new GoalValidationError("Goal creation must not have a previous hash");
		}
		const eventWithoutHash: Omit<GoalCreatedEvent, "hash"> = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: input.eventId,
			goalId: input.goalId,
			sequence: input.sequence,
			eventType: "goal_created",
			actor: input.actor,
			timestamp: input.timestamp,
			prevHash: null,
			payload: { contract: getContractFromPayload(input.payload) },
			schemaVersion: 1,
			idempotencyKey: input.idempotencyKey,
		};
		return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
	}
	if (input.prevHash === null) {
		throw new GoalValidationError("Goal events after creation require a previous hash");
	}
	if (isGoalLifecycleEventType(input.eventType)) {
		return createLifecycleEvent({ ...input, eventType: input.eventType, prevHash: input.prevHash });
	}
	if (input.eventType === "goal_checkpointed") {
		const eventWithoutHash: Omit<GoalCheckpointedEvent, "hash"> = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: input.eventId,
			goalId: input.goalId,
			sequence: input.sequence,
			eventType: "goal_checkpointed",
			actor: input.actor,
			timestamp: input.timestamp,
			prevHash: input.prevHash,
			payload: { checkpoint: getCheckpointFromPayload(input.payload) },
			schemaVersion: 1,
			idempotencyKey: input.idempotencyKey,
		};
		return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
	}
	const eventWithoutHash: Omit<GoalContractUpdatedEvent, "hash"> = {
		schema: GOAL_EVENT_SCHEMA,
		eventId: input.eventId,
		goalId: input.goalId,
		sequence: input.sequence,
		eventType: "goal_contract_updated",
		actor: input.actor,
		timestamp: input.timestamp,
		prevHash: input.prevHash,
		payload: { contract: getContractFromPayload(input.payload) },
		schemaVersion: 1,
		idempotencyKey: input.idempotencyKey,
	};
	return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
}

function headForEvent(event: GoalEvent): GoalHead {
	return { sequence: event.sequence, hash: event.hash };
}

function hasSameIdempotentContent(existing: GoalEvent, proposed: GoalEvent): boolean {
	return (
		existing.goalId === proposed.goalId &&
		existing.eventType === proposed.eventType &&
		stableJsonStringify(existing.payload) === stableJsonStringify(proposed.payload)
	);
}

function parseGoalEvent(value: unknown, lineNumber: number): GoalEvent {
	if (!isRecord(value)) {
		throw new GoalCorruptionError(`Event ${lineNumber} is not an object`);
	}
	const requiredKeys = [
		"schema",
		"eventId",
		"goalId",
		"sequence",
		"eventType",
		"actor",
		"timestamp",
		"prevHash",
		"payload",
		"schemaVersion",
		"idempotencyKey",
		"hash",
	];
	const keys = Object.keys(value).sort();
	if (keys.length !== requiredKeys.length || keys.some((key, index) => key !== [...requiredKeys].sort()[index])) {
		throw new GoalCorruptionError(`Event ${lineNumber} has unknown or missing fields`);
	}
	if (value.schema !== GOAL_EVENT_SCHEMA || value.schemaVersion !== 1) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an unsupported schema`);
	}
	if (typeof value.eventId !== "string" || value.eventId.length === 0 || typeof value.goalId !== "string") {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid identifiers`);
	}
	try {
		assertGoalId(value.goalId);
	} catch {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid goalId`);
	}
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid sequence`);
	}
	if (
		typeof value.actor !== "string" ||
		typeof value.timestamp !== "string" ||
		typeof value.idempotencyKey !== "string"
	) {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid metadata`);
	}
	try {
		assertActor(value.actor as GoalActor);
		assertIsoTimestamp(value.timestamp, "timestamp");
		assertNonEmptyString(value.idempotencyKey, "idempotencyKey");
	} catch {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid metadata`);
	}
	if (value.prevHash !== null && typeof value.prevHash !== "string") {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid prevHash`);
	}
	if (typeof value.hash !== "string" || !value.hash.startsWith("sha256:")) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid hash`);
	}
	if (!isRecord(value.payload)) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid payload`);
	}
	let event: GoalEvent;
	if (value.eventType === "goal_created") {
		if (Object.keys(value.payload).length !== 1 || !("contract" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid create payload`);
		}
		if (value.prevHash !== null) {
			throw new GoalCorruptionError(`Event ${lineNumber} creation event has a previous hash`);
		}
		const createdEvent: GoalCreatedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_created",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { contract: validateGoalContract(value.payload.contract) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = createdEvent;
	} else if (value.eventType === "goal_contract_updated") {
		if (Object.keys(value.payload).length !== 1 || !("contract" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid update payload`);
		}
		if (typeof value.prevHash !== "string") {
			throw new GoalCorruptionError(`Event ${lineNumber} update event has no previous hash`);
		}
		const updatedEvent: GoalContractUpdatedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_contract_updated",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { contract: validateGoalContract(value.payload.contract) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = updatedEvent;
	} else if (value.eventType === "goal_checkpointed") {
		if (Object.keys(value.payload).length !== 1 || !("checkpoint" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid checkpoint payload`);
		}
		if (typeof value.prevHash !== "string") {
			throw new GoalCorruptionError(`Event ${lineNumber} checkpoint event has no previous hash`);
		}
		const checkpointedEvent: GoalCheckpointedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_checkpointed",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { checkpoint: validateGoalCheckpoint(value.payload.checkpoint) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = checkpointedEvent;
	} else if (
		value.eventType === "goal_activated" ||
		value.eventType === "goal_paused" ||
		value.eventType === "goal_resumed" ||
		value.eventType === "goal_ended" ||
		value.eventType === "goal_run_started" ||
		value.eventType === "goal_run_settled" ||
		value.eventType === "goal_run_interrupted"
	) {
		if (typeof value.prevHash !== "string") {
			throw new GoalCorruptionError(`Event ${lineNumber} lifecycle event has no previous hash`);
		}
		let lifecycle: GoalLifecycleEventInput;
		try {
			lifecycle = validateGoalLifecycleEventInput({ eventType: value.eventType, payload: value.payload });
		} catch {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid lifecycle payload`);
		}
		const lifecycleEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: lifecycle.eventType,
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: lifecycle.payload,
			schemaVersion: 1 as const,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		} as GoalLifecycleEvent;
		event = lifecycleEvent;
	} else {
		throw new GoalCorruptionError(`Event ${lineNumber} has an unsupported type`);
	}
	const { hash: _hash, ...withoutHash } = event;
	if (calculateEventHash(withoutHash) !== event.hash) {
		throw new GoalCorruptionError(`Event ${lineNumber} has a hash mismatch`);
	}
	return event;
}

function isGoalLifecycleEvent(event: GoalEvent): event is GoalLifecycleEvent {
	return isGoalLifecycleEventType(event.eventType);
}

function projectGoalLifecycle(events: readonly GoalEvent[], now: string): GoalLifecycleProjection {
	const nowMs = Date.parse(now);
	if (Number.isNaN(nowMs)) {
		throw new GoalValidationError("Goal replay now must be an ISO timestamp");
	}
	let status: GoalLifecycleProjection["status"] = "inactive";
	let activatedAt: string | undefined;
	let activatedAtMs: number | undefined;
	let pausedAt: string | undefined;
	let endedAt: string | undefined;
	let endedAtMs: number | undefined;
	let activeSinceMs: number | undefined;
	let activeElapsed = 0;
	let busyElapsed = 0;
	let lastLifecycleTimestamp = Number.NEGATIVE_INFINITY;
	const runs: GoalRunProjection[] = [];
	const runIds = new Set<string>();
	let openRun: { run: GoalRunProjection; startedAtMs: number } | undefined;
	let lastPause: GoalLifecycleProjection["lastPause"];
	let lastResume: GoalLifecycleProjection["lastResume"];
	let end: GoalLifecycleProjection["end"];

	for (const event of events) {
		if (!isGoalLifecycleEvent(event)) continue;
		const timestampMs = Date.parse(event.timestamp);
		if (timestampMs < lastLifecycleTimestamp) {
			throw new GoalLifecycleTransitionError("lifecycle timestamps must be non-decreasing");
		}
		lastLifecycleTimestamp = timestampMs;

		switch (event.eventType) {
			case "goal_activated":
				if (status !== "inactive") throw new GoalLifecycleTransitionError("activation requires an inactive Goal");
				status = "active";
				activatedAt = event.timestamp;
				activatedAtMs = timestampMs;
				activeSinceMs = timestampMs;
				break;
			case "goal_paused":
				if (status !== "active" || openRun) {
					throw new GoalLifecycleTransitionError("pause requires an active Goal with no running agent");
				}
				if (activeSinceMs === undefined) throw new GoalLifecycleTransitionError("active elapsed time is missing");
				activeElapsed += timestampMs - activeSinceMs;
				activeSinceMs = undefined;
				pausedAt = event.timestamp;
				status = "paused";
				lastPause = {
					actor: event.actor,
					reason: event.payload.reason ?? "",
					userRequest: event.payload.userRequest ?? null,
					nextBestAction: event.payload.nextBestAction ?? "",
					audit: event.payload.audit
						? {
								unmetRequiredAcceptanceIds: [...event.payload.audit.unmetRequiredAcceptanceIds],
								currentEvidence: event.payload.audit.currentEvidence,
								incompleteConclusion: event.payload.audit.incompleteConclusion,
							}
						: {
								unmetRequiredAcceptanceIds: [],
								currentEvidence: "Legacy pause event did not record current evidence.",
								incompleteConclusion: "Legacy pause event did not record an audit.",
							},
				};
				break;
			case "goal_resumed":
				if (status !== "paused") throw new GoalLifecycleTransitionError("resume requires a paused Goal");
				status = "active";
				pausedAt = undefined;
				activeSinceMs = timestampMs;
				lastResume = {
					actor: event.actor,
					reason: event.payload.reason ?? "Legacy resume event did not record a reason.",
					resumeEvidence: event.payload.resumeEvidence ?? "Legacy resume event did not record resume evidence.",
				};
				break;
			case "goal_ended":
				if ((status !== "active" && status !== "paused") || openRun) {
					throw new GoalLifecycleTransitionError("end requires an active or paused Goal with no running agent");
				}
				if (status === "active") {
					if (activeSinceMs === undefined)
						throw new GoalLifecycleTransitionError("active elapsed time is missing");
					activeElapsed += timestampMs - activeSinceMs;
					activeSinceMs = undefined;
				}
				status = "ended";
				endedAt = event.timestamp;
				endedAtMs = timestampMs;
				end = {
					actor: event.actor,
					outcome: event.payload.outcome,
					reason: event.payload.reason ?? "Legacy end event did not record a reason.",
					verifiedAcceptanceIds: [...(event.payload.verifiedAcceptanceIds ?? [])],
					finalEvidence: event.payload.finalEvidence ?? "Legacy end event did not record final evidence.",
					finalSummary: event.payload.finalSummary ?? "Legacy end event did not record a final summary.",
				};
				break;
			case "goal_run_started": {
				if (status !== "active" || openRun) {
					throw new GoalLifecycleTransitionError("run start requires an active Goal with no running agent");
				}
				if (runIds.has(event.payload.runId)) {
					throw new GoalLifecycleTransitionError("run IDs must be unique within a Goal");
				}
				const run: GoalRunProjection = {
					runId: event.payload.runId,
					sessionId: event.payload.sessionId,
					startedAt: event.timestamp,
					status: "interrupted",
				};
				runs.push(run);
				runIds.add(run.runId);
				openRun = { run, startedAtMs: timestampMs };
				break;
			}
			case "goal_run_settled":
				if (status !== "active" || !openRun || openRun.run.runId !== event.payload.runId) {
					throw new GoalLifecycleTransitionError("run settlement must match the active run");
				}
				openRun.run.status = "settled";
				openRun.run.endedAt = event.timestamp;
				busyElapsed += timestampMs - openRun.startedAtMs;
				openRun = undefined;
				break;
			case "goal_run_interrupted":
				if (status !== "active" || !openRun || openRun.run.runId !== event.payload.runId) {
					throw new GoalLifecycleTransitionError("run interruption must match the active run");
				}
				openRun.run.status = "interrupted";
				openRun.run.endedAt = event.timestamp;
				if (!event.payload.recovered) {
					busyElapsed += timestampMs - openRun.startedAtMs;
				}
				openRun = undefined;
				break;
		}
	}

	const effectiveNow = Math.max(nowMs, lastLifecycleTimestamp);
	if (status === "active" && activeSinceMs !== undefined) {
		activeElapsed += effectiveNow - activeSinceMs;
	}
	const wallEndMs = endedAtMs ?? effectiveNow;
	return {
		status,
		...(activatedAt === undefined ? {} : { activatedAt }),
		...(pausedAt === undefined ? {} : { pausedAt }),
		...(endedAt === undefined ? {} : { endedAt }),
		wallElapsed: activatedAtMs === undefined ? 0 : wallEndMs - activatedAtMs,
		activeElapsed,
		busyElapsed,
		runs,
		...(openRun ? { openRunId: openRun.run.runId } : {}),
		...(lastPause === undefined ? {} : { lastPause }),
		...(lastResume === undefined ? {} : { lastResume }),
		...(end === undefined ? {} : { end }),
	};
}

function replayEvents(goalId: string, raw: string, now = new Date().toISOString()): GoalReplay {
	const lastNewline = raw.lastIndexOf("\n");
	const completeContent = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
	const trailingContent = raw.slice(lastNewline + 1);
	const lines = completeContent.length === 0 ? [] : completeContent.slice(0, -1).split("\n");
	if (lines.length === 0) {
		throw new GoalCorruptionError(`Goal has no complete events: ${goalId}`);
	}
	const events = lines.map((line, index) => {
		try {
			return parseGoalEvent(JSON.parse(line) as unknown, index + 1);
		} catch (error) {
			if (error instanceof GoalCorruptionError) throw error;
			if (error instanceof GoalValidationError) {
				throw new GoalCorruptionError(`Event ${index + 1} has an invalid contract`);
			}
			throw new GoalCorruptionError(`Event ${index + 1} is not valid JSON`);
		}
	});
	let sourceContract: GoalContract | undefined;
	let previousHash: string | null = null;
	const eventIds = new Set<string>();
	const idempotencyKeys = new Set<string>();
	for (const [index, event] of events.entries()) {
		if (event.goalId !== goalId) {
			throw new GoalCorruptionError(`Event ${index + 1} belongs to a different Goal`);
		}
		if (event.sequence !== index + 1 || event.prevHash !== previousHash) {
			throw new GoalCorruptionError(`Event ${index + 1} breaks the Goal hash chain`);
		}
		if (eventIds.has(event.eventId) || idempotencyKeys.has(event.idempotencyKey)) {
			throw new GoalCorruptionError(`Event ${index + 1} duplicates a stable identifier`);
		}
		eventIds.add(event.eventId);
		idempotencyKeys.add(event.idempotencyKey);
		if (index === 0 && event.eventType !== "goal_created") {
			throw new GoalCorruptionError("The first Goal event must be goal_created");
		}
		if (
			index > 0 &&
			event.eventType !== "goal_contract_updated" &&
			event.eventType !== "goal_checkpointed" &&
			!isGoalLifecycleEventType(event.eventType)
		) {
			throw new GoalCorruptionError(`Event ${index + 1} is invalid after Goal creation`);
		}
		if (event.eventType === "goal_created" || event.eventType === "goal_contract_updated") {
			const nextContract = event.payload.contract;
			if (nextContract.goalId !== goalId) {
				throw new GoalCorruptionError(`Event ${index + 1} contract has a different Goal ID`);
			}
			if (sourceContract && nextContract.createdAt !== sourceContract.createdAt) {
				throw new GoalCorruptionError(`Event ${index + 1} changes the Goal creation timestamp`);
			}
			sourceContract = nextContract;
		}
		if (isGoalLifecycleEvent(event)) {
			if (!sourceContract) {
				throw new GoalCorruptionError(`Event ${index + 1} has no preceding Goal contract`);
			}
			try {
				validateGoalLifecycleEventForContract(
					{ eventType: event.eventType, payload: event.payload },
					sourceContract,
					event.actor,
				);
			} catch (error) {
				if (error instanceof GoalValidationError) {
					throw new GoalCorruptionError(`Event ${index + 1} violates its Goal contract`);
				}
				throw error;
			}
		}
		previousHash = event.hash;
	}
	const lastEvent = events.at(-1);
	if (!sourceContract || !lastEvent) {
		throw new GoalCorruptionError(`Goal replay failed: ${goalId}`);
	}
	let lifecycle: GoalLifecycleProjection;
	try {
		lifecycle = projectGoalLifecycle(events, now);
	} catch (error) {
		if (error instanceof GoalLifecycleTransitionError) {
			throw new GoalCorruptionError(`Goal lifecycle is invalid: ${error.message}`);
		}
		throw error;
	}
	return {
		goalId,
		contract: upcastGoalContract(sourceContract),
		sourceContract,
		head: headForEvent(lastEvent),
		events,
		lifecycle,
		...(trailingContent.length > 0 ? { tailDiagnostic: { discardedBytes: Buffer.byteLength(trailingContent) } } : {}),
	};
}

export class GoalStore {
	private readonly goalsDirectory: string;
	private readonly artifactStore: ArtifactStore;

	constructor(projectRoot: string) {
		const resolvedProjectRoot = resolve(projectRoot);
		this.goalsDirectory = join(resolvedProjectRoot, ".pi-xk", "goals");
		this.artifactStore = new ArtifactStore(resolvedProjectRoot);
	}

	private paths(goalId: string): GoalPaths {
		assertGoalId(goalId);
		const goalDirectory = join(this.goalsDirectory, goalId);
		if (basename(goalDirectory) !== goalId) {
			throw new GoalValidationError("goalId resolves outside the Goal directory");
		}
		return {
			goalDirectory,
			eventsPath: join(goalDirectory, "events.jsonl"),
			projectionPath: join(goalDirectory, "contract.json"),
			readModelProjectionPath: join(goalDirectory, "goal-read-model.json"),
			lockPath: join(goalDirectory, ".write.lock"),
			recoveryLockPath: join(goalDirectory, ".write.recovery.lock"),
		};
	}

	private async readReplay(paths: GoalPaths, goalId: string, options: GoalReplayOptions = {}): Promise<GoalReplay> {
		let raw: string;
		try {
			raw = await readFile(paths.eventsPath, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new GoalNotFoundError(goalId);
			throw error;
		}
		return replayEvents(goalId, raw, options.now);
	}

	private lockOptions(paths: GoalPaths, goalId: string): FileWriteLockOptions {
		return {
			directory: paths.goalDirectory,
			lockPath: paths.lockPath,
			recoveryLockPath: paths.recoveryLockPath,
			error: (failure: WriteLockFailure) => {
				if (failure.kind === "locked") return new GoalLockedError(goalId);
				if (failure.kind === "recovery-locked") return new GoalLockedError(goalId, "recovering its write lock");
				if (failure.kind === "conflict") return new GoalLockRecoveryConflictError(goalId);
				if (failure.kind === "malformed") {
					return new GoalLockRecoveryError(goalId, "the lock metadata is malformed");
				}
				return new GoalLockRecoveryError(goalId, `the owner is ${failure.ownerState}`);
			},
		};
	}

	private async withGoalLock<TResult>(
		paths: GoalPaths,
		goalId: string,
		action: () => Promise<TResult>,
	): Promise<TResult> {
		return await withFileWriteLock(this.lockOptions(paths, goalId), action);
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async appendEvent(paths: GoalPaths, event: GoalEvent): Promise<void> {
		const handle = await open(paths.eventsPath, "a", 0o600);
		try {
			await handle.writeFile(`${stableJsonStringify(event)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async writeProjection(paths: GoalPaths, replay: GoalReplay): Promise<void> {
		const projection: GoalContractProjection = {
			schema: GOAL_CONTRACT_PROJECTION_SCHEMA,
			goalId: replay.goalId,
			sequence: replay.head.sequence,
			baseHash: replay.head.hash,
			contract: replay.contract,
		};
		const temporaryPath = join(paths.goalDirectory, `.contract-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(projection, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, paths.projectionPath);
			await this.syncDirectory(paths.goalDirectory);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private async writeGoalReadModel(paths: GoalPaths, replay: GoalReplay): Promise<GoalReadModel> {
		const readModel = await buildGoalReadModel(replay, this.artifactStore);
		const temporaryPath = join(paths.goalDirectory, `.read-model-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(readModel, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, paths.readModelProjectionPath);
			await this.syncDirectory(paths.goalDirectory);
		} finally {
			await rm(temporaryPath, { force: true });
		}
		return readModel;
	}

	private async writeDerivedProjections(paths: GoalPaths, replay: GoalReplay): Promise<void> {
		await this.writeProjection(paths, replay);
		await this.writeGoalReadModel(paths, replay);
	}

	private async assertCheckpointArtifacts(checkpoint: GoalCheckpointV2): Promise<void> {
		for (const artifact of checkpoint.evidence.artifacts) {
			await this.artifactStore.read(artifact.artifactId);
		}
	}

	private async replaceEvents(paths: GoalPaths, content: string): Promise<void> {
		const temporaryPath = join(paths.goalDirectory, `.events-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, paths.eventsPath);
			await this.syncDirectory(paths.goalDirectory);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private async removeInitialGoalFiles(paths: GoalPaths): Promise<void> {
		await Promise.all([
			rm(join(paths.goalDirectory, "goal-objective.md"), { force: true }),
			rm(join(paths.goalDirectory, "goal-state.md"), { force: true }),
		]);
	}

	private buildEvent(
		contract: GoalContractV2,
		eventType: GoalContractEventType,
		options: GoalMutationOptions,
		sequence: number,
		prevHash: string | null,
	): GoalEvent {
		assertNonEmptyString(options.eventId, "eventId");
		assertNonEmptyString(options.idempotencyKey, "idempotencyKey");
		const actor = options.actor ?? "runtime";
		assertActor(actor);
		const timestamp = options.timestamp ?? new Date().toISOString();
		assertIsoTimestamp(timestamp, "timestamp");
		return createEvent({
			eventId: options.eventId,
			goalId: contract.goalId,
			eventType,
			actor,
			timestamp,
			prevHash,
			payload: { contract },
			sequence,
			idempotencyKey: options.idempotencyKey,
		});
	}

	private buildCheckpointEvent(
		goalId: string,
		checkpoint: GoalCheckpoint,
		options: GoalMutationOptions,
		sequence: number,
		prevHash: string,
	): GoalEvent {
		assertNonEmptyString(options.eventId, "eventId");
		assertNonEmptyString(options.idempotencyKey, "idempotencyKey");
		const actor = options.actor ?? "runtime";
		assertActor(actor);
		const timestamp = options.timestamp ?? checkpoint.createdAt;
		assertIsoTimestamp(timestamp, "timestamp");
		return createEvent({
			eventId: options.eventId,
			goalId,
			eventType: "goal_checkpointed",
			actor,
			timestamp,
			prevHash,
			payload: { checkpoint },
			sequence,
			idempotencyKey: options.idempotencyKey,
		});
	}

	private buildLifecycleEvent(
		goalId: string,
		input: GoalLifecycleEventInput,
		options: GoalMutationOptions,
		sequence: number,
		prevHash: string,
	): GoalEvent {
		assertNonEmptyString(options.eventId, "eventId");
		assertNonEmptyString(options.idempotencyKey, "idempotencyKey");
		const actor = options.actor ?? "runtime";
		assertActor(actor);
		const timestamp = options.timestamp ?? new Date().toISOString();
		assertIsoTimestamp(timestamp, "timestamp");
		return createEvent({
			eventId: options.eventId,
			goalId,
			eventType: input.eventType,
			actor,
			timestamp,
			prevHash,
			payload: input.payload,
			sequence,
			idempotencyKey: options.idempotencyKey,
		});
	}

	private ensureRetryMatches(replay: GoalReplay, event: GoalEvent): GoalWriteResult | undefined {
		const existing = replay.events.find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
		if (!existing) return undefined;
		if (!hasSameIdempotentContent(existing, event)) {
			throw new GoalIdempotencyConflictError(event.idempotencyKey);
		}
		return { event: existing, head: headForEvent(existing) };
	}

	async createGoal(contractInput: GoalContractV2, options: GoalMutationOptions): Promise<GoalWriteResult> {
		const contract = validateGoalContractV2(contractInput);
		const paths = this.paths(contract.goalId);
		return await this.withGoalLock(paths, contract.goalId, async () => {
			let existing: GoalReplay | undefined;
			try {
				existing = await this.readReplay(paths, contract.goalId);
			} catch (error) {
				if (!(error instanceof GoalNotFoundError)) throw error;
			}
			const event = this.buildEvent(contract, "goal_created", options, 1, null);
			if (existing) {
				if (existing.tailDiagnostic) throw new GoalRecoveryRequiredError(contract.goalId);
				const retry = this.ensureRetryMatches(existing, event);
				if (retry) {
					await writeGoalObjectiveProjection(paths.goalDirectory, existing.contract);
					await this.writeDerivedProjections(paths, existing);
					return retry;
				}
				throw new GoalAlreadyExistsError(contract.goalId);
			}
			await createGoalFiles(paths.goalDirectory, contract);
			try {
				await this.replaceEvents(paths, `${stableJsonStringify(event)}\n`);
			} catch (error) {
				// A rename can succeed while directory sync reports an error. Preserve a
				// valid event in that case; otherwise remove files created by this attempt
				// so the same idempotency key can be retried cleanly.
				let eventPublished = false;
				try {
					const recovered = await this.readReplay(paths, contract.goalId);
					eventPublished =
						recovered.events.length === 1 && this.ensureRetryMatches(recovered, event) !== undefined;
				} catch {
					eventPublished = false;
				}
				if (!eventPublished) await this.removeInitialGoalFiles(paths);
				throw error;
			}
			const replay: GoalReplay = {
				goalId: contract.goalId,
				contract,
				sourceContract: contract,
				head: headForEvent(event),
				events: [event],
				lifecycle: projectGoalLifecycle([event], options.timestamp ?? new Date().toISOString()),
			};
			await this.writeDerivedProjections(paths, replay);
			return { event, head: replay.head };
		});
	}

	async loadGoal(goalId: string): Promise<GoalReplay> {
		return await this.replayGoal(goalId);
	}

	async replayGoal(goalId: string, options: GoalReplayOptions = {}): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.readReplay(paths, goalId, options);
	}

	async putArtifact(input: ArtifactWriteInput): Promise<GoalArtifactMetadata> {
		return await this.artifactStore.put(input);
	}

	async loadGoalReadModel(goalId: string): Promise<GoalReadModel> {
		const paths = this.paths(goalId);
		const replay = await this.readReplay(paths, goalId);
		if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
		let stored: GoalReadModel;
		try {
			stored = validateGoalReadModel(JSON.parse(await readFile(paths.readModelProjectionPath, "utf8")) as unknown);
		} catch {
			throw new GoalReadModelStaleError(goalId);
		}
		if (
			stored.goalId !== replay.goalId ||
			stored.sequence !== replay.head.sequence ||
			stored.baseHash !== replay.head.hash
		) {
			throw new GoalReadModelStaleError(goalId);
		}
		const rebuilt = await buildGoalReadModel(replay, this.artifactStore);
		if (!sameGoalReadModel(stored, rebuilt)) {
			throw new GoalReadModelStaleError(goalId);
		}
		return stored;
	}

	async rebuildGoalReadModel(goalId: string): Promise<GoalReadModel> {
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			return await this.writeGoalReadModel(paths, replay);
		});
	}

	async inspectWriteLock(goalId: string): Promise<GoalWriteLockDiagnostic | undefined> {
		const paths = this.paths(goalId);
		return await inspectFileWriteLock(paths.lockPath);
	}

	async repairAbandonedWriteLock(goalId: string, expectedNonce: string): Promise<boolean> {
		assertGoalId(goalId);
		assertNonEmptyString(expectedNonce, "expectedNonce");
		const paths = this.paths(goalId);
		return await repairAbandonedFileWriteLock(this.lockOptions(paths, goalId), expectedNonce);
	}

	async updateGoalContract(
		contractInput: GoalContractV2,
		options: GoalContractUpdateOptions,
	): Promise<GoalWriteResult> {
		const contract = validateGoalContractV2(contractInput);
		const paths = this.paths(contract.goalId);
		return await this.withGoalLock(paths, contract.goalId, async () => {
			const replay = await this.readReplay(paths, contract.goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(contract.goalId);
			const event = this.buildEvent(
				contract,
				"goal_contract_updated",
				options,
				replay.head.sequence + 1,
				replay.head.hash,
			);
			const retry = this.ensureRetryMatches(replay, event);
			if (retry) return retry;
			if (options.expectedHead.sequence !== replay.head.sequence || options.expectedHead.hash !== replay.head.hash) {
				throw new GoalHeadConflictError(options.expectedHead, replay.head);
			}
			if (contract.createdAt !== replay.contract.createdAt) {
				throw new GoalValidationError("Goal updates cannot change createdAt");
			}
			if (contract.ownerSessionId !== replay.contract.ownerSessionId) {
				throw new GoalValidationError("Goal updates cannot change ownerSessionId");
			}
			if (replay.lifecycle.status === "ended") {
				throw new GoalValidationError("ended Goal contracts cannot be updated");
			}
			await this.appendEvent(paths, event);
			const nextReplay: GoalReplay = {
				goalId: contract.goalId,
				contract,
				sourceContract: contract,
				head: headForEvent(event),
				events: [...replay.events, event],
				lifecycle: projectGoalLifecycle([...replay.events, event], options.timestamp ?? new Date().toISOString()),
			};
			await writeGoalObjectiveProjection(paths.goalDirectory, contract);
			await this.writeDerivedProjections(paths, nextReplay);
			return { event, head: nextReplay.head };
		});
	}

	async appendCheckpoint(
		goalId: string,
		checkpointInput: GoalCheckpointV2,
		options: GoalContractUpdateOptions,
	): Promise<GoalWriteResult> {
		assertGoalId(goalId);
		const validatedCheckpoint = validateGoalCheckpoint(checkpointInput);
		if (validatedCheckpoint.schema !== GOAL_CHECKPOINT_SCHEMA) {
			throw new GoalValidationError("Goal checkpoint writers must use checkpoint v2");
		}
		const checkpoint = validatedCheckpoint;
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			const event = this.buildCheckpointEvent(
				goalId,
				checkpoint,
				options,
				replay.head.sequence + 1,
				replay.head.hash,
			);
			const retry = this.ensureRetryMatches(replay, event);
			if (retry) return retry;
			if (options.expectedHead.sequence !== replay.head.sequence || options.expectedHead.hash !== replay.head.hash) {
				throw new GoalHeadConflictError(options.expectedHead, replay.head);
			}
			await this.assertCheckpointArtifacts(checkpoint);
			await this.appendEvent(paths, event);
			const nextReplay: GoalReplay = {
				goalId,
				contract: replay.contract,
				sourceContract: replay.sourceContract,
				head: headForEvent(event),
				events: [...replay.events, event],
				lifecycle: projectGoalLifecycle([...replay.events, event], options.timestamp ?? new Date().toISOString()),
			};
			await this.writeDerivedProjections(paths, nextReplay);
			return { event, head: nextReplay.head };
		});
	}

	async appendLifecycleEvent(
		goalId: string,
		input: GoalLifecycleEventInput,
		options: GoalContractUpdateOptions,
	): Promise<GoalWriteResult> {
		assertGoalId(goalId);
		const lifecycleInput = validateGoalLifecycleEventInput(input);
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			const contractLifecycleInput = validateGoalLifecycleEventForContract(
				lifecycleInput,
				replay.sourceContract,
				options.actor ?? "runtime",
			);
			const event = this.buildLifecycleEvent(
				goalId,
				contractLifecycleInput,
				options,
				replay.head.sequence + 1,
				replay.head.hash,
			);
			const retry = this.ensureRetryMatches(replay, event);
			if (retry) return retry;
			if (options.expectedHead.sequence !== replay.head.sequence || options.expectedHead.hash !== replay.head.hash) {
				throw new GoalHeadConflictError(options.expectedHead, replay.head);
			}
			const events = [...replay.events, event];
			const lifecycle = projectGoalLifecycle(events, options.timestamp ?? new Date().toISOString());
			await this.appendEvent(paths, event);
			const nextReplay: GoalReplay = {
				goalId,
				contract: replay.contract,
				sourceContract: replay.sourceContract,
				head: headForEvent(event),
				events,
				lifecycle,
			};
			await this.writeDerivedProjections(paths, nextReplay);
			return { event, head: nextReplay.head };
		});
	}

	async inspectGoalFiles(goalId: string): Promise<GoalFilesDiagnostic> {
		const replay = await this.replayGoal(goalId);
		return await inspectGoalFileArtifacts(this.paths(goalId).goalDirectory, replay.contract);
	}

	async rebuildContractProjection(goalId: string): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			await writeGoalObjectiveProjection(paths.goalDirectory, replay.contract);
			await this.writeProjection(paths, replay);
			return replay;
		});
	}

	async repairTrailingPartialEvent(goalId: string): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const raw = await readFile(paths.eventsPath, "utf8");
			const replay = replayEvents(goalId, raw);
			if (!replay.tailDiagnostic) return replay;
			const validContent = raw.slice(0, raw.lastIndexOf("\n") + 1);
			await this.replaceEvents(paths, validContent);
			const repaired = await this.readReplay(paths, goalId);
			await this.writeDerivedProjections(paths, repaired);
			return repaired;
		});
	}
}
