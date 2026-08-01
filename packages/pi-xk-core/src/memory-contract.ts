export const MEMORY_REVISION_SCHEMA = "pi-xk.memory-revision.v1";
export const MEMORY_CUE_SCHEMA = "pi-xk.memory-cue.v1";
export const MEMORY_EDGE_SCHEMA = "pi-xk.memory-edge.v1";
export const MEMORY_EVIDENCE_REF_SCHEMA = "pi-xk.memory-evidence-ref.v1";
export const MEMORY_GIT_FRESHNESS_SCHEMA = "pi-xk.memory-git-freshness.v1";
export const MEMORY_CHANGE_PROPOSAL_SCHEMA = "pi-xk.memory-change-proposal.v1";
export const MEMORY_CAPTURE_SOURCE_SCHEMA = "pi-xk.memory-capture-source.v1";
export const MEMORY_EVENT_SCHEMA = "pi-xk.memory-event.v1";
export const MEMORY_READ_MODEL_SCHEMA = "pi-xk.memory-read-model.v1";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;

export type MemoryKind =
	| "fact"
	| "decision"
	| "constraint"
	| "preference"
	| "procedure"
	| "lesson"
	| "outcome"
	| "open_question";
export type MemoryTrust = "verified" | "model_inferred" | "disputed";
export type MemoryFreshness = "current" | "stale" | "unknown";
export type MemoryLifecycle = "active" | "superseded" | "invalidated" | "archived";
export type MemoryProducer = "user" | "pi-xk" | "model";
export type MemoryActor = "user" | "model" | "runtime" | "system";
export type MemoryCueKind = "project" | "domain" | "component" | "symbol" | "workflow" | "topic";
export type MemoryEdgeRelation =
	| "part_of"
	| "depends_on"
	| "implements"
	| "applies_to"
	| "caused_by"
	| "supports"
	| "contradicts"
	| "supersedes"
	| "related_to";
export type MemoryEvidenceSourceType =
	| "goal_checkpoint"
	| "goal_completion"
	| "chain_summary"
	| "compaction"
	| "task_result"
	| "git"
	| "explicit";
export type MemoryCaptureTrigger = "goal_checkpoint" | "goal_completion" | "chain_rollup" | "explicit" | "backfill";

export interface MemoryHead {
	sequence: number;
	hash: string | null;
}

export interface MemoryStateV1 {
	trust: MemoryTrust;
	freshness: MemoryFreshness;
	lifecycle: MemoryLifecycle;
}

export interface MemoryProvenanceV1 {
	producer: MemoryProducer;
	model: string | null;
	promptVersion: string | null;
	recordedAt: string;
}

export interface MemoryScopeV1 {
	projectId: string;
	goalId: string | null;
	chainId: string | null;
	branchId: string | null;
	paths: string[];
}

export interface MemoryPathDigestV1 {
	path: string;
	digest: string;
}

export interface GitFreshnessBasisV1 {
	schema: typeof MEMORY_GIT_FRESHNESS_SCHEMA;
	repositoryId: string;
	baselineCommit: string;
	scopePaths: string[];
	pathDigests: MemoryPathDigestV1[];
}

export interface GoalCheckpointEvidenceLocatorV1 {
	goalId: string;
	checkpointEventId: string;
}

export interface GoalCompletionEvidenceLocatorV1 {
	goalId: string;
	eventId: string;
}

export interface ChainSummaryEvidenceLocatorV1 {
	chainId: string;
	branchId: string;
	level: "l1" | "l2";
	segmentId: string | null;
	ordinal: number | null;
	windowIndex: number | null;
}

export interface CompactionEvidenceLocatorV1 {
	sessionId: string;
	entryId: string;
	title: string;
}

export interface TaskResultEvidenceLocatorV1 {
	taskId: string;
}

export interface GitEvidenceLocatorV1 {
	repositoryId: string;
	baselineCommit: string;
	scopePaths: string[];
}

export interface ExplicitEvidenceLocatorV1 {
	commandId: string;
}

interface EvidenceRefCommonV1 {
	schema: typeof MEMORY_EVIDENCE_REF_SCHEMA;
	evidenceId: string;
	sourceId: string;
	artifactId: string | null;
	sourceDigest: string;
	recordedAt: string;
}

export type EvidenceRefV1 =
	| (EvidenceRefCommonV1 & { sourceType: "goal_checkpoint"; locator: GoalCheckpointEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "goal_completion"; locator: GoalCompletionEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "chain_summary"; locator: ChainSummaryEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "compaction"; locator: CompactionEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "task_result"; locator: TaskResultEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "git"; locator: GitEvidenceLocatorV1 })
	| (EvidenceRefCommonV1 & { sourceType: "explicit"; locator: ExplicitEvidenceLocatorV1 });

export interface MemoryRevisionV1 {
	schema: typeof MEMORY_REVISION_SCHEMA;
	memoryId: string;
	revision: number;
	kind: MemoryKind;
	title: string;
	statement: string;
	applicability: string;
	trust: MemoryTrust;
	lifecycle: MemoryLifecycle;
	effectiveFrom: string;
	effectiveTo: string | null;
	cueIds: string[];
	evidenceRefs: EvidenceRefV1[];
	freshnessBasis: GitFreshnessBasisV1 | null;
	sourceDigest: string;
	supersedesRevision: number | null;
	provenance: MemoryProvenanceV1;
}

export interface CueNodeV1 {
	schema: typeof MEMORY_CUE_SCHEMA;
	cueId: string;
	revision: number;
	kind: MemoryCueKind;
	key: string;
	label: string;
	aliases: string[];
	scope: MemoryScopeV1;
	sourceDigest: string;
	provenance: MemoryProvenanceV1;
}

export interface MemoryGraphEndpointV1 {
	kind: "memory" | "cue";
	id: string;
}

export interface MemoryEdgeV1 {
	schema: typeof MEMORY_EDGE_SCHEMA;
	edgeId: string;
	from: MemoryGraphEndpointV1;
	to: MemoryGraphEndpointV1;
	relation: MemoryEdgeRelation;
	effectiveFrom: string;
	effectiveTo: string | null;
	evidenceRefs: EvidenceRefV1[];
	sourceDigest: string;
	provenance: MemoryProvenanceV1;
}

export interface MemoryExpectedRevisionV1 {
	memoryId: string;
	revision: number;
}

export type MemoryChangeOperationV1 =
	| { kind: "publish_revision"; revision: MemoryRevisionV1 }
	| { kind: "publish_cue"; cue: CueNodeV1 }
	| { kind: "publish_edge"; edge: MemoryEdgeV1 }
	| {
			kind: "change_lifecycle";
			memoryId: string;
			expectedRevision: number;
			lifecycle: MemoryLifecycle;
			reason: string;
	  }
	| { kind: "detach_evidence"; memoryId: string; expectedRevision: number; evidenceId: string; reason: string }
	| { kind: "purge_memory"; memoryId: string; expectedRevision: number; reason: string };

export interface MemoryChangeProposalV1 {
	schema: typeof MEMORY_CHANGE_PROPOSAL_SCHEMA;
	proposalId: string;
	captureId: string | null;
	sourceDigest: string;
	expectedEventHead: MemoryHead;
	expectedRevisions: MemoryExpectedRevisionV1[];
	reason: string;
	operations: MemoryChangeOperationV1[];
	provenance: MemoryProvenanceV1;
}

export interface MemoryCaptureSourceV1 {
	schema: typeof MEMORY_CAPTURE_SOURCE_SCHEMA;
	captureId: string;
	trigger: MemoryCaptureTrigger;
	sourceIds: string[];
	sourceDigest: string;
	promptVersion: string;
	createdAt: string;
}

export interface MemoryAccessEventV1 {
	runId: string;
	memoryIds: string[];
	evidenceIds: string[];
}

export class MemoryValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new MemoryValidationError(`${field} has unknown or missing fields`);
	}
}

function string(value: unknown, field: string, maximum = 4096): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new MemoryValidationError(`${field} must be a non-empty string`);
	}
	if ([...value].length > maximum) throw new MemoryValidationError(`${field} is too long`);
	if (value.includes("\0")) throw new MemoryValidationError(`${field} must not contain NUL bytes`);
	return value;
}

function singleLine(value: unknown, field: string, maximum: number): string {
	const result = string(value, field, maximum);
	if (/[\r\n\u0000-\u001f\u007f]/u.test(result)) {
		throw new MemoryValidationError(`${field} must be a single line without control characters`);
	}
	return result;
}

function identifier(value: unknown, prefix: string, field: string): string {
	const result = string(value, field, 160);
	if (!result.startsWith(`${prefix}_`) || !SAFE_ID_PATTERN.test(result)) {
		throw new MemoryValidationError(`${field} must use the ${prefix}_<safe-id> format`);
	}
	return result;
}

function digest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
		throw new MemoryValidationError(`${field} must use the sha256:<lowercase-hex> format`);
	}
	return value;
}

function iso(value: unknown, field: string): string {
	const result = string(value, field, 80);
	if (Number.isNaN(Date.parse(result))) throw new MemoryValidationError(`${field} must be an ISO timestamp`);
	return result;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new MemoryValidationError(`${field} must be a positive integer`);
	}
	return value;
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : string(value, field, 256);
}

function uniqueStrings(value: unknown, field: string, maximum = 100): string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new MemoryValidationError(`${field} must be an array`);
	const result = value.map((entry, index) => string(entry, `${field}[${index}]`, 512));
	if (new Set(result).size !== result.length) throw new MemoryValidationError(`${field} must be unique`);
	return result;
}

function projectPath(value: unknown, field: string): string {
	const result = singleLine(value, field, 1024);
	if (
		result.startsWith("/") ||
		result.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(result) ||
		result.includes("\\") ||
		result.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	) {
		throw new MemoryValidationError(`${field} must be a normalized project-relative path`);
	}
	return result;
}

function memoryKind(value: unknown): MemoryKind {
	if (
		!["fact", "decision", "constraint", "preference", "procedure", "lesson", "outcome", "open_question"].includes(
			String(value),
		)
	) {
		throw new MemoryValidationError("memory kind is invalid");
	}
	return value as MemoryKind;
}

function trust(value: unknown): MemoryTrust {
	if (value !== "verified" && value !== "model_inferred" && value !== "disputed") {
		throw new MemoryValidationError("memory trust is invalid");
	}
	return value;
}

function lifecycle(value: unknown): MemoryLifecycle {
	if (value !== "active" && value !== "superseded" && value !== "invalidated" && value !== "archived") {
		throw new MemoryValidationError("memory lifecycle is invalid");
	}
	return value;
}

function provenance(value: unknown): MemoryProvenanceV1 {
	if (!isRecord(value)) throw new MemoryValidationError("provenance must be an object");
	exact(value, ["producer", "model", "promptVersion", "recordedAt"], "provenance");
	if (value.producer !== "user" && value.producer !== "pi-xk" && value.producer !== "model") {
		throw new MemoryValidationError("provenance producer is invalid");
	}
	const model = nullableString(value.model, "provenance model");
	const promptVersion = nullableString(value.promptVersion, "provenance promptVersion");
	if (value.producer === "model" && (!model || !promptVersion)) {
		throw new MemoryValidationError("model provenance requires model and promptVersion");
	}
	return {
		producer: value.producer,
		model,
		promptVersion,
		recordedAt: iso(value.recordedAt, "provenance recordedAt"),
	};
}

function scope(value: unknown): MemoryScopeV1 {
	if (!isRecord(value)) throw new MemoryValidationError("cue scope must be an object");
	exact(value, ["projectId", "goalId", "chainId", "branchId", "paths"], "cue scope");
	return {
		projectId: string(value.projectId, "scope projectId", 160),
		goalId: nullableString(value.goalId, "scope goalId"),
		chainId: nullableString(value.chainId, "scope chainId"),
		branchId: nullableString(value.branchId, "scope branchId"),
		paths: uniqueStrings(value.paths, "scope paths").map((path, index) => projectPath(path, `scope paths[${index}]`)),
	};
}

export function validateGitFreshnessBasisV1(value: unknown): GitFreshnessBasisV1 {
	if (!isRecord(value)) throw new MemoryValidationError("freshness basis must be an object");
	exact(value, ["schema", "repositoryId", "baselineCommit", "scopePaths", "pathDigests"], "freshness basis");
	if (value.schema !== MEMORY_GIT_FRESHNESS_SCHEMA)
		throw new MemoryValidationError("freshness basis schema is unsupported");
	const baselineCommit = string(value.baselineCommit, "freshness baselineCommit", 64);
	if (!COMMIT_PATTERN.test(baselineCommit)) throw new MemoryValidationError("freshness baselineCommit is invalid");
	const scopePaths = uniqueStrings(value.scopePaths, "freshness scopePaths").map((path, index) =>
		projectPath(path, `freshness scopePaths[${index}]`),
	);
	if (scopePaths.length === 0) throw new MemoryValidationError("freshness scopePaths must not be empty");
	if (!Array.isArray(value.pathDigests)) throw new MemoryValidationError("freshness pathDigests must be an array");
	const pathDigests = value.pathDigests.map((entry, index): MemoryPathDigestV1 => {
		if (!isRecord(entry)) throw new MemoryValidationError(`freshness pathDigests[${index}] must be an object`);
		exact(entry, ["path", "digest"], `freshness pathDigests[${index}]`);
		return {
			path: projectPath(entry.path, `freshness pathDigests[${index}].path`),
			digest: digest(entry.digest, `freshness pathDigests[${index}].digest`),
		};
	});
	if (
		pathDigests.length !== scopePaths.length ||
		pathDigests.some((entry, index) => entry.path !== scopePaths[index])
	) {
		throw new MemoryValidationError("freshness pathDigests must exactly match scopePaths order");
	}
	return {
		schema: MEMORY_GIT_FRESHNESS_SCHEMA,
		repositoryId: string(value.repositoryId, "freshness repositoryId", 160),
		baselineCommit,
		scopePaths,
		pathDigests,
	};
}

function evidenceLocator(sourceType: MemoryEvidenceSourceType, value: unknown): EvidenceRefV1["locator"] {
	if (!isRecord(value)) throw new MemoryValidationError("evidence locator must be an object");
	if (sourceType === "goal_checkpoint") {
		exact(value, ["goalId", "checkpointEventId"], "goal checkpoint locator");
		return {
			goalId: string(value.goalId, "locator goalId"),
			checkpointEventId: string(value.checkpointEventId, "locator checkpointEventId"),
		};
	}
	if (sourceType === "goal_completion") {
		exact(value, ["goalId", "eventId"], "goal completion locator");
		return { goalId: string(value.goalId, "locator goalId"), eventId: string(value.eventId, "locator eventId") };
	}
	if (sourceType === "chain_summary") {
		exact(value, ["chainId", "branchId", "level", "segmentId", "ordinal", "windowIndex"], "chain summary locator");
		if (value.level !== "l1" && value.level !== "l2")
			throw new MemoryValidationError("chain summary level is invalid");
		const ordinal = value.ordinal === null ? null : positiveInteger(value.ordinal, "locator ordinal");
		const windowIndex = value.windowIndex === null ? null : positiveInteger(value.windowIndex, "locator windowIndex");
		const segmentId = nullableString(value.segmentId, "locator segmentId");
		if (
			value.level === "l1"
				? segmentId === null || ordinal === null || windowIndex !== null
				: segmentId !== null || ordinal !== null || windowIndex === null
		) {
			throw new MemoryValidationError("chain summary locator does not match its level");
		}
		return {
			chainId: string(value.chainId, "locator chainId"),
			branchId: string(value.branchId, "locator branchId"),
			level: value.level,
			segmentId,
			ordinal,
			windowIndex,
		};
	}
	if (sourceType === "compaction") {
		exact(value, ["sessionId", "entryId", "title"], "compaction locator");
		return {
			sessionId: string(value.sessionId, "locator sessionId"),
			entryId: string(value.entryId, "locator entryId"),
			title: singleLine(value.title, "locator title", 60),
		};
	}
	if (sourceType === "task_result") {
		exact(value, ["taskId"], "task result locator");
		return { taskId: string(value.taskId, "locator taskId") };
	}
	if (sourceType === "git") {
		exact(value, ["repositoryId", "baselineCommit", "scopePaths"], "git locator");
		const baselineCommit = string(value.baselineCommit, "locator baselineCommit", 64);
		if (!COMMIT_PATTERN.test(baselineCommit)) throw new MemoryValidationError("locator baselineCommit is invalid");
		return {
			repositoryId: string(value.repositoryId, "locator repositoryId"),
			baselineCommit,
			scopePaths: uniqueStrings(value.scopePaths, "locator scopePaths").map((path, index) =>
				projectPath(path, `locator scopePaths[${index}]`),
			),
		};
	}
	exact(value, ["commandId"], "explicit locator");
	return { commandId: string(value.commandId, "locator commandId") };
}

export function validateEvidenceRefV1(value: unknown): EvidenceRefV1 {
	if (!isRecord(value)) throw new MemoryValidationError("evidence ref must be an object");
	exact(
		value,
		["schema", "evidenceId", "sourceType", "sourceId", "artifactId", "sourceDigest", "recordedAt", "locator"],
		"evidence ref",
	);
	if (value.schema !== MEMORY_EVIDENCE_REF_SCHEMA)
		throw new MemoryValidationError("evidence ref schema is unsupported");
	if (
		!["goal_checkpoint", "goal_completion", "chain_summary", "compaction", "task_result", "git", "explicit"].includes(
			String(value.sourceType),
		)
	) {
		throw new MemoryValidationError("evidence sourceType is invalid");
	}
	const sourceType = value.sourceType as MemoryEvidenceSourceType;
	const artifactId = value.artifactId === null ? null : digest(value.artifactId, "evidence artifactId");
	if (
		["goal_checkpoint", "goal_completion", "chain_summary", "task_result", "explicit"].includes(sourceType) &&
		artifactId === null
	) {
		throw new MemoryValidationError(`${sourceType} evidence requires artifactId`);
	}
	if ((sourceType === "compaction" || sourceType === "git") && artifactId !== null) {
		throw new MemoryValidationError(`${sourceType} evidence must not contain artifactId`);
	}
	return {
		schema: MEMORY_EVIDENCE_REF_SCHEMA,
		evidenceId: identifier(value.evidenceId, "evidence", "evidenceId"),
		sourceType,
		sourceId: string(value.sourceId, "evidence sourceId", 512),
		artifactId,
		sourceDigest: digest(value.sourceDigest, "evidence sourceDigest"),
		recordedAt: iso(value.recordedAt, "evidence recordedAt"),
		locator: evidenceLocator(sourceType, value.locator),
	} as EvidenceRefV1;
}

export function validateMemoryRevisionV1(value: unknown): MemoryRevisionV1 {
	if (!isRecord(value)) throw new MemoryValidationError("memory revision must be an object");
	exact(
		value,
		[
			"schema",
			"memoryId",
			"revision",
			"kind",
			"title",
			"statement",
			"applicability",
			"trust",
			"lifecycle",
			"effectiveFrom",
			"effectiveTo",
			"cueIds",
			"evidenceRefs",
			"freshnessBasis",
			"sourceDigest",
			"supersedesRevision",
			"provenance",
		],
		"memory revision",
	);
	if (value.schema !== MEMORY_REVISION_SCHEMA)
		throw new MemoryValidationError("memory revision schema is unsupported");
	const revision = positiveInteger(value.revision, "memory revision");
	const effectiveFrom = iso(value.effectiveFrom, "memory effectiveFrom");
	const effectiveTo = value.effectiveTo === null ? null : iso(value.effectiveTo, "memory effectiveTo");
	if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
		throw new MemoryValidationError("memory effectiveTo must be after effectiveFrom");
	}
	const supersedesRevision =
		value.supersedesRevision === null ? null : positiveInteger(value.supersedesRevision, "supersedesRevision");
	if ((revision === 1 && supersedesRevision !== null) || (revision > 1 && supersedesRevision !== revision - 1)) {
		throw new MemoryValidationError("supersedesRevision must identify the immediately previous revision");
	}
	const parsedLifecycle = lifecycle(value.lifecycle);
	if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 100) {
		throw new MemoryValidationError("memory evidenceRefs must contain at most 100 entries");
	}
	if (value.evidenceRefs.length === 0 && parsedLifecycle !== "invalidated" && parsedLifecycle !== "archived") {
		throw new MemoryValidationError("active or superseded memory must retain evidence");
	}
	const evidenceRefs = value.evidenceRefs.map(validateEvidenceRefV1);
	if (new Set(evidenceRefs.map((entry) => entry.evidenceId)).size !== evidenceRefs.length) {
		throw new MemoryValidationError("memory evidenceRefs must use unique evidenceId values");
	}
	return {
		schema: MEMORY_REVISION_SCHEMA,
		memoryId: identifier(value.memoryId, "memory", "memoryId"),
		revision,
		kind: memoryKind(value.kind),
		title: singleLine(value.title, "memory title", 160),
		statement: string(value.statement, "memory statement", 16_384),
		applicability: string(value.applicability, "memory applicability", 8192),
		trust: trust(value.trust),
		lifecycle: parsedLifecycle,
		effectiveFrom,
		effectiveTo,
		cueIds: uniqueStrings(value.cueIds, "memory cueIds").map((entry) => identifier(entry, "cue", "memory cueId")),
		evidenceRefs,
		freshnessBasis: value.freshnessBasis === null ? null : validateGitFreshnessBasisV1(value.freshnessBasis),
		sourceDigest: digest(value.sourceDigest, "memory sourceDigest"),
		supersedesRevision,
		provenance: provenance(value.provenance),
	};
}

export function normalizeMemoryCueKey(value: string): string {
	return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, "-");
}

export function validateCueNodeV1(value: unknown): CueNodeV1 {
	if (!isRecord(value)) throw new MemoryValidationError("cue must be an object");
	exact(
		value,
		["schema", "cueId", "revision", "kind", "key", "label", "aliases", "scope", "sourceDigest", "provenance"],
		"cue",
	);
	if (value.schema !== MEMORY_CUE_SCHEMA) throw new MemoryValidationError("cue schema is unsupported");
	if (!["project", "domain", "component", "symbol", "workflow", "topic"].includes(String(value.kind))) {
		throw new MemoryValidationError("cue kind is invalid");
	}
	const key = singleLine(value.key, "cue key", 120);
	if (key !== normalizeMemoryCueKey(key) || !/^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(key)) {
		throw new MemoryValidationError("cue key must be normalized keyword text");
	}
	return {
		schema: MEMORY_CUE_SCHEMA,
		cueId: identifier(value.cueId, "cue", "cueId"),
		revision: positiveInteger(value.revision, "cue revision"),
		kind: value.kind as MemoryCueKind,
		key,
		label: singleLine(value.label, "cue label", 120),
		aliases: uniqueStrings(value.aliases, "cue aliases", 20).map((entry, index) =>
			singleLine(entry, `cue aliases[${index}]`, 120),
		),
		scope: scope(value.scope),
		sourceDigest: digest(value.sourceDigest, "cue sourceDigest"),
		provenance: provenance(value.provenance),
	};
}

function endpoint(value: unknown, field: string): MemoryGraphEndpointV1 {
	if (!isRecord(value)) throw new MemoryValidationError(`${field} must be an object`);
	exact(value, ["kind", "id"], field);
	if (value.kind !== "memory" && value.kind !== "cue") throw new MemoryValidationError(`${field} kind is invalid`);
	return { kind: value.kind, id: identifier(value.id, value.kind, `${field} id`) };
}

export function validateMemoryEdgeV1(value: unknown): MemoryEdgeV1 {
	if (!isRecord(value)) throw new MemoryValidationError("memory edge must be an object");
	exact(
		value,
		[
			"schema",
			"edgeId",
			"from",
			"to",
			"relation",
			"effectiveFrom",
			"effectiveTo",
			"evidenceRefs",
			"sourceDigest",
			"provenance",
		],
		"memory edge",
	);
	if (value.schema !== MEMORY_EDGE_SCHEMA) throw new MemoryValidationError("memory edge schema is unsupported");
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
		throw new MemoryValidationError("memory edge relation is invalid");
	}
	const from = endpoint(value.from, "memory edge from");
	const to = endpoint(value.to, "memory edge to");
	if (from.kind === to.kind && from.id === to.id)
		throw new MemoryValidationError("memory edge must not be a self edge");
	if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
		throw new MemoryValidationError("memory edge evidenceRefs must not be empty");
	}
	const effectiveFrom = iso(value.effectiveFrom, "memory edge effectiveFrom");
	const effectiveTo = value.effectiveTo === null ? null : iso(value.effectiveTo, "memory edge effectiveTo");
	if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
		throw new MemoryValidationError("memory edge effectiveTo must be after effectiveFrom");
	}
	return {
		schema: MEMORY_EDGE_SCHEMA,
		edgeId: identifier(value.edgeId, "edge", "edgeId"),
		from,
		to,
		relation: value.relation as MemoryEdgeRelation,
		effectiveFrom,
		effectiveTo,
		evidenceRefs: value.evidenceRefs.map(validateEvidenceRefV1),
		sourceDigest: digest(value.sourceDigest, "memory edge sourceDigest"),
		provenance: provenance(value.provenance),
	};
}

function validateMemoryHead(value: unknown): MemoryHead {
	if (!isRecord(value)) throw new MemoryValidationError("memory head must be an object");
	exact(value, ["sequence", "hash"], "memory head");
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
		throw new MemoryValidationError("memory head sequence must be a non-negative integer");
	}
	const hash = value.hash === null ? null : digest(value.hash, "memory head hash");
	if ((value.sequence === 0) !== (hash === null))
		throw new MemoryValidationError("memory head sequence and hash disagree");
	return { sequence: value.sequence, hash };
}

function operation(value: unknown): MemoryChangeOperationV1 {
	if (!isRecord(value)) throw new MemoryValidationError("memory proposal operation must be an object");
	if (value.kind === "publish_revision") {
		exact(value, ["kind", "revision"], "publish revision operation");
		return { kind: value.kind, revision: validateMemoryRevisionV1(value.revision) };
	}
	if (value.kind === "publish_cue") {
		exact(value, ["kind", "cue"], "publish cue operation");
		return { kind: value.kind, cue: validateCueNodeV1(value.cue) };
	}
	if (value.kind === "publish_edge") {
		exact(value, ["kind", "edge"], "publish edge operation");
		return { kind: value.kind, edge: validateMemoryEdgeV1(value.edge) };
	}
	if (value.kind === "change_lifecycle") {
		exact(value, ["kind", "memoryId", "expectedRevision", "lifecycle", "reason"], "lifecycle operation");
		return {
			kind: value.kind,
			memoryId: identifier(value.memoryId, "memory", "lifecycle memoryId"),
			expectedRevision: positiveInteger(value.expectedRevision, "lifecycle expectedRevision"),
			lifecycle: lifecycle(value.lifecycle),
			reason: string(value.reason, "lifecycle reason", 2048),
		};
	}
	if (value.kind === "detach_evidence") {
		exact(value, ["kind", "memoryId", "expectedRevision", "evidenceId", "reason"], "detach evidence operation");
		return {
			kind: value.kind,
			memoryId: identifier(value.memoryId, "memory", "detach memoryId"),
			expectedRevision: positiveInteger(value.expectedRevision, "detach expectedRevision"),
			evidenceId: identifier(value.evidenceId, "evidence", "detach evidenceId"),
			reason: string(value.reason, "detach reason", 2048),
		};
	}
	if (value.kind === "purge_memory") {
		exact(value, ["kind", "memoryId", "expectedRevision", "reason"], "purge operation");
		return {
			kind: value.kind,
			memoryId: identifier(value.memoryId, "memory", "purge memoryId"),
			expectedRevision: positiveInteger(value.expectedRevision, "purge expectedRevision"),
			reason: string(value.reason, "purge reason", 2048),
		};
	}
	throw new MemoryValidationError("memory proposal operation kind is invalid");
}

export function validateMemoryChangeProposalV1(value: unknown): MemoryChangeProposalV1 {
	if (!isRecord(value)) throw new MemoryValidationError("memory change proposal must be an object");
	exact(
		value,
		[
			"schema",
			"proposalId",
			"captureId",
			"sourceDigest",
			"expectedEventHead",
			"expectedRevisions",
			"reason",
			"operations",
			"provenance",
		],
		"memory change proposal",
	);
	if (value.schema !== MEMORY_CHANGE_PROPOSAL_SCHEMA)
		throw new MemoryValidationError("memory change proposal schema is unsupported");
	if (!Array.isArray(value.expectedRevisions)) throw new MemoryValidationError("expectedRevisions must be an array");
	const expectedRevisions = value.expectedRevisions.map((entry, index): MemoryExpectedRevisionV1 => {
		if (!isRecord(entry)) throw new MemoryValidationError(`expectedRevisions[${index}] must be an object`);
		exact(entry, ["memoryId", "revision"], `expectedRevisions[${index}]`);
		return {
			memoryId: identifier(entry.memoryId, "memory", `expectedRevisions[${index}].memoryId`),
			revision: positiveInteger(entry.revision, `expectedRevisions[${index}].revision`),
		};
	});
	if (new Set(expectedRevisions.map((entry) => entry.memoryId)).size !== expectedRevisions.length) {
		throw new MemoryValidationError("expectedRevisions must use unique memoryId values");
	}
	if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 100) {
		throw new MemoryValidationError("memory proposal operations must contain 1 to 100 entries");
	}
	const operations = value.operations.map(operation);
	const parsedProvenance = provenance(value.provenance);
	if (
		parsedProvenance.producer === "model" &&
		operations.some((entry) => entry.kind === "publish_revision" && entry.revision.trust === "verified")
	) {
		throw new MemoryValidationError("model proposals cannot publish verified memory");
	}
	return {
		schema: MEMORY_CHANGE_PROPOSAL_SCHEMA,
		proposalId: identifier(value.proposalId, "proposal", "proposalId"),
		captureId: value.captureId === null ? null : identifier(value.captureId, "capture", "captureId"),
		sourceDigest: digest(value.sourceDigest, "proposal sourceDigest"),
		expectedEventHead: validateMemoryHead(value.expectedEventHead),
		expectedRevisions,
		reason: string(value.reason, "proposal reason", 8192),
		operations,
		provenance: parsedProvenance,
	};
}

export function validateMemoryCaptureSourceV1(value: unknown): MemoryCaptureSourceV1 {
	if (!isRecord(value)) throw new MemoryValidationError("memory capture source must be an object");
	exact(
		value,
		["schema", "captureId", "trigger", "sourceIds", "sourceDigest", "promptVersion", "createdAt"],
		"memory capture source",
	);
	if (value.schema !== MEMORY_CAPTURE_SOURCE_SCHEMA)
		throw new MemoryValidationError("memory capture source schema is unsupported");
	if (
		!["goal_checkpoint", "goal_completion", "chain_rollup", "explicit", "backfill"].includes(String(value.trigger))
	) {
		throw new MemoryValidationError("memory capture trigger is invalid");
	}
	const sourceIds = uniqueStrings(value.sourceIds, "capture sourceIds");
	if (sourceIds.length === 0) throw new MemoryValidationError("capture sourceIds must not be empty");
	return {
		schema: MEMORY_CAPTURE_SOURCE_SCHEMA,
		captureId: identifier(value.captureId, "capture", "captureId"),
		trigger: value.trigger as MemoryCaptureTrigger,
		sourceIds,
		sourceDigest: digest(value.sourceDigest, "capture sourceDigest"),
		promptVersion: string(value.promptVersion, "capture promptVersion", 160),
		createdAt: iso(value.createdAt, "capture createdAt"),
	};
}

export function validateMemoryHeadV1(value: unknown): MemoryHead {
	return validateMemoryHead(value);
}
