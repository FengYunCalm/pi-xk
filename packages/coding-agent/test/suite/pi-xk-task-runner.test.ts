import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRunner } from "../../../pi-xk-extension/src/task-runner.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("Pi-XK TaskRunner", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs a faux-provider child with an independent transcript and structured success", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
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
			expectedResult: "A structured verification result.",
			parentSessionId: "session-parent",
			parentEntryId: "entry-parent",
			parentGoalId: null,
			model: harness.getModel(),
			thinkingLevel: "medium",
			builtinTools: [],
		});

		expect(await handle.completion).toBe("succeeded");
		expect(existsSync(handle.childSessionFile)).toBe(true);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		const transcript = readFileSync(handle.childSessionFile, "utf8");
		expect(transcript).toContain("pi_xk_finish_task");
		expect(transcript).not.toContain("pi_xk_start_task");
		const inspected = await runner.getStore().inspectTask(handle.taskId);
		expect(inspected.result).toMatchObject({
			status: "succeeded",
			summary: "Child verified the requested behavior.",
		});
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
});
