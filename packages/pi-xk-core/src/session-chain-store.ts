import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ArtifactStore, validateArtifactMetadata } from "./artifact-store.ts";
import {
	assertSessionBranchId,
	assertSessionChainArtifactId,
	assertSessionChainHash,
	assertSessionChainId,
	assertSessionSegmentId,
	type BranchCreatedPayloadV1,
	CHAIN_ROLLUP_SCHEMA,
	type ChainArchiveUpdatedPayloadV1,
	type ChainMetadataUpdatedPayloadV1,
	isSessionChainRecord,
	type RolloverAbortedPayloadV1,
	type RolloverCommittedPayloadV1,
	type RolloverPreparedPayloadV1,
	type RollupFailedPayloadV1,
	type RollupPublishedPayloadV1,
	SESSION_CHAIN_CATALOG_SCHEMA,
	SESSION_CHAIN_EVENT_SCHEMA,
	SESSION_CHAIN_EVENT_V2_SCHEMA,
	SESSION_CHAIN_EVENT_V3_SCHEMA,
	type SegmentSummary,
	type SessionBranchProjectionV1,
	type SessionChainActor,
	type SessionChainCatalogEntryV1,
	type SessionChainCatalogV1,
	type SessionChainEvent,
	type SessionChainEventType,
	type SessionChainHead,
	type SessionChainReadModelV1,
	type SessionChainRollupV1,
	type SessionChainSpecV1,
	SessionChainValidationError,
	type SessionSegmentDescriptorV1,
	type SessionSegmentSealV1,
	validateSegmentSummary,
	validateSessionChainActor,
	validateSessionChainExactKeys,
	validateSessionChainNonEmptyString,
	validateSessionChainNonNegativeInteger,
	validateSessionChainRollupV1,
	validateSessionChainSpecV1,
	validateSessionChainTimestamp,
	validateSessionChainTitle,
	validateSessionSegmentDescriptorV1,
} from "./session-chain-contract.ts";
import {
	buildSessionChainReadModel,
	SessionChainReadModelStaleError,
	sameSessionChainReadModel,
	validateSessionChainReadModel,
} from "./session-chain-read-model.ts";
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

export class SessionChainStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionChainStoreError";
	}
}

export class SessionChainNotFoundError extends SessionChainStoreError {
	constructor(chainId: string) {
		super(`Session Chain not found: ${chainId}`);
		this.name = "SessionChainNotFoundError";
	}
}

export class SessionChainAlreadyExistsError extends SessionChainStoreError {
	constructor(chainId: string) {
		super(`Session Chain already exists: ${chainId}`);
		this.name = "SessionChainAlreadyExistsError";
	}
}

export class SessionChainHeadConflictError extends SessionChainStoreError {
	constructor(expected: SessionChainHead, actual: SessionChainHead) {
		super(
			`Session Chain head conflict: expected ${expected.sequence}/${expected.hash}, got ${actual.sequence}/${actual.hash}`,
		);
		this.name = "SessionChainHeadConflictError";
	}
}

export class SessionChainIdempotencyConflictError extends SessionChainStoreError {
	constructor(key: string) {
		super(`Idempotency key was reused with different Session Chain event content: ${key}`);
		this.name = "SessionChainIdempotencyConflictError";
	}
}

export class SessionChainLifecycleTransitionError extends SessionChainStoreError {
	constructor(message: string) {
		super(`Session Chain lifecycle transition is invalid: ${message}`);
		this.name = "SessionChainLifecycleTransitionError";
	}
}

export class SessionChainRecoveryRequiredError extends SessionChainStoreError {
	constructor(chainId: string) {
		super(`Session Chain recovery is required before writing: ${chainId}`);
		this.name = "SessionChainRecoveryRequiredError";
	}
}

export class SessionChainCorruptionError extends SessionChainStoreError {
	constructor(message: string) {
		super(message);
		this.name = "SessionChainCorruptionError";
	}
}

export class SessionChainLockedError extends SessionChainStoreError {
	constructor(chainId: string, operation = "writing") {
		super(`Session Chain is locked while ${operation}: ${chainId}`);
		this.name = "SessionChainLockedError";
	}
}

export class SessionChainLockRecoveryError extends SessionChainStoreError {
	constructor(chainId: string, message: string) {
		super(`Session Chain write-lock recovery failed for ${chainId}: ${message}`);
		this.name = "SessionChainLockRecoveryError";
	}
}

export class SessionChainLockRecoveryConflictError extends SessionChainStoreError {
	constructor(chainId: string) {
		super(`Session Chain write-lock recovery conflicted with a different lock owner: ${chainId}`);
		this.name = "SessionChainLockRecoveryConflictError";
	}
}

interface SessionChainPaths {
	chainDirectory: string;
	eventsPath: string;
	readModelPath: string;
	readModelCheckpointPath: string;
	locksDirectory: string;
	lockPath: string;
}

interface SessionChainReadModelCheckpointV1 {
	schema: "pi-xk.session-chain-read-model-checkpoint.v1";
	headEventOffset: number;
	byteOffset: number;
	sequence: number;
	headHash: string;
	readModelDigest: string;
}

export interface SessionChainReadModelLoadDiagnostic {
	mode: "fast" | "tail" | "full";
	bytesRead: number;
}

export interface SessionChainReadModelLoadResult {
	readModel: SessionChainReadModelV1;
	diagnostic: SessionChainReadModelLoadDiagnostic;
}

export interface SessionChainTailDiagnostic {
	discardedBytes: number;
}

export type SessionChainWriteLockDiagnostic = WriteLockDiagnostic;

export interface SessionChainReplay {
	chainId: string;
	spec: SessionChainSpecV1;
	head: SessionChainHead;
	events: SessionChainEvent[];
	title: string | null;
	archived: boolean;
	branches: SessionBranchProjectionV1[];
	tailDiagnostic?: SessionChainTailDiagnostic;
}

export interface SessionChainMutationOptions {
	eventId: string;
	idempotencyKey: string;
	actor?: SessionChainActor;
	timestamp?: string;
}

export interface SessionChainAppendOptions extends SessionChainMutationOptions {
	expectedHead: SessionChainHead;
}

export interface SessionChainWriteResult {
	event: SessionChainEvent;
	head: SessionChainHead;
}

interface SessionChainEventWithoutHash {
	schema:
		| typeof SESSION_CHAIN_EVENT_SCHEMA
		| typeof SESSION_CHAIN_EVENT_V2_SCHEMA
		| typeof SESSION_CHAIN_EVENT_V3_SCHEMA;
	eventId: string;
	chainId: string;
	sequence: number;
	eventType: SessionChainEventType;
	actor: SessionChainActor;
	timestamp: string;
	prevHash: string | null;
	payload: SessionChainEvent["payload"];
	schemaVersion: 1 | 2 | 3;
	idempotencyKey: string;
}

function isErrno(error: unknown, code: string): boolean {
	return isSessionChainRecord(error) && error.code === code;
}

function calculateHash(event: SessionChainEventWithoutHash): string {
	return `sha256:${createHash("sha256").update(stableJsonStringify(event)).digest("hex")}`;
}

function contentHash(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readModelDigest(readModel: SessionChainReadModelV1): string {
	return contentHash(stableJsonStringify(readModel));
}

function validateReadModelCheckpoint(value: unknown): SessionChainReadModelCheckpointV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Read model checkpoint must be an object");
	validateSessionChainExactKeys(
		value,
		["schema", "headEventOffset", "byteOffset", "sequence", "headHash", "readModelDigest"],
		"Read model checkpoint",
	);
	if (value.schema !== "pi-xk.session-chain-read-model-checkpoint.v1") {
		throw new SessionChainValidationError("Read model checkpoint schema is unsupported");
	}
	const headEventOffset = validateSessionChainNonNegativeInteger(
		value.headEventOffset,
		"Read model checkpoint headEventOffset",
	);
	const byteOffset = validateSessionChainNonNegativeInteger(value.byteOffset, "Read model checkpoint byteOffset");
	if (headEventOffset >= byteOffset) {
		throw new SessionChainValidationError("Read model checkpoint head event range is invalid");
	}
	return {
		schema: "pi-xk.session-chain-read-model-checkpoint.v1",
		headEventOffset,
		byteOffset,
		sequence: validateSessionChainNonNegativeInteger(value.sequence, "Read model checkpoint sequence"),
		headHash: assertSessionChainHash(value.headHash, "Read model checkpoint headHash"),
		readModelDigest: assertSessionChainHash(value.readModelDigest, "Read model checkpoint readModelDigest"),
	};
}

function validateCatalogEntry(value: unknown): SessionChainCatalogEntryV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Catalog entry must be an object");
	const keys = ["chainId", "title", "cwd", "sequence", "baseHash", "createdAt", "updatedAt", "branchHeads"];
	if ("archived" in value) keys.push("archived");
	validateSessionChainExactKeys(value, keys, "Catalog entry");
	const chainId = validateSessionChainNonEmptyString(value.chainId, "Catalog chainId");
	assertSessionChainId(chainId);
	const sequence = validateSessionChainNonNegativeInteger(value.sequence, "Catalog sequence");
	if (sequence === 0) throw new SessionChainValidationError("Catalog sequence must be positive");
	if (!Array.isArray(value.branchHeads) || value.branchHeads.length === 0) {
		throw new SessionChainValidationError("Catalog branchHeads must be a non-empty array");
	}
	if (value.archived !== undefined && typeof value.archived !== "boolean") {
		throw new SessionChainValidationError("Catalog archived must be a boolean");
	}
	return {
		chainId,
		title: validateSessionChainTitle(value.title),
		cwd: validateSessionChainNonEmptyString(value.cwd, "Catalog cwd"),
		sequence,
		baseHash: assertSessionChainHash(value.baseHash, "Catalog baseHash"),
		createdAt: validateSessionChainTimestamp(value.createdAt, "Catalog createdAt"),
		updatedAt: validateSessionChainTimestamp(value.updatedAt, "Catalog updatedAt"),
		archived: value.archived ?? false,
		branchHeads: value.branchHeads.map((head) => {
			if (!isSessionChainRecord(head))
				throw new SessionChainValidationError("Catalog branch head must be an object");
			validateSessionChainExactKeys(head, ["branchId", "segmentId"], "Catalog branch head");
			const branchId = validateSessionChainNonEmptyString(head.branchId, "Catalog branchId");
			const segmentId = validateSessionChainNonEmptyString(head.segmentId, "Catalog segmentId");
			assertSessionBranchId(branchId);
			assertSessionSegmentId(segmentId);
			return { branchId, segmentId };
		}),
	};
}

function validateCatalog(value: unknown): SessionChainCatalogV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Catalog must be an object");
	validateSessionChainExactKeys(value, ["schema", "updatedAt", "chains"], "Catalog");
	if (value.schema !== SESSION_CHAIN_CATALOG_SCHEMA || !Array.isArray(value.chains)) {
		throw new SessionChainValidationError("Catalog schema or chains are invalid");
	}
	return {
		schema: SESSION_CHAIN_CATALOG_SCHEMA,
		updatedAt: value.updatedAt === null ? null : validateSessionChainTimestamp(value.updatedAt, "Catalog updatedAt"),
		chains: value.chains.map(validateCatalogEntry),
	};
}

function catalogEntryFromReadModel(readModel: SessionChainReadModelV1): SessionChainCatalogEntryV1 {
	return {
		chainId: readModel.chainId,
		title: readModel.title,
		cwd: readModel.cwd,
		sequence: readModel.sequence,
		baseHash: readModel.baseHash,
		createdAt: readModel.createdAt,
		updatedAt: readModel.updatedAt,
		archived: readModel.archived,
		branchHeads: readModel.branches
			.map((branch) => ({ branchId: branch.branchId, segmentId: branch.headSegmentId }))
			.sort((left, right) => left.branchId.localeCompare(right.branchId)),
	};
}

function createEvent(input: SessionChainEventWithoutHash): SessionChainEvent {
	return { ...input, hash: calculateHash(input) } as SessionChainEvent;
}

function headFor(event: SessionChainEvent): SessionChainHead {
	return { sequence: event.sequence, hash: event.hash };
}

function cloneSegment(segment: SessionSegmentDescriptorV1): SessionSegmentDescriptorV1 {
	return { ...segment, location: { ...segment.location } };
}

function cloneBranch(branch: SessionBranchProjectionV1): SessionBranchProjectionV1 {
	return {
		...branch,
		forkedFrom: branch.forkedFrom ? { ...branch.forkedFrom } : null,
		segments: branch.segments.map((segment) => ({
			...segment,
			location: { ...segment.location },
			...(segment.seal ? { seal: { ...segment.seal } } : {}),
		})),
		rollups: branch.rollups.map((rollup) => ({ ...rollup })),
		rollupFailures: branch.rollupFailures.map((failure) => ({ ...failure })),
		...(branch.pendingRollover
			? {
					pendingRollover: {
						...branch.pendingRollover,
						targetSegment: cloneSegment(branch.pendingRollover.targetSegment),
					},
				}
			: {}),
	};
}

function validatePreparedPayload(value: unknown): RolloverPreparedPayloadV1 {
	if (!isSessionChainRecord(value))
		throw new SessionChainValidationError("rollover_prepared payload must be an object");
	validateSessionChainExactKeys(
		value,
		["branchId", "sourceSegmentId", "sourceLeafId", "targetSegment", "summaryArtifactId", "reason"],
		"rollover_prepared payload",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	const sourceSegmentId = validateSessionChainNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	assertSessionBranchId(branchId);
	assertSessionSegmentId(sourceSegmentId);
	return {
		branchId,
		sourceSegmentId,
		sourceLeafId: validateSessionChainNonEmptyString(value.sourceLeafId, "sourceLeafId"),
		targetSegment: validateSessionSegmentDescriptorV1(value.targetSegment),
		summaryArtifactId: assertSessionChainArtifactId(value.summaryArtifactId, "summaryArtifactId"),
		reason: validateSessionChainNonEmptyString(value.reason, "reason"),
	};
}

function validateSeal(value: unknown): SessionSegmentSealV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("sourceSeal must be an object");
	validateSessionChainExactKeys(
		value,
		["bytes", "fileHash", "leafId", "summaryArtifactId", "summaryOutEntryId"],
		"sourceSeal",
	);
	const seal: SessionSegmentSealV1 = {
		bytes: validateSessionChainNonNegativeInteger(value.bytes, "sourceSeal.bytes"),
		fileHash: assertSessionChainHash(value.fileHash, "sourceSeal.fileHash"),
		leafId: validateSessionChainNonEmptyString(value.leafId, "sourceSeal.leafId"),
		summaryArtifactId: assertSessionChainArtifactId(value.summaryArtifactId, "sourceSeal.summaryArtifactId"),
		summaryOutEntryId: validateSessionChainNonEmptyString(value.summaryOutEntryId, "sourceSeal.summaryOutEntryId"),
	};
	if (seal.leafId !== seal.summaryOutEntryId) {
		throw new SessionChainValidationError("sourceSeal.leafId must be the summary-out entry");
	}
	return seal;
}

function validateCommittedPayload(value: unknown): RolloverCommittedPayloadV1 {
	if (!isSessionChainRecord(value))
		throw new SessionChainValidationError("rollover_committed payload must be an object");
	validateSessionChainExactKeys(
		value,
		["branchId", "sourceSegmentId", "targetSegmentId", "sourceSeal", "targetMarkers"],
		"rollover_committed payload",
	);
	if (!isSessionChainRecord(value.targetMarkers)) {
		throw new SessionChainValidationError("targetMarkers must be an object");
	}
	validateSessionChainExactKeys(value.targetMarkers, ["chainLinkEntryId", "summaryInEntryId"], "targetMarkers");
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	const sourceSegmentId = validateSessionChainNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	const targetSegmentId = validateSessionChainNonEmptyString(value.targetSegmentId, "targetSegmentId");
	assertSessionBranchId(branchId);
	assertSessionSegmentId(sourceSegmentId);
	assertSessionSegmentId(targetSegmentId);
	return {
		branchId,
		sourceSegmentId,
		targetSegmentId,
		sourceSeal: validateSeal(value.sourceSeal),
		targetMarkers: {
			chainLinkEntryId: validateSessionChainNonEmptyString(
				value.targetMarkers.chainLinkEntryId,
				"targetMarkers.chainLinkEntryId",
			),
			summaryInEntryId: validateSessionChainNonEmptyString(
				value.targetMarkers.summaryInEntryId,
				"targetMarkers.summaryInEntryId",
			),
		},
	};
}

function validateAbortedPayload(value: unknown): RolloverAbortedPayloadV1 {
	if (!isSessionChainRecord(value))
		throw new SessionChainValidationError("rollover_aborted payload must be an object");
	validateSessionChainExactKeys(
		value,
		["branchId", "sourceSegmentId", "targetSegmentId", "reason"],
		"rollover_aborted payload",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	const sourceSegmentId = validateSessionChainNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	const targetSegmentId = validateSessionChainNonEmptyString(value.targetSegmentId, "targetSegmentId");
	assertSessionBranchId(branchId);
	assertSessionSegmentId(sourceSegmentId);
	assertSessionSegmentId(targetSegmentId);
	return {
		branchId,
		sourceSegmentId,
		targetSegmentId,
		reason: validateSessionChainNonEmptyString(value.reason, "reason"),
	};
}

function validateBranchPayload(value: unknown): BranchCreatedPayloadV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("branch_created payload must be an object");
	validateSessionChainExactKeys(
		value,
		["branchId", "fromBranchId", "sourceSegmentId", "sourceEntryId", "segment"],
		"branch_created payload",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	const fromBranchId = validateSessionChainNonEmptyString(value.fromBranchId, "fromBranchId");
	const sourceSegmentId = validateSessionChainNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	assertSessionBranchId(branchId);
	assertSessionBranchId(fromBranchId);
	assertSessionSegmentId(sourceSegmentId);
	return {
		branchId,
		fromBranchId,
		sourceSegmentId,
		sourceEntryId: validateSessionChainNonEmptyString(value.sourceEntryId, "sourceEntryId"),
		segment: validateSessionSegmentDescriptorV1(value.segment),
	};
}

function validateMetadataPayload(value: unknown): ChainMetadataUpdatedPayloadV1 {
	if (!isSessionChainRecord(value)) {
		throw new SessionChainValidationError("chain_metadata_updated payload must be an object");
	}
	validateSessionChainExactKeys(value, ["title"], "chain_metadata_updated payload");
	return { title: validateSessionChainTitle(value.title) };
}

function validateArchivePayload(value: unknown): ChainArchiveUpdatedPayloadV1 {
	if (!isSessionChainRecord(value)) {
		throw new SessionChainValidationError("chain_archive_updated payload must be an object");
	}
	validateSessionChainExactKeys(value, ["archived"], "chain_archive_updated payload");
	if (typeof value.archived !== "boolean") {
		throw new SessionChainValidationError("chain_archive_updated archived must be a boolean");
	}
	return { archived: value.archived };
}

function requirePositiveInteger(value: unknown, field: string): number {
	const number = validateSessionChainNonNegativeInteger(value, field);
	if (number === 0) throw new SessionChainValidationError(`${field} must be positive`);
	return number;
}

function validateRollupPublishedPayload(value: unknown): RollupPublishedPayloadV1 {
	if (!isSessionChainRecord(value)) {
		throw new SessionChainValidationError("rollup_published payload must be an object");
	}
	validateSessionChainExactKeys(
		value,
		["branchId", "windowIndex", "startOrdinal", "endOrdinal", "artifactId", "sourceDigest"],
		"rollup_published payload",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	assertSessionBranchId(branchId);
	const startOrdinal = requirePositiveInteger(value.startOrdinal, "startOrdinal");
	const endOrdinal = requirePositiveInteger(value.endOrdinal, "endOrdinal");
	if (endOrdinal < startOrdinal) throw new SessionChainValidationError("Rollup ordinal range must be ordered");
	return {
		branchId,
		windowIndex: requirePositiveInteger(value.windowIndex, "windowIndex"),
		startOrdinal,
		endOrdinal,
		artifactId: assertSessionChainArtifactId(value.artifactId, "artifactId"),
		sourceDigest: assertSessionChainHash(value.sourceDigest, "sourceDigest"),
	};
}

function validateRollupFailedPayload(value: unknown): RollupFailedPayloadV1 {
	if (!isSessionChainRecord(value)) {
		throw new SessionChainValidationError("rollup_failed payload must be an object");
	}
	validateSessionChainExactKeys(
		value,
		["branchId", "windowIndex", "startOrdinal", "endOrdinal", "stage", "errorCode", "retryable", "attempt"],
		"rollup_failed payload",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	assertSessionBranchId(branchId);
	const startOrdinal = requirePositiveInteger(value.startOrdinal, "startOrdinal");
	const endOrdinal = requirePositiveInteger(value.endOrdinal, "endOrdinal");
	if (endOrdinal < startOrdinal) throw new SessionChainValidationError("Rollup ordinal range must be ordered");
	if (typeof value.retryable !== "boolean") {
		throw new SessionChainValidationError("retryable must be a boolean");
	}
	return {
		branchId,
		windowIndex: requirePositiveInteger(value.windowIndex, "windowIndex"),
		startOrdinal,
		endOrdinal,
		stage: validateSessionChainNonEmptyString(value.stage, "stage"),
		errorCode: validateSessionChainNonEmptyString(value.errorCode, "errorCode"),
		retryable: value.retryable,
		attempt: requirePositiveInteger(value.attempt, "attempt"),
	};
}

function parsePayload(eventType: SessionChainEventType, value: unknown): SessionChainEvent["payload"] {
	if (eventType === "chain_created") {
		if (!isSessionChainRecord(value))
			throw new SessionChainValidationError("chain_created payload must be an object");
		validateSessionChainExactKeys(value, ["spec"], "chain_created payload");
		return { spec: validateSessionChainSpecV1(value.spec) };
	}
	if (eventType === "rollover_prepared") return validatePreparedPayload(value);
	if (eventType === "rollover_committed") return validateCommittedPayload(value);
	if (eventType === "rollover_aborted") return validateAbortedPayload(value);
	if (eventType === "branch_created") return validateBranchPayload(value);
	if (eventType === "rollup_published") return validateRollupPublishedPayload(value);
	if (eventType === "rollup_failed") return validateRollupFailedPayload(value);
	if (eventType === "chain_archive_updated") return validateArchivePayload(value);
	return validateMetadataPayload(value);
}

function parseEvent(value: unknown, lineNumber: number): SessionChainEvent {
	if (!isSessionChainRecord(value)) {
		throw new SessionChainCorruptionError(`Session Chain event ${lineNumber} is not an object`);
	}
	const required = [
		"schema",
		"eventId",
		"chainId",
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
		validateSessionChainExactKeys(value, required, `Session Chain event ${lineNumber}`);
		const isV1 = value.schema === SESSION_CHAIN_EVENT_SCHEMA && value.schemaVersion === 1;
		const isV2 = value.schema === SESSION_CHAIN_EVENT_V2_SCHEMA && value.schemaVersion === 2;
		const isV3 = value.schema === SESSION_CHAIN_EVENT_V3_SCHEMA && value.schemaVersion === 3;
		if (!isV1 && !isV2 && !isV3) {
			throw new SessionChainValidationError("event schema is unsupported");
		}
		const chainId = validateSessionChainNonEmptyString(value.chainId, "chainId");
		assertSessionChainId(chainId);
		const sequence = validateSessionChainNonNegativeInteger(value.sequence, "sequence");
		if (sequence === 0) throw new SessionChainValidationError("sequence must be positive");
		const eventType = validateSessionChainNonEmptyString(value.eventType, "eventType") as SessionChainEventType;
		if (
			![
				"chain_created",
				"rollover_prepared",
				"rollover_committed",
				"rollover_aborted",
				"branch_created",
				"chain_metadata_updated",
				"chain_archive_updated",
				"rollup_published",
				"rollup_failed",
			].includes(eventType)
		) {
			throw new SessionChainValidationError("eventType is invalid");
		}
		if (
			isV1 &&
			(eventType === "rollup_published" || eventType === "rollup_failed" || eventType === "chain_archive_updated")
		) {
			throw new SessionChainValidationError("Event type requires a newer event schema");
		}
		if (isV2 && eventType !== "rollup_published" && eventType !== "rollup_failed") {
			throw new SessionChainValidationError("event schema v2 is reserved for Rollup events");
		}
		if (isV3 && eventType !== "chain_archive_updated") {
			throw new SessionChainValidationError("event schema v3 is reserved for archive events");
		}
		const withoutHash: SessionChainEventWithoutHash = {
			schema: isV3
				? SESSION_CHAIN_EVENT_V3_SCHEMA
				: isV2
					? SESSION_CHAIN_EVENT_V2_SCHEMA
					: SESSION_CHAIN_EVENT_SCHEMA,
			eventId: validateSessionChainNonEmptyString(value.eventId, "eventId"),
			chainId,
			sequence,
			eventType,
			actor: validateSessionChainActor(value.actor),
			timestamp: validateSessionChainTimestamp(value.timestamp, "timestamp"),
			prevHash: value.prevHash === null ? null : assertSessionChainHash(value.prevHash, "prevHash"),
			payload: parsePayload(eventType, value.payload),
			schemaVersion: isV3 ? 3 : isV2 ? 2 : 1,
			idempotencyKey: validateSessionChainNonEmptyString(value.idempotencyKey, "idempotencyKey"),
		};
		const hash = assertSessionChainHash(value.hash, "hash");
		if (calculateHash(withoutHash) !== hash) throw new SessionChainValidationError("event hash mismatch");
		return { ...withoutHash, hash } as SessionChainEvent;
	} catch (error) {
		throw new SessionChainCorruptionError(
			`Session Chain event ${lineNumber} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

function requireBranch(branches: SessionBranchProjectionV1[], branchId: string): SessionBranchProjectionV1 {
	const branch = branches.find((candidate) => candidate.branchId === branchId);
	if (!branch) throw new SessionChainLifecycleTransitionError(`branch does not exist: ${branchId}`);
	return branch;
}

function requireSegment(branch: SessionBranchProjectionV1, segmentId: string) {
	const segment = branch.segments.find((candidate) => candidate.segmentId === segmentId);
	if (!segment) throw new SessionChainLifecycleTransitionError(`Segment does not exist: ${segmentId}`);
	return segment;
}

function segmentExists(branches: SessionBranchProjectionV1[], segmentId: string): boolean {
	return branches.some(
		(branch) =>
			branch.segments.some((segment) => segment.segmentId === segmentId) ||
			branch.pendingRollover?.targetSegment.segmentId === segmentId,
	);
}

function applyEvent(
	branches: SessionBranchProjectionV1[],
	title: string | null,
	event: SessionChainEvent,
): string | null {
	if (event.eventType === "rollover_prepared") {
		const payload = event.payload;
		const branch = requireBranch(branches, payload.branchId);
		if (branch.pendingRollover) {
			throw new SessionChainLifecycleTransitionError(`branch already has a prepared rollover: ${payload.branchId}`);
		}
		if (branch.headSegmentId !== payload.sourceSegmentId) {
			throw new SessionChainLifecycleTransitionError("rollover source is not the branch head");
		}
		const source = requireSegment(branch, payload.sourceSegmentId);
		if (source.status !== "active") {
			throw new SessionChainLifecycleTransitionError("rollover source must be active");
		}
		if (payload.targetSegment.location.kind !== "managed") {
			throw new SessionChainLifecycleTransitionError("rollover target must be a managed Segment");
		}
		if (
			payload.targetSegment.ordinal !== source.ordinal + 1 ||
			payload.targetSegment.predecessorSegmentId !== source.segmentId ||
			payload.targetSegment.summaryInArtifactId !== payload.summaryArtifactId
		) {
			throw new SessionChainLifecycleTransitionError("rollover target does not continue the source Segment");
		}
		if (segmentExists(branches, payload.targetSegment.segmentId)) {
			throw new SessionChainLifecycleTransitionError("rollover target Segment already exists");
		}
		source.status = "prepared";
		branch.pendingRollover = {
			eventId: event.eventId,
			preparedAt: event.timestamp,
			sourceSegmentId: payload.sourceSegmentId,
			sourceLeafId: payload.sourceLeafId,
			targetSegment: cloneSegment(payload.targetSegment),
			summaryArtifactId: payload.summaryArtifactId,
			reason: payload.reason,
		};
		return title;
	}
	if (event.eventType === "rollover_committed") {
		const payload = event.payload;
		const branch = requireBranch(branches, payload.branchId);
		const pending = branch.pendingRollover;
		if (
			!pending ||
			pending.sourceSegmentId !== payload.sourceSegmentId ||
			pending.targetSegment.segmentId !== payload.targetSegmentId
		) {
			throw new SessionChainLifecycleTransitionError("rollover commit does not match the prepared rollover");
		}
		if (payload.sourceSeal.summaryArtifactId !== pending.summaryArtifactId) {
			throw new SessionChainLifecycleTransitionError("rollover commit summary does not match the prepared summary");
		}
		const source = requireSegment(branch, payload.sourceSegmentId);
		if (source.status !== "prepared") {
			throw new SessionChainLifecycleTransitionError("rollover commit source must be prepared");
		}
		source.status = "sealed";
		source.seal = { ...payload.sourceSeal };
		branch.segments.push({ ...cloneSegment(pending.targetSegment), status: "active" });
		branch.headSegmentId = pending.targetSegment.segmentId;
		delete branch.pendingRollover;
		return title;
	}
	if (event.eventType === "rollover_aborted") {
		const payload = event.payload;
		const branch = requireBranch(branches, payload.branchId);
		const pending = branch.pendingRollover;
		if (
			!pending ||
			pending.sourceSegmentId !== payload.sourceSegmentId ||
			pending.targetSegment.segmentId !== payload.targetSegmentId
		) {
			throw new SessionChainLifecycleTransitionError("rollover abort does not match the prepared rollover");
		}
		const source = requireSegment(branch, payload.sourceSegmentId);
		if (source.status !== "prepared") {
			throw new SessionChainLifecycleTransitionError("rollover abort source must be prepared");
		}
		source.status = "active";
		delete branch.pendingRollover;
		return title;
	}
	if (event.eventType === "branch_created") {
		const payload = event.payload;
		if (branches.some((branch) => branch.branchId === payload.branchId)) {
			throw new SessionChainLifecycleTransitionError(`branch already exists: ${payload.branchId}`);
		}
		const sourceBranch = requireBranch(branches, payload.fromBranchId);
		requireSegment(sourceBranch, payload.sourceSegmentId);
		if (segmentExists(branches, payload.segment.segmentId)) {
			throw new SessionChainLifecycleTransitionError("branch Segment already exists");
		}
		if (
			payload.segment.location.kind !== "managed" ||
			payload.segment.ordinal !== 1 ||
			payload.segment.predecessorSegmentId !== payload.sourceSegmentId
		) {
			throw new SessionChainLifecycleTransitionError("branch root Segment is invalid");
		}
		branches.push({
			branchId: payload.branchId,
			createdAt: event.timestamp,
			forkedFrom: {
				branchId: payload.fromBranchId,
				segmentId: payload.sourceSegmentId,
				entryId: payload.sourceEntryId,
			},
			headSegmentId: payload.segment.segmentId,
			segments: [{ ...cloneSegment(payload.segment), status: "active" }],
			rollups: [],
			rollupFailures: [],
		});
		return title;
	}
	if (event.eventType === "rollup_published") {
		const payload = event.payload;
		const branch = requireBranch(branches, payload.branchId);
		if (branch.rollups.some((rollup) => rollup.windowIndex === payload.windowIndex)) {
			throw new SessionChainLifecycleTransitionError(`Rollup window already exists: ${payload.windowIndex}`);
		}
		const previous = branch.rollups.at(-1);
		const expectedWindow = (previous?.windowIndex ?? 0) + 1;
		const expectedStart = (previous?.endOrdinal ?? 0) + 1;
		if (payload.windowIndex !== expectedWindow || payload.startOrdinal !== expectedStart) {
			throw new SessionChainLifecycleTransitionError("Rollup windows must be contiguous and ordered");
		}
		for (let ordinal = payload.startOrdinal; ordinal <= payload.endOrdinal; ordinal++) {
			const segment = branch.segments.find((candidate) => candidate.ordinal === ordinal);
			if (!segment || segment.status !== "sealed" || !segment.seal) {
				throw new SessionChainLifecycleTransitionError(`Rollup source Segment S${ordinal} is not sealed`);
			}
		}
		branch.rollups.push({ ...payload, eventId: event.eventId, publishedAt: event.timestamp });
		return title;
	}
	if (event.eventType === "rollup_failed") {
		const payload = event.payload;
		const branch = requireBranch(branches, payload.branchId);
		branch.rollupFailures.push({ ...payload, eventId: event.eventId, failedAt: event.timestamp });
		return title;
	}
	if (event.eventType === "chain_metadata_updated") return event.payload.title;
	if (event.eventType === "chain_archive_updated") return title;
	throw new SessionChainLifecycleTransitionError("chain_created may only be the first event");
}

function project(events: readonly SessionChainEvent[]): {
	spec: SessionChainSpecV1;
	title: string | null;
	archived: boolean;
	branches: SessionBranchProjectionV1[];
} {
	const created = events[0];
	if (!created || created.eventType !== "chain_created") {
		throw new SessionChainCorruptionError("Session Chain event log must begin with chain_created");
	}
	const spec = created.payload.spec;
	const branches: SessionBranchProjectionV1[] = [
		{
			branchId: spec.rootBranchId,
			createdAt: spec.createdAt,
			forkedFrom: null,
			headSegmentId: spec.rootSegment.segmentId,
			segments: [{ ...cloneSegment(spec.rootSegment), status: "active" }],
			rollups: [],
			rollupFailures: [],
		},
	];
	let title = spec.title;
	let archived = false;
	for (const event of events.slice(1)) {
		title = applyEvent(branches, title, event);
		if (event.eventType === "chain_archive_updated") archived = event.payload.archived;
	}
	return { spec, title, archived, branches };
}

function replayRaw(chainId: string, raw: string): SessionChainReplay {
	const hasPartial = raw.length > 0 && !raw.endsWith("\n");
	const validRaw = hasPartial ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
	const lines = validRaw.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) throw new SessionChainNotFoundError(chainId);
	const events = lines.map((line, index) => {
		try {
			return parseEvent(JSON.parse(line) as unknown, index + 1);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new SessionChainCorruptionError(`Session Chain event ${index + 1} is not valid JSON`);
			}
			throw error;
		}
	});
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event || event.chainId !== chainId || event.sequence !== index + 1) {
			throw new SessionChainCorruptionError(`Session Chain event ${index + 1} breaks identity or sequence`);
		}
		const expectedPrev = index === 0 ? null : events[index - 1]?.hash;
		if (event.prevHash !== expectedPrev) {
			throw new SessionChainCorruptionError(`Session Chain event ${index + 1} breaks the hash chain`);
		}
	}
	const projected = project(events);
	return {
		chainId,
		spec: projected.spec,
		head: headFor(events[events.length - 1] as SessionChainEvent),
		events,
		title: projected.title,
		archived: projected.archived,
		branches: projected.branches.map(cloneBranch),
		...(hasPartial ? { tailDiagnostic: { discardedBytes: Buffer.byteLength(raw.slice(validRaw.length)) } } : {}),
	};
}

function applyEventTail(chainId: string, readModel: SessionChainReadModelV1, raw: string): SessionChainReadModelV1 {
	if (raw.length === 0) return readModel;
	if (!raw.endsWith("\n")) {
		throw new SessionChainCorruptionError("Session Chain event tail is incomplete");
	}
	const lines = raw.split("\n").filter((line) => line.length > 0);
	const branches = readModel.branches.map(cloneBranch);
	let title = readModel.title;
	let archived = readModel.archived;
	let previousHash = readModel.baseHash;
	let sequence = readModel.sequence;
	let updatedAt = readModel.updatedAt;
	for (const line of lines) {
		let event: SessionChainEvent;
		try {
			event = parseEvent(JSON.parse(line) as unknown, sequence + 1);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new SessionChainCorruptionError(`Session Chain event ${sequence + 1} is not valid JSON`);
			}
			throw error;
		}
		if (event.chainId !== chainId || event.sequence !== sequence + 1 || event.prevHash !== previousHash) {
			throw new SessionChainCorruptionError(`Session Chain event ${sequence + 1} breaks the incremental tail`);
		}
		title = applyEvent(branches, title, event);
		if (event.eventType === "chain_archive_updated") archived = event.payload.archived;
		sequence = event.sequence;
		previousHash = event.hash;
		updatedAt = event.timestamp;
	}
	return {
		...readModel,
		sequence,
		baseHash: previousHash,
		title,
		archived,
		updatedAt,
		branches,
	};
}

function sameIdempotentContent(existing: SessionChainEvent, proposed: SessionChainEvent): boolean {
	return (
		existing.chainId === proposed.chainId &&
		existing.eventType === proposed.eventType &&
		stableJsonStringify(existing.payload) === stableJsonStringify(proposed.payload)
	);
}

export class SessionChainStore {
	private readonly projectRoot: string;
	private readonly sessionsDirectory: string;
	private readonly chainsDirectory: string;
	private readonly catalogPath: string;
	private readonly catalogLocksDirectory: string;
	private readonly artifacts: ArtifactStore;

	constructor(projectRoot: string) {
		this.projectRoot = resolve(projectRoot);
		this.sessionsDirectory = join(this.projectRoot, ".pi-xk", "sessions");
		this.chainsDirectory = join(this.sessionsDirectory, "chains");
		this.catalogPath = join(this.sessionsDirectory, "catalog.json");
		this.catalogLocksDirectory = join(this.sessionsDirectory, "locks");
		this.artifacts = new ArtifactStore(this.projectRoot);
	}

	private paths(chainId: string): SessionChainPaths {
		assertSessionChainId(chainId);
		const chainDirectory = join(this.chainsDirectory, chainId);
		if (basename(chainDirectory) !== chainId) {
			throw new SessionChainValidationError("chainId resolves outside the Session Chain directory");
		}
		const locksDirectory = join(chainDirectory, "locks");
		return {
			chainDirectory,
			eventsPath: join(chainDirectory, "events.jsonl"),
			readModelPath: join(chainDirectory, "chain-read-model.json"),
			readModelCheckpointPath: join(chainDirectory, "chain-read-model.checkpoint.json"),
			locksDirectory,
			lockPath: join(locksDirectory, "write.lock"),
		};
	}

	private rollupGenerationLockPaths(
		chainId: string,
		branchId: string,
		windowIndex: number,
	): { directory: string; lockPath: string; label: string } {
		const paths = this.paths(chainId);
		assertSessionBranchId(branchId);
		if (!Number.isInteger(windowIndex) || windowIndex <= 0) {
			throw new SessionChainValidationError("Rollup windowIndex must be a positive integer");
		}
		const directory = join(paths.chainDirectory, "branches", branchId, "rollups");
		return {
			directory,
			lockPath: join(directory, `${String(windowIndex).padStart(6, "0")}.generation.lock`),
			label: `${chainId}/${branchId}/W${windowIndex}`,
		};
	}

	private fileLockOptions(lockPath: string, lockDirectory: string, label: string): FileWriteLockOptions {
		return {
			directory: lockDirectory,
			lockPath,
			recoveryLockPath: join(lockDirectory, `${basename(lockPath, ".lock")}.recovery.lock`),
			error: (failure: WriteLockFailure) => {
				if (failure.kind === "locked") return new SessionChainLockedError(label);
				if (failure.kind === "recovery-locked") {
					return new SessionChainLockedError(label, "recovering its write lock");
				}
				if (failure.kind === "conflict") return new SessionChainLockRecoveryConflictError(label);
				if (failure.kind === "malformed") {
					return new SessionChainLockRecoveryError(label, "the lock metadata is malformed");
				}
				return new SessionChainLockRecoveryError(label, `the owner is ${failure.ownerState}`);
			},
		};
	}

	private async withFileLock<TResult>(
		lockPath: string,
		lockDirectory: string,
		label: string,
		action: () => Promise<TResult>,
	): Promise<TResult> {
		return await withFileWriteLock(this.fileLockOptions(lockPath, lockDirectory, label), action);
	}

	private async replaceFile(path: string, directory: string, content: string): Promise<void> {
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await syncDirectory(directory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async appendEvent(paths: SessionChainPaths, event: SessionChainEvent): Promise<void> {
		const handle = await open(paths.eventsPath, "a", 0o600);
		try {
			await handle.writeFile(`${stableJsonStringify(event)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async readReplay(paths: SessionChainPaths, chainId: string): Promise<SessionChainReplay> {
		try {
			return replayRaw(chainId, await readFile(paths.eventsPath, "utf8"));
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new SessionChainNotFoundError(chainId);
			throw error;
		}
	}

	private async writeReadModel(
		paths: SessionChainPaths,
		replay: SessionChainReplay,
	): Promise<SessionChainReadModelV1> {
		const readModel = buildSessionChainReadModel(replay);
		await this.writeReadModelProjection(paths, readModel, (await stat(paths.eventsPath)).size);
		return readModel;
	}

	private async writeReadModelProjection(
		paths: SessionChainPaths,
		readModel: SessionChainReadModelV1,
		byteOffset: number,
	): Promise<void> {
		await this.replaceFile(paths.readModelPath, paths.chainDirectory, `${JSON.stringify(readModel, null, "\t")}\n`);
		await this.writeReadModelCheckpoint(paths, readModel, byteOffset);
	}

	private async writeReadModelCheckpoint(
		paths: SessionChainPaths,
		readModel: SessionChainReadModelV1,
		byteOffset: number,
	): Promise<void> {
		const headEventOffset = await this.findHeadEventOffset(paths, byteOffset);
		const checkpoint: SessionChainReadModelCheckpointV1 = {
			schema: "pi-xk.session-chain-read-model-checkpoint.v1",
			headEventOffset,
			byteOffset,
			sequence: readModel.sequence,
			headHash: readModel.baseHash,
			readModelDigest: readModelDigest(readModel),
		};
		await this.replaceFile(
			paths.readModelCheckpointPath,
			paths.chainDirectory,
			`${JSON.stringify(checkpoint, null, "\t")}\n`,
		);
	}

	private async findHeadEventOffset(paths: SessionChainPaths, byteOffset: number): Promise<number> {
		if (byteOffset <= 0) throw new SessionChainCorruptionError("Session Chain event log has no checkpoint head");
		const handle = await open(paths.eventsPath, "r");
		try {
			const fileSize = (await handle.stat()).size;
			if (fileSize < byteOffset) {
				throw new SessionChainCorruptionError("Session Chain event log is shorter than its read model");
			}
			const terminator = Buffer.alloc(1);
			if ((await handle.read(terminator, 0, 1, byteOffset - 1)).bytesRead !== 1 || terminator[0] !== 0x0a) {
				throw new SessionChainCorruptionError("Session Chain checkpoint head event is incomplete");
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

	private async readStoredReadModel(paths: SessionChainPaths, chainId: string): Promise<SessionChainReadModelV1> {
		try {
			const stored = validateSessionChainReadModel(
				JSON.parse(await readFile(paths.readModelPath, "utf8")) as unknown,
			);
			if (stored.chainId !== chainId) throw new SessionChainReadModelStaleError(chainId);
			return stored;
		} catch (error) {
			if (error instanceof SessionChainReadModelStaleError) throw error;
			throw new SessionChainReadModelStaleError(chainId);
		}
	}

	private async readStoredReadModelCheckpoint(
		paths: SessionChainPaths,
	): Promise<SessionChainReadModelCheckpointV1 | undefined> {
		try {
			return validateReadModelCheckpoint(
				JSON.parse(await readFile(paths.readModelCheckpointPath, "utf8")) as unknown,
			);
		} catch {
			return undefined;
		}
	}

	private async readEventBytesFrom(
		paths: SessionChainPaths,
		byteOffset: number,
	): Promise<{ bytes: Buffer; fileSize: number }> {
		const handle = await open(paths.eventsPath, "r");
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

	private verifyCheckpointHead(chainId: string, checkpoint: SessionChainReadModelCheckpointV1, raw: string): boolean {
		if (!raw.endsWith("\n")) return false;
		const lines = raw.split("\n").filter((line) => line.length > 0);
		if (lines.length !== 1 || !lines[0]) return false;
		try {
			const event = parseEvent(JSON.parse(lines[0]) as unknown, checkpoint.sequence);
			return (
				event.chainId === chainId && event.sequence === checkpoint.sequence && event.hash === checkpoint.headHash
			);
		} catch {
			return false;
		}
	}

	private async inspectReadModelFastPath(
		paths: SessionChainPaths,
		chainId: string,
	): Promise<(SessionChainReadModelLoadResult & { byteOffset: number }) | undefined> {
		const readModel = await this.readStoredReadModel(paths, chainId);
		const checkpoint = await this.readStoredReadModelCheckpoint(paths);
		if (
			!checkpoint ||
			checkpoint.sequence !== readModel.sequence ||
			checkpoint.headHash !== readModel.baseHash ||
			checkpoint.readModelDigest !== readModelDigest(readModel)
		) {
			return undefined;
		}
		const eventBytes = await this.readEventBytesFrom(paths, checkpoint.headEventOffset);
		if (eventBytes.fileSize < checkpoint.byteOffset) return undefined;
		const proofLength = checkpoint.byteOffset - checkpoint.headEventOffset;
		if (eventBytes.bytes.length < proofLength) return undefined;
		const headRaw = eventBytes.bytes.subarray(0, proofLength).toString("utf8");
		if (!this.verifyCheckpointHead(chainId, checkpoint, headRaw)) return undefined;
		const tailRaw = eventBytes.bytes.subarray(proofLength).toString("utf8");
		if (tailRaw.length === 0) {
			return {
				readModel,
				diagnostic: { mode: "fast", bytesRead: proofLength },
				byteOffset: checkpoint.byteOffset,
			};
		}
		try {
			return {
				readModel: applyEventTail(chainId, readModel, tailRaw),
				diagnostic: { mode: "tail", bytesRead: eventBytes.bytes.length },
				byteOffset: eventBytes.fileSize,
			};
		} catch {
			return undefined;
		}
	}

	private mutationMeta(
		chainId: string,
		options: SessionChainMutationOptions,
	): Pick<SessionChainEventWithoutHash, "eventId" | "chainId" | "actor" | "timestamp" | "idempotencyKey"> {
		return {
			eventId: validateSessionChainNonEmptyString(options.eventId, "eventId"),
			chainId,
			actor: validateSessionChainActor(options.actor ?? "runtime"),
			timestamp: validateSessionChainTimestamp(options.timestamp ?? new Date().toISOString(), "timestamp"),
			idempotencyKey: validateSessionChainNonEmptyString(options.idempotencyKey, "idempotencyKey"),
		};
	}

	private retry(replay: SessionChainReplay, proposed: SessionChainEvent): SessionChainWriteResult | undefined {
		const existing = replay.events.find((event) => event.idempotencyKey === proposed.idempotencyKey);
		if (!existing) return undefined;
		if (!sameIdempotentContent(existing, proposed)) {
			throw new SessionChainIdempotencyConflictError(proposed.idempotencyKey);
		}
		return { event: existing, head: headFor(existing) };
	}

	private assertAppendHead(
		expected: SessionChainHead,
		replay: SessionChainReplay,
		eventType: Exclude<SessionChainEventType, "chain_created">,
	): void {
		if (expected.sequence === replay.head.sequence && expected.hash === replay.head.hash) return;
		if (
			(eventType === "rollover_prepared" ||
				eventType === "rollover_committed" ||
				eventType === "rollover_aborted" ||
				eventType === "branch_created") &&
			replay.events[expected.sequence - 1]?.hash === expected.hash &&
			replay.events
				.slice(expected.sequence)
				.every((event) => event.eventType === "rollup_published" || event.eventType === "rollup_failed")
		) {
			// Rollup publication is derived branch metadata and may finish while a topology source is summarized.
			// The lifecycle projection below still validates the rollover or successor branch atomically.
			return;
		}
		throw new SessionChainHeadConflictError(expected, replay.head);
	}

	private async writeProjections(paths: SessionChainPaths, replay: SessionChainReplay): Promise<void> {
		const readModel = await this.writeReadModel(paths, replay);
		await this.updateCatalogEntry(readModel);
	}

	async putSegmentSummary(summaryInput: SegmentSummary): Promise<string> {
		const summary = validateSegmentSummary(summaryInput);
		const metadata = await this.artifacts.put({
			contentType: "application/json",
			value: summary,
			producer: summary.schema,
			sensitivity: "internal",
			sourceIds: [summary.chainId, summary.sourceSegmentId, summary.targetSegmentId],
			createdAt: summary.generator.generatedAt,
		});
		return metadata.artifactId;
	}

	async readSegmentSummary(artifactId: string): Promise<SegmentSummary> {
		assertSessionChainArtifactId(artifactId, "artifactId");
		const stored = await this.artifacts.read(artifactId);
		try {
			const summary = validateSegmentSummary(JSON.parse(stored.content) as unknown);
			if (stored.metadata.producer !== summary.schema) {
				throw new SessionChainValidationError("Segment summary artifact producer does not match its schema");
			}
			return summary;
		} catch (error) {
			throw new SessionChainCorruptionError(
				`Segment summary artifact is invalid: ${error instanceof Error ? error.message : artifactId}`,
			);
		}
	}

	async putChainRollup(rollupInput: SessionChainRollupV1): Promise<string> {
		const rollup = validateSessionChainRollupV1(rollupInput);
		const metadata = await this.artifacts.put({
			contentType: "application/json",
			value: rollup,
			producer: CHAIN_ROLLUP_SCHEMA,
			sensitivity: "internal",
			sourceIds: [rollup.chainId, rollup.branchId, ...rollup.segmentIds, ...rollup.summaryArtifactIds],
			createdAt: rollup.provenance.generatedAt,
		});
		return metadata.artifactId;
	}

	async readChainRollup(artifactId: string): Promise<SessionChainRollupV1> {
		assertSessionChainArtifactId(artifactId, "artifactId");
		const stored = await this.artifacts.read(artifactId);
		try {
			return validateSessionChainRollupV1(JSON.parse(stored.content) as unknown);
		} catch (error) {
			throw new SessionChainCorruptionError(
				`Session Chain Rollup artifact is invalid: ${error instanceof Error ? error.message : artifactId}`,
			);
		}
	}

	async findChainRollupArtifacts(input: {
		chainId: string;
		branchId: string;
		windowIndex: number;
		sourceDigest?: string;
	}): Promise<string[]> {
		assertSessionChainId(input.chainId);
		assertSessionBranchId(input.branchId);
		if (!Number.isInteger(input.windowIndex) || input.windowIndex <= 0) {
			throw new SessionChainValidationError("Rollup windowIndex must be positive");
		}
		if (input.sourceDigest !== undefined) assertSessionChainHash(input.sourceDigest, "sourceDigest");
		const objectsDirectory = join(this.projectRoot, ".pi-xk", "artifacts", "objects");
		let prefixes: Dirent[];
		try {
			prefixes = await readdir(objectsDirectory, { withFileTypes: true });
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
		const matches: string[] = [];
		for (const prefix of prefixes
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const directory = join(objectsDirectory, prefix.name);
			const files = (await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
				.sort((left, right) => left.name.localeCompare(right.name));
			for (const file of files) {
				let metadata: ReturnType<typeof validateArtifactMetadata>;
				try {
					metadata = validateArtifactMetadata(
						JSON.parse(await readFile(join(directory, file.name), "utf8")) as unknown,
					);
				} catch {
					continue;
				}
				if (metadata.producer !== CHAIN_ROLLUP_SCHEMA) continue;
				let rollup: SessionChainRollupV1;
				try {
					rollup = await this.readChainRollup(metadata.artifactId);
				} catch {
					continue;
				}
				if (
					rollup.chainId === input.chainId &&
					rollup.branchId === input.branchId &&
					rollup.windowIndex === input.windowIndex &&
					(input.sourceDigest === undefined || rollup.sourceDigest === input.sourceDigest)
				) {
					matches.push(metadata.artifactId);
				}
			}
		}
		return matches.sort();
	}

	async createChain(
		specInput: SessionChainSpecV1,
		options: SessionChainMutationOptions,
	): Promise<SessionChainWriteResult> {
		const spec = validateSessionChainSpecV1(specInput);
		const paths = this.paths(spec.chainId);
		return await this.withFileLock(paths.lockPath, paths.locksDirectory, spec.chainId, async () => {
			const event = createEvent({
				schema: SESSION_CHAIN_EVENT_SCHEMA,
				...this.mutationMeta(spec.chainId, options),
				sequence: 1,
				eventType: "chain_created",
				prevHash: null,
				payload: { spec },
				schemaVersion: 1,
			});
			let existing: SessionChainReplay | undefined;
			try {
				existing = await this.readReplay(paths, spec.chainId);
			} catch (error) {
				if (!(error instanceof SessionChainNotFoundError)) throw error;
			}
			if (existing) {
				if (existing.tailDiagnostic) throw new SessionChainRecoveryRequiredError(spec.chainId);
				const retry = this.retry(existing, event);
				if (retry) {
					await this.writeProjections(paths, existing);
					return retry;
				}
				throw new SessionChainAlreadyExistsError(spec.chainId);
			}
			await this.replaceFile(paths.eventsPath, paths.chainDirectory, `${stableJsonStringify(event)}\n`);
			const replay = replayRaw(spec.chainId, `${stableJsonStringify(event)}\n`);
			await this.writeProjections(paths, replay);
			return { event, head: replay.head };
		});
	}

	async appendRolloverPrepared(
		chainId: string,
		payloadInput: RolloverPreparedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		const payload = validatePreparedPayload(payloadInput);
		const summary = await this.readSegmentSummary(payload.summaryArtifactId);
		if (
			summary.chainId !== chainId ||
			summary.branchId !== payload.branchId ||
			summary.sourceSegmentId !== payload.sourceSegmentId ||
			summary.sourceLeafId !== payload.sourceLeafId ||
			summary.sourceRange.lastEntryId !== payload.sourceLeafId ||
			summary.targetSegmentId !== payload.targetSegment.segmentId
		) {
			throw new SessionChainValidationError("Segment summary identity does not match the prepared rollover");
		}
		return await this.append(chainId, "rollover_prepared", payload, options);
	}

	async appendRolloverCommitted(
		chainId: string,
		payloadInput: RolloverCommittedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "rollover_committed", validateCommittedPayload(payloadInput), options);
	}

	async appendRolloverAborted(
		chainId: string,
		payloadInput: RolloverAbortedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "rollover_aborted", validateAbortedPayload(payloadInput), options);
	}

	async appendBranchCreated(
		chainId: string,
		payloadInput: BranchCreatedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "branch_created", validateBranchPayload(payloadInput), options);
	}

	async appendMetadataUpdated(
		chainId: string,
		payloadInput: ChainMetadataUpdatedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "chain_metadata_updated", validateMetadataPayload(payloadInput), options);
	}

	async appendArchiveUpdated(
		chainId: string,
		payloadInput: ChainArchiveUpdatedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "chain_archive_updated", validateArchivePayload(payloadInput), options, 3);
	}

	async appendRollupPublished(
		chainId: string,
		payloadInput: RollupPublishedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		const payload = validateRollupPublishedPayload(payloadInput);
		const rollup = await this.readChainRollup(payload.artifactId);
		if (
			rollup.chainId !== chainId ||
			rollup.branchId !== payload.branchId ||
			rollup.windowIndex !== payload.windowIndex ||
			rollup.startOrdinal !== payload.startOrdinal ||
			rollup.endOrdinal !== payload.endOrdinal ||
			rollup.sourceDigest !== payload.sourceDigest
		) {
			throw new SessionChainValidationError("Rollup artifact identity does not match the published event");
		}
		return await this.append(chainId, "rollup_published", payload, options, 2);
	}

	async appendRollupFailed(
		chainId: string,
		payloadInput: RollupFailedPayloadV1,
		options: SessionChainAppendOptions,
	): Promise<SessionChainWriteResult> {
		return await this.append(chainId, "rollup_failed", validateRollupFailedPayload(payloadInput), options, 2);
	}

	private async append(
		chainId: string,
		eventType: Exclude<SessionChainEventType, "chain_created">,
		payload: SessionChainEvent["payload"],
		options: SessionChainAppendOptions,
		schemaVersion: 1 | 2 | 3 = 1,
	): Promise<SessionChainWriteResult> {
		const paths = this.paths(chainId);
		return await this.withFileLock(paths.lockPath, paths.locksDirectory, chainId, async () => {
			const replay = await this.readReplay(paths, chainId);
			if (replay.tailDiagnostic) throw new SessionChainRecoveryRequiredError(chainId);
			const event = createEvent({
				schema:
					schemaVersion === 3
						? SESSION_CHAIN_EVENT_V3_SCHEMA
						: schemaVersion === 2
							? SESSION_CHAIN_EVENT_V2_SCHEMA
							: SESSION_CHAIN_EVENT_SCHEMA,
				...this.mutationMeta(chainId, options),
				sequence: replay.head.sequence + 1,
				eventType,
				prevHash: replay.head.hash,
				payload,
				schemaVersion,
			});
			const retry = this.retry(replay, event);
			if (retry) {
				await this.writeProjections(paths, replay);
				return retry;
			}
			this.assertAppendHead(options.expectedHead, replay, eventType);
			const nextEvents = [...replay.events, event];
			const projected = project(nextEvents);
			await this.appendEvent(paths, event);
			const next: SessionChainReplay = {
				chainId,
				spec: projected.spec,
				head: headFor(event),
				events: nextEvents,
				title: projected.title,
				archived: projected.archived,
				branches: projected.branches.map(cloneBranch),
			};
			await this.writeProjections(paths, next);
			return { event, head: next.head };
		});
	}

	async replayChain(chainId: string): Promise<SessionChainReplay> {
		return await this.readReplay(this.paths(chainId), chainId);
	}

	async inspectWriteLock(chainId: string): Promise<SessionChainWriteLockDiagnostic | undefined> {
		const paths = this.paths(chainId);
		return await inspectFileWriteLock(paths.lockPath);
	}

	async repairAbandonedWriteLock(chainId: string, expectedNonce: string): Promise<boolean> {
		assertSessionChainId(chainId);
		if (expectedNonce.trim().length === 0) {
			throw new SessionChainValidationError("expectedNonce must be non-empty");
		}
		const paths = this.paths(chainId);
		return await repairAbandonedFileWriteLock(
			this.fileLockOptions(paths.lockPath, paths.locksDirectory, chainId),
			expectedNonce,
		);
	}

	async withRollupGenerationLock<TResult>(
		chainId: string,
		branchId: string,
		windowIndex: number,
		action: () => Promise<TResult>,
	): Promise<TResult> {
		const paths = this.rollupGenerationLockPaths(chainId, branchId, windowIndex);
		return await this.withFileLock(paths.lockPath, paths.directory, paths.label, action);
	}

	async inspectRollupGenerationLock(
		chainId: string,
		branchId: string,
		windowIndex: number,
	): Promise<SessionChainWriteLockDiagnostic | undefined> {
		return await inspectFileWriteLock(this.rollupGenerationLockPaths(chainId, branchId, windowIndex).lockPath);
	}

	async repairAbandonedRollupGenerationLock(
		chainId: string,
		branchId: string,
		windowIndex: number,
		expectedNonce: string,
	): Promise<boolean> {
		if (expectedNonce.trim().length === 0) {
			throw new SessionChainValidationError("expectedNonce must be non-empty");
		}
		const paths = this.rollupGenerationLockPaths(chainId, branchId, windowIndex);
		return await repairAbandonedFileWriteLock(
			this.fileLockOptions(paths.lockPath, paths.directory, paths.label),
			expectedNonce,
		);
	}

	async loadChainReadModelSnapshot(chainId: string): Promise<SessionChainReadModelLoadResult> {
		const paths = this.paths(chainId);
		const initial = await this.inspectReadModelFastPath(paths, chainId);
		if (initial?.diagnostic.mode === "fast") {
			return { readModel: initial.readModel, diagnostic: initial.diagnostic };
		}
		return await this.withFileLock(paths.lockPath, paths.locksDirectory, chainId, async () => {
			const current = await this.inspectReadModelFastPath(paths, chainId);
			if (current) {
				if (current.diagnostic.mode === "tail") {
					await this.writeReadModelProjection(paths, current.readModel, current.byteOffset);
					await this.updateCatalogEntry(current.readModel);
				}
				return { readModel: current.readModel, diagnostic: current.diagnostic };
			}
			const stored = await this.readStoredReadModel(paths, chainId);
			const checkpoint = await this.readStoredReadModelCheckpoint(paths);
			let raw: string;
			try {
				raw = await readFile(paths.eventsPath, "utf8");
			} catch (error) {
				if (isErrno(error, "ENOENT")) throw new SessionChainNotFoundError(chainId);
				throw error;
			}
			const replay = replayRaw(chainId, raw);
			if (replay.tailDiagnostic) throw new SessionChainRecoveryRequiredError(chainId);
			const rebuilt = buildSessionChainReadModel(replay);
			const checkpointMatchesStored =
				checkpoint !== undefined &&
				checkpoint.sequence === stored.sequence &&
				checkpoint.headHash === stored.baseHash &&
				checkpoint.readModelDigest === readModelDigest(stored);
			const storedHeadStillExists = replay.events[stored.sequence - 1]?.hash === stored.baseHash;
			if (
				!sameSessionChainReadModel(stored, rebuilt) &&
				!(checkpointMatchesStored && storedHeadStillExists && rebuilt.sequence >= stored.sequence)
			) {
				throw new SessionChainReadModelStaleError(chainId);
			}
			await this.writeReadModelProjection(paths, rebuilt, Buffer.byteLength(raw));
			await this.updateCatalogEntry(rebuilt);
			return { readModel: rebuilt, diagnostic: { mode: "full", bytesRead: Buffer.byteLength(raw) } };
		});
	}

	async loadChainReadModel(chainId: string): Promise<SessionChainReadModelV1> {
		return (await this.loadChainReadModelSnapshot(chainId)).readModel;
	}

	async rebuildChainReadModel(chainId: string): Promise<SessionChainReadModelV1> {
		const paths = this.paths(chainId);
		return await this.withFileLock(paths.lockPath, paths.locksDirectory, chainId, async () => {
			const replay = await this.readReplay(paths, chainId);
			if (replay.tailDiagnostic) throw new SessionChainRecoveryRequiredError(chainId);
			return await this.writeReadModel(paths, replay);
		});
	}

	private async buildCatalog(): Promise<SessionChainCatalogV1> {
		let chainIds: string[];
		try {
			chainIds = (await readdir(this.chainsDirectory, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("chain_"))
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			if (isErrno(error, "ENOENT")) {
				return { schema: SESSION_CHAIN_CATALOG_SCHEMA, updatedAt: null, chains: [] };
			}
			throw error;
		}
		const chains: SessionChainCatalogEntryV1[] = [];
		for (const chainId of chainIds) {
			let replay: SessionChainReplay;
			try {
				replay = await this.readReplay(this.paths(chainId), chainId);
			} catch (error) {
				if (error instanceof SessionChainNotFoundError) continue;
				throw error;
			}
			if (replay.tailDiagnostic) throw new SessionChainRecoveryRequiredError(chainId);
			chains.push({
				chainId,
				title: replay.title,
				archived: replay.archived,
				cwd: replay.spec.cwd,
				sequence: replay.head.sequence,
				baseHash: replay.head.hash,
				createdAt: replay.spec.createdAt,
				updatedAt: replay.events.at(-1)?.timestamp ?? replay.spec.createdAt,
				branchHeads: replay.branches
					.map((branch) => ({ branchId: branch.branchId, segmentId: branch.headSegmentId }))
					.sort((left, right) => left.branchId.localeCompare(right.branchId)),
			});
		}
		return {
			schema: SESSION_CHAIN_CATALOG_SCHEMA,
			updatedAt: chains.reduce<string | null>(
				(latest, chain) => (latest === null || chain.updatedAt > latest ? chain.updatedAt : latest),
				null,
			),
			chains,
		};
	}

	private async updateCatalogEntry(readModel: SessionChainReadModelV1): Promise<SessionChainCatalogV1> {
		const lockPath = join(this.catalogLocksDirectory, "catalog.write.lock");
		return await this.withFileLock(lockPath, this.catalogLocksDirectory, "catalog", async () => {
			let catalog: SessionChainCatalogV1;
			try {
				catalog = validateCatalog(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown);
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw new SessionChainReadModelStaleError("catalog");
				const chainDirectories = (await readdir(this.chainsDirectory, { withFileTypes: true })).filter(
					(entry) => entry.isDirectory() && entry.name.startsWith("chain_"),
				);
				if (chainDirectories.some((entry) => entry.name !== readModel.chainId)) {
					throw new SessionChainReadModelStaleError("catalog");
				}
				catalog = { schema: SESSION_CHAIN_CATALOG_SCHEMA, updatedAt: null, chains: [] };
			}
			const entry = catalogEntryFromReadModel(readModel);
			const chains = [...catalog.chains.filter((candidate) => candidate.chainId !== entry.chainId), entry].sort(
				(left, right) => left.chainId.localeCompare(right.chainId),
			);
			const next: SessionChainCatalogV1 = {
				schema: SESSION_CHAIN_CATALOG_SCHEMA,
				updatedAt: chains.reduce<string | null>(
					(latest, candidate) => (latest === null || candidate.updatedAt > latest ? candidate.updatedAt : latest),
					null,
				),
				chains,
			};
			await this.replaceFile(this.catalogPath, this.sessionsDirectory, `${JSON.stringify(next, null, "\t")}\n`);
			return next;
		});
	}

	private async refreshCatalog(): Promise<SessionChainCatalogV1> {
		const lockPath = join(this.catalogLocksDirectory, "catalog.write.lock");
		return await this.withFileLock(lockPath, this.catalogLocksDirectory, "catalog", async () => {
			const catalog = await this.buildCatalog();
			await this.replaceFile(this.catalogPath, this.sessionsDirectory, `${JSON.stringify(catalog, null, "\t")}\n`);
			return catalog;
		});
	}

	async rebuildCatalog(): Promise<SessionChainCatalogV1> {
		return await this.refreshCatalog();
	}

	async loadCatalog(): Promise<SessionChainCatalogV1> {
		try {
			return validateCatalog(JSON.parse(await readFile(this.catalogPath, "utf8")) as unknown);
		} catch {
			throw new SessionChainReadModelStaleError("catalog");
		}
	}

	async listChains(): Promise<SessionChainCatalogEntryV1[]> {
		return (await this.loadCatalog()).chains;
	}

	async repairTrailingPartialEvent(chainId: string): Promise<SessionChainReplay> {
		const paths = this.paths(chainId);
		return await this.withFileLock(paths.lockPath, paths.locksDirectory, chainId, async () => {
			const raw = await readFile(paths.eventsPath, "utf8");
			const replay = replayRaw(chainId, raw);
			if (!replay.tailDiagnostic) return replay;
			await this.replaceFile(paths.eventsPath, paths.chainDirectory, raw.slice(0, raw.lastIndexOf("\n") + 1));
			const repaired = await this.readReplay(paths, chainId);
			await this.writeProjections(paths, repaired);
			return repaired;
		});
	}
}
