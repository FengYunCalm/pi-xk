import type {
	MemoryEdgeRelation,
	MemoryEvidenceSourceType,
	MemoryFreshness,
	MemoryHead,
	MemoryKind,
	MemoryLifecycle,
	MemoryStateV1,
	MemoryTrust,
} from "./memory-contract.ts";

export const MEMORY_INDEX_SCHEMA_VERSION = 6;

// D0 may expose only these fixed Host-defined source-scope categories, never a raw path component.
export const MEMORY_RECALL_SCOPE_ROOT_CATEGORIES = [
	"app",
	"apps",
	"bin",
	"cmd",
	"config",
	"configs",
	"docs",
	"internal",
	"lib",
	"packages",
	"pkg",
	"scripts",
	"server",
	"services",
	"src",
	"test",
	"tests",
	"tools",
] as const;

export type MemoryRecallSourceType = MemoryEvidenceSourceType | "agent_run";

export interface MemoryRecallRouteV1 {
	sourceType: MemoryRecallSourceType;
	goalId: string | null;
	chainId: string | null;
	branchId: string | null;
	scopeRoot: string | null;
}

export interface MemoryRecallRoutingV1 {
	routes: MemoryRecallRouteV1[];
}

export interface MemoryRecallCoverageInputV1 {
	goalId: string | null;
	chainId: string | null;
	branchId: string | null;
}

export interface MemoryRecallCoverageV1 {
	schema: "pi-xk.memory-recall-coverage.v1";
	activeMemoryCount: number;
	goalMatchCount: number;
	chainBranchMatchCount: number;
	sourceCounts: Array<{ sourceType: MemoryRecallSourceType; memoryCount: number }>;
	gitScopeRoots: string[];
}

export interface MemoryIndexMemoryV1 {
	memoryId: string;
	revision: number;
	artifactId: string;
	kind: MemoryKind;
	title: string;
	statement: string;
	applicability: string;
	trust: MemoryTrust;
	freshness: MemoryFreshness;
	lifecycle: MemoryLifecycle;
	effectiveFrom: string;
	effectiveTo: string | null;
	recordedAt: string;
	sourceDigest: string;
	evidenceIds: string[];
	accessCount: number;
	lastAccessedAt: string | null;
	recallRouting: MemoryRecallRoutingV1;
}

export interface MemoryIndexCueV1 {
	cueId: string;
	revision: number;
	artifactId: string;
	kind: "project" | "domain" | "component" | "symbol" | "workflow" | "topic";
	key: string;
	label: string;
	aliases: string[];
}

export interface MemoryIndexEdgeV1 {
	edgeId: string;
	artifactId: string;
	fromKind: "memory" | "cue";
	fromId: string;
	toKind: "memory" | "cue";
	toId: string;
	relation: MemoryEdgeRelation;
	effectiveFrom: string;
	effectiveTo: string | null;
}

export interface MemoryIndexHistoryCueV1 {
	cueId: string;
	sourceType: "segment_summary" | "compaction";
	sourceId: string;
	title: string;
	recordedAt: string;
	chainId: string;
	branchId: string;
	segmentId: string;
	ordinal: number;
	sessionId: string | null;
}

export interface MemoryIndexRebuildChunkV1 {
	memories: MemoryIndexMemoryV1[];
	cues: MemoryIndexCueV1[];
	edges: MemoryIndexEdgeV1[];
	historyCues: MemoryIndexHistoryCueV1[];
}

export interface MemoryIndexRebuildPlanV1 {
	head: MemoryHead;
	memoryCount: number;
	cueCount: number;
	edgeCount: number;
	historyCueCount: number;
}

export interface MemoryIndexSnapshotV1 extends MemoryIndexRebuildChunkV1 {
	head: MemoryHead;
}

export interface MemoryIndexDeltaV1 extends MemoryIndexRebuildChunkV1 {
	expectedHead: MemoryHead;
	head: MemoryHead;
	removeMemoryIds: string[];
	removeCueIds: string[];
	removeEdgeIds: string[];
}

export interface MemoryIndexSearchInputV1 {
	query: string;
	kinds?: MemoryKind[];
	asOf?: string;
	includeHistoryCues?: boolean;
	limit: number;
	offset?: number;
	graphDepth: 0 | 1 | 2;
}

export interface MemoryIndexCandidateV1 {
	memoryId: string;
	revision: number;
	artifactId: string;
	kind: MemoryKind;
	title: string;
	state: MemoryStateV1;
	effectiveFrom: string;
	effectiveTo: string | null;
	recordedAt: string;
	relations: Array<{ edgeId: string; relation: MemoryEdgeRelation; otherKind: "memory" | "cue"; otherId: string }>;
	score: number;
}

export interface MemoryHistoryCueCandidateV1 extends MemoryIndexHistoryCueV1 {
	score: number;
}

export interface MemoryIndexSearchResultV1 {
	memories: MemoryIndexCandidateV1[];
	historyCues: MemoryHistoryCueCandidateV1[];
	hasMore: boolean;
}

export interface MemoryIndexGraphInputV1 {
	rootMemoryId: string;
	depth: 1 | 2;
	asOf?: string;
}

export interface MemoryIndexGraphResultV1 {
	memoryIds: string[];
	cueIds: string[];
	edges: Array<{
		edgeId: string;
		from: { kind: "memory" | "cue"; id: string };
		to: { kind: "memory" | "cue"; id: string };
		relation: MemoryEdgeRelation;
	}>;
}

export interface MemoryIndexStatusV1 {
	schemaVersion: 6;
	head: MemoryHead;
	memoryCount: number;
	cueCount: number;
	edgeCount: number;
	historyCueCount: number;
	stateCounts: {
		trust: Record<MemoryTrust, number>;
		freshness: Record<MemoryFreshness, number>;
		lifecycle: Record<MemoryLifecycle, number>;
	};
}

export interface MemoryIndexPort {
	rebuild(snapshot: MemoryIndexSnapshotV1): Promise<void>;
	rebuildFromChunks(plan: MemoryIndexRebuildPlanV1, chunks: AsyncIterable<MemoryIndexRebuildChunkV1>): Promise<void>;
	applyDelta(delta: MemoryIndexDeltaV1): Promise<void>;
	search(input: MemoryIndexSearchInputV1): Promise<MemoryIndexSearchResultV1>;
	graph(input: MemoryIndexGraphInputV1): Promise<MemoryIndexGraphResultV1>;
	recallCoverage(input: MemoryRecallCoverageInputV1): Promise<MemoryRecallCoverageV1>;
	recordAccess(memoryIds: readonly string[], accessedAt: string, head: MemoryHead): Promise<void>;
	status(): Promise<MemoryIndexStatusV1>;
	integrityCheck(): Promise<"ok" | string>;
	close(): Promise<void>;
}
