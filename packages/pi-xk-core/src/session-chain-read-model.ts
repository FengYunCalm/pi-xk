import {
	assertSessionBranchId,
	assertSessionChainArtifactId,
	assertSessionChainHash,
	assertSessionChainId,
	assertSessionSegmentId,
	isSessionChainRecord,
	type PendingRolloverProjectionV1,
	SESSION_CHAIN_READ_MODEL_SCHEMA,
	type SessionBranchProjectionV1,
	type SessionChainReadModelV1,
	type SessionChainRollupFailureProjectionV1,
	type SessionChainRollupProjectionV1,
	SessionChainValidationError,
	type SessionSegmentProjectionV1,
	validateSessionChainExactKeys,
	validateSessionChainNonEmptyString,
	validateSessionChainNonNegativeInteger,
	validateSessionChainTimestamp,
	validateSessionChainTitle,
	validateSessionSegmentDescriptorV1,
} from "./session-chain-contract.ts";
import type { SessionChainReplay } from "./session-chain-store.ts";
import { stableJsonStringify } from "./stable-json.ts";

export class SessionChainReadModelStaleError extends Error {
	constructor(chainId: string) {
		super(`Session Chain read model is stale or no longer matches facts: ${chainId}`);
		this.name = "SessionChainReadModelStaleError";
	}
}

function cloneBranch(branch: SessionBranchProjectionV1): SessionBranchProjectionV1 {
	return {
		branchId: branch.branchId,
		createdAt: branch.createdAt,
		forkedFrom: branch.forkedFrom ? { ...branch.forkedFrom } : null,
		headSegmentId: branch.headSegmentId,
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
						targetSegment: {
							...branch.pendingRollover.targetSegment,
							location: { ...branch.pendingRollover.targetSegment.location },
						},
					},
				}
			: {}),
	};
}

export function buildSessionChainReadModel(replay: SessionChainReplay): SessionChainReadModelV1 {
	return {
		schema: SESSION_CHAIN_READ_MODEL_SCHEMA,
		chainId: replay.chainId,
		sequence: replay.head.sequence,
		baseHash: replay.head.hash,
		title: replay.title,
		cwd: replay.spec.cwd,
		createdAt: replay.spec.createdAt,
		updatedAt: replay.events.at(-1)?.timestamp ?? replay.spec.createdAt,
		branches: replay.branches.map(cloneBranch),
	};
}

function validateSeal(value: unknown): NonNullable<SessionSegmentProjectionV1["seal"]> {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Segment seal must be an object");
	validateSessionChainExactKeys(
		value,
		["bytes", "fileHash", "leafId", "summaryArtifactId", "summaryOutEntryId"],
		"Segment seal",
	);
	return {
		bytes: validateSessionChainNonNegativeInteger(value.bytes, "Segment seal bytes"),
		fileHash: assertSessionChainHash(value.fileHash, "Segment seal fileHash"),
		leafId: validateSessionChainNonEmptyString(value.leafId, "Segment seal leafId"),
		summaryArtifactId: assertSessionChainArtifactId(value.summaryArtifactId, "Segment seal summaryArtifactId"),
		summaryOutEntryId: validateSessionChainNonEmptyString(value.summaryOutEntryId, "Segment seal summaryOutEntryId"),
	};
}

function validateSegmentProjection(value: unknown): SessionSegmentProjectionV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Segment projection must be an object");
	const allowed = [
		"segmentId",
		"ordinal",
		"location",
		"predecessorSegmentId",
		"summaryInArtifactId",
		"createdAt",
		"status",
		"seal",
	];
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new SessionChainValidationError("Segment projection has unknown fields");
	}
	const descriptor = validateSessionSegmentDescriptorV1({
		segmentId: value.segmentId,
		ordinal: value.ordinal,
		location: value.location,
		predecessorSegmentId: value.predecessorSegmentId,
		summaryInArtifactId: value.summaryInArtifactId,
		createdAt: value.createdAt,
	});
	const status = validateSessionChainNonEmptyString(value.status, "Segment status");
	if (status !== "active" && status !== "prepared" && status !== "sealed") {
		throw new SessionChainValidationError("Segment status is invalid");
	}
	const seal = value.seal === undefined ? undefined : validateSeal(value.seal);
	if ((status === "sealed") !== (seal !== undefined)) {
		throw new SessionChainValidationError("Only sealed Segments may contain seal metadata");
	}
	return { ...descriptor, status, ...(seal ? { seal } : {}) };
}

function validatePendingRollover(value: unknown): PendingRolloverProjectionV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("pendingRollover must be an object");
	validateSessionChainExactKeys(
		value,
		["eventId", "preparedAt", "sourceSegmentId", "sourceLeafId", "targetSegment", "summaryArtifactId", "reason"],
		"pendingRollover",
	);
	const sourceSegmentId = validateSessionChainNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	assertSessionSegmentId(sourceSegmentId);
	return {
		eventId: validateSessionChainNonEmptyString(value.eventId, "pendingRollover.eventId"),
		preparedAt: validateSessionChainTimestamp(value.preparedAt, "pendingRollover.preparedAt"),
		sourceSegmentId,
		sourceLeafId: validateSessionChainNonEmptyString(value.sourceLeafId, "pendingRollover.sourceLeafId"),
		targetSegment: validateSessionSegmentDescriptorV1(value.targetSegment),
		summaryArtifactId: assertSessionChainArtifactId(value.summaryArtifactId, "pendingRollover.summaryArtifactId"),
		reason: validateSessionChainNonEmptyString(value.reason, "pendingRollover.reason"),
	};
}

function positiveInteger(value: unknown, field: string): number {
	const number = validateSessionChainNonNegativeInteger(value, field);
	if (number === 0) throw new SessionChainValidationError(`${field} must be positive`);
	return number;
}

function validateRollupProjection(value: unknown): SessionChainRollupProjectionV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Rollup projection must be an object");
	validateSessionChainExactKeys(
		value,
		["branchId", "windowIndex", "startOrdinal", "endOrdinal", "artifactId", "sourceDigest", "eventId", "publishedAt"],
		"Rollup projection",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "Rollup branchId");
	assertSessionBranchId(branchId);
	return {
		branchId,
		windowIndex: positiveInteger(value.windowIndex, "Rollup windowIndex"),
		startOrdinal: positiveInteger(value.startOrdinal, "Rollup startOrdinal"),
		endOrdinal: positiveInteger(value.endOrdinal, "Rollup endOrdinal"),
		artifactId: assertSessionChainArtifactId(value.artifactId, "Rollup artifactId"),
		sourceDigest: assertSessionChainHash(value.sourceDigest, "Rollup sourceDigest"),
		eventId: validateSessionChainNonEmptyString(value.eventId, "Rollup eventId"),
		publishedAt: validateSessionChainTimestamp(value.publishedAt, "Rollup publishedAt"),
	};
}

function validateRollupFailure(value: unknown): SessionChainRollupFailureProjectionV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("Rollup failure must be an object");
	validateSessionChainExactKeys(
		value,
		[
			"branchId",
			"windowIndex",
			"startOrdinal",
			"endOrdinal",
			"stage",
			"errorCode",
			"retryable",
			"attempt",
			"eventId",
			"failedAt",
		],
		"Rollup failure",
	);
	const branchId = validateSessionChainNonEmptyString(value.branchId, "Rollup failure branchId");
	assertSessionBranchId(branchId);
	if (typeof value.retryable !== "boolean") {
		throw new SessionChainValidationError("Rollup failure retryable must be a boolean");
	}
	return {
		branchId,
		windowIndex: positiveInteger(value.windowIndex, "Rollup failure windowIndex"),
		startOrdinal: positiveInteger(value.startOrdinal, "Rollup failure startOrdinal"),
		endOrdinal: positiveInteger(value.endOrdinal, "Rollup failure endOrdinal"),
		stage: validateSessionChainNonEmptyString(value.stage, "Rollup failure stage"),
		errorCode: validateSessionChainNonEmptyString(value.errorCode, "Rollup failure errorCode"),
		retryable: value.retryable,
		attempt: positiveInteger(value.attempt, "Rollup failure attempt"),
		eventId: validateSessionChainNonEmptyString(value.eventId, "Rollup failure eventId"),
		failedAt: validateSessionChainTimestamp(value.failedAt, "Rollup failure failedAt"),
	};
}

function validateBranch(value: unknown): SessionBranchProjectionV1 {
	if (!isSessionChainRecord(value)) throw new SessionChainValidationError("branch projection must be an object");
	const allowed = [
		"branchId",
		"createdAt",
		"forkedFrom",
		"headSegmentId",
		"segments",
		"rollups",
		"rollupFailures",
		"pendingRollover",
	];
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new SessionChainValidationError("branch projection has unknown fields");
	}
	for (const required of [
		"branchId",
		"createdAt",
		"forkedFrom",
		"headSegmentId",
		"segments",
		"rollups",
		"rollupFailures",
	]) {
		if (!(required in value)) throw new SessionChainValidationError("branch projection has missing fields");
	}
	const branchId = validateSessionChainNonEmptyString(value.branchId, "branchId");
	assertSessionBranchId(branchId);
	const headSegmentId = validateSessionChainNonEmptyString(value.headSegmentId, "headSegmentId");
	assertSessionSegmentId(headSegmentId);
	let forkedFrom: SessionBranchProjectionV1["forkedFrom"] = null;
	if (value.forkedFrom !== null) {
		if (!isSessionChainRecord(value.forkedFrom)) {
			throw new SessionChainValidationError("forkedFrom must be an object or null");
		}
		validateSessionChainExactKeys(value.forkedFrom, ["branchId", "segmentId", "entryId"], "forkedFrom");
		const fromBranchId = validateSessionChainNonEmptyString(value.forkedFrom.branchId, "forkedFrom.branchId");
		const segmentId = validateSessionChainNonEmptyString(value.forkedFrom.segmentId, "forkedFrom.segmentId");
		assertSessionBranchId(fromBranchId);
		assertSessionSegmentId(segmentId);
		forkedFrom = {
			branchId: fromBranchId,
			segmentId,
			entryId: validateSessionChainNonEmptyString(value.forkedFrom.entryId, "forkedFrom.entryId"),
		};
	}
	if (!Array.isArray(value.segments) || value.segments.length === 0) {
		throw new SessionChainValidationError("branch segments must be a non-empty array");
	}
	const segments = value.segments.map(validateSegmentProjection);
	if (!Array.isArray(value.rollups) || !Array.isArray(value.rollupFailures)) {
		throw new SessionChainValidationError("branch Rollup projections must be arrays");
	}
	if (!segments.some((segment) => segment.segmentId === headSegmentId)) {
		throw new SessionChainValidationError("branch headSegmentId is not present in segments");
	}
	return {
		branchId,
		createdAt: validateSessionChainTimestamp(value.createdAt, "branch.createdAt"),
		forkedFrom,
		headSegmentId,
		segments,
		rollups: value.rollups.map(validateRollupProjection),
		rollupFailures: value.rollupFailures.map(validateRollupFailure),
		...(value.pendingRollover === undefined
			? {}
			: { pendingRollover: validatePendingRollover(value.pendingRollover) }),
	};
}

export function validateSessionChainReadModel(value: unknown): SessionChainReadModelV1 {
	if (!isSessionChainRecord(value))
		throw new SessionChainValidationError("Session Chain read model must be an object");
	validateSessionChainExactKeys(
		value,
		["schema", "chainId", "sequence", "baseHash", "title", "cwd", "createdAt", "updatedAt", "branches"],
		"Session Chain read model",
	);
	if (value.schema !== SESSION_CHAIN_READ_MODEL_SCHEMA) {
		throw new SessionChainValidationError("Session Chain read model schema is unsupported");
	}
	const chainId = validateSessionChainNonEmptyString(value.chainId, "chainId");
	assertSessionChainId(chainId);
	const sequence = validateSessionChainNonNegativeInteger(value.sequence, "sequence");
	if (sequence === 0) throw new SessionChainValidationError("sequence must be positive");
	if (!Array.isArray(value.branches) || value.branches.length === 0) {
		throw new SessionChainValidationError("branches must be a non-empty array");
	}
	return {
		schema: SESSION_CHAIN_READ_MODEL_SCHEMA,
		chainId,
		sequence,
		baseHash: assertSessionChainHash(value.baseHash, "baseHash"),
		title: validateSessionChainTitle(value.title),
		cwd: validateSessionChainNonEmptyString(value.cwd, "cwd"),
		createdAt: validateSessionChainTimestamp(value.createdAt, "createdAt"),
		updatedAt: validateSessionChainTimestamp(value.updatedAt, "updatedAt"),
		branches: value.branches.map(validateBranch),
	};
}

export function sameSessionChainReadModel(left: SessionChainReadModelV1, right: SessionChainReadModelV1): boolean {
	return stableJsonStringify(left) === stableJsonStringify(right);
}
