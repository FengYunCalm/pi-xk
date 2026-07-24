import { mkdtemp, rm, stat } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../packages/coding-agent/dist/index.js";

const MIB = 1024 * 1024;
const DEFAULT_SIZES = [1, 8, 32, 128];
const DEFAULT_RUNS = 3;
const scriptPath = fileURLToPath(import.meta.url);

function parsePositiveInteger(value, field) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

function parseArguments(argv) {
	const options = { sizes: DEFAULT_SIZES, runs: DEFAULT_RUNS, json: false, measurePath: null };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--sizes") {
			const raw = argv[++index];
			if (!raw) throw new Error("--sizes requires a comma-separated MiB list");
			options.sizes = raw.split(",").map((value) => parsePositiveInteger(value, "size"));
			continue;
		}
		if (argument === "--runs") {
			const raw = argv[++index];
			if (!raw) throw new Error("--runs requires a value");
			options.runs = parsePositiveInteger(raw, "runs");
			continue;
		}
		if (argument === "--measure") {
			const raw = argv[++index];
			if (!raw) throw new Error("--measure requires a session path");
			options.measurePath = resolve(raw);
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return options;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

async function generateSession(directory, targetMiB) {
	const path = join(directory, `session-${targetMiB}mib.jsonl`);
	const manager = SessionManager.createAt(directory, path, { id: `benchmark-${targetMiB}mib` });
	const payload = "x".repeat(4096);
	const targetBytes = targetMiB * MIB;
	let index = 0;
	while (true) {
		for (let batch = 0; batch < 128; batch++) {
			manager.appendCustomEntry("pi-xk.session-chain-benchmark", { index, payload });
			index += 1;
		}
		manager.flushDurable();
		if ((await stat(path)).size >= targetBytes) break;
	}
	return { path, bytes: (await stat(path)).size, entries: manager.getEntries().length };
}

function measureSession(path) {
	globalThis.gc?.();
	const started = performance.now();
	const manager = SessionManager.open(path);
	const elapsedMs = performance.now() - started;
	const peakRssBytes = process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024);
	return { elapsedMs, peakRssBytes, entries: manager.getEntries().length };
}

function runMeasurement(path) {
	const result = spawnSync(process.execPath, ["--expose-gc", scriptPath, "--measure", path], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || `measurement exited ${result.status}`);
	return JSON.parse(result.stdout);
}

function markdown(results, environment) {
	return [
		`Session Chain SessionManager.open benchmark`,
		`Environment: ${environment.platform} ${environment.release} · Node ${environment.node}`,
		"",
		"| Target | Actual | Events | Median open | Median throughput | Median peak RSS |",
		"| ---: | ---: | ---: | ---: | ---: | ---: |",
		...results.map(
			(result) =>
				`| ${result.targetMiB} MiB | ${result.actualMiB.toFixed(3)} MiB | ${result.entries.toLocaleString("en-US")} | ${Math.round(result.medianOpenMs)} ms | ${result.medianThroughputMiBPerSecond.toFixed(1)} MiB/s | ${result.medianPeakRssMiB.toFixed(1)} MiB |`,
		),
	].join("\n");
}

const options = parseArguments(process.argv.slice(2));
if (options.measurePath) {
	process.stdout.write(JSON.stringify(measureSession(options.measurePath)));
	process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), "pi-xk-session-chain-benchmark-"));
try {
	const results = [];
	for (const targetMiB of options.sizes) {
		const generated = await generateSession(directory, targetMiB);
		const runs = Array.from({ length: options.runs }, () => runMeasurement(generated.path));
		results.push({
			targetMiB,
			actualMiB: generated.bytes / MIB,
			entries: generated.entries,
			medianOpenMs: median(runs.map((run) => run.elapsedMs)),
			medianThroughputMiBPerSecond: median(
				runs.map((run) => generated.bytes / MIB / (run.elapsedMs / 1000)),
			),
			medianPeakRssMiB: median(runs.map((run) => run.peakRssBytes / MIB)),
			runs,
		});
	}
	const environment = {
		platform: process.platform,
		release: release(),
		node: process.version,
	};
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ environment, results }, null, 2)}\n`);
	} else {
		process.stdout.write(`${markdown(results, environment)}\n`);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
