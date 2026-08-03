import {
	type EvidenceRefV1,
	type GitFreshnessBasisV1,
	type MemoryEdgeRelation,
	type MemoryEdgeV1,
	type MemoryGraphEndpointV1,
	type MemoryKind,
	type MemoryLifecycle,
	type MemoryProvenanceV1,
	type MemoryRevisionV1,
	type MemoryTrust,
	MemoryValidationError,
	validateEvidenceRefV1,
	validateGitFreshnessBasisV1,
	validateMemoryEdgeV1,
	validateMemoryRevisionV1,
} from "./memory-contract.ts";

export const MEMORY_EVIDENCE_REF_V2_SCHEMA = "pi-xk.memory-evidence-ref.v2";
export const MEMORY_EDGE_V2_SCHEMA = "pi-xk.memory-edge.v2";
export const MEMORY_EVENT_V2_SCHEMA = "pi-xk.memory-event.v2";
export const MEMORY_READ_MODEL_V2_SCHEMA = "pi-xk.memory-read-model.v2";
export const MEMORY_REVIEW_DECISION_SCHEMA = "pi-xk.memory-review-decision.v1";
export const MEMORY_RECONSTRUCTION_TRACE_SCHEMA = "pi-xk.memory-reconstruction-trace.v1";
export const MEMORY_REVISION_V2_SCHEMA = "pi-xk.memory-revision.v2";
export const MEMORY_REVIEW_PROMPT_VERSION = "pi-xk.memory-review-v1";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MEMORY_KINDS = new Set<MemoryKind>([
	"fact",
	"decision",
	"constraint",
	"preference",
	"procedure",
	"lesson",
	"outcome",
	"open_question",
]);
const MEMORY_TRUST = new Set<MemoryTrust>(["verified", "model_inferred", "disputed"]);
const MEMORY_LIFECYCLES = new Set<MemoryLifecycle>(["active", "superseded", "invalidated", "archived"]);

export const DEFAULT_AMBIENT_RECALL_BUDGET = {
	maxTotalKnowledgeActions: 10,
	maxMemoryActions: 8,
	maxMemorySearchCalls: 3,
	maxUniqueMemoryReads: 10,
	maxEvidenceReads: 6,
	maxSkillCandidateActions: 4,
} as const;

export type MemoryReviewAction = "keep" | "revise" | "supersede" | "dispute" | "create";
export type RecallStopReason =
	| "not_needed"
	| "sufficient"
	| "irrelevant"
	| "budget_exhausted"
	| "evidence_unavailable"
	| "conflict_found"
	| "run_failed";
export type MemoryRunOutcome = "succeeded" | "error" | "aborted" | "incomplete";
export type MemoryTransitionMode = "create" | "revise" | "supersede" | "dispute";
export type MemoryTrustDerivation =
	| "verbatim-user-evidence"
	| "host-verified"
	| "model-reconstruction"
	| "conflict-detected";

export interface AgentRunEvidenceLocatorV2 {
	projectId: string;
	sessionId: string;
	sessionFile: string;
	chainId: string | null;
	branchId: string | null;
	segmentId: string | null;
	requestEntryId: string;
	terminalAssistantEntryId: string;
	toolResultEntryIds: string[];
	rangeDigest: string;
}

export interface AgentRunEvidenceRefV2 {
	schema: typeof MEMORY_EVIDENCE_REF_V2_SCHEMA;
	evidenceId: string;
	sourceType: "agent_run";
	sourceId: string;
	artifactId: string | null;
	sourceDigest: string;
	recordedAt: string;
	locator: AgentRunEvidenceLocatorV2;
}

export type EvidenceRefV2 = EvidenceRefV1 | AgentRunEvidenceRefV2;

export interface MemorySemanticDraftV1 {
	kind: MemoryKind;
	title: string;
	statement: string;
	applicability: string;
	effectiveFrom: string;
	cueIds: string[];
}

export interface MemoryReviewSourceRevisionV1 {
	memoryId: string;
	expectedRevision: number;
}

export interface MemoryReviewDecisionV1 {
	schema: typeof MEMORY_REVIEW_DECISION_SCHEMA;
	decisionId: string;
	runId: string;
	action: MemoryReviewAction;
	sourceMemories: MemoryReviewSourceRevisionV1[];
	replacement: MemorySemanticDraftV1 | null;
	evidenceIds: string[];
	reason: string;
	provenance: MemoryProvenanceV1;
}

export interface AmbientRecallBudgetUsageV1 {
	totalKnowledgeActions: number;
	memoryActions: number;
	memorySearchCalls: number;
	uniqueMemoryReads: number;
	evidenceReads: number;
	skillCandidateActions: number;
}

export interface MemoryReconstructionTraceV1 {
	schema: typeof MEMORY_RECONSTRUCTION_TRACE_SCHEMA;
	runId: string;
	sessionId: string;
	startedAt: string;
	settledAt: string;
	queryDigests: string[];
	candidateIds: string[];
	readRevisions: Array<{ memoryId: string; revision: number }>;
	evidenceIds: string[];
	decisions: string[];
	budgetUsage: AmbientRecallBudgetUsageV1;
	stopReason: RecallStopReason;
	outcome: MemoryRunOutcome;
}

export interface MemoryRevisionV2 {
	schema: typeof MEMORY_REVISION_V2_SCHEMA;
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
	evidenceRefs: EvidenceRefV2[];
	freshnessBasis: GitFreshnessBasisV1 | null;
	sourceDigest: string;
	supersedesRevision: number | null;
	provenance: MemoryProvenanceV1;
	transition: {
		mode: MemoryTransitionMode;
		reviewId: string;
		sourceRevisions: Array<{ memoryId: string; revision: number }>;
		trustDerivation: MemoryTrustDerivation;
	};
}

export type MemoryRevision = MemoryRevisionV1 | MemoryRevisionV2;

export interface MemoryEdgeV2 {
	schema: typeof MEMORY_EDGE_V2_SCHEMA;
	edgeId: string;
	from: MemoryGraphEndpointV1;
	to: MemoryGraphEndpointV1;
	relation: MemoryEdgeRelation;
	effectiveFrom: string;
	effectiveTo: string | null;
	evidenceRefs: EvidenceRefV2[];
	sourceDigest: string;
	provenance: MemoryProvenanceV1;
}

export type MemoryEdge = MemoryEdgeV1 | MemoryEdgeV2;

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MemoryValidationError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new MemoryValidationError(`${field} has unknown or missing fields`);
	}
}

function text(value: unknown, field: string, maximum: number, oneLine = false): string {
	if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum || value.includes("\0")) {
		throw new MemoryValidationError(`${field} must be a non-empty bounded string`);
	}
	if (oneLine && /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
		throw new MemoryValidationError(`${field} must be one line`);
	}
	return value;
}

function id(value: unknown, field: string): string {
	const result = text(value, field, 160, true);
	if (!SAFE_ID_PATTERN.test(result)) throw new MemoryValidationError(`${field} is invalid`);
	return result;
}

function digest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
		throw new MemoryValidationError(`${field} must be a sha256 digest`);
	}
	return value;
}

function iso(value: unknown, field: string): string {
	const result = text(value, field, 80, true);
	if (Number.isNaN(Date.parse(result))) throw new MemoryValidationError(`${field} must be an ISO timestamp`);
	return result;
}

function integer(value: unknown, field: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
		throw new MemoryValidationError(`${field} must be an integer >= ${minimum}`);
	}
	return value;
}

function uniqueIds(value: unknown, field: string, maximum: number): string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new MemoryValidationError(`${field} must be bounded`);
	const result = value.map((entry, index) => id(entry, `${field}[${index}]`));
	if (new Set(result).size !== result.length) throw new MemoryValidationError(`${field} must be unique`);
	return result;
}

function provenance(value: unknown): MemoryProvenanceV1 {
	const input = record(value, "provenance");
	exact(input, ["producer", "model", "promptVersion", "recordedAt"], "provenance");
	if (!(["user", "pi-xk", "model"] as unknown[]).includes(input.producer)) {
		throw new MemoryValidationError("provenance producer is invalid");
	}
	return {
		producer: input.producer as MemoryProvenanceV1["producer"],
		model: input.model === null ? null : text(input.model, "provenance model", 256, true),
		promptVersion:
			input.promptVersion === null ? null : text(input.promptVersion, "provenance promptVersion", 256, true),
		recordedAt: iso(input.recordedAt, "provenance recordedAt"),
	};
}

export function validateAgentRunEvidenceRefV2(value: unknown): AgentRunEvidenceRefV2 {
	const input = record(value, "agent run evidence");
	exact(
		input,
		["schema", "evidenceId", "sourceType", "sourceId", "artifactId", "sourceDigest", "recordedAt", "locator"],
		"agent run evidence",
	);
	if (input.schema !== MEMORY_EVIDENCE_REF_V2_SCHEMA || input.sourceType !== "agent_run") {
		throw new MemoryValidationError("agent run evidence schema or sourceType is invalid");
	}
	const locator = record(input.locator, "agent run locator");
	exact(
		locator,
		[
			"projectId",
			"sessionId",
			"sessionFile",
			"chainId",
			"branchId",
			"segmentId",
			"requestEntryId",
			"terminalAssistantEntryId",
			"toolResultEntryIds",
			"rangeDigest",
		],
		"agent run locator",
	);
	const nullableId = (entry: unknown, field: string): string | null => (entry === null ? null : id(entry, field));
	const chainId = nullableId(locator.chainId, "agent run chainId");
	const branchId = nullableId(locator.branchId, "agent run branchId");
	const segmentId = nullableId(locator.segmentId, "agent run segmentId");
	if (
		[chainId, branchId, segmentId].some((entry) => entry === null) &&
		[chainId, branchId, segmentId].some((entry) => entry !== null)
	) {
		throw new MemoryValidationError("agent run Chain identity must be entirely present or absent");
	}
	return {
		schema: MEMORY_EVIDENCE_REF_V2_SCHEMA,
		evidenceId: id(input.evidenceId, "agent run evidenceId"),
		sourceType: "agent_run",
		sourceId: id(input.sourceId, "agent run sourceId"),
		artifactId: input.artifactId === null ? null : digest(input.artifactId, "agent run artifactId"),
		sourceDigest: digest(input.sourceDigest, "agent run sourceDigest"),
		recordedAt: iso(input.recordedAt, "agent run recordedAt"),
		locator: {
			projectId: id(locator.projectId, "agent run projectId"),
			sessionId: id(locator.sessionId, "agent run sessionId"),
			sessionFile: text(locator.sessionFile, "agent run sessionFile", 4_096, true),
			chainId,
			branchId,
			segmentId,
			requestEntryId: id(locator.requestEntryId, "agent run requestEntryId"),
			terminalAssistantEntryId: id(locator.terminalAssistantEntryId, "agent run terminalAssistantEntryId"),
			toolResultEntryIds: uniqueIds(locator.toolResultEntryIds, "agent run toolResultEntryIds", 100),
			rangeDigest: digest(locator.rangeDigest, "agent run rangeDigest"),
		},
	};
}

export function validateEvidenceRefV2(value: unknown): EvidenceRefV2 {
	const input = record(value, "evidence");
	return input.schema === MEMORY_EVIDENCE_REF_V2_SCHEMA
		? validateAgentRunEvidenceRefV2(input)
		: validateEvidenceRefV1(input);
}

function semanticDraft(value: unknown): MemorySemanticDraftV1 {
	const input = record(value, "Memory replacement");
	exact(input, ["kind", "title", "statement", "applicability", "effectiveFrom", "cueIds"], "Memory replacement");
	if (!MEMORY_KINDS.has(input.kind as MemoryKind))
		throw new MemoryValidationError("Memory replacement kind is invalid");
	return {
		kind: input.kind as MemoryKind,
		title: text(input.title, "Memory replacement title", 160, true),
		statement: text(input.statement, "Memory replacement statement", 16_384),
		applicability: text(input.applicability, "Memory replacement applicability", 8_192),
		effectiveFrom: iso(input.effectiveFrom, "Memory replacement effectiveFrom"),
		cueIds: uniqueIds(input.cueIds, "Memory replacement cueIds", 50),
	};
}

export function validateMemoryReviewDecisionV1(value: unknown): MemoryReviewDecisionV1 {
	const input = record(value, "Memory review decision");
	exact(
		input,
		[
			"schema",
			"decisionId",
			"runId",
			"action",
			"sourceMemories",
			"replacement",
			"evidenceIds",
			"reason",
			"provenance",
		],
		"Memory review decision",
	);
	if (input.schema !== MEMORY_REVIEW_DECISION_SCHEMA)
		throw new MemoryValidationError("Memory review schema is invalid");
	if (
		!(typeof input.action === "string" && ["keep", "revise", "supersede", "dispute", "create"].includes(input.action))
	) {
		throw new MemoryValidationError("Memory review action is invalid");
	}
	if (!Array.isArray(input.sourceMemories) || input.sourceMemories.length > 50) {
		throw new MemoryValidationError("Memory review sourceMemories must be bounded");
	}
	const sourceMemories = input.sourceMemories.map((entry, index) => {
		const source = record(entry, `Memory review sourceMemories[${index}]`);
		exact(source, ["memoryId", "expectedRevision"], `Memory review sourceMemories[${index}]`);
		return {
			memoryId: id(source.memoryId, `Memory review sourceMemories[${index}].memoryId`),
			expectedRevision: integer(
				source.expectedRevision,
				`Memory review sourceMemories[${index}].expectedRevision`,
				1,
			),
		};
	});
	if (new Set(sourceMemories.map((entry) => entry.memoryId)).size !== sourceMemories.length) {
		throw new MemoryValidationError("Memory review sourceMemories must be unique");
	}
	const action = input.action as MemoryReviewAction;
	const replacement = input.replacement === null ? null : semanticDraft(input.replacement);
	if (action === "keep" && replacement !== null) throw new MemoryValidationError("keep cannot contain a replacement");
	if (action !== "keep" && replacement === null) throw new MemoryValidationError(`${action} requires a replacement`);
	if (action === "create" && sourceMemories.length !== 0)
		throw new MemoryValidationError("create cannot name source memories");
	if (action !== "create" && sourceMemories.length === 0)
		throw new MemoryValidationError(`${action} requires source memories`);
	return {
		schema: MEMORY_REVIEW_DECISION_SCHEMA,
		decisionId: id(input.decisionId, "Memory review decisionId"),
		runId: id(input.runId, "Memory review runId"),
		action,
		sourceMemories,
		replacement,
		evidenceIds: uniqueIds(input.evidenceIds, "Memory review evidenceIds", 100),
		reason: text(input.reason, "Memory review reason", 8_192),
		provenance: provenance(input.provenance),
	};
}

export function validateMemoryReconstructionTraceV1(value: unknown): MemoryReconstructionTraceV1 {
	const input = record(value, "Memory reconstruction trace");
	exact(
		input,
		[
			"schema",
			"runId",
			"sessionId",
			"startedAt",
			"settledAt",
			"queryDigests",
			"candidateIds",
			"readRevisions",
			"evidenceIds",
			"decisions",
			"budgetUsage",
			"stopReason",
			"outcome",
		],
		"Memory reconstruction trace",
	);
	if (input.schema !== MEMORY_RECONSTRUCTION_TRACE_SCHEMA) throw new MemoryValidationError("trace schema is invalid");
	const budget = record(input.budgetUsage, "Memory reconstruction budget");
	exact(
		budget,
		[
			"totalKnowledgeActions",
			"memoryActions",
			"memorySearchCalls",
			"uniqueMemoryReads",
			"evidenceReads",
			"skillCandidateActions",
		],
		"Memory reconstruction budget",
	);
	const budgetUsage: AmbientRecallBudgetUsageV1 = {
		totalKnowledgeActions: integer(budget.totalKnowledgeActions, "totalKnowledgeActions"),
		memoryActions: integer(budget.memoryActions, "memoryActions"),
		memorySearchCalls: integer(budget.memorySearchCalls, "memorySearchCalls"),
		uniqueMemoryReads: integer(budget.uniqueMemoryReads, "uniqueMemoryReads"),
		evidenceReads: integer(budget.evidenceReads, "evidenceReads"),
		skillCandidateActions: integer(budget.skillCandidateActions, "skillCandidateActions"),
	};
	const limits: Array<[keyof AmbientRecallBudgetUsageV1, number]> = [
		["totalKnowledgeActions", DEFAULT_AMBIENT_RECALL_BUDGET.maxTotalKnowledgeActions],
		["memoryActions", DEFAULT_AMBIENT_RECALL_BUDGET.maxMemoryActions],
		["memorySearchCalls", DEFAULT_AMBIENT_RECALL_BUDGET.maxMemorySearchCalls],
		["uniqueMemoryReads", DEFAULT_AMBIENT_RECALL_BUDGET.maxUniqueMemoryReads],
		["evidenceReads", DEFAULT_AMBIENT_RECALL_BUDGET.maxEvidenceReads],
		["skillCandidateActions", DEFAULT_AMBIENT_RECALL_BUDGET.maxSkillCandidateActions],
	];
	if (limits.some(([key, maximum]) => budgetUsage[key] > maximum)) {
		throw new MemoryValidationError("Memory reconstruction budget exceeds the configured default");
	}
	if (
		!(
			typeof input.stopReason === "string" &&
			[
				"not_needed",
				"sufficient",
				"irrelevant",
				"budget_exhausted",
				"evidence_unavailable",
				"conflict_found",
				"run_failed",
			].includes(input.stopReason)
		)
	) {
		throw new MemoryValidationError("trace stopReason is invalid");
	}
	if (
		!(typeof input.outcome === "string" && ["succeeded", "error", "aborted", "incomplete"].includes(input.outcome))
	) {
		throw new MemoryValidationError("trace outcome is invalid");
	}
	if (!Array.isArray(input.readRevisions) || input.readRevisions.length > 10) {
		throw new MemoryValidationError("trace readRevisions must be bounded");
	}
	const readRevisions = input.readRevisions.map((entry, index) => {
		const revision = record(entry, `trace readRevisions[${index}]`);
		exact(revision, ["memoryId", "revision"], `trace readRevisions[${index}]`);
		return {
			memoryId: id(revision.memoryId, `trace readRevisions[${index}].memoryId`),
			revision: integer(revision.revision, `trace readRevisions[${index}].revision`, 1),
		};
	});
	return {
		schema: MEMORY_RECONSTRUCTION_TRACE_SCHEMA,
		runId: id(input.runId, "trace runId"),
		sessionId: id(input.sessionId, "trace sessionId"),
		startedAt: iso(input.startedAt, "trace startedAt"),
		settledAt: iso(input.settledAt, "trace settledAt"),
		queryDigests: Array.isArray(input.queryDigests)
			? input.queryDigests.map((entry, index) => digest(entry, `trace queryDigests[${index}]`))
			: (() => {
					throw new MemoryValidationError("trace queryDigests must be an array");
				})(),
		candidateIds: uniqueIds(input.candidateIds, "trace candidateIds", 200),
		readRevisions,
		evidenceIds: uniqueIds(input.evidenceIds, "trace evidenceIds", 100),
		decisions: uniqueIds(input.decisions, "trace decisions", 100),
		budgetUsage,
		stopReason: input.stopReason as RecallStopReason,
		outcome: input.outcome as MemoryRunOutcome,
	};
}

export function validateMemoryRevisionV2(value: unknown): MemoryRevisionV2 {
	const input = record(value, "Memory revision v2");
	exact(
		input,
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
			"transition",
		],
		"Memory revision v2",
	);
	if (input.schema !== MEMORY_REVISION_V2_SCHEMA)
		throw new MemoryValidationError("Memory revision v2 schema is invalid");
	if (!MEMORY_KINDS.has(input.kind as MemoryKind))
		throw new MemoryValidationError("Memory revision v2 kind is invalid");
	if (!MEMORY_TRUST.has(input.trust as MemoryTrust))
		throw new MemoryValidationError("Memory revision v2 trust is invalid");
	if (!MEMORY_LIFECYCLES.has(input.lifecycle as MemoryLifecycle)) {
		throw new MemoryValidationError("Memory revision v2 lifecycle is invalid");
	}
	if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 100) {
		throw new MemoryValidationError("Memory revision v2 evidenceRefs must be bounded");
	}
	const transition = record(input.transition, "Memory revision v2 transition");
	exact(transition, ["mode", "reviewId", "sourceRevisions", "trustDerivation"], "Memory revision v2 transition");
	if (
		!(typeof transition.mode === "string" && ["create", "revise", "supersede", "dispute"].includes(transition.mode))
	) {
		throw new MemoryValidationError("Memory revision v2 transition mode is invalid");
	}
	if (
		!(
			typeof transition.trustDerivation === "string" &&
			["verbatim-user-evidence", "host-verified", "model-reconstruction", "conflict-detected"].includes(
				transition.trustDerivation,
			)
		)
	) {
		throw new MemoryValidationError("Memory revision v2 trust derivation is invalid");
	}
	if (
		input.trust === "verified" &&
		!["verbatim-user-evidence", "host-verified"].includes(transition.trustDerivation as string)
	) {
		throw new MemoryValidationError("verified Memory requires a deterministic trust derivation");
	}
	if (input.trust === "disputed" && transition.trustDerivation !== "conflict-detected") {
		throw new MemoryValidationError("disputed Memory requires conflict-detected derivation");
	}
	if (!Array.isArray(transition.sourceRevisions) || transition.sourceRevisions.length > 50) {
		throw new MemoryValidationError("Memory revision v2 sourceRevisions must be bounded");
	}
	const sourceRevisions = transition.sourceRevisions.map((entry, index) => {
		const source = record(entry, `Memory revision v2 sourceRevisions[${index}]`);
		exact(source, ["memoryId", "revision"], `Memory revision v2 sourceRevisions[${index}]`);
		return {
			memoryId: id(source.memoryId, `Memory revision v2 sourceRevisions[${index}].memoryId`),
			revision: integer(source.revision, `Memory revision v2 sourceRevisions[${index}].revision`, 1),
		};
	});
	return {
		schema: MEMORY_REVISION_V2_SCHEMA,
		memoryId: id(input.memoryId, "Memory revision v2 memoryId"),
		revision: integer(input.revision, "Memory revision v2 revision", 1),
		kind: input.kind as MemoryKind,
		title: text(input.title, "Memory revision v2 title", 160, true),
		statement: text(input.statement, "Memory revision v2 statement", 16_384),
		applicability: text(input.applicability, "Memory revision v2 applicability", 8_192),
		trust: input.trust as MemoryTrust,
		lifecycle: input.lifecycle as MemoryLifecycle,
		effectiveFrom: iso(input.effectiveFrom, "Memory revision v2 effectiveFrom"),
		effectiveTo: input.effectiveTo === null ? null : iso(input.effectiveTo, "Memory revision v2 effectiveTo"),
		cueIds: uniqueIds(input.cueIds, "Memory revision v2 cueIds", 50),
		evidenceRefs: input.evidenceRefs.map(validateEvidenceRefV2),
		freshnessBasis: input.freshnessBasis === null ? null : validateGitFreshnessBasisV1(input.freshnessBasis),
		sourceDigest: digest(input.sourceDigest, "Memory revision v2 sourceDigest"),
		supersedesRevision:
			input.supersedesRevision === null
				? null
				: integer(input.supersedesRevision, "Memory revision v2 supersedesRevision", 1),
		provenance: provenance(input.provenance),
		transition: {
			mode: transition.mode as MemoryTransitionMode,
			reviewId: id(transition.reviewId, "Memory revision v2 reviewId"),
			sourceRevisions,
			trustDerivation: transition.trustDerivation as MemoryTrustDerivation,
		},
	};
}

export function validateMemoryRevision(value: unknown): MemoryRevision {
	const input = record(value, "Memory revision");
	return input.schema === MEMORY_REVISION_V2_SCHEMA ? validateMemoryRevisionV2(input) : importMemoryRevisionV1(input);
}

function importMemoryRevisionV1(value: unknown): MemoryRevisionV1 {
	return validateMemoryRevisionV1(value);
}

function graphEndpoint(value: unknown, field: string): MemoryGraphEndpointV1 {
	const input = record(value, field);
	exact(input, ["kind", "id"], field);
	if (input.kind !== "memory" && input.kind !== "cue") {
		throw new MemoryValidationError(`${field} kind is invalid`);
	}
	return { kind: input.kind, id: id(input.id, `${field} id`) };
}

export function validateMemoryEdgeV2(value: unknown): MemoryEdgeV2 {
	const input = record(value, "Memory edge v2");
	exact(
		input,
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
		"Memory edge v2",
	);
	if (input.schema !== MEMORY_EDGE_V2_SCHEMA) throw new MemoryValidationError("Memory edge v2 schema is invalid");
	if (
		!(
			typeof input.relation === "string" &&
			[
				"part_of",
				"depends_on",
				"implements",
				"applies_to",
				"caused_by",
				"supports",
				"contradicts",
				"supersedes",
				"related_to",
			].includes(input.relation)
		)
	) {
		throw new MemoryValidationError("Memory edge v2 relation is invalid");
	}
	const from = graphEndpoint(input.from, "Memory edge v2 from");
	const to = graphEndpoint(input.to, "Memory edge v2 to");
	if (from.kind === to.kind && from.id === to.id)
		throw new MemoryValidationError("Memory edge v2 cannot be a self edge");
	if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0 || input.evidenceRefs.length > 100) {
		throw new MemoryValidationError("Memory edge v2 evidenceRefs must be non-empty and bounded");
	}
	const effectiveFrom = iso(input.effectiveFrom, "Memory edge v2 effectiveFrom");
	const effectiveTo = input.effectiveTo === null ? null : iso(input.effectiveTo, "Memory edge v2 effectiveTo");
	if (effectiveTo !== null && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
		throw new MemoryValidationError("Memory edge v2 effectiveTo must be after effectiveFrom");
	}
	return {
		schema: MEMORY_EDGE_V2_SCHEMA,
		edgeId: id(input.edgeId, "Memory edge v2 edgeId"),
		from,
		to,
		relation: input.relation as MemoryEdgeRelation,
		effectiveFrom,
		effectiveTo,
		evidenceRefs: input.evidenceRefs.map(validateEvidenceRefV2),
		sourceDigest: digest(input.sourceDigest, "Memory edge v2 sourceDigest"),
		provenance: provenance(input.provenance),
	};
}

export function validateMemoryEdge(value: unknown): MemoryEdge {
	const input = record(value, "Memory edge");
	return input.schema === MEMORY_EDGE_V2_SCHEMA ? validateMemoryEdgeV2(input) : validateMemoryEdgeV1(input);
}
