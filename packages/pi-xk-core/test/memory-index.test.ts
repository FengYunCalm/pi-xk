import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type {
	MemoryIndexCueV1,
	MemoryIndexEdgeV1,
	MemoryIndexMemoryV1,
	MemoryIndexRebuildChunkV1,
	MemoryIndexRebuildPlanV1,
	MemoryIndexSnapshotV1,
} from "../src/index.ts";
import { MemoryIndexWorkerClient } from "../src/index.ts";
import { MemorySqliteProjection } from "../src/memory-index-database.ts";

const execFile = promisify(execFileCallback);
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

function memory(
	memoryId: string,
	title: string,
	statement: string,
	options: Partial<MemoryIndexMemoryV1> = {},
): MemoryIndexMemoryV1 {
	return {
		memoryId,
		revision: 1,
		artifactId: `sha256:${(memoryId.endsWith("two") ? "b" : "a").repeat(64)}`,
		kind: "decision",
		title,
		statement,
		applicability: "Pi-XK Session Chain",
		trust: "model_inferred",
		freshness: "current",
		lifecycle: "active",
		effectiveFrom: "2026-08-01T00:00:00.000Z",
		effectiveTo: null,
		recordedAt: "2026-08-01T00:00:00.000Z",
		sourceDigest: `sha256:${(memoryId.endsWith("two") ? "d" : "c").repeat(64)}`,
		evidenceIds: [`evidence_${memoryId}`],
		accessCount: 0,
		lastAccessedAt: null,
		...options,
	};
}

function cue(cueId: string, key: string, label: string): MemoryIndexCueV1 {
	return {
		cueId,
		revision: 1,
		artifactId: `sha256:${"e".repeat(64)}`,
		kind: "component",
		key,
		label,
		aliases: [],
	};
}

function edge(edgeId: string, memoryId: string, cueId: string): MemoryIndexEdgeV1 {
	return {
		edgeId,
		artifactId: `sha256:${"f".repeat(64)}`,
		fromKind: "memory",
		fromId: memoryId,
		toKind: "cue",
		toId: cueId,
		relation: "applies_to",
		effectiveFrom: "2026-08-01T00:00:00.000Z",
		effectiveTo: null,
	};
}

function snapshot(): MemoryIndexSnapshotV1 {
	return {
		head: { sequence: 12, hash: `sha256:${"1".repeat(64)}` },
		memories: [
			memory("memory_one", "Canonical summaries", "Artifact read-back content is canonical."),
			memory("memory_two", "Goal revision policy", "Verified Goal contracts require confirmation.", {
				freshness: "stale",
			}),
		],
		cues: [cue("cue_chain", "session-chain", "Session Chain"), cue("cue_goal", "goal", "Goal")],
		edges: [edge("edge_one", "memory_one", "cue_chain"), edge("edge_two", "memory_two", "cue_goal")],
		historyCues: [
			{
				cueId: "history_segment_5",
				sourceType: "segment_summary",
				sourceId: `sha256:${"9".repeat(64)}`,
				title: "Artifact summary correction",
				recordedAt: "2026-08-01T00:00:00.000Z",
				chainId: "chain_main",
				branchId: "branch_main",
				segmentId: "segment_5",
				ordinal: 5,
				sessionId: null,
			},
		],
	};
}

function rebuildPlan(value: MemoryIndexSnapshotV1): MemoryIndexRebuildPlanV1 {
	return {
		head: value.head,
		memoryCount: value.memories.length,
		cueCount: value.cues.length,
		edgeCount: value.edges.length,
		historyCueCount: value.historyCues.length,
	};
}

async function* rebuildChunks(value: MemoryIndexSnapshotV1): AsyncGenerator<MemoryIndexRebuildChunkV1> {
	yield { memories: value.memories.slice(0, 1), cues: [], edges: [], historyCues: [] };
	yield { memories: value.memories.slice(1), cues: value.cues, edges: [], historyCues: [] };
	yield { memories: [], cues: [], edges: value.edges, historyCues: value.historyCues };
}

describe("Memory SQLite projection", () => {
	it("runs the Node SQLite projection behind the async worker port", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xk-memory-index-worker-"));
		const client = new MemoryIndexWorkerClient({
			databasePath: join(directory, "index.sqlite"),
			nodeWorkerUrl: new URL("../src/memory-index-node-worker.ts", import.meta.url),
		});
		try {
			expect(await client.status()).toEqual({
				schemaVersion: 3,
				head: { sequence: 0, hash: null },
				memoryCount: 0,
				cueCount: 0,
				edgeCount: 0,
				historyCueCount: 0,
				stateCounts: {
					trust: { verified: 0, model_inferred: 0, disputed: 0 },
					freshness: { current: 0, stale: 0, unknown: 0 },
					lifecycle: { active: 0, superseded: 0, invalidated: 0, archived: 0 },
				},
			});
			const value = snapshot();
			await client.rebuildFromChunks(rebuildPlan(value), rebuildChunks(value));
			expect((await client.search({ query: "Session Chain", limit: 12, graphDepth: 1 })).memories[0]?.memoryId).toBe(
				"memory_one",
			);
			await client.recordAccess(["memory_one"], "2026-08-01T00:00:00.000Z", {
				sequence: 2,
				hash: `sha256:${"b".repeat(64)}`,
			});
			expect(await client.integrityCheck()).toBe("ok");
		} finally {
			await client.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("publishes rebuilt metadata only after every chunk finishes", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		const initial = snapshot();
		projection.rebuild(initial);
		const replacement: MemoryIndexSnapshotV1 = {
			head: { sequence: 20, hash: `sha256:${"2".repeat(64)}` },
			memories: [memory("memory_replacement", "Replacement memory", "Replacement statement")],
			cues: [],
			edges: [],
			historyCues: [],
		};

		projection.beginRebuild(rebuildPlan(replacement));
		projection.appendRebuildChunk({
			memories: replacement.memories,
			cues: [],
			edges: [],
			historyCues: [],
		});
		expect(projection.status()).toMatchObject({ head: initial.head, memoryCount: initial.memories.length });
		projection.finishRebuild();
		expect(projection.status()).toMatchObject({ head: replacement.head, memoryCount: 1 });
		database.close();
	});

	it("rolls back the complete rebuild when a later chunk fails", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		const initial = snapshot();
		projection.rebuild(initial);
		const replacement = memory("memory_replacement", "Replacement memory", "Replacement statement");
		projection.beginRebuild({
			head: { sequence: 21, hash: `sha256:${"3".repeat(64)}` },
			memoryCount: 2,
			cueCount: 0,
			edgeCount: 0,
			historyCueCount: 0,
		});
		projection.appendRebuildChunk({ memories: [replacement], cues: [], edges: [], historyCues: [] });
		expect(() =>
			projection.appendRebuildChunk({ memories: [replacement], cues: [], edges: [], historyCues: [] }),
		).toThrow();

		expect(projection.status()).toMatchObject({ head: initial.head, memoryCount: initial.memories.length });
		expect(projection.search({ query: "Canonical summaries", limit: 12, graphDepth: 0 }).memories[0]?.memoryId).toBe(
			"memory_one",
		);
		database.close();
	});

	it("closes without hanging after the worker fails during database startup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-xk-memory-index-corrupt-"));
		const databasePath = join(directory, "index.sqlite");
		await writeFile(databasePath, "not a SQLite database");
		const client = new MemoryIndexWorkerClient({
			databasePath,
			nodeWorkerUrl: new URL("../src/memory-index-node-worker.ts", import.meta.url),
		});
		try {
			await expect(client.status()).rejects.toThrow();
			await expect(client.close()).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rebuilds facts and checkpoints the event head", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		expect(projection.status()).toEqual({
			schemaVersion: 3,
			head: snapshot().head,
			memoryCount: 2,
			cueCount: 2,
			edgeCount: 2,
			historyCueCount: 1,
			stateCounts: {
				trust: { verified: 0, model_inferred: 2, disputed: 0 },
				freshness: { current: 1, stale: 1, unknown: 0 },
				lifecycle: { active: 2, superseded: 0, invalidated: 0, archived: 0 },
			},
		});
		expect(projection.integrityCheck()).toBe("ok");
		database.close();
	});

	it("restores access heat from the event-derived snapshot", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			memories: [
				memory("memory_one", "Canonical summaries", "Artifact read-back content is canonical.", {
					accessCount: 7,
					lastAccessedAt: "2026-08-01T01:00:00.000Z",
				}),
			],
		});
		expect(projection.getMemory("memory_one")).toMatchObject({
			accessCount: 7,
			lastAccessedAt: "2026-08-01T01:00:00.000Z",
		});
		database.close();
	});

	it("applies fact deltas atomically with event-head CAS", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		const initial = snapshot();
		projection.rebuild(initial);
		const replacement = memory("memory_two", "Updated Goal policy", "Updated searchable statement", {
			revision: 2,
			accessCount: 3,
		});
		projection.applyDelta({
			expectedHead: initial.head,
			head: { sequence: 13, hash: `sha256:${"2".repeat(64)}` },
			memories: [replacement],
			cues: [],
			edges: [],
			historyCues: [],
			removeMemoryIds: ["memory_one"],
			removeCueIds: [],
			removeEdgeIds: [],
		});
		expect(projection.status()).toMatchObject({
			head: { sequence: 13, hash: `sha256:${"2".repeat(64)}` },
			memoryCount: 1,
			edgeCount: 1,
		});
		expect(projection.search({ query: "Updated searchable", limit: 12, graphDepth: 0 }).memories[0]).toMatchObject({
			memoryId: "memory_two",
			revision: 2,
		});
		expect(projection.search({ query: "Canonical summaries", limit: 12, graphDepth: 0 }).memories).toEqual([]);
		const updatedHead = projection.status().head;
		projection.applyDelta({
			expectedHead: updatedHead,
			head: updatedHead,
			memories: [],
			cues: [],
			edges: [],
			historyCues: [
				{
					cueId: "history_segment_10",
					sourceType: "compaction",
					sourceId: "compaction_segment_10",
					title: "Incremental history cue",
					recordedAt: "2026-08-02T00:00:00.000Z",
					chainId: "chain_main",
					branchId: "branch_main",
					segmentId: "segment_10",
					ordinal: 10,
					sessionId: "session_segment_10",
				},
			],
			removeMemoryIds: [],
			removeCueIds: [],
			removeEdgeIds: [],
		});
		expect(projection.status()).toMatchObject({ head: updatedHead, historyCueCount: 2 });
		expect(() =>
			projection.applyDelta({
				expectedHead: updatedHead,
				head: updatedHead,
				memories: [replacement],
				cues: [],
				edges: [],
				historyCues: [],
				removeMemoryIds: [],
				removeCueIds: [],
				removeEdgeIds: [],
			}),
		).toThrow(/fact delta must advance/i);
		expect(() =>
			projection.applyDelta({
				expectedHead: initial.head,
				head: { sequence: 14, hash: `sha256:${"3".repeat(64)}` },
				memories: [],
				cues: [],
				edges: [],
				historyCues: [],
				removeMemoryIds: [],
				removeCueIds: [],
				removeEdgeIds: [],
			}),
		).toThrow(/head conflict/i);
		database.close();
	});

	it("represents an empty rebuilt event head with a null hash", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({ head: { sequence: 0, hash: null }, memories: [], cues: [], edges: [], historyCues: [] });
		expect(projection.status().head).toEqual({ sequence: 0, hash: null });
		database.close();
	});

	it("returns metadata-only D1 candidates from lexical and graph retrieval", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		const result = projection.search({ query: "Session Chain", limit: 12, graphDepth: 1 });
		expect(result.memories[0]).toMatchObject({
			memoryId: "memory_one",
			title: "Canonical summaries",
			state: { trust: "model_inferred", freshness: "current", lifecycle: "active" },
		});
		expect(result.memories[0]).not.toHaveProperty("statement");
		expect(result.historyCues).toEqual([]);
		database.close();
	});

	it("retrieves reordered keywords across title and statement fields", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		const result = projection.search({
			query: "read-back summaries canonical Artifact",
			limit: 12,
			graphDepth: 0,
		});
		expect(result.memories[0]?.memoryId).toBe("memory_one");
		database.close();
	});

	it("returns title-only history cues without promoting them to memory", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		const result = projection.search({
			query: "Artifact",
			limit: 12,
			graphDepth: 1,
			includeHistoryCues: true,
		});
		expect(result.historyCues).toEqual([
			expect.objectContaining({
				cueId: "history_segment_5",
				title: "Artifact summary correction",
				chainId: "chain_main",
				branchId: "branch_main",
				segmentId: "segment_5",
				ordinal: 5,
			}),
		]);
		expect(result.historyCues[0]).not.toHaveProperty("statement");
		database.close();
	});

	it("retrieves two-code-point CJK terms across memories, cues, and history cues", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			memories: [memory("memory_one", "目标修订", "目标合同需要确认")],
			cues: [cue("cue_goal", "目标", "目标")],
			edges: [edge("edge_one", "memory_one", "cue_goal")],
			historyCues: [{ ...snapshot().historyCues[0]!, title: "目标复盘" }],
		});
		const result = projection.search({
			query: "目标",
			limit: 12,
			graphDepth: 1,
			includeHistoryCues: true,
		});
		expect(result.memories.map((entry) => entry.memoryId)).toEqual(["memory_one"]);
		expect(result.historyCues.map((entry) => entry.cueId)).toEqual(["history_segment_5"]);
		database.close();
	});

	it("uses one page budget across Memory and History Cue results", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		const first = projection.search({
			query: "Artifact",
			limit: 1,
			graphDepth: 0,
			includeHistoryCues: true,
		});
		expect(first.memories.length + first.historyCues.length).toBe(1);
		expect(first.hasMore).toBe(true);
		const second = projection.search({
			query: "Artifact",
			limit: 1,
			offset: 1,
			graphDepth: 0,
			includeHistoryCues: true,
		});
		expect(second.memories.length + second.historyCues.length).toBe(1);
		database.close();
	});

	it("caps the combined Memory and History Cue candidate pool before pagination", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			head: { sequence: 1, hash: `sha256:${"8".repeat(64)}` },
			memories: Array.from({ length: 150 }, (_, index) =>
				memory(`memory_pool_${index}`, `Shared pool candidate ${index}`, "Shared pool candidate body"),
			),
			cues: [],
			edges: [],
			historyCues: Array.from({ length: 150 }, (_, index) => ({
				cueId: `history_pool_${index}`,
				sourceType: "segment_summary" as const,
				sourceId: `sha256:${index.toString(16).padStart(64, "0")}`,
				title: `Shared pool candidate ${index}`,
				recordedAt: "2026-08-01T00:00:00.000Z",
				chainId: "chain_pool",
				branchId: "branch_pool",
				segmentId: `segment_pool_${index}`,
				ordinal: index + 1,
				sessionId: null,
			})),
		});

		const last = projection.search({
			query: "Shared pool candidate",
			limit: 50,
			offset: 199,
			graphDepth: 0,
			includeHistoryCues: true,
		});
		expect(last.memories.length + last.historyCues.length).toBe(1);
		expect(last.hasMore).toBe(false);
		expect(
			projection.search({
				query: "Shared pool candidate",
				limit: 50,
				offset: 200,
				graphDepth: 0,
				includeHistoryCues: true,
			}),
		).toMatchObject({ memories: [], historyCues: [], hasMore: false });
		database.close();
	});

	it("recalls recent entries without requiring temporal words in their text", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild(snapshot());
		const result = projection.search({ query: "最近", limit: 1, graphDepth: 0 });
		expect(result.memories).toHaveLength(1);
		database.close();
	});

	it("filters graph traversal and relation hints by edge effective time", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			edges: snapshot().edges.map((entry) => ({ ...entry, effectiveTo: "2026-08-02T00:00:00.000Z" })),
		});
		expect(
			projection.graph({ rootMemoryId: "memory_one", depth: 1, asOf: "2026-08-01T12:00:00.000Z" }).cueIds,
		).toEqual(["cue_chain"]);
		expect(
			projection.graph({ rootMemoryId: "memory_one", depth: 1, asOf: "2026-08-03T00:00:00.000Z" }).cueIds,
		).toEqual([]);
		expect(
			projection.search({
				query: "Canonical summaries",
				limit: 12,
				graphDepth: 0,
				asOf: "2026-08-03T00:00:00.000Z",
			}).memories[0]?.relations,
		).toEqual([]);
		expect(
			projection.graph({ rootMemoryId: "memory_one", depth: 1, asOf: "August 1, 2026 12:00:00 UTC" }).cueIds,
		).toEqual(["cue_chain"]);
		expect(
			projection.search({
				query: "Canonical summaries",
				limit: 12,
				graphDepth: 1,
				asOf: "August 1, 2026 12:00:00 UTC",
			}).memories[0]?.relations,
		).toEqual([expect.objectContaining({ edgeId: "edge_one" })]);
		database.close();
	});

	it("uses access heat only as a bounded ranking signal", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			memories: [
				memory("memory_one", "Shared decision one", "same searchable phrase"),
				memory("memory_two", "Shared decision two", "same searchable phrase", { trust: "verified" }),
			],
		});
		for (let index = 0; index < 100; index++) {
			projection.recordAccess(["memory_one"], "2026-08-01T00:00:00.000Z", {
				sequence: index + 2,
				hash: `sha256:${"b".repeat(64)}`,
			});
		}
		const result = projection.search({ query: "same searchable phrase", limit: 12, graphDepth: 0 });
		expect(result.memories.map((entry) => entry.memoryId)).toContain("memory_one");
		expect(result.memories.map((entry) => entry.memoryId)).toContain("memory_two");
		expect(projection.getMemory("memory_one")?.lifecycle).toBe("active");
		database.close();
	});

	it("honors as-of validity and lifecycle filters", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			memories: [
				memory("memory_one", "Historical decision", "valid during July", {
					effectiveFrom: "2026-07-01T00:00:00.000Z",
					effectiveTo: "2026-08-01T00:00:00.000Z",
				}),
				memory("memory_two", "Archived decision", "not active", { lifecycle: "archived" }),
			],
		});
		expect(
			projection.search({ query: "Historical decision", asOf: "2026-07-15T00:00:00.000Z", limit: 12, graphDepth: 0 })
				.memories,
		).toHaveLength(1);
		expect(
			projection.search({ query: "Historical decision", asOf: "2026-08-02T00:00:00.000Z", limit: 12, graphDepth: 0 })
				.memories,
		).toHaveLength(0);
		expect(projection.search({ query: "Archived decision", limit: 12, graphDepth: 0 }).memories).toHaveLength(0);
		database.close();
	});

	it("keeps committed current facts visible when the host wall clock moves backward", () => {
		vi.useFakeTimers();
		const database = new DatabaseSync(":memory:");
		try {
			const committedAt = "2026-08-06T12:00:00.500Z";
			vi.setSystemTime(committedAt);
			const projection = new MemorySqliteProjection(database);
			projection.rebuild({
				head: { sequence: 1, hash: `sha256:${"7".repeat(64)}` },
				memories: [
					memory("memory_one", "Clock-safe current fact", "The committed fact remains searchable.", {
						effectiveFrom: committedAt,
						recordedAt: committedAt,
					}),
				],
				cues: [],
				edges: [],
				historyCues: [],
			});

			vi.setSystemTime("2026-08-06T12:00:00.000Z");
			expect(projection.search({ query: "Clock-safe current fact", limit: 12, graphDepth: 0 }).memories).toEqual([
				expect.objectContaining({ memoryId: "memory_one" }),
			]);
			expect(
				projection.search({
					query: "Clock-safe current fact",
					asOf: "2026-08-06T12:00:00.000Z",
					limit: 12,
					graphDepth: 0,
				}).memories,
			).toEqual([]);
		} finally {
			database.close();
			vi.useRealTimers();
		}
	});

	it("pages the ranked candidate set without reading memory bodies into D1", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		projection.rebuild({
			...snapshot(),
			memories: [
				memory("memory_one", "Shared candidate one", "shared candidate phrase"),
				memory("memory_two", "Shared candidate two", "shared candidate phrase"),
			],
		});
		const first = projection.search({ query: "shared candidate phrase", limit: 1, offset: 0, graphDepth: 0 });
		const second = projection.search({ query: "shared candidate phrase", limit: 1, offset: 1, graphDepth: 0 });
		expect(first.memories).toHaveLength(1);
		expect(second.memories).toHaveLength(1);
		expect(second.memories[0]?.memoryId).not.toBe(first.memories[0]?.memoryId);
		expect(second.memories[0]).not.toHaveProperty("statement");
		database.close();
	});

	it("caps the merged lexical and graph candidate pool at 200 entries", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new MemorySqliteProjection(database);
		const lexicalMemories = Array.from({ length: 200 }, (_, index) =>
			memory(
				`memory_lexical_${String(index).padStart(3, "0")}`,
				`Candidate pool token ${index}`,
				"candidatepooltoken",
			),
		);
		const graphMemories = Array.from({ length: 200 }, (_, index) =>
			memory(`memory_graph_${String(index).padStart(3, "0")}`, `Graph neighbor ${index}`, "graph-only neighbor"),
		);
		const edges: MemoryIndexEdgeV1[] = lexicalMemories.map((lexical, index) => ({
			edgeId: `edge_candidate_pool_${String(index).padStart(3, "0")}`,
			artifactId: `sha256:${"f".repeat(64)}`,
			fromKind: "memory",
			fromId: lexical.memoryId,
			toKind: "memory",
			toId: graphMemories[index]!.memoryId,
			relation: "related_to",
			effectiveFrom: "2026-08-01T00:00:00.000Z",
			effectiveTo: null,
		}));
		projection.rebuild({
			head: { sequence: 1, hash: `sha256:${"1".repeat(64)}` },
			memories: [...lexicalMemories, ...graphMemories],
			cues: [],
			edges,
			historyCues: [],
		});

		expect(projection.search({ query: "candidatepooltoken", limit: 1, offset: 200, graphDepth: 1 }).memories).toEqual(
			[],
		);
		database.close();
	});

	it.skipIf(!bunAvailable)(
		"checkpoints the Bun worker WAL before a rebuilt index file is moved",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-xk-memory-index-bun-move-"));
			try {
				const inputPath = join(directory, "snapshot.json");
				const temporaryPath = join(directory, "temporary.sqlite");
				const finalPath = join(directory, "index.sqlite");
				await writeFile(inputPath, `${JSON.stringify(snapshot())}\n`);
				const moduleUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
				const script = [
					'import { readFileSync, renameSync, rmSync } from "node:fs";',
					`import { MemoryIndexWorkerClient } from ${JSON.stringify(moduleUrl)};`,
					`const snapshot = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));`,
					`const temporaryPath = ${JSON.stringify(temporaryPath)};`,
					`const finalPath = ${JSON.stringify(finalPath)};`,
					"const builder = new MemoryIndexWorkerClient({ databasePath: temporaryPath });",
					"await builder.rebuild(snapshot);",
					"await builder.close();",
					"renameSync(temporaryPath, finalPath);",
					'for (const suffix of ["-wal", "-shm"]) rmSync(temporaryPath + suffix, { force: true });',
					"const reopened = new MemoryIndexWorkerClient({ databasePath: finalPath });",
					"const result = {",
					"  status: await reopened.status(),",
					'  memoryIds: (await reopened.search({ query: "Canonical summaries", limit: 12, graphDepth: 0 })).memories.map((memory) => memory.memoryId),',
					"  integrity: await reopened.integrityCheck(),",
					"};",
					"await reopened.close();",
					"process.stdout.write(JSON.stringify(result));",
				].join("\n");
				const bun = await execFile("bun", ["-e", script], {
					cwd: process.cwd(),
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
				});
				expect(JSON.parse(bun.stdout)).toEqual({
					status: expect.objectContaining({ head: snapshot().head, memoryCount: 2 }),
					memoryIds: ["memory_one"],
					integrity: "ok",
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		15_000,
	);

	it.skipIf(!bunAvailable)(
		"produces equivalent Node and Bun SQLite projection results when the Bun runtime is available",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-xk-memory-index-runtime-equivalence-"));
			try {
				const inputPath = join(directory, "snapshot.json");
				await writeFile(inputPath, `${JSON.stringify(snapshot())}\n`);
				const nodeDatabase = new DatabaseSync(":memory:");
				const nodeProjection = new MemorySqliteProjection(nodeDatabase);
				nodeProjection.rebuild(snapshot());
				const nodeResult = {
					status: nodeProjection.status(),
					memoryIds: nodeProjection
						.search({ query: "Session Chain", limit: 12, graphDepth: 2 })
						.memories.map((memory) => memory.memoryId),
					historyCueIds: nodeProjection
						.search({ query: "Artifact summary", limit: 12, graphDepth: 1, includeHistoryCues: true })
						.historyCues.map((cue) => cue.cueId),
				};
				nodeDatabase.close();

				const moduleUrl = pathToFileURL(join(process.cwd(), "src", "memory-index-database.ts")).href;
				const script = [
					'import { readFileSync } from "node:fs";',
					'import { Database } from "bun:sqlite";',
					`import { MemorySqliteProjection } from ${JSON.stringify(moduleUrl)};`,
					`const snapshot = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));`,
					'const database = new Database(":memory:", { strict: true });',
					"const projection = new MemorySqliteProjection(database);",
					"projection.rebuild(snapshot);",
					"const result = {",
					"  status: projection.status(),",
					'  memoryIds: projection.search({ query: "Session Chain", limit: 12, graphDepth: 2 }).memories.map((memory) => memory.memoryId),',
					'  historyCueIds: projection.search({ query: "Artifact summary", limit: 12, graphDepth: 1, includeHistoryCues: true }).historyCues.map((cue) => cue.cueId),',
					"};",
					"database.close();",
					"process.stdout.write(JSON.stringify(result));",
				].join("\n");
				const bun = await execFile("bun", ["-e", script], {
					cwd: process.cwd(),
					encoding: "utf8",
					maxBuffer: 4 * 1024 * 1024,
				});
				expect(JSON.parse(bun.stdout)).toEqual(nodeResult);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
