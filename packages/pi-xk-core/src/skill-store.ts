import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "./artifact-store.ts";
import { validateMemoryEvidenceOwnership } from "./memory-evidence.ts";
import {
	SKILL_BUNDLE_MANIFEST_SCHEMA,
	SKILL_CANDIDATE_SCHEMA,
	SKILL_REVIEW_DECISION_SCHEMA,
	SKILL_REVISION_SCHEMA,
	SKILL_USE_EVIDENCE_SCHEMA,
	type SkillBundleManifestV1,
	type SkillCandidateV1,
	type SkillEvidenceV1,
	type SkillReviewDecisionV1,
	type SkillRevisionV1,
	type SkillScope,
	type SkillUseEvidenceV1,
	SkillValidationError,
	validateSkillBundleManifestV1,
	validateSkillCandidateV1,
	validateSkillReviewDecisionV1,
	validateSkillRevisionV1,
	validateSkillUseEvidenceV1,
} from "./skill-contract.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";
import {
	type FileWriteLockOptions,
	inspectFileWriteLock,
	repairAbandonedFileWriteLock,
	type WriteLockDiagnostic,
	withFileWriteLock,
} from "./write-lock.ts";

export const SKILL_EVENT_SCHEMA = "pi-xk.skill-event.v1";
export const SKILL_READ_MODEL_SCHEMA = "pi-xk.skill-read-model.v1";
export const SKILL_MANAGED_MARKER_SCHEMA = "pi-xk.managed-skill.v1";

const SKILL_EVENT_TYPES = new Set<SkillEventType>([
	"candidate_recorded",
	"candidate_rejected",
	"skill_use_recorded",
	"skill_change_applied",
	"skill_promotion_eligible",
	"skill_promoted",
	"skill_publication_failed",
	"skill_archived",
	"skill_purged",
]);

export type SkillEventType =
	| "candidate_recorded"
	| "candidate_rejected"
	| "skill_use_recorded"
	| "skill_change_applied"
	| "skill_promotion_eligible"
	| "skill_promoted"
	| "skill_publication_failed"
	| "skill_archived"
	| "skill_purged";

export type SkillActor = "user" | "model" | "runtime";

export interface SkillHead {
	sequence: number;
	hash: string | null;
}

export interface SkillPublishedRevisionRefV1 {
	skillId: string;
	revision: number;
	artifactId: string;
	bundleArtifactId: string;
	name: string;
	scope: SkillScope;
	lifecycle: SkillRevisionV1["lifecycle"];
	sourceDigest: string;
}

export interface SkillCandidateProjectionV1 {
	candidateId: string;
	skillId: string;
	artifactId: string;
	reviewArtifactId: string | null;
	bundleArtifactId: string;
	targetScope: SkillScope;
	expectedRevision: number | null;
	name: string;
	status: "pending" | "applied" | "rejected";
	sourceDigest: string;
}

export interface SkillUseProjectionV1 {
	useId: string;
	artifactId: string;
	skillId: string;
	revision: number;
	projectId: string;
	outcome: SkillUseEvidenceV1["outcome"];
	recordedAt: string;
}

export interface SkillPublicationFailureV1 {
	skillId: string;
	revision: number;
	stage: "projection" | "reload" | "promotion";
	errorCode: string;
	message: string;
	recordedAt: string;
}

interface CandidateRecordedPayloadV1 {
	candidate: SkillCandidateProjectionV1;
}

interface CandidateRejectedPayloadV1 {
	candidateId: string;
	reason: string;
}

interface SkillUseRecordedPayloadV1 {
	use: SkillUseProjectionV1;
}

interface SkillChangeAppliedPayloadV1 {
	candidateId: string;
	revisions: SkillPublishedRevisionRefV1[];
}

interface SkillPromotionEligiblePayloadV1 {
	skillId: string;
	revision: number;
	projectIds: string[];
	successfulUses: number;
}

interface SkillPromotedPayloadV1 {
	candidateId: string;
	revision: SkillPublishedRevisionRefV1;
}

interface SkillPublicationFailedPayloadV1 extends SkillPublicationFailureV1 {}

interface SkillArchivedPayloadV1 {
	revision: SkillPublishedRevisionRefV1;
	reason: string;
}

interface SkillPurgedPayloadV1 {
	skillId: string;
	revisionArtifactIds: string[];
	bundleArtifactIds: string[];
	candidateArtifactIds: string[];
	reviewArtifactIds: string[];
	fileArtifactIds: string[];
	sourceDigest: string;
}

interface SkillEventPayloadMapV1 {
	candidate_recorded: CandidateRecordedPayloadV1;
	candidate_rejected: CandidateRejectedPayloadV1;
	skill_use_recorded: SkillUseRecordedPayloadV1;
	skill_change_applied: SkillChangeAppliedPayloadV1;
	skill_promotion_eligible: SkillPromotionEligiblePayloadV1;
	skill_promoted: SkillPromotedPayloadV1;
	skill_publication_failed: SkillPublicationFailedPayloadV1;
	skill_archived: SkillArchivedPayloadV1;
	skill_purged: SkillPurgedPayloadV1;
}

interface SkillEventBaseV1 {
	schema: typeof SKILL_EVENT_SCHEMA;
	eventId: string;
	sequence: number;
	actor: SkillActor;
	timestamp: string;
	prevHash: string | null;
	schemaVersion: 1;
	idempotencyKey: string;
	hash: string;
}

export type SkillEventV1 = {
	[TEventType in SkillEventType]: SkillEventBaseV1 & {
		eventType: TEventType;
		payload: SkillEventPayloadMapV1[TEventType];
	};
}[SkillEventType];

type SkillEventWithoutHash = {
	[TEventType in SkillEventType]: Omit<Extract<SkillEventV1, { eventType: TEventType }>, "hash">;
}[SkillEventType];

export interface SkillReadModelV1 {
	schema: typeof SKILL_READ_MODEL_SCHEMA;
	head: SkillHead;
	eventBytes: number;
	candidates: SkillCandidateProjectionV1[];
	revisions: SkillPublishedRevisionRefV1[];
	revisionHistory: SkillPublishedRevisionRefV1[];
	uses: SkillUseProjectionV1[];
	promotionEligibleSkillIds: string[];
	promotedCandidateIds: string[];
	publicationFailures: SkillPublicationFailureV1[];
	purgedSkillIds: string[];
	idempotencyKeys: string[];
}

export interface SkillMutationOptions {
	eventId: string;
	idempotencyKey: string;
	expectedHead: SkillHead;
	actor?: SkillActor;
	timestamp: string;
}

export interface SkillBundleDraftV1 {
	instructions: {
		steps: string;
		validation: string;
		failureHandling: string;
	};
	resources: Array<{ path: string; content: string; executable: boolean }>;
}

export interface SkillBundleSourceV1 {
	candidateId: string;
	skillId: string;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	provenance: SkillCandidateV1["provenance"];
}

export interface SkillStoreOptions {
	scope?: SkillScope;
	agentDir?: string;
	projectId?: string;
	now?: () => string;
}

export interface SkillStoreStatusV1 {
	head: SkillHead;
	active: number;
	archived: number;
	candidates: number;
	stale: number;
	needsReview: number;
	publicationFailures: number;
}

export interface SkillDoctorReportV1 {
	ok: boolean;
	diagnostics: Array<{ code: string; message: string; repairable: boolean }>;
	checkedEvents: number;
	checkedArtifacts: number;
}

export interface SkillPurgeResultV1 {
	head: SkillHead;
	removedArtifactIds: string[];
	retainedArtifactIds: string[];
	cleanupDiagnostics: string[];
}

export class SkillStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillStoreError";
	}
}

export class SkillCorruptionError extends SkillStoreError {
	constructor(message: string) {
		super(message);
		this.name = "SkillCorruptionError";
	}
}

export class SkillHeadConflictError extends SkillStoreError {
	constructor(expected: SkillHead, actual: SkillHead) {
		super(
			`Skill head conflict: expected ${expected.sequence}/${expected.hash}, actual ${actual.sequence}/${actual.hash}`,
		);
		this.name = "SkillHeadConflictError";
	}
}

export class SkillRevisionConflictError extends SkillStoreError {
	constructor(skillId: string, expected: number | null, actual: number | null) {
		super(`Skill revision conflict for ${skillId}: expected ${expected}, actual ${actual}`);
		this.name = "SkillRevisionConflictError";
	}
}

export class SkillProjectionCollisionError extends SkillStoreError {
	constructor(name: string) {
		super(`Skill projection collides with a non-managed Skill: ${name}`);
		this.name = "SkillProjectionCollisionError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new SkillCorruptionError(`${field} is not an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new SkillCorruptionError(`${field} has unknown or missing fields`);
	}
	return value;
}

function eventText(value: unknown, field: string, maximum = 1_024): string {
	if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum || value.includes("\0")) {
		throw new SkillCorruptionError(`${field} is invalid`);
	}
	return value;
}

function eventInteger(value: unknown, field: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
		throw new SkillCorruptionError(`${field} is invalid`);
	}
	return value;
}

function eventDigest(value: unknown, field: string): string {
	const result = eventText(value, field, 71);
	if (!/^sha256:[a-f0-9]{64}$/u.test(result)) throw new SkillCorruptionError(`${field} is invalid`);
	return result;
}

function eventTimestamp(value: unknown, field: string): string {
	const result = eventText(value, field, 80);
	if (Number.isNaN(Date.parse(result))) throw new SkillCorruptionError(`${field} is invalid`);
	return result;
}

function validateRevisionReferencePayload(value: unknown, field: string): void {
	const input = exactRecord(
		value,
		["skillId", "revision", "artifactId", "bundleArtifactId", "name", "scope", "lifecycle", "sourceDigest"],
		field,
	);
	eventText(input.skillId, `${field}.skillId`, 160);
	eventInteger(input.revision, `${field}.revision`, 1);
	eventDigest(input.artifactId, `${field}.artifactId`);
	eventDigest(input.bundleArtifactId, `${field}.bundleArtifactId`);
	eventText(input.name, `${field}.name`, 64);
	if (input.scope !== "project" && input.scope !== "global")
		throw new SkillCorruptionError(`${field}.scope is invalid`);
	if (input.lifecycle !== "active" && input.lifecycle !== "superseded" && input.lifecycle !== "archived") {
		throw new SkillCorruptionError(`${field}.lifecycle is invalid`);
	}
	eventDigest(input.sourceDigest, `${field}.sourceDigest`);
}

function validateCandidateProjectionPayload(value: unknown, field: string): void {
	const input = exactRecord(
		value,
		[
			"candidateId",
			"skillId",
			"artifactId",
			"reviewArtifactId",
			"bundleArtifactId",
			"targetScope",
			"expectedRevision",
			"name",
			"status",
			"sourceDigest",
		],
		field,
	);
	eventText(input.candidateId, `${field}.candidateId`, 160);
	eventText(input.skillId, `${field}.skillId`, 160);
	eventDigest(input.artifactId, `${field}.artifactId`);
	if (input.reviewArtifactId !== null) eventDigest(input.reviewArtifactId, `${field}.reviewArtifactId`);
	eventDigest(input.bundleArtifactId, `${field}.bundleArtifactId`);
	if (input.targetScope !== "project" && input.targetScope !== "global") {
		throw new SkillCorruptionError(`${field}.targetScope is invalid`);
	}
	if (input.expectedRevision !== null) eventInteger(input.expectedRevision, `${field}.expectedRevision`, 1);
	eventText(input.name, `${field}.name`, 64);
	if (input.status !== "pending" && input.status !== "applied" && input.status !== "rejected") {
		throw new SkillCorruptionError(`${field}.status is invalid`);
	}
	eventDigest(input.sourceDigest, `${field}.sourceDigest`);
}

function validateUseProjectionPayload(value: unknown, field: string): void {
	const input = exactRecord(
		value,
		["useId", "artifactId", "skillId", "revision", "projectId", "outcome", "recordedAt"],
		field,
	);
	eventText(input.useId, `${field}.useId`, 160);
	eventDigest(input.artifactId, `${field}.artifactId`);
	eventText(input.skillId, `${field}.skillId`, 160);
	eventInteger(input.revision, `${field}.revision`, 1);
	eventText(input.projectId, `${field}.projectId`, 160);
	if (input.outcome !== "success" && input.outcome !== "failure" && input.outcome !== "unknown") {
		throw new SkillCorruptionError(`${field}.outcome is invalid`);
	}
	eventTimestamp(input.recordedAt, `${field}.recordedAt`);
}

function validateEventPayload(eventType: SkillEventType, value: unknown, field: string): void {
	if (eventType === "candidate_recorded") {
		const input = exactRecord(value, ["candidate"], field);
		validateCandidateProjectionPayload(input.candidate, `${field}.candidate`);
		return;
	}
	if (eventType === "candidate_rejected") {
		const input = exactRecord(value, ["candidateId", "reason"], field);
		eventText(input.candidateId, `${field}.candidateId`, 160);
		eventText(input.reason, `${field}.reason`, 8_192);
		return;
	}
	if (eventType === "skill_use_recorded") {
		const input = exactRecord(value, ["use"], field);
		validateUseProjectionPayload(input.use, `${field}.use`);
		return;
	}
	if (eventType === "skill_change_applied") {
		const input = exactRecord(value, ["candidateId", "revisions"], field);
		eventText(input.candidateId, `${field}.candidateId`, 160);
		if (!Array.isArray(input.revisions) || input.revisions.length === 0 || input.revisions.length > 51) {
			throw new SkillCorruptionError(`${field}.revisions is invalid`);
		}
		input.revisions.forEach((entry, index) => {
			validateRevisionReferencePayload(entry, `${field}.revisions[${index}]`);
		});
		return;
	}
	if (eventType === "skill_promotion_eligible") {
		const input = exactRecord(value, ["skillId", "revision", "projectIds", "successfulUses"], field);
		eventText(input.skillId, `${field}.skillId`, 160);
		eventInteger(input.revision, `${field}.revision`, 1);
		if (!Array.isArray(input.projectIds) || input.projectIds.length < 2 || input.projectIds.length > 100) {
			throw new SkillCorruptionError(`${field}.projectIds is invalid`);
		}
		const projectIds = input.projectIds.map((entry, index) => eventText(entry, `${field}.projectIds[${index}]`, 160));
		if (new Set(projectIds).size !== projectIds.length)
			throw new SkillCorruptionError(`${field}.projectIds is invalid`);
		eventInteger(input.successfulUses, `${field}.successfulUses`, 3);
		return;
	}
	if (eventType === "skill_promoted") {
		const input = exactRecord(value, ["candidateId", "revision"], field);
		eventText(input.candidateId, `${field}.candidateId`, 160);
		validateRevisionReferencePayload(input.revision, `${field}.revision`);
		return;
	}
	if (eventType === "skill_publication_failed") {
		const input = exactRecord(value, ["skillId", "revision", "stage", "errorCode", "message", "recordedAt"], field);
		eventText(input.skillId, `${field}.skillId`, 160);
		eventInteger(input.revision, `${field}.revision`, 1);
		if (input.stage !== "projection" && input.stage !== "reload" && input.stage !== "promotion") {
			throw new SkillCorruptionError(`${field}.stage is invalid`);
		}
		eventText(input.errorCode, `${field}.errorCode`, 160);
		eventText(input.message, `${field}.message`, 1_024);
		eventTimestamp(input.recordedAt, `${field}.recordedAt`);
		return;
	}
	if (eventType === "skill_archived") {
		const input = exactRecord(value, ["revision", "reason"], field);
		validateRevisionReferencePayload(input.revision, `${field}.revision`);
		eventText(input.reason, `${field}.reason`, 8_192);
		return;
	}
	const input = exactRecord(
		value,
		[
			"skillId",
			"revisionArtifactIds",
			"bundleArtifactIds",
			"candidateArtifactIds",
			"reviewArtifactIds",
			"fileArtifactIds",
			"sourceDigest",
		],
		field,
	);
	eventText(input.skillId, `${field}.skillId`, 160);
	for (const key of [
		"revisionArtifactIds",
		"bundleArtifactIds",
		"candidateArtifactIds",
		"reviewArtifactIds",
		"fileArtifactIds",
	] as const) {
		if (!Array.isArray(input[key]) || input[key].length > 10_000) {
			throw new SkillCorruptionError(`${field}.${key} is invalid`);
		}
		input[key].forEach((entry, index) => {
			eventDigest(entry, `${field}.${key}[${index}]`);
		});
	}
	if ((input.revisionArtifactIds as unknown[]).length === 0 || (input.bundleArtifactIds as unknown[]).length === 0) {
		throw new SkillCorruptionError(`${field} requires revision and bundle artifacts`);
	}
	eventDigest(input.sourceDigest, `${field}.sourceDigest`);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return [...message.replace(/\s+/gu, " ").trim()].slice(0, 1_024).join("") || "Unknown Skill error";
}

function sameHead(left: SkillHead, right: SkillHead): boolean {
	return left.sequence === right.sequence && left.hash === right.hash;
}

function eventHash(event: SkillEventWithoutHash): string {
	return digest(stableJsonStringify(event));
}

function emptyReadModel(): SkillReadModelV1 {
	return {
		schema: SKILL_READ_MODEL_SCHEMA,
		head: { sequence: 0, hash: null },
		eventBytes: 0,
		candidates: [],
		revisions: [],
		revisionHistory: [],
		uses: [],
		promotionEligibleSkillIds: [],
		promotedCandidateIds: [],
		publicationFailures: [],
		purgedSkillIds: [],
		idempotencyKeys: [],
	};
}

function assertSafeBundlePath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	if (
		normalized.startsWith("/") ||
		normalized.length === 0 ||
		normalized.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new SkillValidationError(`Skill bundle path is unsafe: ${path}`);
	}
	return normalized;
}

function assertBundleText(value: string, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new SkillValidationError(`${field} must be non-empty UTF-8 text`);
	}
	return value;
}

function skillFrontmatter(name: string, description: string): string {
	return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---`;
}

function renderSkillMarkdown(candidate: SkillBundleSourceV1, draft: SkillBundleDraftV1): string {
	const divergence = candidate.divergenceConditions.map((condition) => `- ${condition}`).join("\n");
	return [
		skillFrontmatter(candidate.name, candidate.description),
		"",
		`# ${candidate.name}`,
		"",
		"## Applicability",
		"",
		candidate.applicability,
		"",
		"## Do Not Use When",
		"",
		divergence || "- The current task falls outside the stated applicability.",
		"",
		"## Steps",
		"",
		draft.instructions.steps,
		"",
		"## Validation",
		"",
		draft.instructions.validation,
		"",
		"## Failure Handling",
		"",
		draft.instructions.failureHandling,
		"",
	].join("\n");
}

function currentRevision(model: SkillReadModelV1, skillId: string): SkillPublishedRevisionRefV1 | undefined {
	return model.revisions.find((revision) => revision.skillId === skillId);
}

function replaceRevision(model: SkillReadModelV1, revision: SkillPublishedRevisionRefV1): void {
	const index = model.revisions.findIndex((entry) => entry.skillId === revision.skillId);
	if (index < 0) model.revisions.push(revision);
	else model.revisions[index] = revision;
	model.revisions.sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function applyEvent(modelInput: SkillReadModelV1, event: SkillEventV1, eventBytes: number): SkillReadModelV1 {
	const model: SkillReadModelV1 = {
		...modelInput,
		head: { sequence: event.sequence, hash: event.hash },
		eventBytes,
		candidates: modelInput.candidates.map((candidate) => ({ ...candidate })),
		revisions: modelInput.revisions.map((revision) => ({ ...revision })),
		revisionHistory: modelInput.revisionHistory.map((revision) => ({ ...revision })),
		uses: modelInput.uses.map((use) => ({ ...use })),
		promotionEligibleSkillIds: [...modelInput.promotionEligibleSkillIds],
		promotedCandidateIds: [...modelInput.promotedCandidateIds],
		publicationFailures: modelInput.publicationFailures.map((failure) => ({ ...failure })),
		purgedSkillIds: [...modelInput.purgedSkillIds],
		idempotencyKeys: [...modelInput.idempotencyKeys, event.idempotencyKey],
	};
	if (event.eventType === "candidate_recorded") {
		if (model.candidates.some((candidate) => candidate.candidateId === event.payload.candidate.candidateId)) {
			throw new SkillCorruptionError("candidate_recorded duplicates candidateId");
		}
		model.candidates.push(event.payload.candidate);
		model.candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
	} else if (event.eventType === "candidate_rejected") {
		const candidate = model.candidates.find((entry) => entry.candidateId === event.payload.candidateId);
		if (!candidate || candidate.status !== "pending")
			throw new SkillCorruptionError("candidate_rejected requires pending candidate");
		candidate.status = "rejected";
	} else if (event.eventType === "skill_use_recorded") {
		if (model.uses.some((use) => use.useId === event.payload.use.useId)) {
			throw new SkillCorruptionError("skill_use_recorded duplicates useId");
		}
		const revision = currentRevision(model, event.payload.use.skillId);
		const candidateRevision = model.candidates.some(
			(candidate) =>
				candidate.status === "pending" &&
				candidate.skillId === event.payload.use.skillId &&
				(candidate.expectedRevision ?? 0) + 1 === event.payload.use.revision,
		);
		if ((!revision || revision.revision !== event.payload.use.revision) && !candidateRevision) {
			throw new SkillCorruptionError("skill_use_recorded references a non-current revision");
		}
		model.uses.push(event.payload.use);
	} else if (event.eventType === "skill_change_applied") {
		const candidate = model.candidates.find((entry) => entry.candidateId === event.payload.candidateId);
		if (!candidate || candidate.status !== "pending")
			throw new SkillCorruptionError("skill_change_applied requires pending candidate");
		candidate.status = "applied";
		for (const revision of event.payload.revisions) {
			const current = currentRevision(model, revision.skillId);
			if ((current?.revision ?? 0) + 1 !== revision.revision) {
				throw new SkillCorruptionError(`skill_change_applied breaks revision sequence for ${revision.skillId}`);
			}
			model.revisionHistory.push(revision);
			replaceRevision(model, revision);
		}
	} else if (event.eventType === "skill_promotion_eligible") {
		if (!model.promotionEligibleSkillIds.includes(event.payload.skillId)) {
			model.promotionEligibleSkillIds.push(event.payload.skillId);
			model.promotionEligibleSkillIds.sort();
		}
	} else if (event.eventType === "skill_promoted") {
		if (model.promotedCandidateIds.includes(event.payload.candidateId)) {
			throw new SkillCorruptionError("skill_promoted duplicates candidateId");
		}
		const candidate = model.candidates.find((entry) => entry.candidateId === event.payload.candidateId);
		if (!candidate || candidate.status !== "pending" || candidate.skillId !== event.payload.revision.skillId) {
			throw new SkillCorruptionError("skill_promoted requires its pending candidate");
		}
		const current = currentRevision(model, event.payload.revision.skillId);
		if ((current?.revision ?? 0) + 1 !== event.payload.revision.revision) {
			throw new SkillCorruptionError("skill_promoted breaks revision sequence");
		}
		candidate.status = "applied";
		model.promotedCandidateIds.push(event.payload.candidateId);
		model.revisionHistory.push(event.payload.revision);
		replaceRevision(model, event.payload.revision);
	} else if (event.eventType === "skill_publication_failed") {
		model.publicationFailures.push(event.payload);
	} else if (event.eventType === "skill_archived") {
		const current = currentRevision(model, event.payload.revision.skillId);
		if (!current || current.revision + 1 !== event.payload.revision.revision) {
			throw new SkillCorruptionError("skill_archived breaks revision sequence");
		}
		model.revisionHistory.push(event.payload.revision);
		replaceRevision(model, event.payload.revision);
	} else if (event.eventType === "skill_purged") {
		if (!currentRevision(model, event.payload.skillId))
			throw new SkillCorruptionError("skill_purged references missing Skill");
		model.revisions = model.revisions.filter((revision) => revision.skillId !== event.payload.skillId);
		model.revisionHistory = model.revisionHistory.filter((revision) => revision.skillId !== event.payload.skillId);
		model.candidates = model.candidates.filter((candidate) => candidate.skillId !== event.payload.skillId);
		if (!model.purgedSkillIds.includes(event.payload.skillId)) model.purgedSkillIds.push(event.payload.skillId);
	}
	return model;
}

export class SkillStore {
	private readonly projectRoot: string;
	private readonly scope: SkillScope;
	private readonly projectId: string;
	private readonly factsDirectory: string;
	private readonly eventsPath: string;
	private readonly readModelPath: string;
	private readonly locksDirectory: string;
	private readonly projectionRoot: string;
	private readonly artifacts: ArtifactStore;
	private readonly now: () => string;

	constructor(projectRoot: string, options: SkillStoreOptions = {}) {
		this.projectRoot = resolve(projectRoot);
		this.scope = options.scope ?? "project";
		this.projectId =
			options.projectId ?? `project_${createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 32)}`;
		if (this.scope === "global") {
			if (!options.agentDir) throw new SkillValidationError("Global Skill Store requires agentDir");
			const agentDir = resolve(options.agentDir);
			this.factsDirectory = join(agentDir, "pi-xk", "skills");
			this.projectionRoot = join(agentDir, "skills");
			this.artifacts = new ArtifactStore(agentDir, {
				artifactsDirectory: join(this.factsDirectory, "artifacts"),
			});
		} else {
			this.factsDirectory = join(this.projectRoot, ".pi-xk", "skills");
			this.projectionRoot = join(this.projectRoot, ".pi", "skills");
			this.artifacts = new ArtifactStore(this.projectRoot);
		}
		this.eventsPath = join(this.factsDirectory, "events.jsonl");
		this.readModelPath = join(this.factsDirectory, "skill-read-model.json");
		this.locksDirectory = join(this.factsDirectory, "locks");
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private lockOptions(): FileWriteLockOptions {
		return {
			directory: this.locksDirectory,
			lockPath: join(this.locksDirectory, "write.lock"),
			recoveryLockPath: join(this.locksDirectory, "write-recovery.lock"),
			error: (failure) => new SkillStoreError(`Skill write lock unavailable: ${failure.kind}`),
		};
	}

	private async writeReadModel(model: SkillReadModelV1): Promise<void> {
		await mkdir(this.factsDirectory, { recursive: true });
		const temporary = join(this.factsDirectory, `.skill-read-model-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(model, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.readModelPath);
			await syncDirectory(this.factsDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private parseEvent(value: unknown, line: number): SkillEventV1 {
		const input = exactRecord(
			value,
			[
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
			],
			`Skill event ${line}`,
		);
		if (
			input.schema !== SKILL_EVENT_SCHEMA ||
			input.schemaVersion !== 1 ||
			!SKILL_EVENT_TYPES.has(input.eventType as SkillEventType)
		) {
			throw new SkillCorruptionError(`Skill event ${line} schema or type is unsupported`);
		}
		eventText(input.eventId, `Skill event ${line}.eventId`, 160);
		eventInteger(input.sequence, `Skill event ${line}.sequence`, 1);
		eventTimestamp(input.timestamp, `Skill event ${line}.timestamp`);
		eventText(input.idempotencyKey, `Skill event ${line}.idempotencyKey`, 512);
		eventDigest(input.hash, `Skill event ${line}.hash`);
		if (input.prevHash !== null) eventDigest(input.prevHash, `Skill event ${line}.prevHash`);
		if (input.actor !== "user" && input.actor !== "model" && input.actor !== "runtime") {
			throw new SkillCorruptionError(`Skill event ${line}.actor is invalid`);
		}
		validateEventPayload(input.eventType as SkillEventType, input.payload, `Skill event ${line}.payload`);
		const withoutHash = { ...input };
		delete withoutHash.hash;
		if (eventHash(withoutHash as SkillEventWithoutHash) !== input.hash) {
			throw new SkillCorruptionError(`Skill event ${line} hash is invalid`);
		}
		return input as unknown as SkillEventV1;
	}

	async replay(): Promise<{ events: SkillEventV1[]; readModel: SkillReadModelV1 }> {
		let raw = "";
		try {
			raw = await readFile(this.eventsPath, "utf8");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		let model = emptyReadModel();
		const events: SkillEventV1[] = [];
		let bytes = 0;
		for (const [index, line] of raw.split("\n").filter(Boolean).entries()) {
			const event = this.parseEvent(JSON.parse(line) as unknown, index + 1);
			if (event.sequence !== model.head.sequence + 1 || event.prevHash !== model.head.hash) {
				throw new SkillCorruptionError(`Skill event ${index + 1} breaks the hash chain`);
			}
			bytes += Buffer.byteLength(`${line}\n`);
			model = applyEvent(model, event, bytes);
			events.push(event);
		}
		return { events, readModel: model };
	}

	async loadReadModel(): Promise<SkillReadModelV1> {
		let model: SkillReadModelV1;
		try {
			model = JSON.parse(await readFile(this.readModelPath, "utf8")) as SkillReadModelV1;
			if (model.schema !== SKILL_READ_MODEL_SCHEMA)
				throw new SkillCorruptionError("Skill read model schema is invalid");
		} catch (error) {
			if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError) && !(error instanceof SkillCorruptionError)) {
				throw error;
			}
			const replay = await this.replay();
			await this.writeReadModel(replay.readModel);
			return replay.readModel;
		}
		let eventBytes = 0;
		try {
			eventBytes = (await stat(this.eventsPath)).size;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		if (eventBytes === model.eventBytes) return model;
		const replay = await this.replay();
		await this.writeReadModel(replay.readModel);
		return replay.readModel;
	}

	private async append<TEventType extends SkillEventType>(
		eventType: TEventType,
		payload: SkillEventPayloadMapV1[TEventType],
		options: SkillMutationOptions,
	): Promise<{ event: Extract<SkillEventV1, { eventType: TEventType }>; head: SkillHead }> {
		return await withFileWriteLock(this.lockOptions(), async () => {
			const model = await this.loadReadModel();
			if (model.idempotencyKeys.includes(options.idempotencyKey)) {
				const replay = await this.replay();
				const existing = replay.events.find((event) => event.idempotencyKey === options.idempotencyKey);
				if (
					!existing ||
					existing.eventType !== eventType ||
					stableJsonStringify(existing.payload) !== stableJsonStringify(payload)
				) {
					throw new SkillStoreError(`Skill idempotency conflict: ${options.idempotencyKey}`);
				}
				return { event: existing as Extract<SkillEventV1, { eventType: TEventType }>, head: replay.readModel.head };
			}
			if (!sameHead(model.head, options.expectedHead))
				throw new SkillHeadConflictError(options.expectedHead, model.head);
			const withoutHash = {
				schema: SKILL_EVENT_SCHEMA,
				eventId: options.eventId,
				sequence: model.head.sequence + 1,
				eventType,
				actor: options.actor ?? "runtime",
				timestamp: options.timestamp,
				prevHash: model.head.hash,
				payload,
				schemaVersion: 1 as const,
				idempotencyKey: options.idempotencyKey,
			} as Extract<SkillEventWithoutHash, { eventType: TEventType }>;
			const event = { ...withoutHash, hash: eventHash(withoutHash) } as Extract<
				SkillEventV1,
				{ eventType: TEventType }
			>;
			await mkdir(this.factsDirectory, { recursive: true });
			const handle = await open(this.eventsPath, "a", 0o600);
			let line: string;
			try {
				line = `${stableJsonStringify(event)}\n`;
				await handle.writeFile(line, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			const next = applyEvent(model, event, model.eventBytes + Buffer.byteLength(line));
			await this.writeReadModel(next);
			return { event, head: next.head };
		});
	}

	async createBundle(
		source: SkillBundleSourceV1,
		draft: SkillBundleDraftV1,
	): Promise<{ manifest: SkillBundleManifestV1; bundleArtifactId: string }> {
		const validated = validateSkillCandidateV1({
			schema: SKILL_CANDIDATE_SCHEMA,
			...source,
			targetScope: this.scope,
			expectedRevision: null,
			bundleArtifactId: digest("skill-bundle-placeholder"),
			evidenceRefs: [],
			sourceDigest: digest("skill-source-placeholder"),
		});
		const canonical: SkillBundleSourceV1 = {
			candidateId: validated.candidateId,
			skillId: validated.skillId,
			name: validated.name,
			description: validated.description,
			applicability: validated.applicability,
			divergenceConditions: validated.divergenceConditions,
			provenance: validated.provenance,
		};
		const markdown = renderSkillMarkdown(canonical, {
			instructions: {
				steps: assertBundleText(draft.instructions.steps, "Skill steps"),
				validation: assertBundleText(draft.instructions.validation, "Skill validation"),
				failureHandling: assertBundleText(draft.instructions.failureHandling, "Skill failure handling"),
			},
			resources: draft.resources,
		});
		if (Buffer.byteLength(markdown) > 32 * 1024 || markdown.split("\n").length > 500) {
			throw new SkillValidationError("SKILL.md exceeds its size or line limit");
		}
		const resources = draft.resources.map((resource) => ({
			path: assertSafeBundlePath(resource.path),
			content: assertBundleText(resource.content, `Skill resource ${resource.path}`),
			executable: resource.executable,
		}));
		if (resources.some((resource) => resource.path === "SKILL.md")) {
			throw new SkillValidationError("Skill resources cannot replace Host-rendered SKILL.md");
		}
		if (resources.length + 1 > 20 || new Set(resources.map((resource) => resource.path)).size !== resources.length) {
			throw new SkillValidationError("Skill bundle resources must be unique and bounded");
		}
		const sourceFiles = [{ path: "SKILL.md", content: markdown, executable: false }, ...resources];
		if (sourceFiles.some((file) => Buffer.byteLength(file.content) > 64 * 1024)) {
			throw new SkillValidationError("Skill bundle file exceeds the artifact size limit");
		}
		const totalBytes = sourceFiles.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
		if (totalBytes > 256 * 1024) throw new SkillValidationError("Skill bundle exceeds 256 KiB");
		const files = [];
		for (const file of sourceFiles) {
			const stored = await this.artifacts.put({
				contentType: "text/plain",
				text: file.content,
				producer: SKILL_BUNDLE_MANIFEST_SCHEMA,
				sensitivity: "internal",
				sourceIds: [canonical.candidateId, canonical.skillId, file.path],
				createdAt: canonical.provenance.recordedAt,
			});
			const readBack = await this.artifacts.read(stored.artifactId);
			files.push({
				path: file.path,
				digest: digest(readBack.content),
				artifactId: stored.artifactId,
				executable: file.executable,
				bytes: Buffer.byteLength(readBack.content),
			});
		}
		const manifest = validateSkillBundleManifestV1({
			schema: SKILL_BUNDLE_MANIFEST_SCHEMA,
			name: canonical.name,
			description: canonical.description,
			files,
			totalBytes: files.reduce((total, file) => total + file.bytes, 0),
			sourceDigest: digest(stableJsonStringify(files)),
		});
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: manifest,
			producer: SKILL_BUNDLE_MANIFEST_SCHEMA,
			sensitivity: "internal",
			sourceIds: [canonical.candidateId, canonical.skillId],
			createdAt: canonical.provenance.recordedAt,
		});
		return {
			manifest: validateSkillBundleManifestV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			),
			bundleArtifactId: stored.artifactId,
		};
	}

	async readBundle(bundleArtifactId: string): Promise<SkillBundleManifestV1> {
		const stored = await this.artifacts.read(bundleArtifactId);
		if (stored.metadata.producer !== SKILL_BUNDLE_MANIFEST_SCHEMA) {
			throw new SkillCorruptionError("Skill bundle producer is invalid");
		}
		const manifest = validateSkillBundleManifestV1(JSON.parse(stored.content) as unknown);
		for (const file of manifest.files) {
			const content = await this.artifacts.read(file.artifactId);
			if (digest(content.content) !== file.digest || Buffer.byteLength(content.content) !== file.bytes) {
				throw new SkillCorruptionError(`Skill bundle file is corrupt: ${file.path}`);
			}
		}
		return manifest;
	}

	async readBundleFiles(
		bundleArtifactId: string,
	): Promise<Array<{ path: string; content: string; executable: boolean }>> {
		const manifest = await this.readBundle(bundleArtifactId);
		const files = [];
		for (const file of manifest.files) {
			files.push({
				path: file.path,
				content: (await this.artifacts.read(file.artifactId)).content,
				executable: file.executable,
			});
		}
		return files;
	}

	private async validateEvidence(evidence: readonly SkillEvidenceV1[]): Promise<void> {
		for (const entry of evidence) {
			for (const source of entry.evidenceRefs) await validateMemoryEvidenceOwnership(this.projectRoot, source);
		}
	}

	async recordCandidate(
		candidateInput: SkillCandidateV1,
		options: SkillMutationOptions,
		reviewArtifactId: string | null = null,
	): Promise<{ candidate: SkillCandidateV1; artifactId: string; head: SkillHead }> {
		const candidate = validateSkillCandidateV1(candidateInput);
		if (candidate.targetScope !== this.scope)
			throw new SkillValidationError("Skill candidate targets another Store scope");
		const model = await this.loadReadModel();
		if (model.purgedSkillIds.includes(candidate.skillId)) {
			throw new SkillValidationError(`Skill ID has been purged and cannot be recreated: ${candidate.skillId}`);
		}
		await this.readBundle(candidate.bundleArtifactId);
		await this.validateEvidence(candidate.evidenceRefs);
		if (reviewArtifactId !== null) {
			const review = await this.artifacts.read(reviewArtifactId);
			if (review.metadata.producer !== SKILL_REVIEW_DECISION_SCHEMA) {
				throw new SkillValidationError("Skill review artifact producer is invalid");
			}
			validateSkillReviewDecisionV1(JSON.parse(review.content) as unknown);
		}
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: candidate,
			producer: SKILL_CANDIDATE_SCHEMA,
			sensitivity: "internal",
			sourceIds: [candidate.candidateId, candidate.skillId],
			createdAt: candidate.provenance.recordedAt,
		});
		const canonical = validateSkillCandidateV1(
			JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
		);
		const write = await this.append(
			"candidate_recorded",
			{
				candidate: {
					candidateId: canonical.candidateId,
					skillId: canonical.skillId,
					artifactId: stored.artifactId,
					reviewArtifactId,
					bundleArtifactId: canonical.bundleArtifactId,
					targetScope: canonical.targetScope,
					expectedRevision: canonical.expectedRevision,
					name: canonical.name,
					status: "pending",
					sourceDigest: canonical.sourceDigest,
				},
			},
			options,
		);
		return { candidate: canonical, artifactId: stored.artifactId, head: write.head };
	}

	async recordReviewArtifact(
		decisionInput: SkillReviewDecisionV1,
	): Promise<{ decision: SkillReviewDecisionV1; artifactId: string }> {
		const decision = validateSkillReviewDecisionV1(decisionInput);
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: decision,
			producer: SKILL_REVIEW_DECISION_SCHEMA,
			sensitivity: "internal",
			sourceIds: [decision.decisionId, decision.runId],
			createdAt: decision.provenance.recordedAt,
		});
		return {
			decision: validateSkillReviewDecisionV1(
				JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
			),
			artifactId: stored.artifactId,
		};
	}

	async readCandidate(candidateId: string): Promise<SkillCandidateV1> {
		const model = await this.loadReadModel();
		const reference = model.candidates.find((candidate) => candidate.candidateId === candidateId);
		if (!reference) throw new SkillValidationError(`Skill candidate not found: ${candidateId}`);
		const stored = await this.artifacts.read(reference.artifactId);
		return validateSkillCandidateV1(JSON.parse(stored.content) as unknown);
	}

	private revisionReference(
		revision: SkillRevisionV1,
		artifactId: string,
		bundleArtifactId: string,
	): SkillPublishedRevisionRefV1 {
		return {
			skillId: revision.skillId,
			revision: revision.revision,
			artifactId,
			bundleArtifactId,
			name: revision.name,
			scope: revision.scope,
			lifecycle: revision.lifecycle,
			sourceDigest: revision.sourceDigest,
		};
	}

	private async publishRevision(
		revision: SkillRevisionV1,
		bundleArtifactId: string,
	): Promise<SkillPublishedRevisionRefV1> {
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: revision,
			producer: SKILL_REVISION_SCHEMA,
			sensitivity: "internal",
			sourceIds: [...new Set([revision.skillId, ...revision.evidenceRefs.map((evidence) => evidence.runId)])],
			createdAt: revision.provenance.recordedAt,
		});
		const canonical = validateSkillRevisionV1(
			JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown,
		);
		return this.revisionReference(canonical, stored.artifactId, bundleArtifactId);
	}

	private async marker(path: string): Promise<{ skillId: string; revision: number } | null> {
		try {
			const value = JSON.parse(await readFile(join(path, ".pi-xk-managed-skill.json"), "utf8")) as unknown;
			if (
				!isRecord(value) ||
				value.schema !== SKILL_MANAGED_MARKER_SCHEMA ||
				typeof value.skillId !== "string" ||
				typeof value.revision !== "number"
			) {
				return null;
			}
			return { skillId: value.skillId, revision: value.revision };
		} catch {
			return null;
		}
	}

	private async assertProjectionAvailable(name: string, skillId: string): Promise<void> {
		const path = join(this.projectionRoot, name);
		try {
			const entry = await lstat(path);
			if (entry.isSymbolicLink() || !entry.isDirectory()) throw new SkillProjectionCollisionError(name);
			const marker = await this.marker(path);
			if (!marker || marker.skillId !== skillId) throw new SkillProjectionCollisionError(name);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
	}

	private async publishProjection(reference: SkillPublishedRevisionRefV1): Promise<void> {
		const bundle = await this.readBundle(reference.bundleArtifactId);
		await mkdir(this.projectionRoot, { recursive: true });
		await this.assertProjectionAvailable(reference.name, reference.skillId);
		const temporary = join(this.projectionRoot, `.pi-xk-skill-${reference.skillId}-${randomUUID()}`);
		const target = join(this.projectionRoot, reference.name);
		const recovery = join(this.projectionRoot, `.pi-xk-recovery-${reference.skillId}`);
		try {
			await mkdir(temporary, { recursive: true });
			for (const file of bundle.files) {
				const path = join(temporary, file.path);
				await mkdir(dirname(path), { recursive: true });
				const content = await this.artifacts.read(file.artifactId);
				const handle = await open(path, "wx", file.executable ? 0o700 : 0o600);
				try {
					await handle.writeFile(content.content, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
			}
			const markerHandle = await open(join(temporary, ".pi-xk-managed-skill.json"), "wx", 0o600);
			try {
				await markerHandle.writeFile(
					`${JSON.stringify({ schema: SKILL_MANAGED_MARKER_SCHEMA, skillId: reference.skillId, revision: reference.revision, sourceDigest: reference.sourceDigest }, null, "\t")}\n`,
					"utf8",
				);
				await markerHandle.sync();
			} finally {
				await markerHandle.close();
			}
			await rm(recovery, { recursive: true, force: true });
			try {
				await rename(target, recovery);
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			}
			await rename(temporary, target);
			await syncDirectory(this.projectionRoot);
			await rm(recovery, { recursive: true, force: true });
		} catch (error) {
			if (await this.marker(recovery)) {
				try {
					await lstat(target);
				} catch (targetError) {
					if (isErrno(targetError, "ENOENT")) await rename(recovery, target);
				}
			}
			throw error;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}

	async applyCandidate(
		candidateId: string,
		options: SkillMutationOptions,
		supersedesRevisions: SkillRevisionV1["supersedesRevisions"] = [],
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		const [candidate, model] = await Promise.all([this.readCandidate(candidateId), this.loadReadModel()]);
		const projection = model.candidates.find((entry) => entry.candidateId === candidateId);
		if (!projection || projection.status !== "pending")
			throw new SkillValidationError("Skill candidate is not pending");
		const current = currentRevision(model, candidate.skillId);
		if ((current?.revision ?? null) !== candidate.expectedRevision) {
			throw new SkillRevisionConflictError(candidate.skillId, candidate.expectedRevision, current?.revision ?? null);
		}
		if (!candidate.evidenceRefs.some((evidence) => evidence.outcome === "success")) {
			throw new SkillValidationError("Skill activation requires successful evidence");
		}
		if (candidate.expectedRevision !== null && candidate.provenance.producer !== "user") {
			const usedCurrent = candidate.evidenceRefs.some(
				(evidence) =>
					evidence.schema === SKILL_USE_EVIDENCE_SCHEMA &&
					evidence.skillId === candidate.skillId &&
					evidence.revision === candidate.expectedRevision,
			);
			if (!usedCurrent) throw new SkillValidationError("Skill revision requires actual use evidence");
		}
		const supersededKeys = supersedesRevisions.map((reference) => `${reference.skillId}\0${reference.revision}`);
		if (new Set(supersededKeys).size !== supersededKeys.length) {
			throw new SkillValidationError("Skill supersedesRevisions must be unique");
		}
		const superseded = [];
		for (const source of supersedesRevisions) {
			const sourceCurrent = await this.readRevision(source.skillId);
			if (sourceCurrent.revision.revision !== source.revision) {
				throw new SkillRevisionConflictError(source.skillId, source.revision, sourceCurrent.revision.revision);
			}
			if (source.skillId !== candidate.skillId && sourceCurrent.revision.lifecycle !== "active") {
				throw new SkillValidationError(`Skill supersede source is not active: ${source.skillId}`);
			}
			superseded.push(sourceCurrent);
		}
		await this.assertProjectionAvailable(candidate.name, candidate.skillId);
		const bundle = await this.readBundle(candidate.bundleArtifactId);
		const revision = validateSkillRevisionV1({
			schema: SKILL_REVISION_SCHEMA,
			skillId: candidate.skillId,
			revision: (current?.revision ?? 0) + 1,
			scope: candidate.targetScope,
			lifecycle: "active",
			name: candidate.name,
			description: candidate.description,
			applicability: candidate.applicability,
			divergenceConditions: candidate.divergenceConditions,
			files: bundle.files.map(({ path, digest: fileDigest, executable }) => ({
				path,
				digest: fileDigest,
				executable,
			})),
			evidenceRefs: candidate.evidenceRefs,
			supersedesRevisions,
			sourceDigest: candidate.sourceDigest,
			provenance: candidate.provenance,
		});
		const reference = await this.publishRevision(revision, candidate.bundleArtifactId);
		const lifecycleReferences: SkillPublishedRevisionRefV1[] = [];
		for (const source of superseded) {
			if (source.revision.skillId === candidate.skillId) continue;
			const evidenceById = new Map(
				[...source.revision.evidenceRefs, ...candidate.evidenceRefs].map((evidence) => [
					evidence.schema === SKILL_USE_EVIDENCE_SCHEMA ? evidence.useId : evidence.evidenceId,
					evidence,
				]),
			);
			const lifecycleRevision = validateSkillRevisionV1({
				...source.revision,
				revision: source.revision.revision + 1,
				lifecycle: "superseded",
				evidenceRefs: [...evidenceById.values()].slice(0, 100),
				supersedesRevisions: [
					...source.revision.supersedesRevisions,
					{ skillId: source.revision.skillId, revision: source.revision.revision },
				],
				sourceDigest: digest(
					stableJsonStringify({
						mode: "supersede",
						candidateId,
						source: { skillId: source.revision.skillId, revision: source.revision.revision },
						target: { skillId: candidate.skillId, revision: revision.revision },
					}),
				),
				provenance: candidate.provenance,
			});
			lifecycleReferences.push(await this.publishRevision(lifecycleRevision, source.reference.bundleArtifactId));
		}
		const write = await this.append(
			"skill_change_applied",
			{ candidateId, revisions: [reference, ...lifecycleReferences] },
			options,
		);
		let projectionPublished = true;
		try {
			await this.publishProjection(reference);
			if (current && current.name !== reference.name) {
				await this.removeManagedProjection(current.name, current.skillId);
			}
			for (const source of superseded) {
				if (source.revision.skillId !== candidate.skillId) {
					await this.removeManagedProjection(source.reference.name, source.reference.skillId);
				}
			}
		} catch (error) {
			projectionPublished = false;
			const failure = await this.append(
				"skill_publication_failed",
				{
					skillId: revision.skillId,
					revision: revision.revision,
					stage: "projection",
					errorCode: "skill_projection_failed",
					message: boundedMessage(error),
					recordedAt: this.now(),
				},
				{
					eventId: `evt_skill_projection_failed_${candidateId}`,
					idempotencyKey: `skill:projection-failed:${candidateId}`,
					expectedHead: write.head,
					actor: "runtime",
					timestamp: this.now(),
				},
			);
			return { revision, head: failure.head, projectionPublished };
		}
		return { revision, head: write.head, projectionPublished };
	}

	async recordUse(useInput: SkillUseEvidenceV1, options: SkillMutationOptions): Promise<SkillHead> {
		const use = validateSkillUseEvidenceV1(useInput);
		const model = await this.loadReadModel();
		const revision = currentRevision(model, use.skillId);
		const candidateRevision = model.candidates.some(
			(candidate) =>
				candidate.status === "pending" &&
				candidate.skillId === use.skillId &&
				(candidate.expectedRevision ?? 0) + 1 === use.revision,
		);
		if ((!revision || revision.revision !== use.revision || revision.lifecycle !== "active") && !candidateRevision) {
			throw new SkillRevisionConflictError(use.skillId, use.revision, revision?.revision ?? null);
		}
		await this.validateEvidence([use]);
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: use,
			producer: SKILL_USE_EVIDENCE_SCHEMA,
			sensitivity: "internal",
			sourceIds: [use.useId, use.skillId, use.runId],
			createdAt: use.recordedAt,
		});
		validateSkillUseEvidenceV1(JSON.parse((await this.artifacts.read(stored.artifactId)).content) as unknown);
		return (
			await this.append(
				"skill_use_recorded",
				{
					use: {
						useId: use.useId,
						artifactId: stored.artifactId,
						skillId: use.skillId,
						revision: use.revision,
						projectId: use.projectId,
						outcome: use.outcome,
						recordedAt: use.recordedAt,
					},
				},
				options,
			)
		).head;
	}

	private async readRevisionReference(
		reference: SkillPublishedRevisionRefV1,
	): Promise<{ revision: SkillRevisionV1; reference: SkillPublishedRevisionRefV1 }> {
		const stored = await this.artifacts.read(reference.artifactId);
		if (stored.metadata.producer !== SKILL_REVISION_SCHEMA) {
			throw new SkillCorruptionError(
				`Skill revision producer is invalid: ${reference.skillId} r${reference.revision}`,
			);
		}
		const revision = validateSkillRevisionV1(JSON.parse(stored.content) as unknown);
		if (
			revision.skillId !== reference.skillId ||
			revision.revision !== reference.revision ||
			revision.sourceDigest !== reference.sourceDigest
		) {
			throw new SkillCorruptionError(
				`Skill revision artifact does not match its event: ${reference.skillId} r${reference.revision}`,
			);
		}
		return { revision, reference };
	}

	async readRevision(
		skillId: string,
		revisionNumber?: number,
	): Promise<{ revision: SkillRevisionV1; reference: SkillPublishedRevisionRefV1 }> {
		const model = await this.loadReadModel();
		const reference =
			revisionNumber === undefined
				? currentRevision(model, skillId)
				: model.revisionHistory.find((entry) => entry.skillId === skillId && entry.revision === revisionNumber);
		if (!reference) {
			throw new SkillValidationError(
				revisionNumber === undefined
					? `Skill not found: ${skillId}`
					: `Skill revision not found: ${skillId} r${revisionNumber}`,
			);
		}
		return await this.readRevisionReference(reference);
	}

	async listRevisions(): Promise<Array<{ revision: SkillRevisionV1; reference: SkillPublishedRevisionRefV1 }>> {
		const model = await this.loadReadModel();
		const result = [];
		for (const reference of model.revisions) result.push(await this.readRevision(reference.skillId));
		return result;
	}

	async timeline(
		skillId: string,
	): Promise<Array<{ revision: SkillRevisionV1; reference: SkillPublishedRevisionRefV1 }>> {
		const model = await this.loadReadModel();
		const references = model.revisionHistory
			.filter((reference) => reference.skillId === skillId)
			.sort((left, right) => left.revision - right.revision);
		if (references.length === 0) throw new SkillValidationError(`Skill not found: ${skillId}`);
		const result = [];
		for (const reference of references) result.push(await this.readRevisionReference(reference));
		return result;
	}

	async archive(
		skillId: string,
		reason: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		if (reason.trim().length === 0) throw new SkillValidationError("Skill archive reason must be non-empty");
		const current = await this.readRevision(skillId);
		if (current.revision.lifecycle === "archived") throw new SkillValidationError("Skill is already archived");
		const revision = validateSkillRevisionV1({
			...current.revision,
			revision: current.revision.revision + 1,
			lifecycle: "archived",
			supersedesRevisions: [
				...current.revision.supersedesRevisions,
				{ skillId: current.revision.skillId, revision: current.revision.revision },
			],
			sourceDigest: digest(
				stableJsonStringify({
					mode: "archive",
					skillId,
					fromRevision: current.revision.revision,
					reason,
				}),
			),
			provenance: { producer: "user", model: null, promptVersion: null, recordedAt: options.timestamp },
		});
		const reference = await this.publishRevision(revision, current.reference.bundleArtifactId);
		const write = await this.append("skill_archived", { revision: reference, reason }, options);
		let projectionPublished = true;
		try {
			await this.removeManagedProjection(current.reference.name, skillId);
		} catch (error) {
			projectionPublished = false;
			const failure = await this.append(
				"skill_publication_failed",
				{
					skillId,
					revision: revision.revision,
					stage: "projection",
					errorCode: "skill_projection_remove_failed",
					message: boundedMessage(error),
					recordedAt: this.now(),
				},
				{
					eventId: `${options.eventId}_projection_failed`,
					idempotencyKey: `${options.idempotencyKey}:projection-failed`,
					expectedHead: write.head,
					actor: "runtime",
					timestamp: this.now(),
				},
			);
			return { revision, head: failure.head, projectionPublished };
		}
		return { revision, head: write.head, projectionPublished };
	}

	async rollback(
		skillId: string,
		targetRevision: number,
		reason: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		if (reason.trim().length === 0) throw new SkillValidationError("Skill rollback reason must be non-empty");
		const [target, current] = await Promise.all([
			this.readRevision(skillId, targetRevision),
			this.readRevision(skillId),
		]);
		const identity = createHash("sha256")
			.update(stableJsonStringify({ skillId, targetRevision, currentRevision: current.revision.revision, reason }))
			.digest("hex")
			.slice(0, 32);
		const candidateId = `candidate_rollback_${identity}`;
		const candidate = validateSkillCandidateV1({
			schema: SKILL_CANDIDATE_SCHEMA,
			candidateId,
			skillId,
			targetScope: this.scope,
			expectedRevision: current.revision.revision,
			name: target.revision.name,
			description: target.revision.description,
			applicability: target.revision.applicability,
			divergenceConditions: target.revision.divergenceConditions,
			bundleArtifactId: target.reference.bundleArtifactId,
			evidenceRefs: target.revision.evidenceRefs,
			sourceDigest: digest(
				stableJsonStringify({
					mode: "rollback",
					skillId,
					targetRevision,
					currentRevision: current.revision.revision,
					reason,
				}),
			),
			provenance: { producer: "user", model: null, promptVersion: null, recordedAt: options.timestamp },
		});
		const recorded = await this.recordCandidate(candidate, options);
		return await this.applyCandidate(candidateId, {
			...options,
			eventId: `${options.eventId}_apply`,
			idempotencyKey: `${options.idempotencyKey}:apply`,
			expectedHead: recorded.head,
		});
	}

	async purge(skillId: string, options: SkillMutationOptions): Promise<SkillPurgeResultV1> {
		const model = await this.loadReadModel();
		const current = currentRevision(model, skillId);
		if (!current) throw new SkillValidationError(`Skill not found: ${skillId}`);
		if (current.lifecycle !== "archived") throw new SkillValidationError("Skill must be archived before purge");
		if (model.candidates.some((candidate) => candidate.skillId === skillId && candidate.status === "pending")) {
			throw new SkillValidationError("Skill with a pending candidate cannot be purged");
		}
		for (const reference of model.revisions) {
			if (reference.skillId === skillId || reference.lifecycle !== "active") continue;
			const revision = await this.readRevisionReference(reference);
			if (revision.revision.supersedesRevisions.some((source) => source.skillId === skillId)) {
				throw new SkillValidationError(`Skill has an active inbound revision reference: ${reference.skillId}`);
			}
		}
		const revisionReferences = model.revisionHistory.filter((reference) => reference.skillId === skillId);
		const candidateReferences = model.candidates.filter((candidate) => candidate.skillId === skillId);
		const bundleArtifactIds = [...new Set(revisionReferences.map((reference) => reference.bundleArtifactId))];
		const fileArtifactIds = new Set<string>();
		for (const bundleArtifactId of bundleArtifactIds) {
			for (const file of (await this.readBundle(bundleArtifactId)).files) fileArtifactIds.add(file.artifactId);
		}
		const payload: SkillPurgedPayloadV1 = {
			skillId,
			revisionArtifactIds: revisionReferences.map((reference) => reference.artifactId),
			bundleArtifactIds,
			candidateArtifactIds: candidateReferences.map((candidate) => candidate.artifactId),
			reviewArtifactIds: candidateReferences
				.map((candidate) => candidate.reviewArtifactId)
				.filter((artifactId): artifactId is string => artifactId !== null),
			fileArtifactIds: [...fileArtifactIds],
			sourceDigest: digest(
				stableJsonStringify({
					skillId,
					revisions: revisionReferences.map((reference) => ({
						revision: reference.revision,
						artifactId: reference.artifactId,
						bundleArtifactId: reference.bundleArtifactId,
					})),
					candidates: candidateReferences.map((candidate) => candidate.artifactId),
				}),
			),
		};
		const write = await this.append("skill_purged", payload, options);
		await this.removeManagedProjection(current.name, skillId);

		const referencedElsewhere = new Set<string>();
		for (const candidate of model.candidates) {
			if (candidate.skillId === skillId) continue;
			referencedElsewhere.add(candidate.artifactId);
			referencedElsewhere.add(candidate.bundleArtifactId);
		}
		for (const reference of model.revisionHistory) {
			if (reference.skillId === skillId) continue;
			referencedElsewhere.add(reference.artifactId);
			referencedElsewhere.add(reference.bundleArtifactId);
			for (const file of (await this.readBundle(reference.bundleArtifactId)).files) {
				referencedElsewhere.add(file.artifactId);
			}
		}
		const removedArtifactIds: string[] = [];
		const retainedArtifactIds: string[] = [];
		const cleanupDiagnostics: string[] = [];
		const targets = new Set([
			...payload.revisionArtifactIds,
			...payload.bundleArtifactIds,
			...payload.candidateArtifactIds,
			...payload.reviewArtifactIds,
			...payload.fileArtifactIds,
		]);
		for (const artifactId of targets) {
			if (referencedElsewhere.has(artifactId)) {
				retainedArtifactIds.push(artifactId);
				continue;
			}
			try {
				if (await this.artifacts.remove(artifactId)) removedArtifactIds.push(artifactId);
			} catch (error) {
				cleanupDiagnostics.push(`${artifactId}: ${boundedMessage(error)}`);
			}
		}
		return {
			head: write.head,
			removedArtifactIds: removedArtifactIds.sort(),
			retainedArtifactIds: retainedArtifactIds.sort(),
			cleanupDiagnostics,
		};
	}

	async promoteCandidate(
		candidateId: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		if (this.scope !== "global") throw new SkillValidationError("Only the global Skill Store can promote candidates");
		const [candidate, model] = await Promise.all([this.readCandidate(candidateId), this.loadReadModel()]);
		const projection = model.candidates.find((entry) => entry.candidateId === candidateId);
		if (!projection || projection.status !== "pending")
			throw new SkillValidationError("Skill candidate is not pending");
		const recordedUses = model.uses.filter(
			(use) => use.skillId === candidate.skillId && use.revision === (candidate.expectedRevision ?? 0) + 1,
		);
		const successfulUses = [
			...candidate.evidenceRefs.filter((evidence) => evidence.outcome === "success"),
			...recordedUses.filter((use) => use.outcome === "success"),
		];
		const repositoryUses = successfulUses.filter((evidence) => /^repo_[a-f0-9]{32}$/u.test(evidence.projectId));
		const projectIds = [...new Set(repositoryUses.map((evidence) => evidence.projectId))].sort();
		if (repositoryUses.length < 3) throw new SkillValidationError("Skill promotion requires three successful uses");
		if (projectIds.length < 2) {
			throw new SkillValidationError("Skill promotion requires successful use in two projects");
		}
		if (
			candidate.evidenceRefs.some(
				(evidence) => evidence.schema === SKILL_USE_EVIDENCE_SCHEMA && evidence.outcome === "failure",
			) ||
			recordedUses.some((use) => use.outcome === "failure")
		) {
			throw new SkillValidationError("Skill promotion is blocked by unresolved failure evidence");
		}
		const current = currentRevision(model, candidate.skillId);
		if ((current?.revision ?? null) !== candidate.expectedRevision) {
			throw new SkillRevisionConflictError(candidate.skillId, candidate.expectedRevision, current?.revision ?? null);
		}
		await this.assertProjectionAvailable(candidate.name, candidate.skillId);
		const bundle = await this.readBundle(candidate.bundleArtifactId);
		const recordedUseEvidence = [];
		for (const use of recordedUses) {
			const stored = await this.artifacts.read(use.artifactId);
			recordedUseEvidence.push(validateSkillUseEvidenceV1(JSON.parse(stored.content) as unknown));
		}
		const revision = validateSkillRevisionV1({
			schema: SKILL_REVISION_SCHEMA,
			skillId: candidate.skillId,
			revision: (current?.revision ?? 0) + 1,
			scope: "global",
			lifecycle: "active",
			name: candidate.name,
			description: candidate.description,
			applicability: candidate.applicability,
			divergenceConditions: candidate.divergenceConditions,
			files: bundle.files.map(({ path, digest: fileDigest, executable }) => ({
				path,
				digest: fileDigest,
				executable,
			})),
			evidenceRefs: [...candidate.evidenceRefs, ...recordedUseEvidence].slice(0, 100),
			supersedesRevisions: current ? [{ skillId: current.skillId, revision: current.revision }] : [],
			sourceDigest: candidate.sourceDigest,
			provenance: candidate.provenance,
		});
		const reference = await this.publishRevision(revision, candidate.bundleArtifactId);
		const eligible = await this.append(
			"skill_promotion_eligible",
			{ skillId: candidate.skillId, revision: revision.revision, projectIds, successfulUses: repositoryUses.length },
			options,
		);
		const promoted = await this.append(
			"skill_promoted",
			{ candidateId, revision: reference },
			{
				...options,
				eventId: `${options.eventId}_promoted`,
				idempotencyKey: `${options.idempotencyKey}:promoted`,
				expectedHead: eligible.head,
			},
		);
		let projectionPublished = true;
		try {
			await this.publishProjection(reference);
		} catch (error) {
			projectionPublished = false;
			const failure = await this.append(
				"skill_publication_failed",
				{
					skillId: revision.skillId,
					revision: revision.revision,
					stage: "promotion",
					errorCode: "skill_promotion_projection_failed",
					message: boundedMessage(error),
					recordedAt: this.now(),
				},
				{
					...options,
					eventId: `${options.eventId}_projection_failed`,
					idempotencyKey: `${options.idempotencyKey}:projection-failed`,
					expectedHead: promoted.head,
					actor: "runtime",
				},
			);
			return { revision, head: failure.head, projectionPublished };
		}
		return { revision, head: promoted.head, projectionPublished };
	}

	async rejectCandidate(candidateId: string, reason: string, options: SkillMutationOptions): Promise<SkillHead> {
		return (await this.append("candidate_rejected", { candidateId, reason }, options)).head;
	}

	async recordPublicationFailure(
		failure: SkillPublicationFailureV1,
		options: SkillMutationOptions,
	): Promise<SkillHead> {
		return (await this.append("skill_publication_failed", failure, options)).head;
	}

	async listPendingCandidates(): Promise<SkillCandidateV1[]> {
		const model = await this.loadReadModel();
		const result = [];
		for (const reference of model.candidates) {
			if (reference.status === "pending") result.push(await this.readCandidate(reference.candidateId));
		}
		return result;
	}

	async repairProjections(): Promise<void> {
		for (const { reference } of await this.listRevisions()) {
			if (reference.lifecycle === "active") await this.publishProjection(reference);
			else await this.removeManagedProjection(reference.name, reference.skillId);
		}
	}

	async setProjectionAvailable(skillId: string, available: boolean): Promise<boolean> {
		const current = await this.readRevision(skillId);
		const target = join(this.projectionRoot, current.reference.name);
		const marker = await this.marker(target);
		if (!available || current.reference.lifecycle !== "active") {
			if (!marker) return false;
			if (marker.skillId !== skillId) throw new SkillProjectionCollisionError(current.reference.name);
			await this.removeManagedProjection(current.reference.name, skillId);
			return true;
		}
		if (marker?.skillId === skillId && marker.revision === current.reference.revision) return false;
		await this.publishProjection(current.reference);
		return true;
	}

	private async removeManagedProjection(name: string, skillId: string): Promise<void> {
		const path = join(this.projectionRoot, name);
		const marker = await this.marker(path);
		if (!marker) return;
		if (marker.skillId !== skillId) throw new SkillProjectionCollisionError(name);
		await rm(path, { recursive: true, force: true });
	}

	async status(): Promise<SkillStoreStatusV1> {
		const model = await this.loadReadModel();
		const failuresBySkill = new Map<string, SkillUseProjectionV1[]>();
		for (const use of model.uses) {
			const values = failuresBySkill.get(use.skillId) ?? [];
			values.push(use);
			failuresBySkill.set(use.skillId, values);
		}
		let needsReview = 0;
		for (const revision of model.revisions) {
			const latest = (failuresBySkill.get(revision.skillId) ?? [])
				.filter((use) => use.revision === revision.revision)
				.slice(-2);
			if (latest.length === 2 && latest.every((use) => use.outcome === "failure")) needsReview += 1;
		}
		return {
			head: model.head,
			active: model.revisions.filter((revision) => revision.lifecycle === "active").length,
			archived: model.revisions.filter((revision) => revision.lifecycle === "archived").length,
			candidates: model.candidates.filter((candidate) => candidate.status === "pending").length,
			stale: 0,
			needsReview,
			publicationFailures: model.publicationFailures.length,
		};
	}

	async doctor(deep = false): Promise<SkillDoctorReportV1> {
		const diagnostics: SkillDoctorReportV1["diagnostics"] = [];
		const replay = await this.replay();
		const stored = await this.loadReadModel();
		if (!sameHead(replay.readModel.head, stored.head)) {
			diagnostics.push({
				code: "read_model_stale",
				message: "Skill read model head differs from facts",
				repairable: true,
			});
		}
		let checkedArtifacts = 0;
		if (deep) {
			for (const candidate of replay.readModel.candidates) {
				await this.readCandidate(candidate.candidateId);
				await this.readBundle(candidate.bundleArtifactId);
				checkedArtifacts += 2;
			}
			for (const revision of replay.readModel.revisions) {
				await this.readRevision(revision.skillId);
				await this.readBundle(revision.bundleArtifactId);
				checkedArtifacts += 2;
				if (revision.lifecycle === "active") {
					const marker = await this.marker(join(this.projectionRoot, revision.name));
					if (!marker || marker.skillId !== revision.skillId || marker.revision !== revision.revision) {
						diagnostics.push({
							code: "projection_stale",
							message: `Managed Skill projection is missing or stale: ${revision.name}`,
							repairable: true,
						});
					}
				}
			}
		}
		return { ok: diagnostics.length === 0, diagnostics, checkedEvents: replay.events.length, checkedArtifacts };
	}

	async inspectWriteLock(): Promise<WriteLockDiagnostic | undefined> {
		return await inspectFileWriteLock(this.lockOptions().lockPath);
	}

	async repairAbandonedWriteLock(expectedNonce: string): Promise<boolean> {
		return await repairAbandonedFileWriteLock(this.lockOptions(), expectedNonce);
	}

	getProjectId(): string {
		return this.projectId;
	}

	getScope(): SkillScope {
		return this.scope;
	}

	getProjectionRoot(): string {
		return this.projectionRoot;
	}

	async identifyManagedSkillPath(
		filePath: string,
	): Promise<{ skillId: string; revision: number; name: string; scope: SkillScope } | null> {
		const absolute = resolve(filePath);
		if (basename(absolute) !== "SKILL.md") return null;
		const directory = dirname(absolute);
		const relativeDirectory = relative(this.projectionRoot, directory);
		if (
			relativeDirectory.length === 0 ||
			relativeDirectory === ".." ||
			relativeDirectory.startsWith(`..${sep}`) ||
			relativeDirectory.includes(sep)
		) {
			return null;
		}
		try {
			const entry = await lstat(directory);
			if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
		} catch {
			return null;
		}
		const marker = await this.marker(directory);
		if (!marker) return null;
		const current = currentRevision(await this.loadReadModel(), marker.skillId);
		if (
			!current ||
			current.revision !== marker.revision ||
			current.name !== relativeDirectory ||
			current.lifecycle !== "active"
		) {
			return null;
		}
		return { skillId: current.skillId, revision: current.revision, name: current.name, scope: current.scope };
	}

	getFactsDirectory(): string {
		return this.factsDirectory;
	}
}
