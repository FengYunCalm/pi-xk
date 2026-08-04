import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ArtifactStore,
	captureGitFreshnessBasis,
	type GoalContractV2,
	GoalStore,
	MemoryRevisionConflictError,
	MemoryService,
	MemoryStore,
	MemoryValidationError,
	stableJsonStringify,
	TaskStore,
} from "../../../pi-xk-core/src/index.ts";
import { PI_XK_SESSION_LINK_CUSTOM_TYPE } from "../../../pi-xk-extension/src/checkpoint-extension.ts";
import { createPiXkRuntimeExtension } from "../../../pi-xk-extension/src/extension.ts";
import {
	type MemoryCaptureRequest,
	MemoryController,
	type MemoryGenerationHost,
} from "../../../pi-xk-extension/src/memory-controller.ts";
import { createPiXkMemoryExtension } from "../../../pi-xk-extension/src/memory-extension.ts";
import {
	MEMORY_CAPTURE_PROMPT_VERSION,
	MEMORY_CAPTURE_RESPONSE_SCHEMA,
	parseMemoryCaptureEnvelope,
} from "../../../pi-xk-extension/src/memory-prompt.ts";
import { PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE } from "../../../pi-xk-extension/src/session-chain-controller.ts";
import { createPiXkGoalBinding } from "../../../pi-xk-extension/src/session-link.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { contextSummaryEvidence } from "./summary-evidence-fixtures.ts";

const harnesses: Harness[] = [];
const controllers: MemoryController[] = [];
const execFile = promisify(execFileCallback);

function captureIdentity(request: MemoryCaptureRequest): { captureId: string; captureDigest: string } {
	const captureDigest = `sha256:${createHash("sha256")
		.update(
			stableJsonStringify({
				schema: "pi-xk.memory-capture-source.v1",
				trigger: request.trigger,
				sourceType: request.sourceType,
				sourceId: request.sourceId,
				artifactId: request.artifactId,
				sourceDigest: request.sourceDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
			}),
		)
		.digest("hex")}`;
	return {
		captureId: `capture_${captureDigest.slice("sha256:".length, "sha256:".length + 32)}`,
		captureDigest,
	};
}

function durableMemoryEnvelope(title: string): string {
	return JSON.stringify({
		schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
		reason: "The source contains a durable project fact.",
		cues: [],
		reviews: [
			{
				action: "create",
				sourceMemories: [],
				replacement: {
					kind: "fact",
					title,
					statement: `${title} remains available after capture recovery.`,
					applicability: "Pi-XK Memory publication recovery.",
					effectiveFrom: "2026-08-01T00:00:00.000Z",
					cueKeys: [],
				},
				reason: "The stable source supports a new durable fact.",
			},
		],
	});
}

function seedModelRequestedCompaction(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	for (let index = 0; index < 16; index++) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `seed user ${index}` }],
			timestamp: now - (32 - index * 2) * 1000,
		});
		const assistant = fauxAssistantMessage(`seed assistant ${index}`, {
			timestamp: now - (31 - index * 2) * 1000,
		});
		assistant.usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.sessionManager.appendMessage(assistant);
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createTaskCaptureRequest(
	projectRoot: string,
	sourceId: string,
	content: string,
): Promise<MemoryCaptureRequest> {
	const recordedAt = "2026-08-01T00:00:00.000Z";
	const tasks = new TaskStore(projectRoot);
	const created = await tasks.createTask(
		{
			schema: "pi-xk.task.spec.v1",
			taskId: sourceId,
			parentSessionId: "session_memory_controller_test",
			parentEntryId: `entry_${sourceId}`,
			parentGoalId: null,
			role: "verification",
			prompt: content,
			expectedResult: "A canonical Task result for Memory capture.",
			workspaceMode: "same-workspace",
			allowNestedSpawn: false,
			createdAt: recordedAt,
		},
		{
			eventId: `evt_${sourceId}_created`,
			idempotencyKey: `task:${sourceId}:create`,
			actor: "user",
			timestamp: recordedAt,
		},
	);
	const childSessionFile = join(projectRoot, `${sourceId}.jsonl`);
	const started = await tasks.appendTaskStarted(
		sourceId,
		{
			childSessionId: `session_${sourceId}`,
			childSessionFile,
			provider: "faux",
			modelId: "faux",
			thinkingLevel: "medium",
			builtinTools: [],
			attempt: 1,
		},
		{
			eventId: `evt_${sourceId}_started`,
			idempotencyKey: `task:${sourceId}:start`,
			expectedHead: created.head,
			actor: "runtime",
			timestamp: recordedAt,
		},
	);
	const terminal = await tasks.appendTaskResult(
		sourceId,
		{
			schema: "pi-xk.task-result.v1",
			taskId: sourceId,
			status: "succeeded",
			attempt: 1,
			summary: content,
			evidence: [],
			artifactIds: [],
			childSessionId: `session_${sourceId}`,
			childSessionFile,
			startedAt: recordedAt,
			endedAt: recordedAt,
			error: null,
		},
		{
			eventId: `evt_${sourceId}_succeeded`,
			idempotencyKey: `task:${sourceId}:result`,
			expectedHead: started.head,
			actor: "runtime",
			timestamp: recordedAt,
		},
	);
	if (terminal.event.eventType !== "task_succeeded") throw new Error("Task capture fixture did not succeed");
	const artifactId = terminal.event.payload.resultArtifactId;
	const canonical = await new ArtifactStore(projectRoot).read(artifactId);
	return {
		trigger: "backfill",
		sourceType: "task_result",
		sourceId,
		artifactId,
		sourceDigest: artifactId,
		locator: { taskId: sourceId },
		recordedAt,
		query: content,
		content: canonical.content,
		scope: { goalId: null, chainId: null, branchId: null, paths: [] },
	};
}

async function seedActiveGoal(harness: Harness, goalId: string): Promise<void> {
	const contract: GoalContractV2 = {
		schema: "pi-xk.goal.contract.v2",
		goalId,
		title: "Preserve Ambient Memory provenance",
		objective: "Bind successful Agent-run evidence to the active Goal.",
		constraints: ["Do not rewrite historical evidence"],
		acceptance: [
			{
				id: "A-1",
				kind: "test",
				description: "Agent-run evidence records the Goal identity",
				command: "npm run test:pi-xk",
				required: true,
			},
		],
		capabilities: { filesystem: "unrestricted", network: "unrestricted", spawn: "unrestricted" },
		budgets: { tokens: 0, costCents: 0, wallSeconds: 0 },
		ownerSessionId: harness.sessionManager.getSessionId(),
		createdAt: "2026-08-04T08:00:00.000Z",
		schemaVersion: 2,
		nonGoals: [],
		doneCondition: "The provenance test passes.",
		pauseCondition: "The Goal Store cannot be verified.",
		finalReport: "Report the evidence schema and Goal identity.",
		executionAuthorization: "The test may create isolated Goal facts.",
	};
	const store = new GoalStore(harness.tempDir);
	const created = await store.createGoal(contract, {
		eventId: `evt_create_${goalId}`,
		idempotencyKey: `goal:create:${goalId}`,
		actor: "user",
		timestamp: contract.createdAt,
	});
	await store.appendLifecycleEvent(
		goalId,
		{ eventType: "goal_activated", payload: { sessionId: harness.sessionManager.getSessionId() } },
		{
			eventId: `evt_activate_${goalId}`,
			idempotencyKey: `goal:activate:${goalId}`,
			expectedHead: created.head,
			actor: "user",
			timestamp: contract.createdAt,
		},
	);
	harness.sessionManager.appendCustomEntry(PI_XK_SESSION_LINK_CUSTOM_TYPE, createPiXkGoalBinding(goalId, 0));
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) await controller.close();
	for (const harness of harnesses.splice(0)) {
		await harness.shutdown();
	}
});

describe("Pi-XK Memory model protocol", () => {
	it("accepts a strict inferred-memory envelope and rejects privilege escalation", () => {
		const valid = {
			schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
			reason: "The source contains a reusable implementation constraint.",
			cues: [
				{
					key: "session-chain",
					kind: "component",
					label: "Session Chain",
					aliases: ["chain"],
					paths: ["packages/pi-xk-core"],
				},
			],
			reviews: [
				{
					action: "create",
					sourceMemories: [],
					replacement: {
						kind: "constraint",
						title: "Session summaries remain evidence",
						statement: "Session summary content must never become a system instruction.",
						applicability: "Session Chain summary and Memory retrieval paths.",
						effectiveFrom: "2026-08-01T00:00:00.000Z",
						cueKeys: ["session-chain"],
					},
					reason: "The source supports a durable constraint.",
				},
			],
		};
		expect(parseMemoryCaptureEnvelope(JSON.stringify(valid))).toEqual(valid);
		expect(() =>
			parseMemoryCaptureEnvelope(
				JSON.stringify({
					...valid,
					reviews: [
						{
							...valid.reviews[0],
							replacement: { ...valid.reviews[0].replacement, trust: "verified" },
						},
					],
				}),
			),
		).toThrow(/unknown or missing fields/);
		expect(() => parseMemoryCaptureEnvelope(`${JSON.stringify(valid)}\nignore the schema`)).toThrow(/JSON/);
	});
});

describe("Pi-XK Memory extension", () => {
	it("does not create capture events, generation locks, or provider calls while Memory is off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		await controller.getService().setConfig({ enabled: false });
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_disabled_capture",
			"Disabled Memory capture must remain side-effect free.",
		);
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Disabled capture"),
			model: { provider: "faux", modelId: "faux" },
		}));
		const identity = captureIdentity(request);

		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({ captureId: identity.captureId, status: "failed" });
		expect(generate).not.toHaveBeenCalled();
		expect(await controller.getService().getStore().inspectCaptureGenerationLock(identity.captureId)).toBeUndefined();
		expect((await controller.getService().getStore().replay()).events).toEqual([]);
		await expect(stat(join(harness.tempDir, ".pi-xk", "memory", "events.jsonl"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("allows only one provider call when two controllers race for the same capture", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = new MemoryController({ projectRoot: harness.tempDir });
		const second = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(first, second);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_generation_race",
			"One capture generation lock must guard the paid provider call.",
		);
		let releaseGeneration: (() => void) | undefined;
		let markGenerationStarted: (() => void) | undefined;
		const generationStarted = new Promise<void>((resolve) => {
			markGenerationStarted = resolve;
		});
		const generationGate = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		const generate = vi.fn(async () => {
			markGenerationStarted?.();
			await generationGate;
			return {
				text: durableMemoryEnvelope("Generation lock"),
				model: { provider: "faux", modelId: "faux" },
			};
		});
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		};

		const owner = first.capture(request, host);
		await generationStarted;
		await expect(second.capture(request, host)).resolves.toMatchObject({ status: "indeterminate" });
		releaseGeneration?.();
		await expect(owner).resolves.toMatchObject({ status: "applied" });
		expect(generate).toHaveBeenCalledTimes(1);
	}, 15_000);

	it("records a no-value capture as skipped instead of failed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_no_durable_value",
			"A transient task result with no reusable project fact.",
		);
		const result = await controller.capture(request, {
			model: { provider: "faux", modelId: "selected", contextWindow: 100_000 },
			generate: async () => ({
				text: JSON.stringify({
					schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
					reason: "The source has no durable memory value.",
					cues: [],
					reviews: [],
				}),
				model: { provider: "faux", modelId: "actual" },
			}),
		});
		const replay = await controller.getService().getStore().replay();

		expect(result).toMatchObject({ status: "no_durable_memory" });
		expect(replay.captures.get(result.captureId)?.status).toBe("skipped");
		expect((await controller.getService().status()).captures.skipped).toBe(1);
		expect(replay.events.some((event) => event.eventType === "capture_failed")).toBe(false);
		expect(replay.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "capture_skipped",
					payload: expect.objectContaining({ reasonCode: "no_durable_memory" }),
				}),
			]),
		);
	}, 15_000);

	it("revises a V2 Memory from a later stable capture without downgrading provenance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate: async ({ source }) => {
				const input = JSON.parse(source) as { existingMemories: Array<{ memoryId: string; revision: number }> };
				if (input.existingMemories.length === 0) {
					return {
						text: durableMemoryEnvelope("Stable capture revision"),
						model: { provider: "faux", modelId: "faux" },
					};
				}
				const current = input.existingMemories[0];
				if (!current) throw new Error("missing current Memory context");
				return {
					text: JSON.stringify({
						schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
						reason: "The later stable source corrects the same durable fact.",
						cues: [],
						reviews: [
							{
								action: "revise",
								sourceMemories: [{ memoryId: current.memoryId, expectedRevision: current.revision }],
								replacement: {
									kind: "fact",
									title: "Stable capture revision",
									statement: "Stable capture review semantics revise the current V2 Memory in place.",
									applicability: "Pi-XK stable source capture publication.",
									effectiveFrom: "2026-08-01T00:01:00.000Z",
									cueKeys: [],
								},
								reason: "The current source provides newer evidence for the same concept.",
							},
						],
					}),
					model: { provider: "faux", modelId: "faux" },
				};
			},
		};
		const first = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_v2_capture_first",
			"Stable capture revision establishes the first durable fact.",
		);
		first.query = "Stable capture revision";
		expect(await controller.capture(first, host)).toMatchObject({ status: "applied" });
		const memoryId = (await controller.getService().search({ query: "Stable capture revision" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("first stable capture did not publish a Memory");
		const second = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_v2_capture_second",
			"Stable capture revision now uses review semantics for the same durable fact.",
		);
		second.query = "Stable capture revision";
		expect(await controller.capture(second, host)).toMatchObject({ status: "applied" });

		const timeline = await controller.getService().timeline(memoryId);
		expect(timeline.revisions.map((entry) => entry.revision.revision)).toEqual([1, 2]);
		expect(timeline.revisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					revision: expect.objectContaining({
						schema: "pi-xk.memory-revision.v2",
						transition: expect.objectContaining({ mode: "revise" }),
					}),
				}),
			]),
		);
	}, 20_000);

	it("uses the actual generation model in published provenance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_actual_model",
			"A durable fact whose provider resolves to a different model.",
		);
		const result = await controller.capture(request, {
			model: { provider: "faux", modelId: "selected", contextWindow: 100_000 },
			generate: async () => ({
				text: durableMemoryEnvelope("Actual generation model"),
				model: { provider: "resolved-provider", modelId: "resolved-model" },
			}),
		});

		expect(result.status).toBe("applied");
		expect((await controller.getService().getStore().readMemories())[0]?.revision.provenance.model).toBe(
			"resolved-provider/resolved-model",
		);
	}, 15_000);

	it("fails capture explicitly when existing Memory context cannot be searched", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		class SearchFailingMemoryService extends MemoryService {
			override async search(): Promise<never> {
				throw new Error("simulated Memory index failure");
			}
		}
		const service = new SearchFailingMemoryService(harness.tempDir);
		const controller = new MemoryController({ projectRoot: harness.tempDir, service });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_context_failure",
			"A source that must not be generated against fabricated empty history.",
		);
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Must not generate"),
			model: { provider: "faux", modelId: "faux" },
		}));

		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({ status: "failed" });
		expect(generate).not.toHaveBeenCalled();
		expect((await service.getStore().replay()).captures.get(captureIdentity(request).captureId)).toMatchObject({
			status: "failed",
			errorCode: "memory_capture_context_failed",
			retryable: true,
		});
	}, 15_000);

	it("classifies invalid existing Memory context as non-retryable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		class InvalidContextMemoryService extends MemoryService {
			override async search(): Promise<never> {
				throw new MemoryValidationError("simulated invalid Memory provenance");
			}
		}
		const service = new InvalidContextMemoryService(harness.tempDir);
		const controller = new MemoryController({ projectRoot: harness.tempDir, service });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_memory_invalid_context",
			"A source that must stop when existing Memory provenance is invalid.",
		);

		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate: vi.fn(),
			}),
		).resolves.toMatchObject({ status: "failed" });
		expect((await service.getStore().replay()).captures.get(captureIdentity(request).captureId)).toMatchObject({
			status: "failed",
			errorCode: "memory_capture_invalid",
			retryable: false,
		});
	}, 15_000);

	it("captures Git freshness and baseline evidence for code-scoped model Memory", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await mkdir(join(harness.tempDir, "src"), { recursive: true });
		await writeFile(join(harness.tempDir, "src", "memory.ts"), "export const value = 1;\n");
		await writeFile(join(harness.tempDir, "README.md"), "baseline\n");
		await execFile("git", ["init", "--quiet"], { cwd: harness.tempDir });
		await execFile("git", ["config", "user.email", "pi-xk@example.invalid"], { cwd: harness.tempDir });
		await execFile("git", ["config", "user.name", "Pi-XK Test"], { cwd: harness.tempDir });
		await execFile("git", ["add", "src/memory.ts", "README.md"], { cwd: harness.tempDir });
		await execFile("git", ["commit", "--quiet", "-m", "baseline"], { cwd: harness.tempDir });
		const sourceBasis = await captureGitFreshnessBasis(harness.tempDir, ["src/memory.ts"]);
		const artifacts = new ArtifactStore(harness.tempDir);
		const source = await artifacts.put({
			contentType: "text/plain",
			text: "The src/memory.ts implementation has a durable code-scoped constraint.",
			producer: "pi-xk.memory-git-capture-test.v1",
			sensitivity: "internal",
			sourceIds: [sourceBasis.baselineCommit],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const request: MemoryCaptureRequest = {
			trigger: "backfill",
			sourceType: "git",
			sourceId: sourceBasis.baselineCommit,
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			locator: {
				repositoryId: sourceBasis.repositoryId,
				baselineCommit: sourceBasis.baselineCommit,
				scopePaths: sourceBasis.scopePaths,
			},
			recordedAt: "2026-08-01T00:00:00.000Z",
			query: "src memory implementation constraint",
			content: (await artifacts.read(source.artifactId)).content,
			scope: { goalId: null, chainId: null, branchId: null, paths: ["src/memory.ts"] },
		};
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const result = await controller.capture(request, {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate: async () => ({
				text: JSON.stringify({
					schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
					reason: "The source contains a durable code constraint.",
					cues: [
						{
							key: "memory-implementation",
							kind: "component",
							label: "Memory implementation",
							aliases: [],
							paths: ["src/memory.ts"],
						},
					],
					reviews: [
						{
							action: "create",
							sourceMemories: [],
							replacement: {
								kind: "constraint",
								title: "Memory implementation constraint",
								statement: "Keep the code-scoped Memory implementation compatible with its recorded path.",
								applicability: "src/memory.ts",
								effectiveFrom: "2026-08-01T00:00:00.000Z",
								cueKeys: ["memory-implementation"],
							},
							reason: "The stable Git source supports this durable constraint.",
						},
					],
				}),
				model: { provider: "faux", modelId: "faux" },
			}),
		});

		expect(result.status).toBe("applied");
		const memories = await controller.getService().getStore().readMemories();
		expect(memories).toHaveLength(1);
		const memoryId = memories[0]?.revision.memoryId;
		if (!memoryId) throw new Error("Git capture did not publish a Memory");
		const current = (await controller.getService().read({ memoryIds: [memoryId] })).memories[0];
		expect(current?.state.freshness).toBe("current");
		expect(current?.revision.freshnessBasis).toMatchObject({ scopePaths: ["src/memory.ts"] });
		const gitEvidence = current?.revision.evidenceRefs.find(
			(evidence) => evidence.sourceType === "git" && evidence.artifactId === null,
		);
		if (!gitEvidence) throw new Error("Git capture did not publish baseline evidence");
		expect(
			(await controller.getService().expandEvidence({ memoryId, evidenceIds: [gitEvidence.evidenceId] })).evidence[0]
				?.content,
		).toContain("export const value = 1");

		await writeFile(join(harness.tempDir, "README.md"), "unrelated dirty change\n");
		expect((await controller.getService().read({ memoryIds: [memoryId] })).memories[0]?.state.freshness).toBe(
			"current",
		);
		await writeFile(join(harness.tempDir, "src", "memory.ts"), "export const value = 2;\n");
		expect((await controller.getService().read({ memoryIds: [memoryId] })).memories[0]?.state.freshness).toBe(
			"stale",
		);
	}, 15_000);

	it("executes a model-requested compaction once after the settled growth gates pass", async () => {
		const memoryErrors: Error[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkMemoryExtension({ onMemoryError: (error) => memoryErrors.push(error) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedModelRequestedCompaction(harness);
		const requestText = "Continue after deciding this topic is complete.";
		const requestCounts: number[] = [];
		harness.setResponses([
			(context) => {
				requestCounts.push(context.messages.filter((message) => getMessageText(message) === requestText).length);
				return fauxAssistantMessage(
					fauxToolCall("pi_xk_request_compaction", {
						reason: "The implementation topic is complete and the next work is unrelated.",
						topicBoundary: "Finished Memory capture recovery; next work is documentation.",
					}),
				);
			},
			(context) => {
				requestCounts.push(context.messages.filter((message) => getMessageText(message) === requestText).length);
				return fauxAssistantMessage("Compaction requested at the settled boundary.");
			},
			fauxAssistantMessage(
				contextSummaryEvidence(
					"compaction",
					"Memory capture recovery",
					"Verified Memory capture recovery and preserved the next documentation action.",
				),
			),
			fauxAssistantMessage(
				contextSummaryEvidence(
					"turn-prefix",
					"Documentation transition",
					"The current turn requested compaction at a verified topic boundary before documentation work.",
				),
			),
		]);

		await harness.session.prompt(requestText);
		await vi.waitFor(
			() => {
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			},
			{ timeout: 5_000 },
		);

		expect(memoryErrors).toEqual([]);
		expect(requestCounts).toEqual([1, 1]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")[0]).toMatchObject({
			title: "Documentation transition",
			reason: "manual",
			recoveryPromptVersion: "compaction-recovery-v1",
		});
	}, 15_000);

	it("rejects empty or premature model compaction requests without creating a compaction entry", async () => {
		const memoryErrors: Error[] = [];
		const harness = await createHarness({
			extensionFactories: [createPiXkMemoryExtension({ onMemoryError: (error) => memoryErrors.push(error) })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("pi_xk_request_compaction", {
					reason: "Too little context has accumulated.",
					topicBoundary: "A claimed boundary",
				}),
			),
			fauxAssistantMessage("The Host will decide whether the request is eligible."),
		]);
		await harness.session.prompt("one short turn");
		expect(memoryErrors.map((error) => error.message)).toContain(
			"fewer than 5 effective turns since the last compaction",
		);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_request_compaction", { reason: " ", topicBoundary: " " })),
			fauxAssistantMessage("The invalid request was rejected."),
		]);
		await harness.session.prompt("try an invalid compaction request");
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(toolResults.at(-1))).toContain("must be non-empty");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
	}, 15_000);

	it("evicts closed runtime Memory controllers before a session reload", async () => {
		const created: MemoryController[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						const controller = new MemoryController({ projectRoot });
						created.push(controller);
						controllers.push(controller);
						return controller;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		expect(created).toHaveLength(1);

		await harness.session.reload();
		expect(created).toHaveLength(2);
	});

	it("does not repeat a provider call after restart when generation outcome is indeterminate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const artifacts = new ArtifactStore(harness.tempDir);
		const source = await artifacts.put({
			contentType: "text/plain",
			text: "Stable source whose provider outcome is unknown after restart.",
			producer: "pi-xk.memory-indeterminate-test.v1",
			sensitivity: "internal",
			sourceIds: ["task_indeterminate"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const request: MemoryCaptureRequest = {
			trigger: "backfill",
			sourceType: "task_result",
			sourceId: "task_indeterminate",
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			locator: { taskId: "task_indeterminate" },
			recordedAt: "2026-08-01T00:00:00.000Z",
			query: "indeterminate provider outcome",
			content: (await artifacts.read(source.artifactId)).content,
			scope: { goalId: null, chainId: null, branchId: null, paths: [] },
		};
		const { captureId, captureDigest } = captureIdentity(request);
		const service = new MemoryService(harness.tempDir);
		const scheduled = await service.getStore().scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId,
				trigger: request.trigger,
				sourceIds: [request.sourceId, request.artifactId],
				sourceDigest: captureDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
				createdAt: request.recordedAt,
			},
			{
				eventId: "evt_memory_indeterminate_schedule",
				idempotencyKey: `memory:schedule:${captureId}`,
				expectedHead: { sequence: 0, hash: null },
			},
		);
		await service.getStore().markGenerationStarted(captureId, 1, {
			eventId: "evt_memory_indeterminate_generation",
			idempotencyKey: `memory:generation:${captureId}:1`,
			expectedHead: scheduled.head,
		});
		await service.close();
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate: async () => {
				throw new Error("provider must not be called");
			},
		};

		await expect(controller.capture(request, host)).resolves.toMatchObject({ captureId, status: "indeterminate" });
	});

	it("reuses a persisted provider result after a retryable publication failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_publication_recovery",
			"Stable source with a paid provider result awaiting publication.",
		);
		const artifacts = new ArtifactStore(harness.tempDir);
		const { captureId, captureDigest } = captureIdentity(request);
		const service = new MemoryService(harness.tempDir);
		const scheduled = await service.getStore().scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId,
				trigger: request.trigger,
				sourceIds: [request.sourceId, request.artifactId],
				sourceDigest: captureDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
				createdAt: request.recordedAt,
			},
			{
				eventId: "evt_memory_publication_recovery_schedule",
				idempotencyKey: `memory:schedule:${captureId}`,
				expectedHead: { sequence: 0, hash: null },
			},
		);
		const generating = await service.getStore().markGenerationStarted(captureId, 1, {
			eventId: "evt_memory_publication_recovery_generation",
			idempotencyKey: `memory:generation:${captureId}:1`,
			expectedHead: scheduled.head,
		});
		const result = await artifacts.put({
			contentType: "text/plain",
			text: durableMemoryEnvelope("Publication recovery"),
			producer: MEMORY_CAPTURE_PROMPT_VERSION,
			sensitivity: "internal",
			sourceIds: [captureId, request.artifactId],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		await mkdir(join(harness.tempDir, ".pi-xk", "memory", "pending"), { recursive: true });
		await writeFile(
			join(harness.tempDir, ".pi-xk", "memory", "pending", `${captureId}.json`),
			`${JSON.stringify({
				schema: "pi-xk.memory-capture-pending.v1",
				captureId,
				resultArtifactId: result.artifactId,
				updatedAt: "2026-08-01T00:00:01.000Z",
			})}\n`,
		);
		await service.getStore().markCaptureFailed(
			{
				captureId,
				stage: "publication",
				errorCode: "memory_capture_publication_failed",
				retryable: true,
				message: "simulated publication interruption",
			},
			{
				eventId: "evt_memory_publication_recovery_failed",
				idempotencyKey: `memory:failed:${captureId}:1:publication`,
				expectedHead: generating.head,
			},
		);
		await service.close();

		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const generate = vi.fn(async () => {
			throw new Error("provider must not be called after its result was persisted");
		});
		const capture = await controller.capture(request, {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		});

		expect(capture).toMatchObject({ captureId, status: "applied" });
		expect(generate).not.toHaveBeenCalled();
		expect((await controller.getService().getStore().replay()).captures.get(captureId)?.status).toBe("applied");
	}, 15_000);

	it("repairs one persisted capture-format failure without relaxing the envelope contract", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_capture_format_repair",
			"A stable source whose first provider response uses a Memory kind as a cue kind.",
		);
		const generate = vi.fn(async (input: Parameters<MemoryGenerationHost["generate"]>[0]) => {
			if (generate.mock.calls.length === 1) {
				return {
					text: JSON.stringify({
						schema: MEMORY_CAPTURE_RESPONSE_SCHEMA,
						reason: "The source supports a durable constraint.",
						cues: [
							{
								key: "capture-format",
								kind: "constraint",
								label: "Capture format",
								aliases: [],
								paths: [],
							},
						],
						reviews: [],
					}),
					model: { provider: "faux", modelId: "faux" },
				};
			}
			expect(input.instructions).toContain("cue kind is a navigation category");
			const repairInput = JSON.parse(input.source) as {
				schema: string;
				rejectedResult: { validationMessage: string };
			};
			expect(repairInput.schema).toBe("pi-xk.memory-capture-format-repair-input.v1");
			expect(repairInput.rejectedResult.validationMessage).toContain("cue kind is invalid");
			return {
				text: durableMemoryEnvelope("Capture format repair"),
				model: { provider: "faux", modelId: "faux" },
			};
		});

		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({ status: "applied" });
		expect(generate).toHaveBeenCalledTimes(2);
		const replay = await controller.getService().getStore().replay();
		const capture = replay.captures.get(captureIdentity(request).captureId);
		expect(capture).toMatchObject({ status: "applied", attempt: 2 });
		expect(replay.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "capture_failed",
					payload: expect.objectContaining({
						errorCode: "memory_capture_format_repair_requested",
						retryable: true,
					}),
				}),
			]),
		);
	}, 15_000);

	it("stops after one capture-format repair attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_capture_format_exhausted",
			"A stable source whose provider cannot produce the required capture envelope.",
		);
		const generate = vi.fn(async () => ({
			text: "not a JSON envelope",
			model: { provider: "faux", modelId: "faux" },
		}));

		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({ status: "failed" });
		expect(generate).toHaveBeenCalledTimes(2);
		expect(
			(await controller.getService().getStore().replay()).captures.get(captureIdentity(request).captureId),
		).toMatchObject({
			status: "failed",
			attempt: 2,
			errorCode: "memory_capture_format_repair_exhausted",
			retryable: false,
		});
	}, 15_000);

	it("does not repeat a format-repair provider call after restart when its outcome is indeterminate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_capture_format_repair_indeterminate",
			"A stable source whose format repair may already have reached the provider before restart.",
		);
		const { captureId, captureDigest } = captureIdentity(request);
		const service = new MemoryService(harness.tempDir);
		const scheduled = await service.getStore().scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId,
				trigger: request.trigger,
				sourceIds: [request.sourceId, request.artifactId],
				sourceDigest: captureDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
				createdAt: request.recordedAt,
			},
			{
				eventId: "evt_memory_format_repair_indeterminate_schedule",
				idempotencyKey: `memory:schedule:${captureId}`,
				expectedHead: { sequence: 0, hash: null },
			},
		);
		const firstGeneration = await service.getStore().markGenerationStarted(captureId, 1, {
			eventId: "evt_memory_format_repair_indeterminate_generation_1",
			idempotencyKey: `memory:generation:${captureId}:1`,
			expectedHead: scheduled.head,
		});
		const invalidResult = await new ArtifactStore(harness.tempDir).put({
			contentType: "text/plain",
			text: "not a JSON envelope",
			producer: MEMORY_CAPTURE_PROMPT_VERSION,
			sensitivity: "internal",
			sourceIds: [captureId, request.artifactId],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		await mkdir(join(harness.tempDir, ".pi-xk", "memory", "pending"), { recursive: true });
		await writeFile(
			join(harness.tempDir, ".pi-xk", "memory", "pending", `${captureId}.json`),
			`${JSON.stringify({
				schema: "pi-xk.memory-capture-pending.v3",
				captureId,
				resultArtifactId: invalidResult.artifactId,
				model: "faux/faux",
				updatedAt: "2026-08-01T00:00:01.000Z",
				formatRepair: { validationMessage: "Memory capture response must be one JSON object" },
			})}\n`,
		);
		const failed = await service.getStore().markCaptureFailed(
			{
				captureId,
				stage: "validation",
				errorCode: "memory_capture_format_repair_requested",
				retryable: true,
				message: "Memory capture response must be one JSON object",
			},
			{
				eventId: "evt_memory_format_repair_indeterminate_failed",
				idempotencyKey: `memory:failed:${captureId}:1:validation`,
				expectedHead: firstGeneration.head,
			},
		);
		await service.getStore().markGenerationStarted(captureId, 2, {
			eventId: "evt_memory_format_repair_indeterminate_generation_2",
			idempotencyKey: `memory:generation:${captureId}:2`,
			expectedHead: failed.head,
		});
		await service.close();

		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const generate = vi.fn(async () => {
			throw new Error("format repair provider must not be called after restart");
		});
		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({ captureId, status: "indeterminate" });
		expect(generate).not.toHaveBeenCalled();
	}, 15_000);

	it("rejects a format-repair marker that is not backed by the capture failure state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_capture_format_repair_tampered",
			"A stable source whose pending repair marker does not match its durable capture state.",
		);
		const { captureId, captureDigest } = captureIdentity(request);
		const service = new MemoryService(harness.tempDir);
		const scheduled = await service.getStore().scheduleCapture(
			{
				schema: "pi-xk.memory-capture-source.v1",
				captureId,
				trigger: request.trigger,
				sourceIds: [request.sourceId, request.artifactId],
				sourceDigest: captureDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
				createdAt: request.recordedAt,
			},
			{
				eventId: "evt_memory_format_repair_tampered_schedule",
				idempotencyKey: `memory:schedule:${captureId}`,
				expectedHead: { sequence: 0, hash: null },
			},
		);
		const generating = await service.getStore().markGenerationStarted(captureId, 1, {
			eventId: "evt_memory_format_repair_tampered_generation",
			idempotencyKey: `memory:generation:${captureId}:1`,
			expectedHead: scheduled.head,
		});
		const result = await new ArtifactStore(harness.tempDir).put({
			contentType: "text/plain",
			text: durableMemoryEnvelope("Tampered repair marker"),
			producer: MEMORY_CAPTURE_PROMPT_VERSION,
			sensitivity: "internal",
			sourceIds: [captureId, request.artifactId],
			createdAt: "2026-08-01T00:00:01.000Z",
		});
		await mkdir(join(harness.tempDir, ".pi-xk", "memory", "pending"), { recursive: true });
		await writeFile(
			join(harness.tempDir, ".pi-xk", "memory", "pending", `${captureId}.json`),
			`${JSON.stringify({
				schema: "pi-xk.memory-capture-pending.v3",
				captureId,
				resultArtifactId: result.artifactId,
				model: "faux/faux",
				updatedAt: "2026-08-01T00:00:01.000Z",
				formatRepair: { validationMessage: "forged format repair marker" },
			})}\n`,
		);
		await service.getStore().markCaptureFailed(
			{
				captureId,
				stage: "publication",
				errorCode: "memory_capture_publication_failed",
				retryable: true,
				message: "simulated publication interruption",
			},
			{
				eventId: "evt_memory_format_repair_tampered_failed",
				idempotencyKey: `memory:failed:${captureId}:1:publication`,
				expectedHead: generating.head,
			},
		);
		await service.close();

		const controller = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(controller);
		const generate = vi.fn();
		await expect(
			controller.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).rejects.toThrow("format repair marker does not match capture state");
		expect(generate).not.toHaveBeenCalled();
	}, 15_000);

	it("resumes a recorded capture review after publication interruption", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_recorded_proposal_recovery",
			"A recorded inferred-memory proposal must publish after restart without another provider call.",
		);
		const first = new MemoryController({ projectRoot: harness.tempDir });
		const applyMemoryReviews = vi
			.spyOn(first.getService(), "applyMemoryReviews")
			.mockRejectedValueOnce(new Error("simulated interruption after reconstruction_recorded"));
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Recorded proposal recovery"),
			model: { provider: "faux", modelId: "faux" },
		}));

		const interrupted = await first.capture(request, {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		});
		expect(interrupted).toMatchObject({ status: "failed", confirmationRequired: false });
		expect((await first.getService().getStore().replay()).captures.get(interrupted.captureId)).toMatchObject({
			status: "failed",
			retryable: true,
		});
		applyMemoryReviews.mockRestore();
		await first.close();

		const restarted = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(restarted);
		await expect(
			restarted.capture(request, {
				model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
				generate,
			}),
		).resolves.toMatchObject({
			captureId: interrupted.captureId,
			status: "applied",
			confirmationRequired: false,
		});
		expect(generate).toHaveBeenCalledTimes(1);
		expect((await restarted.getService().getStore().replay()).captures.get(interrupted.captureId)?.status).toBe(
			"applied",
		);
		await expect(
			stat(join(harness.tempDir, ".pi-xk", "memory", "pending", `${interrupted.captureId}.json`)),
		).rejects.toMatchObject({ code: "ENOENT" });
	}, 15_000);

	it("regenerates semantic CAS conflicts across restarts and enters cooldown after three attempts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_revision_conflict_cooldown",
			"A stable source whose semantic Memory context changes during publication.",
		);
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Revision conflict cooldown"),
			model: { provider: "faux", modelId: "faux" },
		}));
		const host: MemoryGenerationHost = {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		};
		const runConflictAttempt = async (): Promise<Awaited<ReturnType<MemoryController["capture"]>>> => {
			const controller = new MemoryController({ projectRoot: harness.tempDir });
			vi.spyOn(controller.getService(), "applyMemoryReviews").mockRejectedValueOnce(
				new MemoryRevisionConflictError("memory_concurrent", 1, 2),
			);
			try {
				return await controller.capture(request, host);
			} finally {
				await controller.close();
			}
		};

		await expect(runConflictAttempt()).resolves.toMatchObject({ status: "failed" });
		await expect(runConflictAttempt()).resolves.toMatchObject({ status: "failed" });
		await expect(runConflictAttempt()).resolves.toMatchObject({ status: "failed" });

		const restarted = new MemoryController({ projectRoot: harness.tempDir });
		try {
			await expect(restarted.capture(request, host)).resolves.toMatchObject({ status: "failed" });
			const replay = await restarted.getService().getStore().replay();
			const { captureId } = captureIdentity(request);
			expect(replay.captures.get(captureId)).toMatchObject({
				status: "failed",
				attempt: 3,
				errorCode: "memory_capture_revision_conflict_cooldown",
				retryable: false,
			});
			expect([...replay.reconstructions.keys()].sort()).toEqual([
				captureId,
				`${captureId}:attempt:2`,
				`${captureId}:attempt:3`,
			]);
			expect(replay.failedReviewRunIds).toEqual(new Set(replay.reconstructions.keys()));
		} finally {
			await restarted.close();
		}
		expect(generate).toHaveBeenCalledTimes(3);
	}, 20_000);

	it("keeps an applied capture when projection publication fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		class ProjectionFailingMemoryService extends MemoryService {
			override async synchronizeProjections(): Promise<never> {
				throw new Error("simulated projection failure");
			}
		}
		const service = new ProjectionFailingMemoryService(harness.tempDir);
		const controller = new MemoryController({ projectRoot: harness.tempDir, service });
		controllers.push(controller);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_projection_failure",
			"Stable source whose derived projections fail after fact publication.",
		);

		const result = await controller.capture(request, {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate: async () => ({
				text: durableMemoryEnvelope("Projection failure"),
				model: { provider: "faux", modelId: "faux" },
			}),
		});
		const replay = await service.getStore().replay();

		expect(result.status).toBe("applied");
		expect(replay.captures.get(result.captureId)).toMatchObject({
			status: "applied",
			errorCode: "memory_projection_failed",
			retryable: true,
		});
		expect(replay.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "capture_failed",
					payload: expect.objectContaining({ stage: "projection" }),
				}),
			]),
		);
	}, 15_000);

	it("keeps the manifest body-free and exposes D1-D3 read-only retrieval", async () => {
		const memoryErrors: Error[] = [];
		let extensionController: MemoryController | undefined;
		let fullReplays = 0;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkMemoryExtension({
					onMemoryError: (error) => memoryErrors.push(error),
					createController: (projectRoot) => {
						extensionController = new MemoryController({
							projectRoot,
							service: new MemoryService(
								projectRoot,
								new MemoryStore(projectRoot, {
									onFullReplay: () => {
										fullReplays += 1;
									},
								}),
							),
						});
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		await harness.session.prompt("/memory remember Never inject SECRET_MEMORY_BODY into a system prompt.");
		expect(memoryErrors).toEqual([]);
		expect((await extensionController?.getService().getStore().replay())?.head.sequence).toBeGreaterThan(0);
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const stored = await service.search({ query: "SECRET_MEMORY_BODY" });
		expect(stored.items).toHaveLength(1);
		const memoryId = stored.items[0]?.memoryId;
		if (!memoryId) throw new Error("explicit Memory fixture was not published");
		fullReplays = 0;

		const systemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				systemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "SECRET_MEMORY_BODY" }));
			},
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_expand_memory_evidence", {
					memoryId,
					evidenceIds: stored.items[0]?.memoryId ? undefined : [],
				}),
			),
			fauxAssistantMessage("Memory evidence inspected."),
		]);
		await harness.session.prompt("What did we decide before?");

		expect(systemPrompts[0]).toContain("Pi-XK Memory manifest");
		expect(systemPrompts[0]).toContain("pi_xk_search_memory=enabled");
		expect(systemPrompts[0]).not.toContain("SECRET_MEMORY_BODY");
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(toolResults[0])).not.toContain('"statement"');
		expect(getMessageText(toolResults[1])).toContain("SECRET_MEMORY_BODY");
		expect(getMessageText(toolResults[1])).toContain("historical evidence");
		expect(getMessageText(toolResults[2])).toContain("historicalEvidence");
		const loaded = await service.getStore().loadReadModelSnapshot();
		expect(loaded.readModel.accesses).toEqual([expect.objectContaining({ memoryId, accessCount: 1 })]);
		const status = await service.status();
		expect(status.index?.head).toEqual(status.head);
		expect(fullReplays).toBe(0);
	});

	it("publishes a staged Memory revision only after a successful settled run", async () => {
		const memoryErrors: Error[] = [];
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkRuntimeExtension({
					memory: { onMemoryError: (error) => memoryErrors.push(error) },
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Establish a persisted Session Chain root." }],
			timestamp: Date.now() - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("Persisted root established."));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Ambient reviews publish at settled boundaries.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Ambient reviews" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("Ambient review fixture was not published");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "Ambient reviews" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_memory", {
					action: "revise",
					sourceMemories: [{ memoryId, expectedRevision: 1 }],
					replacement: {
						kind: "decision",
						title: "Ambient reviews publish after settlement",
						statement: "Semantic Memory revisions publish only after the logical Agent run settles successfully.",
						applicability: "Pi-XK Ambient Memory review publication.",
						effectiveFrom: "2026-08-03T08:00:00.000Z",
						cueIds: [],
					},
					reason: "The current implementation run verified the settled publication boundary.",
				}),
			),
			fauxAssistantMessage("The evidence-backed Memory revision is staged."),
		]);
		await harness.session.prompt("Review the prior Memory against the current implementation.");
		expect(memoryErrors).toEqual([]);
		const replay = await service.getStore().replay();
		expect(replay.events.some((event) => event.eventType === "memory_review_applied")).toBe(true);
		const reviewToolResults = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map(getMessageText);
		expect(reviewToolResults).toEqual(expect.arrayContaining([expect.stringContaining('"status":"staged"')]));
		expect(replay.events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["reconstruction_recorded", "memory_review_applied", "access_recorded"]),
		);
		const timeline = (await service.timeline(memoryId)).revisions;
		expect(timeline.map((entry) => entry.revision.revision)).toEqual([1, 2]);
		expect(timeline[1]?.revision).toMatchObject({
			schema: "pi-xk.memory-revision.v2",
			trust: "model_inferred",
			transition: { mode: "revise", trustDerivation: "model-reconstruction" },
		});
		expect(timeline[1]?.revision.evidenceRefs).toEqual([
			expect.objectContaining({ sourceType: "agent_run", artifactId: null }),
		]);
	}, 20_000);

	it("rejects an invented review cue before settlement without recording a review failure", async () => {
		const memoryErrors: Error[] = [];
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkMemoryExtension({
					onMemoryError: (error) => memoryErrors.push(error),
					createController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember D2 cue provenance is required for semantic reviews.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "D2 cue provenance" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("review cue fixture was not published");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_memory", {
					action: "create",
					sourceMemories: [],
					replacement: {
						kind: "fact",
						title: "Invented cue must be rejected",
						statement: "A model cannot invent a cue identifier during a semantic Memory review.",
						applicability: "Ambient Memory review tool validation.",
						effectiveFrom: "2026-08-05T00:00:00.000Z",
						cueIds: ["cue_invented_by_model"],
					},
					reason: "Exercise immediate cue provenance validation.",
				}),
			),
			fauxAssistantMessage("The invalid semantic review was rejected before settlement."),
		]);
		await harness.session.prompt("Attempt an invalid Memory review cue.");

		const reviewResult = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => ({ message, text: getMessageText(message) }))
			.find(({ text }) => text.includes("cue was not returned by a D2 read"));
		expect(reviewResult?.message.isError).toBe(true);
		expect(memoryErrors).toEqual([]);
		const replay = await service.getStore().replay();
		expect(replay.events.some((event) => event.eventType === "memory_review_failed")).toBe(false);
		expect((await service.timeline(memoryId)).revisions).toHaveLength(1);
	}, 20_000);

	it("publishes v3 Agent-run evidence with the durable Goal identity", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkMemoryExtension({
					createController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		const goalId = "goal_memory_provenance";
		await seedActiveGoal(harness, goalId);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Agent-run evidence preserves its Goal identity.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Goal identity" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("Goal provenance fixture was not published");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_memory", {
					action: "revise",
					sourceMemories: [{ memoryId, expectedRevision: 1 }],
					replacement: {
						kind: "fact",
						title: "Agent-run evidence preserves Goal identity",
						statement: "Successful Ambient Memory revisions retain the active Goal identity.",
						applicability: "Pi-XK Agent runs with an active Goal binding.",
						effectiveFrom: "2026-08-04T08:00:00.000Z",
						cueIds: [],
					},
					reason: "The current run verifies the Goal provenance contract.",
				}),
			),
			fauxAssistantMessage("Goal provenance verified."),
		]);
		await harness.session.prompt("Review the provenance Memory under this Goal.");

		const timeline = (await service.timeline(memoryId)).revisions;
		expect(timeline[1]?.revision.evidenceRefs).toEqual([
			expect.objectContaining({
				schema: "pi-xk.memory-evidence-ref.v3",
				sourceType: "agent_run",
				locator: expect.objectContaining({ goalId }),
			}),
		]);
	}, 20_000);

	it("omits an uncommitted Session Chain locator from Agent-run evidence", async () => {
		const memoryErrors: Error[] = [];
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkMemoryExtension({
					onMemoryError: (error) => memoryErrors.push(error),
					createController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, {
			schema: "pi-xk.session-chain-link.v1",
			kind: "segment_link",
			chainId: "chain_pending_adoption",
			branchId: "branch_pending_adoption",
			segmentId: harness.sessionManager.getSessionId(),
			ordinal: 1,
			predecessorSegmentId: null,
			summaryInArtifactId: null,
			createdAt: "2026-08-03T08:00:00.000Z",
		});
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Pending Chain adoption must not invalidate Agent-run evidence.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Pending Chain adoption" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("pending Chain adoption fixture was not published");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_memory", {
					action: "revise",
					sourceMemories: [{ memoryId, expectedRevision: 1 }],
					replacement: {
						kind: "decision",
						title: "Pending Chain adoption preserves evidence",
						statement: "Agent-run evidence remains valid while Session Chain adoption is not yet durable.",
						applicability: "Pi-XK Memory settlement during Session Chain adoption.",
						effectiveFrom: "2026-08-03T08:00:00.000Z",
						cueIds: [],
					},
					reason: "The current run verifies the adoption boundary.",
				}),
			),
			fauxAssistantMessage("The evidence-backed Memory revision is staged."),
		]);
		await harness.session.prompt("Review the Memory while Chain adoption is still pending.");

		expect(memoryErrors).toEqual([]);
		const timeline = (await service.timeline(memoryId)).revisions;
		expect(timeline.map((entry) => entry.revision.revision)).toEqual([1, 2]);
		expect(timeline[1]?.revision.evidenceRefs).toEqual([
			expect.objectContaining({
				sourceType: "agent_run",
				locator: expect.objectContaining({ chainId: null, branchId: null, segmentId: null }),
			}),
		]);
	}, 20_000);

	it("records implicit keep for a D2 read without a semantic change", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Keep this Memory unchanged when it remains accurate.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "remains accurate" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("implicit keep fixture was not published");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "remains accurate" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage("The existing Memory remains accurate."),
		]);
		await harness.session.prompt("Check whether the prior Memory still applies.");

		const replay = await service.getStore().replay();
		const review = replay.events.find(
			(event) => event.schema === "pi-xk.memory-event.v2" && event.eventType === "memory_review_applied",
		);
		expect(review?.payload).toMatchObject({ decisionArtifactIds: [], implicitKeepMemoryIds: [memoryId] });
		expect((await service.timeline(memoryId)).revisions).toHaveLength(1);
	}, 20_000);

	it("enforces the per-run search budget without expanding the candidate pool", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "first" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "second" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "third" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_search_memory", { query: "fourth" })),
			fauxAssistantMessage("The recall budget stopped further search."),
		]);
		await harness.session.prompt("Search several possible historical phrasings.");

		const budgetResult = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map(getMessageText)
			.find((text) => text.includes("budget_exhausted"));
		expect(budgetResult).toBeDefined();
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const replay = await service.getStore().replay();
		const reconstruction = replay.reconstructions.values().next().value;
		if (!reconstruction) throw new Error("budget reconstruction was not recorded");
		const trace = JSON.parse((await new ArtifactStore(harness.tempDir).read(reconstruction.traceArtifactId)).content);
		expect(trace).toMatchObject({
			stopReason: "budget_exhausted",
			budgetUsage: { memorySearchCalls: 3, memoryActions: 3, totalKnowledgeActions: 3 },
		});
		expect(trace.queryDigests).toHaveLength(3);
	}, 20_000);

	it("keeps an aborted run diagnostic-only even after D2 retrieval", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Aborted runs cannot revise this Memory.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Aborted runs" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("aborted run fixture was not published");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage("aborted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Read the prior Memory before this run aborts.");

		const replay = await service.getStore().replay();
		expect(replay.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "reconstruction_recorded",
					payload: expect.objectContaining({ outcome: "aborted" }),
				}),
			]),
		);
		expect(replay.events.some((event) => event.eventType === "memory_review_applied")).toBe(false);
		expect((await service.timeline(memoryId)).revisions).toHaveLength(1);
	}, 20_000);

	it("keeps a length-truncated run diagnostic-only even after D2 retrieval", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Truncated runs cannot revise this Memory.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Truncated runs" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("truncated run fixture was not published");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] })),
			fauxAssistantMessage("truncated", { stopReason: "length" }),
		]);
		await harness.session.prompt("Read the prior Memory before this run reaches its output limit.");

		const replay = await service.getStore().replay();
		expect(replay.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "reconstruction_recorded",
					payload: expect.objectContaining({ outcome: "incomplete" }),
				}),
			]),
		);
		expect(replay.events.some((event) => event.eventType === "memory_review_applied")).toBe(false);
		expect((await service.timeline(memoryId)).revisions).toHaveLength(1);
	}, 20_000);

	it("publishes one Memory review when a queued follow-up is drained in the same logical run", async () => {
		const memoryErrors: Error[] = [];
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkRuntimeExtension({
					memory: { onMemoryError: (error) => memoryErrors.push(error) },
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Establish a persisted Session Chain root." }],
			timestamp: Date.now() - 1_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("Persisted root established."));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.bindExtensions({});
		await harness.session.prompt("/memory remember Queued follow-ups publish exactly one semantic revision.");
		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const memoryId = (await service.search({ query: "Queued follow-ups" })).items[0]?.memoryId;
		if (!memoryId) throw new Error("queued follow-up fixture was not published");
		let queued = false;
		harness.setResponses([
			() => {
				if (!queued) {
					queued = true;
					harness.session.agent.followUp({
						role: "user",
						content: [{ type: "text", text: "queued verification" }],
						timestamp: Date.now(),
					});
				}
				return fauxAssistantMessage(fauxToolCall("pi_xk_read_memory", { memoryIds: [memoryId] }));
			},
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_memory", {
					action: "revise",
					sourceMemories: [{ memoryId, expectedRevision: 1 }],
					replacement: {
						kind: "fact",
						title: "Queued follow-ups publish once",
						statement: "A queued follow-up is drained before one Memory review publication.",
						applicability: "Ambient Memory logical runs with queued user input.",
						effectiveFrom: "2026-08-04T08:00:00.000Z",
						cueIds: [],
					},
					reason: "The current logical run includes the queued verification.",
				}),
			),
			fauxAssistantMessage("Review staged before the queued follow-up."),
			fauxAssistantMessage("Queued follow-up handled."),
		]);
		await harness.session.prompt("Review the queued follow-up publication behavior.");

		const replay = await service.getStore().replay();
		expect(memoryErrors).toEqual([]);
		expect(
			replay.events.filter(
				(event) => event.schema === "pi-xk.memory-event.v2" && event.eventType === "memory_review_applied",
			),
		).toHaveLength(1);
		expect((await service.timeline(memoryId)).revisions).toHaveLength(2);
	}, 20_000);

	it("does not write reconstruction or access facts for an ordinary run without knowledge actions", async () => {
		let extensionController: MemoryController | undefined;
		const harness = await createHarness({
			extensionFactories: [
				createPiXkRuntimeExtension({
					createMemoryController: (projectRoot) => {
						extensionController = new MemoryController({ projectRoot });
						controllers.push(extensionController);
						return extensionController;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("A one-off answer without project-history lookup.")]);
		await harness.session.prompt("Answer this one-off question without using project history.");

		const service = extensionController?.getService();
		if (!service) throw new Error("Memory extension controller was not created");
		const replay = await service.getStore().replay();
		expect(replay.events.some((event) => event.eventType === "reconstruction_recorded")).toBe(false);
		expect(replay.events.some((event) => event.eventType === "access_recorded")).toBe(false);
	}, 20_000);
});
