import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPiXkExtension,
	createPiXkGoalBinding,
	isPiXkSessionLink,
	PI_XK_SESSION_LINK_CUSTOM_TYPE,
	type PiXkLifecycleEvent,
	type PiXkSessionLink,
} from "../../../pi-xk-extension/src/index.ts";
import { type CustomEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function isPiXkSessionLinkEntry(entry: SessionEntry): entry is CustomEntry<PiXkSessionLink> {
	return (
		entry.type === "custom" && entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE && isPiXkSessionLink(entry.data)
	);
}

describe("Pi-XK session link integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("validates goal bindings and writes each binding only once across reloads", async () => {
		const binding = createPiXkGoalBinding("goal-123", 0);
		const harness = await createHarness({
			extensionFactories: [createPiXkExtension({ bindings: [binding] })],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		await harness.session.reload();

		const entries = harness.sessionManager.getEntries();
		const links = entries.filter(isPiXkSessionLinkEntry);
		expect(links).toHaveLength(1);
		expect(links[0]?.data).toEqual(binding);
		expect(() => createPiXkGoalBinding("", 0)).toThrow("goalId");
		expect(() => createPiXkGoalBinding("goal-123", -1)).toThrow("generation");
	});

	it("keeps custom bindings in the tree and out of model context", async () => {
		const harness = await createHarness({
			extensionFactories: [createPiXkExtension({ bindings: [createPiXkGoalBinding("goal-tree", 2)] })],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		const entry = harness.sessionManager.getEntries().find(isPiXkSessionLinkEntry);
		expect(entry).toBeDefined();
		expect(harness.sessionManager.getLeafId()).toBe(entry?.id);
		expect(harness.sessionManager.getTree()[0]?.entry.id).toBe(entry?.id);
		expect(harness.sessionManager.buildSessionContext().messages).toEqual([]);
	});

	it("preserves parseable bindings after JSONL reopen and fork", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionDir = join(harness.tempDir, "sessions");
		const source = SessionManager.create(harness.tempDir, sessionDir);
		const binding = createPiXkGoalBinding("goal-persisted", 4);
		source.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, binding);
		source.appendMessage(fauxAssistantMessage("persist custom entry"));
		const sourcePath = source.getSessionFile();
		expect(sourcePath).toBeDefined();
		expect(existsSync(sourcePath!)).toBe(true);

		const reopened = SessionManager.open(sourcePath!);
		const forked = SessionManager.forkFrom(sourcePath!, harness.tempDir, sessionDir);
		for (const sessionManager of [reopened, forked]) {
			const entry = sessionManager.getEntries().find(isPiXkSessionLinkEntry);
			expect(entry).toBeDefined();
			expect(entry?.data).toEqual(binding);
		}
	});

	it("observes turn_end only after the tool result is persisted", async () => {
		const observedContexts: Array<{ event: PiXkLifecycleEvent; roles: string[] }> = [];
		const lifecycle: PiXkLifecycleEvent[] = [];
		let sessionManager: Harness["sessionManager"] | undefined;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				createPiXkExtension({
					onLifecycle: (event) => {
						lifecycle.push(event);
						if (event.type === "turn_end") {
							observedContexts.push({
								event,
								roles: sessionManager?.buildSessionContext().messages.map((message) => message.role) ?? [],
							});
						}
					},
				}),
			],
		});
		harnesses.push(harness);
		sessionManager = harness.sessionManager;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.bindExtensions({});
		await harness.session.prompt("run echo");

		expect(observedContexts[0]?.roles).toContain("toolResult");
		expect(observedContexts.map(({ event }) => event.type)).toEqual(["turn_end", "turn_end"]);
		expect(lifecycle.at(-1)?.type).toBe("agent_settled");
	});

	it("observes native compaction without replacing its summary", async () => {
		const lifecycle: PiXkLifecycleEvent[] = [];
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [createPiXkExtension({ onLifecycle: (event) => lifecycle.push(event) })],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("native Pi history summary"),
			fauxAssistantMessage("native Pi turn prefix"),
		]);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user message" }],
			timestamp: Date.now() - 3_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("first assistant message"));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second user message" }],
			timestamp: Date.now() - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("second assistant message"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		await harness.session.bindExtensions({});
		const result = await harness.session.compact();

		expect(result.summary).toContain("native Pi history summary");
		expect(result.summary).toContain("native Pi turn prefix");
		expect(lifecycle.map((event) => event.type)).toContain("session_before_compact");
		expect(lifecycle.map((event) => event.type)).toContain("session_compact");
		expect(lifecycle.findIndex((event) => event.type === "session_before_compact")).toBeLessThan(
			lifecycle.findIndex((event) => event.type === "session_compact"),
		);
	});
});
