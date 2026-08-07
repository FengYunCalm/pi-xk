import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRegisteredProbeManifest, validatePlan } from "./validate-pi-xk-public-parity-plan.mjs";

const REPORT_SCHEMA = "pi-xk.capability-report.v1";
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_AGENTS = new Map([
	["native", "pi-native"],
	["xk", "pi-xk"],
]);

function usage() {
	console.log(`Usage: node scripts/summarize-pi-xk-harbor-report.mjs \\
  --native <Harbor-trial-dir> --xk <Harbor-trial-dir> --out <report.json> \\
  --thinking <level> --plan <public-parity-plan.json> --attempt <id>

Create a sanitized public-parity report from two Harbor trial directories. The
output contains verifier and aggregate usage metadata only; it never copies
prompts, transcripts, tool arguments, assistant text, or provider credentials.`);
}

function parseArgs(argv) {
	let native;
	let xk;
	let out;
	let thinking;
	let plan;
	let attempt;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--native") {
			native = argv[++index];
			continue;
		}
		if (argument === "--xk") {
			xk = argv[++index];
			continue;
		}
		if (argument === "--out") {
			out = argv[++index];
			continue;
		}
		if (argument === "--thinking") {
			thinking = argv[++index];
			continue;
		}
		if (argument === "--plan") {
			plan = argv[++index];
			continue;
		}
		if (argument === "--attempt") {
			attempt = argv[++index];
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!native || !xk || !out || !thinking || !plan || !attempt) {
		throw new Error("--native, --xk, --out, --thinking, --plan, and --attempt are required");
	}
	return {
		help: false,
		native: resolve(native),
		xk: resolve(xk),
		out: resolve(out),
		thinking,
		plan: resolve(plan),
		attempt,
	};
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value, field) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function number(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative finite number`);
	}
	return value;
}

function lowercaseHex(value, length, field) {
	const parsed = string(value, field);
	if (parsed.length !== length || !/^[0-9a-f]+$/u.test(parsed)) {
		throw new Error(`${field} must be a lowercase hexadecimal digest`);
	}
	return parsed;
}

function reward(result, label) {
	if (!isRecord(result.verifier_result) || !isRecord(result.verifier_result.rewards)) {
		throw new Error(`${label} Harbor result has no verifier reward`);
	}
	return number(result.verifier_result.rewards.reward, `${label} verifier reward`);
}

function elapsedSeconds(result, label) {
	const startedAt = Date.parse(string(result.started_at, `${label} started_at`));
	const finishedAt = Date.parse(string(result.finished_at, `${label} finished_at`));
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
		throw new Error(`${label} Harbor result has invalid timestamps`);
	}
	return (finishedAt - startedAt) / 1000;
}

async function readJson(path, label) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read ${label}: ${path}`, { cause: error });
	}
	if (!isRecord(parsed)) throw new Error(`${label} is not a JSON object`);
	return parsed;
}

async function parseTrial(trialDir, role, harness, controls, attempt) {
	const expectedAgent = EXPECTED_AGENTS.get(role);
	if (!expectedAgent) throw new Error(`Unsupported trial role: ${role}`);
	const [result, summary] = await Promise.all([
		readJson(resolve(trialDir, "result.json"), `${role} Harbor result`),
		readJson(resolve(trialDir, "agent", `${expectedAgent}-summary.json`), `${role} telemetry summary`),
	]);
	if (summary.agent !== expectedAgent) throw new Error(`${role} telemetry agent identity does not match`);
	if (!isRecord(result.agent_result)) throw new Error(`${role} Harbor result has no agent_result`);
	const taskDigest = lowercaseHex(result.task_checksum, 64, `${role} task_checksum`);
	const taskName = string(result.task_name, `${role} task_name`);
	const model = string(summary.model, `${role} model`);
	const expectedModel = `${controls.provider}/${controls.model}`;
	if (model !== expectedModel) throw new Error(`${role} model does not match the registered plan`);
	const piVersion = string(summary.pi_version, `${role} pi_version`);
	const bundleSourceCommit = lowercaseHex(summary.bundle_source_commit, 40, `${role} bundle_source_commit`);
	const bundleContentDigest = lowercaseHex(summary.bundle_content_digest, 64, `${role} bundle_content_digest`);
	const runtimeArchiveDigest = lowercaseHex(summary.runtime_archive_digest, 64, `${role} runtime_archive_digest`);
	const harborVersion = string(summary.harbor_version, `${role} harbor_version`);
	const harborSourceCommit = lowercaseHex(summary.harbor_source_commit, 40, `${role} harbor_source_commit`);
	if (harborVersion !== harness.version) throw new Error(`${role} harness version does not match the registered plan`);
	if (harborSourceCommit !== harness.commit) throw new Error(`${role} harness commit does not match the registered plan`);
	const startedAt = Date.parse(string(result.started_at, `${role} started_at`));
	const finishedAt = Date.parse(string(result.finished_at, `${role} finished_at`));
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
		throw new Error(`${role} Harbor result has invalid timestamps`);
	}
	const usage = result.agent_result;
	const status = reward(result, role) >= 1 && result.exception_info === null ? "passed" : "failed";
	return {
		taskName,
		startedAt,
		run: {
		id: `${role}-${taskDigest.slice(0, 16)}-${attempt}`,
		scenarioId: "public-code-task-parity",
		comparisonId: `${taskName.replaceAll(/[^a-z0-9]+/giu, "-").replaceAll(/^-|-$/gu, "")}-${model.replaceAll(/[^a-z0-9]+/giu, "-")}-${controls.thinking}-${attempt}`,
		agent: expectedAgent,
		execution: "real-provider",
		status,
		control: {
			model,
			thinking: controls.thinking,
			piVersion,
			runtimeId: `harbor-${harborVersion}-${harborSourceCommit}-pi-${piVersion}-${bundleSourceCommit}-${bundleContentDigest}-${runtimeArchiveDigest}`,
			taskDigest,
			budget: { wallSeconds: controls.wallSeconds, toolPolicy: controls.toolPolicy },
		},
		metrics: {
			reward: reward(result, role),
			inputTokensIncludingCache: number(usage.n_input_tokens, `${role} n_input_tokens`),
			outputTokens: number(usage.n_output_tokens, `${role} n_output_tokens`),
			cacheReadTokens: number(usage.n_cache_tokens, `${role} n_cache_tokens`),
			costUsd: number(usage.cost_usd, `${role} cost_usd`),
			elapsedSeconds: elapsedSeconds(result, role),
		},
			verification: { structural: true, independent: true },
		},
	};
}

async function atomicWrite(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function readRegisteredPlan(path) {
	const plan = await readJson(path, "public parity plan");
	const probePath = await resolveRegisteredProbeManifest(plan, workspaceRoot);
	return validatePlan(plan, await readJson(probePath, "public parity probe manifest"));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const plan = await readRegisteredPlan(options.plan);
	if (options.thinking !== plan.controls.thinking) {
		throw new Error("--thinking does not match the registered public parity plan");
	}
	const pair = plan.pairs.find((candidate) => candidate.attemptId === options.attempt);
	if (!pair) throw new Error(`Public parity plan does not register attempt: ${options.attempt}`);
	const [native, xk] = await Promise.all([
		parseTrial(options.native, "native", plan.harness, plan.controls, pair.attemptId),
		parseTrial(options.xk, "xk", plan.harness, plan.controls, pair.attemptId),
	]);
	const expectedTaskName = `pi-xk-evaluation/${pair.taskId}`;
	if (native.taskName !== expectedTaskName || xk.taskName !== expectedTaskName) {
		throw new Error(`Public parity plan attempt ${pair.attemptId} does not register task ${native.taskName}`);
	}
	const trialByAgent = new Map([
		["pi-native", native],
		["pi-xk", xk],
	]);
	const first = trialByAgent.get(pair.agentOrder[0]);
	const second = trialByAgent.get(pair.agentOrder[1]);
	if (!first || !second || first.startedAt >= second.startedAt) {
		throw new Error(`Public parity plan attempt ${pair.attemptId} did not follow the registered agent order`);
	}
	if (native.run.control.taskDigest !== xk.run.control.taskDigest) throw new Error("Harbor trials use different task digests");
	if (
		native.run.control.model !== xk.run.control.model ||
		native.run.control.piVersion !== xk.run.control.piVersion ||
		native.run.control.runtimeId !== xk.run.control.runtimeId
	) {
		throw new Error("Harbor trials do not use the same Pi runtime control");
	}
	if (native.run.comparisonId !== xk.run.comparisonId) throw new Error("Harbor trials do not form the same comparison");
	await atomicWrite(
		options.out,
		`${JSON.stringify(
			{
				schema: REPORT_SCHEMA,
				reportKind: "public-evaluation",
				generatedAt: new Date().toISOString(),
				runs: [native.run, xk.run],
			},
			null,
			2,
		)}\n`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
