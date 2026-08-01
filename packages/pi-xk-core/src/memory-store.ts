import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { ArtifactNotFoundError, ArtifactStore, validateArtifactMetadata } from "./artifact-store.ts";
import {
	type CueNodeV1,
	type EvidenceRefV1,
	MEMORY_CAPTURE_SOURCE_SCHEMA,
	MEMORY_CHANGE_PROPOSAL_SCHEMA,
	MEMORY_CUE_SCHEMA,
	MEMORY_EDGE_SCHEMA,
	MEMORY_EVENT_SCHEMA,
	MEMORY_READ_MODEL_SCHEMA,
	MEMORY_REVISION_SCHEMA,
	type MemoryAccessEventV1,
	type MemoryActor,
	type MemoryCaptureSourceV1,
	type MemoryCaptureTrigger,
	type MemoryChangeProposalV1,
	type MemoryEdgeRelation,
	type MemoryEdgeV1,
	type MemoryGraphEndpointV1,
	type MemoryHead,
	type MemoryLifecycle,
	type MemoryRevisionV1,
	type MemoryStateV1,
	MemoryValidationError,
	validateCueNodeV1,
	validateMemoryCaptureSourceV1,
	validateMemoryChangeProposalV1,
	validateMemoryEdgeV1,
	validateMemoryRevisionV1,
} from "./memory-contract.ts";
import { resolveGitFreshness } from "./memory-freshness.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";
import {
	type FileWriteLockOptions,
	inspectFileWriteLock,
	repairAbandonedFileWriteLock,
	type WriteLockDiagnostic,
	type WriteLockFailure,
	withFileWriteLock,
} from "./write-lock.ts";

export type MemoryEventType =
	| "capture_scheduled"
	| "generation_started"
	| "capture_failed"
	| "proposal_recorded"
	| "memory_change_applied"
	| "proposal_rejected"
	| "memory_lifecycle_changed"
	| "evidence_detached"
	| "memory_purged"
	| "access_recorded";

export interface CaptureScheduledPayloadV1 {
	captureId: string;
	sourceArtifactId: string;
	sourceDigest: string;
	trigger: MemoryCaptureTrigger;
	promptVersion: string;
}

export interface GenerationStartedPayloadV1 {
	captureId: string;
	attempt: number;
}

export interface CaptureFailedPayloadV1 {
	captureId: string;
	stage: "source" | "generation" | "validation" | "artifact" | "publication" | "projection";
	errorCode: string;
	retryable: boolean;
	message: string;
}

export interface ProposalRecordedPayloadV1 {
	captureId: string | null;
	proposalId: string;
	proposalArtifactId: string;
	resultArtifactId: string;
	confirmationRequired: boolean;
}

export interface MemoryChangeAppliedPayloadV1 {
	proposalId: string;
	proposalArtifactId: string;
	revisions: PublishedMemoryRevisionRefV1[];
	cues: PublishedCueRefV1[];
	edges: PublishedEdgeRefV1[];
}

export interface PublishedMemoryRevisionRefV1 {
	memoryId: string;
	revision: number;
	artifactId: string;
	trust: "verified" | "model_inferred" | "disputed";
	lifecycle: MemoryLifecycle;
	sourceDigest: string;
	evidenceIds: string[];
}

export interface PublishedCueRefV1 {
	cueId: string;
	revision: number;
	artifactId: string;
	key: string;
}

export interface PublishedEdgeRefV1 {
	edgeId: string;
	artifactId: string;
	from: MemoryGraphEndpointV1;
	to: MemoryGraphEndpointV1;
	relation: MemoryEdgeRelation;
}

export interface ProposalRejectedPayloadV1 {
	proposalId: string;
	reason: string;
}

export interface MemoryLifecycleChangedPayloadV1 {
	memoryId: string;
	fromRevision: number;
	toRevision: number;
	lifecycle: "active" | "superseded" | "invalidated" | "archived";
	reason: string;
	revisionArtifactId: string;
}

export interface EvidenceDetachedPayloadV1 {
	memoryId: string;
	fromRevision: number;
	toRevision: number;
	evidenceId: string;
	reason: string;
	revisionArtifactId: string;
}

export interface MemoryPurgedPayloadV1 {
	memoryId: string;
	revisionArtifactIds: string[];
	sourceDigest: string;
}

export interface AccessRecordedPayloadV1 {
	runId: string;
	memoryIds: string[];
	evidenceIds: string[];
}

export type MemoryEventPayloadV1 =
	| CaptureScheduledPayloadV1
	| GenerationStartedPayloadV1
	| CaptureFailedPayloadV1
	| ProposalRecordedPayloadV1
	| MemoryChangeAppliedPayloadV1
	| ProposalRejectedPayloadV1
	| MemoryLifecycleChangedPayloadV1
	| EvidenceDetachedPayloadV1
	| MemoryPurgedPayloadV1
	| AccessRecordedPayloadV1;

export interface MemoryEventPayloadMapV1 {
	capture_scheduled: CaptureScheduledPayloadV1;
	generation_started: GenerationStartedPayloadV1;
	capture_failed: CaptureFailedPayloadV1;
	proposal_recorded: ProposalRecordedPayloadV1;
	memory_change_applied: MemoryChangeAppliedPayloadV1;
	proposal_rejected: ProposalRejectedPayloadV1;
	memory_lifecycle_changed: MemoryLifecycleChangedPayloadV1;
	evidence_detached: EvidenceDetachedPayloadV1;
	memory_purged: MemoryPurgedPayloadV1;
	access_recorded: AccessRecordedPayloadV1;
}

interface MemoryEventBaseV1 {
	schema: typeof MEMORY_EVENT_SCHEMA;
	eventId: string;
	sequence: number;
	actor: MemoryActor;
	timestamp: string;
	prevHash: string | null;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export type MemoryEventV1 = {
	[TEventType in MemoryEventType]: MemoryEventBaseV1 & {
		eventType: TEventType;
		payload: MemoryEventPayloadMapV1[TEventType];
	};
}[MemoryEventType];

type EventWithoutHash = {
	[TEventType in MemoryEventType]: Omit<Extract<MemoryEventV1, { eventType: TEventType }>, "hash">;
}[MemoryEventType];

interface HashableMemoryEventV1 extends Omit<MemoryEventBaseV1, "hash"> {
	eventType: MemoryEventType;
	payload: MemoryEventPayloadV1;
}

export type MemoryCaptureStatus = "scheduled" | "generating" | "failed" | "proposed" | "applied" | "rejected";

export interface MemoryCaptureProjectionV1 {
	captureId: string;
	status: MemoryCaptureStatus;
	sourceArtifactId: string;
	sourceDigest: string;
	trigger: MemoryCaptureTrigger;
	promptVersion: string;
	attempt: number | null;
	proposalId: string | null;
	errorCode: string | null;
	retryable: boolean | null;
}

export interface MemoryReplay {
	head: MemoryHead;
	events: MemoryEventV1[];
	captures: Map<string, MemoryCaptureProjectionV1>;
	memories: Map<string, PublishedMemoryRevisionRefV1>;
	cues: Map<string, PublishedCueRefV1>;
	edges: Map<string, PublishedEdgeRefV1>;
	proposals: Map<string, ProposalRecordedPayloadV1>;
	purgedSourceDigests: Set<string>;
	tailDiagnostic?: MemoryTailDiagnostic;
}

export interface MemoryAccessProjectionV1 {
	memoryId: string;
	accessCount: number;
	lastAccessedAt: string;
}

export interface MemoryReadResultV1 {
	revision: MemoryRevisionV1;
	artifactId: string;
	state: MemoryStateV1;
}

export interface MemoryTimelineEntryV1 extends MemoryReadResultV1 {}

export interface MemoryProposalRecordResultV1 {
	write: MemoryWriteResult<"proposal_recorded">;
	proposal: MemoryChangeProposalV1;
	proposalArtifactId: string;
}

export interface MemoryApplyResultV1 {
	write: MemoryWriteResult<"memory_change_applied">;
	revisions: MemoryRevisionV1[];
	cues: CueNodeV1[];
}

export interface MemoryPurgeCleanupDiagnosticV1 {
	artifactId: string;
	errorCode: string;
	message: string;
}

export interface MemoryPurgeResultV1 {
	write: MemoryWriteResult<"memory_purged">;
	removedArtifactIds: string[];
	retainedArtifactIds: string[];
	cleanupDiagnostics: MemoryPurgeCleanupDiagnosticV1[];
}

export interface MemoryReadModelV1 {
	schema: typeof MEMORY_READ_MODEL_SCHEMA;
	head: MemoryHead;
	eventCount: number;
	captures: MemoryCaptureProjectionV1[];
	memories: PublishedMemoryRevisionRefV1[];
	cues: PublishedCueRefV1[];
	edges: PublishedEdgeRefV1[];
	proposals: ProposalRecordedPayloadV1[];
	resolvedProposalIds: string[];
	purgedSourceDigests: string[];
	accessRunIds: string[];
	accesses: MemoryAccessProjectionV1[];
	counts: {
		scheduled: number;
		generating: number;
		failed: number;
		proposed: number;
		applied: number;
		rejected: number;
	};
}

export interface MemoryTailDiagnostic {
	discardedBytes: number;
}

export interface MemoryReadModelLoadDiagnostic {
	mode: "fast" | "tail" | "full";
	bytesRead: number;
	fallbackReason?: "projection-missing-or-invalid" | "event-log-shortened" | "checkpoint-mismatch";
}

export interface MemoryReadModelLoadResult {
	readModel: MemoryReadModelV1;
	diagnostic: MemoryReadModelLoadDiagnostic;
}

export interface MemoryReadModelInspection {
	state: "absent" | "current" | "stale" | "invalid" | "event-log-shortened";
	readModel: MemoryReadModelV1 | null;
	diagnostic: MemoryReadModelLoadDiagnostic | null;
	eventLogBytes: number;
	readModelExists: boolean;
	checkpointExists: boolean;
}

export interface MemoryMutationOptions {
	eventId: string;
	idempotencyKey: string;
	expectedHead: MemoryHead;
	actor?: MemoryActor;
	timestamp?: string;
}

export interface MemoryApplyOptions extends MemoryMutationOptions {
	confirmed?: boolean;
}

export interface MemoryWriteResult<TEventType extends MemoryEventType = MemoryEventType> {
	event: Extract<MemoryEventV1, { eventType: TEventType }>;
	head: MemoryHead;
}

interface MemoryPaths {
	memoryDirectory: string;
	locksDirectory: string;
	eventsPath: string;
	readModelPath: string;
	readModelCheckpointPath: string;
	lockPath: string;
	recoveryLockPath: string;
}

interface MemoryReadModelCheckpointV1 {
	schema: "pi-xk.memory-read-model-checkpoint.v1";
	headEventOffset: number;
	byteOffset: number;
	sequence: number;
	headHash: string;
	readModelDigest: string;
	idempotencyKeys: string[];
}

export interface MemoryStoreOptions {
	/** Test and benchmark observer for verified full event-log replay. */
	onFullReplay?: () => void;
	/** Test-only Artifact Store injection for post-tombstone cleanup failures. */
	artifactStore?: ArtifactStore;
}

export interface MemoryDeepInspectionV1 {
	replay: MemoryReplay;
	referencedArtifactIds: string[];
	evidenceRefs: EvidenceRefV1[];
	orphanArtifactIds: string[];
	purgedArtifactIdsPresent: string[];
	purgedArtifactIdsMissing: string[];
}

interface MemoryFactProjection {
	memories: Map<string, PublishedMemoryRevisionRefV1>;
	cues: Map<string, PublishedCueRefV1>;
	edges: Map<string, PublishedEdgeRefV1>;
}

export type MemoryWriteLockDiagnostic = WriteLockDiagnostic;

export class MemoryStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryStoreError";
	}
}

export class MemoryHeadConflictError extends MemoryStoreError {
	constructor(expected: MemoryHead, actual: MemoryHead) {
		super(
			`Memory head conflict: expected ${expected.sequence}/${expected.hash}, got ${actual.sequence}/${actual.hash}`,
		);
		this.name = "MemoryHeadConflictError";
	}
}

export class MemoryIdempotencyConflictError extends MemoryStoreError {
	constructor(key: string) {
		super(`Idempotency key was reused with different Memory event content: ${key}`);
		this.name = "MemoryIdempotencyConflictError";
	}
}

export class MemoryRevisionConflictError extends MemoryStoreError {
	constructor(memoryId: string, expected: number | null, actual: number | null) {
		super(`Memory revision conflict for ${memoryId}: expected ${expected ?? "missing"}, got ${actual ?? "missing"}`);
		this.name = "MemoryRevisionConflictError";
	}
}

export class MemoryNotFoundError extends MemoryStoreError {
	constructor(memoryId: string) {
		super(`Memory not found: ${memoryId}`);
		this.name = "MemoryNotFoundError";
	}
}

export class MemoryRecoveryRequiredError extends MemoryStoreError {
	constructor() {
		super("Memory recovery is required before writing");
		this.name = "MemoryRecoveryRequiredError";
	}
}

export class MemoryCorruptionError extends MemoryStoreError {
	constructor(message: string) {
		super(message);
		this.name = "MemoryCorruptionError";
	}
}

export class MemoryLockedError extends MemoryStoreError {
	constructor(operation = "writing") {
		super(`Memory is locked while ${operation}`);
		this.name = "MemoryLockedError";
	}
}

export class MemoryLockRecoveryError extends MemoryStoreError {
	constructor(message: string) {
		super(`Memory write-lock recovery failed: ${message}`);
		this.name = "MemoryLockRecoveryError";
	}
}

export class MemoryLockRecoveryConflictError extends MemoryStoreError {
	constructor() {
		super("Memory write-lock recovery conflicted with a different lock owner");
		this.name = "MemoryLockRecoveryConflictError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new MemoryValidationError(`${field} has unknown or missing fields`);
	}
}

function requiredString(value: unknown, field: string, maximum = 4096): string {
	if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum) {
		throw new MemoryValidationError(`${field} must be a non-empty bounded string`);
	}
	return value;
}

function sha(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new MemoryValidationError(`${field} must be a SHA-256 identifier`);
	}
	return value;
}

function integer(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new MemoryValidationError(`${field} must be a positive integer`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new MemoryValidationError(`${field} must be a non-negative integer`);
	}
	return value;
}

function actor(value: unknown): MemoryActor {
	if (value !== "user" && value !== "model" && value !== "runtime" && value !== "system") {
		throw new MemoryValidationError("Memory actor is invalid");
	}
	return value;
}

function timestamp(value: unknown): string {
	const result = requiredString(value, "Memory event timestamp", 80);
	if (Number.isNaN(Date.parse(result))) throw new MemoryValidationError("Memory event timestamp must be ISO");
	return result;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length > 200) throw new MemoryValidationError(`${field} must be an array`);
	const result = value.map((entry, index) => requiredString(entry, `${field}[${index}]`, 512));
	if (new Set(result).size !== result.length) throw new MemoryValidationError(`${field} must be unique`);
	return result;
}

function artifactArray(value: unknown, field: string): string[] {
	return stringArray(value, field).map((entry, index) => sha(entry, `${field}[${index}]`));
}

function graphEndpoint(value: unknown, field: string): MemoryGraphEndpointV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["kind", "id"], field);
	if (value.kind !== "memory" && value.kind !== "cue") throw new MemoryValidationError(`${field} kind is invalid`);
	return { kind: value.kind, id: requiredString(value.id, `${field} id`) };
}

function publishedRevisionRef(value: unknown, field: string): PublishedMemoryRevisionRefV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["memoryId", "revision", "artifactId", "trust", "lifecycle", "sourceDigest", "evidenceIds"], field);
	if (value.trust !== "verified" && value.trust !== "model_inferred" && value.trust !== "disputed") {
		throw new MemoryValidationError(`${field} trust is invalid`);
	}
	if (
		value.lifecycle !== "active" &&
		value.lifecycle !== "superseded" &&
		value.lifecycle !== "invalidated" &&
		value.lifecycle !== "archived"
	) {
		throw new MemoryValidationError(`${field} lifecycle is invalid`);
	}
	return {
		memoryId: requiredString(value.memoryId, `${field} memoryId`),
		revision: integer(value.revision, `${field} revision`),
		artifactId: sha(value.artifactId, `${field} artifactId`),
		trust: value.trust,
		lifecycle: value.lifecycle,
		sourceDigest: sha(value.sourceDigest, `${field} sourceDigest`),
		evidenceIds: stringArray(value.evidenceIds, `${field} evidenceIds`),
	};
}

function publishedCueRef(value: unknown, field: string): PublishedCueRefV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["cueId", "revision", "artifactId", "key"], field);
	return {
		cueId: requiredString(value.cueId, `${field} cueId`),
		revision: integer(value.revision, `${field} revision`),
		artifactId: sha(value.artifactId, `${field} artifactId`),
		key: requiredString(value.key, `${field} key`, 120),
	};
}

function publishedEdgeRef(value: unknown, field: string): PublishedEdgeRefV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["edgeId", "artifactId", "from", "to", "relation"], field);
	if (
		![
			"part_of",
			"depends_on",
			"implements",
			"applies_to",
			"caused_by",
			"supports",
			"contradicts",
			"supersedes",
			"related_to",
		].includes(String(value.relation))
	) {
		throw new MemoryValidationError(`${field} relation is invalid`);
	}
	return {
		edgeId: requiredString(value.edgeId, `${field} edgeId`),
		artifactId: sha(value.artifactId, `${field} artifactId`),
		from: graphEndpoint(value.from, `${field} from`),
		to: graphEndpoint(value.to, `${field} to`),
		relation: value.relation as MemoryEdgeRelation,
	};
}

function parsePayload(eventType: MemoryEventType, value: unknown): MemoryEventPayloadV1 {
	if (!isRecord(value)) throw new MemoryValidationError("Memory event payload must be an object");
	if (eventType === "capture_scheduled") {
		exact(
			value,
			["captureId", "sourceArtifactId", "sourceDigest", "trigger", "promptVersion"],
			"capture_scheduled payload",
		);
		if (
			!["goal_checkpoint", "goal_completion", "chain_rollup", "explicit", "backfill"].includes(String(value.trigger))
		) {
			throw new MemoryValidationError("capture_scheduled trigger is invalid");
		}
		return {
			captureId: requiredString(value.captureId, "captureId"),
			sourceArtifactId: sha(value.sourceArtifactId, "sourceArtifactId"),
			sourceDigest: sha(value.sourceDigest, "sourceDigest"),
			trigger: value.trigger as MemoryCaptureTrigger,
			promptVersion: requiredString(value.promptVersion, "promptVersion", 160),
		};
	}
	if (eventType === "generation_started") {
		exact(value, ["captureId", "attempt"], "generation_started payload");
		return { captureId: requiredString(value.captureId, "captureId"), attempt: integer(value.attempt, "attempt") };
	}
	if (eventType === "capture_failed") {
		exact(value, ["captureId", "stage", "errorCode", "retryable", "message"], "capture_failed payload");
		if (
			!["source", "generation", "validation", "artifact", "publication", "projection"].includes(String(value.stage))
		) {
			throw new MemoryValidationError("capture_failed stage is invalid");
		}
		if (typeof value.retryable !== "boolean") throw new MemoryValidationError("capture_failed retryable is invalid");
		return {
			captureId: requiredString(value.captureId, "captureId"),
			stage: value.stage as CaptureFailedPayloadV1["stage"],
			errorCode: requiredString(value.errorCode, "errorCode", 160),
			retryable: value.retryable,
			message: requiredString(value.message, "message", 2048),
		};
	}
	if (eventType === "proposal_recorded") {
		exact(
			value,
			["captureId", "proposalId", "proposalArtifactId", "resultArtifactId", "confirmationRequired"],
			"proposal_recorded payload",
		);
		if (typeof value.confirmationRequired !== "boolean")
			throw new MemoryValidationError("confirmationRequired is invalid");
		return {
			captureId: value.captureId === null ? null : requiredString(value.captureId, "captureId"),
			proposalId: requiredString(value.proposalId, "proposalId"),
			proposalArtifactId: sha(value.proposalArtifactId, "proposalArtifactId"),
			resultArtifactId: sha(value.resultArtifactId, "resultArtifactId"),
			confirmationRequired: value.confirmationRequired,
		};
	}
	if (eventType === "memory_change_applied") {
		exact(value, ["proposalId", "proposalArtifactId", "revisions", "cues", "edges"], "memory_change_applied payload");
		if (!Array.isArray(value.revisions) || !Array.isArray(value.cues) || !Array.isArray(value.edges)) {
			throw new MemoryValidationError("memory_change_applied artifact references must be arrays");
		}
		return {
			proposalId: requiredString(value.proposalId, "proposalId"),
			proposalArtifactId: sha(value.proposalArtifactId, "proposalArtifactId"),
			revisions: value.revisions.map((entry, index) => publishedRevisionRef(entry, `revisions[${index}]`)),
			cues: value.cues.map((entry, index) => publishedCueRef(entry, `cues[${index}]`)),
			edges: value.edges.map((entry, index) => publishedEdgeRef(entry, `edges[${index}]`)),
		};
	}
	if (eventType === "proposal_rejected") {
		exact(value, ["proposalId", "reason"], "proposal_rejected payload");
		return {
			proposalId: requiredString(value.proposalId, "proposalId"),
			reason: requiredString(value.reason, "reason", 2048),
		};
	}
	if (eventType === "memory_lifecycle_changed") {
		exact(
			value,
			["memoryId", "fromRevision", "toRevision", "lifecycle", "reason", "revisionArtifactId"],
			"memory_lifecycle_changed payload",
		);
		if (!["active", "superseded", "invalidated", "archived"].includes(String(value.lifecycle))) {
			throw new MemoryValidationError("memory lifecycle is invalid");
		}
		return {
			memoryId: requiredString(value.memoryId, "memoryId"),
			fromRevision: integer(value.fromRevision, "fromRevision"),
			toRevision: integer(value.toRevision, "toRevision"),
			lifecycle: value.lifecycle as MemoryLifecycleChangedPayloadV1["lifecycle"],
			reason: requiredString(value.reason, "reason", 2048),
			revisionArtifactId: sha(value.revisionArtifactId, "revisionArtifactId"),
		};
	}
	if (eventType === "evidence_detached") {
		exact(
			value,
			["memoryId", "fromRevision", "toRevision", "evidenceId", "reason", "revisionArtifactId"],
			"evidence_detached payload",
		);
		return {
			memoryId: requiredString(value.memoryId, "memoryId"),
			fromRevision: integer(value.fromRevision, "fromRevision"),
			toRevision: integer(value.toRevision, "toRevision"),
			evidenceId: requiredString(value.evidenceId, "evidenceId"),
			reason: requiredString(value.reason, "reason", 2048),
			revisionArtifactId: sha(value.revisionArtifactId, "revisionArtifactId"),
		};
	}
	if (eventType === "memory_purged") {
		exact(value, ["memoryId", "revisionArtifactIds", "sourceDigest"], "memory_purged payload");
		return {
			memoryId: requiredString(value.memoryId, "memoryId"),
			revisionArtifactIds: artifactArray(value.revisionArtifactIds, "revisionArtifactIds"),
			sourceDigest: sha(value.sourceDigest, "sourceDigest"),
		};
	}
	exact(value, ["runId", "memoryIds", "evidenceIds"], "access_recorded payload");
	return {
		runId: requiredString(value.runId, "runId"),
		memoryIds: stringArray(value.memoryIds, "memoryIds"),
		evidenceIds: stringArray(value.evidenceIds, "evidenceIds"),
	};
}

function calculateHash(event: HashableMemoryEventV1): string {
	return `sha256:${createHash("sha256").update(stableJsonStringify(event)).digest("hex")}`;
}

function createEvent<TEventType extends MemoryEventType>(
	input: Extract<EventWithoutHash, { eventType: TEventType }>,
): Extract<MemoryEventV1, { eventType: TEventType }> {
	return { ...input, hash: calculateHash(input) } as Extract<MemoryEventV1, { eventType: TEventType }>;
}

function headFor(event: MemoryEventV1 | undefined): MemoryHead {
	return event ? { sequence: event.sequence, hash: event.hash } : { sequence: 0, hash: null };
}

function parseEvent(value: unknown, lineNumber: number): MemoryEventV1 {
	if (!isRecord(value)) throw new MemoryCorruptionError(`Memory event ${lineNumber} is not an object`);
	const fields = [
		"schema",
		"eventId",
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
	try {
		exact(value, fields, `Memory event ${lineNumber}`);
		if (value.schema !== MEMORY_EVENT_SCHEMA || value.schemaVersion !== 1)
			throw new MemoryValidationError("schema is unsupported");
		if (
			![
				"capture_scheduled",
				"generation_started",
				"capture_failed",
				"proposal_recorded",
				"memory_change_applied",
				"proposal_rejected",
				"memory_lifecycle_changed",
				"evidence_detached",
				"memory_purged",
				"access_recorded",
			].includes(String(value.eventType))
		) {
			throw new MemoryValidationError("eventType is unsupported");
		}
		const eventType = value.eventType as MemoryEventType;
		const sequence = integer(value.sequence, "sequence");
		const prevHash = value.prevHash === null ? null : sha(value.prevHash, "prevHash");
		const withoutHash: HashableMemoryEventV1 = {
			schema: MEMORY_EVENT_SCHEMA,
			eventId: requiredString(value.eventId, "eventId"),
			sequence,
			eventType,
			actor: actor(value.actor),
			timestamp: timestamp(value.timestamp),
			prevHash,
			payload: parsePayload(eventType, value.payload),
			schemaVersion: 1,
			idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey"),
		};
		const hash = sha(value.hash, "hash");
		if (calculateHash(withoutHash) !== hash) throw new MemoryValidationError("hash mismatch");
		return { ...withoutHash, hash } as MemoryEventV1;
	} catch (error) {
		throw new MemoryCorruptionError(
			`Memory event ${lineNumber} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

function projectCaptures(events: readonly MemoryEventV1[]): Map<string, MemoryCaptureProjectionV1> {
	const captures = new Map<string, MemoryCaptureProjectionV1>();
	const proposals = new Map<string, string | null>();
	const resolvedProposals = new Set<string>();
	for (const event of events) {
		if (event.eventType === "capture_scheduled") {
			if (captures.has(event.payload.captureId)) {
				throw new MemoryCorruptionError("capture_scheduled duplicates captureId");
			}
			captures.set(event.payload.captureId, {
				captureId: event.payload.captureId,
				status: "scheduled",
				sourceArtifactId: event.payload.sourceArtifactId,
				sourceDigest: event.payload.sourceDigest,
				trigger: event.payload.trigger,
				promptVersion: event.payload.promptVersion,
				attempt: null,
				proposalId: null,
				errorCode: null,
				retryable: null,
			});
		} else if (event.eventType === "generation_started") {
			const capture = captures.get(event.payload.captureId);
			if (
				!capture ||
				(capture.status !== "scheduled" && capture.status !== "failed") ||
				(capture.status === "failed" && capture.retryable !== true) ||
				event.payload.attempt !== (capture.attempt ?? 0) + 1
			) {
				throw new MemoryCorruptionError("generation_started requires a scheduled or failed capture");
			}
			captures.set(capture.captureId, {
				...capture,
				status: "generating",
				attempt: event.payload.attempt,
				errorCode: null,
				retryable: null,
			});
		} else if (event.eventType === "capture_failed") {
			const capture = captures.get(event.payload.captureId);
			if (event.payload.stage === "projection" && capture?.status === "applied") {
				captures.set(capture.captureId, {
					...capture,
					errorCode: event.payload.errorCode,
					retryable: event.payload.retryable,
				});
				continue;
			}
			if (!capture || (capture.status !== "scheduled" && capture.status !== "generating")) {
				throw new MemoryCorruptionError("capture_failed requires a scheduled or generating capture");
			}
			captures.set(capture.captureId, {
				...capture,
				status: "failed",
				errorCode: event.payload.errorCode,
				retryable: event.payload.retryable,
			});
		} else if (event.eventType === "proposal_recorded") {
			if (proposals.has(event.payload.proposalId)) {
				throw new MemoryCorruptionError("proposal_recorded duplicates proposalId");
			}
			proposals.set(event.payload.proposalId, event.payload.captureId);
			if (event.payload.captureId) {
				const capture = captures.get(event.payload.captureId);
				if (
					!capture ||
					(capture.status !== "generating" &&
						!(capture.status === "scheduled" && capture.trigger === "explicit") &&
						!(capture.status === "failed" && capture.retryable === true))
				) {
					throw new MemoryCorruptionError("proposal_recorded requires a publishable capture result");
				}
				captures.set(capture.captureId, { ...capture, status: "proposed", proposalId: event.payload.proposalId });
			}
		} else if (event.eventType === "memory_change_applied" || event.eventType === "proposal_rejected") {
			if (!proposals.has(event.payload.proposalId) || resolvedProposals.has(event.payload.proposalId)) {
				throw new MemoryCorruptionError(`${event.eventType} requires one unresolved recorded proposal`);
			}
			resolvedProposals.add(event.payload.proposalId);
			const captureId = proposals.get(event.payload.proposalId);
			if (captureId) {
				const capture = captures.get(captureId);
				if (capture)
					captures.set(captureId, {
						...capture,
						status: event.eventType === "memory_change_applied" ? "applied" : "rejected",
					});
			}
		}
	}
	return captures;
}

function projectFacts(events: readonly MemoryEventV1[]): {
	memories: Map<string, PublishedMemoryRevisionRefV1>;
	cues: Map<string, PublishedCueRefV1>;
	edges: Map<string, PublishedEdgeRefV1>;
	proposals: Map<string, ProposalRecordedPayloadV1>;
	purgedSourceDigests: Set<string>;
} {
	const memories = new Map<string, PublishedMemoryRevisionRefV1>();
	const cues = new Map<string, PublishedCueRefV1>();
	const edges = new Map<string, PublishedEdgeRefV1>();
	const proposals = new Map<string, ProposalRecordedPayloadV1>();
	const purgedSourceDigests = new Set<string>();
	const resolvedProposals = new Set<string>();
	const accessRuns = new Set<string>();
	for (const event of events) {
		if (event.eventType === "capture_scheduled") {
			if (purgedSourceDigests.has(event.payload.sourceDigest)) {
				throw new MemoryCorruptionError("capture_scheduled reuses a purged source digest");
			}
		} else if (event.eventType === "proposal_recorded") {
			if (proposals.has(event.payload.proposalId))
				throw new MemoryCorruptionError("proposal_recorded duplicates proposalId");
			proposals.set(event.payload.proposalId, event.payload);
		} else if (event.eventType === "memory_change_applied") {
			const proposal = proposals.get(event.payload.proposalId);
			if (
				!proposal ||
				resolvedProposals.has(event.payload.proposalId) ||
				proposal.proposalArtifactId !== event.payload.proposalArtifactId
			) {
				throw new MemoryCorruptionError("memory_change_applied does not match a recorded proposal");
			}
			resolvedProposals.add(event.payload.proposalId);
			for (const revision of event.payload.revisions) {
				const current = memories.get(revision.memoryId);
				if ((current?.revision ?? 0) + 1 !== revision.revision) {
					throw new MemoryCorruptionError(
						`memory_change_applied breaks revision sequence for ${revision.memoryId}`,
					);
				}
				memories.set(revision.memoryId, revision);
			}
			for (const cue of event.payload.cues) {
				const current = cues.get(cue.cueId);
				if ((current?.revision ?? 0) + 1 !== cue.revision) {
					throw new MemoryCorruptionError(`memory_change_applied breaks cue revision sequence for ${cue.cueId}`);
				}
				cues.set(cue.cueId, cue);
			}
			for (const edge of event.payload.edges) {
				if (edges.has(edge.edgeId))
					throw new MemoryCorruptionError(`memory_change_applied duplicates edge ${edge.edgeId}`);
				edges.set(edge.edgeId, edge);
			}
		} else if (event.eventType === "proposal_rejected") {
			if (!proposals.has(event.payload.proposalId) || resolvedProposals.has(event.payload.proposalId)) {
				throw new MemoryCorruptionError("proposal_rejected requires one unresolved recorded proposal");
			}
			resolvedProposals.add(event.payload.proposalId);
		} else if (event.eventType === "memory_lifecycle_changed") {
			const current = memories.get(event.payload.memoryId);
			if (
				!current ||
				current.revision !== event.payload.fromRevision ||
				event.payload.toRevision !== current.revision + 1
			) {
				throw new MemoryCorruptionError("memory_lifecycle_changed breaks revision sequence");
			}
			memories.set(current.memoryId, {
				...current,
				revision: event.payload.toRevision,
				artifactId: event.payload.revisionArtifactId,
				lifecycle: event.payload.lifecycle,
			});
		} else if (event.eventType === "evidence_detached") {
			const current = memories.get(event.payload.memoryId);
			if (
				!current ||
				current.revision !== event.payload.fromRevision ||
				event.payload.toRevision !== current.revision + 1
			) {
				throw new MemoryCorruptionError("evidence_detached breaks revision sequence");
			}
			if (!current.evidenceIds.includes(event.payload.evidenceId)) {
				throw new MemoryCorruptionError("evidence_detached references missing evidence");
			}
			memories.set(current.memoryId, {
				...current,
				revision: event.payload.toRevision,
				artifactId: event.payload.revisionArtifactId,
				evidenceIds: current.evidenceIds.filter((evidenceId) => evidenceId !== event.payload.evidenceId),
			});
		} else if (event.eventType === "memory_purged") {
			if (!memories.delete(event.payload.memoryId))
				throw new MemoryCorruptionError("memory_purged references missing memory");
			for (const [edgeId, edge] of edges) {
				if (
					(edge.from.kind === "memory" && edge.from.id === event.payload.memoryId) ||
					(edge.to.kind === "memory" && edge.to.id === event.payload.memoryId)
				) {
					edges.delete(edgeId);
				}
			}
			purgedSourceDigests.add(event.payload.sourceDigest);
		} else if (event.eventType === "access_recorded") {
			if (accessRuns.has(event.payload.runId)) {
				throw new MemoryCorruptionError("access_recorded duplicates runId");
			}
			accessRuns.add(event.payload.runId);
		}
	}
	for (const edge of edges.values()) {
		for (const endpoint of [edge.from, edge.to]) {
			if (endpoint.kind === "memory" ? !memories.has(endpoint.id) : !cues.has(endpoint.id)) {
				throw new MemoryCorruptionError(
					`memory edge ${edge.edgeId} references missing ${endpoint.kind} ${endpoint.id}`,
				);
			}
		}
	}
	return { memories, cues, edges, proposals, purgedSourceDigests };
}

function replayRaw(raw: string): MemoryReplay {
	const hasPartial = raw.length > 0 && !raw.endsWith("\n");
	const validRaw = hasPartial ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
	const lines = validRaw.split("\n").filter((line) => line.length > 0);
	const events = lines.map((line, index) => {
		try {
			return parseEvent(JSON.parse(line) as unknown, index + 1);
		} catch (error) {
			if (error instanceof SyntaxError)
				throw new MemoryCorruptionError(`Memory event ${index + 1} is not valid JSON`);
			throw error;
		}
	});
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event || event.sequence !== index + 1)
			throw new MemoryCorruptionError(`Memory event ${index + 1} breaks sequence`);
		const expectedPrevious = index === 0 ? null : events[index - 1]?.hash;
		if (event.prevHash !== expectedPrevious)
			throw new MemoryCorruptionError(`Memory event ${index + 1} breaks the hash chain`);
	}
	const facts = projectFacts(events);
	return {
		head: headFor(events.at(-1)),
		events,
		captures: projectCaptures(events),
		...facts,
		...(hasPartial ? { tailDiagnostic: { discardedBytes: Buffer.byteLength(raw.slice(validRaw.length)) } } : {}),
	};
}

function accessProjections(events: readonly MemoryEventV1[]): Map<string, MemoryAccessProjectionV1> {
	const accesses = new Map<string, MemoryAccessProjectionV1>();
	for (const event of events) {
		if (event.eventType === "access_recorded") {
			for (const memoryId of event.payload.memoryIds) {
				const current = accesses.get(memoryId);
				accesses.set(memoryId, {
					memoryId,
					accessCount: (current?.accessCount ?? 0) + 1,
					lastAccessedAt: event.timestamp,
				});
			}
		} else if (event.eventType === "memory_purged") {
			accesses.delete(event.payload.memoryId);
		}
	}
	return accesses;
}

function buildReadModel(replay: MemoryReplay): MemoryReadModelV1 {
	const captures = [...replay.captures.values()].sort((left, right) => left.captureId.localeCompare(right.captureId));
	const counts: MemoryReadModelV1["counts"] = {
		scheduled: 0,
		generating: 0,
		failed: 0,
		proposed: 0,
		applied: 0,
		rejected: 0,
	};
	for (const capture of captures) counts[capture.status] += 1;
	return {
		schema: MEMORY_READ_MODEL_SCHEMA,
		head: replay.head,
		eventCount: replay.events.length,
		captures,
		memories: [...replay.memories.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
		cues: [...replay.cues.values()].sort((left, right) => left.cueId.localeCompare(right.cueId)),
		edges: [...replay.edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
		proposals: [...replay.proposals.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
		resolvedProposalIds: replay.events
			.filter((event) => event.eventType === "memory_change_applied" || event.eventType === "proposal_rejected")
			.map((event) => event.payload.proposalId)
			.sort(),
		purgedSourceDigests: [...replay.purgedSourceDigests].sort(),
		accessRunIds: replay.events
			.filter((event) => event.eventType === "access_recorded")
			.map((event) => event.payload.runId)
			.sort(),
		accesses: [...accessProjections(replay.events).values()].sort((left, right) =>
			left.memoryId.localeCompare(right.memoryId),
		),
		counts,
	};
}

function projectionArray(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value) || value.length > 1_000_000) {
		throw new MemoryValidationError(`${field} must be a bounded array`);
	}
	return value;
}

function projectionStrings(value: unknown, field: string, sorted = false): string[] {
	const result = projectionArray(value, field).map((entry, index) => requiredString(entry, `${field}[${index}]`, 512));
	if (sorted) {
		for (let index = 1; index < result.length; index++) {
			if (result[index - 1]! >= result[index]!) {
				throw new MemoryValidationError(`${field} must be sorted and unique`);
			}
		}
	} else if (new Set(result).size !== result.length) {
		throw new MemoryValidationError(`${field} must be unique`);
	}
	return result;
}

function captureProjection(value: unknown, field: string): MemoryCaptureProjectionV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(
		value,
		[
			"captureId",
			"status",
			"sourceArtifactId",
			"sourceDigest",
			"trigger",
			"promptVersion",
			"attempt",
			"proposalId",
			"errorCode",
			"retryable",
		],
		field,
	);
	if (
		!(["scheduled", "generating", "failed", "proposed", "applied", "rejected"] as unknown[]).includes(value.status)
	) {
		throw new MemoryValidationError(`${field} status is invalid`);
	}
	if (
		!(["goal_checkpoint", "goal_completion", "chain_rollup", "explicit", "backfill"] as unknown[]).includes(
			value.trigger,
		)
	) {
		throw new MemoryValidationError(`${field} trigger is invalid`);
	}
	if (value.retryable !== null && typeof value.retryable !== "boolean") {
		throw new MemoryValidationError(`${field} retryable is invalid`);
	}
	return {
		captureId: requiredString(value.captureId, `${field} captureId`),
		status: value.status as MemoryCaptureStatus,
		sourceArtifactId: sha(value.sourceArtifactId, `${field} sourceArtifactId`),
		sourceDigest: sha(value.sourceDigest, `${field} sourceDigest`),
		trigger: value.trigger as MemoryCaptureTrigger,
		promptVersion: requiredString(value.promptVersion, `${field} promptVersion`, 160),
		attempt: value.attempt === null ? null : integer(value.attempt, `${field} attempt`),
		proposalId: value.proposalId === null ? null : requiredString(value.proposalId, `${field} proposalId`),
		errorCode: value.errorCode === null ? null : requiredString(value.errorCode, `${field} errorCode`, 160),
		retryable: value.retryable,
	};
}

function accessProjection(value: unknown, field: string): MemoryAccessProjectionV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["memoryId", "accessCount", "lastAccessedAt"], field);
	return {
		memoryId: requiredString(value.memoryId, `${field} memoryId`),
		accessCount: integer(value.accessCount, `${field} accessCount`),
		lastAccessedAt: timestamp(value.lastAccessedAt),
	};
}

function validateReadModel(value: unknown): MemoryReadModelV1 {
	if (!isRecord(value)) throw new MemoryValidationError("Memory read model must be an object");
	exact(
		value,
		[
			"schema",
			"head",
			"eventCount",
			"captures",
			"memories",
			"cues",
			"edges",
			"proposals",
			"resolvedProposalIds",
			"purgedSourceDigests",
			"accessRunIds",
			"accesses",
			"counts",
		],
		"Memory read model",
	);
	if (value.schema !== MEMORY_READ_MODEL_SCHEMA)
		throw new MemoryValidationError("Memory read model schema is unsupported");
	if (!isRecord(value.head)) throw new MemoryValidationError("Memory read model head must be an object");
	exact(value.head, ["sequence", "hash"], "Memory read model head");
	const sequence = nonNegativeInteger(value.head.sequence, "Memory read model head sequence");
	const hash = value.head.hash === null ? null : sha(value.head.hash, "Memory read model head hash");
	if ((sequence === 0) !== (hash === null)) throw new MemoryValidationError("Memory read model head is inconsistent");
	const eventCount = nonNegativeInteger(value.eventCount, "Memory read model eventCount");
	if (eventCount !== sequence) throw new MemoryValidationError("Memory read model eventCount must match its head");
	const captures = projectionArray(value.captures, "Memory read model captures").map((entry, index) =>
		captureProjection(entry, `Memory read model captures[${index}]`),
	);
	const memories = projectionArray(value.memories, "Memory read model memories").map((entry, index) =>
		publishedRevisionRef(entry, `Memory read model memories[${index}]`),
	);
	const cues = projectionArray(value.cues, "Memory read model cues").map((entry, index) =>
		publishedCueRef(entry, `Memory read model cues[${index}]`),
	);
	const edges = projectionArray(value.edges, "Memory read model edges").map((entry, index) =>
		publishedEdgeRef(entry, `Memory read model edges[${index}]`),
	);
	const proposals = projectionArray(value.proposals, "Memory read model proposals").map(
		(entry) => parsePayload("proposal_recorded", entry) as ProposalRecordedPayloadV1,
	);
	const resolvedProposalIds = projectionStrings(
		value.resolvedProposalIds,
		"Memory read model resolvedProposalIds",
		true,
	);
	const purgedSourceDigests = projectionStrings(
		value.purgedSourceDigests,
		"Memory read model purgedSourceDigests",
		true,
	).map((entry, index) => sha(entry, `Memory read model purgedSourceDigests[${index}]`));
	const accessRunIds = projectionStrings(value.accessRunIds, "Memory read model accessRunIds", true);
	const accesses = projectionArray(value.accesses, "Memory read model accesses").map((entry, index) =>
		accessProjection(entry, `Memory read model accesses[${index}]`),
	);
	if (!isRecord(value.counts)) throw new MemoryValidationError("Memory read model counts must be an object");
	exact(
		value.counts,
		["scheduled", "generating", "failed", "proposed", "applied", "rejected"],
		"Memory read model counts",
	);
	const counts = {
		scheduled: nonNegativeInteger(value.counts.scheduled, "Memory read model scheduled count"),
		generating: nonNegativeInteger(value.counts.generating, "Memory read model generating count"),
		failed: nonNegativeInteger(value.counts.failed, "Memory read model failed count"),
		proposed: nonNegativeInteger(value.counts.proposed, "Memory read model proposed count"),
		applied: nonNegativeInteger(value.counts.applied, "Memory read model applied count"),
		rejected: nonNegativeInteger(value.counts.rejected, "Memory read model rejected count"),
	};
	const sortedUnique = <TEntry>(entries: readonly TEntry[], id: (entry: TEntry) => string, field: string): void => {
		for (let index = 1; index < entries.length; index++) {
			if (id(entries[index - 1]!).localeCompare(id(entries[index]!)) >= 0) {
				throw new MemoryValidationError(`${field} must be sorted and unique`);
			}
		}
	};
	sortedUnique(captures, (entry) => entry.captureId, "Memory read model capture IDs");
	sortedUnique(memories, (entry) => entry.memoryId, "Memory read model memory IDs");
	sortedUnique(cues, (entry) => entry.cueId, "Memory read model cue IDs");
	sortedUnique(edges, (entry) => entry.edgeId, "Memory read model edge IDs");
	sortedUnique(proposals, (entry) => entry.proposalId, "Memory read model proposal IDs");
	sortedUnique(accesses, (entry) => entry.memoryId, "Memory read model access memory IDs");
	let memoryIndex = 0;
	for (const access of accesses) {
		while (memories[memoryIndex] && memories[memoryIndex]!.memoryId.localeCompare(access.memoryId) < 0) {
			memoryIndex += 1;
		}
		if (memories[memoryIndex]?.memoryId !== access.memoryId) {
			throw new MemoryValidationError("Memory read model access references missing memory");
		}
	}
	return {
		schema: MEMORY_READ_MODEL_SCHEMA,
		head: { sequence, hash },
		eventCount,
		captures,
		memories,
		cues,
		edges,
		proposals,
		resolvedProposalIds,
		purgedSourceDigests,
		accessRunIds,
		accesses,
		counts,
	};
}

function readModelDigest(readModel: MemoryReadModelV1): string {
	return `sha256:${createHash("sha256").update(stableJsonStringify(readModel)).digest("hex")}`;
}

function validateReadModelCheckpoint(value: unknown): MemoryReadModelCheckpointV1 {
	if (!isRecord(value)) throw new MemoryValidationError("Memory read model checkpoint must be an object");
	exact(
		value,
		["schema", "headEventOffset", "byteOffset", "sequence", "headHash", "readModelDigest", "idempotencyKeys"],
		"Memory read model checkpoint",
	);
	if (value.schema !== "pi-xk.memory-read-model-checkpoint.v1") {
		throw new MemoryValidationError("Memory read model checkpoint schema is unsupported");
	}
	const headEventOffset = nonNegativeInteger(value.headEventOffset, "Memory checkpoint headEventOffset");
	const byteOffset = nonNegativeInteger(value.byteOffset, "Memory checkpoint byteOffset");
	if (headEventOffset >= byteOffset) throw new MemoryValidationError("Memory checkpoint event range is invalid");
	const sequence = integer(value.sequence, "Memory checkpoint sequence");
	const idempotencyKeys = projectionStrings(value.idempotencyKeys, "Memory checkpoint idempotencyKeys");
	if (idempotencyKeys.length !== sequence) {
		throw new MemoryValidationError("Memory checkpoint idempotencyKeys do not match its sequence");
	}
	return {
		schema: "pi-xk.memory-read-model-checkpoint.v1",
		headEventOffset,
		byteOffset,
		sequence,
		headHash: sha(value.headHash, "Memory checkpoint headHash"),
		readModelDigest: sha(value.readModelDigest, "Memory checkpoint readModelDigest"),
		idempotencyKeys,
	};
}

function applyEventTail(readModel: MemoryReadModelV1, raw: string): MemoryReadModelV1 {
	if (raw.length === 0) return readModel;
	if (!raw.endsWith("\n")) throw new MemoryCorruptionError("Memory event tail is incomplete");
	const captures = new Map(readModel.captures.map((entry) => [entry.captureId, { ...entry }]));
	const memories = new Map(readModel.memories.map((entry) => [entry.memoryId, { ...entry }]));
	const cues = new Map(readModel.cues.map((entry) => [entry.cueId, { ...entry }]));
	const edges = new Map(readModel.edges.map((entry) => [entry.edgeId, { ...entry }]));
	const proposals = new Map(readModel.proposals.map((entry) => [entry.proposalId, { ...entry }]));
	const resolvedProposals = new Set(readModel.resolvedProposalIds);
	const purgedSourceDigests = new Set(readModel.purgedSourceDigests);
	const accessRunIds = new Set(readModel.accessRunIds);
	const accesses = new Map(readModel.accesses.map((entry) => [entry.memoryId, { ...entry }]));
	const counts = { ...readModel.counts };
	let sequence = readModel.head.sequence;
	let previousHash = readModel.head.hash;

	const replaceCapture = (next: MemoryCaptureProjectionV1): void => {
		const current = captures.get(next.captureId);
		if (current) counts[current.status] -= 1;
		counts[next.status] += 1;
		captures.set(next.captureId, next);
	};

	for (const line of raw.split("\n").filter((entry) => entry.length > 0)) {
		let event: MemoryEventV1;
		try {
			event = parseEvent(JSON.parse(line) as unknown, sequence + 1);
		} catch (error) {
			if (error instanceof SyntaxError)
				throw new MemoryCorruptionError(`Memory event ${sequence + 1} is not valid JSON`);
			throw error;
		}
		if (event.sequence !== sequence + 1 || event.prevHash !== previousHash) {
			throw new MemoryCorruptionError(`Memory event ${sequence + 1} breaks the incremental tail`);
		}

		if (event.eventType === "capture_scheduled") {
			if (captures.has(event.payload.captureId))
				throw new MemoryCorruptionError("capture_scheduled duplicates captureId");
			if (purgedSourceDigests.has(event.payload.sourceDigest)) {
				throw new MemoryCorruptionError("capture_scheduled reuses a purged source digest");
			}
			replaceCapture({
				captureId: event.payload.captureId,
				status: "scheduled",
				sourceArtifactId: event.payload.sourceArtifactId,
				sourceDigest: event.payload.sourceDigest,
				trigger: event.payload.trigger,
				promptVersion: event.payload.promptVersion,
				attempt: null,
				proposalId: null,
				errorCode: null,
				retryable: null,
			});
		} else if (event.eventType === "generation_started") {
			const capture = captures.get(event.payload.captureId);
			if (
				!capture ||
				(capture.status !== "scheduled" && capture.status !== "failed") ||
				(capture.status === "failed" && capture.retryable !== true) ||
				event.payload.attempt !== (capture.attempt ?? 0) + 1
			) {
				throw new MemoryCorruptionError("generation_started requires a scheduled or failed capture");
			}
			replaceCapture({
				...capture,
				status: "generating",
				attempt: event.payload.attempt,
				errorCode: null,
				retryable: null,
			});
		} else if (event.eventType === "capture_failed") {
			const capture = captures.get(event.payload.captureId);
			if (event.payload.stage === "projection" && capture?.status === "applied") {
				replaceCapture({
					...capture,
					errorCode: event.payload.errorCode,
					retryable: event.payload.retryable,
				});
			} else if (!capture || (capture.status !== "scheduled" && capture.status !== "generating")) {
				throw new MemoryCorruptionError("capture_failed requires a scheduled or generating capture");
			} else {
				replaceCapture({
					...capture,
					status: "failed",
					errorCode: event.payload.errorCode,
					retryable: event.payload.retryable,
				});
			}
		} else if (event.eventType === "proposal_recorded") {
			if (proposals.has(event.payload.proposalId))
				throw new MemoryCorruptionError("proposal_recorded duplicates proposalId");
			proposals.set(event.payload.proposalId, event.payload);
			if (event.payload.captureId) {
				const capture = captures.get(event.payload.captureId);
				if (
					!capture ||
					(capture.status !== "generating" &&
						!(capture.status === "scheduled" && capture.trigger === "explicit") &&
						!(capture.status === "failed" && capture.retryable === true))
				) {
					throw new MemoryCorruptionError("proposal_recorded requires a publishable capture result");
				}
				replaceCapture({ ...capture, status: "proposed", proposalId: event.payload.proposalId });
			}
		} else if (event.eventType === "memory_change_applied") {
			const proposal = proposals.get(event.payload.proposalId);
			if (
				!proposal ||
				resolvedProposals.has(event.payload.proposalId) ||
				proposal.proposalArtifactId !== event.payload.proposalArtifactId
			) {
				throw new MemoryCorruptionError("memory_change_applied does not match a recorded proposal");
			}
			resolvedProposals.add(event.payload.proposalId);
			if (proposal.captureId) {
				const capture = captures.get(proposal.captureId);
				if (!capture || capture.status !== "proposed")
					throw new MemoryCorruptionError("memory_change_applied requires a proposed capture");
				replaceCapture({ ...capture, status: "applied" });
			}
			for (const revision of event.payload.revisions) {
				const current = memories.get(revision.memoryId);
				if ((current?.revision ?? 0) + 1 !== revision.revision) {
					throw new MemoryCorruptionError(
						`memory_change_applied breaks revision sequence for ${revision.memoryId}`,
					);
				}
				memories.set(revision.memoryId, revision);
			}
			for (const cue of event.payload.cues) {
				const current = cues.get(cue.cueId);
				if ((current?.revision ?? 0) + 1 !== cue.revision) {
					throw new MemoryCorruptionError(`memory_change_applied breaks cue revision sequence for ${cue.cueId}`);
				}
				cues.set(cue.cueId, cue);
			}
			for (const edge of event.payload.edges) {
				if (edges.has(edge.edgeId))
					throw new MemoryCorruptionError(`memory_change_applied duplicates edge ${edge.edgeId}`);
				edges.set(edge.edgeId, edge);
			}
		} else if (event.eventType === "proposal_rejected") {
			const proposal = proposals.get(event.payload.proposalId);
			if (!proposal || resolvedProposals.has(event.payload.proposalId)) {
				throw new MemoryCorruptionError("proposal_rejected requires one unresolved recorded proposal");
			}
			resolvedProposals.add(event.payload.proposalId);
			if (proposal.captureId) {
				const capture = captures.get(proposal.captureId);
				if (!capture || capture.status !== "proposed")
					throw new MemoryCorruptionError("proposal_rejected requires a proposed capture");
				replaceCapture({ ...capture, status: "rejected" });
			}
		} else if (event.eventType === "memory_lifecycle_changed") {
			const current = memories.get(event.payload.memoryId);
			if (
				!current ||
				current.revision !== event.payload.fromRevision ||
				event.payload.toRevision !== current.revision + 1
			) {
				throw new MemoryCorruptionError("memory_lifecycle_changed breaks revision sequence");
			}
			memories.set(current.memoryId, {
				...current,
				revision: event.payload.toRevision,
				artifactId: event.payload.revisionArtifactId,
				lifecycle: event.payload.lifecycle,
			});
		} else if (event.eventType === "evidence_detached") {
			const current = memories.get(event.payload.memoryId);
			if (
				!current ||
				current.revision !== event.payload.fromRevision ||
				event.payload.toRevision !== current.revision + 1
			) {
				throw new MemoryCorruptionError("evidence_detached breaks revision sequence");
			}
			if (!current.evidenceIds.includes(event.payload.evidenceId)) {
				throw new MemoryCorruptionError("evidence_detached references missing evidence");
			}
			memories.set(current.memoryId, {
				...current,
				revision: event.payload.toRevision,
				artifactId: event.payload.revisionArtifactId,
				evidenceIds: current.evidenceIds.filter((evidenceId) => evidenceId !== event.payload.evidenceId),
			});
		} else if (event.eventType === "memory_purged") {
			if (!memories.delete(event.payload.memoryId))
				throw new MemoryCorruptionError("memory_purged references missing memory");
			for (const [edgeId, edge] of edges) {
				if (
					(edge.from.kind === "memory" && edge.from.id === event.payload.memoryId) ||
					(edge.to.kind === "memory" && edge.to.id === event.payload.memoryId)
				)
					edges.delete(edgeId);
			}
			accesses.delete(event.payload.memoryId);
			purgedSourceDigests.add(event.payload.sourceDigest);
		} else {
			if (accessRunIds.has(event.payload.runId)) throw new MemoryCorruptionError("access_recorded duplicates runId");
			accessRunIds.add(event.payload.runId);
			const evidenceIds = new Set<string>();
			for (const memoryId of event.payload.memoryIds) {
				const memory = memories.get(memoryId);
				if (!memory) throw new MemoryCorruptionError("access_recorded references missing memory");
				for (const evidenceId of memory.evidenceIds) evidenceIds.add(evidenceId);
				const current = accesses.get(memoryId);
				accesses.set(memoryId, {
					memoryId,
					accessCount: (current?.accessCount ?? 0) + 1,
					lastAccessedAt: event.timestamp,
				});
			}
			for (const evidenceId of event.payload.evidenceIds) {
				if (!evidenceIds.has(evidenceId))
					throw new MemoryCorruptionError("access_recorded references unrelated evidence");
			}
		}

		for (const edge of edges.values()) {
			for (const endpoint of [edge.from, edge.to]) {
				if (endpoint.kind === "memory" ? !memories.has(endpoint.id) : !cues.has(endpoint.id)) {
					throw new MemoryCorruptionError(
						`memory edge ${edge.edgeId} references missing ${endpoint.kind} ${endpoint.id}`,
					);
				}
			}
		}
		sequence = event.sequence;
		previousHash = event.hash;
	}

	return validateReadModel({
		schema: MEMORY_READ_MODEL_SCHEMA,
		head: { sequence, hash: previousHash },
		eventCount: sequence,
		captures: [...captures.values()].sort((left, right) => left.captureId.localeCompare(right.captureId)),
		memories: [...memories.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
		cues: [...cues.values()].sort((left, right) => left.cueId.localeCompare(right.cueId)),
		edges: [...edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
		proposals: [...proposals.values()].sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
		resolvedProposalIds: [...resolvedProposals].sort(),
		purgedSourceDigests: [...purgedSourceDigests].sort(),
		accessRunIds: [...accessRunIds].sort(),
		accesses: [...accesses.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
		counts,
	});
}

function sameIdempotentContent(existing: MemoryEventV1, proposed: MemoryEventV1): boolean {
	return (
		existing.eventType === proposed.eventType &&
		stableJsonStringify(existing.payload) === stableJsonStringify(proposed.payload)
	);
}

export class MemoryStore {
	private readonly projectRoot: string;
	private readonly paths: MemoryPaths;
	private readonly artifacts: ArtifactStore;
	private readonly onFullReplay: (() => void) | undefined;

	constructor(projectRoot: string, options: MemoryStoreOptions = {}) {
		this.projectRoot = resolve(projectRoot);
		const memoryDirectory = join(this.projectRoot, ".pi-xk", "memory");
		this.paths = {
			memoryDirectory,
			locksDirectory: join(memoryDirectory, "locks"),
			eventsPath: join(memoryDirectory, "events.jsonl"),
			readModelPath: join(memoryDirectory, "memory-read-model.json"),
			readModelCheckpointPath: join(memoryDirectory, "memory-read-model.checkpoint.json"),
			lockPath: join(memoryDirectory, ".write.lock"),
			recoveryLockPath: join(memoryDirectory, ".write.recovery.lock"),
		};
		this.artifacts = options.artifactStore ?? new ArtifactStore(this.projectRoot);
		this.onFullReplay = options.onFullReplay;
	}

	private captureGenerationLockOptions(captureId: string): FileWriteLockOptions {
		const normalized = requiredString(captureId, "captureId", 160);
		if (!/^capture_[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
			throw new MemoryValidationError("captureId is invalid for a generation lock");
		}
		const lockPath = join(this.paths.locksDirectory, `${normalized}.generation.lock`);
		return {
			directory: this.paths.locksDirectory,
			lockPath,
			recoveryLockPath: join(this.paths.locksDirectory, `${normalized}.generation.recovery.lock`),
			error: (failure: WriteLockFailure) => {
				if (failure.kind === "locked") return new MemoryLockedError(`generating capture ${normalized}`);
				if (failure.kind === "recovery-locked") {
					return new MemoryLockedError(`recovering capture generation ${normalized}`);
				}
				if (failure.kind === "conflict") return new MemoryLockRecoveryConflictError();
				if (failure.kind === "malformed") {
					return new MemoryLockRecoveryError(`capture ${normalized} generation lock metadata is malformed`);
				}
				return new MemoryLockRecoveryError(`capture ${normalized} generation lock owner is ${failure.ownerState}`);
			},
		};
	}

	private lockOptions(): FileWriteLockOptions {
		return {
			directory: this.paths.memoryDirectory,
			lockPath: this.paths.lockPath,
			recoveryLockPath: this.paths.recoveryLockPath,
			error: (failure: WriteLockFailure) => {
				if (failure.kind === "locked") return new MemoryLockedError();
				if (failure.kind === "recovery-locked") return new MemoryLockedError("recovering its write lock");
				if (failure.kind === "conflict") return new MemoryLockRecoveryConflictError();
				if (failure.kind === "malformed") return new MemoryLockRecoveryError("the lock metadata is malformed");
				return new MemoryLockRecoveryError(`the owner is ${failure.ownerState}`);
			},
		};
	}

	private async replaceFile(path: string, content: string): Promise<void> {
		const temporary = join(this.paths.memoryDirectory, `.${basename(path)}-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await syncDirectory(this.paths.memoryDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async appendEvent(event: MemoryEventV1): Promise<void> {
		const handle = await open(this.paths.eventsPath, "a", 0o600);
		try {
			await handle.writeFile(`${stableJsonStringify(event)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async readReplay(): Promise<MemoryReplay> {
		this.onFullReplay?.();
		try {
			return replayRaw(await readFile(this.paths.eventsPath, "utf8"));
		} catch (error) {
			if (isErrno(error, "ENOENT")) return replayRaw("");
			throw error;
		}
	}

	private async writeReadModel(replay: MemoryReplay): Promise<MemoryReadModelV1> {
		const readModel = buildReadModel(replay);
		await this.writeReadModelProjection(
			readModel,
			(await stat(this.paths.eventsPath)).size,
			replay.events.map((event) => event.idempotencyKey),
		);
		return readModel;
	}

	private async writeReadModelProjection(
		readModel: MemoryReadModelV1,
		byteOffset: number,
		idempotencyKeys: readonly string[],
	): Promise<void> {
		await this.replaceFile(this.paths.readModelPath, `${JSON.stringify(readModel, null, "\t")}\n`);
		const headEventOffset = await this.findHeadEventOffset(byteOffset);
		const checkpoint: MemoryReadModelCheckpointV1 = {
			schema: "pi-xk.memory-read-model-checkpoint.v1",
			headEventOffset,
			byteOffset,
			sequence: readModel.head.sequence,
			headHash: readModel.head.hash ?? "",
			readModelDigest: readModelDigest(readModel),
			idempotencyKeys: [...idempotencyKeys],
		};
		validateReadModelCheckpoint(checkpoint);
		await this.replaceFile(this.paths.readModelCheckpointPath, `${JSON.stringify(checkpoint, null, "\t")}\n`);
	}

	private async findHeadEventOffset(byteOffset: number): Promise<number> {
		if (byteOffset <= 0) throw new MemoryCorruptionError("Memory event log has no checkpoint head");
		const handle = await open(this.paths.eventsPath, "r");
		try {
			const fileSize = (await handle.stat()).size;
			if (fileSize < byteOffset) throw new MemoryCorruptionError("Memory event log is shorter than its read model");
			const terminator = Buffer.alloc(1);
			if ((await handle.read(terminator, 0, 1, byteOffset - 1)).bytesRead !== 1 || terminator[0] !== 0x0a) {
				throw new MemoryCorruptionError("Memory checkpoint head event is incomplete");
			}
			let cursor = byteOffset - 1;
			while (cursor > 0) {
				const length = Math.min(4_096, cursor);
				const start = cursor - length;
				const buffer = Buffer.alloc(length);
				const read = await handle.read(buffer, 0, length, start);
				const newline = buffer.subarray(0, read.bytesRead).lastIndexOf(0x0a);
				if (newline >= 0) return start + newline + 1;
				cursor = start;
			}
			return 0;
		} finally {
			await handle.close();
		}
	}

	private async readStoredReadModel(): Promise<MemoryReadModelV1 | undefined> {
		try {
			return validateReadModel(JSON.parse(await readFile(this.paths.readModelPath, "utf8")) as unknown);
		} catch {
			return undefined;
		}
	}

	private async readStoredReadModelCheckpoint(): Promise<MemoryReadModelCheckpointV1 | undefined> {
		try {
			return validateReadModelCheckpoint(
				JSON.parse(await readFile(this.paths.readModelCheckpointPath, "utf8")) as unknown,
			);
		} catch {
			return undefined;
		}
	}

	private async readEventBytesFrom(byteOffset: number): Promise<{ bytes: Buffer; fileSize: number }> {
		const handle = await open(this.paths.eventsPath, "r");
		try {
			const fileSize = (await handle.stat()).size;
			if (fileSize < byteOffset) return { bytes: Buffer.alloc(0), fileSize };
			const length = fileSize - byteOffset;
			if (length === 0) return { bytes: Buffer.alloc(0), fileSize };
			const buffer = Buffer.alloc(length);
			let consumed = 0;
			while (consumed < length) {
				const read = await handle.read(buffer, consumed, length - consumed, byteOffset + consumed);
				if (read.bytesRead === 0) break;
				consumed += read.bytesRead;
			}
			return { bytes: buffer.subarray(0, consumed), fileSize: byteOffset + consumed };
		} finally {
			await handle.close();
		}
	}

	private verifyCheckpointHead(checkpoint: MemoryReadModelCheckpointV1, raw: string): boolean {
		if (!raw.endsWith("\n")) return false;
		const lines = raw.split("\n").filter((line) => line.length > 0);
		if (lines.length !== 1 || !lines[0]) return false;
		try {
			const event = parseEvent(JSON.parse(lines[0]) as unknown, checkpoint.sequence);
			return event.sequence === checkpoint.sequence && event.hash === checkpoint.headHash;
		} catch {
			return false;
		}
	}

	private async inspectReadModelFastPath(): Promise<
		| (MemoryReadModelLoadResult & {
				byteOffset: number;
				checkpoint: MemoryReadModelCheckpointV1;
				idempotencyKeys: string[];
		  })
		| undefined
	> {
		const [readModel, checkpoint] = await Promise.all([
			this.readStoredReadModel(),
			this.readStoredReadModelCheckpoint(),
		]);
		if (
			!readModel ||
			!checkpoint ||
			checkpoint.sequence !== readModel.head.sequence ||
			checkpoint.headHash !== readModel.head.hash ||
			checkpoint.readModelDigest !== readModelDigest(readModel)
		) {
			return undefined;
		}
		const eventBytes = await this.readEventBytesFrom(checkpoint.headEventOffset);
		if (eventBytes.fileSize < checkpoint.byteOffset) return undefined;
		const proofLength = checkpoint.byteOffset - checkpoint.headEventOffset;
		if (eventBytes.bytes.length < proofLength) return undefined;
		if (!this.verifyCheckpointHead(checkpoint, eventBytes.bytes.subarray(0, proofLength).toString("utf8"))) {
			return undefined;
		}
		const tailRaw = eventBytes.bytes.subarray(proofLength).toString("utf8");
		if (tailRaw.length === 0) {
			return {
				readModel,
				diagnostic: { mode: "fast", bytesRead: proofLength },
				byteOffset: checkpoint.byteOffset,
				checkpoint,
				idempotencyKeys: checkpoint.idempotencyKeys,
			};
		}
		try {
			const nextReadModel = applyEventTail(readModel, tailRaw);
			const tailEvents = tailRaw
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line, index) => parseEvent(JSON.parse(line) as unknown, checkpoint.sequence + index + 1));
			const idempotencyKeys = [...checkpoint.idempotencyKeys, ...tailEvents.map((event) => event.idempotencyKey)];
			if (new Set(idempotencyKeys).size !== idempotencyKeys.length) return undefined;
			return {
				readModel: nextReadModel,
				diagnostic: { mode: "tail", bytesRead: eventBytes.bytes.length },
				byteOffset: eventBytes.fileSize,
				checkpoint,
				idempotencyKeys,
			};
		} catch {
			return undefined;
		}
	}

	private assertHead(expected: MemoryHead, actual: MemoryHead): void {
		if (expected.sequence !== actual.sequence || expected.hash !== actual.hash) {
			throw new MemoryHeadConflictError(expected, actual);
		}
	}

	private retry<TEventType extends MemoryEventType>(
		replay: MemoryReplay,
		proposed: Extract<MemoryEventV1, { eventType: TEventType }>,
	): MemoryWriteResult<TEventType> | undefined {
		const existing = replay.events.find((event) => event.idempotencyKey === proposed.idempotencyKey);
		if (!existing) return undefined;
		if (!sameIdempotentContent(existing, proposed)) throw new MemoryIdempotencyConflictError(proposed.idempotencyKey);
		return {
			event: existing as Extract<MemoryEventV1, { eventType: TEventType }>,
			head: headFor(existing),
		};
	}

	private async append<TEventType extends MemoryEventType>(
		eventType: TEventType,
		payload: MemoryEventPayloadMapV1[TEventType],
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<TEventType>> {
		return await withFileWriteLock(this.lockOptions(), async () => {
			const eventId = requiredString(options.eventId, "eventId");
			const eventActor = actor(options.actor ?? "runtime");
			const eventTimestamp = timestamp(options.timestamp ?? new Date().toISOString());
			const idempotencyKey = requiredString(options.idempotencyKey, "idempotencyKey");
			const parsedPayload = parsePayload(eventType, payload) as MemoryEventPayloadMapV1[TEventType];
			const createForHead = (head: MemoryHead): Extract<MemoryEventV1, { eventType: TEventType }> =>
				createEvent({
					schema: MEMORY_EVENT_SCHEMA,
					eventId,
					sequence: head.sequence + 1,
					eventType,
					actor: eventActor,
					timestamp: eventTimestamp,
					prevHash: head.hash,
					payload: parsedPayload,
					schemaVersion: 1,
					idempotencyKey,
				} as unknown as Extract<EventWithoutHash, { eventType: TEventType }>);
			const projected = await this.inspectReadModelFastPath().catch((error: unknown) => {
				if (isErrno(error, "ENOENT")) return undefined;
				throw error;
			});
			if (projected && !projected.idempotencyKeys.includes(idempotencyKey)) {
				this.assertHead(options.expectedHead, projected.readModel.head);
				const event = createForHead(projected.readModel.head);
				let nextReadModel: MemoryReadModelV1;
				try {
					nextReadModel = applyEventTail(projected.readModel, `${stableJsonStringify(event)}\n`);
				} catch (error) {
					if (error instanceof MemoryCorruptionError) throw new MemoryValidationError(error.message);
					throw error;
				}
				await this.appendEvent(event);
				await this.writeReadModelProjection(nextReadModel, (await stat(this.paths.eventsPath)).size, [
					...projected.idempotencyKeys,
					idempotencyKey,
				]);
				return { event, head: nextReadModel.head };
			}
			const replay = await this.readReplay();
			if (replay.tailDiagnostic) throw new MemoryRecoveryRequiredError();
			const event = createForHead(replay.head);
			const retry = this.retry(replay, event);
			if (retry) return retry;
			this.assertHead(options.expectedHead, replay.head);
			let next: MemoryReplay;
			try {
				next = replayRaw(
					`${replay.events.map((entry) => stableJsonStringify(entry)).join("\n")}${replay.events.length > 0 ? "\n" : ""}${stableJsonStringify(event)}\n`,
				);
			} catch (error) {
				if (error instanceof MemoryCorruptionError) throw new MemoryValidationError(error.message);
				throw error;
			}
			await this.appendEvent(event);
			await this.writeReadModel(next);
			return { event, head: next.head };
		});
	}

	async replay(): Promise<MemoryReplay> {
		return await this.readReplay();
	}

	async loadReadModelSnapshot(): Promise<MemoryReadModelLoadResult> {
		let initial: Awaited<ReturnType<MemoryStore["inspectReadModelFastPath"]>>;
		try {
			initial = await this.inspectReadModelFastPath();
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				const replay = await this.readReplay();
				if (replay.events.length === 0) {
					return {
						readModel: buildReadModel(replay),
						diagnostic: { mode: "full", bytesRead: 0, fallbackReason: "projection-missing-or-invalid" },
					};
				}
			}
			throw error;
		}
		if (initial?.diagnostic.mode === "fast") {
			return { readModel: initial.readModel, diagnostic: initial.diagnostic };
		}
		return await withFileWriteLock(this.lockOptions(), async () => {
			const current = await this.inspectReadModelFastPath().catch((error: unknown) => {
				if (isErrno(error, "ENOENT")) return undefined;
				throw error;
			});
			if (current) {
				if (current.diagnostic.mode === "tail") {
					await this.writeReadModelProjection(current.readModel, current.byteOffset, current.idempotencyKeys);
				}
				return { readModel: current.readModel, diagnostic: current.diagnostic };
			}
			const [stored, checkpoint] = await Promise.all([
				this.readStoredReadModel(),
				this.readStoredReadModelCheckpoint(),
			]);
			let raw: string;
			try {
				raw = await readFile(this.paths.eventsPath, "utf8");
			} catch (error) {
				if (isErrno(error, "ENOENT")) raw = "";
				else throw error;
			}
			const replay = replayRaw(raw);
			if (replay.tailDiagnostic) throw new MemoryRecoveryRequiredError();
			const readModel = buildReadModel(replay);
			let fallbackReason: MemoryReadModelLoadDiagnostic["fallbackReason"] =
				stored && checkpoint ? "checkpoint-mismatch" : "projection-missing-or-invalid";
			if (checkpoint && Buffer.byteLength(raw) < checkpoint.byteOffset) fallbackReason = "event-log-shortened";
			if (replay.events.length > 0) {
				await this.writeReadModelProjection(
					readModel,
					Buffer.byteLength(raw),
					replay.events.map((event) => event.idempotencyKey),
				);
			}
			return {
				readModel,
				diagnostic: { mode: "full", bytesRead: Buffer.byteLength(raw), fallbackReason },
			};
		});
	}

	async inspectReadModelProjection(): Promise<MemoryReadModelInspection> {
		const exists = async (path: string): Promise<boolean> => {
			try {
				await stat(path);
				return true;
			} catch (error) {
				if (isErrno(error, "ENOENT")) return false;
				throw error;
			}
		};
		const [readModelExists, checkpointExists, eventsExist] = await Promise.all([
			exists(this.paths.readModelPath),
			exists(this.paths.readModelCheckpointPath),
			exists(this.paths.eventsPath),
		]);
		if (!eventsExist) {
			return {
				state: readModelExists || checkpointExists ? "invalid" : "absent",
				readModel: null,
				diagnostic: null,
				eventLogBytes: 0,
				readModelExists,
				checkpointExists,
			};
		}
		const eventLogBytes = (await stat(this.paths.eventsPath)).size;
		const [readModel, checkpoint] = await Promise.all([
			this.readStoredReadModel(),
			this.readStoredReadModelCheckpoint(),
		]);
		if (!readModel || !checkpoint) {
			return {
				state: "invalid",
				readModel: readModel ?? null,
				diagnostic: null,
				eventLogBytes,
				readModelExists,
				checkpointExists,
			};
		}
		if (eventLogBytes < checkpoint.byteOffset) {
			return {
				state: "event-log-shortened",
				readModel,
				diagnostic: {
					mode: "full",
					bytesRead: eventLogBytes,
					fallbackReason: "event-log-shortened",
				},
				eventLogBytes,
				readModelExists,
				checkpointExists,
			};
		}
		const inspected = await this.inspectReadModelFastPath();
		if (!inspected) {
			return {
				state: "invalid",
				readModel,
				diagnostic: null,
				eventLogBytes,
				readModelExists,
				checkpointExists,
			};
		}
		return {
			state: inspected.diagnostic.mode === "tail" ? "stale" : "current",
			readModel: inspected.readModel,
			diagnostic: inspected.diagnostic,
			eventLogBytes,
			readModelExists,
			checkpointExists,
		};
	}

	async scheduleCapture(
		sourceInput: MemoryCaptureSourceV1,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"capture_scheduled">> {
		const source = validateMemoryCaptureSourceV1(sourceInput);
		const metadata = await this.artifacts.put({
			contentType: "application/json",
			value: source,
			producer: MEMORY_CAPTURE_SOURCE_SCHEMA,
			sensitivity: "internal",
			sourceIds: source.sourceIds,
			createdAt: source.createdAt,
		});
		const canonical = validateMemoryCaptureSourceV1(
			JSON.parse((await this.artifacts.read(metadata.artifactId)).content) as unknown,
		);
		return await this.append(
			"capture_scheduled",
			{
				captureId: canonical.captureId,
				sourceArtifactId: metadata.artifactId,
				sourceDigest: canonical.sourceDigest,
				trigger: canonical.trigger,
				promptVersion: canonical.promptVersion,
			},
			options,
		);
	}

	async markGenerationStarted(
		captureId: string,
		attempt: number,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"generation_started">> {
		return await this.append("generation_started", { captureId, attempt }, options);
	}

	async markCaptureFailed(
		payload: CaptureFailedPayloadV1,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"capture_failed">> {
		return await this.append("capture_failed", payload, options);
	}

	async rejectProposal(
		proposalId: string,
		reason: string,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"proposal_rejected">> {
		return await this.append("proposal_rejected", { proposalId, reason }, options);
	}

	private proposalRequiresConfirmation(replay: MemoryReplay, proposal: MemoryChangeProposalV1): boolean {
		for (const operation of proposal.operations) {
			if (
				operation.kind === "change_lifecycle" ||
				operation.kind === "detach_evidence" ||
				operation.kind === "purge_memory"
			) {
				return true;
			}
			if (operation.kind === "publish_revision") {
				if (operation.revision.trust === "verified") return true;
				if (replay.memories.has(operation.revision.memoryId)) return true;
			}
			if (operation.kind === "publish_cue" && replay.cues.has(operation.cue.cueId)) return true;
		}
		return false;
	}

	async recordProposal(
		proposalInput: MemoryChangeProposalV1,
		resultArtifactId: string,
		options: MemoryMutationOptions,
	): Promise<MemoryProposalRecordResultV1> {
		const proposal = validateMemoryChangeProposalV1(proposalInput);
		if (
			proposal.expectedEventHead.sequence !== options.expectedHead.sequence ||
			proposal.expectedEventHead.hash !== options.expectedHead.hash
		) {
			throw new MemoryHeadConflictError(proposal.expectedEventHead, options.expectedHead);
		}
		await this.artifacts.read(resultArtifactId);
		const before = await this.replay();
		this.assertHead(options.expectedHead, before.head);
		const metadata = await this.artifacts.put({
			contentType: "application/json",
			value: proposal,
			producer: MEMORY_CHANGE_PROPOSAL_SCHEMA,
			sensitivity: "internal",
			sourceIds: proposal.captureId ? [proposal.proposalId, proposal.captureId] : [proposal.proposalId],
			createdAt: proposal.provenance.recordedAt,
		});
		const canonical = validateMemoryChangeProposalV1(
			JSON.parse((await this.artifacts.read(metadata.artifactId)).content) as unknown,
		);
		const write = await this.append(
			"proposal_recorded",
			{
				captureId: canonical.captureId,
				proposalId: canonical.proposalId,
				proposalArtifactId: metadata.artifactId,
				resultArtifactId,
				confirmationRequired: this.proposalRequiresConfirmation(before, canonical),
			},
			options,
		);
		return { write, proposal: canonical, proposalArtifactId: metadata.artifactId };
	}

	private assertExpectedRevisions(replay: MemoryReplay, proposal: MemoryChangeProposalV1): void {
		const expected = new Map(proposal.expectedRevisions.map((entry) => [entry.memoryId, entry.revision]));
		for (const [memoryId, revision] of expected) {
			const actual = replay.memories.get(memoryId)?.revision ?? null;
			if (actual !== revision) throw new MemoryRevisionConflictError(memoryId, revision, actual);
		}
		for (const operation of proposal.operations) {
			if (operation.kind !== "publish_revision") continue;
			const current = replay.memories.get(operation.revision.memoryId);
			if (operation.revision.revision === 1) {
				if (current) throw new MemoryRevisionConflictError(operation.revision.memoryId, null, current.revision);
				if (expected.has(operation.revision.memoryId)) {
					throw new MemoryRevisionConflictError(
						operation.revision.memoryId,
						null,
						expected.get(operation.revision.memoryId) ?? null,
					);
				}
			} else {
				const expectedRevision = expected.get(operation.revision.memoryId) ?? null;
				if (
					!current ||
					expectedRevision !== current.revision ||
					operation.revision.revision !== current.revision + 1
				) {
					throw new MemoryRevisionConflictError(
						operation.revision.memoryId,
						expectedRevision,
						current?.revision ?? null,
					);
				}
			}
		}
	}

	private async verifyEvidence(
		revisions: readonly MemoryRevisionV1[],
		edges: readonly ReturnType<typeof validateMemoryEdgeV1>[],
	): Promise<void> {
		const artifactIds = new Set<string>();
		for (const evidence of [
			...revisions.flatMap((revision) => revision.evidenceRefs),
			...edges.flatMap((edge) => edge.evidenceRefs),
		]) {
			if (evidence.artifactId) artifactIds.add(evidence.artifactId);
		}
		for (const artifactId of artifactIds) await this.artifacts.read(artifactId);
	}

	async applyProposal(proposalArtifactId: string, options: MemoryApplyOptions): Promise<MemoryApplyResultV1> {
		const proposal = validateMemoryChangeProposalV1(
			JSON.parse((await this.artifacts.read(proposalArtifactId)).content) as unknown,
		);
		const replay = await this.replay();
		this.assertHead(options.expectedHead, replay.head);
		const recorded = replay.proposals.get(proposal.proposalId);
		if (!recorded || recorded.proposalArtifactId !== proposalArtifactId) {
			throw new MemoryValidationError("proposal must be recorded before it can be applied");
		}
		const recordEvent = replay.events.find(
			(event) => event.eventType === "proposal_recorded" && event.payload.proposalId === proposal.proposalId,
		);
		if (
			!recordEvent ||
			recordEvent.sequence - 1 !== proposal.expectedEventHead.sequence ||
			recordEvent.prevHash !== proposal.expectedEventHead.hash
		) {
			throw new MemoryHeadConflictError(proposal.expectedEventHead, {
				sequence: recordEvent ? recordEvent.sequence - 1 : 0,
				hash: recordEvent?.prevHash ?? null,
			});
		}
		if (recorded.confirmationRequired && options.confirmed !== true) {
			throw new MemoryValidationError("proposal requires explicit user confirmation");
		}
		this.assertExpectedRevisions(replay, proposal);
		if (proposal.operations.some((operation) => !operation.kind.startsWith("publish_"))) {
			throw new MemoryValidationError(
				"destructive proposal operations require their dedicated confirmed mutation API",
			);
		}
		const revisions = proposal.operations
			.filter((operation) => operation.kind === "publish_revision")
			.map((operation) => validateMemoryRevisionV1(operation.revision));
		const cues = proposal.operations
			.filter((operation) => operation.kind === "publish_cue")
			.map((operation) => validateCueNodeV1(operation.cue));
		const edges = proposal.operations
			.filter((operation) => operation.kind === "publish_edge")
			.map((operation) => validateMemoryEdgeV1(operation.edge));
		for (const entity of [...revisions, ...cues, ...edges]) {
			if (entity.sourceDigest !== proposal.sourceDigest) {
				throw new MemoryValidationError("published entity sourceDigest must match its proposal");
			}
		}
		const newCueIds = new Set(cues.map((cue) => cue.cueId));
		for (const cue of cues) {
			const current = replay.cues.get(cue.cueId);
			if ((current?.revision ?? 0) + 1 !== cue.revision) {
				throw new MemoryValidationError(`cue revision conflict for ${cue.cueId}`);
			}
		}
		for (const revision of revisions) {
			for (const cueId of revision.cueIds) {
				if (!replay.cues.has(cueId) && !newCueIds.has(cueId)) {
					throw new MemoryValidationError(`memory revision references missing cue ${cueId}`);
				}
			}
		}
		const newMemoryIds = new Set(revisions.map((revision) => revision.memoryId));
		for (const edge of edges) {
			if (replay.edges.has(edge.edgeId)) throw new MemoryValidationError(`edge already exists: ${edge.edgeId}`);
			for (const endpoint of [edge.from, edge.to]) {
				const exists =
					endpoint.kind === "memory"
						? replay.memories.has(endpoint.id) || newMemoryIds.has(endpoint.id)
						: replay.cues.has(endpoint.id) || newCueIds.has(endpoint.id);
				if (!exists) throw new MemoryValidationError(`edge references missing ${endpoint.kind} ${endpoint.id}`);
			}
		}
		await this.verifyEvidence(revisions, edges);

		const canonicalCues: CueNodeV1[] = [];
		const cueRefs: PublishedCueRefV1[] = [];
		for (const cue of cues) {
			const stored = await this.artifacts.put({
				contentType: "application/json",
				value: cue,
				producer: MEMORY_CUE_SCHEMA,
				sensitivity: "internal",
				sourceIds: [proposal.proposalId, ...cue.scope.paths],
				createdAt: cue.provenance.recordedAt,
			});
			const canonical = validateCueNodeV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			);
			canonicalCues.push(canonical);
			cueRefs.push({
				cueId: canonical.cueId,
				revision: canonical.revision,
				artifactId: stored.artifactId,
				key: canonical.key,
			});
		}
		const canonicalRevisions: MemoryRevisionV1[] = [];
		const revisionRefs: PublishedMemoryRevisionRefV1[] = [];
		for (const revision of revisions) {
			const stored = await this.artifacts.put({
				contentType: "application/json",
				value: revision,
				producer: MEMORY_REVISION_SCHEMA,
				sensitivity: "internal",
				sourceIds: [
					...new Set([proposal.proposalId, ...revision.evidenceRefs.map((evidence) => evidence.sourceId)]),
				],
				createdAt: revision.provenance.recordedAt,
			});
			const canonical = validateMemoryRevisionV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			);
			canonicalRevisions.push(canonical);
			revisionRefs.push({
				memoryId: canonical.memoryId,
				revision: canonical.revision,
				artifactId: stored.artifactId,
				trust: canonical.trust,
				lifecycle: canonical.lifecycle,
				sourceDigest: canonical.sourceDigest,
				evidenceIds: canonical.evidenceRefs.map((evidence) => evidence.evidenceId),
			});
		}
		const edgeRefs: PublishedEdgeRefV1[] = [];
		for (const edge of edges) {
			const stored = await this.artifacts.put({
				contentType: "application/json",
				value: edge,
				producer: MEMORY_EDGE_SCHEMA,
				sensitivity: "internal",
				sourceIds: [...new Set([proposal.proposalId, ...edge.evidenceRefs.map((evidence) => evidence.sourceId)])],
				createdAt: edge.provenance.recordedAt,
			});
			const canonical = validateMemoryEdgeV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			);
			edgeRefs.push({
				edgeId: canonical.edgeId,
				artifactId: stored.artifactId,
				from: canonical.from,
				to: canonical.to,
				relation: canonical.relation,
			});
		}
		const write = await this.append(
			"memory_change_applied",
			{
				proposalId: proposal.proposalId,
				proposalArtifactId,
				revisions: revisionRefs,
				cues: cueRefs,
				edges: edgeRefs,
			},
			options,
		);
		return { write, revisions: canonicalRevisions, cues: canonicalCues };
	}

	private factProjection(readModel: MemoryReadModelV1): MemoryFactProjection {
		return {
			memories: new Map(readModel.memories.map((entry) => [entry.memoryId, entry])),
			cues: new Map(readModel.cues.map((entry) => [entry.cueId, entry])),
			edges: new Map(readModel.edges.map((entry) => [entry.edgeId, entry])),
		};
	}

	private async readMemoryReference(
		reference: PublishedMemoryRevisionRefV1,
		cueExists: (cueId: string) => boolean,
	): Promise<MemoryReadResultV1> {
		const revision = validateMemoryRevisionV1(
			JSON.parse((await this.artifacts.read(reference.artifactId)).content) as unknown,
		);
		if (
			revision.memoryId !== reference.memoryId ||
			revision.revision !== reference.revision ||
			revision.trust !== reference.trust ||
			revision.lifecycle !== reference.lifecycle ||
			revision.sourceDigest !== reference.sourceDigest ||
			stableJsonStringify(revision.evidenceRefs.map((evidence) => evidence.evidenceId)) !==
				stableJsonStringify(reference.evidenceIds)
		) {
			throw new MemoryCorruptionError(`Memory revision artifact does not match its event: ${reference.memoryId}`);
		}
		for (const cueId of revision.cueIds) {
			if (!cueExists(cueId)) throw new MemoryCorruptionError(`Memory revision references missing cue: ${cueId}`);
		}
		for (const evidence of revision.evidenceRefs) {
			if (evidence.artifactId) await this.artifacts.read(evidence.artifactId);
		}
		return {
			revision,
			artifactId: reference.artifactId,
			state: {
				trust: revision.trust,
				freshness: revision.freshnessBasis
					? await resolveGitFreshness(this.projectRoot, revision.freshnessBasis)
					: "unknown",
				lifecycle: revision.lifecycle,
			},
		};
	}

	private async readMemoryFromReplay(replay: MemoryFactProjection, memoryId: string): Promise<MemoryReadResultV1> {
		const reference = replay.memories.get(memoryId);
		if (!reference) throw new MemoryNotFoundError(memoryId);
		return await this.readMemoryReference(reference, (cueId) => replay.cues.has(cueId));
	}

	async readMemory(memoryId: string): Promise<MemoryReadResultV1> {
		return await this.readMemoryFromReplay(
			this.factProjection((await this.loadReadModelSnapshot()).readModel),
			memoryId,
		);
	}

	async readMemories(memoryIds?: readonly string[]): Promise<MemoryReadResultV1[]> {
		const replay = this.factProjection((await this.loadReadModelSnapshot()).readModel);
		const selected = memoryIds ? [...memoryIds] : [...replay.memories.keys()].sort();
		if (new Set(selected).size !== selected.length) throw new MemoryValidationError("Memory IDs must be unique");
		const results: MemoryReadResultV1[] = [];
		for (const memoryId of selected) results.push(await this.readMemoryFromReplay(replay, memoryId));
		return results;
	}

	async readMemoriesByReferences(
		references: readonly PublishedMemoryRevisionRefV1[],
		cueExists: (cueId: string) => boolean,
	): Promise<MemoryReadResultV1[]> {
		if (new Set(references.map((reference) => reference.memoryId)).size !== references.length) {
			throw new MemoryValidationError("Memory references must be unique");
		}
		const results: MemoryReadResultV1[] = [];
		for (const reference of references) {
			results.push(await this.readMemoryReference(reference, cueExists));
		}
		return results;
	}

	async readMemoryTimeline(memoryId: string): Promise<MemoryTimelineEntryV1[]> {
		const replay = await this.replay();
		const artifactIds: string[] = [];
		for (const event of replay.events) {
			if (event.eventType === "memory_change_applied") {
				for (const revision of event.payload.revisions) {
					if (revision.memoryId === memoryId) artifactIds.push(revision.artifactId);
				}
			} else if (
				(event.eventType === "memory_lifecycle_changed" || event.eventType === "evidence_detached") &&
				event.payload.memoryId === memoryId
			) {
				artifactIds.push(event.payload.revisionArtifactId);
			}
		}
		if (artifactIds.length === 0) throw new MemoryNotFoundError(memoryId);
		const timeline: MemoryTimelineEntryV1[] = [];
		for (const [index, artifactId] of artifactIds.entries()) {
			const revision = validateMemoryRevisionV1(
				JSON.parse((await this.artifacts.read(artifactId)).content) as unknown,
			);
			if (revision.memoryId !== memoryId || revision.revision !== index + 1) {
				throw new MemoryCorruptionError(`Memory timeline artifact breaks revision sequence: ${memoryId}`);
			}
			timeline.push({
				revision,
				artifactId,
				state: {
					trust: revision.trust,
					freshness: revision.freshnessBasis
						? await resolveGitFreshness(this.projectRoot, revision.freshnessBasis)
						: "unknown",
					lifecycle: revision.lifecycle,
				},
			});
		}
		return timeline;
	}

	private async readCueReference(reference: PublishedCueRefV1): Promise<{ cue: CueNodeV1; artifactId: string }> {
		const cue = validateCueNodeV1(JSON.parse((await this.artifacts.read(reference.artifactId)).content) as unknown);
		if (cue.cueId !== reference.cueId || cue.revision !== reference.revision || cue.key !== reference.key) {
			throw new MemoryCorruptionError(`Memory cue artifact does not match its event: ${reference.cueId}`);
		}
		return { cue, artifactId: reference.artifactId };
	}

	private async readCueFromReplay(
		replay: MemoryFactProjection,
		cueId: string,
	): Promise<{ cue: CueNodeV1; artifactId: string }> {
		const reference = replay.cues.get(cueId);
		if (!reference) throw new MemoryNotFoundError(cueId);
		return await this.readCueReference(reference);
	}

	async readCue(cueId: string): Promise<{ cue: CueNodeV1; artifactId: string }> {
		return await this.readCueFromReplay(this.factProjection((await this.loadReadModelSnapshot()).readModel), cueId);
	}

	async readCues(cueIds?: readonly string[]): Promise<Array<{ cue: CueNodeV1; artifactId: string }>> {
		const replay = this.factProjection((await this.loadReadModelSnapshot()).readModel);
		const selected = cueIds ? [...cueIds] : [...replay.cues.keys()].sort();
		if (new Set(selected).size !== selected.length) throw new MemoryValidationError("Cue IDs must be unique");
		const results: Array<{ cue: CueNodeV1; artifactId: string }> = [];
		for (const cueId of selected) results.push(await this.readCueFromReplay(replay, cueId));
		return results;
	}

	async readCuesByReferences(
		references: readonly PublishedCueRefV1[],
	): Promise<Array<{ cue: CueNodeV1; artifactId: string }>> {
		if (new Set(references.map((reference) => reference.cueId)).size !== references.length) {
			throw new MemoryValidationError("Cue references must be unique");
		}
		const results: Array<{ cue: CueNodeV1; artifactId: string }> = [];
		for (const reference of references) results.push(await this.readCueReference(reference));
		return results;
	}

	private async readEdgeReference(reference: PublishedEdgeRefV1): Promise<{ edge: MemoryEdgeV1; artifactId: string }> {
		const edge = validateMemoryEdgeV1(
			JSON.parse((await this.artifacts.read(reference.artifactId)).content) as unknown,
		);
		if (
			edge.edgeId !== reference.edgeId ||
			stableJsonStringify(edge.from) !== stableJsonStringify(reference.from) ||
			stableJsonStringify(edge.to) !== stableJsonStringify(reference.to) ||
			edge.relation !== reference.relation
		) {
			throw new MemoryCorruptionError(`Memory edge artifact does not match its event: ${reference.edgeId}`);
		}
		return { edge, artifactId: reference.artifactId };
	}

	private async readEdgeFromReplay(
		replay: MemoryFactProjection,
		edgeId: string,
	): Promise<{ edge: MemoryEdgeV1; artifactId: string }> {
		const reference = replay.edges.get(edgeId);
		if (!reference) throw new MemoryNotFoundError(edgeId);
		return await this.readEdgeReference(reference);
	}

	async readEdge(edgeId: string): Promise<{ edge: MemoryEdgeV1; artifactId: string }> {
		return await this.readEdgeFromReplay(this.factProjection((await this.loadReadModelSnapshot()).readModel), edgeId);
	}

	async readEdges(edgeIds?: readonly string[]): Promise<Array<{ edge: MemoryEdgeV1; artifactId: string }>> {
		const replay = this.factProjection((await this.loadReadModelSnapshot()).readModel);
		const selected = edgeIds ? [...edgeIds] : [...replay.edges.keys()].sort();
		if (new Set(selected).size !== selected.length) throw new MemoryValidationError("Edge IDs must be unique");
		const results: Array<{ edge: MemoryEdgeV1; artifactId: string }> = [];
		for (const edgeId of selected) results.push(await this.readEdgeFromReplay(replay, edgeId));
		return results;
	}

	async readEdgesByReferences(
		references: readonly PublishedEdgeRefV1[],
	): Promise<Array<{ edge: MemoryEdgeV1; artifactId: string }>> {
		if (new Set(references.map((reference) => reference.edgeId)).size !== references.length) {
			throw new MemoryValidationError("Edge references must be unique");
		}
		const results: Array<{ edge: MemoryEdgeV1; artifactId: string }> = [];
		for (const reference of references) results.push(await this.readEdgeReference(reference));
		return results;
	}

	private requireConfirmation(options: MemoryApplyOptions): void {
		if (options.confirmed !== true) throw new MemoryValidationError("Memory mutation requires explicit confirmation");
	}

	private async publishDerivedRevision(
		revision: MemoryRevisionV1,
	): Promise<{ revision: MemoryRevisionV1; artifactId: string }> {
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: revision,
			producer: MEMORY_REVISION_SCHEMA,
			sensitivity: "internal",
			sourceIds: [revision.memoryId, ...revision.evidenceRefs.map((evidence) => evidence.sourceId)],
			createdAt: revision.provenance.recordedAt,
		});
		return {
			revision: validateMemoryRevisionV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			),
			artifactId: stored.artifactId,
		};
	}

	async changeMemoryLifecycle(
		memoryId: string,
		expectedRevision: number,
		lifecycle: MemoryLifecycle,
		reason: string,
		options: MemoryApplyOptions,
	): Promise<MemoryWriteResult<"memory_lifecycle_changed">> {
		this.requireConfirmation(options);
		requiredString(reason, "reason", 2048);
		const replay = await this.replay();
		this.assertHead(options.expectedHead, replay.head);
		const reference = replay.memories.get(memoryId);
		if (!reference) throw new MemoryNotFoundError(memoryId);
		if (reference.revision !== expectedRevision) {
			throw new MemoryRevisionConflictError(memoryId, expectedRevision, reference.revision);
		}
		if (reference.lifecycle === lifecycle)
			throw new MemoryValidationError("Memory already has the requested lifecycle");
		const current = await this.readMemory(memoryId);
		const recordedAt = timestamp(options.timestamp ?? new Date().toISOString());
		const published = await this.publishDerivedRevision({
			...current.revision,
			revision: current.revision.revision + 1,
			lifecycle,
			supersedesRevision: current.revision.revision,
			provenance: {
				producer: options.actor === "user" ? "user" : "pi-xk",
				model: null,
				promptVersion: null,
				recordedAt,
			},
		});
		return await this.append(
			"memory_lifecycle_changed",
			{
				memoryId,
				fromRevision: current.revision.revision,
				toRevision: published.revision.revision,
				lifecycle: published.revision.lifecycle,
				reason,
				revisionArtifactId: published.artifactId,
			},
			options,
		);
	}

	async detachMemoryEvidence(
		memoryId: string,
		expectedRevision: number,
		evidenceId: string,
		reason: string,
		options: MemoryApplyOptions,
	): Promise<MemoryWriteResult<"evidence_detached">> {
		this.requireConfirmation(options);
		requiredString(reason, "reason", 2048);
		const replay = await this.replay();
		this.assertHead(options.expectedHead, replay.head);
		const reference = replay.memories.get(memoryId);
		if (!reference) throw new MemoryNotFoundError(memoryId);
		if (reference.revision !== expectedRevision) {
			throw new MemoryRevisionConflictError(memoryId, expectedRevision, reference.revision);
		}
		const current = await this.readMemory(memoryId);
		if (!current.revision.evidenceRefs.some((evidence) => evidence.evidenceId === evidenceId)) {
			throw new MemoryValidationError(`Memory evidence does not exist: ${evidenceId}`);
		}
		const recordedAt = timestamp(options.timestamp ?? new Date().toISOString());
		const published = await this.publishDerivedRevision({
			...current.revision,
			revision: current.revision.revision + 1,
			evidenceRefs: current.revision.evidenceRefs.filter((evidence) => evidence.evidenceId !== evidenceId),
			supersedesRevision: current.revision.revision,
			provenance: {
				producer: options.actor === "user" ? "user" : "pi-xk",
				model: null,
				promptVersion: null,
				recordedAt,
			},
		});
		return await this.append(
			"evidence_detached",
			{
				memoryId,
				fromRevision: current.revision.revision,
				toRevision: published.revision.revision,
				evidenceId,
				reason,
				revisionArtifactId: published.artifactId,
			},
			options,
		);
	}

	private revisionArtifactIds(replay: MemoryReplay, memoryId: string): string[] {
		const result = new Set<string>();
		for (const event of replay.events) {
			if (event.eventType === "memory_change_applied") {
				for (const revision of event.payload.revisions) {
					if (revision.memoryId === memoryId) result.add(revision.artifactId);
				}
			} else if (
				(event.eventType === "memory_lifecycle_changed" || event.eventType === "evidence_detached") &&
				event.payload.memoryId === memoryId
			) {
				result.add(event.payload.revisionArtifactId);
			}
		}
		return [...result];
	}

	private async assertNoActiveEdges(replay: MemoryReplay, memoryId: string, asOf: string): Promise<void> {
		for (const edgeReference of replay.edges.values()) {
			const touchesMemory =
				(edgeReference.from.kind === "memory" && edgeReference.from.id === memoryId) ||
				(edgeReference.to.kind === "memory" && edgeReference.to.id === memoryId);
			if (!touchesMemory) continue;
			const edge = validateMemoryEdgeV1(
				JSON.parse((await this.artifacts.read(edgeReference.artifactId)).content) as unknown,
			);
			if (edge.effectiveTo === null || Date.parse(edge.effectiveTo) > Date.parse(asOf)) {
				throw new MemoryValidationError(`Memory has an active graph edge: ${edge.edgeId}`);
			}
		}
	}

	private async artifactHasExternalReference(artifactId: string): Promise<boolean> {
		const piXkDirectory = join(this.projectRoot, ".pi-xk");
		const artifactsDirectory = join(piXkDirectory, "artifacts");
		const objectDirectory = join(artifactsDirectory, "objects");
		const referenceBytes = Buffer.from(artifactId, "utf8");
		const searchableExtensions = new Set([".json", ".jsonl", ".md"]);
		const visit = async (directory: string): Promise<boolean> => {
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (isErrno(error, "ENOENT")) return false;
				throw error;
			}
			for (const entry of entries) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					if (path === this.paths.memoryDirectory) continue;
					if (await visit(path)) return true;
				} else if (entry.isFile() && directory.startsWith(objectDirectory) && extname(path) === ".json") {
					const metadata = validateArtifactMetadata(JSON.parse(await readFile(path, "utf8")) as unknown);
					if (metadata.artifactId === artifactId || metadata.producer.startsWith("pi-xk.memory")) continue;
					if (metadata.sourceIds.includes(artifactId)) return true;
					const dataPath = `${path.slice(0, -".json".length)}.data`;
					if ((await readFile(dataPath)).includes(referenceBytes)) return true;
				} else if (
					entry.isFile() &&
					!directory.startsWith(artifactsDirectory) &&
					searchableExtensions.has(extname(path)) &&
					(await readFile(path)).includes(referenceBytes)
				) {
					return true;
				}
			}
			return false;
		};
		return await visit(piXkDirectory);
	}

	async purgeMemory(
		memoryId: string,
		expectedRevision: number,
		reason: string,
		options: MemoryApplyOptions,
	): Promise<MemoryPurgeResultV1> {
		this.requireConfirmation(options);
		requiredString(reason, "reason", 2048);
		const replay = await this.replay();
		this.assertHead(options.expectedHead, replay.head);
		const reference = replay.memories.get(memoryId);
		if (!reference) throw new MemoryNotFoundError(memoryId);
		if (reference.revision !== expectedRevision) {
			throw new MemoryRevisionConflictError(memoryId, expectedRevision, reference.revision);
		}
		if (reference.lifecycle !== "archived" && reference.lifecycle !== "invalidated") {
			throw new MemoryValidationError("Memory must be archived or invalidated before purge");
		}
		if (reference.evidenceIds.length > 0)
			throw new MemoryValidationError("Memory evidence must be detached before purge");
		const asOf = timestamp(options.timestamp ?? new Date().toISOString());
		await this.assertNoActiveEdges(replay, memoryId, asOf);
		const revisionArtifactIds = this.revisionArtifactIds(replay, memoryId);
		for (const artifactId of revisionArtifactIds) {
			const stored = await this.artifacts.read(artifactId);
			const revision = validateMemoryRevisionV1(JSON.parse(stored.content) as unknown);
			if (stored.metadata.producer !== MEMORY_REVISION_SCHEMA || revision.memoryId !== memoryId) {
				throw new MemoryValidationError(
					"Memory purge revision artifact is not exclusively owned by the target Memory",
				);
			}
		}
		const externallyReferenced = new Set<string>();
		for (const artifactId of revisionArtifactIds) {
			if (await this.artifactHasExternalReference(artifactId)) externallyReferenced.add(artifactId);
		}
		const write = await this.append(
			"memory_purged",
			{
				memoryId,
				revisionArtifactIds,
				sourceDigest: reference.sourceDigest,
			},
			options,
		);
		const removedArtifactIds: string[] = [];
		const cleanupDiagnostics: MemoryPurgeCleanupDiagnosticV1[] = [];
		for (const artifactId of revisionArtifactIds) {
			if (externallyReferenced.has(artifactId)) continue;
			try {
				if (await this.artifacts.remove(artifactId)) removedArtifactIds.push(artifactId);
			} catch (error) {
				cleanupDiagnostics.push({
					artifactId,
					errorCode: isRecord(error) && typeof error.code === "string" ? error.code : "artifact_cleanup_failed",
					message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
				});
			}
		}
		return {
			write,
			removedArtifactIds,
			retainedArtifactIds: [...externallyReferenced].sort(),
			cleanupDiagnostics,
		};
	}

	async recordAccess(
		access: MemoryAccessEventV1,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"access_recorded">> {
		const readModel = (await this.loadReadModelSnapshot()).readModel;
		this.assertHead(options.expectedHead, readModel.head);
		const memories = new Map(readModel.memories.map((memory) => [memory.memoryId, memory]));
		const evidenceIds = new Set<string>();
		for (const memoryId of access.memoryIds) {
			const memory = memories.get(memoryId);
			if (!memory) throw new MemoryValidationError(`Memory access references missing memory: ${memoryId}`);
			for (const evidenceId of memory.evidenceIds) evidenceIds.add(evidenceId);
		}
		for (const evidenceId of access.evidenceIds) {
			if (!evidenceIds.has(evidenceId)) {
				throw new MemoryValidationError(`Memory access references unrelated evidence: ${evidenceId}`);
			}
		}
		return await this.append(
			"access_recorded",
			{ runId: access.runId, memoryIds: access.memoryIds, evidenceIds: access.evidenceIds },
			options,
		);
	}

	async inspectDeep(): Promise<MemoryDeepInspectionV1> {
		const replay = await this.readReplay();
		if (replay.tailDiagnostic) throw new MemoryRecoveryRequiredError();
		const referenced = new Set<string>();
		const purgedArtifactIds = new Set(
			replay.events.flatMap((event) =>
				event.eventType === "memory_purged" ? event.payload.revisionArtifactIds : [],
			),
		);
		const purgedArtifactIdsPresent: string[] = [];
		const purgedArtifactIdsMissing: string[] = [];
		const evidenceRefs = new Map<string, EvidenceRefV1>();
		const rememberEvidence = (evidence: EvidenceRefV1): void => {
			const current = evidenceRefs.get(evidence.evidenceId);
			if (current && stableJsonStringify(current) !== stableJsonStringify(evidence)) {
				throw new MemoryCorruptionError(`Memory evidence ID has conflicting definitions: ${evidence.evidenceId}`);
			}
			evidenceRefs.set(evidence.evidenceId, evidence);
		};
		const readArtifact = async (artifactId: string, allowPurgedMissing = false) => {
			referenced.add(artifactId);
			try {
				const stored = await this.artifacts.read(artifactId);
				if (allowPurgedMissing) purgedArtifactIdsPresent.push(artifactId);
				return stored;
			} catch (error) {
				if (allowPurgedMissing && error instanceof ArtifactNotFoundError) {
					purgedArtifactIdsMissing.push(artifactId);
					return null;
				}
				throw error;
			}
		};

		for (const event of replay.events) {
			if (event.eventType === "capture_scheduled") {
				const stored = await readArtifact(event.payload.sourceArtifactId);
				if (!stored) continue;
				const source = validateMemoryCaptureSourceV1(JSON.parse(stored.content) as unknown);
				for (const sourceId of source.sourceIds) {
					if (/^sha256:[a-f0-9]{64}$/.test(sourceId)) referenced.add(sourceId);
				}
				if (
					source.captureId !== event.payload.captureId ||
					source.sourceDigest !== event.payload.sourceDigest ||
					source.trigger !== event.payload.trigger ||
					source.promptVersion !== event.payload.promptVersion
				) {
					throw new MemoryCorruptionError("Memory capture source artifact does not match its event");
				}
			} else if (event.eventType === "proposal_recorded") {
				const [proposalStored] = await Promise.all([
					readArtifact(event.payload.proposalArtifactId),
					readArtifact(event.payload.resultArtifactId),
				]);
				if (!proposalStored) continue;
				const proposal = validateMemoryChangeProposalV1(JSON.parse(proposalStored.content) as unknown);
				if (proposal.proposalId !== event.payload.proposalId || proposal.captureId !== event.payload.captureId) {
					throw new MemoryCorruptionError("Memory proposal artifact does not match its event");
				}
			} else if (event.eventType === "memory_change_applied") {
				for (const reference of event.payload.revisions) {
					const stored = await readArtifact(reference.artifactId, purgedArtifactIds.has(reference.artifactId));
					if (!stored) continue;
					const revision = validateMemoryRevisionV1(JSON.parse(stored.content) as unknown);
					if (
						revision.memoryId !== reference.memoryId ||
						revision.revision !== reference.revision ||
						revision.trust !== reference.trust ||
						revision.lifecycle !== reference.lifecycle ||
						revision.sourceDigest !== reference.sourceDigest ||
						stableJsonStringify(revision.evidenceRefs.map((evidence) => evidence.evidenceId)) !==
							stableJsonStringify(reference.evidenceIds)
					) {
						throw new MemoryCorruptionError("Memory revision artifact does not match its event");
					}
					for (const evidence of revision.evidenceRefs) {
						rememberEvidence(evidence);
						if (evidence.artifactId) await readArtifact(evidence.artifactId);
					}
				}
				for (const reference of event.payload.cues) {
					const stored = await readArtifact(reference.artifactId);
					if (!stored) continue;
					const cue = validateCueNodeV1(JSON.parse(stored.content) as unknown);
					if (cue.cueId !== reference.cueId || cue.revision !== reference.revision || cue.key !== reference.key) {
						throw new MemoryCorruptionError("Memory cue artifact does not match its event");
					}
				}
				for (const reference of event.payload.edges) {
					const stored = await readArtifact(reference.artifactId);
					if (!stored) continue;
					const edge = validateMemoryEdgeV1(JSON.parse(stored.content) as unknown);
					if (
						edge.edgeId !== reference.edgeId ||
						stableJsonStringify(edge.from) !== stableJsonStringify(reference.from) ||
						stableJsonStringify(edge.to) !== stableJsonStringify(reference.to) ||
						edge.relation !== reference.relation
					) {
						throw new MemoryCorruptionError("Memory edge artifact does not match its event");
					}
					for (const evidence of edge.evidenceRefs) {
						rememberEvidence(evidence);
						if (evidence.artifactId) await readArtifact(evidence.artifactId);
					}
				}
			} else if (event.eventType === "memory_lifecycle_changed" || event.eventType === "evidence_detached") {
				const stored = await readArtifact(
					event.payload.revisionArtifactId,
					purgedArtifactIds.has(event.payload.revisionArtifactId),
				);
				if (!stored) continue;
				const revision = validateMemoryRevisionV1(JSON.parse(stored.content) as unknown);
				if (revision.memoryId !== event.payload.memoryId || revision.revision !== event.payload.toRevision) {
					throw new MemoryCorruptionError("Memory derived revision artifact does not match its event");
				}
				for (const evidence of revision.evidenceRefs) {
					rememberEvidence(evidence);
					if (evidence.artifactId) await readArtifact(evidence.artifactId);
				}
			}
		}
		const pendingDirectory = join(this.paths.memoryDirectory, "pending");
		try {
			for (const entry of await readdir(pendingDirectory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const pending = JSON.parse(await readFile(join(pendingDirectory, entry.name), "utf8")) as unknown;
				if (
					isRecord(pending) &&
					typeof pending.resultArtifactId === "string" &&
					/^sha256:[a-f0-9]{64}$/.test(pending.resultArtifactId)
				) {
					referenced.add(pending.resultArtifactId);
				}
			}
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		const orphanArtifactIds: string[] = [];
		const objectsDirectory = join(this.projectRoot, ".pi-xk", "artifacts", "objects");
		try {
			for (const prefix of await readdir(objectsDirectory, { withFileTypes: true })) {
				if (!prefix.isDirectory()) continue;
				for (const entry of await readdir(join(objectsDirectory, prefix.name), { withFileTypes: true })) {
					if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
					const metadata = validateArtifactMetadata(
						JSON.parse(await readFile(join(objectsDirectory, prefix.name, entry.name), "utf8")) as unknown,
					);
					if (
						metadata.producer.startsWith("pi-xk.memory") &&
						!referenced.has(metadata.artifactId) &&
						!purgedArtifactIds.has(metadata.artifactId)
					) {
						orphanArtifactIds.push(metadata.artifactId);
					}
				}
			}
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		return {
			replay,
			referencedArtifactIds: [...referenced].sort(),
			evidenceRefs: [...evidenceRefs.values()].sort((left, right) =>
				left.evidenceId.localeCompare(right.evidenceId),
			),
			orphanArtifactIds: orphanArtifactIds.sort(),
			purgedArtifactIdsPresent: [...new Set(purgedArtifactIdsPresent)].sort(),
			purgedArtifactIdsMissing: [...new Set(purgedArtifactIdsMissing)].sort(),
		};
	}

	async inspectWriteLock(): Promise<MemoryWriteLockDiagnostic | undefined> {
		return await inspectFileWriteLock(this.paths.lockPath);
	}

	async withCaptureGenerationLock<TResult>(captureId: string, action: () => Promise<TResult>): Promise<TResult> {
		return await withFileWriteLock(this.captureGenerationLockOptions(captureId), action);
	}

	async inspectCaptureGenerationLock(captureId: string): Promise<MemoryWriteLockDiagnostic | undefined> {
		return await inspectFileWriteLock(this.captureGenerationLockOptions(captureId).lockPath);
	}

	async repairAbandonedCaptureGenerationLock(captureId: string, expectedNonce: string): Promise<boolean> {
		if (expectedNonce.trim().length === 0) throw new MemoryValidationError("expectedNonce must be non-empty");
		return await repairAbandonedFileWriteLock(this.captureGenerationLockOptions(captureId), expectedNonce);
	}

	async repairAbandonedWriteLock(expectedNonce: string): Promise<boolean> {
		if (expectedNonce.trim().length === 0) throw new MemoryValidationError("expectedNonce must be non-empty");
		return await repairAbandonedFileWriteLock(this.lockOptions(), expectedNonce);
	}

	async rebuildReadModel(): Promise<MemoryReadModelV1> {
		return await withFileWriteLock(this.lockOptions(), async () => {
			const replay = await this.readReplay();
			if (replay.tailDiagnostic) throw new MemoryRecoveryRequiredError();
			return await this.writeReadModel(replay);
		});
	}

	async repairTrailingPartialEvent(): Promise<MemoryReplay> {
		return await withFileWriteLock(this.lockOptions(), async () => {
			const raw = await readFile(this.paths.eventsPath, "utf8");
			const replay = replayRaw(raw);
			if (!replay.tailDiagnostic) return replay;
			await this.replaceFile(this.paths.eventsPath, raw.slice(0, raw.lastIndexOf("\n") + 1));
			const repaired = await this.readReplay();
			await this.writeReadModel(repaired);
			return repaired;
		});
	}
}
