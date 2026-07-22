import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type FauxResponseFactory,
	fauxAssistantMessage,
	registerFauxProvider,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeRolloverEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const SUMMARY_USAGE: Usage = {
	input: 120,
	output: 24,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 144,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("extension session context summarization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("summarizes with the current model without modifying the transcript", async () => {
		let capturedContext = "";
		let capturedMaxTokens: number | undefined;
		let result: Awaited<ReturnType<ExtensionContext["summarizeSessionContext"]>> | undefined;
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "new segment facts" }],
				timestamp: Date.now(),
			},
		];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("summarize-context", {
						description: "exercise host summarization",
						handler: async (_args, ctx) => {
							result = await ctx.summarizeSessionContext({
								messages,
								previousSummary: "previous segment summary",
								customInstructions: "Return a cumulative carry-forward summary.",
								maxOutputTokens: 2048,
							});
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const entriesBefore = harness.sessionManager.getEntries();
		const messagesBefore = harness.session.messages.slice();

		harness.session.agent.streamFn = (model, context, options) => {
			capturedContext = JSON.stringify(context);
			capturedMaxTokens = options?.maxTokens;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = {
					...fauxAssistantMessage("cumulative summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: SUMMARY_USAGE,
				};
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		};

		await harness.session.prompt("/summarize-context");

		expect(result).toMatchObject({
			summary: "cumulative summary",
			model: { provider: harness.getModel().provider, modelId: harness.getModel().id },
			thinkingLevel: harness.session.thinkingLevel,
			usage: SUMMARY_USAGE,
		});
		expect(capturedContext).toContain("new segment facts");
		expect(capturedContext).toContain("<previous-summary>");
		expect(capturedContext).toContain("previous segment summary");
		expect(capturedMaxTokens).toBe(2048);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.messages).toEqual(messagesBefore);
	});
});

describe("AgentSessionRuntime rollover", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options: { failRolloverRuntime?: boolean } = {},
	) {
		const tempDir = join(tmpdir(), `pi-rollover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses([fauxAssistantMessage("source response")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			if (options.failRolloverRuntime && sessionStartEvent?.reason === "rollover") {
				throw new Error("replacement runtime failed");
			}
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		const bind = async (): Promise<void> => {
			await runtime.session.bindExtensions({});
		};
		runtime.setRebindSession(bind);
		await bind();

		cleanups.push(async () => {
			try {
				await runtime.dispose();
			} catch {
				// A deliberately failed committed rollover leaves no active runtime to dispose.
			}
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return { runtime, faux, tempDir };
	}

	it("durably prepares both files, commits the domain, and replaces the runtime", async () => {
		const lifecycle: Array<SessionBeforeRolloverEvent | SessionShutdownEvent | SessionStartEvent | string> = [];
		let oldContext: ExtensionContext | undefined;
		let targetSessionFile = "";
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_rollover", (event) => {
				lifecycle.push(event);
			});
			pi.on("session_shutdown", (event) => {
				lifecycle.push(event);
			});
			pi.on("session_start", (event) => {
				lifecycle.push(event);
			});
			pi.registerCommand("rollover-test", {
				description: "exercise host rollover",
				handler: async (_args, ctx) => {
					oldContext = ctx;
					targetSessionFile = join(ctx.cwd, "segments", "000002_segment-2.jsonl");
					await ctx.rolloverSession({
						targetSessionFile,
						targetSessionId: "segment-2",
						reason: "test threshold",
						initializeTarget: (target) => {
							lifecycle.push("target initialized");
							target.appendCustomMessageEntry("session_chain_summary_in", "carry forward", false);
						},
						finalizeSource: (source) => {
							lifecycle.push("source finalized");
							source.appendCustomEntry("session_chain_summary_out", { summary: "carry forward" });
						},
						commit: async ({ sourceSessionFile, targetSessionFile: committedTarget }) => {
							expect(readFileSync(committedTarget, "utf8")).toContain("session_chain_summary_in");
							expect(readFileSync(sourceSessionFile, "utf8")).toContain("session_chain_summary_out");
							lifecycle.push("domain committed");
						},
						withSession: async (newContext) => {
							expect(newContext.sessionManager.getSessionId()).toBe("segment-2");
							lifecycle.push("with replacement");
						},
					});
				},
			});
		});
		await runtime.session.prompt("seed source");
		const sourceSessionFile = runtime.session.sessionFile!;
		lifecycle.length = 0;

		await runtime.session.prompt("/rollover-test");

		expect(runtime.session.sessionFile).toBe(targetSessionFile);
		expect(runtime.session.sessionId).toBe("segment-2");
		expect(runtime.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(existsSync(sourceSessionFile)).toBe(true);
		expect(existsSync(targetSessionFile)).toBe(true);
		expect(() => oldContext?.sessionManager.getSessionId()).toThrow(/stale/);
		expect(lifecycle).toEqual([
			{
				type: "session_before_rollover",
				reason: "test threshold",
				sourceSessionFile,
				targetSessionFile,
				targetSessionId: "segment-2",
			},
			"target initialized",
			"source finalized",
			"domain committed",
			{ type: "session_shutdown", reason: "rollover", targetSessionFile },
			{ type: "session_start", reason: "rollover", previousSessionFile: sourceSessionFile },
			"with replacement",
		]);
		expect(targetSessionFile.startsWith(join(tempDir, "segments"))).toBe(true);
	});

	it("reuses an already committed target without writing either transaction callback", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("seed source");
		const targetSessionFile = join(tempDir, "segments", "000002_recovered.jsonl");
		const target = SessionManager.createAt(tempDir, targetSessionFile, { id: "recovered-segment" });
		target.appendCustomMessageEntry("session_chain_summary_in", "recovered carry forward", false);
		target.flushDurable();

		const result = await runtime.rolloverSession({
			targetSessionFile,
			targetSessionId: "recovered-segment",
			reason: "recover committed chain head",
			reuseTarget: true,
		});

		expect(result).toMatchObject({ cancelled: false, targetSessionId: "recovered-segment" });
		expect(runtime.session.sessionFile).toBe(targetSessionFile);
		expect(runtime.session.sessionId).toBe("recovered-segment");
		expect(readFileSync(targetSessionFile, "utf8").match(/session_chain_summary_in/g)).toHaveLength(1);
	});

	it("honors cancellation before running rollover callbacks", async () => {
		let callbackCalled = false;
		const { runtime, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_rollover", () => ({ cancel: true }));
		});
		await runtime.session.prompt("seed source");
		const originalSession = runtime.session;

		const result = await runtime.rolloverSession({
			targetSessionFile: join(tempDir, "segments", "000002_cancelled.jsonl"),
			targetSessionId: "cancelled",
			reason: "cancel me",
			initializeTarget: () => {
				callbackCalled = true;
			},
			finalizeSource: () => {
				callbackCalled = true;
			},
			commit: async () => {
				callbackCalled = true;
			},
		});

		expect(result).toEqual({ cancelled: true });
		expect(callbackCalled).toBe(false);
		expect(runtime.session).toBe(originalSession);
	});

	it("rejects rollover while user input is queued", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.steer("queued input");

		await expect(
			runtime.rolloverSession({
				targetSessionFile: join(tempDir, "segments", "000002_pending.jsonl"),
				targetSessionId: "pending",
				reason: "pending input",
				initializeTarget: () => {},
				finalizeSource: () => {},
				commit: async () => {},
			}),
		).rejects.toThrow("queued messages");
	});

	it("rejects rollover while an agent run is active", async () => {
		let releaseResponse: (() => void) | undefined;
		const responseRelease = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const delayedResponse: FauxResponseFactory = async () => {
			await responseRelease;
			return fauxAssistantMessage("delayed response");
		};
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		faux.setResponses([delayedResponse]);
		const prompt = runtime.session.prompt("keep the agent busy");
		while (faux.state.callCount === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		await expect(
			runtime.rolloverSession({
				targetSessionFile: join(tempDir, "segments", "000002_busy.jsonl"),
				targetSessionId: "busy",
				reason: "busy agent",
				initializeTarget: () => {},
				finalizeSource: () => {},
				commit: async () => {},
			}),
		).rejects.toThrow("settled, idle session");

		releaseResponse?.();
		await prompt;
	});

	it("freezes new transcript input while target initialization is pending", async () => {
		let releaseInitialization: (() => void) | undefined;
		let signalInitializationStarted: (() => void) | undefined;
		const initializationRelease = new Promise<void>((resolve) => {
			releaseInitialization = resolve;
		});
		const initializationStarted = new Promise<void>((resolve) => {
			signalInitializationStarted = resolve;
		});
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("seed source");

		const rollover = runtime.rolloverSession({
			targetSessionFile: join(tempDir, "segments", "000002_frozen.jsonl"),
			targetSessionId: "frozen",
			reason: "freeze source",
			initializeTarget: async (target) => {
				target.appendCustomMessageEntry("session_chain_summary_in", "carry forward", false);
				signalInitializationStarted?.();
				await initializationRelease;
			},
			finalizeSource: (source) => {
				source.appendCustomEntry("session_chain_summary_out", { summary: "carry forward" });
			},
			commit: async () => {},
		});
		await initializationStarted;

		await expect(runtime.session.prompt("late input")).rejects.toThrow("source transcript is read-only");
		releaseInitialization?.();
		await expect(rollover).resolves.toMatchObject({ cancelled: false, targetSessionId: "frozen" });
	});

	it("fails closed when domain commit fails after the source is finalized", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("seed source");

		await expect(
			runtime.rolloverSession({
				targetSessionFile: join(tempDir, "segments", "000002_commit-failure.jsonl"),
				targetSessionId: "commit-failure",
				reason: "commit failure",
				initializeTarget: (target) => {
					target.appendCustomMessageEntry("session_chain_summary_in", "carry forward", false);
				},
				finalizeSource: (source) => {
					source.appendCustomEntry("session_chain_summary_out", { summary: "carry forward" });
				},
				commit: async () => {
					throw new Error("domain commit failed");
				},
			}),
		).rejects.toThrow("domain commit failed");

		expect(() => runtime.session).toThrow(/prepared rollover finalized the source session/);
	});

	it("does not fall back to the source runtime after a committed replacement fails", async () => {
		let committed = false;
		const { runtime, tempDir } = await createRuntimeForTest(() => {}, { failRolloverRuntime: true });
		await runtime.session.prompt("seed source");

		await expect(
			runtime.rolloverSession({
				targetSessionFile: join(tempDir, "segments", "000002_failed-runtime.jsonl"),
				targetSessionId: "failed-runtime",
				reason: "runtime failure",
				initializeTarget: (target) => {
					target.appendCustomMessageEntry("session_chain_summary_in", "carry forward", false);
				},
				finalizeSource: (source) => {
					source.appendCustomEntry("session_chain_summary_out", { summary: "carry forward" });
				},
				commit: async () => {
					committed = true;
				},
			}),
		).rejects.toThrow("replacement runtime failed");

		expect(committed).toBe(true);
		expect(() => runtime.session).toThrow(/committed rollover target/);
	});
});
