import { isAbsolute } from "node:path";

export const SESSION_CHAIN_SPEC_SCHEMA = "pi-xk.session-chain.spec.v1";
export const SESSION_CHAIN_EVENT_SCHEMA = "pi-xk.session-chain-event.v1";
export const SESSION_CHAIN_EVENT_V2_SCHEMA = "pi-xk.session-chain-event.v2";
export const SESSION_CHAIN_EVENT_V3_SCHEMA = "pi-xk.session-chain-event.v3";
export const SESSION_CHAIN_READ_MODEL_SCHEMA = "pi-xk.session-chain-read-model.v1";
export const SESSION_CHAIN_CATALOG_SCHEMA = "pi-xk.session-chain-catalog.v1";
export const SEGMENT_SUMMARY_SCHEMA = "pi-xk.segment-summary.v1";
export const SEGMENT_SUMMARY_V2_SCHEMA = "pi-xk.segment-summary.v2";
export const CHAIN_ROLLUP_SCHEMA = "pi-xk.session-chain-rollup.v1";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CHAIN_ID_PATTERN = /^chain_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BRANCH_ID_PATTERN = /^branch_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SessionChainActor = "user" | "model" | "runtime" | "system";
export type SessionSegmentStatus = "active" | "prepared" | "sealed";

export type SessionSegmentLocationV1 =
	| { kind: "managed"; fileName: string }
	| { kind: "external-root"; absolutePath: string };

export interface SessionSegmentDescriptorV1 {
	segmentId: string;
	ordinal: number;
	location: SessionSegmentLocationV1;
	predecessorSegmentId: string | null;
	summaryInArtifactId: string | null;
	createdAt: string;
}

export interface SessionChainSpecV1 {
	schema: typeof SESSION_CHAIN_SPEC_SCHEMA;
	chainId: string;
	title: string | null;
	cwd: string;
	rootBranchId: string;
	rootSegment: SessionSegmentDescriptorV1;
	createdAt: string;
}

export interface SegmentSummarySourceRangeV1 {
	firstEntryId: string | null;
	lastEntryId: string;
	entryCount: number;
	entriesHash: string;
}

export interface SegmentSummaryGeneratorV1 {
	provider: string;
	modelId: string;
	promptVersion: string;
	inputTokens: number;
	outputTokens: number;
	generatedAt: string;
}

export interface SegmentSummaryV1 {
	schema: typeof SEGMENT_SUMMARY_SCHEMA;
	chainId: string;
	branchId: string;
	sourceSegmentId: string;
	sourceLeafId: string;
	targetSegmentId: string;
	baseSummaryArtifactId: string | null;
	sourceRange: SegmentSummarySourceRangeV1;
	segmentDeltaMarkdown: string;
	carryForwardMarkdown: string;
	generator: SegmentSummaryGeneratorV1;
}

export interface SegmentSummaryV2 {
	schema: typeof SEGMENT_SUMMARY_V2_SCHEMA;
	title: string;
	chainId: string;
	branchId: string;
	sourceSegmentId: string;
	sourceLeafId: string;
	targetSegmentId: string;
	baseSummaryArtifactId: string | null;
	sourceRange: SegmentSummarySourceRangeV1;
	segmentDeltaMarkdown: string;
	carryForwardMarkdown: string;
	generator: SegmentSummaryGeneratorV1;
}

export type SegmentSummary = SegmentSummaryV1 | SegmentSummaryV2;

export interface SessionChainRollupContentV1 {
	state: string;
	decisions: string[];
	constraints: string[];
	completed: string[];
	unresolved: string[];
	nextActions: string[];
}

export interface SessionChainRollupProvenanceV1 {
	generator: string;
	model: string;
	promptVersion: string;
	generatedAt: string;
}

/** Immutable Artifact Store body. The content-addressed artifact ID lives in events and read envelopes. */
export interface SessionChainRollupV1 {
	schema: typeof CHAIN_ROLLUP_SCHEMA;
	chainId: string;
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	segmentIds: string[];
	summaryArtifactIds: string[];
	sourceDigest: string;
	rollup: SessionChainRollupContentV1;
	provenance: SessionChainRollupProvenanceV1;
}

export interface RolloverPreparedPayloadV1 {
	branchId: string;
	sourceSegmentId: string;
	sourceLeafId: string;
	targetSegment: SessionSegmentDescriptorV1;
	summaryArtifactId: string;
	reason: string;
}

export interface SessionSegmentSealV1 {
	bytes: number;
	fileHash: string;
	leafId: string;
	summaryArtifactId: string;
	summaryOutEntryId: string;
}

export interface RolloverCommittedPayloadV1 {
	branchId: string;
	sourceSegmentId: string;
	targetSegmentId: string;
	sourceSeal: SessionSegmentSealV1;
	targetMarkers: {
		chainLinkEntryId: string;
		summaryInEntryId: string;
	};
}

export interface RolloverAbortedPayloadV1 {
	branchId: string;
	sourceSegmentId: string;
	targetSegmentId: string;
	reason: string;
}

export interface BranchCreatedPayloadV1 {
	branchId: string;
	fromBranchId: string;
	sourceSegmentId: string;
	sourceEntryId: string;
	segment: SessionSegmentDescriptorV1;
}

export interface ChainMetadataUpdatedPayloadV1 {
	title: string | null;
}

export interface ChainArchiveUpdatedPayloadV1 {
	archived: boolean;
}

export interface RollupPublishedPayloadV1 {
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	artifactId: string;
	sourceDigest: string;
}

export interface RollupFailedPayloadV1 {
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	stage: string;
	errorCode: string;
	retryable: boolean;
	attempt: number;
}

export type SessionChainEventType =
	| "chain_created"
	| "rollover_prepared"
	| "rollover_committed"
	| "rollover_aborted"
	| "branch_created"
	| "chain_metadata_updated"
	| "chain_archive_updated"
	| "rollup_published"
	| "rollup_failed";

export interface ChainCreatedEventPayloadV1 {
	spec: SessionChainSpecV1;
}

interface SessionChainEventBase<TEventType extends SessionChainEventType, TPayload> {
	schema:
		| typeof SESSION_CHAIN_EVENT_SCHEMA
		| typeof SESSION_CHAIN_EVENT_V2_SCHEMA
		| typeof SESSION_CHAIN_EVENT_V3_SCHEMA;
	eventId: string;
	chainId: string;
	sequence: number;
	eventType: TEventType;
	actor: SessionChainActor;
	timestamp: string;
	prevHash: string | null;
	payload: TPayload;
	schemaVersion: 1 | 2 | 3;
	idempotencyKey: string;
	hash: string;
}

export type SessionChainEvent =
	| SessionChainEventBase<"chain_created", ChainCreatedEventPayloadV1>
	| SessionChainEventBase<"rollover_prepared", RolloverPreparedPayloadV1>
	| SessionChainEventBase<"rollover_committed", RolloverCommittedPayloadV1>
	| SessionChainEventBase<"rollover_aborted", RolloverAbortedPayloadV1>
	| SessionChainEventBase<"branch_created", BranchCreatedPayloadV1>
	| SessionChainEventBase<"chain_metadata_updated", ChainMetadataUpdatedPayloadV1>
	| SessionChainEventBase<"chain_archive_updated", ChainArchiveUpdatedPayloadV1>
	| SessionChainEventBase<"rollup_published", RollupPublishedPayloadV1>
	| SessionChainEventBase<"rollup_failed", RollupFailedPayloadV1>;

export interface SessionChainHead {
	sequence: number;
	hash: string;
}

export interface SessionSegmentProjectionV1 extends SessionSegmentDescriptorV1 {
	status: SessionSegmentStatus;
	seal?: SessionSegmentSealV1;
}

export interface PendingRolloverProjectionV1 {
	eventId: string;
	preparedAt: string;
	sourceSegmentId: string;
	sourceLeafId: string;
	targetSegment: SessionSegmentDescriptorV1;
	summaryArtifactId: string;
	reason: string;
}

export interface SessionChainRollupProjectionV1 extends RollupPublishedPayloadV1 {
	eventId: string;
	publishedAt: string;
}

export interface SessionChainRollupFailureProjectionV1 extends RollupFailedPayloadV1 {
	eventId: string;
	failedAt: string;
}

export interface SessionBranchProjectionV1 {
	branchId: string;
	createdAt: string;
	forkedFrom: {
		branchId: string;
		segmentId: string;
		entryId: string;
	} | null;
	headSegmentId: string;
	segments: SessionSegmentProjectionV1[];
	rollups: SessionChainRollupProjectionV1[];
	rollupFailures: SessionChainRollupFailureProjectionV1[];
	pendingRollover?: PendingRolloverProjectionV1;
}

export interface SessionChainReadModelV1 {
	schema: typeof SESSION_CHAIN_READ_MODEL_SCHEMA;
	chainId: string;
	sequence: number;
	baseHash: string;
	title: string | null;
	archived: boolean;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	branches: SessionBranchProjectionV1[];
}

export interface SessionChainCatalogEntryV1 {
	chainId: string;
	title: string | null;
	cwd: string;
	sequence: number;
	baseHash: string;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
	branchHeads: Array<{ branchId: string; segmentId: string }>;
}

export interface SessionChainCatalogV1 {
	schema: typeof SESSION_CHAIN_CATALOG_SCHEMA;
	updatedAt: string | null;
	chains: SessionChainCatalogEntryV1[];
}

export class SessionChainValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionChainValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new SessionChainValidationError(`${field} has unknown or missing fields`);
	}
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SessionChainValidationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireNullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireNonEmptyString(value, field);
}

function requireIsoTimestamp(value: unknown, field: string): string {
	const timestamp = requireNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(timestamp))) {
		throw new SessionChainValidationError(`${field} must be an ISO timestamp`);
	}
	return timestamp;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new SessionChainValidationError(`${field} must be a non-negative integer`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
	const number = requireNonNegativeInteger(value, field);
	if (number === 0) throw new SessionChainValidationError(`${field} must be a positive integer`);
	return number;
}

export function assertSessionChainHash(value: unknown, field: string): string {
	const hash = requireNonEmptyString(value, field);
	if (!HASH_PATTERN.test(hash)) throw new SessionChainValidationError(`${field} must be a sha256 hash`);
	return hash;
}

export function assertSessionChainArtifactId(value: unknown, field: string): string {
	return assertSessionChainHash(value, field);
}

export function assertSessionChainId(chainId: string): void {
	if (!CHAIN_ID_PATTERN.test(chainId)) {
		throw new SessionChainValidationError("chainId must use the chain_<safe-id> format");
	}
}

export function assertSessionBranchId(branchId: string): void {
	if (!BRANCH_ID_PATTERN.test(branchId)) {
		throw new SessionChainValidationError("branchId must use the branch_<safe-id> format");
	}
}

export function assertSessionSegmentId(segmentId: string): void {
	if (!SEGMENT_ID_PATTERN.test(segmentId)) {
		throw new SessionChainValidationError("segmentId must be a path-safe Pi session ID");
	}
}

export function validateSessionSegmentLocationV1(
	value: unknown,
	ordinal: number,
	segmentId: string,
): SessionSegmentLocationV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("Segment location must be an object");
	if (value.kind === "managed") {
		requireExactKeys(value, ["kind", "fileName"], "managed Segment location");
		const fileName = requireNonEmptyString(value.fileName, "Segment location fileName");
		const expected = `${String(ordinal).padStart(6, "0")}_${segmentId}.jsonl`;
		if (fileName !== expected) {
			throw new SessionChainValidationError(`Segment location fileName must be ${expected}`);
		}
		return { kind: "managed", fileName };
	}
	if (value.kind === "external-root") {
		requireExactKeys(value, ["kind", "absolutePath"], "external Segment location");
		const absolutePath = requireNonEmptyString(value.absolutePath, "Segment location absolutePath");
		if (!isAbsolute(absolutePath) || !absolutePath.endsWith(".jsonl")) {
			throw new SessionChainValidationError("Segment location absolutePath must be an absolute JSONL path");
		}
		return { kind: "external-root", absolutePath };
	}
	throw new SessionChainValidationError("Segment location kind is invalid");
}

export function validateSessionSegmentDescriptorV1(value: unknown): SessionSegmentDescriptorV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("Segment descriptor must be an object");
	requireExactKeys(
		value,
		["segmentId", "ordinal", "location", "predecessorSegmentId", "summaryInArtifactId", "createdAt"],
		"Segment descriptor",
	);
	const segmentId = requireNonEmptyString(value.segmentId, "segmentId");
	assertSessionSegmentId(segmentId);
	const ordinal = requirePositiveInteger(value.ordinal, "Segment ordinal");
	const predecessorSegmentId = requireNullableString(value.predecessorSegmentId, "predecessorSegmentId");
	if (predecessorSegmentId !== null) assertSessionSegmentId(predecessorSegmentId);
	const summaryInArtifactId =
		value.summaryInArtifactId === null
			? null
			: assertSessionChainArtifactId(value.summaryInArtifactId, "summaryInArtifactId");
	return {
		segmentId,
		ordinal,
		location: validateSessionSegmentLocationV1(value.location, ordinal, segmentId),
		predecessorSegmentId,
		summaryInArtifactId,
		createdAt: requireIsoTimestamp(value.createdAt, "Segment createdAt"),
	};
}

export function validateSessionChainSpecV1(value: unknown): SessionChainSpecV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("Session Chain spec must be an object");
	requireExactKeys(
		value,
		["schema", "chainId", "title", "cwd", "rootBranchId", "rootSegment", "createdAt"],
		"Session Chain spec",
	);
	if (value.schema !== SESSION_CHAIN_SPEC_SCHEMA) {
		throw new SessionChainValidationError("Session Chain spec schema is unsupported");
	}
	const chainId = requireNonEmptyString(value.chainId, "chainId");
	assertSessionChainId(chainId);
	const rootBranchId = requireNonEmptyString(value.rootBranchId, "rootBranchId");
	assertSessionBranchId(rootBranchId);
	const cwd = requireNonEmptyString(value.cwd, "cwd");
	if (!isAbsolute(cwd)) throw new SessionChainValidationError("cwd must be absolute");
	const rootSegment = validateSessionSegmentDescriptorV1(value.rootSegment);
	if (
		rootSegment.ordinal !== 1 ||
		rootSegment.predecessorSegmentId !== null ||
		rootSegment.summaryInArtifactId !== null
	) {
		throw new SessionChainValidationError("root Segment must be ordinal 1 without predecessor or summary artifact");
	}
	return {
		schema: SESSION_CHAIN_SPEC_SCHEMA,
		chainId,
		title: requireNullableString(value.title, "title"),
		cwd,
		rootBranchId,
		rootSegment,
		createdAt: requireIsoTimestamp(value.createdAt, "createdAt"),
	};
}

function validateSummarySourceRange(value: unknown): SegmentSummarySourceRangeV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("sourceRange must be an object");
	requireExactKeys(value, ["firstEntryId", "lastEntryId", "entryCount", "entriesHash"], "sourceRange");
	const firstEntryId = value.firstEntryId === null ? null : requireNonEmptyString(value.firstEntryId, "firstEntryId");
	const entryCount = requireNonNegativeInteger(value.entryCount, "entryCount");
	if ((firstEntryId === null) !== (entryCount === 0)) {
		throw new SessionChainValidationError("firstEntryId must be null exactly when entryCount is zero");
	}
	return {
		firstEntryId,
		lastEntryId: requireNonEmptyString(value.lastEntryId, "lastEntryId"),
		entryCount,
		entriesHash: assertSessionChainHash(value.entriesHash, "entriesHash"),
	};
}

function validateSummaryGenerator(value: unknown): SegmentSummaryGeneratorV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("summary generator must be an object");
	requireExactKeys(
		value,
		["provider", "modelId", "promptVersion", "inputTokens", "outputTokens", "generatedAt"],
		"summary generator",
	);
	return {
		provider: requireNonEmptyString(value.provider, "generator.provider"),
		modelId: requireNonEmptyString(value.modelId, "generator.modelId"),
		promptVersion: requireNonEmptyString(value.promptVersion, "generator.promptVersion"),
		inputTokens: requireNonNegativeInteger(value.inputTokens, "generator.inputTokens"),
		outputTokens: requireNonNegativeInteger(value.outputTokens, "generator.outputTokens"),
		generatedAt: requireIsoTimestamp(value.generatedAt, "generator.generatedAt"),
	};
}

const SUMMARY_TITLE_MAX_CODE_POINTS = 60;
const SUMMARY_TITLE_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SUMMARY_TITLE_MARKDOWN = /(?:^#{1,6}\s|^[-*+]\s|^\d+[.)]\s|^>\s|```|`|\*\*|__|~~|\[[^\]]+\]\([^)]+\))/u;
const SUMMARY_TITLE_ROLE_INSTRUCTION =
	/(?:^|[|｜;；,.，。!?！？/\\()[\]{}]\s*|\s[-–—]\s*)(?:\[|\(|【)?\s*(?:system|developer|assistant|user|tool|human|系统|开发者|助手|用户|工具)\s*(?:\]|\)|】)?\s*[:：]|\b(?:act\s+as|you\s+are(?:\s+now)?)\b|(?:扮演|你(?:现在)?是)/iu;
const SUMMARY_TITLE_IMPERATIVE =
	/(?:^|[|｜:：;；,.，。!?！？/\\()[\]{}]\s*|\s[-–—]\s*|\b(?:then|and\s+then)\s+|(?:然后|并且|再)\s*)(?:(?:please|do|must|ignore|disregard|override|follow)\s+|(?:execute|run|read|open|call|delete|change|modify|continue)\s+(?:the|this|that|these|those|all|any|arbitrary|previous|system|developer|tool|tools|command|commands|instruction|instructions|file|files|task|tasks|everything|now)\b|(?:请|必须|务必)|(?:忽略|无视|覆盖|遵循|执行|运行|读取|打开|调用|删除|修改|继续)(?:任意|所有|全部|以下|上述|之前|当前|现在|系统|开发者|工具|命令|指令|文件|任务|操作))/iu;
const SUMMARY_TITLE_COMPLETION_CLAIM =
	/(?:^(?:completed|done|finished|shipped)\b|\b(?:completed|done|finished|fixed|resolved|shipped)\s*$|已完成|完成了|修复完成|已修复|已解决|交付完成)/iu;

export interface SegmentSummaryTitleValidationOptions {
	truncateOverlong?: boolean;
}

export function validateSegmentSummaryTitle(
	value: unknown,
	options: SegmentSummaryTitleValidationOptions = {},
): string {
	const title = requireNonEmptyString(value, "title").trim();
	if (SUMMARY_TITLE_CONTROL_CHARACTERS.test(title) || /[\r\n]/u.test(title)) {
		throw new SessionChainValidationError("title must be a single line without control characters");
	}
	if (SUMMARY_TITLE_MARKDOWN.test(title) || /<[^>]*>/u.test(title)) {
		throw new SessionChainValidationError("title must not contain Markdown or markup");
	}
	if (SUMMARY_TITLE_ROLE_INSTRUCTION.test(title)) {
		throw new SessionChainValidationError("title must not contain role instructions");
	}
	if (SUMMARY_TITLE_IMPERATIVE.test(title)) {
		throw new SessionChainValidationError("title must not contain imperative text");
	}
	if (SUMMARY_TITLE_COMPLETION_CLAIM.test(title)) {
		throw new SessionChainValidationError("title must not contain an unverified completion claim");
	}
	const codePoints = [...title];
	if (codePoints.length > SUMMARY_TITLE_MAX_CODE_POINTS) {
		if (options.truncateOverlong) return codePoints.slice(0, SUMMARY_TITLE_MAX_CODE_POINTS).join("").trimEnd();
		throw new SessionChainValidationError(
			`title must not exceed ${SUMMARY_TITLE_MAX_CODE_POINTS} Unicode code points`,
		);
	}
	return title;
}

export function validateSegmentSummaryV1(value: unknown): SegmentSummaryV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("Segment summary must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"chainId",
			"branchId",
			"sourceSegmentId",
			"sourceLeafId",
			"targetSegmentId",
			"baseSummaryArtifactId",
			"sourceRange",
			"segmentDeltaMarkdown",
			"carryForwardMarkdown",
			"generator",
		],
		"Segment summary",
	);
	if (value.schema !== SEGMENT_SUMMARY_SCHEMA) {
		throw new SessionChainValidationError("Segment summary schema is unsupported");
	}
	const chainId = requireNonEmptyString(value.chainId, "chainId");
	assertSessionChainId(chainId);
	const branchId = requireNonEmptyString(value.branchId, "branchId");
	assertSessionBranchId(branchId);
	const sourceSegmentId = requireNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	const targetSegmentId = requireNonEmptyString(value.targetSegmentId, "targetSegmentId");
	assertSessionSegmentId(sourceSegmentId);
	assertSessionSegmentId(targetSegmentId);
	return {
		schema: SEGMENT_SUMMARY_SCHEMA,
		chainId,
		branchId,
		sourceSegmentId,
		sourceLeafId: requireNonEmptyString(value.sourceLeafId, "sourceLeafId"),
		targetSegmentId,
		baseSummaryArtifactId:
			value.baseSummaryArtifactId === null
				? null
				: assertSessionChainArtifactId(value.baseSummaryArtifactId, "baseSummaryArtifactId"),
		sourceRange: validateSummarySourceRange(value.sourceRange),
		segmentDeltaMarkdown: requireNonEmptyString(value.segmentDeltaMarkdown, "segmentDeltaMarkdown"),
		carryForwardMarkdown: requireNonEmptyString(value.carryForwardMarkdown, "carryForwardMarkdown"),
		generator: validateSummaryGenerator(value.generator),
	};
}

export function validateSegmentSummaryV2(value: unknown): SegmentSummaryV2 {
	if (!isRecord(value)) throw new SessionChainValidationError("Segment summary must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"title",
			"chainId",
			"branchId",
			"sourceSegmentId",
			"sourceLeafId",
			"targetSegmentId",
			"baseSummaryArtifactId",
			"sourceRange",
			"segmentDeltaMarkdown",
			"carryForwardMarkdown",
			"generator",
		],
		"Segment summary",
	);
	if (value.schema !== SEGMENT_SUMMARY_V2_SCHEMA) {
		throw new SessionChainValidationError("Segment summary schema is unsupported");
	}
	const chainId = requireNonEmptyString(value.chainId, "chainId");
	assertSessionChainId(chainId);
	const branchId = requireNonEmptyString(value.branchId, "branchId");
	assertSessionBranchId(branchId);
	const sourceSegmentId = requireNonEmptyString(value.sourceSegmentId, "sourceSegmentId");
	const targetSegmentId = requireNonEmptyString(value.targetSegmentId, "targetSegmentId");
	assertSessionSegmentId(sourceSegmentId);
	assertSessionSegmentId(targetSegmentId);
	return {
		schema: SEGMENT_SUMMARY_V2_SCHEMA,
		title: validateSegmentSummaryTitle(value.title),
		chainId,
		branchId,
		sourceSegmentId,
		sourceLeafId: requireNonEmptyString(value.sourceLeafId, "sourceLeafId"),
		targetSegmentId,
		baseSummaryArtifactId:
			value.baseSummaryArtifactId === null
				? null
				: assertSessionChainArtifactId(value.baseSummaryArtifactId, "baseSummaryArtifactId"),
		sourceRange: validateSummarySourceRange(value.sourceRange),
		segmentDeltaMarkdown: requireNonEmptyString(value.segmentDeltaMarkdown, "segmentDeltaMarkdown"),
		carryForwardMarkdown: requireNonEmptyString(value.carryForwardMarkdown, "carryForwardMarkdown"),
		generator: validateSummaryGenerator(value.generator),
	};
}

export function validateSegmentSummary(value: unknown): SegmentSummary {
	if (!isRecord(value)) throw new SessionChainValidationError("Segment summary must be an object");
	if (value.schema === SEGMENT_SUMMARY_SCHEMA) return validateSegmentSummaryV1(value);
	if (value.schema === SEGMENT_SUMMARY_V2_SCHEMA) return validateSegmentSummaryV2(value);
	throw new SessionChainValidationError("Segment summary schema is unsupported");
}

function validateNonEmptyStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new SessionChainValidationError(`${field} must be an array`);
	return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function validateRollupContent(value: unknown): SessionChainRollupContentV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("rollup must be an object");
	requireExactKeys(value, ["state", "decisions", "constraints", "completed", "unresolved", "nextActions"], "rollup");
	return {
		state: requireNonEmptyString(value.state, "rollup.state"),
		decisions: validateNonEmptyStringArray(value.decisions, "rollup.decisions"),
		constraints: validateNonEmptyStringArray(value.constraints, "rollup.constraints"),
		completed: validateNonEmptyStringArray(value.completed, "rollup.completed"),
		unresolved: validateNonEmptyStringArray(value.unresolved, "rollup.unresolved"),
		nextActions: validateNonEmptyStringArray(value.nextActions, "rollup.nextActions"),
	};
}

function validateRollupProvenance(value: unknown): SessionChainRollupProvenanceV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("rollup provenance must be an object");
	requireExactKeys(value, ["generator", "model", "promptVersion", "generatedAt"], "rollup provenance");
	return {
		generator: requireNonEmptyString(value.generator, "provenance.generator"),
		model: requireNonEmptyString(value.model, "provenance.model"),
		promptVersion: requireNonEmptyString(value.promptVersion, "provenance.promptVersion"),
		generatedAt: requireIsoTimestamp(value.generatedAt, "provenance.generatedAt"),
	};
}

export function validateSessionChainRollupV1(value: unknown): SessionChainRollupV1 {
	if (!isRecord(value)) throw new SessionChainValidationError("Session Chain Rollup must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"chainId",
			"branchId",
			"windowIndex",
			"startOrdinal",
			"endOrdinal",
			"segmentIds",
			"summaryArtifactIds",
			"sourceDigest",
			"rollup",
			"provenance",
		],
		"Session Chain Rollup",
	);
	if (value.schema !== CHAIN_ROLLUP_SCHEMA) {
		throw new SessionChainValidationError("Session Chain Rollup schema is unsupported");
	}
	const chainId = requireNonEmptyString(value.chainId, "chainId");
	const branchId = requireNonEmptyString(value.branchId, "branchId");
	assertSessionChainId(chainId);
	assertSessionBranchId(branchId);
	const windowIndex = requirePositiveInteger(value.windowIndex, "windowIndex");
	const startOrdinal = requirePositiveInteger(value.startOrdinal, "startOrdinal");
	const endOrdinal = requirePositiveInteger(value.endOrdinal, "endOrdinal");
	if (endOrdinal < startOrdinal) {
		throw new SessionChainValidationError("Rollup ordinal range must be ordered");
	}
	const segmentIds = validateNonEmptyStringArray(value.segmentIds, "segmentIds");
	for (const segmentId of segmentIds) assertSessionSegmentId(segmentId);
	if (!Array.isArray(value.summaryArtifactIds)) {
		throw new SessionChainValidationError("summaryArtifactIds must be an array");
	}
	const summaryArtifactIds = value.summaryArtifactIds.map((artifactId, index) =>
		assertSessionChainArtifactId(artifactId, `summaryArtifactIds[${index}]`),
	);
	const expectedLength = endOrdinal - startOrdinal + 1;
	if (
		segmentIds.length !== expectedLength ||
		summaryArtifactIds.length !== expectedLength ||
		segmentIds.length !== summaryArtifactIds.length
	) {
		throw new SessionChainValidationError("Rollup source arrays must match its ordinal range");
	}
	if (
		new Set(segmentIds).size !== segmentIds.length ||
		new Set(summaryArtifactIds).size !== summaryArtifactIds.length
	) {
		throw new SessionChainValidationError("Rollup source arrays must not contain duplicates");
	}
	return {
		schema: CHAIN_ROLLUP_SCHEMA,
		chainId,
		branchId,
		windowIndex,
		startOrdinal,
		endOrdinal,
		segmentIds,
		summaryArtifactIds,
		sourceDigest: assertSessionChainHash(value.sourceDigest, "sourceDigest"),
		rollup: validateRollupContent(value.rollup),
		provenance: validateRollupProvenance(value.provenance),
	};
}

export function validateSessionChainActor(value: unknown): SessionChainActor {
	if (value !== "user" && value !== "model" && value !== "runtime" && value !== "system") {
		throw new SessionChainValidationError("Session Chain actor is invalid");
	}
	return value;
}

export function validateSessionChainTitle(value: unknown): string | null {
	return requireNullableString(value, "title");
}

export function validateSessionChainTimestamp(value: unknown, field: string): string {
	return requireIsoTimestamp(value, field);
}

export function validateSessionChainNonEmptyString(value: unknown, field: string): string {
	return requireNonEmptyString(value, field);
}

export function validateSessionChainNonNegativeInteger(value: unknown, field: string): number {
	return requireNonNegativeInteger(value, field);
}

export function validateSessionChainExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	field: string,
): void {
	requireExactKeys(value, keys, field);
}

export function isSessionChainRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}
