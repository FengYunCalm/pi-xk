import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskReadModelStaleError, type TaskResultEnvelopeV1, type TaskSpecV1, TaskStore } from "../src/index.ts";

const tempDirs: string[] = [];

function createSpec(taskId: string): TaskSpecV1 {
	return {
		schema: "pi-xk.task.spec.v1",
		taskId,
		parentSessionId: "session-parent",
		parentEntryId: "entry-parent",
		parentGoalId: null,
		role: "review",
		prompt: "Review the bounded change.",
		expectedResult: "A review summary.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

async function createCompletedTask(store: TaskStore, taskId: string): Promise<string> {
	const spec = createSpec(taskId);
	const created = await store.createTask(spec, { eventId: `${taskId}:created`, idempotencyKey: `${taskId}:created` });
	const started = await store.appendTaskStarted(
		taskId,
		{
			childSessionId: `${taskId}:child`,
			childSessionFile: `${taskId}.jsonl`,
			provider: "faux",
			modelId: "faux",
			thinkingLevel: "medium",
			builtinTools: [],
			attempt: 1,
		},
		{ eventId: `${taskId}:started`, idempotencyKey: `${taskId}:started`, expectedHead: created.head },
	);
	const result: TaskResultEnvelopeV1 = {
		schema: "pi-xk.task-result.v1",
		taskId,
		status: "succeeded",
		attempt: 1,
		summary: "Reviewed.",
		evidence: [{ kind: "text", value: "No blocking findings." }],
		artifactIds: [],
		childSessionId: `${taskId}:child`,
		childSessionFile: `${taskId}.jsonl`,
		startedAt: "2026-07-22T00:00:01.000Z",
		endedAt: "2026-07-22T00:00:02.000Z",
		error: null,
	};
	const terminal = await store.appendTaskResult(taskId, result, {
		eventId: `${taskId}:succeeded`,
		idempotencyKey: `${taskId}:succeeded`,
		expectedHead: started.head,
	});
	if (terminal.event.eventType !== "task_succeeded") throw new Error("unexpected terminal event");
	return terminal.event.payload.resultArtifactId;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("Task read model", () => {
	it("rebuilds a deleted projection from Task facts", async () => {
		const projectRoot = join(tmpdir(), `pi-xk-task-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(projectRoot, { recursive: true });
		tempDirs.push(projectRoot);
		const store = new TaskStore(projectRoot);
		const artifactId = await createCompletedTask(store, "task_read_model");
		const path = join(projectRoot, ".pi-xk", "tasks", "task_read_model", "task-read-model.json");
		await rm(path);

		const rebuilt = await store.rebuildTaskReadModel("task_read_model");
		expect(rebuilt).toMatchObject({
			schema: "pi-xk.task-read-model.v1",
			status: "succeeded",
			result: { resultArtifactId: artifactId, artifactStatus: "valid" },
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(rebuilt);
	});

	it("rejects a stale projection when its result artifact disappears", async () => {
		const projectRoot = join(tmpdir(), `pi-xk-task-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(projectRoot, { recursive: true });
		tempDirs.push(projectRoot);
		const store = new TaskStore(projectRoot);
		const artifactId = await createCompletedTask(store, "task_missing_artifact");
		const digest = artifactId.slice("sha256:".length);
		await rm(join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2)), { recursive: true });

		await expect(store.loadTaskReadModel("task_missing_artifact")).rejects.toBeInstanceOf(TaskReadModelStaleError);
		const rebuilt = await store.rebuildTaskReadModel("task_missing_artifact");
		expect(rebuilt.result?.artifactStatus).toBe("missing");
	});
});
