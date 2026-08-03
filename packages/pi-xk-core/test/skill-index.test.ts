import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { type SkillIndexSnapshotV1, SkillIndexWorkerClient } from "../src/index.ts";
import { SkillSqliteProjection } from "../src/skill-index-database.ts";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(): SkillIndexSnapshotV1 {
	return {
		head: { sequence: 4, hash: digest("a") },
		skills: [
			{
				skillId: "skill_release-audit",
				revision: 2,
				artifactId: digest("b"),
				bundleArtifactId: digest("c"),
				scope: "project",
				lifecycle: "active",
				name: "release-audit",
				description: "Audit an isolated release artifact.",
				applicability: "Use for Node and Bun release smoke checks.",
				divergenceConditions: ["No release artifact exists."],
				stale: false,
				needsReview: false,
				successfulUses: 3,
				failedUses: 0,
				recordedAt: "2026-08-03T00:00:00.000Z",
				sourceDigest: digest("d"),
			},
		],
		candidates: [
			{
				candidateId: "candidate_memory-review",
				skillId: "skill_memory-review",
				targetScope: "global",
				expectedRevision: null,
				name: "memory-review",
				description: "Review retrieved project Memory.",
				applicability: "Use after D2 Memory retrieval.",
				divergenceConditions: ["No project history was read."],
				status: "pending",
				sourceDigest: digest("e"),
			},
		],
	};
}

describe("Skill index", () => {
	it("searches active Skills and pending candidates without returning bundle bodies", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new SkillSqliteProjection(database);
		projection.rebuild(snapshot());

		const active = projection.search({ query: "release smoke", includeCandidates: false, limit: 10 });
		expect(active.skills.map((skill) => skill.skillId)).toEqual(["skill_release-audit"]);
		expect(active.candidates).toEqual([]);
		expect(active.skills[0]).not.toHaveProperty("instructions");

		const candidates = projection.search({ query: "Memory retrieval", includeCandidates: true, limit: 10 });
		expect(candidates.candidates.map((candidate) => candidate.candidateId)).toEqual(["candidate_memory-review"]);
		database.close();
	});

	it("applies an incremental delta only at the expected fact head", () => {
		const database = new DatabaseSync(":memory:");
		const projection = new SkillSqliteProjection(database);
		projection.rebuild(snapshot());
		const replacement = {
			...snapshot().skills[0]!,
			revision: 3,
			description: "Audit release binaries and packages.",
		};
		projection.applyDelta({
			expectedHead: snapshot().head,
			head: { sequence: 5, hash: digest("f") },
			skills: [replacement],
			candidates: [],
			removeSkillIds: [],
			removeCandidateIds: ["candidate_memory-review"],
		});

		expect(projection.status()).toMatchObject({
			head: { sequence: 5, hash: digest("f") },
			skillCount: 1,
			candidateCount: 0,
		});
		expect(() =>
			projection.applyDelta({
				expectedHead: snapshot().head,
				head: { sequence: 6, hash: digest("1") },
				skills: [],
				candidates: [],
				removeSkillIds: [],
				removeCandidateIds: [],
			}),
		).toThrow("head");
		database.close();
	});

	it("persists equivalent FTS state through the Node worker", async () => {
		const root = await mkdtemp(join("/tmp", "pi-xk-skill-index-"));
		roots.push(root);
		const client = new SkillIndexWorkerClient({
			databasePath: join(root, "index.sqlite"),
			nodeWorkerUrl: new URL("../src/skill-index-node-worker.ts", import.meta.url),
		});
		await client.rebuild(snapshot());
		expect((await client.search({ query: "release", includeCandidates: true, limit: 10 })).skills).toHaveLength(1);
		expect(await client.integrityCheck()).toBe("ok");
		await client.close();
	});
});
