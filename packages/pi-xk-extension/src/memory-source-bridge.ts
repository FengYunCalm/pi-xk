import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ArtifactStore,
	GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA,
	type GoalContract,
	type GoalEvent,
	GoalStore,
	type MemoryIndexHistoryCueV1,
	parseGoalStateProjection,
	SessionChainStore,
	stableJsonStringify,
	syncDirectory,
	upcastGoalContract,
	validateGoalCheckpointEvidenceArtifactV2,
	validateGoalCompletionState,
	validateMemoryCaptureSourceV1,
} from "pi-xk-core";
import type {
	MemoryCaptureRequest,
	MemoryCaptureResultV1,
	MemoryController,
	MemoryGenerationHost,
} from "./memory-controller.ts";

const MEMORY_SOURCE_CURSOR_V1_SCHEMA = "pi-xk.memory-source-cursors.v1";
const MEMORY_SOURCE_CURSOR_SCHEMA = "pi-xk.memory-source-cursors.v2";
const MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA = "pi-xk.memory-history-cue-cursor.v1";
const MEMORY_HISTORY_CUE_CURSOR_SCHEMA = "pi-xk.memory-history-cue-cursor.v2";
const MEMORY_GOAL_SOURCE_SCHEMA = "pi-xk.memory-goal-source.v1";

interface MemoryCaptureControllerPort {
	getService(): ReturnType<MemoryController["getService"]>;
	capture(request: MemoryCaptureRequest, host: MemoryGenerationHost): Promise<MemoryCaptureResultV1>;
	resumePublications(): Promise<MemoryCaptureResultV1[]>;
}

interface MemorySourceCursorV1 {
	schema: typeof MEMORY_SOURCE_CURSOR_V1_SCHEMA;
	goals: Record<string, number>;
	chains: Record<string, number>;
	updatedAt: string;
}

interface MemorySourceCursorV2 {
	schema: typeof MEMORY_SOURCE_CURSOR_SCHEMA;
	goals: Record<string, { sequence: number; hash: string | null }>;
	chains: Record<string, { sequence: number; hash: string | null }>;
	updatedAt: string;
}

interface MemoryHistoryCueSegmentCursorV1 {
	chainId: string;
	branchId: string;
	segmentId: string;
	summaryArtifactId: string;
	sessionId: string;
}

interface MemoryHistoryCueCursorV1 {
	schema: typeof MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA;
	chains: Record<string, { sequence: number; hash: string | null }>;
	segments: Record<string, MemoryHistoryCueSegmentCursorV1>;
	cues: MemoryIndexHistoryCueV1[];
	updatedAt: string;
}

interface MemoryHistoryCueCursorV2 {
	schema: typeof MEMORY_HISTORY_CUE_CURSOR_SCHEMA;
	chains: Record<string, { sequence: number; hash: string | null }>;
	segments: Record<string, MemoryHistoryCueSegmentCursorV1>;
	cues: MemoryIndexHistoryCueV1[];
	contentDigest: string;
	updatedAt: string;
}

export interface PublishedRollupSourceV1 {
	chainId: string;
	branchId: string;
	windowIndex: number;
	artifactId: string;
}

export interface MemorySourceBridgeDoctorDiagnosticV1 {
	code: "source_cursor_invalid" | "history_cue_cursor_invalid";
	message: string;
	repairable: boolean;
}

interface EligibleSource {
	recordedAt: string;
	request: MemoryCaptureRequest;
}

class IneligibleGoalCheckpointSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IneligibleGoalCheckpointSourceError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function historyCueId(value: unknown): string {
	return `history_${digest(stableJsonStringify(value)).slice("sha256:".length, "sha256:".length + 32)}`;
}

function historySegmentKey(chainId: string, branchId: string, segmentId: string): string {
	return digest(stableJsonStringify({ chainId, branchId, segmentId }));
}

function exactSourceHead(value: unknown, field: string): { sequence: number; hash: string | null } {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "hash,sequence") {
		throw new Error(`Memory source cursor ${field} does not match its event log`);
	}
	if (
		typeof value.sequence !== "number" ||
		!Number.isInteger(value.sequence) ||
		value.sequence < 0 ||
		(value.hash !== null && (typeof value.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.hash))) ||
		(value.sequence === 0) !== (value.hash === null)
	) {
		throw new Error(`Memory source cursor ${field} does not match its event log`);
	}
	return { sequence: value.sequence, hash: value.hash };
}

function exactCursor(value: unknown): MemorySourceCursorV1 | MemorySourceCursorV2 {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "chains,goals,schema,updatedAt") {
		throw new Error("Memory source cursor is invalid");
	}
	if (!isRecord(value.goals) || !isRecord(value.chains)) {
		throw new Error("Memory source cursor is invalid");
	}
	if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
		throw new Error("Memory source cursor timestamp is invalid");
	}
	if (value.schema === MEMORY_SOURCE_CURSOR_V1_SCHEMA) {
		const entries = (record: Record<string, unknown>, field: string): Record<string, number> => {
			const result: Record<string, number> = {};
			for (const [key, sequence] of Object.entries(record)) {
				if (!Number.isInteger(sequence) || Number(sequence) < 0)
					throw new Error(`Memory source cursor ${field} is invalid`);
				result[key] = Number(sequence);
			}
			return result;
		};
		return {
			schema: MEMORY_SOURCE_CURSOR_V1_SCHEMA,
			goals: entries(value.goals, "goals"),
			chains: entries(value.chains, "chains"),
			updatedAt: value.updatedAt,
		};
	}
	if (value.schema !== MEMORY_SOURCE_CURSOR_SCHEMA) throw new Error("Memory source cursor schema is unsupported");
	const entries = (
		record: Record<string, unknown>,
		field: string,
	): Record<string, { sequence: number; hash: string | null }> => {
		const result: Record<string, { sequence: number; hash: string | null }> = {};
		for (const [key, head] of Object.entries(record)) {
			result[key] = exactSourceHead(head, `${field}.${key}`);
		}
		return result;
	};
	return {
		schema: MEMORY_SOURCE_CURSOR_SCHEMA,
		goals: entries(value.goals, "goals"),
		chains: entries(value.chains, "chains"),
		updatedAt: value.updatedAt,
	};
}

function requiredCursorString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`Memory history cue ${field} is invalid`);
	return value;
}

function exactHistoryCue(value: unknown): MemoryIndexHistoryCueV1 {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(",") !==
			"branchId,chainId,cueId,ordinal,recordedAt,segmentId,sessionId,sourceId,sourceType,title"
	) {
		throw new Error("Memory history cue cursor contains an invalid cue");
	}
	if (value.sourceType !== "segment_summary" && value.sourceType !== "compaction") {
		throw new Error("Memory history cue sourceType is invalid");
	}
	const recordedAt = requiredCursorString(value.recordedAt, "recordedAt");
	if (
		typeof value.ordinal !== "number" ||
		!Number.isInteger(value.ordinal) ||
		value.ordinal < 1 ||
		(value.sessionId !== null && (typeof value.sessionId !== "string" || value.sessionId.trim().length === 0)) ||
		Number.isNaN(Date.parse(recordedAt))
	) {
		throw new Error("Memory history cue cursor contains invalid range metadata");
	}
	return {
		cueId: requiredCursorString(value.cueId, "cueId"),
		sourceType: value.sourceType,
		sourceId: requiredCursorString(value.sourceId, "sourceId"),
		title: requiredCursorString(value.title, "title"),
		recordedAt,
		chainId: requiredCursorString(value.chainId, "chainId"),
		branchId: requiredCursorString(value.branchId, "branchId"),
		segmentId: requiredCursorString(value.segmentId, "segmentId"),
		ordinal: value.ordinal,
		sessionId: value.sessionId,
	};
}

function historyCueContentDigest(cursor: Pick<MemoryHistoryCueCursorV2, "chains" | "segments" | "cues">): string {
	return digest(stableJsonStringify({ chains: cursor.chains, segments: cursor.segments, cues: cursor.cues }));
}

function exactHistoryCueCursor(value: unknown): MemoryHistoryCueCursorV1 | MemoryHistoryCueCursorV2 {
	if (
		!isRecord(value) ||
		(value.schema !== MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA && value.schema !== MEMORY_HISTORY_CUE_CURSOR_SCHEMA) ||
		Object.keys(value).sort().join(",") !==
			(value.schema === MEMORY_HISTORY_CUE_CURSOR_SCHEMA
				? "chains,contentDigest,cues,schema,segments,updatedAt"
				: "chains,cues,schema,segments,updatedAt") ||
		!isRecord(value.chains) ||
		!isRecord(value.segments) ||
		!Array.isArray(value.cues) ||
		typeof value.updatedAt !== "string" ||
		Number.isNaN(Date.parse(value.updatedAt))
	) {
		throw new Error("Memory history cue cursor is invalid");
	}
	const chains: MemoryHistoryCueCursorV2["chains"] = {};
	for (const [chainId, head] of Object.entries(value.chains)) {
		if (
			!isRecord(head) ||
			Object.keys(head).sort().join(",") !== "hash,sequence" ||
			typeof head.sequence !== "number" ||
			!Number.isInteger(head.sequence) ||
			head.sequence < 1 ||
			typeof head.hash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(head.hash)
		) {
			throw new Error(`Memory history cue chain cursor is invalid: ${chainId}`);
		}
		chains[requiredCursorString(chainId, "chainId")] = { sequence: head.sequence, hash: head.hash };
	}
	const segments: MemoryHistoryCueCursorV2["segments"] = {};
	for (const [key, segment] of Object.entries(value.segments)) {
		if (
			!isRecord(segment) ||
			Object.keys(segment).sort().join(",") !== "branchId,chainId,segmentId,sessionId,summaryArtifactId"
		) {
			throw new Error(`Memory history cue segment cursor is invalid: ${key}`);
		}
		segments[requiredCursorString(key, "segment key")] = {
			chainId: requiredCursorString(segment.chainId, "segment chainId"),
			branchId: requiredCursorString(segment.branchId, "segment branchId"),
			segmentId: requiredCursorString(segment.segmentId, "segmentId"),
			summaryArtifactId: requiredCursorString(segment.summaryArtifactId, "summaryArtifactId"),
			sessionId: requiredCursorString(segment.sessionId, "sessionId"),
		};
	}
	const cues = value.cues.map(exactHistoryCue);
	if (new Set(cues.map((cue) => cue.cueId)).size !== cues.length) {
		throw new Error("Memory history cue cursor contains duplicate cue IDs");
	}
	const common = { chains, segments, cues, updatedAt: value.updatedAt };
	if (value.schema === MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA) {
		return { schema: MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA, ...common };
	}
	if (
		typeof value.contentDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(value.contentDigest) ||
		value.contentDigest !== historyCueContentDigest(common)
	) {
		throw new Error("Memory history cue cursor content digest is invalid");
	}
	return { schema: MEMORY_HISTORY_CUE_CURSOR_SCHEMA, ...common, contentDigest: value.contentDigest };
}

function contractAtEvent(events: readonly GoalEvent[], sequence: number): GoalContract {
	let contract: GoalContract | undefined;
	for (const event of events) {
		if (event.sequence > sequence) break;
		if (event.eventType === "goal_created" || event.eventType === "goal_contract_updated") {
			contract = event.payload.contract;
		}
	}
	if (!contract) throw new Error("Goal source has no contract at the selected event");
	return contract;
}

function queryText(parts: readonly string[]): string {
	return [...parts.join(" ").replace(/\s+/gu, " ").trim()].slice(0, 1_500).join("");
}

function eventSourceType(event: GoalEvent): "goal_checkpoint" | "goal_completion" | null {
	if (event.eventType === "goal_checkpointed" && event.payload.checkpoint.reason === "turn_end") {
		return "goal_checkpoint";
	}
	return event.eventType === "goal_ended" ? "goal_completion" : null;
}

export class MemorySourceBridge {
	private readonly projectRoot: string;
	private readonly memoryDirectory: string;
	private readonly cursorPath: string;
	private readonly historyCueCursorPath: string;
	private readonly controller: MemoryCaptureControllerPort;
	private readonly artifacts: ArtifactStore;
	private readonly goals: GoalStore;
	private readonly chains: SessionChainStore;
	private readonly now: () => string;
	constructor(options: {
		projectRoot: string;
		controller: MemoryCaptureControllerPort;
		now?: () => string;
	}) {
		this.projectRoot = resolve(options.projectRoot);
		this.memoryDirectory = join(this.projectRoot, ".pi-xk", "memory");
		this.cursorPath = join(this.memoryDirectory, "source-cursors.json");
		this.historyCueCursorPath = join(this.memoryDirectory, "history-cue-cursor.json");
		this.controller = options.controller;
		this.artifacts = new ArtifactStore(this.projectRoot);
		this.goals = new GoalStore(this.projectRoot);
		this.chains = new SessionChainStore(this.projectRoot);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private async directories(path: string, prefix: string): Promise<string[]> {
		let entries: Dirent[];
		try {
			entries = await readdir(path, { withFileTypes: true });
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
		return entries
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
			.map((entry) => entry.name)
			.sort();
	}

	private async goalIds(): Promise<string[]> {
		return await this.directories(join(this.projectRoot, ".pi-xk", "goals"), "goal_");
	}

	private async chainIds(): Promise<string[]> {
		return await this.directories(join(this.projectRoot, ".pi-xk", "sessions", "chains"), "chain_");
	}

	private async currentCursor(): Promise<MemorySourceCursorV1 | MemorySourceCursorV2 | null> {
		try {
			return exactCursor(JSON.parse(await readFile(this.cursorPath, "utf8")) as unknown);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return null;
			throw error;
		}
	}

	private async writeCursor(cursor: MemorySourceCursorV2): Promise<void> {
		await mkdir(this.memoryDirectory, { recursive: true });
		const temporary = join(this.memoryDirectory, `.source-cursors-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(cursor, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.cursorPath);
			await syncDirectory(this.memoryDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async currentHistoryCueCursor(
		forceRebuild: boolean,
	): Promise<MemoryHistoryCueCursorV1 | MemoryHistoryCueCursorV2 | null> {
		try {
			return exactHistoryCueCursor(JSON.parse(await readFile(this.historyCueCursorPath, "utf8")) as unknown);
		} catch (error) {
			if (isErrno(error, "ENOENT") || forceRebuild) return null;
			throw new Error(
				`Memory history cue cursor is invalid; run /memory doctor repair-projections: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async writeHistoryCueCursor(cursor: MemoryHistoryCueCursorV2): Promise<void> {
		await mkdir(this.memoryDirectory, { recursive: true });
		const temporary = join(this.memoryDirectory, `.history-cue-cursor-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(cursor, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.historyCueCursorPath);
			await syncDirectory(this.memoryDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async factHeads(): Promise<Pick<MemorySourceCursorV2, "goals" | "chains">> {
		const goals: MemorySourceCursorV2["goals"] = {};
		for (const goalId of await this.goalIds()) goals[goalId] = (await this.goals.loadGoal(goalId)).head;
		const chains: MemorySourceCursorV2["chains"] = {};
		for (const chainId of await this.chainIds()) chains[chainId] = (await this.chains.replayChain(chainId)).head;
		return { goals, chains };
	}

	private sourceHeadAt(
		events: readonly { sequence: number; hash: string }[],
		sequence: number,
		label: string,
	): { sequence: number; hash: string | null } {
		if (sequence === 0) return { sequence: 0, hash: null };
		const event = events.find((candidate) => candidate.sequence === sequence);
		if (!event) throw new Error(`Memory source cursor ${label} is ahead of or no longer matches its event log`);
		return { sequence, hash: event.hash };
	}

	private async verifiedSourceCursor(
		cursor: MemorySourceCursorV1 | MemorySourceCursorV2,
	): Promise<MemorySourceCursorV2> {
		const goalIds = new Set(await this.goalIds());
		const goals: MemorySourceCursorV2["goals"] = {};
		for (const [goalId, stored] of Object.entries(cursor.goals)) {
			if (!goalIds.has(goalId)) throw new Error(`Memory source cursor Goal event log is missing: ${goalId}`);
			const replay = await this.goals.loadGoal(goalId);
			const sequence = typeof stored === "number" ? stored : stored.sequence;
			const actual = this.sourceHeadAt(replay.events, sequence, `Goal ${goalId}`);
			if (typeof stored !== "number" && actual.hash !== stored.hash) {
				throw new Error(`Memory source cursor Goal ${goalId} no longer matches its event log`);
			}
			goals[goalId] = actual;
		}
		const chainIds = new Set(await this.chainIds());
		const chains: MemorySourceCursorV2["chains"] = {};
		for (const [chainId, stored] of Object.entries(cursor.chains)) {
			if (!chainIds.has(chainId)) throw new Error(`Memory source cursor Chain event log is missing: ${chainId}`);
			const replay = await this.chains.replayChain(chainId);
			const sequence = typeof stored === "number" ? stored : stored.sequence;
			const actual = this.sourceHeadAt(replay.events, sequence, `Chain ${chainId}`);
			if (typeof stored !== "number" && actual.hash !== stored.hash) {
				throw new Error(`Memory source cursor Chain ${chainId} no longer matches its event log`);
			}
			chains[chainId] = actual;
		}
		return { schema: MEMORY_SOURCE_CURSOR_SCHEMA, goals, chains, updatedAt: cursor.updatedAt };
	}

	private async verifyHistoryCueCursor(cursor: MemoryHistoryCueCursorV1 | MemoryHistoryCueCursorV2): Promise<void> {
		const chainIds = new Set(await this.chainIds());
		const replays = new Map<string, Awaited<ReturnType<SessionChainStore["replayChain"]>>>();
		for (const [chainId, head] of Object.entries(cursor.chains)) {
			if (!chainIds.has(chainId)) throw new Error(`Memory history cue source chain is missing: ${chainId}`);
			const replay = await this.chains.replayChain(chainId);
			const event = replay.events.find((candidate) => candidate.sequence === head.sequence);
			if (!event || event.hash !== head.hash) {
				throw new Error(`Memory history cue chain cursor no longer matches its event log: ${chainId}`);
			}
			replays.set(chainId, replay);
		}
		const segmentManagers = new Map<string, SessionManager>();
		for (const [key, storedSegment] of Object.entries(cursor.segments)) {
			if (key !== historySegmentKey(storedSegment.chainId, storedSegment.branchId, storedSegment.segmentId)) {
				throw new Error(`Memory history cue segment key is invalid: ${storedSegment.segmentId}`);
			}
			const replay = replays.get(storedSegment.chainId) ?? (await this.chains.replayChain(storedSegment.chainId));
			replays.set(storedSegment.chainId, replay);
			const branch = replay.branches.find((candidate) => candidate.branchId === storedSegment.branchId);
			const segment = branch?.segments.find((candidate) => candidate.segmentId === storedSegment.segmentId);
			if (
				!segment ||
				segment.status !== "sealed" ||
				segment.seal?.summaryArtifactId !== storedSegment.summaryArtifactId
			) {
				throw new Error(`Memory history cue segment cursor no longer matches its seal: ${storedSegment.segmentId}`);
			}
			const manager = SessionManager.open(this.segmentPath(storedSegment.chainId, storedSegment.branchId, segment));
			if (manager.getSessionId() !== storedSegment.sessionId) {
				throw new Error(`Memory history cue segment Session no longer matches: ${storedSegment.segmentId}`);
			}
			segmentManagers.set(key, manager);
		}
		for (const cue of cursor.cues) {
			const key = historySegmentKey(cue.chainId, cue.branchId, cue.segmentId);
			const storedSegment = cursor.segments[key];
			if (!storedSegment) throw new Error(`Memory history cue has no sealed Segment source: ${cue.cueId}`);
			if (cue.sourceType === "segment_summary") {
				const summary = await this.chains.readSegmentSummary(storedSegment.summaryArtifactId);
				if (
					cue.sessionId !== null ||
					cue.sourceId !== storedSegment.summaryArtifactId ||
					summary.schema !== "pi-xk.segment-summary.v2" ||
					summary.title !== cue.title ||
					summary.generator.generatedAt !== cue.recordedAt
				) {
					throw new Error(`Memory history cue no longer matches its L1 artifact: ${cue.cueId}`);
				}
				continue;
			}
			const manager = segmentManagers.get(key);
			const entry = manager
				?.getEntries()
				.find((candidate) => candidate.type === "compaction" && candidate.id === cue.sourceId);
			if (
				!manager ||
				cue.sessionId !== manager.getSessionId() ||
				!entry ||
				entry.type !== "compaction" ||
				entry.title !== cue.title ||
				entry.timestamp !== cue.recordedAt
			) {
				throw new Error(`Memory history cue no longer matches its compaction entry: ${cue.cueId}`);
			}
		}
	}

	async doctor(mode: "quick" | "deep" = "quick"): Promise<MemorySourceBridgeDoctorDiagnosticV1[]> {
		const diagnostics: MemorySourceBridgeDoctorDiagnosticV1[] = [];
		try {
			const cursor = await this.currentCursor();
			if (mode === "deep" && cursor) await this.verifiedSourceCursor(cursor);
		} catch (error) {
			diagnostics.push({
				code: "source_cursor_invalid",
				message: error instanceof Error ? error.message : String(error),
				repairable: false,
			});
		}
		try {
			const cursor = await this.currentHistoryCueCursor(false);
			if (mode === "deep" && cursor) await this.verifyHistoryCueCursor(cursor);
		} catch (error) {
			diagnostics.push({
				code: "history_cue_cursor_invalid",
				message: error instanceof Error ? error.message : String(error),
				repairable: true,
			});
		}
		return diagnostics;
	}

	async initialize(): Promise<void> {
		if (!(await this.controller.getService().getConfig()).enabled) return;
		if (await this.currentCursor()) return;
		const heads = await this.factHeads();
		await this.writeCursor({ schema: MEMORY_SOURCE_CURSOR_SCHEMA, ...heads, updatedAt: this.now() });
	}

	private async checkpointState(
		event: Extract<GoalEvent, { eventType: "goal_checkpointed" }>,
		contract: GoalContract,
	): Promise<string> {
		const checkpoint = event.payload.checkpoint;
		if (checkpoint.schema !== "pi-xk.goal-checkpoint.v2" || checkpoint.reason !== "turn_end") {
			throw new IneligibleGoalCheckpointSourceError(
				`Goal ${event.goalId} checkpoint has no event-time Goal State snapshot`,
			);
		}
		for (const reference of checkpoint.evidence.artifacts) {
			if (reference.role !== "checkpoint_evidence") continue;
			const stored = await this.artifacts.read(reference.artifactId);
			if (stored.metadata.producer !== GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA) continue;
			const snapshot = validateGoalCheckpointEvidenceArtifactV2(JSON.parse(stored.content) as unknown);
			const contractRevision = contract.schema === "pi-xk.goal.contract.v3" ? contract.revision : null;
			if (
				snapshot.goalId !== event.goalId ||
				snapshot.sessionId !== checkpoint.sessionId ||
				snapshot.leafId !== checkpoint.leafId ||
				snapshot.turnIndex !== checkpoint.turnIndex ||
				snapshot.toolResultCount !== checkpoint.toolResultCount ||
				snapshot.createdAt !== checkpoint.createdAt ||
				snapshot.contractRevision !== contractRevision ||
				!stored.metadata.sourceIds.includes(event.goalId) ||
				!stored.metadata.sourceIds.includes(checkpoint.sessionId) ||
				!stored.metadata.sourceIds.includes(checkpoint.leafId)
			) {
				throw new Error(`Goal ${event.goalId} checkpoint State snapshot does not match its event`);
			}
			if (contract.schema === "pi-xk.goal.contract.v3") {
				try {
					parseGoalStateProjection(snapshot.goalState, contract);
				} catch (error) {
					throw new IneligibleGoalCheckpointSourceError(
						`Goal ${event.goalId} checkpoint State is not synchronized with revision ${contract.revision}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return snapshot.goalState;
		}
		throw new IneligibleGoalCheckpointSourceError(
			`Goal ${event.goalId} checkpoint has no event-time Goal State snapshot`,
		);
	}

	private async canonicalGoalRequest(event: GoalEvent, trigger: "goal_checkpoint" | "goal_completion" | "backfill") {
		const replay = await this.goals.loadGoal(event.goalId);
		const contract = contractAtEvent(replay.events, event.sequence);
		let state: string;
		if (event.eventType === "goal_checkpointed") {
			state = await this.checkpointState(event, contract);
		} else {
			const currentContract = upcastGoalContract(contract);
			if (stableJsonStringify(currentContract) !== stableJsonStringify(replay.contract)) {
				throw new Error(`Goal ${event.goalId} completion contract is no longer current`);
			}
			const finalCheckpoint = [...replay.events]
				.reverse()
				.find(
					(candidate) =>
						candidate.sequence < event.sequence &&
						candidate.eventType === "goal_checkpointed" &&
						candidate.payload.checkpoint.reason === "turn_end",
				);
			if (!finalCheckpoint || finalCheckpoint.eventType !== "goal_checkpointed") {
				throw new IneligibleGoalCheckpointSourceError(
					`Goal ${event.goalId} completion has no final event-time Goal State snapshot`,
				);
			}
			state = await this.checkpointState(finalCheckpoint, contract);
		}
		if (event.eventType === "goal_ended" && contract.schema === "pi-xk.goal.contract.v3") {
			const payload = event.payload;
			const stateError = validateGoalCompletionState(state, contract, {
				verifiedAcceptanceIds: payload.verifiedAcceptanceIds ?? [],
				finalEvidence: payload.finalEvidence ?? "",
				finalSummary: payload.finalSummary ?? "",
			});
			if (stateError) throw new Error(`Goal completion state is invalid: ${stateError}`);
		}
		const sourceType = event.eventType === "goal_ended" ? "goal_completion" : "goal_checkpoint";
		const source = {
			schema: MEMORY_GOAL_SOURCE_SCHEMA,
			goalId: event.goalId,
			contractRevision: contract.schema === "pi-xk.goal.contract.v3" ? contract.revision : null,
			event,
			state,
		};
		const stored = await this.artifacts.put({
			contentType: "application/json",
			value: source,
			producer: MEMORY_GOAL_SOURCE_SCHEMA,
			sensitivity: "internal",
			sourceIds: [event.goalId, event.eventId],
			createdAt: event.timestamp,
		});
		const canonical = await this.artifacts.read(stored.artifactId);
		const parsed = JSON.parse(canonical.content) as unknown;
		if (!isRecord(parsed) || parsed.schema !== MEMORY_GOAL_SOURCE_SCHEMA || parsed.goalId !== event.goalId) {
			throw new Error("Goal Memory source artifact failed canonical read-back validation");
		}
		return {
			trigger,
			sourceType,
			sourceId: event.eventId,
			artifactId: stored.artifactId,
			sourceDigest: stored.artifactId,
			locator:
				event.eventType === "goal_ended"
					? { goalId: event.goalId, eventId: event.eventId }
					: { goalId: event.goalId, checkpointEventId: event.eventId },
			recordedAt: event.timestamp,
			query: queryText([contract.title, sourceType, state]),
			content: canonical.content,
			scope: { goalId: event.goalId, chainId: null, branchId: null, paths: [] },
		} satisfies MemoryCaptureRequest;
	}

	private async canonicalRollupRequest(
		source: PublishedRollupSourceV1,
		trigger: "chain_rollup" | "backfill",
	): Promise<MemoryCaptureRequest> {
		const replay = await this.chains.replayChain(source.chainId);
		const branch = replay.branches.find((candidate) => candidate.branchId === source.branchId);
		const publication = branch?.rollups.find(
			(candidate) => candidate.windowIndex === source.windowIndex && candidate.artifactId === source.artifactId,
		);
		if (!publication) throw new Error("Session Chain Rollup has no matching published event");
		const rollup = await this.chains.readChainRollup(source.artifactId);
		if (
			rollup.chainId !== source.chainId ||
			rollup.branchId !== source.branchId ||
			rollup.windowIndex !== source.windowIndex ||
			rollup.sourceDigest !== publication.sourceDigest
		) {
			throw new Error("Session Chain Rollup artifact does not match its published event");
		}
		const canonical = await this.artifacts.read(source.artifactId);
		return {
			trigger,
			sourceType: "chain_summary",
			sourceId: publication.eventId,
			artifactId: source.artifactId,
			sourceDigest: source.artifactId,
			locator: {
				chainId: source.chainId,
				branchId: source.branchId,
				level: "l2",
				segmentId: null,
				ordinal: null,
				windowIndex: source.windowIndex,
			},
			recordedAt: publication.publishedAt,
			query: queryText([
				rollup.rollup.state,
				...rollup.rollup.decisions,
				...rollup.rollup.constraints,
				...rollup.rollup.unresolved,
			]),
			content: canonical.content,
			scope: { goalId: null, chainId: source.chainId, branchId: source.branchId, paths: [] },
		};
	}

	async capturePublishedRollup(
		source: PublishedRollupSourceV1,
		host: MemoryGenerationHost,
		trigger: "chain_rollup" | "backfill" = "chain_rollup",
	): Promise<MemoryCaptureResultV1> {
		return await this.controller.capture(await this.canonicalRollupRequest(source, trigger), host);
	}

	private async unseenGoalSources(
		cursor: MemorySourceCursorV2,
		retryableSourceIds: ReadonlySet<string>,
	): Promise<Array<{ event: GoalEvent; trigger: "goal_checkpoint" | "goal_completion" }>> {
		const result: Array<{ event: GoalEvent; trigger: "goal_checkpoint" | "goal_completion" }> = [];
		for (const goalId of await this.goalIds()) {
			const replay = await this.goals.loadGoal(goalId);
			const latestCheckpoint = [...replay.events]
				.reverse()
				.find((event) => eventSourceType(event) === "goal_checkpoint");
			for (const event of replay.events) {
				const retryable = retryableSourceIds.has(event.eventId);
				if (event.sequence <= (cursor.goals[goalId]?.sequence ?? 0) && !retryable) continue;
				const trigger = eventSourceType(event);
				if (
					!trigger ||
					(trigger === "goal_checkpoint" && event.eventId !== latestCheckpoint?.eventId && !retryable)
				) {
					continue;
				}
				if (trigger === "goal_checkpoint" && event.eventType === "goal_checkpointed") {
					try {
						await this.checkpointState(event, contractAtEvent(replay.events, event.sequence));
					} catch (error) {
						if (error instanceof IneligibleGoalCheckpointSourceError) continue;
						throw error;
					}
				}
				result.push({ event, trigger });
			}
			cursor.goals[goalId] = replay.head;
		}
		return result;
	}

	private async unseenRollups(
		cursor: MemorySourceCursorV2,
		retryableSourceIds: ReadonlySet<string>,
	): Promise<PublishedRollupSourceV1[]> {
		const result: PublishedRollupSourceV1[] = [];
		for (const chainId of await this.chainIds()) {
			const replay = await this.chains.replayChain(chainId);
			for (const event of replay.events) {
				if (
					(event.sequence <= (cursor.chains[chainId]?.sequence ?? 0) && !retryableSourceIds.has(event.eventId)) ||
					event.eventType !== "rollup_published"
				)
					continue;
				result.push({
					chainId,
					branchId: event.payload.branchId,
					windowIndex: event.payload.windowIndex,
					artifactId: event.payload.artifactId,
				});
			}
			cursor.chains[chainId] = replay.head;
		}
		return result;
	}

	private async retryableSourceIds(): Promise<Set<string>> {
		const readModel = (await this.controller.getService().getStore().loadReadModelSnapshot()).readModel;
		const sourceIds = new Set<string>();
		for (const capture of readModel.captures) {
			if (capture.status !== "failed" || capture.retryable !== true) continue;
			const stored = await this.artifacts.read(capture.sourceArtifactId);
			const source = validateMemoryCaptureSourceV1(JSON.parse(stored.content) as unknown);
			if (source.captureId !== capture.captureId || source.sourceDigest !== capture.sourceDigest) {
				throw new Error(`Retryable Memory capture source does not match its event state: ${capture.captureId}`);
			}
			const sourceId = source.sourceIds[0];
			if (sourceId) sourceIds.add(sourceId);
		}
		return sourceIds;
	}

	async captureStableSources(host: MemoryGenerationHost): Promise<MemoryCaptureResultV1[]> {
		if (!(await this.controller.getService().getConfig()).enabled) return [];
		await this.controller.resumePublications();
		let storedCursor = await this.currentCursor();
		if (!storedCursor) {
			await this.initialize();
			storedCursor = await this.currentCursor();
		}
		const originalCursor = storedCursor;
		const baseline = storedCursor ? await this.verifiedSourceCursor(storedCursor) : null;
		if (!baseline) return [];
		let cursor: MemorySourceCursorV2 = {
			...baseline,
			goals: { ...baseline.goals },
			chains: { ...baseline.chains },
		};
		const retryableSourceIds = await this.retryableSourceIds();
		const goalSources = await this.unseenGoalSources(cursor, retryableSourceIds);
		const rollups = await this.unseenRollups(cursor, retryableSourceIds);
		if (goalSources.length === 0 && rollups.length === 0) {
			if (
				stableJsonStringify({ goals: cursor.goals, chains: cursor.chains }) !==
					stableJsonStringify({ goals: baseline.goals, chains: baseline.chains }) ||
				originalCursor?.schema !== MEMORY_SOURCE_CURSOR_SCHEMA
			) {
				await this.writeCursor({ ...cursor, updatedAt: this.now() });
			}
			return [];
		}
		const results: MemoryCaptureResultV1[] = [];
		for (const source of goalSources) {
			results.push(
				await this.controller.capture(await this.canonicalGoalRequest(source.event, source.trigger), host),
			);
		}
		for (const source of rollups) results.push(await this.capturePublishedRollup(source, host));
		cursor = { ...cursor, updatedAt: this.now() };
		await this.writeCursor(cursor);
		return results;
	}

	private async capturedSourceIds(): Promise<Set<string>> {
		const readModel = (await this.controller.getService().getStore().loadReadModelSnapshot()).readModel;
		const sourceIds = new Set<string>();
		for (const capture of readModel.captures) {
			if (capture.status === "failed" && capture.retryable === true) continue;
			const stored = await this.artifacts.read(capture.sourceArtifactId);
			const source = validateMemoryCaptureSourceV1(JSON.parse(stored.content) as unknown);
			for (const sourceId of source.sourceIds) sourceIds.add(sourceId);
		}
		return sourceIds;
	}

	private async backfillSources(): Promise<EligibleSource[]> {
		const captured = await this.capturedSourceIds();
		const sources: EligibleSource[] = [];
		for (const goalId of await this.goalIds()) {
			const replay = await this.goals.loadGoal(goalId);
			const latestCheckpoint = [...replay.events]
				.reverse()
				.find((event) => eventSourceType(event) === "goal_checkpoint");
			for (const event of replay.events) {
				const sourceType = eventSourceType(event);
				if (
					!sourceType ||
					captured.has(event.eventId) ||
					(sourceType === "goal_checkpoint" && event.eventId !== latestCheckpoint?.eventId)
				) {
					continue;
				}
				try {
					sources.push({
						recordedAt: event.timestamp,
						request: await this.canonicalGoalRequest(event, "backfill"),
					});
				} catch (error) {
					if (error instanceof IneligibleGoalCheckpointSourceError) continue;
					throw error;
				}
			}
		}
		for (const chainId of await this.chainIds()) {
			const replay = await this.chains.replayChain(chainId);
			for (const branch of replay.branches) {
				for (const rollup of branch.rollups) {
					if (captured.has(rollup.eventId)) continue;
					sources.push({
						recordedAt: rollup.publishedAt,
						request: await this.canonicalRollupRequest(
							{
								chainId,
								branchId: branch.branchId,
								windowIndex: rollup.windowIndex,
								artifactId: rollup.artifactId,
							},
							"backfill",
						),
					});
				}
			}
		}
		return sources.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
	}

	async backfill(host: MemoryGenerationHost, limit = 1): Promise<MemoryCaptureResultV1[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory backfill limit must be 1 to 20");
		if (!(await this.controller.getService().getConfig()).enabled) {
			throw new Error("Memory is disabled and read-only");
		}
		const results: MemoryCaptureResultV1[] = [];
		for (const source of (await this.backfillSources()).slice(0, limit)) {
			results.push(await this.controller.capture(source.request, host));
		}
		return results;
	}

	private segmentPath(
		chainId: string,
		branchId: string,
		segment: { location: { kind: "managed"; fileName: string } | { kind: "external-root"; absolutePath: string } },
	): string {
		if (segment.location.kind === "external-root") return resolve(segment.location.absolutePath);
		const path = join(
			this.projectRoot,
			".pi-xk",
			"sessions",
			"chains",
			chainId,
			"branches",
			branchId,
			"segments",
			segment.location.fileName,
		);
		if (basename(path) !== segment.location.fileName || dirname(path) === path)
			throw new Error("Session Segment path is invalid");
		return path;
	}

	async refreshHistoryCues(options: { forceRebuild?: boolean } = {}): Promise<MemoryIndexHistoryCueV1[]> {
		const forceRebuild = options.forceRebuild ?? false;
		const persisted = await this.currentHistoryCueCursor(forceRebuild);
		const rebuildFromFacts = forceRebuild || persisted?.schema === MEMORY_HISTORY_CUE_CURSOR_V1_SCHEMA;
		const stored = rebuildFromFacts ? null : persisted;
		const cues = new Map((stored?.cues ?? []).map((cue) => [cue.cueId, cue]));
		const chains = { ...(stored?.chains ?? {}) };
		const segments = { ...(stored?.segments ?? {}) };
		const newCueIds = new Set<string>();
		const chainIds = await this.chainIds();
		if (!forceRebuild) {
			for (const chainId of Object.keys(chains)) {
				if (!chainIds.includes(chainId)) {
					throw new Error(`Memory history cue source chain is missing: ${chainId}`);
				}
			}
		}
		for (const chainId of chainIds) {
			const replay = await this.chains.replayChain(chainId);
			const previousHead = forceRebuild ? undefined : chains[chainId];
			if (previousHead) {
				if (replay.head.sequence < previousHead.sequence) {
					throw new Error(`Memory history cue chain moved backwards: ${chainId}`);
				}
				const previousEvent = replay.events.find((event) => event.sequence === previousHead.sequence);
				if (!previousEvent || previousEvent.hash !== previousHead.hash) {
					throw new Error(`Memory history cue chain cursor no longer matches its event log: ${chainId}`);
				}
				if (replay.head.sequence === previousHead.sequence && replay.head.hash === previousHead.hash) continue;
			}
			for (const branch of replay.branches) {
				for (const segment of branch.segments) {
					if (segment.status !== "sealed" || !segment.seal) continue;
					const segmentKey = historySegmentKey(chainId, branch.branchId, segment.segmentId);
					const previousSegment = forceRebuild ? undefined : segments[segmentKey];
					if (previousSegment) {
						if (
							previousSegment.chainId !== chainId ||
							previousSegment.branchId !== branch.branchId ||
							previousSegment.segmentId !== segment.segmentId ||
							previousSegment.summaryArtifactId !== segment.seal.summaryArtifactId
						) {
							throw new Error(
								`Memory history cue segment cursor no longer matches its seal: ${segment.segmentId}`,
							);
						}
						continue;
					}
					const summary = await this.chains.readSegmentSummary(segment.seal.summaryArtifactId);
					if (summary.schema === "pi-xk.segment-summary.v2") {
						const cue: MemoryIndexHistoryCueV1 = {
							cueId: historyCueId({ sourceType: "segment_summary", artifactId: segment.seal.summaryArtifactId }),
							sourceType: "segment_summary",
							sourceId: segment.seal.summaryArtifactId,
							title: summary.title,
							recordedAt: summary.generator.generatedAt,
							chainId,
							branchId: branch.branchId,
							segmentId: segment.segmentId,
							ordinal: segment.ordinal,
							sessionId: null,
						};
						cues.set(cue.cueId, cue);
						newCueIds.add(cue.cueId);
					}
					const manager = SessionManager.open(this.segmentPath(chainId, branch.branchId, segment));
					const sessionId = manager.getSessionId();
					for (const entry of manager.getEntries()) {
						if (entry.type !== "compaction" || !entry.title?.trim()) continue;
						const cue: MemoryIndexHistoryCueV1 = {
							cueId: historyCueId({ sourceType: "compaction", sessionId, entryId: entry.id }),
							sourceType: "compaction",
							sourceId: entry.id,
							title: entry.title,
							recordedAt: entry.timestamp,
							chainId,
							branchId: branch.branchId,
							segmentId: segment.segmentId,
							ordinal: segment.ordinal,
							sessionId,
						};
						cues.set(cue.cueId, cue);
						newCueIds.add(cue.cueId);
					}
					segments[segmentKey] = {
						chainId,
						branchId: branch.branchId,
						segmentId: segment.segmentId,
						summaryArtifactId: segment.seal.summaryArtifactId,
						sessionId,
					};
				}
			}
			chains[chainId] = replay.head;
		}
		const result = [...cues.values()].sort(
			(left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.cueId.localeCompare(right.cueId),
		);
		if (result.length > 0 || stored || forceRebuild) {
			await this.controller.getService().synchronizeHistoryCues(result, {
				newCueIds: [...newCueIds],
				forceRebuild: rebuildFromFacts || !stored,
			});
		}
		const cursorContent = { chains, segments, cues: result };
		const cursor: MemoryHistoryCueCursorV2 = {
			schema: MEMORY_HISTORY_CUE_CURSOR_SCHEMA,
			...cursorContent,
			contentDigest: historyCueContentDigest(cursorContent),
			updatedAt: this.now(),
		};
		if (!stored || stableJsonStringify(cursor) !== stableJsonStringify({ ...stored, updatedAt: cursor.updatedAt })) {
			await this.writeHistoryCueCursor(cursor);
		}
		return result;
	}
}
