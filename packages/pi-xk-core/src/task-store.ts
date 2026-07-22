import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ArtifactCorruptionError, ArtifactNotFoundError, ArtifactStore } from "./artifact-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import {
	assertTaskId,
	TASK_EVENT_SCHEMA,
	TASK_RESULT_SCHEMA,
	type TaskActor,
	type TaskChildInfoV1,
	type TaskEvent,
	type TaskEventType,
	type TaskHead,
	type TaskReadModel,
	type TaskResultEnvelopeV1,
	type TaskSpecV1,
	type TaskStatus,
	type TaskTerminalEventPayload,
	type TaskTerminalStatus,
	TaskValidationError,
	validateTaskChildInfo,
	validateTaskReadModel,
	validateTaskResultEnvelopeV1,
	validateTaskSpecV1,
} from "./task-contract.ts";
import { buildTaskReadModel, sameTaskReadModel, TaskReadModelStaleError } from "./task-read-model.ts";

const LOCK_RETRY_LIMIT = 100;
const LOCK_RETRY_DELAY_MS = 10;

export class TaskStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskStoreError";
	}
}

export class TaskNotFoundError extends TaskStoreError {
	constructor(taskId: string) {
		super(`Task not found: ${taskId}`);
		this.name = "TaskNotFoundError";
	}
}

export class TaskAlreadyExistsError extends TaskStoreError {
	constructor(taskId: string) {
		super(`Task already exists: ${taskId}`);
		this.name = "TaskAlreadyExistsError";
	}
}

export class TaskHeadConflictError extends TaskStoreError {
	constructor(expected: TaskHead, actual: TaskHead) {
		super(
			`Task head conflict: expected ${expected.sequence}/${expected.hash}, got ${actual.sequence}/${actual.hash}`,
		);
		this.name = "TaskHeadConflictError";
	}
}

export class TaskIdempotencyConflictError extends TaskStoreError {
	constructor(key: string) {
		super(`Idempotency key was reused with different Task event content: ${key}`);
		this.name = "TaskIdempotencyConflictError";
	}
}

export class TaskLifecycleTransitionError extends TaskStoreError {
	constructor(message: string) {
		super(`Task lifecycle transition is invalid: ${message}`);
		this.name = "TaskLifecycleTransitionError";
	}
}

export class TaskRecoveryRequiredError extends TaskStoreError {
	constructor(taskId: string) {
		super(`Task recovery is required before writing: ${taskId}`);
		this.name = "TaskRecoveryRequiredError";
	}
}

export class TaskCorruptionError extends TaskStoreError {
	constructor(message: string) {
		super(message);
		this.name = "TaskCorruptionError";
	}
}

export class TaskLockedError extends TaskStoreError {
	constructor(taskId: string) {
		super(`Task is locked while writing: ${taskId}`);
		this.name = "TaskLockedError";
	}
}

interface TaskPaths {
	taskDirectory: string;
	eventsPath: string;
	readModelPath: string;
	lockPath: string;
}

export interface TaskTailDiagnostic {
	discardedBytes: number;
}

export interface TaskReplay {
	taskId: string;
	spec: TaskSpecV1;
	head: TaskHead;
	events: TaskEvent[];
	status: TaskStatus;
	resultArtifactId?: string;
	tailDiagnostic?: TaskTailDiagnostic;
}

export interface TaskMutationOptions {
	eventId: string;
	idempotencyKey: string;
	actor?: TaskActor;
	timestamp?: string;
}

export interface TaskAppendOptions extends TaskMutationOptions {
	expectedHead: TaskHead;
}

export interface TaskWriteResult {
	event: TaskEvent;
	head: TaskHead;
}

export interface TaskListFilter {
	parentSessionId?: string;
	parentGoalId?: string | null;
	status?: TaskStatus;
}

export interface TaskInspection {
	replay: TaskReplay;
	readModel: TaskReadModel;
	result: TaskResultEnvelopeV1 | null;
	resultDiagnostic: "none" | "valid" | "missing" | "corrupt";
}

interface EventWithoutHash {
	schema: typeof TASK_EVENT_SCHEMA;
	eventId: string;
	taskId: string;
	sequence: number;
	eventType: TaskEventType;
	actor: TaskActor;
	timestamp: string;
	prevHash: string | null;
	payload: TaskEvent["payload"];
	schemaVersion: 1;
	idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new TaskValidationError(`${field} must be a non-empty string`);
	return value;
}

function requireIso(value: unknown, field: string): string {
	const timestamp = requireNonEmpty(value, field);
	if (Number.isNaN(Date.parse(timestamp))) throw new TaskValidationError(`${field} must be an ISO timestamp`);
	return timestamp;
}

function requireActor(value: unknown): TaskActor {
	if (value !== "user" && value !== "model" && value !== "runtime" && value !== "system")
		throw new TaskValidationError("actor is invalid");
	return value;
}

function requireArtifactId(value: unknown, field: string): string {
	const id = requireNonEmpty(value, field);
	if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new TaskValidationError(`${field} is invalid`);
	return id;
}

function calculateHash(event: EventWithoutHash): string {
	return `sha256:${createHash("sha256").update(stableJsonStringify(event)).digest("hex")}`;
}

function headFor(event: TaskEvent): TaskHead {
	return { sequence: event.sequence, hash: event.hash };
}

function terminalEventType(status: TaskTerminalStatus): TaskEventType {
	return `task_${status}` as TaskEventType;
}

function createEvent(input: EventWithoutHash): TaskEvent {
	const event = { ...input, hash: calculateHash(input) } as TaskEvent;
	return event;
}

function validateTerminalPayload(value: unknown, eventType: TaskEventType): TaskTerminalEventPayload {
	if (!isRecord(value)) throw new TaskValidationError("terminal payload must be an object");
	const keys = Object.keys(value).sort();
	const expected = ["status", "resultArtifactId", "summary", "artifactIds", "error"].sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
		throw new TaskValidationError("terminal payload fields are invalid");
	const status = requireNonEmpty(value.status, "terminal status") as TaskTerminalStatus;
	if (terminalEventType(status) !== eventType)
		throw new TaskValidationError("terminal status does not match event type");
	if (!Array.isArray(value.artifactIds)) throw new TaskValidationError("terminal artifactIds must be an array");
	const artifactIds = value.artifactIds.map((item, index) => requireArtifactId(item, `artifactIds[${index}]`));
	let error: TaskTerminalEventPayload["error"] = null;
	if (value.error !== null) {
		if (!isRecord(value.error) || Object.keys(value.error).sort().join(",") !== "code,message")
			throw new TaskValidationError("terminal error is invalid");
		error = {
			code: requireNonEmpty(value.error.code, "error.code"),
			message: requireNonEmpty(value.error.message, "error.message"),
		};
	}
	return {
		status,
		resultArtifactId: requireArtifactId(value.resultArtifactId, "resultArtifactId"),
		summary: requireNonEmpty(value.summary, "summary"),
		artifactIds,
		error,
	};
}

function parseEvent(value: unknown, lineNumber: number): TaskEvent {
	if (!isRecord(value)) throw new TaskCorruptionError(`Task event ${lineNumber} is not an object`);
	const required = [
		"schema",
		"eventId",
		"taskId",
		"sequence",
		"eventType",
		"actor",
		"timestamp",
		"prevHash",
		"payload",
		"schemaVersion",
		"idempotencyKey",
		"hash",
	].sort();
	const keys = Object.keys(value).sort();
	if (keys.length !== required.length || keys.some((key, index) => key !== required[index]))
		throw new TaskCorruptionError(`Task event ${lineNumber} has unknown or missing fields`);
	try {
		if (value.schema !== TASK_EVENT_SCHEMA || value.schemaVersion !== 1)
			throw new TaskValidationError("schema is unsupported");
		const taskId = requireNonEmpty(value.taskId, "taskId");
		assertTaskId(taskId);
		if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1)
			throw new TaskValidationError("sequence is invalid");
		const eventType = requireNonEmpty(value.eventType, "eventType") as TaskEventType;
		if (
			!["task_created", "task_started", "task_succeeded", "task_failed", "task_cancelled", "task_orphaned"].includes(
				eventType,
			)
		)
			throw new TaskValidationError("eventType is invalid");
		const actor = requireActor(value.actor);
		const timestamp = requireIso(value.timestamp, "timestamp");
		if (value.prevHash !== null && typeof value.prevHash !== "string")
			throw new TaskValidationError("prevHash is invalid");
		if (!isRecord(value.payload)) throw new TaskValidationError("payload is invalid");
		let payload: TaskEvent["payload"];
		if (eventType === "task_created") {
			if (Object.keys(value.payload).sort().join(",") !== "spec")
				throw new TaskValidationError("create payload is invalid");
			payload = { spec: validateTaskSpecV1(value.payload.spec) };
		} else if (eventType === "task_started") {
			if (Object.keys(value.payload).sort().join(",") !== "child")
				throw new TaskValidationError("start payload is invalid");
			payload = { child: validateTaskChildInfo(value.payload.child) };
		} else {
			payload = validateTerminalPayload(value.payload, eventType);
		}
		const withoutHash: EventWithoutHash = {
			schema: TASK_EVENT_SCHEMA,
			eventId: requireNonEmpty(value.eventId, "eventId"),
			taskId,
			sequence: value.sequence,
			eventType,
			actor,
			timestamp,
			prevHash: value.prevHash,
			payload,
			schemaVersion: 1,
			idempotencyKey: requireNonEmpty(value.idempotencyKey, "idempotencyKey"),
		};
		const hash = requireArtifactId(value.hash, "hash");
		if (calculateHash(withoutHash) !== hash) throw new TaskValidationError("hash mismatch");
		return { ...withoutHash, hash } as TaskEvent;
	} catch (error) {
		throw new TaskCorruptionError(
			`Task event ${lineNumber} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

function project(events: readonly TaskEvent[]): { spec: TaskSpecV1; status: TaskStatus; resultArtifactId?: string } {
	const created = events[0];
	if (!created || created.eventType !== "task_created")
		throw new TaskCorruptionError("Task event log must begin with task_created");
	let status: TaskStatus = "pending";
	let resultArtifactId: string | undefined;
	for (let index = 1; index < events.length; index++) {
		const event = events[index];
		if (!event) continue;
		if (event.eventType === "task_started") {
			if (status !== "pending") throw new TaskLifecycleTransitionError("task_started requires pending");
			status = "running";
		} else if (event.eventType !== "task_created") {
			if (status !== "running" && !(status === "pending" && event.eventType === "task_cancelled")) {
				throw new TaskLifecycleTransitionError(`${event.eventType} requires running`);
			}
			status = event.payload.status;
			resultArtifactId = event.payload.resultArtifactId;
		}
	}
	return { spec: created.payload.spec, status, ...(resultArtifactId ? { resultArtifactId } : {}) };
}

function replayRaw(taskId: string, raw: string): TaskReplay {
	const hasPartial = raw.length > 0 && !raw.endsWith("\n");
	const validRaw = hasPartial ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
	const lines = validRaw.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0) throw new TaskNotFoundError(taskId);
	const events = lines.map((line, index) => {
		try {
			return parseEvent(JSON.parse(line) as unknown, index + 1);
		} catch (error) {
			if (error instanceof SyntaxError) throw new TaskCorruptionError(`Task event ${index + 1} is not valid JSON`);
			throw error;
		}
	});
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event || event.taskId !== taskId || event.sequence !== index + 1)
			throw new TaskCorruptionError(`Task event ${index + 1} breaks identity or sequence`);
		const expectedPrev = index === 0 ? null : events[index - 1]?.hash;
		if (event.prevHash !== expectedPrev)
			throw new TaskCorruptionError(`Task event ${index + 1} breaks the hash chain`);
	}
	const projected = project(events);
	const head = headFor(events[events.length - 1] as TaskEvent);
	return {
		taskId,
		spec: projected.spec,
		head,
		events,
		status: projected.status,
		...(projected.resultArtifactId ? { resultArtifactId: projected.resultArtifactId } : {}),
		...(hasPartial ? { tailDiagnostic: { discardedBytes: Buffer.byteLength(raw.slice(validRaw.length)) } } : {}),
	};
}

function sameIdempotentContent(existing: TaskEvent, proposed: TaskEvent): boolean {
	return (
		existing.taskId === proposed.taskId &&
		existing.eventType === proposed.eventType &&
		stableJsonStringify(existing.payload) === stableJsonStringify(proposed.payload)
	);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class TaskStore {
	private readonly tasksDirectory: string;
	private readonly artifacts: ArtifactStore;

	constructor(projectRoot: string) {
		const root = resolve(projectRoot);
		this.tasksDirectory = join(root, ".pi-xk", "tasks");
		this.artifacts = new ArtifactStore(root);
	}

	private paths(taskId: string): TaskPaths {
		assertTaskId(taskId);
		const taskDirectory = join(this.tasksDirectory, taskId);
		if (basename(taskDirectory) !== taskId)
			throw new TaskValidationError("taskId resolves outside the Task directory");
		return {
			taskDirectory,
			eventsPath: join(taskDirectory, "events.jsonl"),
			readModelPath: join(taskDirectory, "task-read-model.json"),
			lockPath: join(taskDirectory, ".write.lock"),
		};
	}

	private async readReplay(paths: TaskPaths, taskId: string): Promise<TaskReplay> {
		try {
			return replayRaw(taskId, await readFile(paths.eventsPath, "utf8"));
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new TaskNotFoundError(taskId);
			throw error;
		}
	}

	private async withLock<TResult>(paths: TaskPaths, taskId: string, action: () => Promise<TResult>): Promise<TResult> {
		await mkdir(paths.taskDirectory, { recursive: true });
		for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
			let handle: FileHandle;
			try {
				handle = await open(paths.lockPath, "wx", 0o600);
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				await wait(LOCK_RETRY_DELAY_MS);
				continue;
			}
			try {
				await handle.writeFile(
					`${JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() })}\n`,
				);
				await handle.sync();
				await handle.close();
				return await action();
			} finally {
				await handle.close().catch(() => {});
				await unlink(paths.lockPath).catch(() => {});
			}
		}
		throw new TaskLockedError(taskId);
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async replaceFile(path: string, directory: string, content: string): Promise<void> {
		const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await this.syncDirectory(directory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async appendEvent(paths: TaskPaths, event: TaskEvent): Promise<void> {
		const handle = await open(paths.eventsPath, "a", 0o600);
		try {
			await handle.writeFile(`${stableJsonStringify(event)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async writeReadModel(paths: TaskPaths, replay: TaskReplay): Promise<TaskReadModel> {
		const readModel = await buildTaskReadModel(replay, this.artifacts);
		await this.replaceFile(paths.readModelPath, paths.taskDirectory, `${JSON.stringify(readModel, null, "\t")}\n`);
		return readModel;
	}

	private mutationMeta(
		taskId: string,
		options: TaskMutationOptions,
	): Pick<EventWithoutHash, "eventId" | "taskId" | "actor" | "timestamp" | "idempotencyKey"> {
		return {
			eventId: requireNonEmpty(options.eventId, "eventId"),
			taskId,
			actor: requireActor(options.actor ?? "runtime"),
			timestamp: requireIso(options.timestamp ?? new Date().toISOString(), "timestamp"),
			idempotencyKey: requireNonEmpty(options.idempotencyKey, "idempotencyKey"),
		};
	}

	private retry(replay: TaskReplay, proposed: TaskEvent): TaskWriteResult | undefined {
		const existing = replay.events.find((event) => event.idempotencyKey === proposed.idempotencyKey);
		if (!existing) return undefined;
		if (!sameIdempotentContent(existing, proposed)) throw new TaskIdempotencyConflictError(proposed.idempotencyKey);
		return { event: existing, head: headFor(existing) };
	}

	private assertHead(expected: TaskHead, actual: TaskHead): void {
		if (expected.sequence !== actual.sequence || expected.hash !== actual.hash)
			throw new TaskHeadConflictError(expected, actual);
	}

	async createTask(specInput: TaskSpecV1, options: TaskMutationOptions): Promise<TaskWriteResult> {
		const spec = validateTaskSpecV1(specInput);
		const paths = this.paths(spec.taskId);
		return await this.withLock(paths, spec.taskId, async () => {
			const meta = this.mutationMeta(spec.taskId, options);
			const event = createEvent({
				schema: TASK_EVENT_SCHEMA,
				...meta,
				sequence: 1,
				eventType: "task_created",
				prevHash: null,
				payload: { spec },
				schemaVersion: 1,
			});
			let existing: TaskReplay | undefined;
			try {
				existing = await this.readReplay(paths, spec.taskId);
			} catch (error) {
				if (!(error instanceof TaskNotFoundError)) throw error;
			}
			if (existing) {
				if (existing.tailDiagnostic) throw new TaskRecoveryRequiredError(spec.taskId);
				const retry = this.retry(existing, event);
				if (retry) {
					await this.writeReadModel(paths, existing);
					return retry;
				}
				throw new TaskAlreadyExistsError(spec.taskId);
			}
			await this.replaceFile(paths.eventsPath, paths.taskDirectory, `${stableJsonStringify(event)}\n`);
			const replay: TaskReplay = {
				taskId: spec.taskId,
				spec,
				head: headFor(event),
				events: [event],
				status: "pending",
			};
			await this.writeReadModel(paths, replay);
			return { event, head: replay.head };
		});
	}

	async appendTaskStarted(
		taskId: string,
		childInput: TaskChildInfoV1,
		options: TaskAppendOptions,
	): Promise<TaskWriteResult> {
		const child = validateTaskChildInfo(childInput);
		return await this.append(taskId, "task_started", { child }, options, ["pending"]);
	}

	async appendTaskResult(
		taskId: string,
		resultInput: TaskResultEnvelopeV1,
		options: TaskAppendOptions,
	): Promise<TaskWriteResult> {
		const result = validateTaskResultEnvelopeV1(resultInput);
		if (result.taskId !== taskId) throw new TaskValidationError("Task result taskId does not match");
		if (result.status !== "succeeded" && result.status !== "failed") {
			throw new TaskValidationError("appendTaskResult only accepts succeeded or failed results");
		}
		const artifact = await this.artifacts.put({
			contentType: "application/json",
			value: result,
			producer: TASK_RESULT_SCHEMA,
			sensitivity: "internal",
			sourceIds: [taskId, result.childSessionId],
			createdAt: result.endedAt,
		});
		const payload: TaskTerminalEventPayload = {
			status: result.status,
			resultArtifactId: artifact.artifactId,
			summary: result.summary,
			artifactIds: [...result.artifactIds],
			error: result.error,
		};
		return await this.append(taskId, terminalEventType(result.status), payload, options, ["running"]);
	}

	async appendTaskCancelled(taskId: string, reason: string, options: TaskAppendOptions): Promise<TaskWriteResult> {
		return await this.appendSyntheticTerminal(
			taskId,
			"cancelled",
			"task_cancelled",
			"task_cancelled",
			reason,
			options,
			false,
		);
	}

	async appendTaskOrphaned(taskId: string, reason: string, options: TaskAppendOptions): Promise<TaskWriteResult> {
		return await this.appendSyntheticTerminal(
			taskId,
			"orphaned",
			"task_orphaned",
			"runtime_lost",
			reason,
			options,
			false,
		);
	}

	private async appendSyntheticTerminal(
		taskId: string,
		status: "cancelled" | "orphaned",
		eventType: "task_cancelled" | "task_orphaned",
		code: string,
		reason: string,
		options: TaskAppendOptions,
		allowPending: boolean,
	): Promise<TaskWriteResult> {
		const replay = await this.replayTask(taskId);
		const started = replay.events.find((event) => event.eventType === "task_started");
		const child = started?.eventType === "task_started" ? started.payload.child : undefined;
		const endedAt = options.timestamp ?? new Date().toISOString();
		const result: TaskResultEnvelopeV1 = {
			schema: "pi-xk.task-result.v1",
			taskId,
			status,
			attempt: 1,
			summary: reason,
			evidence: [],
			artifactIds: [],
			childSessionId: child?.childSessionId ?? "not-started",
			childSessionFile: child?.childSessionFile ?? "not-started",
			startedAt: started?.timestamp ?? null,
			endedAt,
			error: { code, message: reason },
		};
		const artifact = await this.artifacts.put({
			contentType: "application/json",
			value: result,
			producer: TASK_RESULT_SCHEMA,
			sensitivity: "internal",
			sourceIds: [taskId, result.childSessionId],
			createdAt: endedAt,
		});
		return await this.append(
			taskId,
			eventType,
			{ status, resultArtifactId: artifact.artifactId, summary: reason, artifactIds: [], error: result.error },
			{ ...options, timestamp: endedAt },
			allowPending ? ["pending", "running"] : ["running"],
		);
	}

	private async append(
		taskId: string,
		eventType: TaskEventType,
		payload: TaskEvent["payload"],
		options: TaskAppendOptions,
		allowed: TaskStatus[],
	): Promise<TaskWriteResult> {
		const paths = this.paths(taskId);
		return await this.withLock(paths, taskId, async () => {
			const replay = await this.readReplay(paths, taskId);
			if (replay.tailDiagnostic) throw new TaskRecoveryRequiredError(taskId);
			const meta = this.mutationMeta(taskId, options);
			const event = createEvent({
				schema: TASK_EVENT_SCHEMA,
				...meta,
				sequence: replay.head.sequence + 1,
				eventType,
				prevHash: replay.head.hash,
				payload,
				schemaVersion: 1,
			});
			const retry = this.retry(replay, event);
			if (retry) return retry;
			this.assertHead(options.expectedHead, replay.head);
			if (!allowed.includes(replay.status))
				throw new TaskLifecycleTransitionError(
					`${eventType} requires ${allowed.join(" or ")}, got ${replay.status}`,
				);
			const events = [...replay.events, event];
			const projected = project(events);
			await this.appendEvent(paths, event);
			const next: TaskReplay = {
				taskId,
				spec: projected.spec,
				head: headFor(event),
				events,
				status: projected.status,
				...(projected.resultArtifactId ? { resultArtifactId: projected.resultArtifactId } : {}),
			};
			await this.writeReadModel(paths, next);
			return { event, head: next.head };
		});
	}

	async replayTask(taskId: string): Promise<TaskReplay> {
		return await this.readReplay(this.paths(taskId), taskId);
	}

	async loadTaskReadModel(taskId: string): Promise<TaskReadModel> {
		const paths = this.paths(taskId);
		const replay = await this.readReplay(paths, taskId);
		if (replay.tailDiagnostic) throw new TaskRecoveryRequiredError(taskId);
		let stored: TaskReadModel;
		try {
			stored = validateTaskReadModel(JSON.parse(await readFile(paths.readModelPath, "utf8")) as unknown);
		} catch {
			throw new TaskReadModelStaleError(taskId);
		}
		const rebuilt = await buildTaskReadModel(replay, this.artifacts);
		if (!sameTaskReadModel(stored, rebuilt)) throw new TaskReadModelStaleError(taskId);
		return stored;
	}

	async rebuildTaskReadModel(taskId: string): Promise<TaskReadModel> {
		const paths = this.paths(taskId);
		return await this.withLock(paths, taskId, async () => {
			const replay = await this.readReplay(paths, taskId);
			if (replay.tailDiagnostic) throw new TaskRecoveryRequiredError(taskId);
			return await this.writeReadModel(paths, replay);
		});
	}

	async listTasks(filter: TaskListFilter = {}): Promise<TaskReplay[]> {
		let taskIds: string[];
		try {
			taskIds = (await readdir(this.tasksDirectory, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("task_"))
				.map((entry) => entry.name);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
		const tasks: TaskReplay[] = [];
		for (const taskId of taskIds.sort()) {
			const replay = await this.replayTask(taskId);
			if (filter.parentSessionId !== undefined && replay.spec.parentSessionId !== filter.parentSessionId) continue;
			if (filter.parentGoalId !== undefined && replay.spec.parentGoalId !== filter.parentGoalId) continue;
			if (filter.status !== undefined && replay.status !== filter.status) continue;
			tasks.push(replay);
		}
		return tasks;
	}

	async inspectTask(taskId: string): Promise<TaskInspection> {
		const replay = await this.replayTask(taskId);
		const readModel = await buildTaskReadModel(replay, this.artifacts);
		if (!replay.resultArtifactId) return { replay, readModel, result: null, resultDiagnostic: "none" };
		try {
			const stored = await this.artifacts.read(replay.resultArtifactId);
			return {
				replay,
				readModel,
				result: validateTaskResultEnvelopeV1(JSON.parse(stored.content) as unknown),
				resultDiagnostic: "valid",
			};
		} catch (error) {
			if (error instanceof ArtifactNotFoundError)
				return { replay, readModel, result: null, resultDiagnostic: "missing" };
			if (
				error instanceof ArtifactCorruptionError ||
				error instanceof SyntaxError ||
				error instanceof TaskValidationError
			)
				return { replay, readModel, result: null, resultDiagnostic: "corrupt" };
			throw error;
		}
	}

	async recoverTaskOnStartup(taskId: string, reason: string): Promise<TaskReplay> {
		const replay = await this.replayTask(taskId);
		if (replay.status !== "pending" && replay.status !== "running") return replay;
		const eventType = replay.status === "pending" ? "task_cancelled" : "task_orphaned";
		await this.appendSyntheticTerminal(
			taskId,
			replay.status === "pending" ? "cancelled" : "orphaned",
			eventType,
			replay.status === "pending" ? "not_started" : "runtime_lost",
			reason,
			{
				eventId: `recovery:${taskId}:${replay.head.sequence}`,
				idempotencyKey: `startup-recovery:${taskId}:${replay.head.hash}`,
				expectedHead: replay.head,
				actor: "runtime",
			},
			true,
		);
		return await this.replayTask(taskId);
	}

	async repairTrailingPartialEvent(taskId: string): Promise<TaskReplay> {
		const paths = this.paths(taskId);
		return await this.withLock(paths, taskId, async () => {
			const raw = await readFile(paths.eventsPath, "utf8");
			const replay = replayRaw(taskId, raw);
			if (!replay.tailDiagnostic) return replay;
			await this.replaceFile(paths.eventsPath, paths.taskDirectory, raw.slice(0, raw.lastIndexOf("\n") + 1));
			const repaired = await this.readReplay(paths, taskId);
			await this.writeReadModel(paths, repaired);
			return repaired;
		});
	}
}
