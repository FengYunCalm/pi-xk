import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "text",
			text: JSON.stringify({
				schema: "pi.summary-evidence.v1",
				kind: "compaction",
				payload: { title: "Compaction reasoning options", summary: "## Goal\nTest summary" },
			}),
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("rejects a legacy XML response on the new generation path", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [{ type: "text", text: "<title>Legacy</title><summary>old</summary>" }],
		});
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toThrow(/JSON/i);
	});

	it("omits blank custom instructions from native compaction summary input", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key", undefined, undefined, "   ");

		const context = completeSimpleMock.mock.calls[0]?.[1];
		const message = context?.messages[0];
		const content = message?.role === "user" ? message.content : [];
		const promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
		expect(promptText).toContain('"additionalFocus":null');
	});

	it("preserves an aborted summary request as cancellation rather than a schema failure", async () => {
		completeSimpleMock.mockResolvedValue({
			...mockSummaryResponse,
			content: [],
			stopReason: "aborted",
			errorMessage: "summary stopped",
		});

		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).rejects.toMatchObject({
			name: "AbortError",
			message: "summary stopped",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		completeSimpleMock.mockResolvedValueOnce(mockSummaryResponse).mockResolvedValueOnce({
			...mockSummaryResponse,
			content: [
				{
					type: "text",
					text: JSON.stringify({
						schema: "pi.summary-evidence.v1",
						kind: "turn-prefix",
						payload: { title: "Retained turn context", summary: "## Original Request\nTest prefix" },
					}),
				},
			],
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});
