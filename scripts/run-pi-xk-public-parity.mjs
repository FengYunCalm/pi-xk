import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";
import { resolveRegisteredProbeManifest, validatePlan } from "./validate-pi-xk-public-parity-plan.mjs";

export { resolveRegisteredProbeManifest };

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPlanPath = join(workspaceRoot, "evaluation", "capabilities", "public-parity-plan.json");
const agentClasses = new Map([
	["pi-native", "harbor_pi_xk.agent:PiNative"],
	["pi-xk", "harbor_pi_xk.agent:PiXk"],
]);

function usage() {
	console.log(`Usage: node scripts/run-pi-xk-public-parity.mjs \\
  --probe-dir <generated-probe> --bundle <runtime-bundle> \\
  --harbor-root <pinned-harbor-checkout> --harbor-bin <harbor-executable> \\
  --out <new-result-dir> [--plan <path>] [--dry-run]

Execute the checked-in paired public evaluation exactly once in registered
order. The result directory must not already exist; an interrupted run is kept
for audit and cannot be resumed as a one-sided retry.`);
}

function parseArgs(argv) {
	let plan = defaultPlanPath;
	let probeDir;
	let bundle;
	let harborRoot;
	let harborBin;
	let out;
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--plan") plan = argv[++index];
		else if (argument === "--probe-dir") probeDir = argv[++index];
		else if (argument === "--bundle") bundle = argv[++index];
		else if (argument === "--harbor-root") harborRoot = argv[++index];
		else if (argument === "--harbor-bin") harborBin = argv[++index];
		else if (argument === "--out") out = argv[++index];
		else if (argument === "--dry-run") dryRun = true;
		else if (argument === "--help" || argument === "-h") return { help: true };
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!probeDir || !bundle || !harborRoot || !harborBin || !out) {
		throw new Error("--probe-dir, --bundle, --harbor-root, --harbor-bin, and --out are required");
	}
	return {
		help: false,
		plan: resolve(plan),
		probeDir: resolve(probeDir),
		bundleRoot: resolve(bundle),
		harborRoot: resolve(harborRoot),
		harborBin: resolve(harborBin),
		out: resolve(out),
		dryRun,
	};
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path, label) {
	let value;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read ${label}: ${path}`, { cause: error });
	}
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
	return value;
}

async function assertDirectory(path, label) {
	try {
		if (!(await lstat(path)).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	} catch (error) {
		throw new Error(`${label} is unavailable: ${path}`, { cause: error });
	}
}

async function assertFile(path, label) {
	try {
		if (!(await lstat(path)).isFile()) throw new Error(`${label} is not a file: ${path}`);
	} catch (error) {
		throw new Error(`${label} is unavailable: ${path}`, { cause: error });
	}
}

function assertSafeOutput(path) {
	const disallowed = new Set([resolve("/"), workspaceRoot, resolve(process.env.HOME ?? "/nonexistent")]);
	if (disallowed.has(path)) throw new Error(`Refusing unsafe public-evaluation output: ${path}`);
	if (isPathInsideRoot(workspaceRoot, path)) {
		throw new Error("Public-evaluation output must stay outside the repository worktree");
	}
}

async function commandOutput(command, args, cwd) {
	return await new Promise((resolveOutput, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolveOutput(stdout.trim());
			else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
		});
	});
}

export async function verifyDockerBuildx(run = commandOutput) {
	try {
		const output = await run("docker", ["buildx", "version"], workspaceRoot);
		if (typeof output !== "string" || !/\bbuildx\b/iu.test(output)) {
			throw new Error("docker buildx version returned an invalid response");
		}
	} catch (error) {
		throw new Error("Docker Buildx is unavailable; Harbor Docker trials require the buildx CLI plugin", {
			cause: error,
		});
	}
}

export async function verifyDockerCompose(run = commandOutput) {
	try {
		const output = await run("docker", ["compose", "version"], workspaceRoot);
		if (typeof output !== "string" || !/docker compose/iu.test(output)) {
			throw new Error("docker compose version returned an invalid response");
		}
	} catch (error) {
		throw new Error("Docker Compose is unavailable; Harbor Docker trials require the Compose v2 CLI plugin", {
			cause: error,
		});
	}
}

export async function verifyHarborTrialResult(trialRoot, trialName) {
	const result = await readJson(join(trialRoot, "result.json"), `Harbor trial result ${trialName}`);
	if (result.trial_name !== trialName) {
		throw new Error(`Harbor trial result identity does not match ${trialName}`);
	}
	if (result.exception_info !== null) {
		const exceptionType = isRecord(result.exception_info) && typeof result.exception_info.exception_type === "string"
			? result.exception_info.exception_type
			: "an internal error";
		throw new Error(`Harbor trial ${trialName} reported ${exceptionType}`);
	}
	if (!isRecord(result.agent_result)) {
		throw new Error(`Harbor trial ${trialName} has no agent result`);
	}
	if (
		!isRecord(result.verifier_result) ||
		!isRecord(result.verifier_result.rewards) ||
		typeof result.verifier_result.rewards.reward !== "number" ||
		!Number.isFinite(result.verifier_result.rewards.reward)
	) {
		throw new Error(`Harbor trial ${trialName} has no verifier reward`);
	}
}

export async function verifyHarborRuntime(root, executable, harness) {
	await assertDirectory(root, "Harbor source root");
	await assertFile(executable, "Harbor executable");
	await access(executable, constants.X_OK);
	const [commit, status, pyproject] = await Promise.all([
		commandOutput("git", ["rev-parse", "HEAD"], root),
		commandOutput("git", ["status", "--porcelain", "--untracked-files=all"], root),
		readFile(join(root, "pyproject.toml"), "utf8"),
	]);
	if (commit !== harness.commit) throw new Error("Harbor source commit does not match the registered plan");
	if (status) throw new Error("Harbor source checkout must be clean");
	const escapedVersion = harness.version.replaceAll(".", "\\.");
	if (!new RegExp(`^version = "${escapedVersion}"$`, "mu").test(pyproject)) {
		throw new Error("Harbor package version does not match the registered plan");
	}
}

async function verifyGeneratedProbe(probeDir, plan) {
	await assertDirectory(probeDir, "Generated probe directory");
	const generated = await readJson(join(probeDir, "probe-manifest.json"), "generated probe manifest");
	if (JSON.stringify(generated.harness) !== JSON.stringify(plan.harness)) {
		throw new Error("Generated probe harness does not match the registered plan");
	}
	if (generated.upstream?.commit !== plan.benchmark.commit) {
		throw new Error("Generated probe benchmark commit does not match the registered plan");
	}
	if (generated.networkPolicyProfile !== plan.controls.networkPolicyProfile) {
		throw new Error("Generated probe network policy profile does not match the registered plan");
	}
	const expectedTasks = plan.pairs.map((pair) => pair.taskId);
	if (JSON.stringify(generated.tasks) !== JSON.stringify(expectedTasks)) {
		throw new Error("Generated probe task order does not match the registered plan");
	}
	for (const taskId of expectedTasks) {
		const taskRoot = join(probeDir, taskId);
		await assertDirectory(taskRoot, `Generated probe task ${taskId}`);
		const taskToml = await readFile(join(taskRoot, "task.toml"), "utf8");
		const expectedTimeout = `timeout_sec = ${plan.controls.wallSeconds.toFixed(1)}`;
		const agentSection = taskToml.match(/\[agent\]([\s\S]*?)\n\[/u)?.[1] ?? "";
		if (!agentSection.includes(expectedTimeout)) {
			throw new Error(`Generated probe task ${taskId} does not enforce the registered agent timeout`);
		}
	}
}

async function verifyBundle(bundleRoot) {
	await assertDirectory(bundleRoot, "Pi-XK Harbor bundle");
	const manifest = await readJson(join(bundleRoot, "manifest.json"), "Pi-XK Harbor bundle manifest");
	if (manifest.schema !== "pi-xk.harbor-extension-bundle.v2") {
		throw new Error("Pi-XK Harbor bundle schema is invalid");
	}
	for (const path of [
		"extension.js",
		"harbor-telemetry.mjs",
		"pi-agent-core.tgz",
		"pi-ai.tgz",
		"pi-tui.tgz",
		"pi-coding-agent.tgz",
	]) {
		await assertFile(join(bundleRoot, path), `Pi-XK Harbor bundle ${path}`);
	}
}

export function buildPublicParitySchedule(plan) {
	if (!Array.isArray(plan.pairs)) throw new Error("Public parity plan pairs are invalid");
	return plan.pairs.flatMap((pair) =>
		pair.agentOrder.map((agent, order) => ({
			attemptId: pair.attemptId,
			taskId: pair.taskId,
			agent,
			order,
			trialName: `${pair.attemptId}-${agent}`,
		})),
	);
}

export function buildHarborTrialArgs({ entry, plan, taskRoot, trialsRoot, bundleRoot }) {
	const agentClass = agentClasses.get(entry.agent);
	if (!agentClass) throw new Error(`Unsupported public-evaluation agent: ${entry.agent}`);
	const args = [
		"trials",
		"start",
		"--path",
		taskRoot,
		"--trial-name",
		entry.trialName,
		"--trials-dir",
		trialsRoot,
		"--agent",
		agentClass,
		"--model",
		`${plan.controls.provider}/${plan.controls.model}`,
		"--agent-timeout",
		String(plan.controls.wallSeconds),
		"--agent-setup-timeout",
		String(plan.controls.agentSetupSeconds),
		"--agent-kwarg",
		`thinking=${plan.controls.thinking}`,
	];
	if (entry.agent === "pi-xk") {
		args.push("--agent-kwarg", `extension_bundle_dir=${bundleRoot}`);
	} else {
		args.push(
			"--agent-kwarg",
			`telemetry_path=${join(bundleRoot, "harbor-telemetry.mjs")}`,
			"--agent-kwarg",
			`pi_runtime_bundle_dir=${bundleRoot}`,
		);
	}
	return args;
}

async function runCommand(command, args, options) {
	return await new Promise((resolveCode, reject) => {
		const child = spawn(command, args, { ...options, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolveCode(code ?? 1));
	});
}

async function atomicWrite(path, value) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function assertNewOutput(path) {
	assertSafeOutput(path);
	try {
		await lstat(path);
		throw new Error(`Public-evaluation output already exists and cannot be resumed: ${path}`);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

export function markExecutionAborted(state, finishedAt = new Date().toISOString()) {
	state.status = "aborted";
	state.finishedAt = finishedAt;
	for (const entry of state.entries) {
		if (entry.status !== "running") continue;
		entry.status = "failed";
		entry.finishedAt = finishedAt;
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const planValue = await readJson(options.plan, "public parity plan");
	const checkedProbePath = await resolveRegisteredProbeManifest(planValue);
	const probeValue = await readJson(checkedProbePath, "checked public parity probe manifest");
	const plan = validatePlan(planValue, probeValue);
	if (!options.dryRun && !process.env.DEEPSEEK_API_KEY) {
		throw new Error("DEEPSEEK_API_KEY must be injected into the runner environment");
	}
	const preflight = [
		verifyHarborRuntime(options.harborRoot, options.harborBin, plan.harness),
		verifyGeneratedProbe(options.probeDir, plan),
		verifyBundle(options.bundleRoot),
		assertNewOutput(options.out),
	];
	if (!options.dryRun) preflight.push(verifyDockerBuildx(), verifyDockerCompose());
	await Promise.all(preflight);

	const schedule = buildPublicParitySchedule(plan);
	const trialsRoot = join(options.out, "trials");
	const statePath = join(options.out, "execution-state.json");
	const state = {
		schema: "pi-xk.public-parity-execution.v1",
		status: options.dryRun ? "dry-run" : "running",
		plan: options.plan,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		entries: schedule.map((entry) => ({ ...entry, status: "pending", startedAt: null, finishedAt: null })),
	};
	await mkdir(options.out, { recursive: false, mode: 0o700 });
	await atomicWrite(statePath, state);

	const commandPlan = schedule.map((entry) => ({
		entry,
		command: options.harborBin,
		args: buildHarborTrialArgs({
			entry,
			plan,
			taskRoot: join(options.probeDir, entry.taskId),
			trialsRoot,
			bundleRoot: options.bundleRoot,
		}),
	}));
	if (options.dryRun) {
		state.finishedAt = new Date().toISOString();
		await Promise.all([
			atomicWrite(join(options.out, "command-plan.json"), {
				schema: "pi-xk.public-parity-command-plan.v1",
				commands: commandPlan,
			}),
			atomicWrite(statePath, state),
		]);
		console.log(`Pi-XK public parity dry-run written to ${options.out}`);
		return;
	}

	try {
		const pythonPath = [
			join(workspaceRoot, "evaluation", "harbor"),
			join(options.harborRoot, "src"),
			process.env.PYTHONPATH,
		]
			.filter(Boolean)
			.join(delimiter);
		const pairReports = [];
		for (const [index, command] of commandPlan.entries()) {
			const stateEntry = state.entries[index];
			stateEntry.status = "running";
			stateEntry.startedAt = new Date().toISOString();
			await atomicWrite(statePath, state);
			const code = await runCommand(command.command, command.args, {
				cwd: workspaceRoot,
				env: { ...process.env, PYTHONPATH: pythonPath },
			});
			stateEntry.finishedAt = new Date().toISOString();
			if (code !== 0) {
				stateEntry.status = "failed";
				throw new Error(`Harbor trial ${command.entry.trialName} failed with exit code ${code}`);
			}
			await verifyHarborTrialResult(join(trialsRoot, command.entry.trialName), command.entry.trialName);
			stateEntry.status = "completed";
			await atomicWrite(statePath, state);

			if (command.entry.order === 1) {
				const pair = plan.pairs.find((candidate) => candidate.attemptId === command.entry.attemptId);
				if (!pair) throw new Error(`Missing registered pair: ${command.entry.attemptId}`);
				const trialByAgent = new Map(
					pair.agentOrder.map((agent) => [agent, join(trialsRoot, `${pair.attemptId}-${agent}`)]),
				);
				const reportPath = join(options.out, "pairs", `${pair.attemptId}.json`);
				const summaryCode = await runCommand(
					process.execPath,
					[
						join(workspaceRoot, "scripts", "summarize-pi-xk-harbor-report.mjs"),
						"--native",
						trialByAgent.get("pi-native"),
						"--xk",
						trialByAgent.get("pi-xk"),
						"--out",
						reportPath,
						"--thinking",
						plan.controls.thinking,
						"--plan",
						options.plan,
						"--attempt",
						pair.attemptId,
					],
					{ cwd: workspaceRoot, env: process.env },
				);
				if (summaryCode !== 0) throw new Error(`Unable to summarize registered pair ${pair.attemptId}`);
				pairReports.push(await readJson(reportPath, `pair report ${pair.attemptId}`));
			}
		}

		await atomicWrite(join(options.out, "capability-report.json"), {
			schema: "pi-xk.capability-report.v1",
			reportKind: "public-evaluation",
			generatedAt: new Date().toISOString(),
			runs: pairReports.flatMap((report) => report.runs),
		});
		state.status = "completed";
		state.finishedAt = new Date().toISOString();
		await atomicWrite(statePath, state);
		console.log(`Pi-XK public parity evaluation completed at ${options.out}`);
	} catch (error) {
		markExecutionAborted(state);
		try {
			await atomicWrite(statePath, state);
		} catch (stateError) {
			throw new AggregateError(
				[error, stateError],
				"Public parity execution failed and the aborted state could not be persisted",
			);
		}
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
