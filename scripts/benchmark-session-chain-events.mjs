import { mkdtemp, rm, stat } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SESSION_CHAIN_SPEC_SCHEMA, SessionChainStore } from "../packages/pi-xk-core/dist/index.js";

const DEFAULT_COUNTS = [100, 1000];
const DEFAULT_RUNS = 3;

function positiveInteger(value, field) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

function parseArguments(argv) {
	const options = { counts: DEFAULT_COUNTS, runs: DEFAULT_RUNS, json: false };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--counts") {
			const raw = argv[++index];
			if (!raw) throw new Error("--counts requires a comma-separated event-count list");
			options.counts = raw.split(",").map((value) => positiveInteger(value, "event count"));
			continue;
		}
		if (argument === "--runs") {
			const raw = argv[++index];
			if (!raw) throw new Error("--runs requires a value");
			options.runs = positiveInteger(raw, "runs");
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	return options;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
}

async function generateChain(projectRoot, eventCount) {
	let fullReplayCount = 0;
	const store = new SessionChainStore(projectRoot, { onFullReplay: () => fullReplayCount++ });
	const chainId = `chain_benchmark_${eventCount}`;
	const startedAt = performance.now();
	const spec = {
		schema: SESSION_CHAIN_SPEC_SCHEMA,
		chainId,
		title: "Benchmark 1",
		cwd: projectRoot,
		rootBranchId: "branch_main",
		rootSegment: {
			segmentId: "session-root",
			ordinal: 1,
			location: { kind: "managed", fileName: "000001_session-root.jsonl" },
			predecessorSegmentId: null,
			summaryInArtifactId: null,
			createdAt: "2026-07-25T00:00:00.000Z",
		},
		createdAt: "2026-07-25T00:00:00.000Z",
	};
	let current = await store.createChain(spec, { eventId: "event-1", idempotencyKey: "benchmark:1" });
	fullReplayCount = 0;
	for (let sequence = 2; sequence <= eventCount; sequence++) {
		current = await store.appendMetadataUpdated(
			chainId,
			{ title: `Benchmark ${sequence}` },
			{
				eventId: `event-${sequence}`,
				idempotencyKey: `benchmark:${sequence}`,
				expectedHead: current.head,
				timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, sequence - 1)).toISOString(),
			},
		);
	}
	const eventsPath = join(projectRoot, ".pi-xk", "sessions", "chains", chainId, "events.jsonl");
	if (fullReplayCount !== 0) {
		throw new Error(`${eventCount}-event sequential append performed ${fullReplayCount} full event-log replays`);
	}
	const generationMs = performance.now() - startedAt;
	return { store, chainId, generationMs, eventBytes: (await stat(eventsPath)).size, fullReplayCount };
}

function markdown(results, environment) {
	return [
		"Session Chain event/read-model benchmark",
		`Environment: ${environment.platform} ${environment.release} · Node ${environment.node}`,
		"",
		"| Events | Event log | Sequential append | Full replays | Median status | Bytes read | Mode | Peak RSS |",
		"| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...results.map(
			(result) =>
				`| ${result.eventCount} | ${result.eventBytes} B | ${Math.round(result.generationMs)} ms | ${result.fullReplayCount} | ${result.medianLoadMs.toFixed(3)} ms | ${result.maxBytesRead} B | ${result.modes.join(",")} | ${result.peakRssMiB.toFixed(1)} MiB |`,
		),
	].join("\n");
}

const options = parseArguments(process.argv.slice(2));
const directory = await mkdtemp(join(tmpdir(), "pi-xk-session-chain-events-benchmark-"));
try {
	const results = [];
	for (const eventCount of options.counts) {
		const generated = await generateChain(join(directory, String(eventCount)), eventCount);
		const runs = [];
		for (let run = 0; run < options.runs; run++) {
			const startedAt = performance.now();
			const loaded = await generated.store.loadChainReadModelSnapshot(generated.chainId);
			runs.push({
				elapsedMs: performance.now() - startedAt,
				bytesRead: loaded.diagnostic.bytesRead,
				mode: loaded.diagnostic.mode,
			});
		}
		const maximumProofBytes = Math.max(1, Math.floor(generated.eventBytes / 10));
		if (
			runs.some(
				(run) => run.mode !== "fast" || run.bytesRead <= 0 || run.bytesRead >= maximumProofBytes,
			)
		) {
			throw new Error(
				`${eventCount}-event read model did not verify its checkpoint head within the fast-path byte budget`,
			);
		}
		results.push({
			eventCount,
			eventBytes: generated.eventBytes,
			generationMs: generated.generationMs,
			fullReplayCount: generated.fullReplayCount,
			medianLoadMs: median(runs.map((run) => run.elapsedMs)),
			maxBytesRead: Math.max(...runs.map((run) => run.bytesRead)),
			modes: [...new Set(runs.map((run) => run.mode))],
			peakRssMiB: (process.resourceUsage().maxRSS * (process.platform === "darwin" ? 1 : 1024)) / 1024 / 1024,
			runs,
		});
	}
	const environment = { platform: process.platform, release: release(), node: process.version };
	process.stdout.write(
		options.json
			? `${JSON.stringify({ environment, results }, null, 2)}\n`
			: `${markdown(results, environment)}\n`,
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
