import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemorySqliteProjection } from "../packages/pi-xk-core/src/memory-index-database.ts";

const FIXTURE_SCHEMA = "pi-xk.memory-golden.v1";

function digest(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertFixture(fixture) {
	if (
		fixture?.schema !== FIXTURE_SCHEMA ||
		!Array.isArray(fixture.memories) ||
		fixture.memories.length === 0 ||
		!Array.isArray(fixture.edges) ||
		!Array.isArray(fixture.queries) ||
		fixture.queries.length === 0
	) {
		throw new Error("unsupported or incomplete Pi-XK Memory golden fixture");
	}
	const memoryIds = fixture.memories.map((memory) => memory.memoryId);
	if (memoryIds.some((memoryId) => typeof memoryId !== "string") || new Set(memoryIds).size !== memoryIds.length) {
		throw new Error("Memory golden fixture IDs must be unique strings");
	}
}

function snapshotFor(fixture) {
	return {
		head: { sequence: 1, hash: digest("memory-golden-head") },
		memories: fixture.memories.map((memory) => ({
			memoryId: memory.memoryId,
			revision: 1,
			artifactId: digest(`artifact:${memory.memoryId}`),
			kind: memory.kind,
			title: memory.title,
			statement: memory.statement,
			applicability: "Pi-XK project",
			trust: memory.trust,
			freshness: memory.freshness,
			lifecycle: memory.lifecycle,
			effectiveFrom: "2026-01-01T00:00:00.000Z",
			effectiveTo: null,
			recordedAt: "2026-08-01T00:00:00.000Z",
			sourceDigest: digest(`source:${memory.memoryId}`),
			evidenceIds: [`evidence_${memory.memoryId}`],
			accessCount: 0,
			lastAccessedAt: null,
		})),
		cues: [],
		edges: fixture.edges.map((edge) => ({
			edgeId: edge.edgeId,
			artifactId: digest(`artifact:${edge.edgeId}`),
			fromKind: "memory",
			fromId: edge.from,
			toKind: "memory",
			toId: edge.to,
			relation: edge.relation,
			effectiveFrom: "2026-01-01T00:00:00.000Z",
			effectiveTo: null,
		})),
		historyCues: [],
	};
}

export function evaluateMemoryFixture(fixture) {
	assertFixture(fixture);
	const database = new DatabaseSync(":memory:");
	const projection = new MemorySqliteProjection(database);
	try {
		projection.rebuild(snapshotFor(fixture));
		const findings = [];
		let expectedFacts = 0;
		let recalledFacts = 0;
		for (const query of fixture.queries) {
			const results = projection.search({ query: query.query, limit: 12, graphDepth: 1 }).memories;
			const topFive = new Set(results.slice(0, 5).map((memory) => memory.memoryId));
			const topResult = results[0]?.memoryId;
			for (const memoryId of query.expected) {
				expectedFacts += 1;
				if (topFive.has(memoryId)) recalledFacts += 1;
				else findings.push({ category: "omission", query: query.query, memoryId });
			}
			for (const memoryId of query.forbidden) {
				if (topResult === memoryId) findings.push({ category: "irrelevant_recall", query: query.query, memoryId });
			}
		}

		const unsupportedVerified = fixture.memories.filter(
			(memory) => memory.trust === "verified" && memory.evidenceSupported !== true,
		);
		for (const memory of unsupportedVerified) {
			findings.push({ category: "unsupported_verified", memoryId: memory.memoryId });
		}
		let silentConflictMerges = 0;
		const groups = new Map();
		for (const memory of fixture.memories) {
			if (!memory.conflictGroup) continue;
			const group = groups.get(memory.conflictGroup) ?? [];
			group.push(memory);
			groups.set(memory.conflictGroup, group);
		}
		for (const [groupId, memories] of groups) {
			if (memories.length < 2) continue;
			const ids = new Set(memories.map((memory) => memory.memoryId));
			const hasContradiction = fixture.edges.some(
				(edge) => edge.relation === "contradicts" && ids.has(edge.from) && ids.has(edge.to),
			);
			if (!hasContradiction || memories.some((memory) => memory.trust !== "disputed")) {
				silentConflictMerges += 1;
				findings.push({ category: "silent_conflict_merge", groupId });
			}
		}
		const recall = expectedFacts === 0 ? 1 : recalledFacts / expectedFacts;
		return {
			schema: fixture.schema,
			memories: fixture.memories.length,
			queries: fixture.queries.length,
			expectedFacts,
			recalledFacts,
			criticalFactRecall: recall,
			unsupportedVerified: unsupportedVerified.length,
			silentConflictMerges,
			findings,
		};
	} finally {
		database.close();
	}
}

async function main() {
	const fixturePath = process.argv[2];
	if (!fixturePath) {
		throw new Error("usage: node --import tsx scripts/evaluate-pi-xk-memory.mjs <fixture.json>");
	}
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
	const report = evaluateMemoryFixture(fixture);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.criticalFactRecall < 0.95 || report.unsupportedVerified !== 0 || report.silentConflictMerges !== 0) {
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
