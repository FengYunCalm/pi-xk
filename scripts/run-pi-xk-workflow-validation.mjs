import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportSchema = "pi-xk.capability-report.v1";
const scenarioDefinitions = [
	{
		id: "goal-contract-continuity",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: [
					"test/goal-contract-v2.test.ts",
					"test/goal-contract-v3.test.ts",
					"test/goal-lifecycle.test.ts",
					"test/goal-read-model.test.ts",
					"test/goal-store.test.ts",
				],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: ["test/suite/pi-xk-goal-extension.test.ts", "test/suite/pi-xk-checkpoint-bridge.test.ts"],
			},
		],
	},
	{
		id: "task-child-delivery",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: ["test/task-contract.test.ts", "test/task-store.test.ts", "test/task-read-model.test.ts"],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: ["test/suite/pi-xk-task-runner.test.ts", "test/suite/pi-xk-task-extension.test.ts"],
			},
		],
	},
	{
		id: "chain-rollover-rollup-recovery",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: [
					"test/session-chain-contract.test.ts",
					"test/session-chain-store.test.ts",
					"test/session-chain-read-model.test.ts",
					"test/session-chain-summary-v2.test.ts",
				],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: [
					"test/suite/pi-xk-session-chain-controller.test.ts",
					"test/suite/pi-xk-session-chain-extension.test.ts",
					"test/suite/pi-xk-session-chain-summary-quality.test.ts",
					"test/suite/pi-xk-session-chain-summary-retry.test.ts",
					"test/suite/pi-xk-session-chain-summary-title.test.ts",
				],
			},
		],
	},
	{
		id: "compaction-continuation",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: [
					"test/compaction-recovery.test.ts",
					"test/agent-session-auto-compaction-queue.test.ts",
					"test/suite/agent-session-compaction.test.ts",
				],
			},
		],
	},
	{
		id: "ambient-memory-recall-and-review",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: [
					"test/memory-contract.test.ts",
					"test/ambient-memory-contract.test.ts",
					"test/ambient-memory-store.test.ts",
					"test/memory-evidence.test.ts",
					"test/memory-freshness.test.ts",
					"test/memory-incremental-publication.test.ts",
					"test/memory-store.test.ts",
					"test/memory-index.test.ts",
					"test/memory-service.test.ts",
				],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: [
					"test/suite/pi-xk-memory-extension.test.ts",
					"test/suite/pi-xk-memory-prompt.test.ts",
					"test/suite/pi-xk-memory-source-bridge.test.ts",
				],
			},
		],
	},
	{
		id: "skill-evolution-and-reload",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: [
					"test/skill-contract.test.ts",
					"test/skill-index.test.ts",
					"test/skill-service.test.ts",
					"test/skill-store.test.ts",
				],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: ["test/suite/pi-xk-skill-evolution.test.ts", "test/suite/pi-xk-skill-reload.test.ts"],
			},
		],
	},
	{
		id: "doctor-projection-repair",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "pi-xk-core"),
				tests: [
					"test/goal-store.test.ts",
					"test/task-store.test.ts",
					"test/session-chain-store.test.ts",
					"test/memory-service.test.ts",
					"test/skill-service.test.ts",
				],
			},
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: ["test/suite/pi-xk-session-chain-extension.test.ts"],
			},
		],
	},
	{
		id: "local-installation-lifecycle",
		testGroups: [
			{
				packageRoot: join(workspaceRoot, "packages", "coding-agent"),
				tests: ["test/suite/pi-xk-package-install.test.ts"],
			},
		],
	},
];
const scenariosById = new Map(scenarioDefinitions.map((scenario) => [scenario.id, scenario]));

function usage() {
	console.log(`Usage: node scripts/run-pi-xk-workflow-validation.mjs --out <dir> [options]

Options:
  --scenario <id|all>  Run one matrix scenario or all scenarios (default: all)
  --force              Replace a previous output directory

Runs the existing faux-provider Pi-XK workflow verifiers and writes only a
sanitized capability report. This validates product invariants, not a public
head-to-head benchmark score.`);
}

function parseArgs(argv) {
	let out;
	let scenario = "all";
	let force = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--out") {
			out = argv[++index];
			continue;
		}
		if (argument === "--scenario") {
			scenario = argv[++index];
			continue;
		}
		if (argument === "--force") {
			force = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!out) throw new Error("--out is required");
	if (scenario !== "all" && !scenariosById.has(scenario)) throw new Error(`Unknown workflow scenario: ${scenario}`);
	return { help: false, out: resolve(out), scenario, force };
}

function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSafeOutput(path) {
	const disallowed = new Set([resolve("/"), workspaceRoot, resolve(homedir())]);
	if (disallowed.has(path)) throw new Error(`Refusing unsafe workflow output directory: ${path}`);
	if (isPathInsideRoot(workspaceRoot, path)) {
		throw new Error("Workflow output must be outside the repository worktree");
	}
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function assertFile(path, label) {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	} catch (error) {
		throw new Error(`${label} is missing: ${path}`, { cause: error });
	}
}

async function atomicWrite(path, content) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export function buildWorkflowTestEnvironment(tempRoot, environment = process.env) {
	return { ...environment, TMP: tempRoot, TEMP: tempRoot, TMPDIR: tempRoot };
}

async function createWorkflowTempRoot(output) {
	const base = process.platform === "win32" ? dirname(output) : "/tmp";
	await mkdir(base, { recursive: true, mode: 0o700 });
	return await mkdtemp(join(base, "pi-xk-workflow-validation-"));
}

async function piVersion() {
	const packagePath = join(workspaceRoot, "packages", "coding-agent", "package.json");
	const parsed = JSON.parse(await readFile(packagePath, "utf8"));
	if (!parsed || typeof parsed.version !== "string") throw new Error("Pi coding-agent package version is invalid");
	return parsed.version;
}

function sourceIdentity(version) {
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
	if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Git source revision is invalid");
	const dirty = spawnSync("git", ["diff", "--quiet"], { cwd: workspaceRoot }).status !== 0;
	return `pi-xk-faux-${version}-${revision}${dirty ? "-dirty" : ""}`;
}

async function scenarioDigest(scenario) {
	const chunks = [];
	for (const group of scenario.testGroups) {
		for (const test of group.tests) {
			const path = join(group.packageRoot, test);
			chunks.push(`${relative(workspaceRoot, path)}\n${await readFile(path, "utf8")}`);
		}
	}
	return sha256(chunks.join("\n\u0000\n"));
}

async function runScenario(scenario, version, runtimeId, childEnvironment) {
	const startedAt = Date.now();
	let passed = true;
	for (const group of scenario.testGroups) {
		const testCli = join(group.packageRoot, "node_modules", "vitest", "dist", "cli.js");
		await assertFile(testCli, `Vitest CLI for ${scenario.id}`);
		for (const test of group.tests) await assertFile(join(group.packageRoot, test), `${scenario.id} test ${test}`);
		const result = spawnSync(process.execPath, [testCli, "--run", ...group.tests], {
			cwd: group.packageRoot,
			env: childEnvironment,
			stdio: "inherit",
		});
		if (result.error || result.status !== 0) {
			passed = false;
			break;
		}
	}
	const elapsedSeconds = (Date.now() - startedAt) / 1000;
	const status = passed ? "passed" : "failed";
	return {
		id: `faux-${scenario.id}`,
		scenarioId: scenario.id,
		agent: "pi-xk",
		execution: "faux-provider",
		status,
		control: {
			model: "faux-provider",
			thinking: "not-applicable",
			piVersion: version,
			runtimeId,
			taskDigest: await scenarioDigest(scenario),
			budget: { wallSeconds: Math.ceil(elapsedSeconds), toolPolicy: "faux-provider-harness" },
		},
		metrics: {
			reward: status === "passed" ? 1 : 0,
			inputTokensIncludingCache: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			costUsd: 0,
			elapsedSeconds,
		},
		verification: { structural: status === "passed", independent: false },
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	assertSafeOutput(options.out);
	if (await exists(options.out)) {
		if (!options.force) throw new Error(`Output already exists: ${options.out}; pass --force to replace it`);
		await rm(options.out, { recursive: true, force: true });
	}
	const selected = options.scenario === "all" ? scenarioDefinitions : [scenariosById.get(options.scenario)];
	const version = await piVersion();
	const runtimeId = sourceIdentity(version);
	const workflowTempRoot = await createWorkflowTempRoot(options.out);
	try {
		const childEnvironment = buildWorkflowTestEnvironment(workflowTempRoot);
		const runs = [];
		for (const scenario of selected) {
			if (!scenario) throw new Error(`Unknown workflow scenario: ${options.scenario}`);
			const run = await runScenario(scenario, version, runtimeId, childEnvironment);
			runs.push(run);
			if (run.status !== "passed") {
				await mkdir(options.out, { recursive: true, mode: 0o700 });
				await atomicWrite(
					join(options.out, "failure.json"),
					`${JSON.stringify({ schema: "pi-xk.workflow-validation-failure.v1", scenarioId: scenario.id, code: "deterministic_tests_failed" }, null, 2)}\n`,
				);
				throw new Error(`Pi-XK workflow validation failed: ${scenario.id}`);
			}
		}
		await mkdir(options.out, { recursive: true, mode: 0o700 });
		await atomicWrite(
			join(options.out, "capability-report.json"),
			`${JSON.stringify(
				{ schema: reportSchema, reportKind: "workflow-validation", generatedAt: new Date().toISOString(), runs },
				null,
				2,
			)}\n`,
		);
		console.log(`Pi-XK workflow validation report created at ${join(options.out, "capability-report.json")}`);
	} finally {
		await rm(workflowTempRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
