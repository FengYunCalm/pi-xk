import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";
import { contextSummaryEvidence } from "./summary-evidence-fixtures.ts";

describe("AgentSession branch summary contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("honors replacement instructions without imposing the default JSON response", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		let systemPrompt = "";
		let promptText = "";
		harness.session.agent.streamFn = (model, context) => {
			systemPrompt = context.systemPrompt ?? "";
			const message = context.messages[0];
			const content = message?.role === "user" ? message.content : [];
			promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
			const response = {
				...fauxAssistantMessage("<custom-branch>verified branch evidence</custom-branch>"),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end(response);
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, {
			summarize: true,
			customInstructions: "Return exactly one <custom-branch> block.",
			replaceInstructions: true,
		});

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.summary).toContain("<custom-branch>verified branch evidence</custom-branch>");
		expect(promptText).toContain("Return exactly one <custom-branch> block.");
		expect(promptText).not.toContain('Use "branch" as kind.');
		expect(systemPrompt).not.toContain("Output exactly one JSON object");
	});

	it("falls back to the default branch contract when replacement instructions are blank", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		let promptText = "";
		harness.session.agent.streamFn = (model, context) => {
			const message = context.messages[0];
			const content = message?.role === "user" ? message.content : [];
			promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
			const response = {
				...fauxAssistantMessage(
					contextSummaryEvidence("branch", "Branch audit", "## Goal\nVerified branch evidence."),
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end(response);
			});
			return stream;
		};

		const targetId = harness.sessionManager.appendMessage(userMsg("first branch"));
		harness.sessionManager.appendMessage(assistantMsg("first reply"));
		harness.sessionManager.appendMessage(userMsg("abandoned branch work"));
		harness.sessionManager.appendMessage(assistantMsg("abandoned reply"));

		const result = await harness.session.navigateTree(targetId, {
			summarize: true,
			customInstructions: "   ",
			replaceInstructions: true,
		});

		expect(result.summaryEntry?.summary).toContain("## Goal\nVerified branch evidence.");
		expect(result.summaryEntry?.summary).not.toContain("pi.summary-evidence.v1");
		expect(promptText).toContain('"additionalFocus":null');
	});
});
