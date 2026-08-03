import { type EvidenceRefV2, validateEvidenceRefV2 } from "./ambient-memory-contract.ts";
import { type GitFreshnessBasisV1, type MemoryProvenanceV1, validateGitFreshnessBasisV1 } from "./memory-contract.ts";

export const SKILL_CANDIDATE_SCHEMA = "pi-xk.skill-candidate.v1";
export const SKILL_BUNDLE_MANIFEST_SCHEMA = "pi-xk.skill-bundle-manifest.v1";
export const SKILL_REVISION_SCHEMA = "pi-xk.skill-revision.v1";
export const SKILL_SOURCE_EVIDENCE_SCHEMA = "pi-xk.skill-source-evidence.v1";
export const SKILL_USE_EVIDENCE_SCHEMA = "pi-xk.skill-use-evidence.v1";
export const SKILL_REVIEW_DECISION_SCHEMA = "pi-xk.skill-review-decision.v1";
export const SKILL_REVIEW_PROMPT_VERSION = "pi-xk.skill-review-v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillScope = "project" | "global";
export type SkillLifecycle = "active" | "superseded" | "archived";
export type SkillUseOutcome = "success" | "failure" | "unknown";
export type SkillReviewAction = "keep" | "create" | "revise" | "supersede";

export interface SkillSourceEvidenceV1 {
	schema: typeof SKILL_SOURCE_EVIDENCE_SCHEMA;
	evidenceId: string;
	projectId: string;
	runId: string;
	outcome: SkillUseOutcome;
	evidenceRefs: EvidenceRefV2[];
	freshnessBasis: GitFreshnessBasisV1 | null;
	recordedAt: string;
}

export interface SkillUseEvidenceV1 {
	schema: typeof SKILL_USE_EVIDENCE_SCHEMA;
	useId: string;
	skillId: string;
	revision: number;
	projectId: string;
	runId: string;
	outcome: SkillUseOutcome;
	evidenceRefs: EvidenceRefV2[];
	divergenceObserved: string | null;
	recordedAt: string;
}

export type SkillEvidenceV1 = SkillSourceEvidenceV1 | SkillUseEvidenceV1;

export interface SkillBundleManifestV1 {
	schema: typeof SKILL_BUNDLE_MANIFEST_SCHEMA;
	name: string;
	description: string;
	files: Array<{
		path: string;
		digest: string;
		artifactId: string;
		executable: boolean;
		bytes: number;
	}>;
	totalBytes: number;
	sourceDigest: string;
}

export interface SkillCandidateV1 {
	schema: typeof SKILL_CANDIDATE_SCHEMA;
	candidateId: string;
	skillId: string;
	targetScope: SkillScope;
	expectedRevision: number | null;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	bundleArtifactId: string;
	evidenceRefs: SkillEvidenceV1[];
	sourceDigest: string;
	provenance: MemoryProvenanceV1;
}

export interface SkillRevisionReferenceV1 {
	skillId: string;
	revision: number;
}

export interface SkillBundleFileReferenceV1 {
	path: string;
	digest: string;
	executable: boolean;
}

export interface SkillRevisionV1 {
	schema: typeof SKILL_REVISION_SCHEMA;
	skillId: string;
	revision: number;
	scope: SkillScope;
	lifecycle: SkillLifecycle;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	files: SkillBundleFileReferenceV1[];
	evidenceRefs: SkillEvidenceV1[];
	supersedesRevisions: SkillRevisionReferenceV1[];
	sourceDigest: string;
	provenance: MemoryProvenanceV1;
}

export interface SkillReviewSourceV1 {
	skillId: string;
	expectedRevision: number;
}

export interface SkillReviewUseV1 extends SkillReviewSourceV1 {
	outcome: SkillUseOutcome;
	divergenceObserved: string | null;
}

export interface SkillSemanticDraftV1 {
	targetScope: SkillScope;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	instructions: {
		steps: string;
		validation: string;
		failureHandling: string;
	};
	resources: Array<{ path: string; content: string; executable: boolean }>;
}

export interface SkillReviewDecisionV1 {
	schema: typeof SKILL_REVIEW_DECISION_SCHEMA;
	decisionId: string;
	runId: string;
	action: SkillReviewAction;
	sourceSkills: SkillReviewSourceV1[];
	uses: SkillReviewUseV1[];
	replacement: SkillSemanticDraftV1 | null;
	evidenceIds: string[];
	reason: string;
	provenance: MemoryProvenanceV1;
}

export class SkillValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillValidationError";
	}
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SkillValidationError(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new SkillValidationError(`${field} has unknown or missing fields`);
	}
}

function text(value: unknown, field: string, maximum: number, singleLine = false): string {
	if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum || value.includes("\0")) {
		throw new SkillValidationError(`${field} must be a non-empty bounded string`);
	}
	if (singleLine && /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
		throw new SkillValidationError(`${field} must be one line`);
	}
	return value;
}

function id(value: unknown, field: string): string {
	const result = text(value, field, 160, true);
	if (!ID_PATTERN.test(result)) throw new SkillValidationError(`${field} is invalid`);
	return result;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new SkillValidationError(`${field} must be a positive revision`);
	}
	return value;
}

function digest(value: unknown, field: string): string {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
		throw new SkillValidationError(`${field} must be a sha256 digest`);
	}
	return value;
}

function timestamp(value: unknown, field: string): string {
	const result = text(value, field, 80, true);
	if (Number.isNaN(Date.parse(result))) throw new SkillValidationError(`${field} must be an ISO timestamp`);
	return result;
}

function skillName(value: unknown): string {
	const result = text(value, "Skill name", 64, true);
	if (!SKILL_NAME_PATTERN.test(result)) throw new SkillValidationError("Skill name is invalid");
	return result;
}

function strings(value: unknown, field: string, maximum: number, maximumLength: number): string[] {
	if (!Array.isArray(value) || value.length > maximum) throw new SkillValidationError(`${field} must be bounded`);
	const result = value.map((entry, index) => text(entry, `${field}[${index}]`, maximumLength));
	if (new Set(result).size !== result.length) throw new SkillValidationError(`${field} must be unique`);
	return result;
}

function provenance(value: unknown): MemoryProvenanceV1 {
	const input = record(value, "Skill provenance");
	exact(input, ["producer", "model", "promptVersion", "recordedAt"], "Skill provenance");
	if (!(["user", "pi-xk", "model"] as unknown[]).includes(input.producer)) {
		throw new SkillValidationError("Skill provenance producer is invalid");
	}
	return {
		producer: input.producer as MemoryProvenanceV1["producer"],
		model: input.model === null ? null : text(input.model, "Skill provenance model", 256, true),
		promptVersion:
			input.promptVersion === null ? null : text(input.promptVersion, "Skill provenance promptVersion", 256, true),
		recordedAt: timestamp(input.recordedAt, "Skill provenance recordedAt"),
	};
}

function relativePath(value: unknown, field: string): string {
	const result = text(value, field, 1024, true).replaceAll("\\", "/");
	if (result.startsWith("/") || result.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new SkillValidationError(`${field} must be a normalized bundle-relative path`);
	}
	return result;
}

export function validateSkillUseEvidenceV1(value: unknown): SkillUseEvidenceV1 {
	const input = record(value, "Skill use evidence");
	exact(
		input,
		[
			"schema",
			"useId",
			"skillId",
			"revision",
			"projectId",
			"runId",
			"outcome",
			"evidenceRefs",
			"divergenceObserved",
			"recordedAt",
		],
		"Skill use evidence",
	);
	if (input.schema !== SKILL_USE_EVIDENCE_SCHEMA)
		throw new SkillValidationError("Skill use evidence schema is invalid");
	if (!(typeof input.outcome === "string" && ["success", "failure", "unknown"].includes(input.outcome))) {
		throw new SkillValidationError("Skill use outcome is invalid");
	}
	if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 100) {
		throw new SkillValidationError("Skill use evidenceRefs must be bounded");
	}
	return {
		schema: SKILL_USE_EVIDENCE_SCHEMA,
		useId: id(input.useId, "Skill useId"),
		skillId: id(input.skillId, "Skill ID"),
		revision: positiveInteger(input.revision, "Skill revision"),
		projectId: id(input.projectId, "Skill projectId"),
		runId: id(input.runId, "Skill runId"),
		outcome: input.outcome as SkillUseOutcome,
		evidenceRefs: input.evidenceRefs.map(validateEvidenceRefV2),
		divergenceObserved:
			input.divergenceObserved === null ? null : text(input.divergenceObserved, "Skill divergence", 8_192),
		recordedAt: timestamp(input.recordedAt, "Skill use recordedAt"),
	};
}

export function validateSkillSourceEvidenceV1(value: unknown): SkillSourceEvidenceV1 {
	const input = record(value, "Skill source evidence");
	exact(
		input,
		["schema", "evidenceId", "projectId", "runId", "outcome", "evidenceRefs", "freshnessBasis", "recordedAt"],
		"Skill source evidence",
	);
	if (input.schema !== SKILL_SOURCE_EVIDENCE_SCHEMA) {
		throw new SkillValidationError("Skill source evidence schema is invalid");
	}
	if (!(typeof input.outcome === "string" && ["success", "failure", "unknown"].includes(input.outcome))) {
		throw new SkillValidationError("Skill source outcome is invalid");
	}
	if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0 || input.evidenceRefs.length > 100) {
		throw new SkillValidationError("Skill source evidenceRefs must be non-empty and bounded");
	}
	return {
		schema: SKILL_SOURCE_EVIDENCE_SCHEMA,
		evidenceId: id(input.evidenceId, "Skill source evidenceId"),
		projectId: id(input.projectId, "Skill source projectId"),
		runId: id(input.runId, "Skill source runId"),
		outcome: input.outcome as SkillUseOutcome,
		evidenceRefs: input.evidenceRefs.map(validateEvidenceRefV2),
		freshnessBasis: input.freshnessBasis === null ? null : validateGitFreshnessBasisV1(input.freshnessBasis),
		recordedAt: timestamp(input.recordedAt, "Skill source recordedAt"),
	};
}

function skillEvidence(value: unknown, field: string): SkillEvidenceV1[] {
	if (!Array.isArray(value) || value.length > 100) throw new SkillValidationError(`${field} must be bounded`);
	return value.map((entry) => {
		const input = record(entry, `${field} entry`);
		return input.schema === SKILL_SOURCE_EVIDENCE_SCHEMA
			? validateSkillSourceEvidenceV1(input)
			: validateSkillUseEvidenceV1(input);
	});
}

export function validateSkillBundleManifestV1(value: unknown): SkillBundleManifestV1 {
	const input = record(value, "Skill bundle manifest");
	exact(input, ["schema", "name", "description", "files", "totalBytes", "sourceDigest"], "Skill bundle manifest");
	if (input.schema !== SKILL_BUNDLE_MANIFEST_SCHEMA) {
		throw new SkillValidationError("Skill bundle manifest schema is invalid");
	}
	if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 20) {
		throw new SkillValidationError("Skill bundle files must be non-empty and bounded");
	}
	const files = input.files.map((entry, index) => {
		const file = record(entry, `Skill bundle files[${index}]`);
		exact(file, ["path", "digest", "artifactId", "executable", "bytes"], `Skill bundle files[${index}]`);
		if (typeof file.executable !== "boolean") throw new SkillValidationError("Skill bundle executable is invalid");
		if (
			typeof file.bytes !== "number" ||
			!Number.isInteger(file.bytes) ||
			file.bytes < 0 ||
			file.bytes > 256 * 1024
		) {
			throw new SkillValidationError("Skill bundle file bytes are invalid");
		}
		return {
			path: relativePath(file.path, `Skill bundle files[${index}].path`),
			digest: digest(file.digest, `Skill bundle files[${index}].digest`),
			artifactId: digest(file.artifactId, `Skill bundle files[${index}].artifactId`),
			executable: file.executable,
			bytes: file.bytes,
		};
	});
	if (!files.some((file) => file.path === "SKILL.md"))
		throw new SkillValidationError("Skill bundle requires SKILL.md");
	if (new Set(files.map((file) => file.path)).size !== files.length) {
		throw new SkillValidationError("Skill bundle file paths must be unique");
	}
	if (
		typeof input.totalBytes !== "number" ||
		!Number.isInteger(input.totalBytes) ||
		input.totalBytes < 1 ||
		input.totalBytes > 256 * 1024
	) {
		throw new SkillValidationError("Skill bundle totalBytes is invalid");
	}
	if (files.reduce((total, file) => total + file.bytes, 0) !== input.totalBytes) {
		throw new SkillValidationError("Skill bundle totalBytes does not match files");
	}
	return {
		schema: SKILL_BUNDLE_MANIFEST_SCHEMA,
		name: skillName(input.name),
		description: text(input.description, "Skill bundle description", 1_024),
		files,
		totalBytes: input.totalBytes,
		sourceDigest: digest(input.sourceDigest, "Skill bundle sourceDigest"),
	};
}

export function validateSkillCandidateV1(value: unknown): SkillCandidateV1 {
	const input = record(value, "Skill candidate");
	exact(
		input,
		[
			"schema",
			"candidateId",
			"skillId",
			"targetScope",
			"expectedRevision",
			"name",
			"description",
			"applicability",
			"divergenceConditions",
			"bundleArtifactId",
			"evidenceRefs",
			"sourceDigest",
			"provenance",
		],
		"Skill candidate",
	);
	if (input.schema !== SKILL_CANDIDATE_SCHEMA) throw new SkillValidationError("Skill candidate schema is invalid");
	if (input.targetScope !== "project" && input.targetScope !== "global") {
		throw new SkillValidationError("Skill candidate targetScope is invalid");
	}
	return {
		schema: SKILL_CANDIDATE_SCHEMA,
		candidateId: id(input.candidateId, "Skill candidateId"),
		skillId: id(input.skillId, "Skill ID"),
		targetScope: input.targetScope,
		expectedRevision:
			input.expectedRevision === null ? null : positiveInteger(input.expectedRevision, "Skill expected revision"),
		name: skillName(input.name),
		description: text(input.description, "Skill description", 1_024),
		applicability: text(input.applicability, "Skill applicability", 8_192),
		divergenceConditions: strings(input.divergenceConditions, "Skill divergenceConditions", 50, 1_024),
		bundleArtifactId: digest(input.bundleArtifactId, "Skill bundleArtifactId"),
		evidenceRefs: skillEvidence(input.evidenceRefs, "Skill evidenceRefs"),
		sourceDigest: digest(input.sourceDigest, "Skill sourceDigest"),
		provenance: provenance(input.provenance),
	};
}

export function validateSkillRevisionV1(value: unknown): SkillRevisionV1 {
	const input = record(value, "Skill revision");
	exact(
		input,
		[
			"schema",
			"skillId",
			"revision",
			"scope",
			"lifecycle",
			"name",
			"description",
			"applicability",
			"divergenceConditions",
			"files",
			"evidenceRefs",
			"supersedesRevisions",
			"sourceDigest",
			"provenance",
		],
		"Skill revision",
	);
	if (input.schema !== SKILL_REVISION_SCHEMA) throw new SkillValidationError("Skill revision schema is invalid");
	if (input.scope !== "project" && input.scope !== "global") throw new SkillValidationError("Skill scope is invalid");
	if (!(typeof input.lifecycle === "string" && ["active", "superseded", "archived"].includes(input.lifecycle))) {
		throw new SkillValidationError("Skill lifecycle is invalid");
	}
	if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 20) {
		throw new SkillValidationError("Skill files must be non-empty and bounded");
	}
	const files = input.files.map((entry, index) => {
		const file = record(entry, `Skill files[${index}]`);
		exact(file, ["path", "digest", "executable"], `Skill files[${index}]`);
		if (typeof file.executable !== "boolean") throw new SkillValidationError("Skill executable flag is invalid");
		return {
			path: relativePath(file.path, `Skill files[${index}].path`),
			digest: digest(file.digest, `Skill files[${index}].digest`),
			executable: file.executable,
		};
	});
	if (new Set(files.map((file) => file.path)).size !== files.length) {
		throw new SkillValidationError("Skill file paths must be unique");
	}
	if (!files.some((file) => file.path === "SKILL.md"))
		throw new SkillValidationError("Skill bundle requires SKILL.md");
	if (!Array.isArray(input.supersedesRevisions) || input.supersedesRevisions.length > 50) {
		throw new SkillValidationError("Skill supersedesRevisions must be bounded");
	}
	const supersedesRevisions = input.supersedesRevisions.map((entry, index) => {
		const reference = record(entry, `Skill supersedesRevisions[${index}]`);
		exact(reference, ["skillId", "revision"], `Skill supersedesRevisions[${index}]`);
		return {
			skillId: id(reference.skillId, `Skill supersedesRevisions[${index}].skillId`),
			revision: positiveInteger(reference.revision, `Skill supersedesRevisions[${index}].revision`),
		};
	});
	return {
		schema: SKILL_REVISION_SCHEMA,
		skillId: id(input.skillId, "Skill ID"),
		revision: positiveInteger(input.revision, "Skill revision"),
		scope: input.scope,
		lifecycle: input.lifecycle as SkillLifecycle,
		name: skillName(input.name),
		description: text(input.description, "Skill description", 1_024),
		applicability: text(input.applicability, "Skill applicability", 8_192),
		divergenceConditions: strings(input.divergenceConditions, "Skill divergenceConditions", 50, 1_024),
		files,
		evidenceRefs: skillEvidence(input.evidenceRefs, "Skill evidenceRefs"),
		supersedesRevisions,
		sourceDigest: digest(input.sourceDigest, "Skill sourceDigest"),
		provenance: provenance(input.provenance),
	};
}

export function validateSkillReviewDecisionV1(value: unknown): SkillReviewDecisionV1 {
	const input = record(value, "Skill review decision");
	exact(
		input,
		[
			"schema",
			"decisionId",
			"runId",
			"action",
			"sourceSkills",
			"uses",
			"replacement",
			"evidenceIds",
			"reason",
			"provenance",
		],
		"Skill review decision",
	);
	if (input.schema !== SKILL_REVIEW_DECISION_SCHEMA) {
		throw new SkillValidationError("Skill review decision schema is invalid");
	}
	if (!(typeof input.action === "string" && ["keep", "create", "revise", "supersede"].includes(input.action))) {
		throw new SkillValidationError("Skill review action is invalid");
	}
	if (!Array.isArray(input.sourceSkills) || input.sourceSkills.length > 20) {
		throw new SkillValidationError("Skill review sourceSkills must be bounded");
	}
	const sourceSkills = input.sourceSkills.map((entry, index) => {
		const source = record(entry, `Skill review sourceSkills[${index}]`);
		exact(source, ["skillId", "expectedRevision"], `Skill review sourceSkills[${index}]`);
		return {
			skillId: id(source.skillId, `Skill review sourceSkills[${index}].skillId`),
			expectedRevision: positiveInteger(
				source.expectedRevision,
				`Skill review sourceSkills[${index}].expectedRevision`,
			),
		};
	});
	if (new Set(sourceSkills.map((source) => source.skillId)).size !== sourceSkills.length) {
		throw new SkillValidationError("Skill review sourceSkills must be unique");
	}
	if (!Array.isArray(input.uses) || input.uses.length > 20) {
		throw new SkillValidationError("Skill review uses must be bounded");
	}
	const uses = input.uses.map((entry, index) => {
		const use = record(entry, `Skill review uses[${index}]`);
		exact(use, ["skillId", "expectedRevision", "outcome", "divergenceObserved"], `Skill review uses[${index}]`);
		if (!(typeof use.outcome === "string" && ["success", "failure", "unknown"].includes(use.outcome))) {
			throw new SkillValidationError(`Skill review uses[${index}].outcome is invalid`);
		}
		return {
			skillId: id(use.skillId, `Skill review uses[${index}].skillId`),
			expectedRevision: positiveInteger(use.expectedRevision, `Skill review uses[${index}].expectedRevision`),
			outcome: use.outcome as SkillUseOutcome,
			divergenceObserved:
				use.divergenceObserved === null
					? null
					: text(use.divergenceObserved, `Skill review uses[${index}].divergenceObserved`, 8_192),
		};
	});
	if (new Set(uses.map((use) => use.skillId)).size !== uses.length) {
		throw new SkillValidationError("Skill review uses must be unique");
	}
	const action = input.action as SkillReviewAction;
	if (action === "create" && sourceSkills.length !== 0) {
		throw new SkillValidationError("Skill create cannot name source Skills");
	}
	if (action === "keep" && sourceSkills.length === 0) {
		throw new SkillValidationError("Skill keep requires at least one source Skill");
	}
	if (action === "revise" && sourceSkills.length !== 1) {
		throw new SkillValidationError("Skill revise requires exactly one source Skill");
	}
	if (action === "supersede" && sourceSkills.length === 0) {
		throw new SkillValidationError("Skill supersede requires at least one source Skill");
	}
	if ((action === "keep") !== (input.replacement === null)) {
		throw new SkillValidationError("Skill review replacement does not match its action");
	}
	let replacement: SkillSemanticDraftV1 | null = null;
	if (input.replacement !== null) {
		const draft = record(input.replacement, "Skill review replacement");
		exact(
			draft,
			["targetScope", "name", "description", "applicability", "divergenceConditions", "instructions", "resources"],
			"Skill review replacement",
		);
		if (draft.targetScope !== "project" && draft.targetScope !== "global") {
			throw new SkillValidationError("Skill review targetScope is invalid");
		}
		const instructions = record(draft.instructions, "Skill review instructions");
		exact(instructions, ["steps", "validation", "failureHandling"], "Skill review instructions");
		if (!Array.isArray(draft.resources) || draft.resources.length > 19) {
			throw new SkillValidationError("Skill review resources must be bounded");
		}
		const resources = draft.resources.map((entry, index) => {
			const resource = record(entry, `Skill review resources[${index}]`);
			exact(resource, ["path", "content", "executable"], `Skill review resources[${index}]`);
			if (typeof resource.executable !== "boolean") {
				throw new SkillValidationError(`Skill review resources[${index}].executable is invalid`);
			}
			return {
				path: relativePath(resource.path, `Skill review resources[${index}].path`),
				content: text(resource.content, `Skill review resources[${index}].content`, 65_536),
				executable: resource.executable,
			};
		});
		if (new Set(resources.map((resource) => resource.path)).size !== resources.length) {
			throw new SkillValidationError("Skill review resource paths must be unique");
		}
		replacement = {
			targetScope: draft.targetScope,
			name: skillName(draft.name),
			description: text(draft.description, "Skill review description", 1_024),
			applicability: text(draft.applicability, "Skill review applicability", 8_192),
			divergenceConditions: strings(draft.divergenceConditions, "Skill review divergenceConditions", 50, 1_024),
			instructions: {
				steps: text(instructions.steps, "Skill review steps", 32_768),
				validation: text(instructions.validation, "Skill review validation", 32_768),
				failureHandling: text(instructions.failureHandling, "Skill review failureHandling", 32_768),
			},
			resources,
		};
	}
	return {
		schema: SKILL_REVIEW_DECISION_SCHEMA,
		decisionId: id(input.decisionId, "Skill review decisionId"),
		runId: id(input.runId, "Skill review runId"),
		action,
		sourceSkills,
		uses,
		replacement,
		evidenceIds: strings(input.evidenceIds, "Skill review evidenceIds", 100, 160),
		reason: text(input.reason, "Skill review reason", 8_192),
		provenance: provenance(input.provenance),
	};
}
