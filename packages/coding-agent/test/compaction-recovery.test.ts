import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPACTION_RECOVERY_PROMPT_VERSION,
	getPendingCompactionRecovery,
	SessionManager,
} from "../src/core/session-manager.ts";

function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: stopReason === "stop" ? "continued" : "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: stopReason === "error" ? "temporary failure" : undefined,
		timestamp: Date.now(),
	};
}

describe("compaction recovery persistence", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir && existsSync(dir)) rmSync(dir, { recursive: true });
		}
	});

	it("derives pending recovery after restart until a successful assistant response", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-recovery-"));
		tempDirs.push(dir);
		const file = join(dir, "session.jsonl");
		const source = SessionManager.createAt(dir, file);
		const firstKeptEntryId = source.appendMessage({
			role: "user",
			content: [{ type: "text", text: "original request" }],
			timestamp: Date.now() - 1000,
		});
		source.appendMessage(assistant("stop"));
		source.appendCompaction("summary", firstKeptEntryId, 100, undefined, false, {
			title: "Recovery persistence",
			reason: "manual",
			recoveryPromptVersion: COMPACTION_RECOVERY_PROMPT_VERSION,
		});
		source.flushDurable();

		const reopened = SessionManager.open(file);
		expect(getPendingCompactionRecovery(reopened.getBranch())).toMatchObject({
			title: "Recovery persistence",
			reason: "manual",
			recoveryPromptVersion: COMPACTION_RECOVERY_PROMPT_VERSION,
		});

		reopened.appendMessage(assistant("error"));
		reopened.appendMessage(assistant("aborted"));
		expect(getPendingCompactionRecovery(reopened.getBranch())).not.toBeNull();

		reopened.appendMessage(assistant("stop"));
		expect(getPendingCompactionRecovery(reopened.getBranch())).toBeNull();
	});

	it("does not infer recovery for legacy compaction entries", () => {
		const manager = SessionManager.inMemory();
		const firstKeptEntryId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "legacy request" }],
			timestamp: Date.now(),
		});
		manager.appendCompaction("legacy summary", firstKeptEntryId, 100);

		expect(getPendingCompactionRecovery(manager.getBranch())).toBeNull();
	});
});
