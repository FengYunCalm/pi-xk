import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactCorruptionError,
	ArtifactNotFoundError,
	ArtifactStore,
	type TaskChildInfoV1,
	TaskHeadConflictError,
	TaskIdempotencyConflictError,
	TaskLifecycleTransitionError,
	TaskLockedError,
	TaskRecoveryRequiredError,
	type TaskResultEnvelopeV1,
	type TaskSpecV1,
	type TaskSpecV2,
	TaskStore,
	upcastTaskSpec,
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

function createSpecV2(taskId: string): TaskSpecV2 {
	return {
		schema: "pi-xk.task.spec.v2",
		taskId,
		parent: {
			chainId: "chain_parent",
			branchId: "branch_parent",
			segmentId: "segment-parent",
			entryId: "entry-parent",
		},
		parentGoalId: null,
		childChainId: `chain_${taskId}`,
		role: "implementation",
		prompt: "Implement one chain-bound change.",
		expectedResult: "A concise chain-bound report.",
		workspaceMode: "same-workspace",
		allowNestedSpawn: false,
		createdAt: "2026-07-22T00:00:00.000Z",
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
	it("stores V2 facts while replaying V1 bytes and hashes unchanged", async () => {
		const { store, projectRoot } = await createStore();
		const legacy = createSpec("task_v1_replay");
		await store.createTask(legacy, { eventId: "evt-v1", idempotencyKey: "create:v1" });
		const legacyPath = join(projectRoot, ".pi-xk", "tasks", legacy.taskId, "events.jsonl");
		const beforeReplay = await readFile(legacyPath, "utf8");
		const legacyReplay = await store.replayTask(legacy.taskId);
		expect(await readFile(legacyPath, "utf8")).toBe(beforeReplay);
		expect(legacyReplay.events[0]?.hash).toBe(JSON.parse(beforeReplay.trim()).hash);
		expect(upcastTaskSpec(legacyReplay.spec)).toMatchObject({
			schema: "pi-xk.task.spec.v2",
			parent: { entryId: legacy.parentEntryId },
		});

		const current = createSpecV2("task_v2_replay");
		await store.createTask(current, { eventId: "evt-v2", idempotencyKey: "create:v2" });
		expect((await store.replayTask(current.taskId)).spec).toEqual(current);
	});

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

	it.each([
		["missing", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ArtifactNotFoundError],
		["corrupt", null, ArtifactCorruptionError],
	] as const)(
		"rejects a %s referenced artifact before appending a terminal event",
		async (_kind, artifactId, errorType) => {
			const { store, projectRoot } = await createStore();
			const spec = createSpec(`task_${_kind}_evidence`);
			const created = await store.createTask(spec, {
				eventId: `evt-${_kind}-created`,
				idempotencyKey: `create:${_kind}`,
			});
			const started = await store.appendTaskStarted(
				spec.taskId,
				{
					childSessionId: `child-${_kind}`,
					childSessionFile: `child-${_kind}.jsonl`,
					provider: "faux",
					modelId: "faux",
					thinkingLevel: "medium",
					builtinTools: [],
					attempt: 1,
				},
				{
					eventId: `evt-${_kind}-started`,
					idempotencyKey: `start:${_kind}`,
					expectedHead: created.head,
				},
			);
			let referencedArtifactId: string;
			if (artifactId === null) {
				const metadata = await new ArtifactStore(projectRoot).put({
					contentType: "text/plain",
					text: "task evidence",
					producer: "pi-xk.test.v1",
					sensitivity: "internal",
					sourceIds: [spec.taskId],
					createdAt: "2026-07-22T00:00:01.000Z",
				});
				referencedArtifactId = metadata.artifactId;
				const digest = metadata.artifactId.slice("sha256:".length);
				await writeFile(
					join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`),
					"tampered",
				);
			} else {
				referencedArtifactId = artifactId;
			}
			const result = { ...createResult(spec.taskId), artifactIds: [referencedArtifactId] };

			await expect(
				store.appendTaskResult(spec.taskId, result, {
					eventId: `evt-${_kind}-terminal`,
					idempotencyKey: `terminal:${_kind}`,
					expectedHead: started.head,
				}),
			).rejects.toBeInstanceOf(errorType);
			await expect(store.replayTask(spec.taskId)).resolves.toMatchObject({ status: "running", head: started.head });
		},
	);

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

	it("fails closed and explicitly repairs an abandoned Task write lock", async () => {
		const { store, projectRoot } = await createStore();
		const spec = createSpec("task_abandoned_lock");
		const created = await store.createTask(spec, { eventId: "evt-created", idempotencyKey: "create:lock" });
		const lockPath = join(projectRoot, ".pi-xk", "tasks", spec.taskId, ".write.lock");
		await writeFile(
			lockPath,
			`${JSON.stringify({ pid: 999_999_999, nonce: "abandoned-task", createdAt: "2026-07-22T00:01:00.000Z" })}\n`,
		);

		const startedPayload: TaskChildInfoV1 = {
			childSessionId: "child-lock",
			childSessionFile: "child-lock.jsonl",
			provider: "faux",
			modelId: "faux",
			thinkingLevel: "medium",
			builtinTools: [],
			attempt: 1,
		};
		await expect(
			store.appendTaskStarted(spec.taskId, startedPayload, {
				eventId: "evt-start-locked",
				idempotencyKey: "start:locked",
				expectedHead: created.head,
			}),
		).rejects.toBeInstanceOf(TaskLockedError);
		expect(await store.inspectWriteLock(spec.taskId)).toMatchObject({
			nonce: "abandoned-task",
			ownerState: "missing",
			malformed: false,
		});
		await expect(store.repairAbandonedWriteLock(spec.taskId, "wrong-owner")).rejects.toThrow("conflicted");
		await expect(store.repairAbandonedWriteLock(spec.taskId, "abandoned-task")).resolves.toBe(true);
		await expect(
			store.appendTaskStarted(spec.taskId, startedPayload, {
				eventId: "evt-start-recovered",
				idempotencyKey: "start:recovered",
				expectedHead: created.head,
			}),
		).resolves.toMatchObject({ head: { sequence: 2 } });
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
