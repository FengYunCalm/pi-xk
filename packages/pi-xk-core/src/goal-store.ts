import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	assertGoalId,
	GOAL_CONTRACT_PROJECTION_SCHEMA,
	GOAL_EVENT_SCHEMA,
	type GoalActor,
	type GoalCheckpoint,
	type GoalCheckpointedEvent,
	type GoalContractProjection,
	type GoalContractUpdatedEvent,
	type GoalContractV1,
	type GoalCreatedEvent,
	type GoalEvent,
	type GoalHead,
	GoalValidationError,
	validateGoalCheckpoint,
	validateGoalContract,
} from "./contract.ts";
import { stableJsonStringify } from "./stable-json.ts";

const LOCK_RETRY_LIMIT = 100;
const LOCK_RETRY_DELAY_MS = 10;

export class GoalStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalStoreError";
	}
}

export class GoalNotFoundError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal not found: ${goalId}`);
		this.name = "GoalNotFoundError";
	}
}

export class GoalAlreadyExistsError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal already exists: ${goalId}`);
		this.name = "GoalAlreadyExistsError";
	}
}

export class GoalHeadConflictError extends GoalStoreError {
	constructor(expected: GoalHead, actual: GoalHead) {
		super(
			`Goal head conflict: expected ${expected.sequence}/${expected.hash}, got ${actual.sequence}/${actual.hash}`,
		);
		this.name = "GoalHeadConflictError";
	}
}

export class GoalIdempotencyConflictError extends GoalStoreError {
	constructor(idempotencyKey: string) {
		super(`Idempotency key was reused with different event content: ${idempotencyKey}`);
		this.name = "GoalIdempotencyConflictError";
	}
}

export class GoalRecoveryRequiredError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal recovery is required before writing: ${goalId}`);
		this.name = "GoalRecoveryRequiredError";
	}
}

export class GoalCorruptionError extends GoalStoreError {
	constructor(message: string) {
		super(message);
		this.name = "GoalCorruptionError";
	}
}

export class GoalLockedError extends GoalStoreError {
	constructor(goalId: string) {
		super(`Goal is locked by another writer: ${goalId}`);
		this.name = "GoalLockedError";
	}
}

interface GoalPaths {
	goalDirectory: string;
	eventsPath: string;
	projectionPath: string;
	lockPath: string;
}

interface StoredLock {
	pid: number;
	nonce: string;
	createdAt: string;
}

export interface GoalTailDiagnostic {
	discardedBytes: number;
}

export interface GoalReplay {
	goalId: string;
	contract: GoalContractV1;
	head: GoalHead;
	events: GoalEvent[];
	tailDiagnostic?: GoalTailDiagnostic;
}

export interface GoalMutationOptions {
	eventId: string;
	idempotencyKey: string;
	actor?: GoalActor;
	timestamp?: string;
}

export interface GoalContractUpdateOptions extends GoalMutationOptions {
	expectedHead: GoalHead;
}

export interface GoalWriteResult {
	event: GoalEvent;
	head: GoalHead;
}

interface EventInput {
	eventId: string;
	goalId: string;
	eventType: GoalEvent["eventType"];
	actor: GoalActor;
	timestamp: string;
	prevHash: string | null;
	payload: GoalEvent["payload"];
	sequence: number;
	idempotencyKey: string;
}

type GoalContractEventType = "goal_created" | "goal_contract_updated";

interface GoalEventHashInput {
	schema: typeof GOAL_EVENT_SCHEMA;
	eventId: string;
	goalId: string;
	sequence: number;
	eventType: GoalEvent["eventType"];
	actor: GoalActor;
	timestamp: string;
	prevHash: string | null;
	payload: GoalEvent["payload"];
	schemaVersion: 1;
	idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function assertNonEmptyString(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new GoalValidationError(`${field} must be a non-empty string`);
	}
}

function assertIsoTimestamp(value: string, field: string): void {
	assertNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(value))) {
		throw new GoalValidationError(`${field} must be an ISO timestamp`);
	}
}

function assertActor(value: GoalActor): void {
	if (value !== "user" && value !== "runtime" && value !== "model" && value !== "child-task" && value !== "system") {
		throw new GoalValidationError("actor is invalid");
	}
}

function eventHashInput(event: GoalEventHashInput): string {
	return stableJsonStringify(event);
}

function calculateEventHash(event: GoalEventHashInput): string {
	return `sha256:${createHash("sha256").update(eventHashInput(event)).digest("hex")}`;
}

function getContractFromPayload(payload: GoalEvent["payload"]): GoalContractV1 {
	if (!("contract" in payload)) {
		throw new GoalValidationError("Goal event requires a contract payload");
	}
	return payload.contract;
}

function getCheckpointFromPayload(payload: GoalEvent["payload"]): GoalCheckpoint {
	if (!("checkpoint" in payload)) {
		throw new GoalValidationError("Goal checkpoint event requires a checkpoint payload");
	}
	return payload.checkpoint;
}

function createEvent(input: EventInput): GoalEvent {
	if (input.eventType === "goal_created") {
		if (input.prevHash !== null) {
			throw new GoalValidationError("Goal creation must not have a previous hash");
		}
		const eventWithoutHash: Omit<GoalCreatedEvent, "hash"> = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: input.eventId,
			goalId: input.goalId,
			sequence: input.sequence,
			eventType: "goal_created",
			actor: input.actor,
			timestamp: input.timestamp,
			prevHash: null,
			payload: { contract: getContractFromPayload(input.payload) },
			schemaVersion: 1,
			idempotencyKey: input.idempotencyKey,
		};
		return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
	}
	if (input.prevHash === null) {
		throw new GoalValidationError("Goal contract updates require a previous hash");
	}
	if (input.eventType === "goal_checkpointed") {
		const eventWithoutHash: Omit<GoalCheckpointedEvent, "hash"> = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: input.eventId,
			goalId: input.goalId,
			sequence: input.sequence,
			eventType: "goal_checkpointed",
			actor: input.actor,
			timestamp: input.timestamp,
			prevHash: input.prevHash,
			payload: { checkpoint: getCheckpointFromPayload(input.payload) },
			schemaVersion: 1,
			idempotencyKey: input.idempotencyKey,
		};
		return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
	}
	const eventWithoutHash: Omit<GoalContractUpdatedEvent, "hash"> = {
		schema: GOAL_EVENT_SCHEMA,
		eventId: input.eventId,
		goalId: input.goalId,
		sequence: input.sequence,
		eventType: "goal_contract_updated",
		actor: input.actor,
		timestamp: input.timestamp,
		prevHash: input.prevHash,
		payload: { contract: getContractFromPayload(input.payload) },
		schemaVersion: 1,
		idempotencyKey: input.idempotencyKey,
	};
	return { ...eventWithoutHash, hash: calculateEventHash(eventWithoutHash) };
}

function headForEvent(event: GoalEvent): GoalHead {
	return { sequence: event.sequence, hash: event.hash };
}

function hasSameIdempotentContent(existing: GoalEvent, proposed: GoalEvent): boolean {
	return (
		existing.goalId === proposed.goalId &&
		existing.eventType === proposed.eventType &&
		stableJsonStringify(existing.payload) === stableJsonStringify(proposed.payload)
	);
}

function parseGoalEvent(value: unknown, lineNumber: number): GoalEvent {
	if (!isRecord(value)) {
		throw new GoalCorruptionError(`Event ${lineNumber} is not an object`);
	}
	const requiredKeys = [
		"schema",
		"eventId",
		"goalId",
		"sequence",
		"eventType",
		"actor",
		"timestamp",
		"prevHash",
		"payload",
		"schemaVersion",
		"idempotencyKey",
		"hash",
	];
	const keys = Object.keys(value).sort();
	if (keys.length !== requiredKeys.length || keys.some((key, index) => key !== [...requiredKeys].sort()[index])) {
		throw new GoalCorruptionError(`Event ${lineNumber} has unknown or missing fields`);
	}
	if (value.schema !== GOAL_EVENT_SCHEMA || value.schemaVersion !== 1) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an unsupported schema`);
	}
	if (typeof value.eventId !== "string" || value.eventId.length === 0 || typeof value.goalId !== "string") {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid identifiers`);
	}
	try {
		assertGoalId(value.goalId);
	} catch {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid goalId`);
	}
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid sequence`);
	}
	if (
		typeof value.actor !== "string" ||
		typeof value.timestamp !== "string" ||
		typeof value.idempotencyKey !== "string"
	) {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid metadata`);
	}
	try {
		assertActor(value.actor as GoalActor);
		assertIsoTimestamp(value.timestamp, "timestamp");
		assertNonEmptyString(value.idempotencyKey, "idempotencyKey");
	} catch {
		throw new GoalCorruptionError(`Event ${lineNumber} has invalid metadata`);
	}
	if (value.prevHash !== null && typeof value.prevHash !== "string") {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid prevHash`);
	}
	if (typeof value.hash !== "string" || !value.hash.startsWith("sha256:")) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid hash`);
	}
	if (!isRecord(value.payload)) {
		throw new GoalCorruptionError(`Event ${lineNumber} has an invalid payload`);
	}
	let event: GoalEvent;
	if (value.eventType === "goal_created") {
		if (Object.keys(value.payload).length !== 1 || !("contract" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid create payload`);
		}
		if (value.prevHash !== null) {
			throw new GoalCorruptionError(`Event ${lineNumber} creation event has a previous hash`);
		}
		const createdEvent: GoalCreatedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_created",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { contract: validateGoalContract(value.payload.contract) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = createdEvent;
	} else if (value.eventType === "goal_contract_updated") {
		if (Object.keys(value.payload).length !== 1 || !("contract" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid update payload`);
		}
		if (typeof value.prevHash !== "string") {
			throw new GoalCorruptionError(`Event ${lineNumber} update event has no previous hash`);
		}
		const updatedEvent: GoalContractUpdatedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_contract_updated",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { contract: validateGoalContract(value.payload.contract) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = updatedEvent;
	} else if (value.eventType === "goal_checkpointed") {
		if (Object.keys(value.payload).length !== 1 || !("checkpoint" in value.payload)) {
			throw new GoalCorruptionError(`Event ${lineNumber} has an invalid checkpoint payload`);
		}
		if (typeof value.prevHash !== "string") {
			throw new GoalCorruptionError(`Event ${lineNumber} checkpoint event has no previous hash`);
		}
		const checkpointedEvent: GoalCheckpointedEvent = {
			schema: GOAL_EVENT_SCHEMA,
			eventId: value.eventId,
			goalId: value.goalId,
			sequence: value.sequence,
			eventType: "goal_checkpointed",
			actor: value.actor as GoalActor,
			timestamp: value.timestamp,
			prevHash: value.prevHash,
			payload: { checkpoint: validateGoalCheckpoint(value.payload.checkpoint) },
			schemaVersion: 1,
			idempotencyKey: value.idempotencyKey,
			hash: value.hash,
		};
		event = checkpointedEvent;
	} else {
		throw new GoalCorruptionError(`Event ${lineNumber} has an unsupported type`);
	}
	const { hash: _hash, ...withoutHash } = event;
	if (calculateEventHash(withoutHash) !== event.hash) {
		throw new GoalCorruptionError(`Event ${lineNumber} has a hash mismatch`);
	}
	return event;
}

function replayEvents(goalId: string, raw: string): GoalReplay {
	const lastNewline = raw.lastIndexOf("\n");
	const completeContent = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
	const trailingContent = raw.slice(lastNewline + 1);
	const lines = completeContent.length === 0 ? [] : completeContent.slice(0, -1).split("\n");
	if (lines.length === 0) {
		throw new GoalCorruptionError(`Goal has no complete events: ${goalId}`);
	}
	const events = lines.map((line, index) => {
		try {
			return parseGoalEvent(JSON.parse(line) as unknown, index + 1);
		} catch (error) {
			if (error instanceof GoalCorruptionError) throw error;
			if (error instanceof GoalValidationError) {
				throw new GoalCorruptionError(`Event ${index + 1} has an invalid contract`);
			}
			throw new GoalCorruptionError(`Event ${index + 1} is not valid JSON`);
		}
	});
	let contract: GoalContractV1 | undefined;
	let previousHash: string | null = null;
	const eventIds = new Set<string>();
	const idempotencyKeys = new Set<string>();
	for (const [index, event] of events.entries()) {
		if (event.goalId !== goalId) {
			throw new GoalCorruptionError(`Event ${index + 1} belongs to a different Goal`);
		}
		if (event.sequence !== index + 1 || event.prevHash !== previousHash) {
			throw new GoalCorruptionError(`Event ${index + 1} breaks the Goal hash chain`);
		}
		if (eventIds.has(event.eventId) || idempotencyKeys.has(event.idempotencyKey)) {
			throw new GoalCorruptionError(`Event ${index + 1} duplicates a stable identifier`);
		}
		eventIds.add(event.eventId);
		idempotencyKeys.add(event.idempotencyKey);
		if (index === 0 && event.eventType !== "goal_created") {
			throw new GoalCorruptionError("The first Goal event must be goal_created");
		}
		if (index > 0 && event.eventType !== "goal_contract_updated" && event.eventType !== "goal_checkpointed") {
			throw new GoalCorruptionError(`Event ${index + 1} is invalid after Goal creation`);
		}
		if (event.eventType !== "goal_checkpointed") {
			const nextContract = event.payload.contract;
			if (nextContract.goalId !== goalId) {
				throw new GoalCorruptionError(`Event ${index + 1} contract has a different Goal ID`);
			}
			if (contract && nextContract.createdAt !== contract.createdAt) {
				throw new GoalCorruptionError(`Event ${index + 1} changes the Goal creation timestamp`);
			}
			contract = nextContract;
		}
		previousHash = event.hash;
	}
	const lastEvent = events.at(-1);
	if (!contract || !lastEvent) {
		throw new GoalCorruptionError(`Goal replay failed: ${goalId}`);
	}
	return {
		goalId,
		contract,
		head: headForEvent(lastEvent),
		events,
		...(trailingContent.length > 0 ? { tailDiagnostic: { discardedBytes: Buffer.byteLength(trailingContent) } } : {}),
	};
}

function wait(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export class GoalStore {
	private readonly goalsDirectory: string;

	constructor(projectRoot: string) {
		this.goalsDirectory = join(resolve(projectRoot), ".pi-xk", "goals");
	}

	private paths(goalId: string): GoalPaths {
		assertGoalId(goalId);
		const goalDirectory = join(this.goalsDirectory, goalId);
		if (basename(goalDirectory) !== goalId) {
			throw new GoalValidationError("goalId resolves outside the Goal directory");
		}
		return {
			goalDirectory,
			eventsPath: join(goalDirectory, "events.jsonl"),
			projectionPath: join(goalDirectory, "contract.json"),
			lockPath: join(goalDirectory, ".write.lock"),
		};
	}

	private async readReplay(paths: GoalPaths, goalId: string): Promise<GoalReplay> {
		let raw: string;
		try {
			raw = await readFile(paths.eventsPath, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new GoalNotFoundError(goalId);
			throw error;
		}
		return replayEvents(goalId, raw);
	}

	private async recoverStaleLock(paths: GoalPaths): Promise<boolean> {
		let stored: StoredLock;
		try {
			stored = JSON.parse(await readFile(paths.lockPath, "utf8")) as StoredLock;
		} catch {
			return false;
		}
		if (!Number.isInteger(stored.pid) || stored.pid <= 0 || typeof stored.nonce !== "string") {
			return false;
		}
		try {
			process.kill(stored.pid, 0);
			return false;
		} catch (error) {
			if (!isErrno(error, "ESRCH")) return false;
		}
		try {
			const stalePath = `${paths.lockPath}.stale-${randomUUID()}`;
			await rename(paths.lockPath, stalePath);
			await rm(stalePath, { force: true });
			return true;
		} catch {
			return false;
		}
	}

	private async withGoalLock<TResult>(
		paths: GoalPaths,
		goalId: string,
		action: () => Promise<TResult>,
	): Promise<TResult> {
		await mkdir(paths.goalDirectory, { recursive: true });
		const lock: StoredLock = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
		for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
			let handle: FileHandle;
			try {
				handle = await open(paths.lockPath, "wx", 0o600);
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				if (await this.recoverStaleLock(paths)) continue;
				await wait(LOCK_RETRY_DELAY_MS);
				continue;
			}
			try {
				try {
					await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				return await action();
			} finally {
				await unlink(paths.lockPath).catch(() => {});
			}
		}
		throw new GoalLockedError(goalId);
	}

	private async syncDirectory(directory: string): Promise<void> {
		const handle = await open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async appendEvent(paths: GoalPaths, event: GoalEvent): Promise<void> {
		const handle = await open(paths.eventsPath, "a", 0o600);
		try {
			await handle.writeFile(`${stableJsonStringify(event)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private async writeProjection(paths: GoalPaths, replay: GoalReplay): Promise<void> {
		const projection: GoalContractProjection = {
			schema: GOAL_CONTRACT_PROJECTION_SCHEMA,
			goalId: replay.goalId,
			sequence: replay.head.sequence,
			baseHash: replay.head.hash,
			contract: replay.contract,
		};
		const temporaryPath = join(paths.goalDirectory, `.contract-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(projection, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, paths.projectionPath);
			await this.syncDirectory(paths.goalDirectory);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private async replaceEvents(paths: GoalPaths, content: string): Promise<void> {
		const temporaryPath = join(paths.goalDirectory, `.events-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporaryPath, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, paths.eventsPath);
			await this.syncDirectory(paths.goalDirectory);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	}

	private buildEvent(
		contract: GoalContractV1,
		eventType: GoalContractEventType,
		options: GoalMutationOptions,
		sequence: number,
		prevHash: string | null,
	): GoalEvent {
		assertNonEmptyString(options.eventId, "eventId");
		assertNonEmptyString(options.idempotencyKey, "idempotencyKey");
		const actor = options.actor ?? "runtime";
		assertActor(actor);
		const timestamp = options.timestamp ?? new Date().toISOString();
		assertIsoTimestamp(timestamp, "timestamp");
		return createEvent({
			eventId: options.eventId,
			goalId: contract.goalId,
			eventType,
			actor,
			timestamp,
			prevHash,
			payload: { contract },
			sequence,
			idempotencyKey: options.idempotencyKey,
		});
	}

	private buildCheckpointEvent(
		goalId: string,
		checkpoint: GoalCheckpoint,
		options: GoalMutationOptions,
		sequence: number,
		prevHash: string,
	): GoalEvent {
		assertNonEmptyString(options.eventId, "eventId");
		assertNonEmptyString(options.idempotencyKey, "idempotencyKey");
		const actor = options.actor ?? "runtime";
		assertActor(actor);
		const timestamp = options.timestamp ?? checkpoint.createdAt;
		assertIsoTimestamp(timestamp, "timestamp");
		return createEvent({
			eventId: options.eventId,
			goalId,
			eventType: "goal_checkpointed",
			actor,
			timestamp,
			prevHash,
			payload: { checkpoint },
			sequence,
			idempotencyKey: options.idempotencyKey,
		});
	}

	private ensureRetryMatches(replay: GoalReplay, event: GoalEvent): GoalWriteResult | undefined {
		const existing = replay.events.find((candidate) => candidate.idempotencyKey === event.idempotencyKey);
		if (!existing) return undefined;
		if (!hasSameIdempotentContent(existing, event)) {
			throw new GoalIdempotencyConflictError(event.idempotencyKey);
		}
		return { event: existing, head: headForEvent(existing) };
	}

	async createGoal(contractInput: GoalContractV1, options: GoalMutationOptions): Promise<GoalWriteResult> {
		const contract = validateGoalContract(contractInput);
		const paths = this.paths(contract.goalId);
		return await this.withGoalLock(paths, contract.goalId, async () => {
			let existing: GoalReplay | undefined;
			try {
				existing = await this.readReplay(paths, contract.goalId);
			} catch (error) {
				if (!(error instanceof GoalNotFoundError)) throw error;
			}
			const event = this.buildEvent(contract, "goal_created", options, 1, null);
			if (existing) {
				if (existing.tailDiagnostic) throw new GoalRecoveryRequiredError(contract.goalId);
				const retry = this.ensureRetryMatches(existing, event);
				if (retry) return retry;
				throw new GoalAlreadyExistsError(contract.goalId);
			}
			await this.appendEvent(paths, event);
			const replay: GoalReplay = {
				goalId: contract.goalId,
				contract,
				head: headForEvent(event),
				events: [event],
			};
			await this.writeProjection(paths, replay);
			return { event, head: replay.head };
		});
	}

	async loadGoal(goalId: string): Promise<GoalReplay> {
		return await this.replayGoal(goalId);
	}

	async replayGoal(goalId: string): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.readReplay(paths, goalId);
	}

	async updateGoalContract(
		contractInput: GoalContractV1,
		options: GoalContractUpdateOptions,
	): Promise<GoalWriteResult> {
		const contract = validateGoalContract(contractInput);
		const paths = this.paths(contract.goalId);
		return await this.withGoalLock(paths, contract.goalId, async () => {
			const replay = await this.readReplay(paths, contract.goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(contract.goalId);
			const event = this.buildEvent(
				contract,
				"goal_contract_updated",
				options,
				replay.head.sequence + 1,
				replay.head.hash,
			);
			const retry = this.ensureRetryMatches(replay, event);
			if (retry) return retry;
			if (options.expectedHead.sequence !== replay.head.sequence || options.expectedHead.hash !== replay.head.hash) {
				throw new GoalHeadConflictError(options.expectedHead, replay.head);
			}
			if (contract.createdAt !== replay.contract.createdAt) {
				throw new GoalValidationError("Goal updates cannot change createdAt");
			}
			await this.appendEvent(paths, event);
			const nextReplay: GoalReplay = {
				goalId: contract.goalId,
				contract,
				head: headForEvent(event),
				events: [...replay.events, event],
			};
			await this.writeProjection(paths, nextReplay);
			return { event, head: nextReplay.head };
		});
	}

	async appendCheckpoint(
		goalId: string,
		checkpointInput: GoalCheckpoint,
		options: GoalContractUpdateOptions,
	): Promise<GoalWriteResult> {
		assertGoalId(goalId);
		const checkpoint = validateGoalCheckpoint(checkpointInput);
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			const event = this.buildCheckpointEvent(
				goalId,
				checkpoint,
				options,
				replay.head.sequence + 1,
				replay.head.hash,
			);
			const retry = this.ensureRetryMatches(replay, event);
			if (retry) return retry;
			if (options.expectedHead.sequence !== replay.head.sequence || options.expectedHead.hash !== replay.head.hash) {
				throw new GoalHeadConflictError(options.expectedHead, replay.head);
			}
			await this.appendEvent(paths, event);
			const nextReplay: GoalReplay = {
				goalId,
				contract: replay.contract,
				head: headForEvent(event),
				events: [...replay.events, event],
			};
			await this.writeProjection(paths, nextReplay);
			return { event, head: nextReplay.head };
		});
	}

	async rebuildContractProjection(goalId: string): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const replay = await this.readReplay(paths, goalId);
			if (replay.tailDiagnostic) throw new GoalRecoveryRequiredError(goalId);
			await this.writeProjection(paths, replay);
			return replay;
		});
	}

	async repairTrailingPartialEvent(goalId: string): Promise<GoalReplay> {
		const paths = this.paths(goalId);
		return await this.withGoalLock(paths, goalId, async () => {
			const raw = await readFile(paths.eventsPath, "utf8");
			const replay = replayEvents(goalId, raw);
			if (!replay.tailDiagnostic) return replay;
			const validContent = raw.slice(0, raw.lastIndexOf("\n") + 1);
			await this.replaceEvents(paths, validContent);
			const repaired = await this.readReplay(paths, goalId);
			await this.writeProjection(paths, repaired);
			return repaired;
		});
	}
}
