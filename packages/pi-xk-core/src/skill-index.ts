import type { SkillLifecycle, SkillScope } from "./skill-contract.ts";
import type { SkillHead } from "./skill-store.ts";

export const SKILL_INDEX_SCHEMA_VERSION = 1;

export interface SkillIndexSkillV1 {
	skillId: string;
	revision: number;
	artifactId: string;
	bundleArtifactId: string;
	scope: SkillScope;
	lifecycle: SkillLifecycle;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	stale: boolean;
	needsReview: boolean;
	successfulUses: number;
	failedUses: number;
	recordedAt: string;
	sourceDigest: string;
}

export interface SkillIndexCandidateV1 {
	candidateId: string;
	skillId: string;
	targetScope: SkillScope;
	expectedRevision: number | null;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	status: "pending" | "applied" | "rejected";
	sourceDigest: string;
}

export interface SkillIndexSnapshotV1 {
	head: SkillHead;
	skills: SkillIndexSkillV1[];
	candidates: SkillIndexCandidateV1[];
}

export interface SkillIndexDeltaV1 {
	expectedHead: SkillHead;
	head: SkillHead;
	skills: SkillIndexSkillV1[];
	candidates: SkillIndexCandidateV1[];
	removeSkillIds: string[];
	removeCandidateIds: string[];
}

export interface SkillIndexSearchInputV1 {
	query: string;
	includeCandidates: boolean;
	limit: number;
	offset?: number;
}

export interface SkillIndexSearchSkillV1 {
	skillId: string;
	revision: number;
	scope: SkillScope;
	lifecycle: SkillLifecycle;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	stale: boolean;
	needsReview: boolean;
	score: number;
}

export interface SkillIndexSearchCandidateV1 {
	candidateId: string;
	skillId: string;
	targetScope: SkillScope;
	expectedRevision: number | null;
	name: string;
	description: string;
	applicability: string;
	divergenceConditions: string[];
	status: "pending" | "applied" | "rejected";
	score: number;
}

export interface SkillIndexSearchResultV1 {
	skills: SkillIndexSearchSkillV1[];
	candidates: SkillIndexSearchCandidateV1[];
	hasMore: boolean;
}

export interface SkillIndexStatusV1 {
	schemaVersion: 1;
	head: SkillHead;
	skillCount: number;
	candidateCount: number;
	activeCount: number;
	staleCount: number;
	needsReviewCount: number;
}

export interface SkillIndexPort {
	rebuild(snapshot: SkillIndexSnapshotV1): Promise<void>;
	applyDelta(delta: SkillIndexDeltaV1): Promise<void>;
	search(input: SkillIndexSearchInputV1): Promise<SkillIndexSearchResultV1>;
	status(): Promise<SkillIndexStatusV1>;
	integrityCheck(): Promise<"ok" | string>;
	close(): Promise<void>;
}
