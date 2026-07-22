import { describe, expect, it } from "vitest";
import {
	type TaskResultEnvelopeV1,
	type TaskSpecV1,
	TaskValidationError,
	validateTaskResultEnvelopeV1,
	validateTaskSpecV1,
} from "../src/index.ts";

function createSpec(): TaskSpecV1 {
	return {
		schema: "pi-xk.task.spec.v1",
		taskId: "task_contract",
		parentSessionId: "session-parent",
		parentEntryId: "entry-parent",
		parentGoalId: "goal_parent",
		role: "verification",
		prompt: "Verify the Task contract.",
		expectedResult: "A verified result envelope.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function createResult(): TaskResultEnvelopeV1 {
	return {
		schema: "pi-xk.task-result.v1",
		taskId: "task_contract",
		status: "succeeded",
		attempt: 1,
		summary: "The contract passed.",
		evidence: [{ kind: "command", value: "npm run check" }],
		artifactIds: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
		childSessionId: "child-session",
		childSessionFile: "/project/.pi-xk/tasks/task_contract/session/child.jsonl",
		startedAt: "2026-07-22T00:00:01.000Z",
		endedAt: "2026-07-22T00:00:02.000Z",
		error: null,
	};
}

describe("Task contracts", () => {
	it("strictly validates TaskSpecV1", () => {
		expect(validateTaskSpecV1(createSpec())).toEqual(createSpec());
		expect(() => validateTaskSpecV1({ ...createSpec(), extra: true })).toThrow(TaskValidationError);
		expect(() => validateTaskSpecV1({ ...createSpec(), taskId: "../task" })).toThrow("task_<safe-id>");
		expect(() => validateTaskSpecV1({ ...createSpec(), role: "planner" })).toThrow("role");
		expect(() => validateTaskSpecV1({ ...createSpec(), allowNestedSpawn: true })).toThrow("nested spawn");
	});

	it("validates TaskResultEnvelopeV1 and terminal error rules", () => {
		expect(validateTaskResultEnvelopeV1(createResult())).toEqual(createResult());
		expect(() => validateTaskResultEnvelopeV1({ ...createResult(), attempt: 2 })).toThrow("attempt");
		expect(() =>
			validateTaskResultEnvelopeV1({
				...createResult(),
				status: "failed",
				error: null,
			}),
		).toThrow("failed");
		expect(
			validateTaskResultEnvelopeV1({
				...createResult(),
				status: "orphaned",
				startedAt: null,
				error: { code: "runtime_lost", message: "Runtime exited." },
			}),
		).toMatchObject({ status: "orphaned", startedAt: null });
	});
});
