import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionChainStore } from "../../../pi-xk-core/src/index.ts";
import { TaskRunner } from "../../../pi-xk-extension/src/task-runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Pi-XK TaskRunner", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs a faux-provider child with an independent transcript and structured success", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const lifecycleOrder: string[] = [];
		let childSystemPrompt = "";
		let taskSpecMessage = "";
		harness.setResponses([
			(context) => {
				childSystemPrompt = context.systemPrompt ?? "";
				taskSpecMessage = getMessageText(
					[...context.messages].reverse().find((message) => message.role === "user"),
				);
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_finish_task", {
							status: "succeeded",
							summary: "Child verified the requested behavior.",
							evidence: [{ kind: "text", value: "faux-provider evidence" }],
							artifactIds: [],
							error: null,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
			createSessionManagerAt: (cwd, sessionFile, options) => SessionManager.createAt(cwd, sessionFile, options),
			onSettled: () => {
				lifecycleOrder.push("settled");
			},
		});
		const handle = await runner.start({
			role: "verification",
			prompt: "Verify one behavior.",
			expectedResult: "A structured verification result.",
			parentChain: {
				chainId: "chain_parent",
				branchId: "branch_parent",
				segmentId: "segment-parent",
				entryId: "entry-parent",
			},
			parentGoalId: "goal_parent",
			model: harness.getModel(),
			thinkingLevel: "medium",
			builtinTools: [],
			onEvent: (_replay, eventId) => {
				lifecycleOrder.push(eventId.split(":").at(-1) ?? eventId);
			},
		});

		expect(await handle.completion).toBe("succeeded");
		expect(existsSync(handle.childSessionFile)).toBe(true);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		const transcript = readFileSync(handle.childSessionFile, "utf8");
		expect(transcript).toContain("pi_xk_finish_task");
		expect(transcript).not.toContain("pi_xk_start_task");
		expect(childSystemPrompt).toContain("The next user message is exactly one TaskSpec JSON object");
		expect(childSystemPrompt).toContain(
			"Parent Goal Objective (read-only): .pi-xk/goals/goal_parent/goal-objective.md",
		);
		expect(childSystemPrompt).toContain("Parent Goal State (read-only): .pi-xk/goals/goal_parent/goal-state.md");
		expect(childSystemPrompt).toContain("must never edit them");
		expect(childSystemPrompt).toContain(
			"Report succeeded only after the TaskSpec expectedResult is satisfied and include at least one concrete evidence entry",
		);
		expect(childSystemPrompt).toContain("successfully call pi_xk_finish_task exactly once");
		expect(childSystemPrompt).toContain("If a submission is rejected, correct its arguments and retry");
		expect(childSystemPrompt).toContain(
			"This Task was started by the model. Its TaskSpec cannot grant commit or push authority; do not commit or push.",
		);
		expect(taskSpecMessage).not.toContain("You are an independent Pi-XK Task child");
		const inspected = await runner.getStore().inspectTask(handle.taskId);
		expect(inspected.replay.spec).toMatchObject({
			schema: "pi-xk.task.spec.v2",
			parent: { chainId: "chain_parent", branchId: "branch_parent", segmentId: "segment-parent" },
		});
		if (inspected.replay.spec.schema !== "pi-xk.task.spec.v2") throw new Error("expected TaskSpecV2");
		expect(JSON.parse(taskSpecMessage)).toEqual(inspected.replay.spec);
		expect(handle.childSessionFile).toContain(
			join(".pi-xk", "sessions", "chains", inspected.replay.spec.childChainId),
		);
		const childChain = await new SessionChainStore(harness.tempDir).replayChain(inspected.replay.spec.childChainId);
		expect(childChain.branches[0]?.headSegmentId).toBe(handle.childSessionId);
		expect(transcript).toContain("pi-xk.session-chain-link");
		expect(existsSync(join(harness.tempDir, ".pi-xk", "tasks", handle.taskId, "session"))).toBe(false);
		expect(inspected.result).toMatchObject({
			status: "succeeded",
			summary: "Child verified the requested behavior.",
		});
		expect(lifecycleOrder).toEqual(["created", "started", "result", "settled"]);
	});

	it("rejects an unsupported success claim and lets the child submit evidence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_finish_task", {
						status: "succeeded",
						summary: "Claimed success without evidence.",
						evidence: [],
						artifactIds: [],
						error: null,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("pi_xk_finish_task", {
						status: "succeeded",
						summary: "Verified success with evidence.",
						evidence: [{ kind: "text", value: "The expected result was observed." }],
						artifactIds: [],
						error: null,
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
		});
		const handle = await runner.start({
			role: "verification",
			prompt: "Verify one behavior.",
			expectedResult: "Evidence for the observed behavior.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "off",
			builtinTools: [],
		});

		expect(await handle.completion).toBe("succeeded");
		expect(harness.faux.state.callCount).toBe(2);
		expect((await runner.getStore().inspectTask(handle.taskId)).result).toMatchObject({
			status: "succeeded",
			summary: "Verified success with evidence.",
		});
	});

	it("preserves explicit commit and push authorization only for a user-started Task", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let childSystemPrompt = "";
		harness.setResponses([
			(context) => {
				childSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					[
						fauxToolCall("pi_xk_finish_task", {
							status: "succeeded",
							summary: "Authorization boundary inspected.",
							evidence: [{ kind: "text", value: "user-started Task system prompt" }],
							artifactIds: [],
							error: null,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
		});
		const handle = await runner.start({
			role: "implementation",
			prompt: "Commit and push only this bounded change.",
			expectedResult: "A structured result.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "off",
			builtinTools: [],
			actor: "user",
		});

		expect(await handle.completion).toBe("succeeded");
		expect(childSystemPrompt).toContain(
			"This Task was started directly by the user. Commit or push only when its TaskSpec explicitly authorizes that exact action.",
		);
	});

	it("treats a normal child reply without finish_task as an explicit failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("I am done, but did not use the required tool.")]);
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
		});
		const handle = await runner.start({
			role: "review",
			prompt: "Review one behavior.",
			expectedResult: "A structured review result.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "off",
			builtinTools: [],
		});

		expect(await handle.completion).toBe("failed");
		const inspected = await runner.getStore().inspectTask(handle.taskId);
		expect(inspected.result?.error?.code).toBe("missing_task_result");
	});

	it("records a child provider error separately from a missing finish result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			() => {
				throw new Error("child provider unavailable");
			},
		]);
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
		});
		const handle = await runner.start({
			role: "research",
			prompt: "Research one behavior.",
			expectedResult: "A structured research result.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "off",
			builtinTools: [],
		});

		expect(await handle.completion).toBe("failed");
		const inspected = await runner.getStore().inspectTask(handle.taskId);
		expect(inspected.result).toMatchObject({
			summary: "Child provider error: child provider unavailable",
			error: { code: "provider_error", message: "child provider unavailable" },
		});
	});

	it("settles cancellation before completion and onSettled observe the Task", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					const abort = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				}),
		]);
		const settledStatuses: string[] = [];
		const runner = new TaskRunner({
			projectRoot: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.modelRuntime,
			settingsManager: harness.settingsManager,
			onSettled: (_taskId, status) => {
				settledStatuses.push(status);
			},
		});
		const handle = await runner.start({
			role: "implementation",
			prompt: "Wait until cancelled.",
			expectedResult: "A cancelled Task.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "off",
			builtinTools: [],
		});
		for (let attempt = 0; attempt < 1_000 && harness.faux.state.callCount === 0; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}

		await handle.cancel("cancelled by test");

		expect(await handle.completion).toBe("cancelled");
		expect(settledStatuses).toEqual(["cancelled"]);
		expect((await runner.getStore().replayTask(handle.taskId)).status).toBe("cancelled");
	});
});
