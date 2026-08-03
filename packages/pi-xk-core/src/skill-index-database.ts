import type { SqliteDatabasePort } from "./memory-index-database.ts";
import {
	SKILL_INDEX_SCHEMA_VERSION,
	type SkillIndexCandidateV1,
	type SkillIndexDeltaV1,
	type SkillIndexSearchInputV1,
	type SkillIndexSearchResultV1,
	type SkillIndexSkillV1,
	type SkillIndexSnapshotV1,
	type SkillIndexStatusV1,
} from "./skill-index.ts";
import type { SkillHead } from "./skill-store.ts";

interface RankedRow {
	id: string;
	rank: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Skill index ${field} is invalid`);
	return value;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Skill index ${field} is invalid`);
	return value;
}

function rankedRow(value: unknown): RankedRow {
	if (!isRecord(value)) throw new Error("Skill index ranked row is invalid");
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
	return [...query.matchAll(/[\p{L}\p{N}_]+/gu)]
		.map((match) => match[0])
		.filter((token, index, all) => all.indexOf(token) === index)
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" OR ");
}

function assertHead(head: SkillHead, field: string): void {
	if (!Number.isInteger(head.sequence) || head.sequence < 0 || (head.sequence === 0) !== (head.hash === null)) {
		throw new Error(`Skill index ${field} is invalid`);
	}
	if (head.hash !== null && !/^sha256:[a-f0-9]{64}$/u.test(head.hash)) {
		throw new Error(`Skill index ${field} is invalid`);
	}
}

export class SkillSqliteProjection {
	private readonly database: SqliteDatabasePort;

	constructor(database: SqliteDatabasePort) {
		this.database = database;
		this.initialize();
	}

	private initialize(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS skill_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS skill_records (
				skill_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL,
				artifact_id TEXT NOT NULL,
				bundle_artifact_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				lifecycle TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL,
				applicability TEXT NOT NULL,
				divergence_conditions TEXT NOT NULL,
				stale INTEGER NOT NULL,
				needs_review INTEGER NOT NULL,
				successful_uses INTEGER NOT NULL,
				failed_uses INTEGER NOT NULL,
				recorded_at TEXT NOT NULL,
				source_digest TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS skill_candidates (
				candidate_id TEXT PRIMARY KEY,
				skill_id TEXT NOT NULL,
				target_scope TEXT NOT NULL,
				expected_revision INTEGER,
				name TEXT NOT NULL,
				description TEXT NOT NULL,
				applicability TEXT NOT NULL,
				divergence_conditions TEXT NOT NULL,
				status TEXT NOT NULL,
				source_digest TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(skill_id UNINDEXED, name, description, applicability, divergence_conditions);
			CREATE VIRTUAL TABLE IF NOT EXISTS skill_candidate_fts USING fts5(candidate_id UNINDEXED, name, description, applicability, divergence_conditions);
		`);
		const schema = this.database.prepare("SELECT value FROM skill_index_meta WHERE key = 'schema_version'").get();
		if (!schema) {
			this.database
				.prepare(
					"INSERT INTO skill_index_meta(key, value) VALUES ('schema_version', ?), ('head_sequence', '0'), ('head_hash', '')",
				)
				.run(String(SKILL_INDEX_SCHEMA_VERSION));
		} else if (!isRecord(schema) || schema.value !== String(SKILL_INDEX_SCHEMA_VERSION)) {
			throw new Error("Skill index schema version is unsupported");
		}
	}

	private head(): SkillHead {
		const rows = this.database
			.prepare("SELECT key, value FROM skill_index_meta WHERE key IN ('head_sequence', 'head_hash')")
			.all();
		const values = new Map(
			rows.map((row) => {
				if (!isRecord(row)) throw new Error("Skill index metadata row is invalid");
				return [requiredString(row.key, "metadata key"), typeof row.value === "string" ? row.value : ""];
			}),
		);
		const sequence = Number.parseInt(values.get("head_sequence") ?? "0", 10);
		const hash = values.get("head_hash") || null;
		const head = { sequence, hash };
		assertHead(head, "head");
		return head;
	}

	private writeHead(head: SkillHead): void {
		assertHead(head, "head");
		this.database
			.prepare("UPDATE skill_index_meta SET value = ? WHERE key = 'head_sequence'")
			.run(String(head.sequence));
		this.database.prepare("UPDATE skill_index_meta SET value = ? WHERE key = 'head_hash'").run(head.hash ?? "");
	}

	private upsertSkill(skill: SkillIndexSkillV1): void {
		this.database
			.prepare(`INSERT OR REPLACE INTO skill_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				skill.skillId,
				skill.revision,
				skill.artifactId,
				skill.bundleArtifactId,
				skill.scope,
				skill.lifecycle,
				skill.name,
				skill.description,
				skill.applicability,
				JSON.stringify(skill.divergenceConditions),
				skill.stale ? 1 : 0,
				skill.needsReview ? 1 : 0,
				skill.successfulUses,
				skill.failedUses,
				skill.recordedAt,
				skill.sourceDigest,
			);
		this.database.prepare("DELETE FROM skill_fts WHERE skill_id = ?").run(skill.skillId);
		this.database
			.prepare("INSERT INTO skill_fts VALUES (?, ?, ?, ?, ?)")
			.run(skill.skillId, skill.name, skill.description, skill.applicability, skill.divergenceConditions.join(" "));
	}

	private upsertCandidate(candidate: SkillIndexCandidateV1): void {
		this.database
			.prepare("INSERT OR REPLACE INTO skill_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(
				candidate.candidateId,
				candidate.skillId,
				candidate.targetScope,
				candidate.expectedRevision,
				candidate.name,
				candidate.description,
				candidate.applicability,
				JSON.stringify(candidate.divergenceConditions),
				candidate.status,
				candidate.sourceDigest,
			);
		this.database.prepare("DELETE FROM skill_candidate_fts WHERE candidate_id = ?").run(candidate.candidateId);
		this.database
			.prepare("INSERT INTO skill_candidate_fts VALUES (?, ?, ?, ?, ?)")
			.run(
				candidate.candidateId,
				candidate.name,
				candidate.description,
				candidate.applicability,
				candidate.divergenceConditions.join(" "),
			);
	}

	rebuild(snapshot: SkillIndexSnapshotV1): void {
		assertHead(snapshot.head, "rebuild head");
		transaction(this.database, () => {
			this.database.exec(
				"DELETE FROM skill_fts; DELETE FROM skill_candidate_fts; DELETE FROM skill_records; DELETE FROM skill_candidates;",
			);
			for (const skill of snapshot.skills) this.upsertSkill(skill);
			for (const candidate of snapshot.candidates) this.upsertCandidate(candidate);
			this.writeHead(snapshot.head);
		});
	}

	applyDelta(delta: SkillIndexDeltaV1): void {
		assertHead(delta.expectedHead, "expected head");
		assertHead(delta.head, "delta head");
		const current = this.head();
		if (current.sequence !== delta.expectedHead.sequence || current.hash !== delta.expectedHead.hash) {
			throw new Error("Skill index head conflict");
		}
		transaction(this.database, () => {
			for (const skillId of delta.removeSkillIds) {
				this.database.prepare("DELETE FROM skill_records WHERE skill_id = ?").run(skillId);
				this.database.prepare("DELETE FROM skill_fts WHERE skill_id = ?").run(skillId);
			}
			for (const candidateId of delta.removeCandidateIds) {
				this.database.prepare("DELETE FROM skill_candidates WHERE candidate_id = ?").run(candidateId);
				this.database.prepare("DELETE FROM skill_candidate_fts WHERE candidate_id = ?").run(candidateId);
			}
			for (const skill of delta.skills) this.upsertSkill(skill);
			for (const candidate of delta.candidates) this.upsertCandidate(candidate);
			this.writeHead(delta.head);
		});
	}

	search(input: SkillIndexSearchInputV1): SkillIndexSearchResultV1 {
		const limit = Math.max(1, Math.min(50, input.limit));
		const offset = Math.max(0, input.offset ?? 0);
		const query = ftsQuery(input.query);
		if (!query) return { skills: [], candidates: [], hasMore: false };
		const skillRanks = this.database
			.prepare(
				"SELECT skill_id AS id, bm25(skill_fts) AS rank FROM skill_fts WHERE skill_fts MATCH ? ORDER BY rank LIMIT 201",
			)
			.all(query)
			.map(rankedRow);
		const candidateRanks = input.includeCandidates
			? this.database
					.prepare(
						"SELECT candidate_id AS id, bm25(skill_candidate_fts) AS rank FROM skill_candidate_fts WHERE skill_candidate_fts MATCH ? ORDER BY rank LIMIT 201",
					)
					.all(query)
					.map(rankedRow)
			: [];
		const combined = [
			...skillRanks.map((entry) => ({ kind: "skill" as const, ...entry })),
			...candidateRanks.map((entry) => ({ kind: "candidate" as const, ...entry })),
		].sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
		const selected = combined.slice(offset, offset + limit);
		const skills = selected
			.filter((entry) => entry.kind === "skill")
			.map((entry) => {
				const row = this.database.prepare("SELECT * FROM skill_records WHERE skill_id = ?").get(entry.id);
				if (!isRecord(row)) throw new Error("Skill index record is missing");
				return {
					skillId: requiredString(row.skill_id, "skill_id"),
					revision: requiredNumber(row.revision, "revision"),
					scope: requiredString(row.scope, "scope") as SkillIndexSkillV1["scope"],
					lifecycle: requiredString(row.lifecycle, "lifecycle") as SkillIndexSkillV1["lifecycle"],
					name: requiredString(row.name, "name"),
					description: requiredString(row.description, "description"),
					applicability: requiredString(row.applicability, "applicability"),
					divergenceConditions: JSON.parse(
						requiredString(row.divergence_conditions, "divergence_conditions"),
					) as string[],
					stale: requiredNumber(row.stale, "stale") === 1,
					needsReview: requiredNumber(row.needs_review, "needs_review") === 1,
					score: -entry.rank,
				};
			});
		const candidates = selected
			.filter((entry) => entry.kind === "candidate")
			.map((entry) => {
				const row = this.database.prepare("SELECT * FROM skill_candidates WHERE candidate_id = ?").get(entry.id);
				if (!isRecord(row)) throw new Error("Skill candidate index record is missing");
				return {
					candidateId: requiredString(row.candidate_id, "candidate_id"),
					skillId: requiredString(row.skill_id, "skill_id"),
					targetScope: requiredString(row.target_scope, "target_scope") as SkillIndexCandidateV1["targetScope"],
					expectedRevision:
						row.expected_revision === null ? null : requiredNumber(row.expected_revision, "expected_revision"),
					name: requiredString(row.name, "name"),
					description: requiredString(row.description, "description"),
					applicability: requiredString(row.applicability, "applicability"),
					divergenceConditions: JSON.parse(
						requiredString(row.divergence_conditions, "divergence_conditions"),
					) as string[],
					status: requiredString(row.status, "status") as SkillIndexCandidateV1["status"],
					score: -entry.rank,
				};
			});
		return { skills, candidates, hasMore: combined.length > offset + limit };
	}

	status(): SkillIndexStatusV1 {
		const counts = this.database
			.prepare(
				`SELECT COUNT(*) AS total,
				SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active,
				SUM(stale) AS stale,
				SUM(needs_review) AS needs_review FROM skill_records`,
			)
			.get();
		const candidates = this.database
			.prepare("SELECT COUNT(*) AS total FROM skill_candidates WHERE status = 'pending'")
			.get();
		if (!isRecord(counts) || !isRecord(candidates)) throw new Error("Skill index status is invalid");
		return {
			schemaVersion: 1,
			head: this.head(),
			skillCount: requiredNumber(counts.total, "skill count"),
			candidateCount: requiredNumber(candidates.total, "candidate count"),
			activeCount: requiredNumber(counts.active ?? 0, "active count"),
			staleCount: requiredNumber(counts.stale ?? 0, "stale count"),
			needsReviewCount: requiredNumber(counts.needs_review ?? 0, "needs review count"),
		};
	}

	integrityCheck(): "ok" | string {
		const row = this.database.prepare("PRAGMA integrity_check").get();
		if (!isRecord(row)) return "invalid integrity result";
		const value = Object.values(row)[0];
		return value === "ok" ? "ok" : String(value);
	}
}
