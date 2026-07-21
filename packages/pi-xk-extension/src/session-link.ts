export const PI_XK_SESSION_LINK_SCHEMA = "pi-xk.session-link.v1";

export const PI_XK_SESSION_LINK_KIND = "goal_binding";

export const PI_XK_CHECKPOINT_REF_KIND = "checkpoint_ref";

export const PI_XK_CHECKPOINT_INTENT_KIND = "checkpoint_intent";

export const PI_XK_GOAL_CAPTURE_KIND = "goal_capture";

export const PI_XK_GOAL_DRAFT_KIND = "goal_draft";

export const PI_XK_GOAL_LIFECYCLE_INTENT_KIND = "goal_lifecycle_intent";

export interface PiXkSessionLink {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_SESSION_LINK_KIND;
	goalId: string;
	generation: number;
}

export interface PiXkCheckpointRef {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_REF_KIND;
	goalId: string;
	eventId: string;
	generation: number;
}

export interface PiXkTurnCheckpointIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_INTENT_KIND;
	goalId: string;
	sessionId: string;
	leafId: string;
	turnIndex: number;
	toolResultCount: number;
	reason: "turn_end";
	createdAt: string;
	generation: number;
}

export interface PiXkCompactionCheckpointIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_CHECKPOINT_INTENT_KIND;
	goalId: string;
	sessionId: string;
	leafId: string;
	reason: "session_before_compact";
	createdAt: string;
	generation: number;
}

export type PiXkCheckpointIntent = PiXkTurnCheckpointIntent | PiXkCompactionCheckpointIntent;

export type PiXkGoalCaptureState = "open" | "cancelled" | "consumed";

export interface PiXkGoalCapture {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_CAPTURE_KIND;
	captureId: string;
	state: PiXkGoalCaptureState;
	createdAt: string;
}

export type PiXkGoalDraftState = "requested" | "proposed" | "superseded" | "confirming" | "confirmed" | "cancelled";

export type PiXkGoalDraftAcceptanceKind = "command" | "test" | "artifact" | "approval";

export interface PiXkGoalDraftAcceptance {
	id: string;
	kind: PiXkGoalDraftAcceptanceKind;
	description: string;
	required: boolean;
	command?: string;
}

export interface PiXkGoalDraftProposal {
	title: string;
	objective: string;
	constraints: string[];
	acceptance: PiXkGoalDraftAcceptance[];
	nonGoals: string[];
	doneCondition: string;
	pauseCondition: string;
	finalReport: string;
	executionAuthorization: string;
}

/** A session-local candidate contract. It does not create a Goal until confirming has a Goal ID. */
export interface PiXkGoalDraft {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_DRAFT_KIND;
	draftId: string;
	state: PiXkGoalDraftState;
	objective: string;
	revisionFeedback: string | null;
	proposal: PiXkGoalDraftProposal | null;
	goalId: string | null;
	createdAt: string;
}

export type PiXkGoalLifecycleIntentAction = "start" | "pause" | "end";

export type PiXkGoalLifecycleIntentState = "requested" | "committed";

export interface PiXkGoalPauseAudit {
	unmetRequiredAcceptanceIds: string[];
	currentEvidence: string;
	incompleteConclusion: string;
}

export interface PiXkGoalLifecycleIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_LIFECYCLE_INTENT_KIND;
	intentId: string;
	goalId: string;
	generation: number;
	actor: "user" | "model";
	action: PiXkGoalLifecycleIntentAction;
	state: PiXkGoalLifecycleIntentState;
	runId: string;
	reason: string;
	resumeEvidence: string;
	userRequest: string | null;
	nextBestAction: string;
	audit: PiXkGoalPauseAudit;
	outcome: string;
	verifiedAcceptanceIds: string[];
	finalEvidence: string;
	finalSummary: string;
	createdAt: string;
}

/** Legacy entries are accepted only so session recovery can normalize missing Phase 1.8 fields. */
interface PiXkLegacyGoalLifecycleIntent {
	schema: typeof PI_XK_SESSION_LINK_SCHEMA;
	kind: typeof PI_XK_GOAL_LIFECYCLE_INTENT_KIND;
	intentId: string;
	goalId: string;
	generation: number;
	actor: "user" | "model";
	action: "pause" | "end";
	state: PiXkGoalLifecycleIntentState;
	runId: string;
	reason: string;
	nextBestAction: string;
	outcome: string;
	finalEvidence: string;
	createdAt: string;
}

export type PiXkStoredGoalLifecycleIntent = PiXkGoalLifecycleIntent | PiXkLegacyGoalLifecycleIntent;

const GOAL_ID_PATTERN = /^goal_[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function isGoalId(value: unknown): value is string {
	if (!isNonEmptyString(value)) return false;
	return GOAL_ID_PATTERN.test(value);
}

function isGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
	return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function assertGoalIdValue(value: string): string {
	if (!isGoalId(value)) {
		throw new Error("Pi-XK session link goalId must use the goal_<safe-id> format");
	}
	return value;
}

function assertNonEmptyString(value: string, field: string): string {
	if (!isNonEmptyString(value)) {
		throw new Error(`Pi-XK checkpoint ${field} must be a non-empty string`);
	}
	return value;
}

function assertString(value: string, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`Pi-XK lifecycle intent ${field} must be a string`);
	}
	return value;
}

function assertNullableString(value: string | null, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw new Error(`Pi-XK lifecycle intent ${field} must be a string or null`);
	}
	return value;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertStringArray(value: string[], field: string): string[] {
	if (!isStringArray(value)) {
		throw new Error(`Pi-XK lifecycle intent ${field} must be a string array`);
	}
	return [...value];
}

function isGoalPauseAudit(value: unknown): value is PiXkGoalPauseAudit {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["unmetRequiredAcceptanceIds", "currentEvidence", "incompleteConclusion"]) &&
		isStringArray(value.unmetRequiredAcceptanceIds) &&
		typeof value.currentEvidence === "string" &&
		typeof value.incompleteConclusion === "string"
	);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoalDraftAcceptance(value: unknown): value is PiXkGoalDraftAcceptance {
	if (!isRecord(value)) return false;
	const kind = value.kind;
	const requiresCommand = kind === "command" || kind === "test";
	const hasCommand = "command" in value;
	if (requiresCommand !== hasCommand) return false;
	const keys = hasCommand
		? ["id", "kind", "description", "required", "command"]
		: ["id", "kind", "description", "required"];
	return (
		hasExactKeys(value, keys) &&
		isNonEmptyString(value.id) &&
		(kind === "command" || kind === "test" || kind === "artifact" || kind === "approval") &&
		isNonEmptyString(value.description) &&
		typeof value.required === "boolean" &&
		(!hasCommand || isNonEmptyString(value.command))
	);
}

function isGoalDraftProposal(value: unknown): value is PiXkGoalDraftProposal {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"title",
			"objective",
			"constraints",
			"acceptance",
			"nonGoals",
			"doneCondition",
			"pauseCondition",
			"finalReport",
			"executionAuthorization",
		]) ||
		!isNonEmptyString(value.title) ||
		!isNonEmptyString(value.objective) ||
		!isStringList(value.constraints) ||
		!Array.isArray(value.acceptance) ||
		!value.acceptance.every(isGoalDraftAcceptance) ||
		!isStringList(value.nonGoals) ||
		!isNonEmptyString(value.doneCondition) ||
		!isNonEmptyString(value.pauseCondition) ||
		!isNonEmptyString(value.finalReport) ||
		!isNonEmptyString(value.executionAuthorization)
	) {
		return false;
	}
	const acceptanceIds = new Set<string>();
	for (const acceptance of value.acceptance) {
		if (acceptanceIds.has(acceptance.id)) return false;
		acceptanceIds.add(acceptance.id);
	}
	return value.acceptance.some((acceptance) => acceptance.required);
}

function assertGoalPauseAudit(value: PiXkGoalPauseAudit): PiXkGoalPauseAudit {
	if (!isGoalPauseAudit(value)) {
		throw new Error("Pi-XK lifecycle intent audit is invalid");
	}
	return {
		unmetRequiredAcceptanceIds: [...value.unmetRequiredAcceptanceIds],
		currentEvidence: value.currentEvidence,
		incompleteConclusion: value.incompleteConclusion,
	};
}

function assertTimestamp(value: string): string {
	if (!isTimestamp(value)) {
		throw new Error("Pi-XK checkpoint createdAt must be an ISO timestamp");
	}
	return value;
}

function assertGeneration(value: number): number {
	if (!isGeneration(value)) {
		throw new Error("Pi-XK session link generation must be a non-negative integer");
	}
	return value;
}

function assertNonNegativeInteger(value: number, field: string): number {
	if (!isGeneration(value)) {
		throw new Error(`Pi-XK checkpoint ${field} must be a non-negative integer`);
	}
	return value;
}

export function isPiXkSessionLink(value: unknown): value is PiXkSessionLink {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "kind", "goalId", "generation"])) {
		return false;
	}
	return (
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_SESSION_LINK_KIND &&
		isGoalId(value.goalId) &&
		isGeneration(value.generation)
	);
}

export function isPiXkCheckpointRef(value: unknown): value is PiXkCheckpointRef {
	if (!isRecord(value) || !hasExactKeys(value, ["schema", "kind", "goalId", "eventId", "generation"])) {
		return false;
	}
	return (
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_CHECKPOINT_REF_KIND &&
		isGoalId(value.goalId) &&
		isNonEmptyString(value.eventId) &&
		isGeneration(value.generation)
	);
}

export function isPiXkCheckpointIntent(value: unknown): value is PiXkCheckpointIntent {
	if (!isRecord(value)) return false;
	if (
		value.schema !== PI_XK_SESSION_LINK_SCHEMA ||
		value.kind !== PI_XK_CHECKPOINT_INTENT_KIND ||
		!isGoalId(value.goalId) ||
		!isNonEmptyString(value.sessionId) ||
		!isNonEmptyString(value.leafId) ||
		!isTimestamp(value.createdAt) ||
		!isGeneration(value.generation)
	) {
		return false;
	}
	if (value.reason === "turn_end") {
		return (
			hasExactKeys(value, [
				"schema",
				"kind",
				"goalId",
				"sessionId",
				"leafId",
				"turnIndex",
				"toolResultCount",
				"reason",
				"createdAt",
				"generation",
			]) &&
			isGeneration(value.turnIndex) &&
			isGeneration(value.toolResultCount)
		);
	}
	return (
		value.reason === "session_before_compact" &&
		hasExactKeys(value, ["schema", "kind", "goalId", "sessionId", "leafId", "reason", "createdAt", "generation"])
	);
}

export function isPiXkGoalCapture(value: unknown): value is PiXkGoalCapture {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schema", "kind", "captureId", "state", "createdAt"]) &&
		value.schema === PI_XK_SESSION_LINK_SCHEMA &&
		value.kind === PI_XK_GOAL_CAPTURE_KIND &&
		isNonEmptyString(value.captureId) &&
		(value.state === "open" || value.state === "cancelled" || value.state === "consumed") &&
		isTimestamp(value.createdAt)
	);
}

export function isPiXkGoalDraft(value: unknown): value is PiXkGoalDraft {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schema",
			"kind",
			"draftId",
			"state",
			"objective",
			"revisionFeedback",
			"proposal",
			"goalId",
			"createdAt",
		]) ||
		value.schema !== PI_XK_SESSION_LINK_SCHEMA ||
		value.kind !== PI_XK_GOAL_DRAFT_KIND ||
		!isNonEmptyString(value.draftId) ||
		(value.state !== "requested" &&
			value.state !== "proposed" &&
			value.state !== "superseded" &&
			value.state !== "confirming" &&
			value.state !== "confirmed" &&
			value.state !== "cancelled") ||
		typeof value.objective !== "string" ||
		(value.revisionFeedback !== null && !isNonEmptyString(value.revisionFeedback)) ||
		(value.proposal !== null && !isGoalDraftProposal(value.proposal)) ||
		(value.goalId !== null && !isGoalId(value.goalId)) ||
		!isTimestamp(value.createdAt)
	) {
		return false;
	}
	if (value.state === "requested") return value.proposal === null && value.goalId === null;
	if (value.state === "proposed" || value.state === "superseded")
		return value.proposal !== null && value.goalId === null;
	if (value.state === "confirming" || value.state === "confirmed")
		return value.proposal !== null && value.goalId !== null;
	return value.goalId === null;
}

export function isPiXkGoalLifecycleIntent(value: unknown): value is PiXkStoredGoalLifecycleIntent {
	if (
		!isRecord(value) ||
		value.schema !== PI_XK_SESSION_LINK_SCHEMA ||
		value.kind !== PI_XK_GOAL_LIFECYCLE_INTENT_KIND ||
		!isNonEmptyString(value.intentId) ||
		!isGoalId(value.goalId) ||
		!isGeneration(value.generation) ||
		(value.actor !== "user" && value.actor !== "model") ||
		(value.state !== "requested" && value.state !== "committed") ||
		typeof value.runId !== "string" ||
		typeof value.reason !== "string" ||
		typeof value.nextBestAction !== "string" ||
		typeof value.outcome !== "string" ||
		typeof value.finalEvidence !== "string" ||
		!isTimestamp(value.createdAt)
	) {
		return false;
	}
	if (
		hasExactKeys(value, [
			"schema",
			"kind",
			"intentId",
			"goalId",
			"generation",
			"actor",
			"action",
			"state",
			"runId",
			"reason",
			"resumeEvidence",
			"userRequest",
			"nextBestAction",
			"audit",
			"outcome",
			"verifiedAcceptanceIds",
			"finalEvidence",
			"finalSummary",
			"createdAt",
		])
	) {
		return (
			(value.action === "start" || value.action === "pause" || value.action === "end") &&
			typeof value.resumeEvidence === "string" &&
			(value.userRequest === null || typeof value.userRequest === "string") &&
			isGoalPauseAudit(value.audit) &&
			isStringArray(value.verifiedAcceptanceIds) &&
			typeof value.finalSummary === "string"
		);
	}
	return (
		hasExactKeys(value, [
			"schema",
			"kind",
			"intentId",
			"goalId",
			"generation",
			"actor",
			"action",
			"state",
			"runId",
			"reason",
			"nextBestAction",
			"outcome",
			"finalEvidence",
			"createdAt",
		]) &&
		(value.action === "pause" || value.action === "end")
	);
}

export function normalizePiXkGoalLifecycleIntent(intent: PiXkStoredGoalLifecycleIntent): PiXkGoalLifecycleIntent {
	if ("resumeEvidence" in intent) {
		return {
			...intent,
			audit: {
				unmetRequiredAcceptanceIds: [...intent.audit.unmetRequiredAcceptanceIds],
				currentEvidence: intent.audit.currentEvidence,
				incompleteConclusion: intent.audit.incompleteConclusion,
			},
			verifiedAcceptanceIds: [...intent.verifiedAcceptanceIds],
		};
	}
	return {
		schema: intent.schema,
		kind: intent.kind,
		intentId: intent.intentId,
		goalId: intent.goalId,
		generation: intent.generation,
		actor: intent.actor,
		action: intent.action,
		state: intent.state,
		runId: intent.runId,
		reason: intent.reason,
		resumeEvidence: "",
		userRequest: null,
		nextBestAction: intent.nextBestAction,
		audit: {
			unmetRequiredAcceptanceIds: [],
			currentEvidence: "",
			incompleteConclusion: "Legacy lifecycle intent did not record a pause audit.",
		},
		outcome: intent.outcome,
		verifiedAcceptanceIds: [],
		finalEvidence: intent.finalEvidence,
		finalSummary: "",
		createdAt: intent.createdAt,
	};
}

export function createPiXkGoalBinding(goalId: string, generation: number): PiXkSessionLink {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_SESSION_LINK_KIND,
		goalId: assertGoalIdValue(goalId),
		generation: assertGeneration(generation),
	};
}

export function createPiXkCheckpointRef(goalId: string, eventId: string, generation: number): PiXkCheckpointRef {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_REF_KIND,
		goalId: assertGoalIdValue(goalId),
		eventId: assertNonEmptyString(eventId, "eventId"),
		generation: assertGeneration(generation),
	};
}

export function createPiXkTurnCheckpointIntent(
	goalId: string,
	sessionId: string,
	leafId: string,
	turnIndex: number,
	toolResultCount: number,
	generation: number,
	createdAt: string,
): PiXkTurnCheckpointIntent {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_INTENT_KIND,
		goalId: assertGoalIdValue(goalId),
		sessionId: assertNonEmptyString(sessionId, "sessionId"),
		leafId: assertNonEmptyString(leafId, "leafId"),
		turnIndex: assertNonNegativeInteger(turnIndex, "turnIndex"),
		toolResultCount: assertNonNegativeInteger(toolResultCount, "toolResultCount"),
		reason: "turn_end",
		createdAt: assertTimestamp(createdAt),
		generation: assertGeneration(generation),
	};
}

export function createPiXkCompactionCheckpointIntent(
	goalId: string,
	sessionId: string,
	leafId: string,
	generation: number,
	createdAt: string,
): PiXkCompactionCheckpointIntent {
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_CHECKPOINT_INTENT_KIND,
		goalId: assertGoalIdValue(goalId),
		sessionId: assertNonEmptyString(sessionId, "sessionId"),
		leafId: assertNonEmptyString(leafId, "leafId"),
		reason: "session_before_compact",
		createdAt: assertTimestamp(createdAt),
		generation: assertGeneration(generation),
	};
}

export function createPiXkGoalCapture(
	captureId: string,
	state: PiXkGoalCaptureState,
	createdAt: string,
): PiXkGoalCapture {
	if (state !== "open" && state !== "cancelled" && state !== "consumed") {
		throw new Error("Pi-XK Goal capture state is invalid");
	}
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_GOAL_CAPTURE_KIND,
		captureId: assertNonEmptyString(captureId, "captureId"),
		state,
		createdAt: assertTimestamp(createdAt),
	};
}

function cloneGoalDraftProposal(proposal: PiXkGoalDraftProposal): PiXkGoalDraftProposal {
	return {
		title: proposal.title,
		objective: proposal.objective,
		constraints: [...proposal.constraints],
		acceptance: proposal.acceptance.map((acceptance) => ({ ...acceptance })),
		nonGoals: [...proposal.nonGoals],
		doneCondition: proposal.doneCondition,
		pauseCondition: proposal.pauseCondition,
		finalReport: proposal.finalReport,
		executionAuthorization: proposal.executionAuthorization,
	};
}

export function createPiXkGoalDraft(draft: Omit<PiXkGoalDraft, "schema" | "kind">): PiXkGoalDraft {
	const value: PiXkGoalDraft = {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_GOAL_DRAFT_KIND,
		draftId: draft.draftId,
		state: draft.state,
		objective: draft.objective,
		revisionFeedback: draft.revisionFeedback,
		proposal: draft.proposal === null ? null : cloneGoalDraftProposal(draft.proposal),
		goalId: draft.goalId,
		createdAt: draft.createdAt,
	};
	if (!isPiXkGoalDraft(value)) {
		throw new Error("Pi-XK Goal draft is invalid");
	}
	return value;
}

export function createPiXkGoalLifecycleIntent(
	intent: Omit<PiXkGoalLifecycleIntent, "schema" | "kind">,
): PiXkGoalLifecycleIntent {
	if (intent.action !== "start" && intent.action !== "pause" && intent.action !== "end") {
		throw new Error("Pi-XK Goal lifecycle intent action is invalid");
	}
	if (intent.state !== "requested" && intent.state !== "committed") {
		throw new Error("Pi-XK Goal lifecycle intent state is invalid");
	}
	if (intent.actor !== "user" && intent.actor !== "model") {
		throw new Error("Pi-XK Goal lifecycle intent actor is invalid");
	}
	return {
		schema: PI_XK_SESSION_LINK_SCHEMA,
		kind: PI_XK_GOAL_LIFECYCLE_INTENT_KIND,
		intentId: assertNonEmptyString(intent.intentId, "intentId"),
		goalId: assertGoalIdValue(intent.goalId),
		generation: assertGeneration(intent.generation),
		actor: intent.actor,
		action: intent.action,
		state: intent.state,
		runId: assertString(intent.runId, "runId"),
		reason: assertString(intent.reason, "reason"),
		resumeEvidence: assertString(intent.resumeEvidence, "resumeEvidence"),
		userRequest: assertNullableString(intent.userRequest, "userRequest"),
		nextBestAction: assertString(intent.nextBestAction, "nextBestAction"),
		audit: assertGoalPauseAudit(intent.audit),
		outcome: assertString(intent.outcome, "outcome"),
		verifiedAcceptanceIds: assertStringArray(intent.verifiedAcceptanceIds, "verifiedAcceptanceIds"),
		finalEvidence: assertString(intent.finalEvidence, "finalEvidence"),
		finalSummary: assertString(intent.finalSummary, "finalSummary"),
		createdAt: assertTimestamp(intent.createdAt),
	};
}

export function assertPiXkSessionLink(value: unknown): asserts value is PiXkSessionLink {
	if (!isPiXkSessionLink(value)) {
		throw new Error("Pi-XK session link must use the pi-xk.session-link.v1 goal_binding schema");
	}
}
