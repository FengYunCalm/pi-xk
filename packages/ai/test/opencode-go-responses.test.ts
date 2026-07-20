import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_GO_MODELS } from "../src/providers/opencode-go.models.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Context } from "../src/types.ts";

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_opencode_go_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("OpenCode Go Responses models", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches Grok 4.5 through the OpenAI Responses endpoint", async () => {
		let request: Request | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			request = new Request(input, init);
			return completedResponse();
		});

		const context: Context = {
			systemPrompt: "You are a careful coding assistant.",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const result = await opencodeGoProvider()
			.stream(OPENCODE_GO_MODELS["grok-4.5"], context, { apiKey: "opencode-go-test-token" })
			.result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(request?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(request?.headers.get("authorization")).toBe("Bearer opencode-go-test-token");
	});
});
