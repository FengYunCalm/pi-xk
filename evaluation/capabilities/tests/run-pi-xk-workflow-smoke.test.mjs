import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildIsolatedProcessEnvironment,
	buildMemoryRecallStatement,
	buildSkillSmokeChecks,
	classifyCompactionError,
	classifyProviderError,
	computeWorkflowRuntimeId,
	countUserPromptEntries,
	entriesHaveManagedSkillRead,
	extractHistoricalEvidenceDiagnosticCodes,
	failRpcWaitersOnExit,
	runRpcCommand,
	runRpcCommandNotification,
	runRpcCompact,
	runRpcNewSession,
	runRpcPrompt,
	runSessionChangingCommand,
	runWorkflowStage,
	inspectTaskEventFacts,
	sessionHasStructuredToolCall,
	waitForFactEvent,
	waitForRpcIdle,
	waitUntil,
	workflowShutdownGraceMs,
	WORKFLOW_SMOKE_PROFILE_SETTINGS,
} from "../../../scripts/run-pi-xk-workflow-smoke.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "run-pi-xk-workflow-smoke.mjs");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-workflow-smoke-test-"),
);

assert.equal(classifyProviderError("401 invalid api key"), "provider_authentication_failed");
assert.equal(classifyProviderError("402 insufficient balance"), "provider_balance_exhausted");
assert.equal(classifyProviderError("429 rate limit exceeded"), "provider_rate_limited");
assert.equal(classifyProviderError("504 request timed out"), "provider_timeout");
assert.equal(classifyProviderError("404 model not found"), "provider_model_unavailable");
assert.equal(classifyProviderError("fetch failed: ENOTFOUND"), "provider_network_failed");
assert.equal(classifyProviderError("provider returned an unknown error"), "provider_agent_error");
assert.equal(classifyCompactionError("Invalid compaction summary response: invalid JSON"), "compaction_invalid_summary");
assert.equal(classifyCompactionError("Nothing to compact (session too small)"), "compaction_unavailable");
assert.equal(classifyCompactionError("429 rate limit exceeded"), "provider_rate_limited");
assert.equal(classifyCompactionError("unclassified compaction failure"), "compaction_failed");

const isolatedEnvironment = buildIsolatedProcessEnvironment({
	homeDir: "/tmp/pi-xk-evaluation-home",
	profileDir: "/tmp/pi-xk-evaluation-profile",
	credentialName: "DEEPSEEK_API_KEY",
	credential: "fixture-credential",
	path: "/usr/bin",
	lang: "C.UTF-8",
});
assert.equal(isolatedEnvironment.HOME, "/tmp/pi-xk-evaluation-home");
assert.equal(isolatedEnvironment.XDG_CONFIG_HOME, "/tmp/pi-xk-evaluation-home/.config");
assert.equal(isolatedEnvironment.XDG_CACHE_HOME, "/tmp/pi-xk-evaluation-home/.cache");
assert.equal(isolatedEnvironment.XDG_DATA_HOME, "/tmp/pi-xk-evaluation-home/.local/share");
assert.equal(isolatedEnvironment.XDG_STATE_HOME, "/tmp/pi-xk-evaluation-home/.local/state");
assert.equal(isolatedEnvironment.PI_CODING_AGENT_DIR, "/tmp/pi-xk-evaluation-profile");
assert.equal(isolatedEnvironment.DEEPSEEK_API_KEY, "fixture-credential");
assert.equal(Object.hasOwn(isolatedEnvironment, "NPM_TOKEN"), false);
assert.deepEqual(WORKFLOW_SMOKE_PROFILE_SETTINGS, { compaction: { keepRecentTokens: 1 } });
const memoryRecallStatement = buildMemoryRecallStatement("XK-NDJSON-7319");
assert.equal(memoryRecallStatement.includes("XK-NDJSON-7319"), true);
assert.equal([...memoryRecallStatement].slice(0, 120).join("").includes("XK-NDJSON-7319"), false);
assert.equal(workflowShutdownGraceMs(900), 120_000);
assert.equal(workflowShutdownGraceMs(30), 30_000);
assert.deepEqual(buildSkillSmokeChecks(true, true, true), {
	skillEventsPresent: true,
	activeSkillPresent: true,
	skillReviewToolObserved: true,
});
assert.equal(
	countUserPromptEntries(
		[
			{ type: "message", message: { role: "user", content: "phase-two" } },
			{ type: "message", message: { role: "assistant", content: "done" } },
			{ type: "compaction", summary: "phase-two was completed" },
		],
		"phase-two",
	),
	1,
);
const matchedNotification = { type: "info", message: "matched" };
assert.equal(await waitUntil(async () => matchedNotification, 100, 1), matchedNotification);

const factRoot = join(temporaryRoot, "fact-events");
await mkdir(join(factRoot, "goal_fixture"), { recursive: true });
await writeFile(
	join(factRoot, "goal_fixture", "events.jsonl"),
	[
		JSON.stringify({ sequence: 1, eventType: "goal_created", timestamp: "2026-08-06T00:00:00.000Z" }),
		JSON.stringify({ sequence: 2, eventType: "goal_ended", timestamp: "2026-08-06T00:01:00.000Z" }),
	].join("\n"),
);
assert.deepEqual(await waitForFactEvent(factRoot, ["goal_ended"], 100, 1), {
	eventType: "goal_ended",
	sequence: 2,
	timestamp: "2026-08-06T00:01:00.000Z",
});

const rpcStates = [{ isStreaming: true }, { isStreaming: false, sessionFile: "/tmp/idle.jsonl" }];
assert.deepEqual(
	await waitForRpcIdle({ state: async () => rpcStates.shift() }, 100, 1),
	{ isStreaming: false, sessionFile: "/tmp/idle.jsonl" },
);

const childSessionFile = join(temporaryRoot, "child-session.jsonl");
const taskRoot = join(temporaryRoot, "task-events");
await mkdir(join(taskRoot, "task_fixture"), { recursive: true });
await writeFile(
	join(taskRoot, "task_fixture", "events.jsonl"),
	[
		JSON.stringify({ sequence: 1, eventType: "task_created", timestamp: "2026-08-06T00:00:00.000Z" }),
		JSON.stringify({
			sequence: 2,
			eventType: "task_started",
			timestamp: "2026-08-06T00:00:01.000Z",
			payload: { child: { childSessionFile } },
		}),
		JSON.stringify({
			sequence: 3,
			eventType: "task_succeeded",
			timestamp: "2026-08-06T00:00:02.000Z",
			payload: { summary: "child-result" },
		}),
	].join("\n"),
);
assert.deepEqual(await inspectTaskEventFacts(taskRoot), {
	eventsPresent: true,
	terminalEventType: "task_succeeded",
	terminalSummary: "child-result",
	childSessionFiles: [childSessionFile],
});
await writeFile(
	childSessionFile,
	`${JSON.stringify({
		type: "message",
		message: { role: "user", content: "The text pi_xk_finish_task is not a tool call." },
	})}\n`,
);
assert.equal(await sessionHasStructuredToolCall(childSessionFile, "pi_xk_finish_task"), false);
await writeFile(
	childSessionFile,
	`${JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "pi_xk_finish_task", arguments: {} }],
		},
	})}\n`,
);
assert.equal(await sessionHasStructuredToolCall(childSessionFile, "pi_xk_finish_task"), true);
const projectRoot = join(temporaryRoot, "skill-project");
const managedSkillPath = join(projectRoot, ".pi", "skills", "validate-incoming-records", "SKILL.md");
assert.equal(
	entriesHaveManagedSkillRead(
		[
			{
				type: "message",
				message: { role: "user", content: `Read ${managedSkillPath} if useful.` },
			},
		],
		projectRoot,
	),
	false,
);
assert.equal(
	entriesHaveManagedSkillRead(
		[
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: managedSkillPath } }],
				},
			},
		],
		projectRoot,
	),
	true,
);

const promptTimeouts = [];
await runRpcPrompt(
	{
		settledCount: 2,
		lastAgentStopReason: "stop",
		request: async (_command, timeoutMs) => promptTimeouts.push(["request", timeoutMs]),
		waitForSettled: async (previous, timeoutMs) => promptTimeouts.push([previous, timeoutMs]),
	},
	"prompt fixture",
	900_000,
);
assert.deepEqual(promptTimeouts, [
	["request", 900_000],
	[2, 900_000],
]);

const newSessionRequests = [];
assert.deepEqual(
	await runRpcNewSession(
		{
			request: async (command, timeoutMs) => {
				newSessionRequests.push([command, timeoutMs]);
				return { cancelled: false };
			},
		},
		900_000,
	),
	{ cancelled: false },
);
assert.deepEqual(newSessionRequests, [[{ type: "new_session" }, 900_000]]);

const compactRequests = [];
assert.deepEqual(
	await runRpcCompact(
		{
			request: async (command, timeoutMs) => {
				compactRequests.push([command, timeoutMs]);
				return { summary: "fixture summary" };
			},
		},
		900_000,
	),
	{ summary: "fixture summary" },
);
assert.deepEqual(compactRequests, [[{ type: "compact" }, 900_000]]);
await assert.rejects(
	() =>
		runRpcCompact(
			{
				request: async () => {
					throw new Error("Invalid compaction summary response: do not persist this response");
				},
			},
			900_000,
		),
	(error) =>
		error.code === "compaction_invalid_summary" && error.message === "Pi RPC compaction failed safely",
);

const runtimeRoot = join(temporaryRoot, "runtime-a");
const runtimeCopyRoot = join(temporaryRoot, "runtime-b");
const runtimePackages = ["agent", "ai", "coding-agent", "tui", "pi-xk-core", "pi-xk-extension"];
await mkdir(runtimeRoot, { recursive: true });
await writeFile(join(runtimeRoot, "package.json"), '{"name":"runtime-fixture"}\n');
await writeFile(join(runtimeRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
for (const packageName of runtimePackages) {
	const packageRoot = join(runtimeRoot, "packages", packageName);
	await mkdir(join(packageRoot, "dist", "nested"), { recursive: true });
	await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: packageName })}\n`);
	await writeFile(join(packageRoot, "dist", "entry.js"), `export const packageName = ${JSON.stringify(packageName)};\n`);
	await writeFile(join(packageRoot, "dist", "nested", "runtime.js"), `export const revision = "one";\n`);
}
await writeFile(join(runtimeRoot, "packages", "coding-agent", "npm-shrinkwrap.json"), '{"lockfileVersion":3}\n');
await cp(runtimeRoot, runtimeCopyRoot, { recursive: true });
const initialRuntimeId = await computeWorkflowRuntimeId(runtimeRoot, "0.80.10");
assert.equal(await computeWorkflowRuntimeId(runtimeCopyRoot, "0.80.10"), initialRuntimeId);
await writeFile(
	join(runtimeCopyRoot, "packages", "pi-xk-core", "dist", "nested", "runtime.js"),
	'export const revision = "two";\n',
);
assert.notEqual(await computeWorkflowRuntimeId(runtimeCopyRoot, "0.80.10"), initialRuntimeId);
const linkedRuntimeDirectory = join(runtimeCopyRoot, "packages", "pi-xk-core", "dist", "linked-runtime");
await symlink(
	join(runtimeCopyRoot, "packages", "agent", "dist"),
	linkedRuntimeDirectory,
	process.platform === "win32" ? "junction" : "dir",
);
await assert.rejects(
	() => computeWorkflowRuntimeId(runtimeCopyRoot, "0.80.10"),
	/symbolic link: packages\/pi-xk-core\/dist\/linked-runtime/u,
);

const commandTimeouts = [];
assert.equal(
	await runRpcCommand(
		{
			notifications: [],
			request: async (_command, timeoutMs) => commandTimeouts.push(["request", timeoutMs]),
			waitForNotification: async (previous, timeoutMs, expectedMessage) => {
				commandTimeouts.push([previous, timeoutMs, expectedMessage]);
				return { type: "info", message: "Session Chain status fixture" };
			},
		},
		"/chain status",
		120_000,
		"Session Chain status",
	),
	true,
);
assert.deepEqual(commandTimeouts, [
	["request", 120_000],
	[0, 120_000, "Session Chain status"],
]);
const warningNotification = await runRpcCommandNotification(
	{
		notifications: [],
		request: async () => {},
		waitForNotification: async () => ({ type: "warning", message: "matched diagnostic" }),
	},
	"/memory doctor",
	120_000,
	"matched diagnostic",
);
assert.deepEqual(warningNotification, { type: "warning", message: "matched diagnostic" });
await assert.rejects(
	() =>
		runRpcCommand(
			{
				notifications: [],
				request: async () => {},
				waitForNotification: async () => ({ type: "warning", message: "matched diagnostic" }),
			},
			"/chain status",
			120_000,
			"matched diagnostic",
		),
	(error) => error.code === "command_warning" && error.message === "Pi-XK command returned a warning diagnostic",
);
assert.deepEqual(
	extractHistoricalEvidenceDiagnosticCodes(
		[
			"Historical evidence",
			JSON.stringify({
				schema: "pi.summary-evidence.v1",
				kind: "memory-doctor",
				payload: { diagnostics: [{ code: "read_model_stale" }, { code: "index_missing_or_stale" }] },
			}),
		].join("\n"),
		"memory-doctor",
	),
	["index_missing_or_stale", "read_model_stale"],
);

const rpcExit = new Error("RPC exited");
let pendingExitError;
let settledExitError;
const exitedClient = {
	exitError: undefined,
	pending: new Map([["pending", { reject: (error) => (pendingExitError = error) }]]),
	settleWaiters: [{ reject: (error) => (settledExitError = error) }],
};
failRpcWaitersOnExit(exitedClient, rpcExit);
assert.equal(exitedClient.exitError, rpcExit);
assert.equal(pendingExitError, rpcExit);
assert.equal(settledExitError, rpcExit);
assert.equal(exitedClient.pending.size, 0);
assert.deepEqual(exitedClient.settleWaiters, []);

const sessionStates = [
	{ sessionFile: "/tmp/source-session.jsonl" },
	{ sessionFile: "/tmp/successor-session.jsonl" },
];
const sessionChangingClient = {
	state: async () => sessionStates.shift(),
	command: async (text, timeoutMs) => {
		assert.equal(text, "/chain rollover evaluation fixture");
		assert.equal(timeoutMs, 120_000);
		return true;
	},
};
assert.deepEqual(
	await runSessionChangingCommand(
		sessionChangingClient,
		"/chain rollover evaluation fixture",
		120_000,
		"Session Chain advanced to ",
	),
	{ sessionFile: "/tmp/successor-session.jsonl" },
);

await assert.rejects(
	() =>
		runSessionChangingCommand(
			{
				state: async () => ({ sessionFile: "/tmp/source-session.jsonl" }),
				command: async () => false,
			},
			"/chain rollover rejected fixture",
			120_000,
			"Session Chain advanced to ",
		),
	(error) => error.code === "session_change_command_failed" && /command reported failure/u.test(error.message),
);

await assert.rejects(
	() =>
		runSessionChangingCommand(
			{
				state: async () => ({ sessionFile: "/tmp/source-session.jsonl" }),
				command: async () => true,
			},
			"/chain rollover unchanged fixture",
			120_000,
			"Session Chain advanced to ",
		),
	(error) => error.code === "session_change_not_applied" && /did not replace the active session/u.test(error.message),
);

await assert.rejects(
	() =>
		runWorkflowStage("chain-memory-compaction.phase-two", async () => {
			throw new Error("provider diagnostic that must not be persisted");
		}),
	(error) =>
		error.code === "workflow_execution_failed" &&
		error.stage === "chain-memory-compaction.phase-two" &&
		error.message === "Workflow stage failed: chain-memory-compaction.phase-two",
);

try {
	const output = join(temporaryRoot, "output");
	const noCredential = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--out",
			output,
			"--provider",
			"deepseek",
			"--model",
			"deepseek-chat",
			"--scenario",
			"chain-memory-compaction",
		],
		{
			cwd: workspaceRoot,
			encoding: "utf8",
			env: { ...process.env, DEEPSEEK_API_KEY: "" },
		},
	);
	assert.notEqual(noCredential.status, 0);
	assert.match(noCredential.stderr, /credential is not available/u);
	assert.equal(existsSync(output), false);

	const unsafe = spawnSync(
		process.execPath,
		[
			scriptPath,
			"--out",
			join(workspaceRoot, "evaluation", "unsafe-output"),
			"--provider",
			"deepseek",
			"--model",
			"deepseek-chat",
		],
		{
			cwd: workspaceRoot,
			encoding: "utf8",
			env: { ...process.env, DEEPSEEK_API_KEY: "" },
		},
	);
	assert.notEqual(unsafe.status, 0);
	assert.match(unsafe.stderr, /outside the repository worktree/u);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
