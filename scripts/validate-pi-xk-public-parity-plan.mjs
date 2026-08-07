import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_SCHEMA = "pi-xk.public-parity-plan.v1";
const PROBE_SCHEMA = "pi-xk.harbor-aider-polyglot-probe.v1";
const PLAN_KEYS = new Set(["schema", "harness", "benchmark", "controls", "retryPolicy", "pairs"]);
const HARNESS_KEYS = new Set(["name", "repository", "commit", "version"]);
const BENCHMARK_KEYS = new Set(["name", "repository", "commit", "probeManifest"]);
const CONTROL_KEYS = new Set([
	"provider",
	"model",
	"thinking",
	"wallSeconds",
	"agentSetupSeconds",
	"toolPolicy",
	"networkPolicyProfile",
]);
const PAIR_KEYS = new Set(["attemptId", "taskId", "agentOrder"]);
const AGENT_ORDER = new Set(["pi-native", "pi-xk"]);

function usage() {
	console.log(`Usage: node scripts/validate-pi-xk-public-parity-plan.mjs --plan <path> --probe <path> [--format json|markdown]

Validate the pre-registered public Pi/Pi-XK paired-evaluation plan. The plan
contains only benchmark controls and task identifiers; prompts, trajectories,
credentials, and model responses are never accepted.`);
}

function parseArgs(argv) {
	let plan;
	let probe;
	let format = "json";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--plan") {
			plan = argv[++index];
			continue;
		}
		if (argument === "--probe") {
			probe = argv[++index];
			continue;
		}
		if (argument === "--format") {
			format = argv[++index];
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!plan || !probe) throw new Error("--plan and --probe are required");
	if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown");
	return { help: false, plan: resolve(plan), probe: resolve(probe), format };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

export async function resolveRegisteredProbeManifest(plan, root = workspaceRoot) {
	if (!isRecord(plan.benchmark) || typeof plan.benchmark.probeManifest !== "string") {
		throw new Error("Public parity plan benchmark probeManifest is invalid");
	}
	const canonicalRoot = await realpath(resolve(root));
	const candidate = resolve(canonicalRoot, plan.benchmark.probeManifest);
	if (!isPathInsideRoot(canonicalRoot, candidate)) {
		throw new Error("Public parity plan probeManifest must stay inside the repository");
	}
	const canonicalCandidate = await realpath(candidate);
	if (!isPathInsideRoot(canonicalRoot, canonicalCandidate)) {
		throw new Error("Public parity plan probeManifest must stay inside the repository");
	}
	return canonicalCandidate;
}

function assertExactKeys(value, expected, field) {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) throw new Error(`${field}.${key} is not supported`);
	}
	for (const key of expected) {
		if (!(key in value)) throw new Error(`${field}.${key} is required`);
	}
}

function assertLowercaseHex(value, length, field) {
	const result = requireString(value, field);
	if (result.length !== length || !/^[0-9a-f]+$/u.test(result)) {
		throw new Error(`${field} must be a lowercase hexadecimal digest`);
	}
	return result;
}

function parseProbe(probe) {
	if (
		!isRecord(probe) ||
		probe.schema !== PROBE_SCHEMA ||
		!isRecord(probe.harness) ||
		!isRecord(probe.upstream) ||
		!Array.isArray(probe.tasks)
	) {
		throw new Error("Probe manifest schema is invalid");
	}
	assertExactKeys(probe.harness, HARNESS_KEYS, "Probe harness");
	const harness = {
		name: requireString(probe.harness.name, "Probe harness name"),
		repository: requireString(probe.harness.repository, "Probe harness repository"),
		commit: assertLowercaseHex(probe.harness.commit, 40, "Probe harness commit"),
		version: requireString(probe.harness.version, "Probe harness version"),
	};
	if (!/^\d+\.\d+\.\d+$/u.test(harness.version)) throw new Error("Probe harness version is invalid");
	const repository = requireString(probe.upstream.repository, "Probe repository");
	const commit = assertLowercaseHex(probe.upstream.commit, 40, "Probe commit");
	if (!Number.isInteger(probe.agentTimeoutSeconds) || probe.agentTimeoutSeconds <= 0) {
		throw new Error("Probe agentTimeoutSeconds must be a positive integer");
	}
	const networkPolicyProfile = requireString(probe.networkPolicyProfile, "Probe networkPolicyProfile");
	if (networkPolicyProfile !== "portable-loopback-v1") {
		throw new Error("Probe network policy profile is unsupported");
	}
	const taskIds = probe.tasks.map((task, index) => {
		if (!isRecord(task)) throw new Error(`Probe task ${index} is invalid`);
		const taskId = requireString(task.id, `Probe task ${index} id`);
		if (!/^[a-z0-9-]+$/u.test(taskId)) throw new Error(`Probe task ${taskId} id is invalid`);
		return taskId;
	});
	if (taskIds.length === 0 || new Set(taskIds).size !== taskIds.length) {
		throw new Error("Probe task identifiers must be non-empty and unique");
	}
	return { harness, repository, commit, agentTimeoutSeconds: probe.agentTimeoutSeconds, networkPolicyProfile, taskIds };
}

export function validatePlan(plan, probe) {
	const probeInfo = parseProbe(probe);
	assertExactKeys(plan, PLAN_KEYS, "Public parity plan");
	if (plan.schema !== PLAN_SCHEMA) throw new Error("Public parity plan schema is invalid");
	assertExactKeys(plan.harness, HARNESS_KEYS, "Public parity plan harness");
	const harness = {
		name: requireString(plan.harness.name, "Public parity plan harness name"),
		repository: requireString(plan.harness.repository, "Public parity plan harness repository"),
		commit: assertLowercaseHex(plan.harness.commit, 40, "Public parity plan harness commit"),
		version: requireString(plan.harness.version, "Public parity plan harness version"),
	};
	if (!/^\d+\.\d+\.\d+$/u.test(harness.version)) throw new Error("Public parity plan harness version is invalid");
	if (
		harness.name !== probeInfo.harness.name ||
		harness.repository !== probeInfo.harness.repository ||
		harness.commit !== probeInfo.harness.commit ||
		harness.version !== probeInfo.harness.version
	) {
		throw new Error("Public parity plan harness commit and version must match the probe manifest");
	}
	assertExactKeys(plan.benchmark, BENCHMARK_KEYS, "Public parity plan benchmark");
	const benchmark = {
		name: requireString(plan.benchmark.name, "Public parity plan benchmark name"),
		repository: requireString(plan.benchmark.repository, "Public parity plan benchmark repository"),
		commit: assertLowercaseHex(plan.benchmark.commit, 40, "Public parity plan benchmark commit"),
		probeManifest: requireString(plan.benchmark.probeManifest, "Public parity plan benchmark probeManifest"),
	};
	if (benchmark.repository !== probeInfo.repository || benchmark.commit !== probeInfo.commit) {
		throw new Error("Public parity plan benchmark pin does not match the probe manifest");
	}
	assertExactKeys(plan.controls, CONTROL_KEYS, "Public parity plan controls");
	if (!Number.isInteger(plan.controls.wallSeconds) || plan.controls.wallSeconds <= 0) {
		throw new Error("Public parity plan controls.wallSeconds must be a positive integer");
	}
	if (!Number.isInteger(plan.controls.agentSetupSeconds) || plan.controls.agentSetupSeconds <= 0) {
		throw new Error("Public parity plan controls.agentSetupSeconds must be a positive integer");
	}
	const controls = {
		provider: requireString(plan.controls.provider, "Public parity plan controls provider"),
		model: requireString(plan.controls.model, "Public parity plan controls model"),
		thinking: requireString(plan.controls.thinking, "Public parity plan controls thinking"),
		wallSeconds: plan.controls.wallSeconds,
		agentSetupSeconds: plan.controls.agentSetupSeconds,
		toolPolicy: requireString(plan.controls.toolPolicy, "Public parity plan controls toolPolicy"),
		networkPolicyProfile: requireString(
			plan.controls.networkPolicyProfile,
			"Public parity plan controls networkPolicyProfile",
		),
	};
	if (controls.wallSeconds !== probeInfo.agentTimeoutSeconds) {
		throw new Error("Public parity plan controls.wallSeconds must match the generated probe agent timeout");
	}
	if (controls.networkPolicyProfile !== probeInfo.networkPolicyProfile) {
		throw new Error("Public parity plan network policy profile must match the probe manifest");
	}
	if (plan.retryPolicy !== "abort-pair-no-single-side-retry") {
		throw new Error("Public parity plan retryPolicy must be abort-pair-no-single-side-retry");
	}
	if (!Array.isArray(plan.pairs) || plan.pairs.length !== probeInfo.taskIds.length) {
		throw new Error("Public parity plan must include exactly one pair for every probe task");
	}

	const attemptIds = new Set();
	const taskIds = new Set();
	let previousFirstAgent;
	const pairs = plan.pairs.map((pair, index) => {
		assertExactKeys(pair, PAIR_KEYS, `Public parity plan pair ${index}`);
		const attemptId = requireString(pair.attemptId, `Public parity plan pair ${index} attemptId`);
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(attemptId) || attemptIds.has(attemptId)) {
			throw new Error(`Public parity plan pair ${index} attemptId is invalid or duplicated`);
		}
		attemptIds.add(attemptId);
		const taskId = requireString(pair.taskId, `Public parity plan pair ${attemptId} taskId`);
		if (!probeInfo.taskIds.includes(taskId) || taskIds.has(taskId)) {
			throw new Error(`Public parity plan task ${taskId} must appear exactly once`);
		}
		taskIds.add(taskId);
		if (!Array.isArray(pair.agentOrder) || pair.agentOrder.length !== 2 || new Set(pair.agentOrder).size !== 2) {
			throw new Error(`Public parity plan pair ${attemptId} agentOrder is invalid`);
		}
		for (const agent of pair.agentOrder) {
			if (!AGENT_ORDER.has(agent)) throw new Error(`Public parity plan pair ${attemptId} agentOrder is invalid`);
		}
		if (previousFirstAgent === pair.agentOrder[0]) {
			throw new Error("Public parity plan pair agent order must alternate to control order effects");
		}
		previousFirstAgent = pair.agentOrder[0];
		return { attemptId, taskId, agentOrder: [...pair.agentOrder] };
	});
	if (taskIds.size !== probeInfo.taskIds.length) throw new Error("Public parity plan must include every probe task exactly once");
	return { schema: PLAN_SCHEMA, harness, benchmark, controls, retryPolicy: plan.retryPolicy, pairs };
}

function renderMarkdown(plan) {
	const lines = [
		"# Pi-XK public parity plan",
		"",
		`- Harness: ${plan.harness.name} ${plan.harness.version} at ${plan.harness.commit}`,
		`- Benchmark: ${plan.benchmark.name} at ${plan.benchmark.commit}`,
		`- Model: ${plan.controls.provider}/${plan.controls.model}; thinking=${plan.controls.thinking}`,
		`- Budget: ${plan.controls.wallSeconds}s per agent; ${plan.controls.agentSetupSeconds}s setup; ${plan.controls.toolPolicy}`,
		`- Network policy: ${plan.controls.networkPolicyProfile}`,
		`- Retry policy: ${plan.retryPolicy}`,
		"",
		"## Pairs",
		...plan.pairs.map((pair) => `- ${pair.attemptId}: ${pair.taskId}; ${pair.agentOrder.join(" then ")}`),
	];
	return `${lines.join("\n")}\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const [plan, probe] = await Promise.all([
		readFile(options.plan, "utf8").then((content) => JSON.parse(content)),
		readFile(options.probe, "utf8").then((content) => JSON.parse(content)),
	]);
	const normalized = validatePlan(plan, probe);
	process.stdout.write(options.format === "markdown" ? renderMarkdown(normalized) : `${JSON.stringify(normalized, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
