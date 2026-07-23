import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type GoalContractV2, GoalStore } from "../../../pi-xk-core/src/index.ts";
import { createPiXkRuntimeExtension } from "../../../pi-xk-extension/src/extension.ts";
import { createPiXkGoalBinding, PI_XK_SESSION_LINK_CUSTOM_TYPE } from "../../../pi-xk-extension/src/index.ts";
import type { SessionChainHost, SessionChainThreshold } from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { SessionChainController } from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { createPiXkSessionChainExtension } from "../../../pi-xk-extension/src/session-chain-extension.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { type ReadonlySessionManager, SessionManager } from "../../src/core/session-manager.ts";

class ForcedThresholdSessionChainController extends SessionChainController {
	private readonly forcedThreshold: SessionChainThreshold;

	constructor(projectRoot: string, threshold: SessionChainThreshold) {
		super({ projectRoot });
		this.forcedThreshold = threshold;
	}

	override async getThreshold(manager: ReadonlySessionManager) {
		const actual = await super.getThreshold(manager);
		return {
			...actual,
			threshold: this.getCurrentBinding(manager)?.ordinal === 1 ? this.forcedThreshold : "none",
		};
	}
}

function createTestSessionChainController(projectRoot: string): SessionChainController {
	return new SessionChainController({
		projectRoot,
		createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
	});
}

interface ChainRuntimeHarness {
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	projectRoot: string;
	setResponses: ReturnType<typeof registerFauxProvider>["setResponses"];
	providerCalls: () => number;
	cleanup: () => Promise<void>;
}

interface ChainRuntimeOptions {
	projectRoot?: string;
	sessionManager?: SessionManager;
	initializeSession?: (sessionManager: SessionManager) => void;
	uiContext?: ExtensionUIContext;
}

async function createChainRuntime(
	extensionFactory: ExtensionFactory,
	options: ChainRuntimeOptions = {},
): Promise<ChainRuntimeHarness> {
	const projectRoot =
		options.projectRoot ??
		join(tmpdir(), `pi-xk-chain-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(projectRoot, { recursive: true });
	const faux = registerFauxProvider({ models: [{ id: "faux-chain", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(projectRoot, "models.json"),
	});

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: projectRoot,
			modelRuntime,
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
	const initialSessionManager = options.sessionManager ?? SessionManager.create(projectRoot);
	options.initializeSession?.(initialSessionManager);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: projectRoot,
		agentDir: projectRoot,
		sessionManager: initialSessionManager,
	});
	const bind = async (): Promise<void> => {
		await runtime.session.bindExtensions({
			...(options.uiContext ? { uiContext: options.uiContext, mode: "tui" as const } : {}),
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				newSession: (sessionOptions) => runtime.newSession(sessionOptions),
				fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
				navigateTree: (targetId, treeOptions) => runtime.session.navigateTree(targetId, treeOptions),
				switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
				reload: () => runtime.session.reload(),
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind();

	return {
		runtime,
		projectRoot,
		setResponses: faux.setResponses,
		providerCalls: () => faux.state.callCount,
		cleanup: async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
		},
	};
}

function chainTestUi(options: {
	statuses?: Array<{ key: string; text: string | undefined }>;
	notifications?: string[];
	select?: (title: string, choices: string[]) => Promise<string | undefined> | string | undefined;
}): ExtensionUIContext {
	return {
		setStatus: (key: string, text: string | undefined) => options.statuses?.push({ key, text }),
		notify: (message: string) => options.notifications?.push(message),
		select: async (title: string, choices: string[]) => await options.select?.(title, choices),
	} as unknown as ExtensionUIContext;
}

async function createCommittedRollover(projectRoot: string): Promise<{
	sourceFile: string;
	targetFile: string;
	targetSegmentId: string;
}> {
	const source = SessionManager.createAt(projectRoot, join(projectRoot, "committed-source.jsonl"), {
		id: "committed-source",
	});
	source.appendMessage({
		role: "user",
		content: [{ type: "text", text: "source work" }],
		timestamp: Date.now(),
	});
	source.appendMessage(fauxAssistantMessage("source result"));
	source.flushDurable();
	const sourceFile = source.getSessionFile();
	if (!sourceFile) throw new Error("committed source must be persisted");
	const controller = new SessionChainController({ projectRoot });
	await controller.adoptExternalRoot(source);
	let target: SessionManager | undefined;
	const host: SessionChainHost = {
		sessionManager: source,
		model: { contextWindow: 100_000 },
		summarizeSessionContext: async () => ({
			summary:
				"<segment-delta>Committed source work.</segment-delta><carry-forward>Committed carry forward.</carry-forward>",
			model: { provider: "faux", modelId: "faux-summary" },
			thinkingLevel: "medium",
			usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
		}),
		rolloverSession: async (rolloverOptions) => {
			target = SessionManager.createAt(projectRoot, rolloverOptions.targetSessionFile, {
				id: rolloverOptions.targetSessionId,
			});
			await rolloverOptions.initializeTarget(target);
			target.flushDurable();
			await rolloverOptions.finalizeSource(source);
			source.flushDurable();
			const commitContext = {
				sourceSessionFile: sourceFile,
				sourceSessionId: source.getSessionId(),
				sourceLeafId: source.getLeafId(),
				targetSessionFile: rolloverOptions.targetSessionFile,
				targetSessionId: target.getSessionId(),
				targetLeafId: target.getLeafId(),
			};
			await rolloverOptions.commit(commitContext);
			return { cancelled: false, ...commitContext };
		},
	};
	const rollover = await controller.rollover(host, { reason: "prepare committed recovery fixture" });
	if (!target) throw new Error("committed target was not created");
	return {
		sourceFile,
		targetFile: target.getSessionFile()!,
		targetSegmentId: rollover.targetSegmentId,
	};
}

const harnesses: ChainRuntimeHarness[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

describe("Pi-XK Session Chain extension", () => {
	it("bootstraps an empty Pi session into a managed chain before ordinary input", async () => {
		const harness = await createChainRuntime(createPiXkSessionChainExtension());
		harnesses.push(harness);
		const managedSessionFile = harness.runtime.session.sessionFile;
		expect(managedSessionFile).toContain(join(".pi-xk", "sessions", "chains"));
		harness.setResponses([fauxAssistantMessage("first managed response")]);

		await harness.runtime.session.prompt("first managed request");

		const currentSession = harness.runtime.session.sessionManager;
		const currentSessionFile = currentSession.getSessionFile();
		expect(currentSessionFile).toBe(managedSessionFile);
		expect(harness.providerCalls()).toBe(1);
		expect(
			harness.runtime.session.messages
				.filter((message) => message.role === "user")
				.map((message) => message.content),
		).toEqual([[{ type: "text", text: "first managed request" }]]);
		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(currentSession);
		expect(binding).not.toBeNull();
		expect((await controller.getStore().replayChain(binding!.chainId)).branches[0]?.headSegmentId).toBe(
			binding?.segmentId,
		);
	});

	it("adopts an existing persisted Pi transcript as an external root without copying it", async () => {
		let externalSessionFile: string | undefined;
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			initializeSession: (sessionManager) => {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "existing global session" }],
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(fauxAssistantMessage("existing response"));
				sessionManager.flushDurable();
				externalSessionFile = sessionManager.getSessionFile();
			},
		});
		harnesses.push(harness);

		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(binding).not.toBeNull();
		expect(harness.runtime.session.sessionFile).toBe(externalSessionFile);
		expect((await controller.getStore().replayChain(binding!.chainId)).spec.rootSegment.location).toEqual({
			kind: "external-root",
			absolutePath: externalSessionFile,
		});
	});

	it("reopens the committed branch head when startup begins from its sealed source", async () => {
		const projectRoot = join(
			tmpdir(),
			`pi-xk-chain-extension-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(projectRoot, { recursive: true });
		const fixture = await createCommittedRollover(projectRoot);
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			projectRoot,
			sessionManager: SessionManager.open(fixture.sourceFile),
		});
		harnesses.push(harness);

		expect(harness.runtime.session.sessionFile).toBe(fixture.targetFile);
		expect(harness.runtime.session.sessionId).toBe(fixture.targetSegmentId);
	});

	it("adds compact chain status to the native footer after external-root adoption", async () => {
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			uiContext: chainTestUi({ statuses }),
			initializeSession: (sessionManager) => {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "existing footer session" }],
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(fauxAssistantMessage("existing footer response"));
				sessionManager.flushDurable();
			},
		});
		harnesses.push(harness);

		expect(statuses.at(-1)).toEqual({
			key: "pi-xk-chain",
			text: expect.stringMatching(/^Chain [a-z0-9]+ · S1 · [\d.]+ (?:B|KiB|MiB)$/),
		});
	});

	it("automatically rolls over a soft-threshold Segment after the parent settles", async () => {
		const errors: Error[] = [];
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({
				createController: (projectRoot) => new ForcedThresholdSessionChainController(projectRoot, "soft"),
				onChainError: (error) => errors.push(error),
			}),
		);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("soft threshold response"),
			fauxAssistantMessage(
				"<segment-delta>Completed the soft-threshold turn.</segment-delta><carry-forward>Soft-threshold work is complete.</carry-forward>",
			),
		]);

		await harness.runtime.session.prompt("reach the soft threshold");

		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(errors.map((error) => error.message)).toEqual([]);
		expect(binding?.ordinal).toBe(2);
		expect(harness.providerCalls()).toBe(2);
		const replay = await controller.getStore().replayChain(binding!.chainId);
		expect(replay.branches[0]?.segments.map((segment) => segment.status)).toEqual(["sealed", "active"]);
	});

	it("keeps an active Goal alive across a composed runtime rollover", async () => {
		const goalErrors: Error[] = [];
		const chainErrors: Error[] = [];
		const harness = await createChainRuntime(
			createPiXkRuntimeExtension({
				createController: (projectRoot) => new ForcedThresholdSessionChainController(projectRoot, "soft"),
				goal: { onGoalError: (error) => goalErrors.push(error) },
				chain: { onChainError: (error) => chainErrors.push(error) },
			}),
		);
		harnesses.push(harness);
		const goalId = "goal_chain_rollover";
		const createdAt = "2026-07-23T00:00:00.000Z";
		const contract: GoalContractV2 = {
			schema: "pi-xk.goal.contract.v2",
			goalId,
			title: "Rollover lifecycle integration",
			objective: "Continue an active Goal across a Session Chain rollover.",
			constraints: ["Use the Session Chain runtime composition."],
			acceptance: [
				{
					id: "A-1",
					kind: "test",
					description: "The rollover completes.",
					required: true,
					command: "run the composed Session Chain rollover regression",
				},
			],
			capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
			budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
			ownerSessionId: harness.runtime.session.sessionId,
			createdAt,
			schemaVersion: 2,
			nonGoals: ["Do not pause because of the rollover."],
			doneCondition: "Acceptance A-1 has final verification evidence.",
			pauseCondition: "New user input is required.",
			finalReport: "Report the verified rollover.",
			executionAuthorization: "The test may exercise the composed extension.",
		};
		const store = new GoalStore(harness.projectRoot);
		const created = await store.createGoal(contract, {
			eventId: `${goalId}:created`,
			idempotencyKey: `${goalId}:created`,
			actor: "user",
			timestamp: createdAt,
		});
		await store.appendLifecycleEvent(
			goalId,
			{ eventType: "goal_activated", payload: { sessionId: harness.runtime.session.sessionId } },
			{
				eventId: `${goalId}:activated`,
				idempotencyKey: `${goalId}:activated`,
				actor: "user",
				timestamp: createdAt,
				expectedHead: created.head,
			},
		);
		harness.runtime.session.sessionManager.appendCustomEntry(
			PI_XK_SESSION_LINK_CUSTOM_TYPE,
			createPiXkGoalBinding(goalId, 0),
		);
		harness.setResponses([
			fauxAssistantMessage("defer continuation until the physical rollover completes"),
			fauxAssistantMessage(
				"<segment-delta>Rollover completed while the Goal remained active.</segment-delta><carry-forward>Goal continuity was preserved.</carry-forward>",
			),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_end_goal", {
					outcome: "verified",
					reason: "The rollover continuation verified the required acceptance.",
					verifiedAcceptanceIds: ["A-1"],
					finalEvidence: "The composed runtime resumed the active Goal after rollover.",
					finalSummary: "Session Chain rollover preserved the Goal lifecycle.",
				}),
			),
		]);

		await harness.runtime.session.prompt("exercise the composed rollover");
		await harness.runtime.session.waitForIdle();

		const replay = await store.replayGoal(goalId);
		expect(replay.lifecycle.status).toBe("ended");
		expect(replay.events.some((event) => event.eventType === "goal_paused")).toBe(false);
		expect(goalErrors).toEqual([]);
		expect(chainErrors).toEqual([]);
		expect(harness.providerCalls()).toBe(3);
		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		expect(controller.getCurrentBinding(harness.runtime.session.sessionManager)?.ordinal).toBe(2);
	});

	it("rolls over a hard-threshold Segment before delivering the next ordinary input", async () => {
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({
				createController: (projectRoot) => new ForcedThresholdSessionChainController(projectRoot, "hard"),
			}),
			{
				initializeSession: (sessionManager) => {
					sessionManager.appendMessage({
						role: "user",
						content: [{ type: "text", text: "existing hard-threshold work" }],
						timestamp: Date.now(),
					});
					sessionManager.appendMessage(fauxAssistantMessage("existing hard-threshold result"));
					sessionManager.flushDurable();
				},
			},
		);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				"<segment-delta>Existing hard-threshold work.</segment-delta><carry-forward>Preserve existing hard-threshold work.</carry-forward>",
			),
			fauxAssistantMessage("hard threshold response"),
		]);

		await harness.runtime.session.prompt("deliver only after hard rollover");

		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(binding?.ordinal).toBe(2);
		expect(harness.providerCalls()).toBe(2);
		expect(
			harness.runtime.session.messages
				.filter((message) => message.role === "user")
				.map((message) => message.content),
		).toContainEqual([{ type: "text", text: "deliver only after hard rollover" }]);
	});

	it("defers soft-threshold rollover while a domain gate is active", async () => {
		const errors: Error[] = [];
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({
				createController: (projectRoot) => new ForcedThresholdSessionChainController(projectRoot, "soft"),
				getGateState: () => ({ taskRunning: true }),
				onChainError: (error) => errors.push(error),
			}),
		);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("soft gate response")]);

		await harness.runtime.session.prompt("keep the soft Segment active");

		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(binding?.ordinal).toBe(1);
		expect(harness.providerCalls()).toBe(1);
		expect(errors.map((error) => error.message)).toEqual(["Session Chain rollover is blocked by running Task"]);
	});

	it("rejects hard-threshold input while a domain gate is active", async () => {
		const notifications: string[] = [];
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({
				createController: (projectRoot) => new ForcedThresholdSessionChainController(projectRoot, "hard"),
				getGateState: () => ({ goalLifecycleIntentPending: true }),
			}),
			{
				uiContext: chainTestUi({ notifications }),
				initializeSession: (sessionManager) => {
					sessionManager.appendMessage({
						role: "user",
						content: [{ type: "text", text: "hard-gated work" }],
						timestamp: Date.now(),
					});
					sessionManager.appendMessage(fauxAssistantMessage("hard-gated result"));
					sessionManager.flushDurable();
				},
			},
		);
		harnesses.push(harness);

		await harness.runtime.session.prompt("must not reach provider");

		expect(harness.providerCalls()).toBe(0);
		expect(
			harness.runtime.session.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "text" && part.text === "must not reach provider"),
			),
		).toBe(false);
		expect(notifications.at(-1)).toContain(
			"hard-threshold rollover failed; input was not delivered: Session Chain rollover is blocked by Goal lifecycle intent",
		);
	});

	it("reports current Segment status without invoking the provider", async () => {
		const notifications: string[] = [];
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			uiContext: chainTestUi({ notifications }),
			initializeSession: (sessionManager) => {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "status fixture" }],
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(fauxAssistantMessage("status fixture response"));
				sessionManager.flushDurable();
			},
		});
		harnesses.push(harness);

		await harness.runtime.session.prompt("/chain status");

		expect(harness.providerCalls()).toBe(0);
		expect(notifications.at(-1)).toMatch(
			/^Session Chain chain_[A-Za-z0-9_-]+ · branch_[A-Za-z0-9_-]+ · S1 active · [\d.]+ (?:B|KiB|MiB) · \d+ entries · threshold none · writable yes · summary root · gates clear$/,
		);
	});

	it("manually rolls over the current Segment and reports success from the replacement context", async () => {
		const notifications: string[] = [];
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			uiContext: chainTestUi({ notifications }),
			initializeSession: (sessionManager) => {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "manual rollover fixture" }],
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(fauxAssistantMessage("manual rollover response"));
				sessionManager.flushDurable();
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				"<segment-delta>Manual rollover fixture.</segment-delta><carry-forward>Preserve the manual rollover fixture.</carry-forward>",
			),
		]);

		await harness.runtime.session.prompt("/chain rollover manual test");

		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const binding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(binding?.ordinal).toBe(2);
		expect(harness.providerCalls()).toBe(1);
		expect(notifications.at(-1)).toBe(`Session Chain advanced to S2 (${binding?.segmentId})`);
	});

	it("shows chain history, progressive summary, and doctor diagnostics", async () => {
		const notifications: string[] = [];
		const harness = await createChainRuntime(createPiXkSessionChainExtension(), {
			uiContext: chainTestUi({ notifications }),
			initializeSession: (sessionManager) => {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "history fixture" }],
					timestamp: Date.now(),
				});
				sessionManager.appendMessage(fauxAssistantMessage("history fixture response"));
				sessionManager.flushDurable();
			},
		});
		harnesses.push(harness);
		const controller = new SessionChainController({ projectRoot: harness.projectRoot });
		const sourceBinding = controller.getCurrentBinding(harness.runtime.session.sessionManager)!;
		harness.setResponses([
			fauxAssistantMessage(
				"<segment-delta>History fixture delta.</segment-delta><carry-forward>History fixture carry-forward.</carry-forward>",
			),
		]);
		await harness.runtime.session.prompt("/chain rollover history fixture");

		await harness.runtime.session.prompt("/chain history");
		const history = notifications.at(-1);
		expect(history).toContain(`Session Chain history ${sourceBinding.chainId}`);
		expect(history).toContain(`S1 ${sourceBinding.segmentId} sealed`);
		expect(history).toMatch(/S2 [A-Za-z0-9._-]+ active \[head\]/);

		await harness.runtime.session.prompt(`/chain summary ${sourceBinding.segmentId}`);
		const summary = notifications.at(-1);
		expect(summary).toContain("Summary-in:\nNo previous Session Chain segment.");
		expect(summary).toContain("Segment delta:\nHistory fixture delta.");
		expect(summary).toContain("Carry-forward:\nHistory fixture carry-forward.");

		await harness.runtime.session.prompt("/chain doctor");
		expect(notifications.at(-1)).toBe(`Session Chain doctor ${sourceBinding.chainId}: no diagnostics`);
		expect(harness.providerCalls()).toBe(1);
	});

	it("selects catalog heads and resumes a chain by unique prefix without scanning transcripts", async () => {
		const projectRoot = join(tmpdir(), `pi-xk-chain-picker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(projectRoot, { recursive: true });
		const controller = createTestSessionChainController(projectRoot);
		const first = await controller.createManagedRoot({ title: "First Chain" });
		const second = await controller.createManagedRoot({ title: "Second Chain" });
		const notifications: string[] = [];
		const pickerChoices: string[][] = [];
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({ createController: () => controller }),
			{
				projectRoot,
				sessionManager: first.sessionManager,
				uiContext: chainTestUi({
					notifications,
					select: (_title, choices) => {
						pickerChoices.push(choices);
						return choices.find((choice) => choice.includes("Second Chain"));
					},
				}),
			},
		);
		harnesses.push(harness);

		await harness.runtime.session.prompt("/chain");
		expect(pickerChoices).toHaveLength(1);
		expect(controller.getCurrentBinding(harness.runtime.session.sessionManager)?.chainId).toBe(
			second.binding.chainId,
		);
		expect(notifications.at(-1)).toContain(`Session Chain resumed ${second.binding.chainId}`);

		await harness.runtime.session.prompt(`/chain resume ${first.binding.chainId.slice(0, 14)}`);
		expect(controller.getCurrentBinding(harness.runtime.session.sessionManager)?.chainId).toBe(first.binding.chainId);
		expect(notifications.at(-1)).toContain(`Session Chain resumed ${first.binding.chainId}`);
		expect(harness.providerCalls()).toBe(0);
	});

	it("continues a historical Segment as a new branch without modifying the source transcript", async () => {
		const projectRoot = join(tmpdir(), `pi-xk-chain-continue-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(projectRoot, { recursive: true });
		const controller = createTestSessionChainController(projectRoot);
		const root = await controller.createManagedRoot({ title: "Branch Fixture" });
		root.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "branch source" }],
			timestamp: Date.now(),
		});
		root.sessionManager.appendMessage(fauxAssistantMessage("branch source response"));
		root.sessionManager.flushDurable();
		const sourceEntryId = root.sessionManager.getLeafId()!;
		const notifications: string[] = [];
		const harness = await createChainRuntime(
			createPiXkSessionChainExtension({ createController: () => controller }),
			{
				projectRoot,
				sessionManager: root.sessionManager,
				uiContext: chainTestUi({ notifications }),
			},
		);
		harnesses.push(harness);
		const sourceBytes = readFileSync(root.sessionFile);
		harness.setResponses([
			fauxAssistantMessage(
				"<segment-delta>Branch source delta.</segment-delta><carry-forward>Branch source carry-forward.</carry-forward>",
			),
		]);

		await harness.runtime.session.prompt(`/chain continue ${root.binding.segmentId} ${sourceEntryId}`);

		expect((await controller.getStore().replayChain(root.binding.chainId)).branches).toHaveLength(2);
		const targetBinding = controller.getCurrentBinding(harness.runtime.session.sessionManager);
		expect(targetBinding?.chainId).toBe(root.binding.chainId);
		expect(targetBinding?.branchId).not.toBe(root.binding.branchId);
		expect(targetBinding?.ordinal).toBe(1);
		expect(targetBinding?.predecessorSegmentId).toBe(root.binding.segmentId);
		expect(readFileSync(root.sessionFile)).toEqual(sourceBytes);
		expect((await controller.getStore().replayChain(root.binding.chainId)).branches).toHaveLength(2);
		expect(harness.providerCalls()).toBe(1);
		expect(notifications.at(-1)).toContain("Session Chain successor branch");
	});
});
