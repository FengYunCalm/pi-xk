import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SkillSqliteProjection } from "../packages/pi-xk-core/src/skill-index-database.ts";

const DEFAULT_COUNTS = [100, 1_000, 10_000];
const DEFAULT_RUNS = 20;
const RELOAD_SKILL_COUNT = 100;
const scriptPath = fileURLToPath(import.meta.url);

function positiveInteger(value, field) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

function parseArguments(argv) {
	const options = { counts: DEFAULT_COUNTS, runs: DEFAULT_RUNS, json: false, measureIndex: null, measureReload: null };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--counts") {
			const raw = argv[++index];
			if (!raw) throw new Error("--counts requires a comma-separated list");
			options.counts = raw.split(",").map((value) => positiveInteger(value, "Skill count"));
			continue;
		}
		if (argument === "--runs") {
			options.runs = positiveInteger(argv[++index] ?? "", "runs");
			continue;
		}
		if (argument === "--measure-index") {
			options.measureIndex = {
				skillCount: positiveInteger(argv[++index] ?? "", "measure Skill count"),
				runs: positiveInteger(argv[++index] ?? "", "measure runs"),
			};
			continue;
		}
		if (argument === "--measure-reload") {
			options.measureReload = {
				skillCount: positiveInteger(argv[++index] ?? "", "reload Skill count"),
				runs: positiveInteger(argv[++index] ?? "", "reload runs"),
			};
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return options;
}

function percentile95(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function digest(index, salt) {
	return `sha256:${(BigInt(index) + BigInt(salt)).toString(16).padStart(64, "0").slice(-64)}`;
}

function skillId(index) {
	return `skill_${String(index).padStart(6, "0")}`;
}

function skillRecord(index, skillCount) {
	return {
		skillId: skillId(index),
		revision: 1,
		artifactId: digest(index, 1),
		bundleArtifactId: digest(index, skillCount + 1),
		scope: "project",
		lifecycle: "active",
		name: `benchmark-skill-${index}`,
		description: `Reusable benchmark workflow target${index}.`,
		applicability: `Synthetic project workflow group ${index % 100}.`,
		divergenceConditions: [`The target${index} workflow is unavailable.`],
		stale: false,
		needsReview: false,
		successfulUses: index % 5,
		failedUses: 0,
		recordedAt: "2026-08-03T00:00:00.000Z",
		sourceDigest: digest(index, skillCount * 2 + 1),
	};
}

function candidateRecord(index, skillCount) {
	return {
		candidateId: `candidate_${String(index).padStart(6, "0")}`,
		skillId: `candidate-skill-${String(index).padStart(6, "0")}`,
		targetScope: "global",
		expectedRevision: null,
		name: `candidate-workflow-${index}`,
		description: `Cross-project candidate target-candidate-${index}.`,
		applicability: `Synthetic candidate group ${index % 100}.`,
		divergenceConditions: ["Repository evidence is unavailable."],
		status: "pending",
		sourceDigest: digest(index, skillCount * 3 + 1),
	};
}

function measureSync(runs, operation) {
	const timings = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		operation();
		timings.push(performance.now() - startedAt);
	}
	return percentile95(timings);
}

async function measureAsync(runs, operation) {
	const timings = [];
	for (let run = 0; run < runs; run += 1) {
		const startedAt = performance.now();
		await operation();
		timings.push(performance.now() - startedAt);
	}
	return percentile95(timings);
}

function measureIndex({ skillCount, runs }) {
	const database = new DatabaseSync(":memory:");
	const projection = new SkillSqliteProjection(database);
	try {
		const candidateCount = Math.max(1, Math.floor(skillCount / 4));
		const startedAt = performance.now();
		projection.rebuild({
			head: { sequence: skillCount + candidateCount, hash: digest(skillCount, candidateCount) },
			skills: Array.from({ length: skillCount }, (_, index) => skillRecord(index, skillCount)),
			candidates: Array.from({ length: candidateCount }, (_, index) => candidateRecord(index, skillCount)),
		});
		const rebuildMs = performance.now() - startedAt;
		const target = Math.floor(skillCount / 2);
		const statusP95Ms = measureSync(runs, () => projection.status());
		const d1P95Ms = measureSync(runs, () =>
			projection.search({ query: `target${target}`, includeCandidates: true, limit: 12 }),
		);
		const candidateD1P95Ms = measureSync(runs, () =>
			projection.search({
				query: `target-candidate-${Math.floor(candidateCount / 2)}`,
				includeCandidates: true,
				limit: 12,
			}),
		);
		return { skillCount, candidateCount, rebuildMs, statusP95Ms, d1P95Ms, candidateD1P95Ms };
	} finally {
		database.close();
	}
}

async function measureReload({ skillCount, runs }) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-skill-reload-benchmark-"),
	);
	try {
		const skillsRoot = join(root, "managed-skills");
		await Promise.all(
			Array.from({ length: skillCount }, async (_, index) => {
				const name = `benchmark-skill-${String(index).padStart(3, "0")}`;
				const directory = join(skillsRoot, name);
				await mkdir(directory, { recursive: true });
				await writeFile(
					join(directory, "SKILL.md"),
					[
						"---",
						`name: ${name}`,
						`description: Reload benchmark Skill ${index}.`,
						"---",
						"",
						"# Benchmark workflow",
						"",
						"Apply and validate the deterministic benchmark workflow.",
						"",
					].join("\n"),
					"utf8",
				);
			}),
		);
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			additionalSkillPaths: [skillsRoot],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const reloadP95Ms = await measureAsync(runs, async () => await loader.reloadSkills());
		return { skillCount, reloadP95Ms, loadedSkills: loader.getSkills().skills.length };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function runChild(argumentsList) {
	const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", scriptPath, ...argumentsList], {
		cwd: resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `Skill benchmark child exited ${result.status}`);
	return JSON.parse(result.stdout);
}

function markdown(indexResults, reloadResult, environment) {
	return [
		"Pi-XK Skill benchmark",
		`Environment: ${environment.platform} ${environment.release} · Node ${environment.node}`,
		"",
		"| Skills | Candidates | Rebuild | Status p95 | Skill D1 p95 | Candidate D1 p95 |",
		"| ---: | ---: | ---: | ---: | ---: | ---: |",
		...indexResults.map(
			(result) =>
				`| ${result.skillCount.toLocaleString("en-US")} | ${result.candidateCount.toLocaleString("en-US")} | ${Math.round(result.rebuildMs)} ms | ${result.statusP95Ms.toFixed(3)} ms | ${result.d1P95Ms.toFixed(3)} ms | ${result.candidateD1P95Ms.toFixed(3)} ms |`,
		),
		"",
		`100-Skill resource-only reload p95: ${reloadResult.reloadP95Ms.toFixed(3)} ms (${reloadResult.loadedSkills} loaded)`,
	].join("\n");
}

const options = parseArguments(process.argv.slice(2));
if (options.measureIndex) {
	process.stdout.write(JSON.stringify(measureIndex(options.measureIndex)));
	process.exit(0);
}
if (options.measureReload) {
	process.stdout.write(JSON.stringify(await measureReload(options.measureReload)));
	process.exit(0);
}

const indexResults = options.counts.map((count) =>
	runChild(["--measure-index", String(count), String(options.runs)]),
);
const reloadResult = runChild(["--measure-reload", String(RELOAD_SKILL_COUNT), String(options.runs)]);
const failures = indexResults.flatMap((result) => [
	...(result.d1P95Ms >= 100 ? [`${result.skillCount}: Skill D1 p95 ${result.d1P95Ms.toFixed(3)} ms`] : []),
	...(result.candidateD1P95Ms >= 100
		? [`${result.skillCount}: candidate D1 p95 ${result.candidateD1P95Ms.toFixed(3)} ms`]
		: []),
]);
if (reloadResult.loadedSkills !== RELOAD_SKILL_COUNT) {
	failures.push(`resource reload loaded ${reloadResult.loadedSkills}/${RELOAD_SKILL_COUNT} Skills`);
}
if (reloadResult.reloadP95Ms >= 50) failures.push(`resource reload p95 ${reloadResult.reloadP95Ms.toFixed(3)} ms`);
const environment = { platform: process.platform, release: release(), node: process.version };
process.stdout.write(
	options.json
		? `${JSON.stringify({ environment, indexResults, reloadResult, failures }, null, 2)}\n`
		: `${markdown(indexResults, reloadResult, environment)}${failures.length > 0 ? `\n\nFailures:\n${failures.join("\n")}` : ""}\n`,
);
if (failures.length > 0) process.exitCode = 1;
