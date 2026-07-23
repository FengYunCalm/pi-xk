import { describe, expect, it } from "vitest";
import {
	type TaskResultEnvelopeV1,
	type TaskSpecV1,
	type TaskSpecV2,
	TaskValidationError,
	upcastTaskSpec,
	validateTaskResultEnvelopeV1,
	validateTaskSpecV1,
	validateTaskSpecV2,
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

function createSpecV2(): TaskSpecV2 {
	return {
		schema: "pi-xk.task.spec.v2",
		taskId: "task_contract_v2",
		parent: {
			chainId: "chain_parent",
			branchId: "branch_parent",
			segmentId: "segment-parent",
			entryId: "entry-parent",
		},
		parentGoalId: "goal_parent",
		childChainId: "chain_child",
		role: "verification",
		prompt: "Verify the V2 Task contract.",
		expectedResult: "A chain-bound result envelope.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
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

	it("strictly validates TaskSpecV2 chain references", () => {
		expect(validateTaskSpecV2(createSpecV2())).toEqual(createSpecV2());
		expect(() => validateTaskSpecV2({ ...createSpecV2(), parentSessionId: "legacy" })).toThrow(TaskValidationError);
		expect(() =>
			validateTaskSpecV2({
				...createSpecV2(),
				parent: { ...createSpecV2().parent, chainId: "../outside" },
			}),
		).toThrow("chain_<safe-id>");
		expect(() => validateTaskSpecV2({ ...createSpecV2(), childChainId: "child" })).toThrow("chain_<safe-id>");
	});

	it("deterministically upcasts V1 without changing its original fields", () => {
		const legacy = createSpec();
		const upcast = upcastTaskSpec(legacy);

		expect(upcast).toMatchObject({
			schema: "pi-xk.task.spec.v2",
			taskId: legacy.taskId,
			parent: { entryId: legacy.parentEntryId },
			parentGoalId: legacy.parentGoalId,
			role: legacy.role,
		});
		expect(upcastTaskSpec(legacy)).toEqual(upcast);
		expect(legacy).toEqual(createSpec());
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
