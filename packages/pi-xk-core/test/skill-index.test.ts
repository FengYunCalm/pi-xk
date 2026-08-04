import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type SkillIndexSnapshotV1, SkillIndexWorkerClient } from "../src/index.ts";
import { SkillSqliteProjection } from "../src/skill-index-database.ts";

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const execFile = promisify(execFileCallback);
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

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
		const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-index-"));
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

	it.skipIf(!bunAvailable)(
		"checkpoints the Bun Skill worker WAL before a rebuilt index file is moved",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-index-bun-move-"));
			roots.push(root);
			const inputPath = join(root, "snapshot.json");
			const temporaryPath = join(root, "temporary.sqlite");
			const finalPath = join(root, "index.sqlite");
			await writeFile(inputPath, `${JSON.stringify(snapshot())}\n`);
			const moduleUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
			const script = [
				'import { readFileSync, renameSync, rmSync } from "node:fs";',
				`import { SkillIndexWorkerClient } from ${JSON.stringify(moduleUrl)};`,
				`const snapshot = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));`,
				`const temporaryPath = ${JSON.stringify(temporaryPath)};`,
				`const finalPath = ${JSON.stringify(finalPath)};`,
				"const builder = new SkillIndexWorkerClient({ databasePath: temporaryPath });",
				"await builder.rebuild(snapshot);",
				"await builder.close();",
				"renameSync(temporaryPath, finalPath);",
				'for (const suffix of ["-wal", "-shm"]) rmSync(temporaryPath + suffix, { force: true });',
				"const reopened = new SkillIndexWorkerClient({ databasePath: finalPath });",
				"const result = {",
				"  status: await reopened.status(),",
				'  skillIds: (await reopened.search({ query: "release", includeCandidates: true, limit: 10 })).skills.map((skill) => skill.skillId),',
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
				status: expect.objectContaining({ head: snapshot().head, skillCount: 1, candidateCount: 1 }),
				skillIds: ["skill_release-audit"],
				integrity: "ok",
			});
		},
		15_000,
	);

	it.skipIf(!bunAvailable)(
		"produces equivalent Node and Bun Skill FTS projection results",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-xk-skill-index-runtime-equivalence-"));
			roots.push(root);
			const inputPath = join(root, "snapshot.json");
			await writeFile(inputPath, `${JSON.stringify(snapshot())}\n`);
			const nodeDatabase = new DatabaseSync(":memory:");
			const nodeProjection = new SkillSqliteProjection(nodeDatabase);
			nodeProjection.rebuild(snapshot());
			const nodeResult = {
				status: nodeProjection.status(),
				skillIds: nodeProjection
					.search({ query: "release smoke", includeCandidates: true, limit: 10 })
					.skills.map((skill) => skill.skillId),
				candidateIds: nodeProjection
					.search({ query: "Memory retrieval", includeCandidates: true, limit: 10 })
					.candidates.map((candidate) => candidate.candidateId),
			};
			nodeDatabase.close();

			const moduleUrl = pathToFileURL(join(process.cwd(), "src", "skill-index-database.ts")).href;
			const script = [
				'import { readFileSync } from "node:fs";',
				'import { Database } from "bun:sqlite";',
				`import { SkillSqliteProjection } from ${JSON.stringify(moduleUrl)};`,
				`const snapshot = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, "utf8"));`,
				'const database = new Database(":memory:", { strict: true });',
				"const projection = new SkillSqliteProjection(database);",
				"projection.rebuild(snapshot);",
				"const result = {",
				"  status: projection.status(),",
				'  skillIds: projection.search({ query: "release smoke", includeCandidates: true, limit: 10 }).skills.map((skill) => skill.skillId),',
				'  candidateIds: projection.search({ query: "Memory retrieval", includeCandidates: true, limit: 10 }).candidates.map((candidate) => candidate.candidateId),',
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
		},
		15_000,
	);
});
