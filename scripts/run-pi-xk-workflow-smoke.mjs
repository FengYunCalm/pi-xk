import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportSchema = "pi-xk.capability-report.v1";
export const extensionDefault = join(workspaceRoot, "packages", "pi-xk-extension", "dist", "extension.js");
export const cliDefault = join(workspaceRoot, "packages", "coding-agent", "dist", "cli.js");
const codingAgentPackagePath = join(workspaceRoot, "packages", "coding-agent", "package.json");
const providerEnvironmentKey = new Map([["deepseek", "DEEPSEEK_API_KEY"]]);
const validScenarios = new Set(["chain-memory-compaction", "goal-task", "skill", "all"]);
const UI_METHODS_REQUIRING_RESPONSE = new Set(["select", "confirm", "input", "editor", "custom"]);
const memoryRecallSentinel = "XK-NDJSON-7319";
const runtimePackageNames = ["agent", "ai", "coding-agent", "tui", "pi-xk-core", "pi-xk-extension"];
export const WORKFLOW_SMOKE_PROFILE_SETTINGS = { compaction: { keepRecentTokens: 1 } };

export function workflowShutdownGraceMs(timeoutSeconds) {
	return Math.min(timeoutSeconds * 1000, 120000);
}

function usage() {
	console.log(`Usage: node scripts/run-pi-xk-workflow-smoke.mjs --out <dir> --provider <name> --model <id> [options]

Options:
  --thinking <level>       Thinking level (default: low)
  --scenario <name>        chain-memory-compaction, goal-task, skill, or all (default: all)
  --timeout <seconds>      Per-provider-turn timeout (default: 900)
  --extension <path>       Built Pi-XK extension entrypoint
  --cli <path>             Built Pi CLI entrypoint
  --force                  Replace a previous output directory

The provider credential is read only from the current process environment. This
runner creates isolated project, profile, and session directories and writes a
sanitized capability report without prompts, transcript content, tool input, or
model output.`);
}

function parseArgs(argv) {
	let out;
	let provider;
	let model;
	let thinking = "low";
	let scenario = "all";
	let timeoutSeconds = 900;
	let extension = extensionDefault;
	let cli = cliDefault;
	let force = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--out") {
			out = argv[++index];
			continue;
		}
		if (argument === "--provider") {
			provider = argv[++index];
			continue;
		}
		if (argument === "--model") {
			model = argv[++index];
			continue;
		}
		if (argument === "--thinking") {
			thinking = argv[++index];
			continue;
		}
		if (argument === "--scenario") {
			scenario = argv[++index];
			continue;
		}
		if (argument === "--timeout") {
			timeoutSeconds = Number(argv[++index]);
			continue;
		}
		if (argument === "--extension") {
			extension = argv[++index];
			continue;
		}
		if (argument === "--cli") {
			cli = argv[++index];
			continue;
		}
		if (argument === "--force") {
			force = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!out || !provider || !model) throw new Error("--out, --provider, and --model are required");
	if (!validScenarios.has(scenario)) throw new Error(`Unsupported scenario: ${scenario}`);
	if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
		throw new Error("--timeout must be an integer between 30 and 3600 seconds");
	}
	return {
		help: false,
		out: resolve(out),
		provider,
		model,
		thinking,
		scenario,
		timeoutSeconds,
		extension: resolve(extension),
		cli: resolve(cli),
		force,
	};
}

function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildMemoryRecallStatement(identifier) {
	if (typeof identifier !== "string" || identifier.trim().length === 0) {
		throw new Error("Memory recall identifier must be a non-empty string");
	}
	return [
		"Interchange policy evidence for this capability evaluation.",
		"The record is intentionally indexed by topic while its exact accepted value remains in the verified D2 statement.",
		`The accepted interchange identifier is ${identifier}.`,
	].join(" ");
}

async function collectRuntimeFiles(root, label) {
	const path = join(root, ...label.split("/"));
	const stat = await lstat(path);
	if (stat.isSymbolicLink()) throw new Error(`Workflow runtime input must not be a symbolic link: ${label}`);
	if (stat.isFile()) return [{ label, path }];
	if (!stat.isDirectory()) throw new Error(`Workflow runtime input is not a regular file or directory: ${label}`);
	const files = [];
	for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name, "en"),
	)) {
		files.push(...(await collectRuntimeFiles(root, `${label}/${entry.name}`)));
	}
	return files;
}

export async function computeWorkflowRuntimeId(root, piVersion) {
	if (typeof piVersion !== "string" || piVersion.length === 0) throw new Error("Pi version is invalid");
	const labels = [
		"package.json",
		"package-lock.json",
		...runtimePackageNames.flatMap((packageName) => [
			`packages/${packageName}/package.json`,
			`packages/${packageName}/dist`,
		]),
		"packages/coding-agent/npm-shrinkwrap.json",
	];
	const files = (await Promise.all(labels.map((label) => collectRuntimeFiles(root, label))))
		.flat()
		.sort((left, right) => left.label.localeCompare(right.label, "en"));
	const hash = createHash("sha256");
	hash.update("pi-xk.workflow-runtime.v1\0");
	for (const file of files) {
		const content = await readFile(file.path);
		hash.update(`${Buffer.byteLength(file.label, "utf8")}:`);
		hash.update(file.label);
		hash.update(`:${content.length}:`);
		hash.update(content);
	}
	return `pi-${piVersion}-runtime-sha256:${hash.digest("hex")}`;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function classifyProviderError(errorMessage) {
	const normalized = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
	if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid (?:api )?key|incorrect api key/u.test(normalized)) {
		return "provider_authentication_failed";
	}
	if (/\b402\b|insufficient (?:balance|funds|credits)|balance (?:is )?(?:insufficient|exhausted)/u.test(normalized)) {
		return "provider_balance_exhausted";
	}
	if (/\b429\b|rate.?limit|quota|too many requests/u.test(normalized)) return "provider_rate_limited";
	if (/\b(?:408|504)\b|timed? out|etimedout/u.test(normalized)) return "provider_timeout";
	if (/\b(?:404|410)\b|model (?:not found|unavailable)|unknown model/u.test(normalized)) {
		return "provider_model_unavailable";
	}
	if (/econn(?:reset|refused)|enotfound|network error|socket hang up|fetch failed/u.test(normalized)) {
		return "provider_network_failed";
	}
	return "provider_agent_error";
}

export function classifyCompactionError(errorMessage) {
	const normalized = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
	if (normalized.includes("invalid compaction summary response")) return "compaction_invalid_summary";
	if (normalized.includes("nothing to compact") || normalized.includes("already compacted")) {
		return "compaction_unavailable";
	}
	if (normalized.includes("compaction cancelled")) return "compaction_cancelled";
	const providerCode = classifyProviderError(normalized);
	return providerCode === "provider_agent_error" ? "compaction_failed" : providerCode;
}

export function buildIsolatedProcessEnvironment({
	homeDir,
	profileDir,
	credentialName,
	credential,
	path,
	lang,
}) {
	for (const [field, value] of Object.entries({ homeDir, profileDir, credentialName, credential })) {
		if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	}
	return {
		HOME: homeDir,
		XDG_CONFIG_HOME: join(homeDir, ".config"),
		XDG_CACHE_HOME: join(homeDir, ".cache"),
		XDG_DATA_HOME: join(homeDir, ".local", "share"),
		XDG_STATE_HOME: join(homeDir, ".local", "state"),
		LANG: typeof lang === "string" && lang.length > 0 ? lang : "C.UTF-8",
		PATH: typeof path === "string" ? path : "",
		PI_CODING_AGENT_DIR: profileDir,
		PI_SKIP_VERSION_CHECK: "1",
		[credentialName]: credential,
	};
}

class ProviderAgentRunError extends Error {
	constructor(errorMessage) {
		super("Pi agent run ended with error");
		this.code = classifyProviderError(errorMessage);
	}
}

class WorkflowSmokeError extends Error {
	constructor(code, message, stage, cause) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
		this.stage = stage;
	}
}

class RpcProcessExitError extends Error {
	constructor(exitCode, signal) {
		super(`Pi RPC process exited (code=${exitCode} signal=${signal})`);
		this.code = "rpc_process_exited";
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

export function failRpcWaitersOnExit(client, error) {
	client.exitError = error;
	for (const pending of client.pending.values()) pending.reject(error);
	client.pending.clear();
	for (const waiter of client.settleWaiters) waiter.reject(error);
	client.settleWaiters = [];
}

export async function runRpcPrompt(client, text, timeoutMs) {
	const previous = client.settledCount;
	await client.request({ type: "prompt", message: text }, timeoutMs);
	await client.waitForSettled(previous, timeoutMs);
	if (client.lastAgentStopReason === "error") throw new ProviderAgentRunError(client.lastAgentErrorMessage);
}

export async function runRpcNewSession(client, timeoutMs) {
	const result = await client.request({ type: "new_session" }, timeoutMs);
	if (!isRecord(result) || result.cancelled !== false) {
		throw new WorkflowSmokeError("session_change_cancelled", "Pi RPC session change was cancelled");
	}
	return result;
}

export async function runRpcCompact(client, timeoutMs) {
	try {
		return await client.request({ type: "compact" }, timeoutMs);
	} catch (error) {
		throw new WorkflowSmokeError(
			classifyCompactionError(error instanceof Error ? error.message : String(error)),
			"Pi RPC compaction failed safely",
			undefined,
			error,
		);
	}
}

export async function runRpcCommandNotification(client, text, timeoutMs, expectedMessage) {
	const previous = client.notifications.length;
	await client.request({ type: "prompt", message: text }, timeoutMs);
	return await client.waitForNotification(previous, timeoutMs, expectedMessage);
}

export async function runRpcCommand(client, text, timeoutMs, expectedMessage) {
	const notification = await runRpcCommandNotification(client, text, timeoutMs, expectedMessage);
	if (notification.type !== "info") {
		const type = notification.type === "warning" || notification.type === "error" ? notification.type : "invalid";
		throw new WorkflowSmokeError(
			`command_${type}`,
			`Pi-XK command returned ${type === "invalid" ? "an invalid" : `a ${type}`} diagnostic`,
		);
	}
	return true;
}

function collectDiagnosticCodes(value, codes) {
	if (Array.isArray(value)) {
		for (const entry of value) collectDiagnosticCodes(entry, codes);
		return;
	}
	if (!isRecord(value)) return;
	if (Array.isArray(value.diagnostics)) {
		for (const diagnostic of value.diagnostics) {
			if (isRecord(diagnostic) && typeof diagnostic.code === "string" && /^[a-z0-9_]+$/u.test(diagnostic.code)) {
				codes.add(diagnostic.code);
			}
		}
	}
	for (const entry of Object.values(value)) collectDiagnosticCodes(entry, codes);
}

export function extractHistoricalEvidenceDiagnosticCodes(message, expectedKind) {
	if (typeof message !== "string") return [];
	const lines = message.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const envelope = JSON.parse(lines[index]);
			if (!isRecord(envelope) || envelope.kind !== expectedKind || !("payload" in envelope)) continue;
			const codes = new Set();
			collectDiagnosticCodes(envelope.payload, codes);
			return [...codes].sort();
		} catch {
			// Historical-evidence prose and malformed lines are not diagnostics.
		}
	}
	return [];
}

function requireSafeOutput(path) {
	const disallowed = new Set([resolve("/"), workspaceRoot, resolve(homedir()), resolve(tmpdir())]);
	if (disallowed.has(path)) throw new Error(`Refusing unsafe workflow output directory: ${path}`);
	if (isPathInsideRoot(workspaceRoot, path)) {
		throw new Error("Workflow output must be outside the repository worktree");
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

async function directoryExists(path) {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function runSessionChangingCommand(client, commandText, timeoutMs, expectedMessage) {
	const before = await client.state();
	if (!isRecord(before) || typeof before.sessionFile !== "string" || before.sessionFile.length === 0) {
		throw new WorkflowSmokeError(
			"session_change_source_unavailable",
			"Session-changing command started without an active session file",
		);
	}
	if (!(await client.command(commandText, timeoutMs, expectedMessage))) {
		throw new WorkflowSmokeError("session_change_command_failed", "Session-changing command reported failure");
	}
	const after = await client.state();
	if (!isRecord(after) || typeof after.sessionFile !== "string" || after.sessionFile === before.sessionFile) {
		throw new WorkflowSmokeError(
			"session_change_not_applied",
			"Session-changing command did not replace the active session",
		);
	}
	return after;
}

async function findFiles(root, predicate) {
	const files = [];
	if (!(await directoryExists(root))) return files;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findFiles(path, predicate)));
			continue;
		}
		if (entry.isFile() && predicate(path)) files.push(path);
	}
	return files;
}

async function readEventObjects(root) {
	const paths = await findFiles(root, (path) => path.endsWith("/events.jsonl"));
	const events = [];
	for (const path of paths) {
		const lines = (await readFile(path, "utf8")).split("\n");
		for (const line of lines) {
			if (!line) continue;
			try {
				const value = JSON.parse(line);
				if (isRecord(value) && typeof value.eventType === "string") events.push(value);
			} catch {
				// A partial final line is not a domain fact.
			}
		}
	}
	return events;
}

export async function waitForFactEvent(root, eventTypes, timeoutMs, intervalMs = 250) {
	const accepted = new Set(eventTypes);
	const event = await waitUntil(
		async () => {
			for (const candidate of await readEventObjects(root)) {
				if (!accepted.has(candidate.eventType)) continue;
				return {
					eventType: candidate.eventType,
					sequence: Number.isInteger(candidate.sequence) ? candidate.sequence : undefined,
					timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : undefined,
				};
			}
			return undefined;
		},
		timeoutMs,
		intervalMs,
	);
	if (!event) throw new Error(`Timed out waiting for domain event: ${[...accepted].join(",")}`);
	return event;
}

export async function inspectTaskEventFacts(root) {
	const events = await readEventObjects(root);
	let terminalEventType;
	let terminalSummary;
	const childSessionFiles = [];
	for (const event of events) {
		if (event.eventType === "task_started" && isRecord(event.payload) && isRecord(event.payload.child)) {
			const childSessionFile = event.payload.child.childSessionFile;
			if (typeof childSessionFile === "string" && childSessionFile.length > 0) childSessionFiles.push(childSessionFile);
		}
		if (["task_succeeded", "task_failed", "task_cancelled", "task_orphaned"].includes(event.eventType)) {
			terminalEventType = event.eventType;
			terminalSummary = isRecord(event.payload) && typeof event.payload.summary === "string" ? event.payload.summary : undefined;
		}
	}
	return { eventsPresent: events.length > 0, terminalEventType, terminalSummary, childSessionFiles };
}

export async function sessionHasStructuredToolCall(path, toolName) {
	const lines = (await readFile(path, "utf8")).split("\n");
	for (const line of lines) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (!isRecord(entry)) continue;
			const message = isRecord(entry.message) ? entry.message : entry;
			if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			if (
				message.content.some(
					(part) => isRecord(part) && part.type === "toolCall" && part.name === toolName,
				)
			) {
				return true;
			}
		} catch {
			// Ignore incomplete or non-session lines.
		}
	}
	return false;
}

async function containsTextInFiles(paths, text) {
	for (const path of paths) {
		if ((await readFile(path, "utf8")).includes(text)) return true;
	}
	return false;
}

export async function waitUntil(predicate, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result) return result;
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
	}
	return predicate();
}

export async function waitForRpcIdle(client, timeoutMs, intervalMs = 250) {
	const state = await waitUntil(
		async () => {
			const current = await client.state();
			return isRecord(current) && current.isStreaming === false ? current : undefined;
		},
		timeoutMs,
		intervalMs,
	);
	if (!state) throw new Error("Timed out waiting for Pi RPC session to become idle");
	return state;
}

export class RpcProcess {
	constructor(options) {
		this.options = options;
		this.process = undefined;
		this.buffer = "";
		this.pending = new Map();
		this.requestId = 0;
		this.settledCount = 0;
		this.settleWaiters = [];
		this.toolNames = new Set();
		this.toolExecutionEvents = [];
		this.uiMethods = new Set();
		this.notifications = [];
		this.stderr = "";
		this.lastAgentStopReason = undefined;
		this.lastAgentErrorMessage = undefined;
		this.exitError = undefined;
	}

	async start() {
		const credentialName = providerEnvironmentKey.get(this.options.provider);
		if (!credentialName) throw new Error(`Unsupported provider for workflow smoke: ${this.options.provider}`);
		const credential = process.env[credentialName];
		if (!credential) throw new Error(`Required provider credential is not available in this process: ${credentialName}`);
		const args = [
			this.options.cli,
			"--mode",
			"rpc",
			"--provider",
			this.options.provider,
			"--model",
			this.options.model,
			"--thinking",
			this.options.thinking,
			"--session-dir",
			this.options.sessionDir,
			"--no-extensions",
			"--approve",
		];
		if (this.options.extension) args.splice(args.length - 1, 0, "--extension", this.options.extension);
		if (this.options.session) args.push("--session", this.options.session);
		this.process = spawn("node", args, {
			cwd: this.options.projectDir,
			env: buildIsolatedProcessEnvironment({
				homeDir: this.options.homeDir,
				profileDir: this.options.profileDir,
				credentialName,
				credential,
				path: process.env.PATH,
				lang: process.env.LANG,
			}),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process.stdout.on("data", (chunk) => this.onStdout(chunk.toString()));
		this.process.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.process.on("exit", (code, signal) => {
			failRpcWaitersOnExit(this, new RpcProcessExitError(code, signal));
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 150));
		if (this.process.exitCode !== null) throw new Error(`Pi RPC startup failed: ${this.safeStderr()}`);
	}

	safeStderr() {
		return this.stderr.replaceAll(/(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z_]+_API_KEY\s*=\s*\S+)/gu, "[redacted]").slice(-2000);
	}

	onStdout(chunk) {
		this.buffer += chunk;
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			try {
				this.onLine(JSON.parse(line));
			} catch {
				// RPC output is JSONL; malformed diagnostic lines are never persisted.
			}
		}
	}

	onLine(event) {
		if (isRecord(event) && event.type === "response" && typeof event.id === "string") {
			const pending = this.pending.get(event.id);
			if (pending) {
				this.pending.delete(event.id);
				if (event.success === true) pending.resolve(event.data);
				else pending.reject(new Error(typeof event.error === "string" ? event.error : "Pi RPC command failed"));
				return;
			}
		}
		if (!isRecord(event)) return;
		if (event.type === "extension_ui_request") {
			if (typeof event.method === "string") this.uiMethods.add(event.method);
			if (event.method === "notify") {
				this.notifications.push({
					message: typeof event.message === "string" ? event.message : "",
					type: event.notifyType === "error" || event.notifyType === "warning" ? event.notifyType : "info",
				});
			}
			if (typeof event.id === "string" && UI_METHODS_REQUIRING_RESPONSE.has(event.method)) {
				this.writeRaw({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			return;
		}
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			this.toolExecutionEvents.push({ toolName: event.toolName, timestamp: Date.now() });
		}
		if (event.type === "agent_end") {
			this.collectToolNames(event.messages);
			const outcome = this.agentOutcome(event.messages);
			this.lastAgentStopReason = outcome?.stopReason;
			this.lastAgentErrorMessage = outcome?.errorMessage;
		}
		if (event.type === "agent_settled") {
			this.settledCount += 1;
			for (const waiter of this.settleWaiters.splice(0)) waiter.resolve();
		}
	}

	collectToolNames(messages) {
		if (!Array.isArray(messages)) return;
		for (const message of messages) {
			if (!isRecord(message) || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
					this.toolNames.add(part.name);
				}
			}
		}
	}

	agentOutcome(messages) {
		if (!Array.isArray(messages)) return undefined;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (isRecord(message) && message.role === "assistant" && typeof message.stopReason === "string") {
				return {
					stopReason: message.stopReason,
					errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
				};
			}
		}
		return undefined;
	}

	writeRaw(command) {
		if (!this.process?.stdin?.writable) return;
		this.process.stdin.write(`${JSON.stringify(command)}\n`);
	}

	request(command, timeoutMs = 30000) {
		if (!this.process?.stdin?.writable) return Promise.reject(new Error("Pi RPC stdin is not writable"));
		const id = `request-${++this.requestId}`;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectRequest(new Error(`Timed out waiting for Pi RPC ${command.type}: ${this.safeStderr()}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolveRequest(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectRequest(error);
				},
			});
			this.writeRaw({ ...command, id });
		});
	}

	waitForSettled(previous, timeoutMs) {
		if (this.exitError) return Promise.reject(this.exitError);
		if (this.settledCount > previous) return Promise.resolve();
		return new Promise((resolveWait, rejectWait) => {
			const timer = setTimeout(() => {
				this.settleWaiters = this.settleWaiters.filter((waiter) => waiter.resolve !== resolveWait);
				rejectWait(new Error(`Timed out waiting for agent settlement: ${this.safeStderr()}`));
			}, timeoutMs);
			this.settleWaiters.push({
				resolve: () => {
					clearTimeout(timer);
					resolveWait();
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectWait(error);
				},
			});
		});
	}

	async waitForNotification(previous, timeoutMs, expectedMessage) {
		const notification = await waitUntil(
			() => {
				if (this.exitError) throw this.exitError;
				return this.notifications
					.slice(previous)
					.find((candidate) => expectedMessage === undefined || candidate.message.includes(expectedMessage));
			},
			timeoutMs,
		);
		if (!notification) throw new Error("Timed out waiting for Pi-XK command diagnostic");
		return notification;
	}

	async prompt(text, timeoutMs) {
		await runRpcPrompt(this, text, timeoutMs);
	}

	async command(text, timeoutMs = 30000, expectedMessage) {
		return await runRpcCommand(this, text, timeoutMs, expectedMessage);
	}

	async commandNotification(text, timeoutMs = 30000, expectedMessage) {
		return await runRpcCommandNotification(this, text, timeoutMs, expectedMessage);
	}

	async state() {
		return this.request({ type: "get_state" });
	}

	async messages() {
		const result = await this.request({ type: "get_messages" });
		return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
	}

	async entries() {
		const result = await this.request({ type: "get_entries" });
		return isRecord(result) && Array.isArray(result.entries) ? result.entries : [];
	}

	async stop() {
		if (!this.process || this.process.exitCode !== null) return;
		const process = this.process;
		process.kill("SIGTERM");
		await new Promise((resolveWait) => {
			const timer = setTimeout(() => {
				if (process.exitCode === null) process.kill("SIGKILL");
				resolveWait();
			}, workflowShutdownGraceMs(this.options.timeoutSeconds));
			process.once("exit", () => {
				clearTimeout(timer);
				resolveWait();
			});
		});
	}
}

async function createScenarioEnvironment(root, name) {
	const scenarioRoot = join(root, name);
	const projectDir = join(scenarioRoot, "project");
	const profileDir = join(scenarioRoot, "profile");
	const sessionDir = join(scenarioRoot, "sessions");
	const homeDir = join(scenarioRoot, "home");
	await Promise.all([
		mkdir(projectDir, { recursive: true, mode: 0o700 }),
		mkdir(profileDir, { recursive: true, mode: 0o700 }),
		mkdir(sessionDir, { recursive: true, mode: 0o700 }),
		mkdir(homeDir, { recursive: true, mode: 0o700 }),
	]);
	await writeFile(
		join(profileDir, "settings.json"),
		`${JSON.stringify(WORKFLOW_SMOKE_PROFILE_SETTINGS, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	return { scenarioRoot, projectDir, profileDir, sessionDir, homeDir };
}

async function writeFixture(projectDir, files) {
	for (const [name, content] of Object.entries(files)) {
		const path = join(projectDir, name);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
	}
}

function userText(message) {
	if (!isRecord(message) || message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function countUserPromptEntries(entries, expectedText) {
	return entries.filter(
		(entry) => isRecord(entry) && entry.type === "message" && userText(entry.message) === expectedText,
	).length;
}

export function entriesHaveManagedSkillRead(entries, projectRoot) {
	const skillRoot = join(projectRoot, ".pi", "skills");
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const message = isRecord(entry.message) ? entry.message : entry;
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== "read" || !isRecord(part.arguments)) continue;
			const path = part.arguments.path;
			if (typeof path !== "string" || path.length === 0) continue;
			const target = resolve(projectRoot, path);
			if (basename(target) === "SKILL.md" && isPathInsideRoot(skillRoot, target)) return true;
		}
	}
	return false;
}

export function usageFromMessages(messages) {
	let inputTokensIncludingCache = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let costUsd = 0;
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
		const usage = message.usage;
		const input = asNonNegativeNumber(usage.input);
		const cacheRead = asNonNegativeNumber(usage.cacheRead);
		inputTokensIncludingCache += input + cacheRead;
		outputTokens += asNonNegativeNumber(usage.output);
		cacheReadTokens += cacheRead;
		if (isRecord(usage.cost)) costUsd += asNonNegativeNumber(usage.cost.total);
	}
	return { inputTokensIncludingCache, outputTokens, cacheReadTokens, costUsd };
}

export async function usageFromSessionFile(path) {
	const messages = [];
	for (const line of (await readFile(path, "utf8")).split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (isRecord(entry) && isRecord(entry.message)) messages.push(entry.message);
		} catch {
			// Ignore incomplete or non-session lines.
		}
	}
	return usageFromMessages(messages);
}

export function addUsage(left, right) {
	return {
		inputTokensIncludingCache: left.inputTokensIncludingCache + right.inputTokensIncludingCache,
		outputTokens: left.outputTokens + right.outputTokens,
		cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
		costUsd: left.costUsd + right.costUsd,
	};
}

function runRecord({ id, scenarioId, status, options, runtimeId, taskDigest, elapsedSeconds, usage, structural, independent }) {
	return {
		id,
		scenarioId,
		agent: "pi-xk",
		execution: "real-provider",
		status,
		control: {
			model: `${options.provider}/${options.model}`,
			thinking: options.thinking,
			piVersion: options.piVersion,
			runtimeId,
			taskDigest,
			budget: { wallSeconds: options.timeoutSeconds, toolPolicy: "pi-default" },
		},
		metrics: {
			reward: status === "passed" ? 1 : 0,
			...usage,
			elapsedSeconds,
		},
		verification: { structural, independent },
	};
}

function failureCode(error) {
	if (
		error instanceof ProviderAgentRunError ||
		error instanceof WorkflowSmokeError ||
		error instanceof RpcProcessExitError
	)
		return error.code;
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("credential is not available")) return "credential_unavailable";
	if (message.includes("Timed out")) return "timeout";
	if (message.includes("Nothing to compact") || message.includes("Already compacted")) return "compaction_unavailable";
	if (message.includes("rollover did not settle")) return "rollover_not_settled";
	if (message.includes("Pi RPC")) return "rpc_failure";
	return "workflow_execution_failed";
}

function rpcExitDetails(error) {
	const seen = new Set();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		if (current instanceof RpcProcessExitError) return { exitCode: current.exitCode, signal: current.signal };
		seen.add(current);
		current = current.cause;
	}
	return undefined;
}

export async function runWorkflowStage(stage, operation) {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof WorkflowSmokeError && error.stage !== undefined) throw error;
		throw new WorkflowSmokeError(failureCode(error), `Workflow stage failed: ${stage}`, stage, error);
	}
}

export async function withClient(environment, options, callback) {
	const client = new RpcProcess({ ...options, ...environment });
	await client.start();
	try {
		return await callback(client);
	} finally {
		await client.stop();
	}
}

async function runChainMemoryCompaction(root, options, runtimeId) {
	const environment = await createScenarioEnvironment(root, "chain-memory-compaction");
	await writeFixture(environment.projectDir, {
		"README.md": "# Capability smoke\nThis project is intentionally isolated.\n",
		"requirements.md": "Use the established interchange format when it is relevant.\n",
	});
	const startedAt = Date.now();
	const prompts = {
		phaseOne: "Create work.log with exactly one line: phase-one.",
		phaseTwo: "Append exactly one line, phase-two, to work.log.",
		phaseThree: "Append exactly one line, phase-three, to work.log.",
		recall:
			"This existing project has durable records that may affect the answer. Determine the accepted interchange identifier, using Pi-XK history if it is relevant, then write only that exact identifier to format.txt.",
	};
	let toolNames = new Set();
	let compactionSucceeded = false;
	let singlePromptOccurrence = false;
	let priorPromptOccurrenceCount = 0;
	let doctorStructural = false;
	let doctorChecks = {};
	let doctorDiagnosticCodes = {};
	let usage = { inputTokensIncludingCache: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
	let resumedSession;
	await runWorkflowStage("chain-memory-compaction.first-session", () =>
		withClient(environment, options, async (client) => {
			const providerTurnTimeoutMs = options.timeoutSeconds * 1000;
			const commandTimeoutMs = Math.min(providerTurnTimeoutMs, 120000);
			if (
			!(await runWorkflowStage("chain-memory-compaction.rollup-config", () =>
				client.command(
					"/chain rollup config 1",
					commandTimeoutMs,
					"Session Chain automatic Rollup interval set to 1",
				),
			))
			) {
				throw new WorkflowSmokeError("rollup_config_failed", "Session Chain Rollup configuration failed");
			}
			await runWorkflowStage("chain-memory-compaction.phase-one", () =>
				client.prompt(prompts.phaseOne, providerTurnTimeoutMs),
			);
		await runWorkflowStage("chain-memory-compaction.rollover", () =>
			runSessionChangingCommand(
				client,
				"/chain rollover capability-smoke",
				commandTimeoutMs,
				"Session Chain advanced to ",
			),
		);
		await runWorkflowStage("chain-memory-compaction.phase-two", () =>
			client.prompt(prompts.phaseTwo, providerTurnTimeoutMs),
		);
		const compaction = await runWorkflowStage("chain-memory-compaction.compaction", () =>
			runRpcCompact(client, providerTurnTimeoutMs),
		);
		compactionSucceeded = isRecord(compaction) && compaction.summary !== undefined;
		await runWorkflowStage("chain-memory-compaction.phase-three", () =>
			client.prompt(prompts.phaseThree, providerTurnTimeoutMs),
		);
		const messages = await client.messages();
		priorPromptOccurrenceCount = countUserPromptEntries(await client.entries(), prompts.phaseTwo);
		singlePromptOccurrence = priorPromptOccurrenceCount === 1;
		usage = usageFromMessages(messages);
		toolNames = new Set(client.toolNames);
		const state = await client.state();
		if (!isRecord(state) || typeof state.sessionFile !== "string" || state.sessionFile.length === 0) {
			throw new Error("Session Chain smoke did not expose a durable successor session file");
		}
		resumedSession = state.sessionFile;
	}),
	);
	await runWorkflowStage("chain-memory-compaction.resumed-session", () =>
		withClient({ ...environment, session: resumedSession }, options, async (client) => {
		const providerTurnTimeoutMs = options.timeoutSeconds * 1000;
		const commandTimeoutMs = Math.min(providerTurnTimeoutMs, 120000);
		if (
			!(await runWorkflowStage("chain-memory-compaction.memory-remember", () =>
				client.command(
					`/memory remember ${buildMemoryRecallStatement(memoryRecallSentinel)}`,
					commandTimeoutMs,
					"Memory stored ",
				),
			))
		) {
			throw new WorkflowSmokeError("memory_remember_failed", "Memory remember command failed");
		}
		await runWorkflowStage("chain-memory-compaction.new-session", () =>
			runRpcNewSession(client, providerTurnTimeoutMs),
		);
		await runWorkflowStage("chain-memory-compaction.recall", () =>
			client.prompt(prompts.recall, providerTurnTimeoutMs),
		);
		const doctorCommands = [
			["chainDeep", "/chain doctor deep", "Session Chain doctor ", null],
			[
				"chainRepairProjections",
				"/chain doctor repair-projections",
				"Session Chain projections repaired:",
				null,
			],
			["memoryQuick", "/memory doctor", '\"kind\":\"memory-doctor\"', "memory-doctor"],
			[
				"memoryRepairProjections",
				"/memory doctor repair-projections",
				"Memory projections rebuilt:",
				null,
			],
			["skillQuick", "/skill doctor", '\"kind\":\"skill-doctor\"', "skill-doctor"],
		];
		for (const [id, command, expectedMessage, evidenceKind] of doctorCommands) {
			const notification = await runWorkflowStage(`chain-memory-compaction.doctor-${id}`, () =>
				client.commandNotification(command, commandTimeoutMs, expectedMessage),
			);
			doctorChecks[id] = notification.type === "info";
			doctorDiagnosticCodes[id] = evidenceKind
				? extractHistoricalEvidenceDiagnosticCodes(notification.message, evidenceKind)
				: [];
		}
		doctorStructural = Object.values(doctorChecks).every(Boolean);
		usage = addUsage(usage, usageFromMessages(await client.messages()));
		for (const name of client.toolNames) toolNames.add(name);
	}),
	);
	const sessionRoot = join(environment.projectDir, ".pi-xk", "sessions");
	const memoryRoot = join(environment.projectDir, ".pi-xk", "memory");
	const chainEvents = await findFiles(sessionRoot, (path) => path.endsWith("/events.jsonl"));
	const rollupPublished = await containsTextInFiles(chainEvents, '"eventType":"rollup_published"');
	const memoryEvents = await findFiles(memoryRoot, (path) => path.endsWith("/events.jsonl"));
	const workLog = (await fileExists(join(environment.projectDir, "work.log")))
		? await readFile(join(environment.projectDir, "work.log"), "utf8")
		: "";
	const answer = (await fileExists(join(environment.projectDir, "format.txt")))
		? await readFile(join(environment.projectDir, "format.txt"), "utf8")
		: "";
	const chainStructural = chainEvents.length > 0 && rollupPublished && workLog === "phase-one\nphase-two\nphase-three\n";
	const compactionStructural = compactionSucceeded && singlePromptOccurrence;
	const memoryObserved = toolNames.has("pi_xk_search_memory") && toolNames.has("pi_xk_read_memory");
	const memoryAnswerMatched = answer.trim() === memoryRecallSentinel;
	const memoryStructural = memoryEvents.length > 0 && memoryAnswerMatched;
	options.diagnostics.push({
		scenarioId: "chain-memory-compaction",
		checks: {
			chainEventsPresent: chainEvents.length > 0,
			rollupPublished,
			workLogMatched: workLog === "phase-one\nphase-two\nphase-three\n",
			compactionResultPresent: compactionSucceeded,
			priorPromptOccurrenceCount,
			memoryEventsPresent: memoryEvents.length > 0,
			memorySearchObserved: toolNames.has("pi_xk_search_memory"),
			memoryReadObserved: toolNames.has("pi_xk_read_memory"),
			memoryAnswerMatched,
			doctor: doctorChecks,
			doctorDiagnosticCodes,
		},
	});
	const elapsedSeconds = (Date.now() - startedAt) / 1000;
	return [
		runRecord({
			id: "real-chain-rollover-rollup-recovery",
			scenarioId: "chain-rollover-rollup-recovery",
			status: chainStructural ? "passed" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("chain-memory-compaction-v3"),
			elapsedSeconds,
			usage,
			structural: chainStructural,
			independent: true,
		}),
		runRecord({
			id: "real-compaction-continuation",
			scenarioId: "compaction-continuation",
			status: compactionStructural ? "passed" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("chain-memory-compaction-v3"),
			elapsedSeconds,
			usage,
			structural: compactionStructural,
			independent: true,
		}),
		runRecord({
			id: "real-ambient-memory-recall-and-review",
			scenarioId: "ambient-memory-recall-and-review",
			status: memoryStructural && memoryObserved ? "passed" : memoryStructural ? "inconclusive" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("chain-memory-compaction-v3"),
			elapsedSeconds,
			usage,
			structural: memoryStructural,
			independent: true,
		}),
		runRecord({
			id: "real-doctor-projection-repair",
			scenarioId: "doctor-projection-repair",
			status: doctorStructural ? "passed" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("chain-memory-compaction-v3"),
			elapsedSeconds,
			usage,
			structural: doctorStructural,
			independent: true,
		}),
	];
}

async function runGoalTask(root, options, runtimeId) {
	const environment = await createScenarioEnvironment(root, "goal-task");
	await writeFixture(environment.projectDir, {
		"requirements.md": "Create goal-proof.txt containing exactly goal-complete after verifying the request.\n",
		"task-source.md": "Return the exact phrase child-result after inspecting this file.\n",
	});
	const startedAt = Date.now();
	let toolNames = new Set();
	let usage = { inputTokensIncludingCache: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
	let goalTerminalEventType;
	let taskFacts = { eventsPresent: false, terminalEventType: undefined, terminalSummary: undefined, childSessionFiles: [] };
	let taskFinishToolObserved = false;
	let taskResultDelivered = false;
	await runWorkflowStage("goal-task.session", () =>
		withClient(environment, options, async (client) => {
			const providerTurnTimeoutMs = options.timeoutSeconds * 1000;
			const commandTimeoutMs = Math.min(providerTurnTimeoutMs, 120000);
			const goalRoot = join(environment.projectDir, ".pi-xk", "goals");
			const taskRoot = join(environment.projectDir, ".pi-xk", "tasks");
			await runWorkflowStage("goal-task.draft", () =>
				client.prompt(
					"/goal Read requirements.md, produce goal-proof.txt, verify it, and report only after the declared acceptance is satisfied.",
					providerTurnTimeoutMs,
				),
			);
			await runWorkflowStage("goal-task.confirm", () =>
				client.request({ type: "prompt", message: "/goal confirm" }, providerTurnTimeoutMs),
			);
			const goalTerminal = await runWorkflowStage("goal-task.goal-run", () =>
				waitForFactEvent(goalRoot, ["goal_ended", "goal_paused"], providerTurnTimeoutMs),
			);
			goalTerminalEventType = goalTerminal.eventType;
			if (goalTerminalEventType !== "goal_ended") {
				throw new WorkflowSmokeError("goal_not_ended", "Goal did not reach the required ended state");
			}
			await runWorkflowStage("goal-task.goal-idle", () => waitForRpcIdle(client, providerTurnTimeoutMs));
			usage = usageFromMessages(await client.messages());
			await runWorkflowStage("goal-task.task-session", () => runRpcNewSession(client, providerTurnTimeoutMs));
			await runWorkflowStage("goal-task.task-start", () =>
				client.commandNotification(
					"/task start Inspect task-source.md and finish with the exact verified result required by that file.",
					commandTimeoutMs,
					" started",
				),
			);
			await runWorkflowStage("goal-task.task-run", () =>
				waitForFactEvent(taskRoot, ["task_succeeded", "task_failed", "task_cancelled", "task_orphaned"], providerTurnTimeoutMs),
			);
			taskFacts = await inspectTaskEventFacts(taskRoot);
			for (const childSessionFile of taskFacts.childSessionFiles) {
				const resolvedChildSessionFile = resolve(childSessionFile);
				if (!isPathInsideRoot(environment.scenarioRoot, resolvedChildSessionFile)) continue;
				const observed = await waitUntil(
					async () =>
						(await fileExists(resolvedChildSessionFile)) &&
						(await sessionHasStructuredToolCall(resolvedChildSessionFile, "pi_xk_finish_task")),
					commandTimeoutMs,
				);
				if (observed) {
					taskFinishToolObserved = true;
					usage = addUsage(usage, await usageFromSessionFile(resolvedChildSessionFile));
					break;
				}
			}
			taskResultDelivered = await waitUntil(
				async () =>
					(await client.entries()).some(
						(entry) =>
							isRecord(entry) && entry.type === "custom_message" && entry.customType === "pi-xk.task-result.v1",
					),
				Math.min(commandTimeoutMs, 30000),
			);
			toolNames = new Set(client.toolNames);
		}),
	);
	const goalEvents = await findFiles(join(environment.projectDir, ".pi-xk", "goals"), (path) => path.endsWith("/events.jsonl"));
	const taskEvents = await findFiles(join(environment.projectDir, ".pi-xk", "tasks"), (path) => path.endsWith("/events.jsonl"));
	const goalProof = (await fileExists(join(environment.projectDir, "goal-proof.txt")))
		? await readFile(join(environment.projectDir, "goal-proof.txt"), "utf8")
		: "";
	const goalStructural =
		goalEvents.length > 0 &&
		goalTerminalEventType === "goal_ended" &&
		toolNames.has("pi_xk_submit_goal_draft") &&
		goalProof.trim() === "goal-complete";
	const taskStructural =
		taskFacts.eventsPresent &&
		taskFacts.terminalEventType === "task_succeeded" &&
		taskFacts.terminalSummary?.includes("child-result") === true &&
		taskFinishToolObserved &&
		taskResultDelivered;
	options.diagnostics.push({
		scenarioId: "goal-task",
		checks: {
			goalEventsPresent: goalEvents.length > 0,
			goalEnded: goalTerminalEventType === "goal_ended",
			goalDraftToolObserved: toolNames.has("pi_xk_submit_goal_draft"),
			goalProofMatched: goalProof.trim() === "goal-complete",
			taskEventsPresent: taskEvents.length > 0,
			taskSucceeded: taskFacts.terminalEventType === "task_succeeded",
			taskResultMatched: taskFacts.terminalSummary?.includes("child-result") === true,
			taskFinishToolObserved,
			taskResultDelivered,
		},
	});
	const elapsedSeconds = (Date.now() - startedAt) / 1000;
	return [
		runRecord({
			id: "real-goal-contract-continuity",
			scenarioId: "goal-contract-continuity",
			status: goalStructural ? "passed" : goalEvents.length > 0 ? "inconclusive" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("goal-task-v1"),
			elapsedSeconds,
			usage,
			structural: goalStructural,
			independent: true,
		}),
		runRecord({
			id: "real-task-child-delivery",
			scenarioId: "task-child-delivery",
			status: taskStructural ? "passed" : taskEvents.length > 0 ? "inconclusive" : "failed",
			options,
			runtimeId,
			taskDigest: sha256("goal-task-v1"),
			elapsedSeconds,
			usage,
			structural: taskStructural,
			independent: true,
		}),
	];
}

export function buildSkillSmokeChecks(skillEventsPresent, activeSkillPresent, skillReviewToolObserved) {
	return { skillEventsPresent, activeSkillPresent, skillReviewToolObserved };
}

async function runSkill(root, options, runtimeId) {
	const environment = await createScenarioEnvironment(root, "skill");
	await writeFixture(environment.projectDir, {
		"incoming/batch-a.ndjson": '{"kind":"alpha","value":1}\n{"kind":"beta","value":2}\n',
		"incoming/batch-b.ndjson": '{"kind":"gamma","value":3}\n',
		"requirements.md": [
			"This repository repeatedly receives NDJSON batches under incoming/.",
			"Establish a reusable project workflow for validating every incoming/*.ndjson file.",
			"Create scripts/validate-incoming.mjs; every non-empty line must parse as a JSON object, while arrays and primitives fail.",
			"Validate both current batches and write validation-report.txt containing exactly all-valid only after they pass.",
			"Document applicability, non-applicability, validation, and failure handling because future agent runs must repeat this workflow.",
			"",
		].join("\n"),
	});
	const startedAt = Date.now();
	let usage = { inputTokensIncludingCache: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
	let skillReviewToolObserved = false;
	let skillChangeApplied = false;
	let hotReloadReadObserved = false;
	let skillUseRecorded = false;
	let initialValidationMatched = false;
	let followUpValidationMatched = false;
	let skillDoctorOk = false;
	let skillDoctorDiagnosticCodes = [];
	await runWorkflowStage("skill.session", () =>
		withClient(environment, options, async (client) => {
			const providerTurnTimeoutMs = options.timeoutSeconds * 1000;
			const commandTimeoutMs = Math.min(providerTurnTimeoutMs, 120000);
			const skillRoot = join(environment.projectDir, ".pi-xk", "skills");
			const activeSkillRoot = join(environment.projectDir, ".pi", "skills");
			await runWorkflowStage("skill.implementation", () =>
				client.prompt(
					"Implement and verify requirements.md. Independently decide whether the completed evidence now satisfies Pi-XK's criteria for a reusable project Skill. If it does, stage an evidence-backed project Skill review with applicability, divergence conditions, validation, and failure handling; otherwise do not create one merely for this evaluation.",
					providerTurnTimeoutMs,
				),
			);
			usage = usageFromMessages(await client.messages());
			skillReviewToolObserved = client.toolNames.has("pi_xk_review_skills");
			initialValidationMatched =
				(await fileExists(join(environment.projectDir, "validation-report.txt"))) &&
				(await readFile(join(environment.projectDir, "validation-report.txt"), "utf8")).trim() === "all-valid";
			if (skillReviewToolObserved) {
				skillChangeApplied = Boolean(
					await waitUntil(
						async () => (await readEventObjects(skillRoot)).some((event) => event.eventType === "skill_change_applied"),
						commandTimeoutMs,
					),
				);
				const activeSkillPresent = Boolean(
					await waitUntil(
						async () => (await findFiles(activeSkillRoot, (path) => path.endsWith("/SKILL.md"))).length > 0,
						commandTimeoutMs,
					),
				);
				if (skillChangeApplied && activeSkillPresent) {
					await writeFixture(environment.projectDir, {
						"incoming/batch-c.ndjson": '{"kind":"delta","value":4}\n',
					});
					await runWorkflowStage("skill.hot-reload-session", () =>
						runRpcNewSession(client, providerTurnTimeoutMs),
					);
					await runWorkflowStage("skill.hot-reload-use", () =>
						client.prompt(
							"A new incoming/batch-c.ndjson has arrived. Use the relevant available project Skill if one exists, apply the established validation workflow, and write latest-result.txt containing exactly all-valid only after verification.",
							providerTurnTimeoutMs,
						),
					);
					usage = addUsage(usage, usageFromMessages(await client.messages()));
					hotReloadReadObserved = entriesHaveManagedSkillRead(await client.entries(), environment.projectDir);
					followUpValidationMatched =
						(await fileExists(join(environment.projectDir, "latest-result.txt"))) &&
						(await readFile(join(environment.projectDir, "latest-result.txt"), "utf8")).trim() === "all-valid";
					if (hotReloadReadObserved) {
						skillUseRecorded = Boolean(
							await waitUntil(
								async () => (await readEventObjects(skillRoot)).some((event) => event.eventType === "skill_use_recorded"),
								Math.min(commandTimeoutMs, 30000),
							),
						);
					}
					const doctor = await runWorkflowStage("skill.doctor", () =>
						client.commandNotification("/skill doctor", commandTimeoutMs, '"kind":"skill-doctor"'),
					);
					skillDoctorDiagnosticCodes = extractHistoricalEvidenceDiagnosticCodes(doctor.message, "skill-doctor");
					skillDoctorOk = doctor.type === "info" && skillDoctorDiagnosticCodes.length === 0;
				}
			}
		}),
	);
	const skillEvents = await findFiles(join(environment.projectDir, ".pi-xk", "skills"), (path) => path.endsWith("/events.jsonl"));
	const activeSkills = await findFiles(join(environment.projectDir, ".pi", "skills"), (path) => path.endsWith("/SKILL.md"));
	const structural =
		skillEvents.length > 0 &&
		activeSkills.length > 0 &&
		skillReviewToolObserved &&
		skillChangeApplied &&
		initialValidationMatched &&
		hotReloadReadObserved &&
		skillUseRecorded &&
		followUpValidationMatched &&
		skillDoctorOk;
	options.diagnostics.push({
		scenarioId: "skill",
		checks: {
			...buildSkillSmokeChecks(skillEvents.length > 0, activeSkills.length > 0, skillReviewToolObserved),
			skillChangeApplied,
			initialValidationMatched,
			hotReloadReadObserved,
			skillUseRecorded,
			followUpValidationMatched,
			skillDoctorOk,
			skillDoctorDiagnosticCodes,
		},
	});
	const elapsedSeconds = (Date.now() - startedAt) / 1000;
	return [
		runRecord({
			id: "real-skill-evolution-and-reload",
			scenarioId: "skill-evolution-and-reload",
			status: structural ? "passed" : skillReviewToolObserved ? "failed" : "inconclusive",
			options,
			runtimeId,
			taskDigest: sha256("skill-v2"),
			elapsedSeconds,
			usage,
			structural,
			independent: true,
		}),
	];
}

async function atomicWrite(path, content) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	requireSafeOutput(options.out);
	await Promise.all([assertFile(options.extension, "Pi-XK extension"), assertFile(options.cli, "Pi CLI")]);
	const credentialName = providerEnvironmentKey.get(options.provider);
	if (!credentialName) throw new Error(`Unsupported provider for workflow smoke: ${options.provider}`);
	if (!process.env[credentialName]) throw new Error(`Required provider credential is not available in this process: ${credentialName}`);
	if (await fileExists(options.out)) {
		if (!options.force) throw new Error(`Output already exists: ${options.out}; pass --force to replace it`);
		await rm(options.out, { recursive: true, force: true });
	}
	const stage = join(dirname(options.out), `.${basename(options.out)}.${randomUUID()}`);
	await mkdir(stage, {
		recursive: true,
		mode: 0o700,
	});
	try {
		const piVersion = JSON.parse(await readFile(codingAgentPackagePath, "utf8")).version;
		if (typeof piVersion !== "string") throw new Error("Pi coding-agent version is invalid");
		options.piVersion = piVersion;
		options.diagnostics = [];
		const runtimeId = await computeWorkflowRuntimeId(workspaceRoot, piVersion);
		const selected = options.scenario === "all" ? ["chain-memory-compaction", "goal-task", "skill"] : [options.scenario];
		const runs = [];
		for (const scenario of selected) {
			const scenarioRuns = await runWorkflowStage(`${scenario}.scenario`, async () => {
				if (scenario === "chain-memory-compaction") return runChainMemoryCompaction(stage, options, runtimeId);
				if (scenario === "goal-task") return runGoalTask(stage, options, runtimeId);
				return runSkill(stage, options, runtimeId);
			});
			runs.push(...scenarioRuns);
		}
		const report = `${JSON.stringify(
			{ schema: reportSchema, reportKind: "workflow-smoke", generatedAt: new Date().toISOString(), runs },
			null,
			2,
		)}\n`;
		await mkdir(options.out, { recursive: true, mode: 0o700 });
		await atomicWrite(join(options.out, "capability-report.json"), report);
		await atomicWrite(
			join(options.out, "diagnostics.json"),
			`${JSON.stringify(
				{
					schema: "pi-xk.workflow-smoke-diagnostics.v1",
					generatedAt: new Date().toISOString(),
					scenarios: options.diagnostics,
				},
				null,
				2,
			)}\n`,
		);
		await rm(stage, { recursive: true, force: true });
		console.log(`Pi-XK workflow smoke report created at ${join(options.out, "capability-report.json")}`);
	} catch (error) {
		await rm(stage, { recursive: true, force: true });
		await mkdir(options.out, { recursive: true, mode: 0o700 });
		const failure = { schema: "pi-xk.workflow-smoke-failure.v1", code: failureCode(error) };
		if (error instanceof WorkflowSmokeError && error.stage !== undefined) failure.stage = error.stage;
		const processExit = rpcExitDetails(error);
		if (processExit) failure.processExit = processExit;
		await atomicWrite(
			join(options.out, "failure.json"),
			`${JSON.stringify(failure, null, 2)}\n`,
		);
		throw new Error(`Pi-XK workflow smoke failed: ${failureCode(error)}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
