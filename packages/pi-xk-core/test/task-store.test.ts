import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	TaskHeadConflictError,
	TaskIdempotencyConflictError,
	TaskLifecycleTransitionError,
	TaskRecoveryRequiredError,
	type TaskResultEnvelopeV1,
	type TaskSpecV1,
	TaskStore,
} from "../src/index.ts";

const tempDirs: string[] = [];

function createSpec(taskId: string): TaskSpecV1 {
	return {
		schema: "pi-xk.task.spec.v1",
		taskId,
		parentSessionId: "session-parent",
		parentEntryId: "entry-parent",
		parentGoalId: null,
		role: "implementation",
		prompt: "Implement one bounded change.",
		expectedResult: "A concise implementation report.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function createResult(taskId: string): TaskResultEnvelopeV1 {
	return {
		schema: "pi-xk.task-result.v1",
		taskId,
		status: "succeeded",
		attempt: 1,
		summary: "Task completed.",
		evidence: [{ kind: "file", value: "src/example.ts" }],
		artifactIds: [],
		childSessionId: "child-session",
		childSessionFile: `/project/.pi-xk/tasks/${taskId}/session/child.jsonl`,
		startedAt: "2026-07-22T00:00:01.000Z",
		endedAt: "2026-07-22T00:00:02.000Z",
		error: null,
	};
}

async function createStore(): Promise<{ store: TaskStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new TaskStore(projectRoot), projectRoot };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("TaskStore", () => {
	it("creates, starts, and completes a hash-chained Task", async () => {
		const { store } = await createStore();
		const spec = createSpec("task_happy_path");
		const created = await store.createTask(spec, {
			eventId: "evt-created",
			idempotencyKey: "create:task_happy_path",
		});
		const started = await store.appendTaskStarted(
			spec.taskId,
			{
				childSessionId: "child-session",
				childSessionFile: "/project/.pi-xk/tasks/task_happy_path/session/child.jsonl",
				provider: "faux",
				modelId: "faux-model",
				thinkingLevel: "medium",
				builtinTools: ["read", "bash", "pi_xk_finish_task"],
				attempt: 1,
			},
			{
				eventId: "evt-started",
				idempotencyKey: "start:task_happy_path",
				expectedHead: created.head,
				timestamp: "2026-07-22T00:00:01.000Z",
			},
		);
		const completed = await store.appendTaskResult(spec.taskId, createResult(spec.taskId), {
			eventId: "evt-completed",
			idempotencyKey: "complete:task_happy_path",
			expectedHead: started.head,
			timestamp: "2026-07-22T00:00:02.000Z",
		});
		const replay = await store.replayTask(spec.taskId);

		expect(replay.status).toBe("succeeded");
		expect(replay.events.map((event) => event.eventType)).toEqual(["task_created", "task_started", "task_succeeded"]);
		expect(completed.event.prevHash).toBe(started.head.hash);
		expect(replay.resultArtifactId).toMatch(/^sha256:/);
	});

	it("deduplicates retries and enforces CAS and lifecycle transitions", async () => {
		const { store } = await createStore();
		const spec = createSpec("task_guards");
		const created = await store.createTask(spec, {
			eventId: "evt-created",
			idempotencyKey: "create:task_guards",
		});
		const retry = await store.createTask(spec, {
			eventId: "evt-created-retry",
			idempotencyKey: "create:task_guards",
		});
		expect(retry).toEqual(created);
		await expect(
			store.createTask(
				{ ...spec, prompt: "Different" },
				{
					eventId: "evt-conflict",
					idempotencyKey: "create:task_guards",
				},
			),
		).rejects.toBeInstanceOf(TaskIdempotencyConflictError);
		await expect(
			store.appendTaskStarted(
				spec.taskId,
				{
					childSessionId: "child",
					childSessionFile: "child.jsonl",
					provider: "faux",
					modelId: "faux",
					thinkingLevel: "off",
					builtinTools: [],
					attempt: 1,
				},
				{
					eventId: "evt-stale",
					idempotencyKey: "start:stale",
					expectedHead: { sequence: 0, hash: "sha256:stale" },
				},
			),
		).rejects.toBeInstanceOf(TaskHeadConflictError);
		await expect(
			store.appendTaskResult(spec.taskId, createResult(spec.taskId), {
				eventId: "evt-invalid-terminal",
				idempotencyKey: "terminal:pending",
				expectedHead: created.head,
			}),
		).rejects.toBeInstanceOf(TaskLifecycleTransitionError);
	});

	it("diagnoses and repairs a trailing partial event", async () => {
		const { store, projectRoot } = await createStore();
		const spec = createSpec("task_partial_tail");
		await store.createTask(spec, { eventId: "evt-created", idempotencyKey: "create:partial" });
		const eventsPath = join(projectRoot, ".pi-xk", "tasks", spec.taskId, "events.jsonl");
		await appendFile(eventsPath, '{"schema":"pi-xk.task-event.v1"');

		const replay = await store.replayTask(spec.taskId);
		expect(replay.tailDiagnostic?.discardedBytes).toBeGreaterThan(0);
		await expect(
			store.appendTaskCancelled(spec.taskId, "startup recovery", {
				eventId: "evt-cancel",
				idempotencyKey: "cancel:partial",
				expectedHead: replay.head,
			}),
		).rejects.toBeInstanceOf(TaskRecoveryRequiredError);

		const repaired = await store.repairTrailingPartialEvent(spec.taskId);
		expect(repaired.tailDiagnostic).toBeUndefined();
		expect(await readFile(eventsPath, "utf8")).toMatch(/\n$/);
	});

	it("recovers pending and running Tasks without inventing success", async () => {
		const { store } = await createStore();
		const pending = createSpec("task_pending_recovery");
		await store.createTask(pending, { eventId: "evt-pending", idempotencyKey: "create:pending" });
		const pendingRecovered = await store.recoverTaskOnStartup(pending.taskId, "runtime restarted");
		expect(pendingRecovered.status).toBe("cancelled");

		const running = createSpec("task_running_recovery");
		const created = await store.createTask(running, { eventId: "evt-running", idempotencyKey: "create:running" });
		await store.appendTaskStarted(
			running.taskId,
			{
				childSessionId: "child-running",
				childSessionFile: "child-running.jsonl",
				provider: "faux",
				modelId: "faux",
				thinkingLevel: "high",
				builtinTools: [],
				attempt: 1,
			},
			{ eventId: "evt-start", idempotencyKey: "start:running", expectedHead: created.head },
		);
		const runningRecovered = await store.recoverTaskOnStartup(running.taskId, "runtime disappeared");
		expect(runningRecovered.status).toBe("orphaned");
	});
});
