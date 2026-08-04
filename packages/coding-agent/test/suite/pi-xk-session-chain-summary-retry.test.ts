import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionChainHost } from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { SessionChainController } from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sessionChainL1Evidence } from "./summary-evidence-fixtures.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const directory = join(tmpdir(), `pi-xk-summary-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

function createHost(
	projectRoot: string,
	manager: SessionManager,
	responses: readonly string[],
): { host: SessionChainHost; summarize: ReturnType<typeof vi.fn> } {
	let current = manager;
	let responseIndex = 0;
	const summarize = vi.fn(async () => ({
		summary: responses[responseIndex++] ?? "invalid response",
		model: { provider: "faux", modelId: "faux-summary" },
		thinkingLevel: "off",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
	}));
	const host: SessionChainHost = {
		get sessionManager() {
			return current;
		},
		model: { contextWindow: 100_000 },
		summarizeSessionContext: summarize,
		rolloverSession: async (options) => {
			const source = current;
			const target = SessionManager.createAt(projectRoot, options.targetSessionFile, {
				id: options.targetSessionId,
			});
			await options.initializeTarget(target);
			target.flushDurable();
			await options.finalizeSource(source);
			source.flushDurable();
			const sourceSessionFile = source.getSessionFile();
			const targetSessionFile = target.getSessionFile();
			if (!sourceSessionFile || !targetSessionFile) throw new Error("retry fixture requires persisted sessions");
			const context = {
				sourceSessionFile,
				sourceSessionId: source.getSessionId(),
				sourceLeafId: source.getLeafId(),
				targetSessionFile,
				targetSessionId: target.getSessionId(),
				targetLeafId: target.getLeafId(),
			};
			await options.commit(context);
			current = target;
			return { cancelled: false as const, ...context };
		},
	};
	return { host, summarize };
}

afterEach(async () => {
	for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Pi-XK Session Chain L1 protocol retry", () => {
	it("retries one malformed provider response before committing the rollover", async () => {
		const projectRoot = await createTempDir();
		const controller = new SessionChainController({ projectRoot });
		const root = await controller.createManagedRoot({ title: "summary retry fixture" });
		root.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Create a retryable L1 summary fixture." }],
			timestamp: Date.now(),
		});
		root.sessionManager.appendMessage(fauxAssistantMessage("Fixture source work completed."));
		root.sessionManager.flushDurable();
		const { host, summarize } = createHost(projectRoot, root.sessionManager, [
			"I will provide the summary next.",
			sessionChainL1Evidence("Retryable summary protocol", "Delta evidence.", "Carry-forward evidence."),
		]);

		await expect(controller.rollover(host, { reason: "retry malformed L1 protocol" })).resolves.toMatchObject({
			cancelled: false,
		});
		expect(summarize).toHaveBeenCalledTimes(2);
		expect(summarize.mock.calls[1]?.[0]).toMatchObject({
			customInstructions: expect.stringContaining(
				"previous response was rejected before any Session Chain state changed",
			),
		});
		const replay = await controller.getStore().replayChain(root.binding.chainId);
		expect(replay.head.sequence).toBe(3);
		expect(replay.branches[0]?.segments.map((segment) => segment.status)).toEqual(["sealed", "active"]);
	});
});
