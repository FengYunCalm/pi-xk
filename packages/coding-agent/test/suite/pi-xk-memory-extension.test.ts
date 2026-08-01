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
	MemoryService,
	MemoryStore,
	stableJsonStringify,
} from "../../../pi-xk-core/src/index.ts";
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
		memories: [
			{
				memoryId: null,
				expectedRevision: null,
				kind: "fact",
				title,
				statement: `${title} remains available after capture recovery.`,
				applicability: "Pi-XK Memory publication recovery.",
				trust: "model_inferred",
				effectiveFrom: "2026-08-01T00:00:00.000Z",
				cueKeys: [],
			},
		],
		edges: [],
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
	const artifacts = new ArtifactStore(projectRoot);
	const source = await artifacts.put({
		contentType: "text/plain",
		text: content,
		producer: "pi-xk.memory-controller-test.v1",
		sensitivity: "internal",
		sourceIds: [sourceId],
		createdAt: "2026-08-01T00:00:00.000Z",
	});
	return {
		trigger: "backfill",
		sourceType: "task_result",
		sourceId,
		artifactId: source.artifactId,
		sourceDigest: source.artifactId,
		locator: { taskId: sourceId },
		recordedAt: "2026-08-01T00:00:00.000Z",
		query: content,
		content: (await artifacts.read(source.artifactId)).content,
		scope: { goalId: null, chainId: null, branchId: null, paths: [] },
	};
}

afterEach(async () => {
	for (const controller of controllers.splice(0)) await controller.close();
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
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
			memories: [
				{
					memoryId: null,
					expectedRevision: null,
					kind: "constraint",
					title: "Session summaries remain evidence",
					statement: "Session summary content must never become a system instruction.",
					applicability: "Session Chain summary and Memory retrieval paths.",
					trust: "model_inferred",
					effectiveFrom: "2026-08-01T00:00:00.000Z",
					cueKeys: ["session-chain"],
				},
			],
			edges: [],
		};
		expect(parseMemoryCaptureEnvelope(JSON.stringify(valid))).toEqual(valid);
		expect(() =>
			parseMemoryCaptureEnvelope(
				JSON.stringify({
					...valid,
					memories: [{ ...valid.memories[0], trust: "verified" }],
				}),
			),
		).toThrow(/trust/);
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
					memories: [
						{
							memoryId: null,
							expectedRevision: null,
							kind: "constraint",
							title: "Memory implementation constraint",
							statement: "Keep the code-scoped Memory implementation compatible with its recorded path.",
							applicability: "src/memory.ts",
							trust: "model_inferred",
							effectiveFrom: "2026-08-01T00:00:00.000Z",
							cueKeys: ["memory-implementation"],
						},
					],
					edges: [],
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
		const artifacts = new ArtifactStore(harness.tempDir);
		const source = await artifacts.put({
			contentType: "text/plain",
			text: "Stable source with a paid provider result awaiting publication.",
			producer: "pi-xk.memory-publication-recovery-test.v1",
			sensitivity: "internal",
			sourceIds: ["task_publication_recovery"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const request: MemoryCaptureRequest = {
			trigger: "backfill",
			sourceType: "task_result",
			sourceId: "task_publication_recovery",
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			locator: { taskId: "task_publication_recovery" },
			recordedAt: "2026-08-01T00:00:00.000Z",
			query: "paid provider result publication recovery",
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

	it("resumes an auto-applicable proposal recorded before publication interruption", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const request = await createTaskCaptureRequest(
			harness.tempDir,
			"task_recorded_proposal_recovery",
			"A recorded inferred-memory proposal must publish after restart without another provider call.",
		);
		const first = new MemoryController({ projectRoot: harness.tempDir });
		const applyProposal = vi
			.spyOn(first.getService().getStore(), "applyProposal")
			.mockRejectedValueOnce(new Error("simulated interruption after proposal_recorded"));
		const generate = vi.fn(async () => ({
			text: durableMemoryEnvelope("Recorded proposal recovery"),
			model: { provider: "faux", modelId: "faux" },
		}));

		const interrupted = await first.capture(request, {
			model: { provider: "faux", modelId: "faux", contextWindow: 100_000 },
			generate,
		});
		expect(interrupted).toMatchObject({ status: "failed", confirmationRequired: false });
		expect((await first.getService().getStore().replay()).captures.get(interrupted.captureId)?.status).toBe(
			"proposed",
		);
		applyProposal.mockRestore();
		await first.close();

		const restarted = new MemoryController({ projectRoot: harness.tempDir });
		controllers.push(restarted);
		await expect(restarted.resumePublications()).resolves.toEqual([
			expect.objectContaining({
				captureId: interrupted.captureId,
				status: "applied",
				confirmationRequired: false,
			}),
		]);
		expect(generate).toHaveBeenCalledTimes(1);
		expect((await restarted.getService().getStore().replay()).captures.get(interrupted.captureId)?.status).toBe(
			"applied",
		);
		await expect(
			stat(join(harness.tempDir, ".pi-xk", "memory", "pending", `${interrupted.captureId}.json`)),
		).rejects.toMatchObject({ code: "ENOENT" });
	}, 15_000);

	it("keeps an applied capture when projection publication fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const artifacts = new ArtifactStore(harness.tempDir);
		const source = await artifacts.put({
			contentType: "text/plain",
			text: "Stable source whose derived projections fail after fact publication.",
			producer: "pi-xk.memory-projection-failure-test.v1",
			sensitivity: "internal",
			sourceIds: ["task_projection_failure"],
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		class ProjectionFailingMemoryService extends MemoryService {
			override async repairProjections(): Promise<never> {
				throw new Error("simulated projection failure");
			}
		}
		const service = new ProjectionFailingMemoryService(harness.tempDir);
		const controller = new MemoryController({ projectRoot: harness.tempDir, service });
		controllers.push(controller);
		const request: MemoryCaptureRequest = {
			trigger: "backfill",
			sourceType: "task_result",
			sourceId: "task_projection_failure",
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			locator: { taskId: "task_projection_failure" },
			recordedAt: "2026-08-01T00:00:00.000Z",
			query: "projection failure after fact publication",
			content: (await artifacts.read(source.artifactId)).content,
			scope: { goalId: null, chainId: null, branchId: null, paths: [] },
		};

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
});
