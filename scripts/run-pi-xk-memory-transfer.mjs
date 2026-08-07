import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildIsolatedProcessEnvironment,
	classifyProviderError,
	computeWorkflowRuntimeId,
	RpcProcess,
} from "./run-pi-xk-workflow-smoke.mjs";
import {
	evaluateMemoryTransferReport,
	memoryTransferPlanDigest,
	validateMemoryTransferPlan,
} from "./evaluate-pi-xk-memory-transfer.mjs";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPlan = join(workspaceRoot, "evaluation", "capabilities", "memory-transfer-plan.json");
const providerEnvironmentKey = new Map([["deepseek", "DEEPSEEK_API_KEY"]]);
const allArms = ["pi-native", "pi-xk-memory-off", "pi-xk-placebo", "pi-xk-learned"];
const allEpisodes = ["learning", "exact-reuse", "similar-transfer", "changed-rule", "unrelated"];
const defaultCliRelativePath = join("packages", "coding-agent", "dist", "cli.js");
const defaultExtensionRelativePath = join("packages", "pi-xk-extension", "dist", "extension.js");
const requireModule = createRequire(import.meta.url);
const memoryRoutingPrefix =
	"Durable project convention for canonical record handling. This title is routing metadata only and intentionally omits exact operations; read the full Memory before applying it. ";

export const MEMORY_TRANSFER_PROFILE_SETTINGS = { compaction: { keepRecentTokens: 4_000 } };

class MemoryTransferProviderBlockedError extends Error {
	constructor(code) {
		super(`Memory transfer provider run is inconclusive: ${code}`);
		this.code = code;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonEmptyString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function asNonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usage() {
	console.log(`Usage: node scripts/run-pi-xk-memory-transfer.mjs --out <dir> [options]

Options:
  --plan <path>             Registered transfer plan (default: evaluation/capabilities/memory-transfer-plan.json)
  --provider <name>         Provider (default: plan provider)
  --model <id>              Model (default: plan model)
  --thinking <level>        Thinking level (default: plan thinking)
  --attempts <count>        Independent attempts (default: 1; plan requires 3 for a claim)
  --arms <ids>              Comma-separated diagnostic arm subset
  --episodes <ids>          Comma-separated diagnostic episode subset; include learning before seeded episodes
  --timeout <seconds>       Per-provider-turn timeout (default: plan wallSeconds)
  --runtime-root <path>     Runtime worktree whose built artifacts are under test
  --extension <path>        Built Pi-XK extension entrypoint inside runtime root
  --cli <path>              Built Pi CLI entrypoint inside runtime root
  --force                   Replace a previous output directory
  --dry-run                 Write only a provider-run cost/count estimate`);
}

function parseArgs(argv) {
	let out;
	let plan = defaultPlan;
	let provider;
	let model;
	let thinking;
	let attempts = 1;
	let arms = [...allArms];
	let episodes = [...allEpisodes];
	let timeoutSeconds;
	let runtimeRoot = workspaceRoot;
	let extension;
	let cli;
	let force = false;
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--out") out = argv[++index];
		else if (argument === "--plan") plan = argv[++index];
		else if (argument === "--provider") provider = argv[++index];
		else if (argument === "--model") model = argv[++index];
		else if (argument === "--thinking") thinking = argv[++index];
		else if (argument === "--attempts") attempts = Number(argv[++index]);
		else if (argument === "--arms") arms = parseMemoryTransferSelection(argv[++index], allArms, "arms");
		else if (argument === "--episodes") episodes = parseMemoryTransferSelection(argv[++index], allEpisodes, "episodes");
		else if (argument === "--timeout") timeoutSeconds = Number(argv[++index]);
		else if (argument === "--runtime-root") runtimeRoot = argv[++index];
		else if (argument === "--extension") extension = argv[++index];
		else if (argument === "--cli") cli = argv[++index];
		else if (argument === "--force") force = true;
		else if (argument === "--dry-run") dryRun = true;
		else if (argument === "--help" || argument === "-h") return { help: true };
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!out) throw new Error("--out is required");
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error("--attempts must be an integer from 1 to 10");
	if (
		arms.some((arm) => arm === "pi-xk-placebo" || arm === "pi-xk-learned") &&
		episodes.some((episode) => episode !== "learning") &&
		!episodes.includes("learning")
	) {
		throw new Error("Diagnostic placebo/learned episodes require the learning episode to seed Memory first");
	}
	const runtime = resolveMemoryTransferRuntime({
		runtimeRoot,
		cli,
		extension: extension === "none" ? null : extension,
		arms,
	});
	return {
		help: false,
		out: resolve(out),
		plan: resolve(plan),
		provider,
		model,
		thinking,
		attempts,
		arms,
		episodes,
		timeoutSeconds,
		runtimeRoot: runtime.root,
		extension: runtime.extension,
		cli: runtime.cli,
		force,
		dryRun,
	};
}

export function resolveMemoryTransferRuntime({ runtimeRoot = workspaceRoot, cli, extension, arms = allArms }) {
	const root = resolve(runtimeRoot);
	const resolvedCli = cli === undefined ? join(root, defaultCliRelativePath) : resolve(cli);
	const resolvedExtension =
		extension === null
			? null
			: extension === undefined
				? join(root, defaultExtensionRelativePath)
				: resolve(extension);
	if (!isPathInsideRoot(root, resolvedCli)) throw new Error("Memory transfer CLI must be inside the runtime root");
	if (resolvedExtension !== null && !isPathInsideRoot(root, resolvedExtension)) {
		throw new Error("Memory transfer extension must be inside the runtime root");
	}
	if (arms.some((arm) => arm.startsWith("pi-xk")) && resolvedExtension === null) {
		throw new Error("A Pi-XK evaluation arm requires a Pi-XK extension");
	}
	return { root, cli: resolvedCli, extension: resolvedExtension };
}

export function parseMemoryTransferSelection(raw, allowed, label) {
	if (typeof raw !== "string" || raw.trim().length === 0) throw new Error(`--${label} must not be empty`);
	const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
	if (requested.length === 0 || new Set(requested).size !== requested.length) {
		throw new Error(`--${label} must contain unique values`);
	}
	for (const value of requested) {
		if (!allowed.includes(value)) throw new Error(`unsupported ${label} value: ${value}`);
	}
	return allowed.filter((value) => requested.includes(value));
}

export function assertSafeOutput(path, runtimeRoot) {
	const output = resolve(path);
	const runtime = resolve(runtimeRoot);
	const home = resolve(homedir());
	const temporary = resolve(tmpdir());
	const overlaps = (root) =>
		output === root || isPathInsideRoot(root, output) || isPathInsideRoot(output, root);
	const insideTemporaryDirectory = isPathInsideRoot(temporary, output);
	if (
		output === resolve("/") ||
		output === temporary ||
		overlaps(workspaceRoot) ||
		overlaps(runtime) ||
		(overlaps(home) && !insideTemporaryDirectory)
	) {
		throw new Error(
			"Memory transfer output must not overlap the evaluation worktree, runtime worktree, home directory, filesystem root, or temporary-directory root",
		);
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

async function atomicWrite(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function buildTaskPrompt(episodeId) {
	switch (episodeId) {
		case "learning":
		case "exact-reuse":
			return "Implement src/records/canonicalize.cjs according to the authoritative project contract. Inspect the project sources, modify only the needed implementation, run the available local checks, and stop when the behavior is verified.";
		case "similar-transfer":
			return "Implement src/indexing/derive-record-route.cjs according to the established project convention for canonical record identifiers. Inspect authoritative sources, modify only the needed implementation, run the available local checks, and stop when the behavior is verified.";
		case "changed-rule":
			return "Implement src/records/canonicalize.cjs according to the current authoritative project contract. Historical conventions may be obsolete, so verify current sources before modifying the implementation, then run the available local checks.";
		case "unrelated":
			return "Implement src/math/inclusive-range.cjs according to the current project sources and visible checks. This is an independent utility; modify only the needed implementation and verify it locally.";
		default:
			throw new Error(`Unsupported transfer episode: ${episodeId}`);
	}
}

function policyText(episodeId) {
	if (episodeId === "changed-rule") {
		return [
			"# Canonical record key policy Q18",
			"",
			"This is the current authoritative policy for canonical record identifiers.",
			"1. Convert input to a string and apply Unicode NFKC normalization.",
			"2. Trim leading and trailing whitespace, then lowercase.",
			"3. Replace every run of internal whitespace with `~`.",
			"4. Preserve hyphens and reject an empty result with TypeError.",
		].join("\n");
	}
	return [
		"# Canonical record key policy Q17",
		"",
		"This is the authoritative policy for canonical record identifiers.",
		"1. Convert input to a string and apply Unicode NFKC normalization.",
		"2. Trim leading and trailing whitespace, then lowercase.",
		"3. Replace every run of internal whitespace with `.`.",
		"4. Preserve hyphens and reject an empty result with TypeError.",
	].join("\n");
}

function taskText(episodeId) {
	return [
		"# Evaluation task",
		"",
		buildTaskPrompt(episodeId),
		"",
		"The verifier is outside this project. Do not create a second implementation or a new dependency.",
	].join("\n");
}

function baseFixtureFiles(episodeId) {
	const canonicalStub = [
		'"use strict";',
		"",
		"// Implement the project policy. The external verifier covers Unicode, whitespace, hyphens, and empty input.",
		"function canonicalRecordKey(_value) {",
		'\tthrow new Error("not implemented");',
		"}",
		"module.exports = { canonicalRecordKey };",
	].join("\n");
	const routeStub = [
		'"use strict";',
		"",
		"function deriveRecordRoute(_tenant, _record) {",
		'\tthrow new Error("not implemented");',
		"}",
		"module.exports = { deriveRecordRoute };",
	].join("\n");
	const rangeStub = [
		'"use strict";',
		"",
		"function inclusiveRange(_start, _end) {",
		'\tthrow new Error("not implemented");',
		"}",
		"module.exports = { inclusiveRange };",
	].join("\n");
	return {
		"TASK.md": taskText(episodeId),
		"README.md": [
			"# Isolated project fixture",
			"",
			"Authoritative component policies live under docs/standards.",
			"The verifier is external and is not present in this directory.",
		].join("\n"),
		"package.json": JSON.stringify({ name: "pi-xk-memory-transfer-fixture", private: true }, null, 2),
		"docs/README.md": [
			"# Project sources",
			"",
			"Canonical record handling follows docs/standards/canonical-record-keys.md.",
			"Display labels and range utilities have separate policies.",
		].join("\n"),
		"docs/standards/canonical-record-keys.md": policyText(episodeId),
		"docs/standards/display-labels.md": "# Display label policy\n\nDisplay labels are presentation-only and may be uppercase.\n",
		"docs/standards/range-utilities.md": "# Range utility policy\n\nRanges are inclusive and preserve ascending integer order.\n",
		"docs/notes/legacy-format.md": "# Legacy note\n\nThis historical note is not authoritative for current record keys.\n",
		"src/records/canonicalize.cjs": canonicalStub,
		"src/indexing/derive-record-route.cjs": routeStub,
		"src/math/inclusive-range.cjs": rangeStub,
		"test/visible-check.cjs": [
			'"use strict";',
			"const { canonicalRecordKey } = require(\"../src/records/canonicalize.cjs\");",
			"const { deriveRecordRoute } = require(\"../src/indexing/derive-record-route.cjs\");",
			"const { inclusiveRange } = require(\"../src/math/inclusive-range.cjs\");",
			"if (typeof canonicalRecordKey !== \"function\" || typeof deriveRecordRoute !== \"function\" || typeof inclusiveRange !== \"function\") process.exit(1);",
			"console.log(\"visible interface checks passed\");",
		].join("\n"),
	};
}

async function writeFixture(projectDir, files) {
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(projectDir, relativePath);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, `${content}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

async function resetProject(projectDir, episodeId) {
	for (const relativePath of ["TASK.md", "README.md", "package.json", "docs", "src", "test"]) {
		await rm(join(projectDir, relativePath), { recursive: true, force: true });
	}
	await writeFixture(projectDir, baseFixtureFiles(episodeId));
}

export function buildMatchedMemoryStatements() {
	const learned = `${memoryRoutingPrefix}Verified learning evidence: Q17 canonical record keys apply Unicode NFKC, trim and lowercase input, replace internal whitespace runs with a period, preserve hyphens, and reject an empty result with TypeError. This applies to canonical record identifiers across the project.`;
	const placebo = `${memoryRoutingPrefix}Verified placebo evidence: U42 display labels apply ASCII uppercase formatting, preserve visual separators, and reject an empty label. This applies only to presentation labels and must not be used for canonical record identifiers.`;
	const targetLength = Math.max([...learned].length, [...placebo].length) + 160;
	return {
		learned: learned.padEnd(targetLength, " "),
		placebo: placebo.padEnd(targetLength, " "),
	};
}

function clearRequireCache(projectDir) {
	for (const key of Object.keys(requireModule.cache)) {
		if (isPathInsideRoot(projectDir, resolve(key))) delete requireModule.cache[key];
	}
}

function requireFixtureModule(projectDir, relativePath) {
	const path = resolve(projectDir, relativePath);
	if (!isPathInsideRoot(projectDir, path)) throw new Error("Verifier target escaped project root");
	clearRequireCache(projectDir);
	return requireModule(path);
}

function assertCanonical(canonicalRecordKey, separator) {
	if (typeof canonicalRecordKey !== "function") return false;
	const cases = [
		["  Ａlpha   Beta  ", `alpha${separator}beta`],
		["Café-Order", "café-order"],
		["alpha-beta", "alpha-beta"],
	];
	for (const [input, expected] of cases) {
		if (canonicalRecordKey(input) !== expected) return false;
	}
	try {
		canonicalRecordKey("   ");
		return false;
	} catch (error) {
		if (!(error instanceof TypeError)) return false;
	}
	return true;
}

export async function verifyEpisode(projectDir, episodeId) {
	try {
		if (["learning", "exact-reuse", "changed-rule"].includes(episodeId)) {
			const module = requireFixtureModule(projectDir, "src/records/canonicalize.cjs");
			return {
				passed: assertCanonical(module.canonicalRecordKey, episodeId === "changed-rule" ? "~" : "."),
				verifierDigest: sha256(`pi-xk-memory-transfer-verifier.v1:${episodeId}`),
			};
		}
		if (episodeId === "similar-transfer") {
			const module = requireFixtureModule(projectDir, "src/indexing/derive-record-route.cjs");
			if (typeof module.deriveRecordRoute !== "function") return { passed: false, verifierDigest: sha256(`pi-xk-memory-transfer-verifier.v1:${episodeId}`) };
			const passed =
				module.deriveRecordRoute("  Ａcme  ", "Café-Order") === "acme/café-order" &&
				module.deriveRecordRoute("north", "alpha-beta") === "north/alpha-beta";
			return { passed, verifierDigest: sha256(`pi-xk-memory-transfer-verifier.v1:${episodeId}`) };
		}
		const module = requireFixtureModule(projectDir, "src/math/inclusive-range.cjs");
		const passed =
			typeof module.inclusiveRange === "function" &&
			JSON.stringify(module.inclusiveRange(2, 5)) === JSON.stringify([2, 3, 4, 5]) &&
			JSON.stringify(module.inclusiveRange(4, 4)) === JSON.stringify([4]);
		return { passed, verifierDigest: sha256(`pi-xk-memory-transfer-verifier.v1:${episodeId}`) };
	} catch {
		return { passed: false, verifierDigest: sha256(`pi-xk-memory-transfer-verifier.v1:${episodeId}`) };
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

function assistantToolCalls(entries) {
	const calls = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") continue;
		if (!Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content) {
			if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
			calls.push({
				id: typeof part.id === "string" && part.id.length > 0 ? part.id : null,
				name: part.name,
				arguments: isRecord(part.arguments) ? part.arguments : {},
				timestamp: entry.timestamp,
			});
		}
	}
	return calls;
}

function secondsSince(startedAt, timestamp) {
	if (typeof timestamp !== "string") return null;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return null;
	return Math.max(0, (parsed - startedAt) / 1000);
}

function argumentPath(argumentsValue) {
	return isRecord(argumentsValue) && typeof argumentsValue.path === "string" ? argumentsValue.path : null;
}

function pathMatches(path, expected) {
	if (typeof path !== "string") return false;
	const normalized = path.replaceAll("\\", "/");
	return normalized === expected || normalized.endsWith(`/${expected}`);
}

function toolResultMessage(value) {
	if (!isRecord(value)) return null;
	const message = isRecord(value.message) && value.type === "message" ? value.message : value;
	if (
		message.role !== "toolResult" ||
		typeof message.toolCallId !== "string" ||
		message.toolCallId.length === 0 ||
		typeof message.toolName !== "string"
	) {
		return null;
	}
	return {
		toolName: message.toolName,
		isError: message.isError === true,
		details: isRecord(message.details) ? message.details : null,
	};
}

function toolResultsByCallId(...sources) {
	const results = new Map();
	for (const source of sources) {
		if (!Array.isArray(source)) continue;
		for (const value of source) {
			const message = toolResultMessage(value);
			if (!message) continue;
			const toolCallId = isRecord(value.message) && value.type === "message" ? value.message.toolCallId : value.toolCallId;
			if (typeof toolCallId !== "string") continue;
			const existing = results.get(toolCallId);
			// Entries are the append-only source and retain results that compaction
			// removes from the active message context. Prefer a duplicate that still
			// carries structured details when an older runtime projection omitted them.
			if (!existing || (existing.details === null && message.details !== null)) results.set(toolCallId, message);
		}
	}
	return results;
}

function memoryIdsFromSearchDetails(details) {
	const candidate = isRecord(details.result) ? details.result : details;
	if (!Array.isArray(candidate.items)) return [];
	return candidate.items
		.filter((item) => isRecord(item) && typeof item.memoryId === "string" && item.memoryId.length > 0)
		.map((item) => item.memoryId);
}

function memoryIdsFromReadDetails(details) {
	const candidate = isRecord(details.result) ? details.result : details;
	if (!Array.isArray(candidate.memories)) return [];
	return candidate.memories
		.map((memory) => (isRecord(memory) && isRecord(memory.revision) ? memory.revision.memoryId : undefined))
		.filter((memoryId) => typeof memoryId === "string" && memoryId.length > 0);
}

export function inspectEpisodeEntries(
	entries,
	{ messages = entries, startedAt, projectDir, authoritativePath, relatedMemoryId, publishedReview },
) {
	const calls = assistantToolCalls(entries);
	// `messages` is the current compaction-aware context and may omit an earlier
	// D1 result. Pair calls with the append-only entries first, then use the
	// current messages as a details-preserving fallback for older runtimes.
	const resultsByCallId = toolResultsByCallId(entries, messages);
	const reads = new Map();
	const d1CandidateIds = new Set();
	let firstRelevantEvidenceSeconds = null;
	let d1SearchCalls = 0;
	let d2ReadCalls = 0;
	let d3EvidenceCalls = 0;
	let reviewCalls = 0;
	let reviewAction = null;
	let relatedMemoryRead = false;
	for (const call of calls) {
		const result = call.id === null ? undefined : resultsByCallId.get(call.id);
		const successfulResult = result?.toolName === call.name && !result.isError ? result : undefined;
		if (call.name === "pi_xk_search_memory") {
			d1SearchCalls += 1;
			if (successfulResult?.details) {
				for (const memoryId of memoryIdsFromSearchDetails(successfulResult.details)) d1CandidateIds.add(memoryId);
			}
		}
		if (call.name === "pi_xk_read_memory") {
			d2ReadCalls += 1;
			const ids = Array.isArray(call.arguments.memoryIds) ? call.arguments.memoryIds : [];
			const returnedIds = successfulResult?.details ? memoryIdsFromReadDetails(successfulResult.details) : [];
			if (relatedMemoryId && ids.includes(relatedMemoryId) && returnedIds.includes(relatedMemoryId)) {
				relatedMemoryRead = true;
				if (firstRelevantEvidenceSeconds === null) firstRelevantEvidenceSeconds = secondsSince(startedAt, call.timestamp);
			}
		}
		if (call.name === "pi_xk_expand_memory_evidence") d3EvidenceCalls += 1;
		if (call.name === "pi_xk_review_memory") {
			reviewCalls += 1;
			if (typeof call.arguments.action === "string") reviewAction = call.arguments.action;
		}
		if (call.name === "read") {
			const path = argumentPath(call.arguments);
			if (path) {
				const resolved = resolve(projectDir, path);
				if (isPathInsideRoot(projectDir, resolved)) reads.set(resolved, (reads.get(resolved) ?? 0) + 1);
				if (pathMatches(path, authoritativePath) && firstRelevantEvidenceSeconds === null) {
					firstRelevantEvidenceSeconds = secondsSince(startedAt, call.timestamp);
				}
			}
		}
		if (["bash", "find", "grep", "ls"].includes(call.name) && firstRelevantEvidenceSeconds === null) {
			const serialized = JSON.stringify(call.arguments);
			if (serialized.includes(authoritativePath)) firstRelevantEvidenceSeconds = secondsSince(startedAt, call.timestamp);
		}
	}
	const duplicateFileReads = [...reads.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
	const explorationCalls = calls.filter((call) => ["read", "bash", "find", "grep", "ls"].includes(call.name)).length;
	return {
		toolCalls: calls.length,
		explorationCalls,
		fileReadCalls: calls.filter((call) => call.name === "read").length,
		duplicateFileReads,
		firstRelevantEvidenceSeconds,
		d1SearchCalls,
		d2ReadCalls,
		d3EvidenceCalls,
		d1CandidateCount: d1CandidateIds.size,
		reviewCalls,
		relatedMemoryRead,
		relatedCandidateExposed: relatedMemoryId !== null && d1CandidateIds.has(relatedMemoryId),
		publishedReview: publishedReview === true,
		reviewAction,
	};
}

async function readEventObjects(root) {
	const paths = [];
	async function walk(path) {
		if (!(await exists(path))) return;
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) throw new Error(`Memory transfer fixture cannot follow a symbolic link: ${path}`);
		if (stat.isFile()) {
			if (path.endsWith("/events.jsonl")) paths.push(path);
			return;
		}
		for (const entry of await readdir(path, { withFileTypes: true })) await walk(join(path, entry.name));
	}
	await walk(root);
	const events = [];
	for (const path of paths.sort()) {
		for (const line of (await readFile(path, "utf8")).split("\n")) {
			if (!line) continue;
			try {
				const value = JSON.parse(line);
				if (isRecord(value) && typeof value.eventType === "string") events.push(value);
			} catch {
				// Ignore an incomplete final line while the projection is settling.
			}
		}
	}
	return events;
}

async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result) return result;
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
	}
	return predicate();
}

async function waitForMemoryApplied(projectDir, memoryId, timeoutMs) {
	return Boolean(
		await waitUntil(async () => {
			const events = await readEventObjects(join(projectDir, ".pi-xk", "memory"));
			return events.some(
				(event) => event.eventType === "memory_change_applied" && JSON.stringify(event).includes(memoryId),
			);
		}, timeoutMs),
	);
}

function eventIdentity(event) {
	if (typeof event.eventId === "string") return `id:${event.eventId}`;
	if (typeof event.hash === "string") return `hash:${event.hash}`;
	return `sequence:${String(event.sequence ?? "")}:${String(event.eventType ?? "")}`;
}

export function inspectReviewPublication(beforeEvents, afterEvents, { reviewRequested }) {
	const baseline = new Set(beforeEvents.map(eventIdentity));
	const baselineSequence = beforeEvents.reduce(
		(maximum, event) => (typeof event.sequence === "number" ? Math.max(maximum, event.sequence) : maximum),
		-1,
	);
	const appended = afterEvents.filter(
		(event) => !baseline.has(eventIdentity(event)) || (typeof event.sequence === "number" && event.sequence > baselineSequence),
	);
	const runIds = new Set(
		appended
			.filter((event) => event.eventType === "reconstruction_recorded" && isRecord(event.payload) && typeof event.payload.runId === "string")
			.map((event) => event.payload.runId),
	);
	const belongsToObservedRun = (event) =>
		runIds.size === 0 || (isRecord(event.payload) && typeof event.payload.runId === "string" && runIds.has(event.payload.runId));
	const applied = appended.find(
		(event) => event.eventType === "memory_review_applied" && isRecord(event.payload) && event.payload.captureId === null && belongsToObservedRun(event),
	);
	if (applied) return { reviewPublication: "applied", reviewFailureCode: null };
	const failed = appended.find((event) => event.eventType === "memory_review_failed" && belongsToObservedRun(event));
	if (failed) {
		const errorCode = isRecord(failed.payload) && typeof failed.payload.errorCode === "string" ? failed.payload.errorCode : "review_failed";
		return { reviewPublication: "failed", reviewFailureCode: errorCode };
	}
	return reviewRequested
		? { reviewPublication: "failed", reviewFailureCode: "review_not_observed" }
		: { reviewPublication: "none", reviewFailureCode: null };
}

async function waitForReviewPublication(projectDir, beforeEvents, reviewRequested, timeoutMs) {
	if (!reviewRequested) return { reviewPublication: "none", reviewFailureCode: null };
	const observed = await waitUntil(async () => {
		const afterEvents = await readEventObjects(join(projectDir, ".pi-xk", "memory"));
		const result = inspectReviewPublication(beforeEvents, afterEvents, { reviewRequested: false });
		return result.reviewPublication === "none" ? undefined : result;
	}, timeoutMs);
	return observed ?? inspectReviewPublication(beforeEvents, await readEventObjects(join(projectDir, ".pi-xk", "memory")), { reviewRequested: true });
}

function memoryIdFromNotification(notification) {
	if (!isRecord(notification) || typeof notification.message !== "string") return null;
	const match = notification.message.match(/Memory stored (memory_[a-z0-9]+)/u);
	return match?.[1] ?? null;
}

async function readPiVersion(runtimeRoot) {
	const packageValue = JSON.parse(await readFile(join(runtimeRoot, "packages", "coding-agent", "package.json"), "utf8"));
	return nonEmptyString(packageValue.version, "coding-agent package version");
}

async function assertRuntimeEntrypoint(runtimeRoot, path, label) {
	if (!isPathInsideRoot(runtimeRoot, path)) throw new Error(`${label} must be inside the runtime root`);
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file inside the runtime root`);
}

export async function computeMemoryTransferRuntimeId({ root, cli, extension }) {
	await assertRuntimeEntrypoint(root, cli, "Memory transfer CLI");
	if (extension !== null) await assertRuntimeEntrypoint(root, extension, "Memory transfer extension");
	const version = await readPiVersion(root);
	const workflowRuntimeId = await computeWorkflowRuntimeId(root, version);
	const selectedEntrypoints = {
		cli: relative(root, cli).replaceAll("\\", "/"),
		extension: extension === null ? null : relative(root, extension).replaceAll("\\", "/"),
	};
	const digest = createHash("sha256")
		.update("pi-xk.memory-transfer-runtime.v1\0")
		.update(workflowRuntimeId)
		.update("\0")
		.update(JSON.stringify(selectedEntrypoints))
		.digest("hex");
	return `pi-${version}-memory-transfer-runtime-sha256:${digest}`;
}

async function createArmEnvironment(root, attemptId, armId) {
	const armRoot = join(root, attemptId, armId);
	const projectDir = join(armRoot, "project");
	const profileDir = join(armRoot, "profile");
	const homeDir = join(armRoot, "home");
	await Promise.all([
		mkdir(projectDir, { recursive: true, mode: 0o700 }),
		mkdir(profileDir, { recursive: true, mode: 0o700 }),
		mkdir(homeDir, { recursive: true, mode: 0o700 }),
	]);
	await writeFile(join(profileDir, "settings.json"), `${JSON.stringify(MEMORY_TRANSFER_PROFILE_SETTINGS, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return { armRoot, projectDir, profileDir, homeDir, memoryId: null };
}

function clientOptions(environment, options, armId, episodeId) {
	return {
		cli: options.cli,
		extension: armId.startsWith("pi-xk") ? options.extension : null,
		provider: options.provider,
		model: options.model,
		thinking: options.thinking,
		sessionDir: join(environment.armRoot, "sessions", episodeId),
		projectDir: environment.projectDir,
		profileDir: environment.profileDir,
		homeDir: environment.homeDir,
		timeoutSeconds: options.timeoutSeconds,
	};
}

async function configureMemory(client, armId, episodeId, hasSeed) {
	if (!armId.startsWith("pi-xk")) return;
	const timeoutMs = 120_000;
	await client.command("/skill config off", timeoutMs);
	if (armId === "pi-xk-memory-off") {
		await client.command("/memory config off", timeoutMs);
		await client.command("/memory config ambient off", timeoutMs);
		await client.command("/memory config evolution off", timeoutMs);
		return;
	}
	await client.command("/memory config on", timeoutMs);
	if (episodeId === "learning" || !hasSeed) {
		await client.command("/memory config ambient off", timeoutMs);
		await client.command("/memory config evolution off", timeoutMs);
		return;
	}
	await client.command("/memory config ambient on", timeoutMs);
	await client.command("/memory config evolution on", timeoutMs);
}

async function seedMemory(client, environment, armId) {
	const statements = buildMatchedMemoryStatements();
	const statement = armId === "pi-xk-learned" ? statements.learned : statements.placebo;
	const notification = await client.commandNotification(`/memory remember ${statement}`, 120_000, "Memory stored ");
	const memoryId = memoryIdFromNotification(notification);
	if (!memoryId) throw new Error("Memory seed did not expose a Memory ID");
	if (!(await waitForMemoryApplied(environment.projectDir, memoryId, 30_000))) {
		throw new Error("Memory seed did not reach memory_change_applied");
	}
	await client.command("/memory config ambient on", 120_000);
	await client.command("/memory config evolution on", 120_000);
	return memoryId;
}

async function runEpisode(environment, options, armId, episodeId, memoryId) {
	await resetProject(environment.projectDir, episodeId);
	const client = new RpcProcess(clientOptions(environment, options, armId, episodeId));
	let entries = [];
	let usage = { inputTokensIncludingCache: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
	let state;
	let promptFailureCode = null;
	let promptStartedAt = Date.now();
	let promptFinishedAt = promptStartedAt;
	await client.start();
	try {
		await configureMemory(client, armId, episodeId, Boolean(memoryId));
		const reviewBaseline = await readEventObjects(join(environment.projectDir, ".pi-xk", "memory"));
		promptStartedAt = Date.now();
		try {
			await client.prompt(buildTaskPrompt(episodeId), options.timeoutSeconds * 1000);
			} catch (error) {
				promptFailureCode = memoryTransferPromptFailureCode(error);
		} finally {
			promptFinishedAt = Date.now();
		}
			entries = await client.entries();
			const messages = await client.messages();
			usage = usageFromMessagesSafe(messages);
		state = await client.state().catch(() => undefined);
			const verification = await verifyEpisode(environment.projectDir, episodeId);
			const status = memoryTransferRunStatus(promptFailureCode, verification.passed);
		const authoritativePath = "docs/standards/canonical-record-keys.md";
			const initialObserved = inspectEpisodeEntries(entries, {
				messages,
				startedAt: promptStartedAt,
			projectDir: environment.projectDir,
			authoritativePath,
			relatedMemoryId: memoryId,
			publishedReview: false,
		});
		const publication = await waitForReviewPublication(
			environment.projectDir,
			reviewBaseline,
			initialObserved.reviewCalls > 0,
			10_000,
		);
		const observed = {
			...initialObserved,
			...publication,
			publishedReview: publication.reviewPublication === "applied",
		};
		return {
			status,
			memoryId,
			verification,
			observed,
			usage,
			elapsedSeconds: (promptFinishedAt - promptStartedAt) / 1000,
				state,
				promptFailureCode,
			};
	} finally {
		await client.stop();
	}
}

export function memoryTransferRunStatus(promptFailureCode, verificationPassed) {
	if (promptFailureCode !== null) return "inconclusive";
	return verificationPassed ? "passed" : "failed";
}

export function memoryTransferPromptFailureCode(error) {
	if (isRecord(error) && typeof error.code === "string" && /^provider_[a-z0-9_]+$/u.test(error.code)) {
		return error.code;
	}
	return classifyProviderError(error instanceof Error ? error.message : String(error));
}

export function shouldAbortMemoryTransferAfterPromptFailure(code) {
	return typeof code === "string" && /^provider_[a-z0-9_]+$/u.test(code);
}

function usageFromMessagesSafe(messages) {
	let inputTokensIncludingCache = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let costUsd = 0;
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) continue;
		inputTokensIncludingCache += asNonNegativeNumber(message.usage.input) + asNonNegativeNumber(message.usage.cacheRead);
		outputTokens += asNonNegativeNumber(message.usage.output);
		cacheReadTokens += asNonNegativeNumber(message.usage.cacheRead);
		if (isRecord(message.usage.cost)) costUsd += asNonNegativeNumber(message.usage.cost.total);
	}
	return { inputTokensIncludingCache, outputTokens, cacheReadTokens, costUsd };
}

function runRecord({ attemptId, armId, episodeId, options, runtimeId, taskDigest, result, seeded }) {
	const setup = armId === "pi-native" ? "none" : armId === "pi-xk-memory-off" ? "disabled" : armId === "pi-xk-placebo" ? "placebo" : "learned";
	return {
		id: `${attemptId}-${armId}-${episodeId}`,
		attemptId,
		arm: armId,
		episodeId,
		status: result.status,
		control: {
			model: `${options.provider}/${options.model}`,
			thinking: options.thinking,
			piVersion: options.piVersion,
			runtimeId,
			taskDigest,
			budget: { wallSeconds: options.timeoutSeconds, toolPolicy: "pi-default" },
		},
		setup: {
			memorySetup: setup,
			seededMemories: seeded ? 1 : 0,
			seedUtf8Bytes: seeded ? Buffer.byteLength(armId === "pi-xk-learned" ? buildMatchedMemoryStatements().learned : buildMatchedMemoryStatements().placebo, "utf8") : 0,
			captureVerified: seeded,
		},
		metrics: {
			...result.usage,
			elapsedSeconds: result.elapsedSeconds,
			toolCalls: result.observed.toolCalls,
			explorationCalls: result.observed.explorationCalls,
			fileReadCalls: result.observed.fileReadCalls,
			duplicateFileReads: result.observed.duplicateFileReads,
			firstRelevantEvidenceSeconds: result.observed.firstRelevantEvidenceSeconds,
		},
			recall: {
				d1SearchCalls: result.observed.d1SearchCalls,
				d2ReadCalls: result.observed.d2ReadCalls,
				d3EvidenceCalls: result.observed.d3EvidenceCalls,
				d1CandidateCount: result.observed.d1CandidateCount,
				reviewCalls: result.observed.reviewCalls,
				relatedMemoryRead: result.observed.relatedMemoryRead,
				relatedCandidateExposed: result.observed.relatedCandidateExposed,
				publishedReview: result.observed.publishedReview,
				reviewPublication: result.observed.reviewPublication,
				reviewFailureCode: result.observed.reviewFailureCode,
				reviewAction: result.observed.reviewAction,
		},
		verification: {
			independent: true,
			passed: result.verification.passed,
			reward: result.verification.passed ? 1 : 0,
			verifierDigest: result.verification.verifierDigest,
		},
	};
}

export function buildExecutionSchedule(arms, episodes, attempts) {
	if (!Array.isArray(arms) || !Array.isArray(episodes) || !Number.isInteger(attempts) || attempts < 1) throw new Error("Invalid Memory transfer schedule inputs");
	const schedule = [];
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const attemptId = `attempt-${String(attempt).padStart(2, "0")}`;
		const orderedArms = attempt % 2 === 0 ? [...arms].reverse() : [...arms];
		for (const episodeId of episodes) {
			for (const arm of orderedArms) schedule.push({ attemptId, arm, episodeId });
		}
	}
	return schedule;
}

async function writeExecutionState(path, state) {
	await atomicWrite(path, state);
}

export function buildMemoryTransferProgressReport({
	generatedAt,
	planDigest,
	arms,
	episodes,
	runs,
	failureCode,
}) {
	return {
		schema: "pi-xk.memory-transfer-progress.v1",
		reportKind: "real-provider",
		generatedAt,
		planDigest,
		selection: { arms: [...arms], episodes: [...episodes] },
		completedRuns: runs.length,
		failureCode,
		runs: [...runs],
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	assertSafeOutput(options.out, options.runtimeRoot);
	if (await exists(options.out)) {
		if (!options.force) throw new Error(`Output already exists: ${options.out}; pass --force to replace it`);
		await rm(options.out, { recursive: true, force: true });
	}
	const planInput = JSON.parse(await readFile(options.plan, "utf8"));
	const plan = validateMemoryTransferPlan(planInput);
	const provider = options.provider ?? plan.controls.provider;
	const model = options.model ?? plan.controls.model;
	const thinking = options.thinking ?? plan.controls.thinking;
	const timeoutSeconds = options.timeoutSeconds ?? plan.controls.wallSeconds;
	if (provider !== plan.controls.provider || model !== plan.controls.model || thinking !== plan.controls.thinking || timeoutSeconds !== plan.controls.wallSeconds) {
		throw new Error("Provider, model, thinking, and timeout must match the registered transfer plan");
	}
	if (!providerEnvironmentKey.has(provider)) throw new Error(`Unsupported provider: ${provider}`);
	if (!options.dryRun && !process.env[providerEnvironmentKey.get(provider)]) {
		throw new Error(`Required provider credential is not available in this process: ${providerEnvironmentKey.get(provider)}`);
	}
	const schedule = buildExecutionSchedule(options.arms, options.episodes, options.attempts);
	const completeMatrix = options.arms.length === allArms.length && options.episodes.length === allEpisodes.length;
	await mkdir(options.out, { recursive: true, mode: 0o700 });
	const statePath = join(options.out, "execution-state.json");
	const progressPath = join(options.out, "progress-report.json");
	const state = {
		schema: "pi-xk.memory-transfer-execution.v1",
		status: options.dryRun ? "dry-run" : "running",
		attempts: options.attempts,
		providerRuns: schedule.length,
		arms: options.arms,
		episodes: options.episodes,
		diagnostic: !completeMatrix,
		startedAt: new Date().toISOString(),
		finishedAt: null,
	};
	await writeExecutionState(statePath, state);
	if (options.dryRun) {
		state.status = "dry-run-complete";
		state.finishedAt = new Date().toISOString();
		await writeExecutionState(statePath, state);
		console.log(JSON.stringify({ providerRuns: schedule.length, attempts: options.attempts, episodes: options.episodes.length, arms: options.arms.length, diagnostic: !completeMatrix }));
		return;
	}
	const version = await readPiVersion(options.runtimeRoot);
	const runtimeId = await computeMemoryTransferRuntimeId({
		root: options.runtimeRoot,
		cli: options.cli,
		extension: options.extension,
	});
	const tempRoot = await mkdtemp(join(process.platform === "win32" ? dirname(options.out) : "/tmp", "pi-xk-memory-transfer-"));
	const runs = [];
	const environments = new Map();
	const planDigest = memoryTransferPlanDigest(planInput);
		try {
		const commonOptions = {
			...options,
			provider,
			model,
			thinking,
			timeoutSeconds,
			piVersion: version,
		};
			for (const entry of schedule) {
			const key = `${entry.attemptId}/${entry.arm}`;
			let environment = environments.get(key);
				if (!environment) {
				environment = await createArmEnvironment(tempRoot, entry.attemptId, entry.arm);
					environments.set(key, environment);
				}
				if (
					entry.episodeId !== "learning" &&
					(entry.arm === "pi-xk-placebo" || entry.arm === "pi-xk-learned") &&
					!environment.memoryId
				) {
					throw new Error(`Memory seed prerequisite is missing for ${entry.attemptId}/${entry.arm}/${entry.episodeId}`);
				}
				const result = await runEpisode(environment, commonOptions, entry.arm, entry.episodeId, environment.memoryId);
				if (result.promptFailureCode) {
					state.providerFailureCounts ??= {};
					state.providerFailureCounts[result.promptFailureCode] =
						(state.providerFailureCounts[result.promptFailureCode] ?? 0) + 1;
				}
			const taskDigest = sha256(JSON.stringify({ files: baseFixtureFiles(entry.episodeId), prompt: buildTaskPrompt(entry.episodeId) }));
			const seeded = entry.episodeId !== "learning" && Boolean(environment.memoryId);
			runs.push(runRecord({ attemptId: entry.attemptId, armId: entry.arm, episodeId: entry.episodeId, options: commonOptions, runtimeId, taskDigest, result, seeded }));
			if (entry.episodeId === "learning" && ["pi-xk-learned", "pi-xk-placebo"].includes(entry.arm) && result.verification.passed) {
				const seedClient = new RpcProcess(clientOptions(environment, commonOptions, entry.arm, "learning-seed"));
				await seedClient.start();
				try {
					await configureMemory(seedClient, entry.arm, "learning", false);
					environment.memoryId = await seedMemory(seedClient, environment, entry.arm);
				} finally {
					await seedClient.stop();
				}
			}
				state.completedRuns = runs.length;
				await writeExecutionState(statePath, state);
				await atomicWrite(
					progressPath,
					buildMemoryTransferProgressReport({
						generatedAt: new Date().toISOString(),
						planDigest,
						arms: options.arms,
						episodes: options.episodes,
						runs,
						failureCode: null,
					}),
				);
				if (shouldAbortMemoryTransferAfterPromptFailure(result.promptFailureCode)) {
					throw new MemoryTransferProviderBlockedError(result.promptFailureCode);
				}
			}
		const report = {
			schema: completeMatrix ? "pi-xk.memory-transfer-report.v2" : "pi-xk.memory-transfer-diagnostic.v1",
			reportKind: "real-provider",
			generatedAt: new Date().toISOString(),
			planDigest,
			...(completeMatrix ? {} : { selection: { arms: options.arms, episodes: options.episodes } }),
			runs,
		};
			await atomicWrite(join(options.out, completeMatrix ? "capability-report.json" : "diagnostic-report.json"), report);
			const summary = completeMatrix ? evaluateMemoryTransferReport(planInput, report) : null;
		if (summary) await atomicWrite(join(options.out, "summary.json"), summary);
		state.status = completeMatrix ? "completed" : "completed-diagnostic";
		state.finishedAt = new Date().toISOString();
		state.claimReady = summary?.claimReady ?? false;
			await writeExecutionState(statePath, state);
			console.log(`Pi-XK Memory ${completeMatrix ? "transfer" : "diagnostic"} report created at ${options.out}`);
		} catch (error) {
			const failureCode =
				error instanceof MemoryTransferProviderBlockedError
					? error.code
					: error instanceof Error && error.message.includes("seed prerequisite")
					? state.providerFailureCounts
						? "provider_prerequisite_failed"
						: "missing_seed"
					: "execution_failed";
			state.status = "failed";
			state.finishedAt = new Date().toISOString();
			state.failureCode = failureCode;
			state.completedRuns = runs.length;
			await Promise.all([
				writeExecutionState(statePath, state),
				atomicWrite(
					progressPath,
					buildMemoryTransferProgressReport({
						generatedAt: state.finishedAt,
						planDigest,
						arms: options.arms,
						episodes: options.episodes,
						runs,
						failureCode,
					}),
				),
			]);
			throw error;
		} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
