import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { MemorySqliteProjection } from "../packages/pi-xk-core/src/memory-index-database.ts";

const DEFAULT_COUNTS = [100, 1_000, 10_000, 100_000];
const DEFAULT_RUNS = 20;
const MAX_EDGES = 500_000;
const MEMORY_CHUNK_SIZE = 512;
const EDGE_CHUNK_SIZE = 4_096;
const scriptPath = fileURLToPath(import.meta.url);

function positiveInteger(value, field) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

function nonNegativeNumber(value, field) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || value.trim().length === 0) {
		throw new Error(`${field} must be a non-negative number`);
	}
	return parsed;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
	const options = {
		counts: DEFAULT_COUNTS,
		runs: DEFAULT_RUNS,
		json: false,
		measure: null,
		baselinePath: null,
		maxRegressionPercent: 15,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--counts") {
			const raw = argv[++index];
			if (!raw) throw new Error("--counts requires a comma-separated list");
			options.counts = raw.split(",").map((value) => positiveInteger(value, "memory count"));
			continue;
		}
		if (argument === "--runs") {
			const raw = argv[++index];
			if (!raw) throw new Error("--runs requires a value");
			options.runs = positiveInteger(raw, "runs");
			continue;
		}
		if (argument === "--measure") {
			const memoryCount = positiveInteger(argv[++index] ?? "", "measure memory count");
			const edgeCount = positiveInteger(argv[++index] ?? "", "measure edge count");
			const runs = positiveInteger(argv[++index] ?? "", "measure runs");
			options.measure = { memoryCount, edgeCount, runs };
			continue;
		}
		if (argument === "--baseline") {
			const path = argv[++index];
			if (!path) throw new Error("--baseline requires a JSON result path");
			options.baselinePath = resolve(path);
			continue;
		}
		if (argument === "--max-regression-percent") {
			options.maxRegressionPercent = nonNegativeNumber(
				argv[++index] ?? "",
				"max regression percent",
			);
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

function hexId(index, salt) {
	return `sha256:${(BigInt(index) + BigInt(salt)).toString(16).padStart(64, "0").slice(-64)}`;
}

function memoryId(index) {
	return `memory_${String(index).padStart(6, "0")}`;
}

function createMemory(index, memoryCount) {
	return {
		memoryId: memoryId(index),
		revision: 1,
		artifactId: hexId(index, 1),
		kind: index % 7 === 0 ? "constraint" : "fact",
		title: `Benchmark topic ${index} target${index}`,
		statement: `Memory benchmark record target${index} supports deterministic lexical retrieval and graph traversal.`,
		applicability: `Synthetic scope group ${index % 100}`,
		trust: index % 11 === 0 ? "verified" : "model_inferred",
		freshness: index % 13 === 0 ? "stale" : "current",
		lifecycle: "active",
		effectiveFrom: "2026-01-01T00:00:00.000Z",
		effectiveTo: null,
		recordedAt: "2026-08-01T00:00:00.000Z",
		sourceDigest: hexId(index, memoryCount + 1),
		evidenceIds: [`evidence_${index}`],
		accessCount: index % 17,
		lastAccessedAt: index % 17 === 0 ? null : "2026-08-01T00:00:00.000Z",
		recallRouting: { routes: [] },
	};
}

function createEdge(index, memoryCount) {
	return {
		edgeId: `edge_${String(index).padStart(7, "0")}`,
		artifactId: hexId(index, memoryCount * 2 + 1),
		fromKind: "memory",
		fromId: memoryId(index % memoryCount),
		toKind: "memory",
		toId: memoryId((index * 17 + 1) % memoryCount),
		relation: "related_to",
		effectiveFrom: "2026-01-01T00:00:00.000Z",
		effectiveTo: null,
	};
}

function rebuildProjection(projection, memoryCount, edgeCount) {
	projection.beginRebuild({
		head: { sequence: memoryCount + edgeCount, hash: hexId(memoryCount + edgeCount, 7) },
		memoryCount,
		cueCount: 0,
		edgeCount,
		historyCueCount: 0,
	});
	try {
		for (let offset = 0; offset < memoryCount; offset += MEMORY_CHUNK_SIZE) {
			const limit = Math.min(memoryCount, offset + MEMORY_CHUNK_SIZE);
			const memories = [];
			for (let index = offset; index < limit; index++) memories.push(createMemory(index, memoryCount));
			projection.appendRebuildChunk({ memories, cues: [], edges: [], historyCues: [] });
		}
		for (let offset = 0; offset < edgeCount; offset += EDGE_CHUNK_SIZE) {
			const limit = Math.min(edgeCount, offset + EDGE_CHUNK_SIZE);
			const edges = [];
			for (let index = offset; index < limit; index++) edges.push(createEdge(index, memoryCount));
			projection.appendRebuildChunk({ memories: [], cues: [], edges, historyCues: [] });
		}
		projection.finishRebuild();
	} catch (error) {
		projection.abortRebuild();
		throw error;
	}
}

function measureOperation(runs, operation) {
	const timings = [];
	for (let run = 0; run < runs; run++) {
		const startedAt = performance.now();
		operation();
		timings.push(performance.now() - startedAt);
	}
	return { p95Ms: percentile95(timings), timings };
}

async function measure(options) {
	const directory = await mkdtemp(join(tmpdir(), `pi-xk-memory-benchmark-${options.memoryCount}-`));
	const database = new DatabaseSync(join(directory, "index.sqlite"));
	const projection = new MemorySqliteProjection(database);
	try {
		const rebuildStartedAt = performance.now();
		rebuildProjection(projection, options.memoryCount, options.edgeCount);
		const rebuildMs = performance.now() - rebuildStartedAt;
		const target = Math.floor(options.memoryCount / 2);
		const targetQuery = `target${target}`;
		const d0 = measureOperation(options.runs, () => projection.status());
		const d1 = measureOperation(options.runs, () =>
			projection.search({ query: targetQuery, limit: 12, graphDepth: 0 }),
		);
		const readIds = Array.from({ length: 5 }, (_, offset) => memoryId((target + offset) % options.memoryCount));
		const d2 = measureOperation(options.runs, () => {
			for (const id of readIds) projection.getMemory(id);
		});
		const graph = measureOperation(options.runs, () =>
			projection.search({ query: targetQuery, limit: 12, graphDepth: 2 }),
		);
		return {
			memoryCount: options.memoryCount,
			edgeCount: options.edgeCount,
			rebuildMs,
			d0P95Ms: d0.p95Ms,
			d1P95Ms: d1.p95Ms,
			d2P95Ms: d2.p95Ms,
			graphP95Ms: graph.p95Ms,
			peakRssMiB: (process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024)) / 1024 / 1024,
		};
	} finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function runMeasurement(memoryCount, edgeCount, runs) {
	const result = spawnSync(
		process.execPath,
		[
			"--no-warnings=ExperimentalWarning",
			"--import",
			"tsx",
			scriptPath,
			"--measure",
			String(memoryCount),
			String(edgeCount),
			String(runs),
		],
		{ cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `Memory benchmark child exited ${result.status}`);
	return JSON.parse(result.stdout);
}

function markdown(results, environment) {
	return [
		"Pi-XK Memory benchmark",
		`Environment: ${environment.platform} ${environment.release} · Node ${environment.node}`,
		"",
		"| Memories | Edges | Rebuild | D0 p95 | D1 p95 | D2 p95 | Graph-2 p95 | Peak RSS |",
		"| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...results.map(
			(result) =>
				`| ${result.memoryCount.toLocaleString("en-US")} | ${result.edgeCount.toLocaleString("en-US")} | ${Math.round(result.rebuildMs)} ms | ${result.d0P95Ms.toFixed(3)} ms | ${result.d1P95Ms.toFixed(3)} ms | ${result.d2P95Ms.toFixed(3)} ms | ${result.graphP95Ms.toFixed(3)} ms | ${result.peakRssMiB.toFixed(1)} MiB |`,
		),
	].join("\n");
}

function baselineKey(result) {
	return `${result.memoryCount}:${result.edgeCount}`;
}

function validateBaselineResult(value) {
	if (!isRecord(value)) throw new Error("memory benchmark baseline result must be an object");
	for (const field of [
		"memoryCount",
		"edgeCount",
		"rebuildMs",
		"d0P95Ms",
		"d1P95Ms",
		"d2P95Ms",
		"graphP95Ms",
		"peakRssMiB",
	]) {
		if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
			throw new Error(`memory benchmark baseline result has invalid ${field}`);
		}
	}
	return value;
}

async function loadBaseline(path, environment) {
	const parsed = JSON.parse(await readFile(path, "utf8"));
	if (!isRecord(parsed) || !isRecord(parsed.environment) || !Array.isArray(parsed.results)) {
		throw new Error("memory benchmark baseline must be JSON output from this benchmark");
	}
	if (parsed.environment.platform !== environment.platform || parsed.environment.node !== environment.node) {
		throw new Error(
			`memory benchmark baseline environment differs: ${parsed.environment.platform} ${parsed.environment.node} vs ${environment.platform} ${environment.node}`,
		);
	}
	return parsed.results.map(validateBaselineResult);
}

function regressionFailures(results, baselineResults, maxRegressionPercent) {
	if (!baselineResults) return [];
	const baselineByKey = new Map(baselineResults.map((result) => [baselineKey(result), result]));
	const metrics = ["rebuildMs", "d0P95Ms", "d1P95Ms", "d2P95Ms", "graphP95Ms", "peakRssMiB"];
	const failures = [];
	for (const result of results) {
		const baseline = baselineByKey.get(baselineKey(result));
		if (!baseline) {
			failures.push(`${result.memoryCount}: baseline is missing ${result.edgeCount} edges`);
			continue;
		}
		for (const metric of metrics) {
			const current = result[metric];
			const previous = baseline[metric];
			if (previous === 0 ? current > 0 : current > previous * (1 + maxRegressionPercent / 100)) {
				const percent = previous === 0 ? "infinite" : `${(((current / previous) - 1) * 100).toFixed(1)}%`;
				failures.push(
					`${result.memoryCount}: ${metric} regressed ${percent} (${current.toFixed(3)} vs ${previous.toFixed(3)}; limit ${maxRegressionPercent}%)`,
				);
			}
		}
	}
	return failures;
}

const options = parseArguments(process.argv.slice(2));
if (options.measure) {
	process.stdout.write(JSON.stringify(await measure(options.measure)));
	process.exit(0);
}

const results = options.counts.map((memoryCount) =>
	runMeasurement(memoryCount, Math.min(MAX_EDGES, memoryCount * 5), options.runs),
);
const environment = { platform: process.platform, release: release(), node: process.version };
const baselineResults = options.baselinePath ? await loadBaseline(options.baselinePath, environment) : null;
const failures = [
	...results.flatMap((result) => [
	...(result.d0P95Ms >= 10 ? [`${result.memoryCount}: D0 p95 ${result.d0P95Ms.toFixed(3)} ms`] : []),
	...(result.d1P95Ms >= 100 ? [`${result.memoryCount}: D1 p95 ${result.d1P95Ms.toFixed(3)} ms`] : []),
	...(result.d2P95Ms >= 25 ? [`${result.memoryCount}: D2 p95 ${result.d2P95Ms.toFixed(3)} ms`] : []),
	...(result.graphP95Ms >= 150 ? [`${result.memoryCount}: graph p95 ${result.graphP95Ms.toFixed(3)} ms`] : []),
	...(result.memoryCount === 100_000 && result.peakRssMiB > 512
		? [`${result.memoryCount}: peak RSS ${result.peakRssMiB.toFixed(1)} MiB`]
		: []),
	]),
	...regressionFailures(results, baselineResults, options.maxRegressionPercent),
];
process.stdout.write(
	options.json
		? `${JSON.stringify(
				{
					environment,
					results,
					baseline: options.baselinePath
						? { path: options.baselinePath, maxRegressionPercent: options.maxRegressionPercent }
						: null,
					failures,
				},
				null,
				2,
			)}\n`
		: `${markdown(results, environment)}${failures.length > 0 ? `\n\nFailures:\n${failures.join("\n")}` : ""}\n`,
);
if (failures.length > 0) process.exitCode = 1;
