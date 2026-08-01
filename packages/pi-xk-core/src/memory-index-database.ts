import {
	MEMORY_INDEX_SCHEMA_VERSION,
	type MemoryHistoryCueCandidateV1,
	type MemoryIndexCandidateV1,
	type MemoryIndexCueV1,
	type MemoryIndexEdgeV1,
	type MemoryIndexHistoryCueV1,
	type MemoryIndexMemoryV1,
	type MemoryIndexRebuildChunkV1,
	type MemoryIndexRebuildPlanV1,
	type MemoryIndexSearchInputV1,
	type MemoryIndexSearchResultV1,
	type MemoryIndexSnapshotV1,
	type MemoryIndexStatusV1,
} from "./memory-index.ts";

type SqliteValue = null | number | bigint | string | Uint8Array;

interface SqliteRunResult {
	changes: number | bigint;
}

interface SqliteStatementPort {
	run(...values: SqliteValue[]): SqliteRunResult;
	get(...values: SqliteValue[]): unknown;
	all(...values: SqliteValue[]): unknown[];
}

export interface SqliteDatabasePort {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatementPort;
}

interface MemoryRow {
	memory_id: string;
	revision: number;
	artifact_id: string;
	kind: MemoryIndexMemoryV1["kind"];
	title: string;
	statement: string;
	applicability: string;
	trust: MemoryIndexMemoryV1["trust"];
	freshness: MemoryIndexMemoryV1["freshness"];
	lifecycle: MemoryIndexMemoryV1["lifecycle"];
	effective_from: string;
	effective_to: string | null;
	recorded_at: string;
	source_digest: string;
	evidence_ids: string;
	access_count: number;
	last_accessed_at: string | null;
}

interface RankedIdRow {
	id: string;
	rank: number;
}

interface MemoryIndexRebuildState {
	plan: MemoryIndexRebuildPlanV1;
	counts: {
		memoryCount: number;
		cueCount: number;
		edgeCount: number;
		historyCueCount: number;
	};
	stateCounts: MemoryIndexStatusV1["stateCounts"];
}

const MEMORY_CANDIDATE_POOL_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Memory index ${field} is invalid`);
	return value;
}

function metadataValue(value: unknown): string {
	if (typeof value !== "string") throw new Error("Memory index metadata value is invalid");
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Memory index ${field} is invalid`);
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`Memory index ${field} is invalid`);
	}
	return value;
}

function validateRebuildPlan(plan: MemoryIndexRebuildPlanV1): MemoryIndexRebuildPlanV1 {
	const sequence = nonNegativeInteger(plan.head.sequence, "rebuild head sequence");
	const hash = plan.head.hash;
	if (
		(hash !== null && (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash))) ||
		(sequence === 0) !== (hash === null)
	) {
		throw new Error("Memory index rebuild head is invalid");
	}
	return {
		head: { sequence, hash },
		memoryCount: nonNegativeInteger(plan.memoryCount, "rebuild memoryCount"),
		cueCount: nonNegativeInteger(plan.cueCount, "rebuild cueCount"),
		edgeCount: nonNegativeInteger(plan.edgeCount, "rebuild edgeCount"),
		historyCueCount: nonNegativeInteger(plan.historyCueCount, "rebuild historyCueCount"),
	};
}

function emptyStateCounts(): MemoryIndexStatusV1["stateCounts"] {
	return {
		trust: { verified: 0, model_inferred: 0, disputed: 0 },
		freshness: { current: 0, stale: 0, unknown: 0 },
		lifecycle: { active: 0, superseded: 0, invalidated: 0, archived: 0 },
	};
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : requiredString(value, field);
}

function memoryRow(value: unknown): MemoryRow {
	if (!isRecord(value)) throw new Error("Memory index row is invalid");
	return {
		memory_id: requiredString(value.memory_id, "memory_id"),
		revision: requiredNumber(value.revision, "revision"),
		artifact_id: requiredString(value.artifact_id, "artifact_id"),
		kind: requiredString(value.kind, "kind") as MemoryRow["kind"],
		title: requiredString(value.title, "title"),
		statement: requiredString(value.statement, "statement"),
		applicability: requiredString(value.applicability, "applicability"),
		trust: requiredString(value.trust, "trust") as MemoryRow["trust"],
		freshness: requiredString(value.freshness, "freshness") as MemoryRow["freshness"],
		lifecycle: requiredString(value.lifecycle, "lifecycle") as MemoryRow["lifecycle"],
		effective_from: requiredString(value.effective_from, "effective_from"),
		effective_to: nullableString(value.effective_to, "effective_to"),
		recorded_at: requiredString(value.recorded_at, "recorded_at"),
		source_digest: requiredString(value.source_digest, "source_digest"),
		evidence_ids: requiredString(value.evidence_ids, "evidence_ids"),
		access_count: requiredNumber(value.access_count, "access_count"),
		last_accessed_at: nullableString(value.last_accessed_at, "last_accessed_at"),
	};
}

function rankedId(value: unknown): RankedIdRow {
	if (!isRecord(value)) throw new Error("Memory index ranked row is invalid");
	return { id: requiredString(value.id, "ranked id"), rank: requiredNumber(value.rank, "rank") };
}

function transaction<TResult>(database: SqliteDatabasePort, action: () => TResult): TResult {
	database.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		database.exec("COMMIT");
		return result;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
}

function ftsQuery(query: string): string {
	const tokens = [...query.matchAll(/[\p{L}\p{N}_]+/gu)]
		.map((match) => match[0])
		.filter((token, index, all) => all.indexOf(token) === index)
		.slice(0, 16);
	if (tokens.length === 0) return `"${query.trim().replaceAll('"', '""')}"`;
	return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function milliseconds(timestamp: string | null): number | null {
	if (timestamp === null) return null;
	const result = Date.parse(timestamp);
	return Number.isNaN(result) ? null : result;
}

const schemaSql = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  applicability TEXT NOT NULL,
  trust TEXT NOT NULL,
  freshness TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  recorded_at TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED,
  title,
  statement,
  applicability,
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS cues (
  cue_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  aliases TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS cue_fts USING fts5(
  cue_id UNINDEXED,
  key,
  label,
  aliases,
  tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS edges (
  edge_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS edges_from ON edges(from_kind, from_id);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_kind, to_id);
CREATE TABLE IF NOT EXISTS history_cues (
  cue_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  session_id TEXT
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS history_cue_fts USING fts5(
  cue_id UNINDEXED,
  title,
  tokenize='trigram'
);
`;

export class MemorySqliteProjection {
	private readonly database: SqliteDatabasePort;
	private readonly insertMetadataDefaultStatement: SqliteStatementPort;
	private readonly putMetadataStatement: SqliteStatementPort;
	private readonly insertMemoryStatement: SqliteStatementPort;
	private readonly insertMemoryFtsStatement: SqliteStatementPort;
	private readonly insertCueStatement: SqliteStatementPort;
	private readonly insertCueFtsStatement: SqliteStatementPort;
	private readonly insertEdgeStatement: SqliteStatementPort;
	private readonly insertHistoryCueStatement: SqliteStatementPort;
	private readonly insertHistoryCueFtsStatement: SqliteStatementPort;
	private rebuildState: MemoryIndexRebuildState | undefined;

	constructor(database: SqliteDatabasePort) {
		this.database = database;
		this.database.exec(schemaSql);
		this.insertMetadataDefaultStatement = this.database.prepare(
			"INSERT OR IGNORE INTO metadata(key, value) VALUES (?, '0')",
		);
		this.putMetadataStatement = this.database.prepare(
			"INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		);
		this.insertMemoryStatement = this.database.prepare(
			`INSERT INTO memories(
          memory_id, revision, artifact_id, kind, title, statement, applicability, trust, freshness,
          lifecycle, effective_from, effective_to, recorded_at, source_digest, evidence_ids, access_count,
          last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertMemoryFtsStatement = this.database.prepare(
			"INSERT INTO memory_fts(memory_id, title, statement, applicability) VALUES (?, ?, ?, ?)",
		);
		this.insertCueStatement = this.database.prepare(
			"INSERT INTO cues(cue_id, revision, artifact_id, kind, key, label, aliases) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.insertCueFtsStatement = this.database.prepare(
			"INSERT INTO cue_fts(cue_id, key, label, aliases) VALUES (?, ?, ?, ?)",
		);
		this.insertEdgeStatement = this.database.prepare(
			"INSERT INTO edges(edge_id, artifact_id, from_kind, from_id, to_kind, to_id, relation) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.insertHistoryCueStatement = this.database.prepare(
			"INSERT INTO history_cues(cue_id, source_type, source_id, title, recorded_at, chain_id, branch_id, segment_id, ordinal, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.insertHistoryCueFtsStatement = this.database.prepare(
			"INSERT INTO history_cue_fts(cue_id, title) VALUES (?, ?)",
		);
		this.database
			.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', ?)")
			.run(String(MEMORY_INDEX_SCHEMA_VERSION));
		for (const key of [
			"head_sequence",
			"memory_count",
			"cue_count",
			"edge_count",
			"history_cue_count",
			"trust_verified_count",
			"trust_model_inferred_count",
			"trust_disputed_count",
			"freshness_current_count",
			"freshness_stale_count",
			"freshness_unknown_count",
			"lifecycle_active_count",
			"lifecycle_superseded_count",
			"lifecycle_invalidated_count",
			"lifecycle_archived_count",
		]) {
			this.insertMetadataDefaultStatement.run(key);
		}
		this.database.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('head_hash', '')").run();
		const version = this.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get();
		if (!isRecord(version) || version.value !== String(MEMORY_INDEX_SCHEMA_VERSION)) {
			throw new Error("Memory index schema version is unsupported");
		}
	}

	private putMetadata(key: string, value: string): void {
		this.putMetadataStatement.run(key, value);
	}

	private insertMemory(memory: MemoryIndexMemoryV1): void {
		this.insertMemoryStatement.run(
			memory.memoryId,
			memory.revision,
			memory.artifactId,
			memory.kind,
			memory.title,
			memory.statement,
			memory.applicability,
			memory.trust,
			memory.freshness,
			memory.lifecycle,
			memory.effectiveFrom,
			memory.effectiveTo,
			memory.recordedAt,
			memory.sourceDigest,
			JSON.stringify(memory.evidenceIds),
			memory.accessCount,
			memory.lastAccessedAt,
		);
		this.insertMemoryFtsStatement.run(memory.memoryId, memory.title, memory.statement, memory.applicability);
	}

	private insertCue(cue: MemoryIndexCueV1): void {
		const aliases = JSON.stringify(cue.aliases);
		this.insertCueStatement.run(cue.cueId, cue.revision, cue.artifactId, cue.kind, cue.key, cue.label, aliases);
		this.insertCueFtsStatement.run(cue.cueId, cue.key, cue.label, cue.aliases.join(" "));
	}

	private insertEdge(edge: MemoryIndexEdgeV1): void {
		this.insertEdgeStatement.run(
			edge.edgeId,
			edge.artifactId,
			edge.fromKind,
			edge.fromId,
			edge.toKind,
			edge.toId,
			edge.relation,
		);
	}

	private insertHistoryCue(cue: MemoryIndexHistoryCueV1): void {
		this.insertHistoryCueStatement.run(
			cue.cueId,
			cue.sourceType,
			cue.sourceId,
			cue.title,
			cue.recordedAt,
			cue.chainId,
			cue.branchId,
			cue.segmentId,
			cue.ordinal,
			cue.sessionId,
		);
		this.insertHistoryCueFtsStatement.run(cue.cueId, cue.title);
	}

	beginRebuild(planInput: MemoryIndexRebuildPlanV1): void {
		if (this.rebuildState) throw new Error("Memory index rebuild is already active");
		const plan = validateRebuildPlan(planInput);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.exec(
				"DELETE FROM memory_fts; DELETE FROM cue_fts; DELETE FROM history_cue_fts; DELETE FROM edges; DELETE FROM memories; DELETE FROM cues; DELETE FROM history_cues;",
			);
			this.rebuildState = {
				plan,
				counts: { memoryCount: 0, cueCount: 0, edgeCount: 0, historyCueCount: 0 },
				stateCounts: emptyStateCounts(),
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	appendRebuildChunk(chunk: MemoryIndexRebuildChunkV1): void {
		const state = this.rebuildState;
		if (!state) throw new Error("Memory index rebuild is not active");
		try {
			for (const [field, entries, expected] of [
				["memoryCount", chunk.memories, state.plan.memoryCount],
				["cueCount", chunk.cues, state.plan.cueCount],
				["edgeCount", chunk.edges, state.plan.edgeCount],
				["historyCueCount", chunk.historyCues, state.plan.historyCueCount],
			] as const) {
				if (!Array.isArray(entries) || state.counts[field] + entries.length > expected) {
					throw new Error(`Memory index rebuild ${field} exceeds its plan`);
				}
			}
			for (const memory of chunk.memories) {
				if (!Object.hasOwn(state.stateCounts.trust, memory.trust)) {
					throw new Error("Memory index rebuild trust is invalid");
				}
				if (!Object.hasOwn(state.stateCounts.freshness, memory.freshness)) {
					throw new Error("Memory index rebuild freshness is invalid");
				}
				if (!Object.hasOwn(state.stateCounts.lifecycle, memory.lifecycle)) {
					throw new Error("Memory index rebuild lifecycle is invalid");
				}
				this.insertMemory(memory);
				state.stateCounts.trust[memory.trust] += 1;
				state.stateCounts.freshness[memory.freshness] += 1;
				state.stateCounts.lifecycle[memory.lifecycle] += 1;
			}
			for (const cue of chunk.cues) this.insertCue(cue);
			for (const edge of chunk.edges) this.insertEdge(edge);
			for (const cue of chunk.historyCues) this.insertHistoryCue(cue);
			state.counts.memoryCount += chunk.memories.length;
			state.counts.cueCount += chunk.cues.length;
			state.counts.edgeCount += chunk.edges.length;
			state.counts.historyCueCount += chunk.historyCues.length;
		} catch (error) {
			this.abortRebuild();
			throw error;
		}
	}

	finishRebuild(): void {
		const state = this.rebuildState;
		if (!state) throw new Error("Memory index rebuild is not active");
		try {
			for (const field of ["memoryCount", "cueCount", "edgeCount", "historyCueCount"] as const) {
				if (state.counts[field] !== state.plan[field]) {
					throw new Error(`Memory index rebuild ${field} does not match its plan`);
				}
			}
			this.putMetadata("head_sequence", String(state.plan.head.sequence));
			this.putMetadata("head_hash", state.plan.head.hash ?? "");
			this.putMetadata("memory_count", String(state.counts.memoryCount));
			this.putMetadata("cue_count", String(state.counts.cueCount));
			this.putMetadata("edge_count", String(state.counts.edgeCount));
			this.putMetadata("history_cue_count", String(state.counts.historyCueCount));
			for (const [dimension, counts] of Object.entries(state.stateCounts)) {
				for (const [value, count] of Object.entries(counts)) {
					this.putMetadata(`${dimension}_${value}_count`, String(count));
				}
			}
			this.database.exec("COMMIT");
			this.rebuildState = undefined;
		} catch (error) {
			this.abortRebuild();
			throw error;
		}
	}

	abortRebuild(): void {
		if (!this.rebuildState) return;
		try {
			this.database.exec("ROLLBACK");
		} finally {
			this.rebuildState = undefined;
		}
	}

	rebuild(snapshot: MemoryIndexSnapshotV1): void {
		this.beginRebuild({
			head: snapshot.head,
			memoryCount: snapshot.memories.length,
			cueCount: snapshot.cues.length,
			edgeCount: snapshot.edges.length,
			historyCueCount: snapshot.historyCues.length,
		});
		try {
			this.appendRebuildChunk({
				memories: snapshot.memories,
				cues: snapshot.cues,
				edges: snapshot.edges,
				historyCues: snapshot.historyCues,
			});
			this.finishRebuild();
		} catch (error) {
			this.abortRebuild();
			throw error;
		}
	}

	status(): MemoryIndexStatusV1 {
		const metadata = new Map(
			this.database
				.prepare("SELECT key, value FROM metadata")
				.all()
				.map((row) => {
					if (!isRecord(row)) throw new Error("Memory index metadata is invalid");
					return [requiredString(row.key, "metadata key"), metadataValue(row.value)] as const;
				}),
		);
		const count = (key: string): number => {
			const value = metadata.get(key);
			if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Memory index ${key} is missing or invalid`);
			return Number(value);
		};
		const groupedCounts = <TValue extends string>(
			column: "trust" | "freshness" | "lifecycle",
			values: readonly TValue[],
		): Record<TValue, number> => {
			return Object.fromEntries(values.map((value) => [value, count(`${column}_${value}_count`)])) as Record<
				TValue,
				number
			>;
		};
		const sequence = Number(metadata.get("head_sequence") ?? "0");
		const hash = metadata.get("head_hash") || null;
		return {
			schemaVersion: MEMORY_INDEX_SCHEMA_VERSION,
			head: { sequence, hash },
			memoryCount: count("memory_count"),
			cueCount: count("cue_count"),
			edgeCount: count("edge_count"),
			historyCueCount: count("history_cue_count"),
			stateCounts: {
				trust: groupedCounts("trust", ["verified", "model_inferred", "disputed"] as const),
				freshness: groupedCounts("freshness", ["current", "stale", "unknown"] as const),
				lifecycle: groupedCounts("lifecycle", ["active", "superseded", "invalidated", "archived"] as const),
			},
		};
	}

	integrityCheck(): "ok" | string {
		const row = this.database.prepare("PRAGMA integrity_check").get();
		if (!isRecord(row)) return "invalid integrity_check response";
		const value = Object.values(row)[0];
		return typeof value === "string" ? value : "invalid integrity_check response";
	}

	getMemory(memoryId: string): MemoryIndexMemoryV1 | undefined {
		const raw = this.database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId);
		if (raw === undefined) return undefined;
		const row = memoryRow(raw);
		return {
			memoryId: row.memory_id,
			revision: row.revision,
			artifactId: row.artifact_id,
			kind: row.kind,
			title: row.title,
			statement: row.statement,
			applicability: row.applicability,
			trust: row.trust,
			freshness: row.freshness,
			lifecycle: row.lifecycle,
			effectiveFrom: row.effective_from,
			effectiveTo: row.effective_to,
			recordedAt: row.recorded_at,
			sourceDigest: row.source_digest,
			evidenceIds: JSON.parse(row.evidence_ids) as string[],
			accessCount: row.access_count,
			lastAccessedAt: row.last_accessed_at,
		};
	}

	recordAccess(memoryIds: readonly string[], accessedAt: string, head: MemoryIndexSnapshotV1["head"]): void {
		transaction(this.database, () => {
			for (const memoryId of memoryIds) {
				const result = this.database
					.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE memory_id = ?")
					.run(accessedAt, memoryId);
				if (Number(result.changes) !== 1)
					throw new Error(`Memory index access references missing memory: ${memoryId}`);
			}
			this.putMetadata("head_sequence", String(head.sequence));
			this.putMetadata("head_hash", head.hash ?? "");
		});
	}

	private ftsRanks(
		table: "memory_fts" | "cue_fts" | "history_cue_fts",
		idColumn: string,
		query: string,
	): RankedIdRow[] {
		if ([...query.trim()].length < 3) return [];
		return this.database
			.prepare(
				`SELECT ${idColumn} AS id, bm25(${table}) AS rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ${MEMORY_CANDIDATE_POOL_LIMIT}`,
			)
			.all(ftsQuery(query))
			.map(rankedId);
	}

	private relatedMemoryIds(seedKind: "memory" | "cue", seedId: string, depth: 1 | 2): string[] {
		const found = new Set<string>();
		let frontier = [{ kind: seedKind, id: seedId }];
		const visited = new Set<string>();
		for (let level = 0; level < depth; level++) {
			const next: Array<{ kind: "memory" | "cue"; id: string }> = [];
			for (const node of frontier) {
				const nodeKey = `${node.kind}:${node.id}`;
				if (visited.has(nodeKey)) continue;
				visited.add(nodeKey);
				for (const raw of this.database
					.prepare(
						"SELECT from_kind, from_id, to_kind, to_id FROM edges WHERE (from_kind = ? AND from_id = ?) OR (to_kind = ? AND to_id = ?)",
					)
					.all(node.kind, node.id, node.kind, node.id)) {
					if (!isRecord(raw)) throw new Error("Memory index edge row is invalid");
					const fromKind = requiredString(raw.from_kind, "edge from_kind") as "memory" | "cue";
					const fromId = requiredString(raw.from_id, "edge from_id");
					const toKind = requiredString(raw.to_kind, "edge to_kind") as "memory" | "cue";
					const toId = requiredString(raw.to_id, "edge to_id");
					const other =
						fromKind === node.kind && fromId === node.id
							? { kind: toKind, id: toId }
							: { kind: fromKind, id: fromId };
					if (other.kind === "memory") found.add(other.id);
					next.push(other);
				}
			}
			frontier = next;
		}
		return [...found];
	}

	private relations(memoryId: string): MemoryIndexCandidateV1["relations"] {
		return this.database
			.prepare(
				"SELECT edge_id, from_kind, from_id, to_kind, to_id, relation FROM edges WHERE (from_kind = 'memory' AND from_id = ?) OR (to_kind = 'memory' AND to_id = ?)",
			)
			.all(memoryId, memoryId)
			.map((raw) => {
				if (!isRecord(raw)) throw new Error("Memory index relation row is invalid");
				const fromKind = requiredString(raw.from_kind, "relation from_kind") as "memory" | "cue";
				const fromId = requiredString(raw.from_id, "relation from_id");
				const toKind = requiredString(raw.to_kind, "relation to_kind") as "memory" | "cue";
				const toId = requiredString(raw.to_id, "relation to_id");
				const other =
					fromKind === "memory" && fromId === memoryId
						? { kind: toKind, id: toId }
						: { kind: fromKind, id: fromId };
				return {
					edgeId: requiredString(raw.edge_id, "relation edge_id"),
					relation: requiredString(
						raw.relation,
						"relation",
					) as MemoryIndexCandidateV1["relations"][number]["relation"],
					otherKind: other.kind,
					otherId: other.id,
				};
			});
	}

	search(input: MemoryIndexSearchInputV1): MemoryIndexSearchResultV1 {
		const query = input.query.trim();
		if (query.length === 0) throw new Error("Memory index query must not be empty");
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
			throw new Error("Memory index limit must be 1 to 50");
		const offset = input.offset ?? 0;
		if (!Number.isInteger(offset) || offset < 0 || offset > MEMORY_CANDIDATE_POOL_LIMIT)
			throw new Error(`Memory index offset must be 0 to ${MEMORY_CANDIDATE_POOL_LIMIT}`);
		const pools: string[][] = [];
		const lexical = this.ftsRanks("memory_fts", "memory_id", query).map((row) => row.id);
		if (lexical.length > 0) pools.push(lexical);
		const cueMatches = this.ftsRanks("cue_fts", "cue_id", query).map((row) => row.id);
		if (input.graphDepth > 0) {
			const graphDepth: 1 | 2 = input.graphDepth === 2 ? 2 : 1;
			const graph = new Set<string>();
			for (const memoryId of lexical) {
				for (const related of this.relatedMemoryIds("memory", memoryId, graphDepth)) graph.add(related);
			}
			for (const cueId of cueMatches) {
				for (const related of this.relatedMemoryIds("cue", cueId, graphDepth)) graph.add(related);
			}
			if (graph.size > 0) pools.push([...graph]);
		}
		if (pools.length === 0) {
			const escaped = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
			pools.push(
				this.database
					.prepare(
						`SELECT memory_id AS id FROM memories WHERE title LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' LIMIT ${MEMORY_CANDIDATE_POOL_LIMIT}`,
					)
					.all(escaped, escaped)
					.map((row) => {
						if (!isRecord(row)) throw new Error("Memory index fallback row is invalid");
						return requiredString(row.id, "fallback id");
					}),
			);
		}
		const scores = new Map<string, number>();
		for (const pool of pools) {
			pool.forEach((memoryId, index) => {
				scores.set(memoryId, (scores.get(memoryId) ?? 0) + 1 / (60 + index + 1));
			});
		}
		const rankedScores = [...scores.entries()]
			.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
			.slice(0, MEMORY_CANDIDATE_POOL_LIMIT);
		const now = Date.now();
		const candidates: MemoryIndexCandidateV1[] = [];
		for (const [memoryId, baseScore] of rankedScores) {
			const raw = this.database.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId);
			if (raw === undefined) continue;
			const row = memoryRow(raw);
			if (row.lifecycle !== "active") continue;
			if (input.kinds && !input.kinds.includes(row.kind)) continue;
			const asOf = milliseconds(input.asOf ?? new Date().toISOString());
			if (
				asOf === null ||
				asOf < Date.parse(row.effective_from) ||
				(row.effective_to !== null && asOf >= Date.parse(row.effective_to))
			)
				continue;
			const lastAccessed = milliseconds(row.last_accessed_at);
			const decay =
				lastAccessed === null ? 0 : Math.exp(-(Math.max(0, now - lastAccessed) / (30 * 24 * 60 * 60 * 1000)));
			const heatBoost = Math.min(0.1, Math.log1p(row.access_count) / 20) * decay;
			const trustBoost = row.trust === "verified" ? 0.05 : row.trust === "disputed" ? -0.05 : 0;
			const freshnessBoost = row.freshness === "current" ? 0.03 : row.freshness === "stale" ? -0.03 : 0;
			candidates.push({
				memoryId: row.memory_id,
				revision: row.revision,
				artifactId: row.artifact_id,
				kind: row.kind,
				title: row.title,
				state: { trust: row.trust, freshness: row.freshness, lifecycle: row.lifecycle },
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				recordedAt: row.recorded_at,
				relations: this.relations(row.memory_id),
				score: baseScore * (1 + heatBoost + trustBoost + freshnessBoost),
			});
		}
		candidates.sort((left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId));

		const historyCues: MemoryHistoryCueCandidateV1[] = [];
		if (input.includeHistoryCues) {
			for (const [index, match] of this.ftsRanks("history_cue_fts", "cue_id", query).entries()) {
				const raw = this.database.prepare("SELECT * FROM history_cues WHERE cue_id = ?").get(match.id);
				if (!isRecord(raw)) continue;
				historyCues.push({
					cueId: requiredString(raw.cue_id, "history cue_id"),
					sourceType: requiredString(
						raw.source_type,
						"history source_type",
					) as MemoryIndexHistoryCueV1["sourceType"],
					sourceId: requiredString(raw.source_id, "history source_id"),
					title: requiredString(raw.title, "history title"),
					recordedAt: requiredString(raw.recorded_at, "history recorded_at"),
					chainId: requiredString(raw.chain_id, "history chain_id"),
					branchId: requiredString(raw.branch_id, "history branch_id"),
					segmentId: requiredString(raw.segment_id, "history segment_id"),
					ordinal: requiredNumber(raw.ordinal, "history ordinal"),
					sessionId: nullableString(raw.session_id, "history session_id"),
					score: 1 / (60 + index + 1),
				});
			}
		}
		return {
			memories: candidates.slice(offset, offset + input.limit),
			historyCues: historyCues.slice(offset, offset + input.limit),
		};
	}
}
