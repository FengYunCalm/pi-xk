import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type UserMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEGMENT_SUMMARY_SCHEMA } from "../../../pi-xk-core/src/index.ts";
import {
	evaluateSessionChainThreshold,
	isPiXkSessionChainBinding,
	PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE,
	PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE,
	PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE,
	SESSION_CHAIN_ROOT_SUMMARY,
	SessionChainController,
	type SessionChainHost,
} from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const directory = join(tmpdir(), `pi-xk-chain-controller-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function appendTurn(manager: SessionManager, user: string, assistant: string): void {
	manager.appendMessage(userMessage(user));
	manager.appendMessage(fauxAssistantMessage(assistant));
}

function createPersistedSession(projectRoot: string, name: string, withTurn = true): SessionManager {
	const manager = SessionManager.createAt(projectRoot, join(projectRoot, `${name}.jsonl`), { id: name });
	if (withTurn) appendTurn(manager, `user:${name}`, `assistant:${name}`);
	manager.flushDurable();
	return manager;
}

interface FakeHostOptions {
	response?: string;
	outputTokens?: number;
	crashAfterSourceFinalize?: boolean;
	cancelBeforeCallbacks?: boolean;
	appendTargetAfterInitialize?: boolean;
}

function createHost(initialManager: SessionManager, options: FakeHostOptions = {}) {
	let currentManager = initialManager;
	const summarizeSessionContext = vi.fn<SessionChainHost["summarizeSessionContext"]>(async () => ({
		summary:
			options.response ??
			"<segment-delta>## Delta\n\n- Finished the current segment.</segment-delta>\n<carry-forward>## Carry forward\n\nContinue from the verified state.</carry-forward>",
		model: { provider: "faux", modelId: "faux-summary" },
		thinkingLevel: "medium",
		usage: {
			input: 200,
			output: options.outputTokens ?? 80,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 280,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	}));
	const host: SessionChainHost = {
		get sessionManager() {
			return currentManager;
		},
		model: { contextWindow: 100_000 },
		summarizeSessionContext,
		rolloverSession: async (rolloverOptions) => {
			if (options.cancelBeforeCallbacks) return { cancelled: true };
			const sourceManager = currentManager;
			const sourceSessionFile = sourceManager.getSessionFile();
			if (!sourceSessionFile) throw new Error("source session is not persisted");
			const targetManager = SessionManager.createAt(
				projectRootFor(sourceManager),
				rolloverOptions.targetSessionFile,
				{ id: rolloverOptions.targetSessionId },
			);
			await rolloverOptions.initializeTarget(targetManager);
			if (options.appendTargetAfterInitialize) appendTurn(targetManager, "late target input", "late target output");
			targetManager.flushDurable();
			await rolloverOptions.finalizeSource(sourceManager);
			sourceManager.flushDurable();
			if (options.crashAfterSourceFinalize) {
				await rm(rolloverOptions.targetSessionFile, { force: true });
				throw new Error("simulated crash after source finalize");
			}
			const commitContext = {
				sourceSessionFile,
				sourceSessionId: sourceManager.getSessionId(),
				sourceLeafId: sourceManager.getLeafId(),
				targetSessionFile: rolloverOptions.targetSessionFile,
				targetSessionId: targetManager.getSessionId(),
				targetLeafId: targetManager.getLeafId(),
			};
			await rolloverOptions.commit(commitContext);
			currentManager = targetManager;
			return { cancelled: false, ...commitContext };
		},
	};
	return { host, summarizeSessionContext, getCurrentManager: () => currentManager };
}

function projectRootFor(manager: SessionManager): string {
	return manager.getCwd();
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const directory = tempDirs.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("SessionChainController roots", () => {
	it("rejects path-unsafe IDs in transcript chain bindings", () => {
		expect(
			isPiXkSessionChainBinding({
				schema: "pi-xk.session-chain-link.v1",
				kind: "segment_link",
				chainId: "chain_safe",
				branchId: "branch_safe",
				segmentId: "../outside",
				ordinal: 1,
				predecessorSegmentId: null,
				summaryInArtifactId: null,
				createdAt: "2026-07-22T00:00:00.000Z",
			}),
		).toBe(false);
	});

	it("bootstraps a new logical chain into a managed project Segment", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "bootstrap-source", false);
		const { host, getCurrentManager } = createHost(source);
		const controller = new SessionChainController({
			projectRoot,
			createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
		});

		const binding = await controller.bootstrapManagedChain(host, { title: "Managed chain" });

		const replay = await controller.getStore().replayChain(binding.chainId);
		const status = await controller.getCurrentStatus(getCurrentManager());
		expect(replay.spec.rootSegment.location.kind).toBe("managed");
		expect(status).toMatchObject({
			chainId: binding.chainId,
			branchId: binding.branchId,
			segmentId: binding.segmentId,
			ordinal: 1,
			segmentStatus: "active",
			writableHead: true,
			threshold: "none",
		});
		expect(await controller.isCurrentWritableHead(getCurrentManager())).toBe(true);
		expect(getCurrentManager().getSessionFile()).toContain(
			join(".pi-xk", "sessions", "chains", binding.chainId, "branches", binding.branchId, "segments"),
		);
		expect(controller.getCurrentBinding(getCurrentManager())).toEqual(binding);
		expect(getCurrentManager().buildSessionContext().messages.at(-1)).toMatchObject({
			role: "custom",
			content: SESSION_CHAIN_ROOT_SUMMARY,
		});
	});

	it("bootstraps a managed chain when Pi has only model, thinking, and session-name projections", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "bootstrap-projections", false);
		source.appendModelChange("faux", "faux-model");
		source.appendThinkingLevelChange("high");
		source.appendSessionInfo("Projected session");
		source.flushDurable();
		const { host, getCurrentManager } = createHost(source);
		const controller = new SessionChainController({
			projectRoot,
			createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
		});

		const binding = await controller.bootstrapManagedChain(host, { title: "Projected chain" });

		expect(controller.getCurrentBinding(getCurrentManager())).toEqual(binding);
		expect(getCurrentManager().getBranch()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "model_change", provider: "faux", modelId: "faux-model" }),
				expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
				expect.objectContaining({ type: "session_info", name: "Projected session" }),
			]),
		);
	});

	it("adopts an existing Pi JSONL as external-root without copying it", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "existing-session");
		const originalPath = source.getSessionFile();
		const controller = new SessionChainController({ projectRoot });

		const binding = await controller.adoptExternalRoot(source, { title: "Adopted chain" });

		const replay = await controller.getStore().replayChain(binding.chainId);
		expect(replay.spec.rootSegment.location).toEqual({ kind: "external-root", absolutePath: originalPath });
		expect(source.getSessionFile()).toBe(originalPath);
		expect(source.getEntries().filter((entry) => entry.type === "custom")).toContainEqual(
			expect.objectContaining({ customType: PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, data: binding }),
		);
		expect(source.getEntries().filter((entry) => entry.type === "custom_message")).toContainEqual(
			expect.objectContaining({ customType: PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE }),
		);
	});
});

describe("SessionChainController rollover", () => {
	it("seals the source only after a cumulative summary and durable target are ready", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "rollover-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "implement controller", "controller implemented");
		const { host, summarizeSessionContext, getCurrentManager } = createHost(source);

		const result = await controller.rollover(host, { reason: "manual test" });

		expect(result.cancelled).toBe(false);
		const summaryRequest = summarizeSessionContext.mock.calls[0]?.[0];
		expect(summaryRequest?.previousSummary).toBe(SESSION_CHAIN_ROOT_SUMMARY);
		expect(JSON.stringify(summaryRequest?.messages)).toContain("<segment-delta>");
		expect(JSON.stringify(summaryRequest?.messages)).toContain("</segment-delta>");
		expect(summaryRequest?.maxOutputTokens).toBe(5_000);
		const replay = await controller.getStore().replayChain(binding.chainId);
		const branch = replay.branches[0];
		expect(branch?.segments.map((segment) => segment.status)).toEqual(["sealed", "active"]);
		expect(source.getEntries().at(-1)).toMatchObject({
			type: "custom",
			customType: PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE,
		});
		expect(getCurrentManager().getEntries()[0]).toMatchObject({
			type: "custom",
			customType: PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE,
		});
		expect(getCurrentManager().getEntries().at(-1)).toMatchObject({
			type: "custom_message",
			customType: PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE,
		});
		const summary = await controller.getStore().readSegmentSummary(result.summaryArtifactId);
		expect(summary).toMatchObject({
			chainId: binding.chainId,
			baseSummaryArtifactId: null,
			segmentDeltaMarkdown: "## Delta\n\n- Finished the current segment.",
			carryForwardMarkdown: "## Carry forward\n\nContinue from the verified state.",
		});
		expect((await controller.doctor(binding.chainId)).diagnostics).toEqual([]);
	});

	it("uses the latest Pi compaction summary as the cumulative base", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "compacted-source");
		const controller = new SessionChainController({ projectRoot });
		await controller.adoptExternalRoot(source);
		const firstKeptEntryId = source.appendMessage(userMessage("kept user tail"));
		source.appendMessage(fauxAssistantMessage("kept assistant tail"));
		source.appendCompaction("cumulative Pi compaction summary", firstKeptEntryId, 1200);
		appendTurn(source, "post-compaction user", "post-compaction assistant");
		const { host, summarizeSessionContext } = createHost(source);

		const result = await controller.rollover(host, { reason: "compaction-aware" });

		expect(summarizeSessionContext.mock.calls[0]?.[0].previousSummary).toBe("cumulative Pi compaction summary");
		const summary = await controller.getStore().readSegmentSummary(result.summaryArtifactId);
		expect(summary.sourceRange.firstEntryId).toBe(firstKeptEntryId);
		expect(summary.sourceRange.lastEntryId).toBe(result.sourceLeafId);
	});

	it("carries the prior Segment summary across three physical Segments", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "progressive-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "segment one work", "segment one result");
		const { host, summarizeSessionContext, getCurrentManager } = createHost(source);

		const first = await controller.rollover(host, { reason: "first progressive rollover" });
		appendTurn(getCurrentManager(), "segment two work", "segment two result");
		const second = await controller.rollover(host, { reason: "second progressive rollover" });

		expect(summarizeSessionContext).toHaveBeenCalledTimes(2);
		expect(summarizeSessionContext.mock.calls[1]?.[0].previousSummary).toBe(
			"## Carry forward\n\nContinue from the verified state.",
		);
		const secondSummary = await controller.getStore().readSegmentSummary(second.summaryArtifactId);
		expect(secondSummary.baseSummaryArtifactId).toBe(first.summaryArtifactId);
		const replay = await controller.getStore().replayChain(binding.chainId);
		expect(replay.branches[0]?.segments.map((segment) => segment.status)).toEqual(["sealed", "sealed", "active"]);
	});

	it("aborts a prepared rollover when the Host cancels before callbacks", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "cancel-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "work before cancel", "result before cancel");
		const { host } = createHost(source, { cancelBeforeCallbacks: true });

		const result = await controller.rollover(host, { reason: "cancelled rollover" });

		expect(result.cancelled).toBe(true);
		const replay = await controller.getStore().replayChain(binding.chainId);
		expect(replay.events.map((event) => event.eventType)).toEqual([
			"chain_created",
			"rollover_prepared",
			"rollover_aborted",
		]);
		expect(replay.branches[0]?.segments[0]?.status).toBe("active");
		const lastEntry = source.getEntries().at(-1);
		expect(lastEntry?.type === "custom" ? lastEntry.customType : null).not.toBe(
			PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE,
		);
	});

	it("does not prepare a rollover when summary generation or validation fails", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "summary-failure");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "new work", "new result");
		const { host } = createHost(source, { response: "not the required summary envelope" });

		await expect(controller.rollover(host, { reason: "invalid summary" })).rejects.toThrow("summary envelope");

		const replay = await controller.getStore().replayChain(binding.chainId);
		expect(replay.events.map((event) => event.eventType)).toEqual(["chain_created"]);
		expect(replay.branches[0]?.segments[0]?.status).toBe("active");
	});

	it("rejects a summary response that exceeds the fixed context-derived budget", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "summary-over-budget");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "new work", "new result");
		const { host } = createHost(source, { outputTokens: 5_001 });

		await expect(controller.rollover(host, { reason: "over budget" })).rejects.toThrow("token budget");

		expect((await controller.getStore().replayChain(binding.chainId)).events).toHaveLength(1);
	});

	it("rebuilds the original target and commits a prepared crash after source summary-out", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "crash-source");
		const controller = new SessionChainController({
			projectRoot,
			createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
		});
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "work before crash", "result before crash");
		const { host } = createHost(source, { crashAfterSourceFinalize: true });

		await expect(controller.rollover(host, { reason: "crash recovery" })).rejects.toThrow("simulated crash");
		const prepared = await controller.getStore().replayChain(binding.chainId);
		const pendingTarget = prepared.branches[0]?.pendingRollover?.targetSegment.segmentId;
		expect(prepared.events.at(-1)?.eventType).toBe("rollover_prepared");

		const recovery = await controller.recoverPending(binding.chainId, binding.branchId);

		expect(recovery.action).toBe("rebuilt-and-committed");
		expect(recovery.targetSegmentId).toBe(pendingTarget);
		const replay = await controller.getStore().replayChain(binding.chainId);
		expect(replay.events.at(-1)?.eventType).toBe("rollover_committed");
		expect(replay.branches[0]?.headSegmentId).toBe(pendingTarget);
	});

	it("aborts a prepared rollover recovered before source summary-out", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "prepared-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		const replay = await controller.getStore().replayChain(binding.chainId);
		const sourceEntries = source.getBranch();
		const sourceLeafId = source.getLeafId();
		if (!sourceLeafId || sourceEntries.length === 0) throw new Error("prepared source must have entries");
		const entriesHash = `sha256:${createHash("sha256")
			.update(sourceEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8")
			.digest("hex")}`;
		const targetSegmentId = "recovery-target";
		const summaryArtifactId = await controller.getStore().putSegmentSummary({
			schema: SEGMENT_SUMMARY_SCHEMA,
			chainId: binding.chainId,
			branchId: binding.branchId,
			sourceSegmentId: binding.segmentId,
			sourceLeafId,
			targetSegmentId,
			baseSummaryArtifactId: null,
			sourceRange: {
				firstEntryId: sourceEntries[0]?.id ?? null,
				lastEntryId: sourceLeafId,
				entryCount: sourceEntries.length,
				entriesHash,
			},
			segmentDeltaMarkdown: "Prepared delta",
			carryForwardMarkdown: "Prepared carry forward",
			generator: {
				provider: "faux",
				modelId: "faux-summary",
				promptVersion: "session-chain-summary-v1",
				inputTokens: 10,
				outputTokens: 5,
				generatedAt: "2026-07-22T00:00:00.000Z",
			},
		});
		await controller.getStore().appendRolloverPrepared(
			binding.chainId,
			{
				branchId: binding.branchId,
				sourceSegmentId: binding.segmentId,
				sourceLeafId,
				targetSegment: {
					segmentId: targetSegmentId,
					ordinal: 2,
					location: { kind: "managed", fileName: `000002_${targetSegmentId}.jsonl` },
					predecessorSegmentId: binding.segmentId,
					summaryInArtifactId: summaryArtifactId,
					createdAt: "2026-07-22T00:00:00.000Z",
				},
				summaryArtifactId,
				reason: "simulate process exit before source finalization",
			},
			{
				eventId: `${binding.chainId}:${targetSegmentId}:prepared`,
				idempotencyKey: `${binding.chainId}:${targetSegmentId}:prepared`,
				expectedHead: replay.head,
				actor: "runtime",
				timestamp: "2026-07-22T00:00:00.000Z",
			},
		);

		const recovery = await controller.recoverPending(binding.chainId, binding.branchId);

		expect(recovery).toMatchObject({ action: "aborted", targetSegmentId });
		expect((await controller.getStore().replayChain(binding.chainId)).events.at(-1)?.eventType).toBe(
			"rollover_aborted",
		);
	});

	it("refuses to commit when summary-in is no longer the staged target leaf", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "target-leaf-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "work before invalid target", "result before invalid target");
		const { host } = createHost(source, { appendTargetAfterInitialize: true });

		await expect(controller.rollover(host, { reason: "invalid target leaf" })).rejects.toThrow(
			"summary-in must be the target Segment leaf",
		);
		expect((await controller.getStore().replayChain(binding.chainId)).branches[0]?.pendingRollover).toBeDefined();
	});

	it("reports sealed transcript tampering", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "tamper-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "seal this", "sealed");
		const { host } = createHost(source);
		await controller.rollover(host, { reason: "seal for doctor" });
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("missing source path");
		await appendFile(sourcePath, '{"tampered":true}\n');

		const report = await controller.doctor(binding.chainId);

		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "sealed_file_hash_mismatch" }),
		);
	});

	it("reports a missing Segment summary artifact", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "missing-summary-source");
		const controller = new SessionChainController({ projectRoot });
		const binding = await controller.adoptExternalRoot(source);
		appendTurn(source, "seal with summary", "summary persisted");
		const { host } = createHost(source);
		const result = await controller.rollover(host, { reason: "remove summary artifact" });
		const digest = result.summaryArtifactId.slice("sha256:".length);
		await rm(join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`));

		const report = await controller.doctor(binding.chainId);

		expect(report.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "summary_artifact_invalid" }),
		);
	});
});

describe("SessionChainController branching", () => {
	it("creates a successor branch without sealing or rewriting the source branch", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "branch-source");
		const controller = new SessionChainController({ projectRoot });
		const sourceBinding = await controller.adoptExternalRoot(source);
		appendTurn(source, "branch from this work", "source branch result");
		const sourceLeafId = source.getLeafId();
		if (!sourceLeafId) throw new Error("branch source must have a leaf");
		const sourceEntries = source.getEntries().length;
		const { host, getCurrentManager } = createHost(source);

		const result = await controller.continueBranch(host, {
			reason: "continue historical work",
			sourceEntryId: sourceLeafId,
		});

		const replay = await controller.getStore().replayChain(sourceBinding.chainId);
		expect(replay.branches).toHaveLength(2);
		expect(replay.branches[0]).toMatchObject({
			branchId: sourceBinding.branchId,
			headSegmentId: sourceBinding.segmentId,
			segments: [{ segmentId: sourceBinding.segmentId, status: "active" }],
		});
		expect(replay.branches[1]).toMatchObject({
			branchId: result.branchId,
			forkedFrom: {
				branchId: sourceBinding.branchId,
				segmentId: sourceBinding.segmentId,
				entryId: sourceLeafId,
			},
			headSegmentId: result.targetSegmentId,
			segments: [{ ordinal: 1, status: "active", predecessorSegmentId: sourceBinding.segmentId }],
		});
		expect(source.getEntries()).toHaveLength(sourceEntries);
		expect(source.getEntries().at(-1)?.type).toBe("message");
		expect(controller.getCurrentBinding(getCurrentManager())).toMatchObject({
			chainId: sourceBinding.chainId,
			branchId: result.branchId,
			segmentId: result.targetSegmentId,
			ordinal: 1,
		});
		expect((await controller.doctor(sourceBinding.chainId)).diagnostics).toEqual([]);
	});

	it("creates a successor branch from a sealed historical Segment without rewriting the source", async () => {
		const projectRoot = await createTempDir();
		const source = createPersistedSession(projectRoot, "sealed-branch-source");
		const controller = new SessionChainController({
			projectRoot,
			createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
		});
		const sourceBinding = await controller.adoptExternalRoot(source);
		appendTurn(source, "historical branch point", "historical branch result");
		const sourceEntryId = source.getLeafId();
		const sourceFile = source.getSessionFile();
		if (!sourceEntryId || !sourceFile) throw new Error("historical branch source must be persisted");
		const { host, getCurrentManager } = createHost(source);
		await controller.rollover(host, { reason: "seal historical branch source" });
		appendTurn(getCurrentManager(), "newer branch work", "newer branch result");
		const sealedBytes = await readFile(sourceFile, "utf8");

		const result = await controller.createSuccessorBranch(host, {
			reason: "continue sealed history",
			source: {
				chainId: sourceBinding.chainId,
				branchId: sourceBinding.branchId,
				segmentId: sourceBinding.segmentId,
			},
			sourceEntryId,
		});

		expect(await readFile(sourceFile, "utf8")).toBe(sealedBytes);
		const replay = await controller.getStore().replayChain(sourceBinding.chainId);
		const branch = replay.branches.find((candidate) => candidate.branchId === result.branchId);
		expect(branch).toMatchObject({
			forkedFrom: {
				branchId: sourceBinding.branchId,
				segmentId: sourceBinding.segmentId,
				entryId: sourceEntryId,
			},
			headSegmentId: result.targetSegmentId,
			segments: [{ ordinal: 1, status: "active", predecessorSegmentId: sourceBinding.segmentId }],
		});
		const target = SessionManager.open(result.sessionFile);
		expect(controller.getCurrentBinding(target)).toMatchObject({
			chainId: sourceBinding.chainId,
			branchId: result.branchId,
			segmentId: result.targetSegmentId,
		});
		const summary = await controller.getStore().readSegmentSummary(result.summaryArtifactId);
		expect(summary).toMatchObject({
			branchId: sourceBinding.branchId,
			sourceSegmentId: sourceBinding.segmentId,
			sourceLeafId: sourceEntryId,
			targetSegmentId: result.targetSegmentId,
		});
		expect((await controller.doctor(sourceBinding.chainId)).diagnostics).toEqual([]);
	});
});

describe("Session Chain thresholds", () => {
	it("keeps soft and hard physical limits independent from token compaction", () => {
		expect(evaluateSessionChainThreshold({ bytes: 1024, entries: 10 })).toBe("none");
		expect(evaluateSessionChainThreshold({ bytes: 16 * 1024 * 1024, entries: 10 })).toBe("soft");
		expect(evaluateSessionChainThreshold({ bytes: 1024, entries: 4_000 })).toBe("soft");
		expect(evaluateSessionChainThreshold({ bytes: 64 * 1024 * 1024, entries: 10 })).toBe("hard");
		expect(evaluateSessionChainThreshold({ bytes: 1024, entries: 16_000 })).toBe("hard");
	});
});
