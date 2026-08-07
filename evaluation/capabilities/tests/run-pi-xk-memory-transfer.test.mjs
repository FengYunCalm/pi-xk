import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertSafeOutput,
	buildExecutionSchedule,
	buildMatchedMemoryStatements,
	buildMemoryTransferProgressReport,
	computeMemoryTransferRuntimeId,
	inspectEpisodeEntries,
	inspectReviewPublication,
	memoryTransferRunStatus,
	memoryTransferPromptFailureCode,
	parseMemoryTransferSelection,
	resolveMemoryTransferRuntime,
	shouldAbortMemoryTransferAfterPromptFailure,
	verifyEpisode,
} from "../../../scripts/run-pi-xk-memory-transfer.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryRoot = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-memory-transfer-test-"));

async function writeRuntimeFixture(root) {
	const packageNames = ["agent", "ai", "coding-agent", "tui", "pi-xk-core", "pi-xk-extension"];
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "package.json"), '{"name":"runtime-fixture"}\n');
	await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
	for (const packageName of packageNames) {
		const packageRoot = join(root, "packages", packageName);
		await mkdir(join(packageRoot, "dist"), { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version: "0.80.10" }));
		await writeFile(join(packageRoot, "dist", "index.js"), `export const packageName = ${JSON.stringify(packageName)};\n`);
	}
	await writeFile(join(root, "packages", "coding-agent", "dist", "cli.js"), 'console.log("cli-a");\n');
	await writeFile(join(root, "packages", "coding-agent", "dist", "cli-alt.js"), 'console.log("cli-a");\n');
	await writeFile(join(root, "packages", "pi-xk-extension", "dist", "extension.js"), 'export default function extension() {}\n');
	await writeFile(join(root, "packages", "coding-agent", "npm-shrinkwrap.json"), '{"lockfileVersion":3}\n');
}

try {
	const runtimeRoot = join(temporaryRoot, "runtime");
	await writeRuntimeFixture(runtimeRoot);
	const runtime = resolveMemoryTransferRuntime({ runtimeRoot, arms: ["pi-native", "pi-xk-learned"] });
	assert.equal(runtime.root, runtimeRoot);
	assert.equal(runtime.cli, join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js"));
	assert.equal(runtime.extension, join(runtimeRoot, "packages", "pi-xk-extension", "dist", "extension.js"));
	assert.doesNotThrow(() => assertSafeOutput(join(tmpdir(), "pi-xk-memory-transfer-safe-output"), runtimeRoot));
	assert.throws(() => assertSafeOutput(runtimeRoot, runtimeRoot), /must not overlap/u);
	assert.throws(() => assertSafeOutput(temporaryRoot, runtimeRoot), /must not overlap/u);
	assert.throws(
		() => resolveMemoryTransferRuntime({ runtimeRoot, cli: join(temporaryRoot, "outside-cli.js"), arms: ["pi-native"] }),
		/runtime root/u,
	);
	assert.throws(
		() => resolveMemoryTransferRuntime({ runtimeRoot, extension: null, arms: ["pi-xk-learned"] }),
		/requires a Pi-XK extension/u,
	);
	assert.equal(
		resolveMemoryTransferRuntime({ runtimeRoot, extension: null, arms: ["pi-native"] }).extension,
		null,
	);
	const runtimeId = await computeMemoryTransferRuntimeId(runtime);
	const alternateRuntimeId = await computeMemoryTransferRuntimeId({
		...runtime,
		cli: join(runtimeRoot, "packages", "coding-agent", "dist", "cli-alt.js"),
	});
	assert.notEqual(runtimeId, alternateRuntimeId);
	await writeFile(join(runtimeRoot, "packages", "coding-agent", "dist", "cli.js"), 'console.log("cli-b");\n');
	assert.notEqual(runtimeId, await computeMemoryTransferRuntimeId(runtime));

	const statements = buildMatchedMemoryStatements();
	assert.equal(Buffer.byteLength(statements.learned, "utf8"), Buffer.byteLength(statements.placebo, "utf8"));
	assert.equal([...statements.learned].slice(0, 120).join(""), [...statements.placebo].slice(0, 120).join(""));
	assert.match(statements.learned, /NFKC/u);
	assert.doesNotMatch(statements.placebo, /NFKC/u);

	assert.deepEqual(
		parseMemoryTransferSelection("pi-xk-learned,pi-native", [
			"pi-native",
			"pi-xk-memory-off",
			"pi-xk-placebo",
			"pi-xk-learned",
		], "arms"),
		["pi-native", "pi-xk-learned"],
	);
	assert.equal(memoryTransferRunStatus(null, true), "passed");
	assert.equal(memoryTransferRunStatus(null, false), "failed");
	assert.equal(memoryTransferRunStatus("provider_rate_limited", false), "inconclusive");
	assert.equal(memoryTransferPromptFailureCode({ code: "provider_rate_limited" }), "provider_rate_limited");
	assert.equal(memoryTransferPromptFailureCode({ code: "unsafe value" }), "provider_agent_error");
	assert.equal(shouldAbortMemoryTransferAfterPromptFailure("provider_balance_exhausted"), true);
	assert.equal(shouldAbortMemoryTransferAfterPromptFailure("provider_rate_limited"), true);
	assert.equal(shouldAbortMemoryTransferAfterPromptFailure(null), false);
	assert.throws(
		() => parseMemoryTransferSelection("pi-xk-learned,unknown", ["pi-native", "pi-xk-learned"], "arms"),
		/unsupported arms value/u,
	);
	assert.deepEqual(
		buildMemoryTransferProgressReport({
			generatedAt: "2026-08-07T00:00:00.000Z",
			planDigest: "sha256:plan",
			arms: ["pi-xk-learned"],
			episodes: ["learning", "exact-reuse"],
			runs: [{ id: "attempt-01-pi-xk-learned-learning" }],
			failureCode: "missing_seed",
		}),
		{
			schema: "pi-xk.memory-transfer-progress.v1",
			reportKind: "real-provider",
			generatedAt: "2026-08-07T00:00:00.000Z",
			planDigest: "sha256:plan",
			selection: {
				arms: ["pi-xk-learned"],
				episodes: ["learning", "exact-reuse"],
			},
			completedRuns: 1,
			failureCode: "missing_seed",
			runs: [{ id: "attempt-01-pi-xk-learned-learning" }],
		},
	);

	assert.deepEqual(
		buildExecutionSchedule(
			["pi-native", "pi-xk-memory-off", "pi-xk-placebo", "pi-xk-learned"],
			["learning", "exact-reuse"],
			2,
		).map(({ attemptId, arm, episodeId }) => `${attemptId}/${arm}/${episodeId}`),
		[
			"attempt-01/pi-native/learning",
			"attempt-01/pi-xk-memory-off/learning",
			"attempt-01/pi-xk-placebo/learning",
			"attempt-01/pi-xk-learned/learning",
			"attempt-01/pi-native/exact-reuse",
			"attempt-01/pi-xk-memory-off/exact-reuse",
			"attempt-01/pi-xk-placebo/exact-reuse",
			"attempt-01/pi-xk-learned/exact-reuse",
			"attempt-02/pi-xk-learned/learning",
			"attempt-02/pi-xk-placebo/learning",
			"attempt-02/pi-xk-memory-off/learning",
			"attempt-02/pi-native/learning",
			"attempt-02/pi-xk-learned/exact-reuse",
			"attempt-02/pi-xk-placebo/exact-reuse",
			"attempt-02/pi-xk-memory-off/exact-reuse",
			"attempt-02/pi-native/exact-reuse",
		],
	);

	const startedAt = Date.parse("2026-08-07T00:00:00.000Z");
	const entries = [
		{
			type: "message",
			timestamp: "2026-08-07T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-search", name: "pi_xk_search_memory", arguments: { query: "omitted" } },
					{
						type: "toolCall",
						id: "call-read-memory",
						name: "pi_xk_read_memory",
						arguments: { memoryIds: ["memory_related"] },
					},
				],
			},
		},
		{
			type: "message",
			timestamp: "2026-08-07T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-read-source-1", name: "read", arguments: { path: "docs/standards/canonical-record-keys.md" } },
					{ type: "toolCall", id: "call-read-source-2", name: "read", arguments: { path: "docs/standards/canonical-record-keys.md" } },
					{
						type: "toolCall",
						id: "call-review",
						name: "pi_xk_review_memory",
						arguments: { action: "revise", sourceMemories: [{ memoryId: "memory_related" }] },
					},
				],
			},
		},
	];
	const messages = [
		{
			role: "toolResult",
			toolCallId: "call-search",
			toolName: "pi_xk_search_memory",
			isError: false,
			details: {
				items: [{ memoryId: "memory_related" }, { memoryId: "memory_other" }],
				historyCues: [],
				nextCursor: null,
			},
		},
		{
			role: "toolResult",
			toolCallId: "call-read-memory",
			toolName: "pi_xk_read_memory",
			isError: false,
			details: {
				memories: [{ revision: { memoryId: "memory_related", revision: 1 } }],
			},
		},
	];
	const appendOnlyEntries = [
		...entries,
		{ type: "message", timestamp: "2026-08-07T00:00:02.500Z", message: messages[0] },
		{ type: "message", timestamp: "2026-08-07T00:00:03.500Z", message: messages[1] },
	];
	assert.deepEqual(
		inspectEpisodeEntries(entries, {
			messages,
			startedAt,
			projectDir: "/tmp/project",
			authoritativePath: "docs/standards/canonical-record-keys.md",
			relatedMemoryId: "memory_related",
			publishedReview: true,
		}),
		{
			toolCalls: 5,
			explorationCalls: 2,
			fileReadCalls: 2,
			duplicateFileReads: 1,
			firstRelevantEvidenceSeconds: 2,
				d1SearchCalls: 1,
				d2ReadCalls: 1,
				d3EvidenceCalls: 0,
				d1CandidateCount: 2,
				reviewCalls: 1,
			relatedMemoryRead: true,
			relatedCandidateExposed: true,
			publishedReview: true,
			reviewAction: "revise",
		},
	);
	assert.deepEqual(
		inspectEpisodeEntries(appendOnlyEntries, {
			// A compaction can remove the earlier D1 result from the active message
			// context while the append-only entries still retain it.
			messages: [messages[1]],
			startedAt,
			projectDir: "/tmp/project",
			authoritativePath: "docs/standards/canonical-record-keys.md",
			relatedMemoryId: "memory_related",
			publishedReview: false,
		}),
		{
			toolCalls: 5,
			explorationCalls: 2,
			fileReadCalls: 2,
			duplicateFileReads: 1,
			firstRelevantEvidenceSeconds: 2,
			d1SearchCalls: 1,
			d2ReadCalls: 1,
			d3EvidenceCalls: 0,
			d1CandidateCount: 2,
			reviewCalls: 1,
			relatedMemoryRead: true,
			relatedCandidateExposed: true,
			publishedReview: false,
			reviewAction: "revise",
		},
	);
	const failedReadMessages = messages.map((message) =>
		message.toolCallId === "call-read-memory" ? { ...message, isError: true } : message,
	);
	assert.equal(
		inspectEpisodeEntries(entries, {
			messages: failedReadMessages,
			startedAt,
			projectDir: "/tmp/project",
			authoritativePath: "docs/standards/canonical-record-keys.md",
			relatedMemoryId: "memory_related",
			publishedReview: false,
		}).relatedMemoryRead,
		false,
	);

	const publicationBaseline = [
		{ eventType: "reconstruction_recorded", eventId: "event-1", sequence: 1 },
	];
	assert.deepEqual(
		inspectReviewPublication(
			publicationBaseline,
			[
				...publicationBaseline,
				{
					eventType: "reconstruction_recorded",
					eventId: "event-2",
					sequence: 2,
					payload: { runId: "run_test" },
				},
				{
					eventType: "memory_review_applied",
					eventId: "event-3",
					sequence: 3,
					payload: { runId: "run_test", captureId: null },
				},
			],
			{ reviewRequested: true },
		),
		{ reviewPublication: "applied", reviewFailureCode: null },
	);
	assert.deepEqual(
		inspectReviewPublication(publicationBaseline, publicationBaseline, { reviewRequested: true }),
		{ reviewPublication: "failed", reviewFailureCode: "review_not_observed" },
	);

	const projectDir = join(temporaryRoot, "project");
	await mkdir(join(projectDir, "src", "records"), { recursive: true });
	await mkdir(join(projectDir, "src", "indexing"), { recursive: true });
	await mkdir(join(projectDir, "src", "math"), { recursive: true });
	await writeFile(
		join(projectDir, "src", "records", "canonicalize.cjs"),
		'module.exports.canonicalRecordKey = (value) => { const result = String(value).normalize("NFKC").trim().toLowerCase().replace(/\\s+/gu, "."); if (!result) throw new TypeError("record key is empty"); return result; };\n',
	);
	await writeFile(
		join(projectDir, "src", "indexing", "derive-record-route.cjs"),
		'const { canonicalRecordKey } = require("../records/canonicalize.cjs");\nmodule.exports.deriveRecordRoute = (tenant, record) => `${canonicalRecordKey(tenant)}/${canonicalRecordKey(record)}`;\n',
	);
	await writeFile(
		join(projectDir, "src", "math", "inclusive-range.cjs"),
		'module.exports.inclusiveRange = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);\n',
	);
	assert.equal((await verifyEpisode(projectDir, "learning")).passed, true);
	assert.equal((await verifyEpisode(projectDir, "exact-reuse")).passed, true);
	assert.equal((await verifyEpisode(projectDir, "similar-transfer")).passed, true);
	assert.equal((await verifyEpisode(projectDir, "unrelated")).passed, true);

	await writeFile(
		join(projectDir, "src", "records", "canonicalize.cjs"),
		'module.exports.canonicalRecordKey = (value) => { const result = String(value).normalize("NFKC").trim().toLowerCase().replace(/\\s+/gu, "~"); if (!result) throw new TypeError("record key is empty"); return result; };\n',
	);
	assert.equal((await verifyEpisode(projectDir, "changed-rule")).passed, true);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
