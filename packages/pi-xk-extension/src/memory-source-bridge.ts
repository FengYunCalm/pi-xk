import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ArtifactStore,
	type GoalContract,
	type GoalEvent,
	GoalStore,
	inspectGoalFiles,
	type MemoryIndexHistoryCueV1,
	SessionChainStore,
	stableJsonStringify,
	validateGoalCompletionState,
	validateMemoryCaptureSourceV1,
} from "pi-xk-core";
import type {
	MemoryCaptureRequest,
	MemoryCaptureResultV1,
	MemoryController,
	MemoryGenerationHost,
} from "./memory-controller.ts";

const MEMORY_SOURCE_CURSOR_SCHEMA = "pi-xk.memory-source-cursors.v1";
const MEMORY_GOAL_SOURCE_SCHEMA = "pi-xk.memory-goal-source.v1";

interface MemoryCaptureControllerPort {
	getService(): ReturnType<MemoryController["getService"]>;
	capture(request: MemoryCaptureRequest, host: MemoryGenerationHost): Promise<MemoryCaptureResultV1>;
	resumePublications(): Promise<MemoryCaptureResultV1[]>;
}

interface MemorySourceCursorV1 {
	schema: typeof MEMORY_SOURCE_CURSOR_SCHEMA;
	goals: Record<string, number>;
	chains: Record<string, number>;
	updatedAt: string;
}

export interface PublishedRollupSourceV1 {
	chainId: string;
	branchId: string;
	windowIndex: number;
	artifactId: string;
}

interface EligibleSource {
	recordedAt: string;
	request: MemoryCaptureRequest;
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

function exactCursor(value: unknown): MemorySourceCursorV1 {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "chains,goals,schema,updatedAt") {
		throw new Error("Memory source cursor is invalid");
	}
	if (value.schema !== MEMORY_SOURCE_CURSOR_SCHEMA || !isRecord(value.goals) || !isRecord(value.chains)) {
		throw new Error("Memory source cursor is invalid");
	}
	const entries = (record: Record<string, unknown>, field: string): Record<string, number> => {
		const result: Record<string, number> = {};
		for (const [key, sequence] of Object.entries(record)) {
			if (!Number.isInteger(sequence) || Number(sequence) < 0)
				throw new Error(`Memory source cursor ${field} is invalid`);
			result[key] = Number(sequence);
		}
		return result;
	};
	if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
		throw new Error("Memory source cursor timestamp is invalid");
	}
	return {
		schema: MEMORY_SOURCE_CURSOR_SCHEMA,
		goals: entries(value.goals, "goals"),
		chains: entries(value.chains, "chains"),
		updatedAt: value.updatedAt,
	};
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
	private readonly controller: MemoryCaptureControllerPort;
	private readonly artifacts: ArtifactStore;
	private readonly goals: GoalStore;
	private readonly chains: SessionChainStore;
	private readonly now: () => string;
	private initialCursor: MemorySourceCursorV1 | null = null;

	constructor(options: {
		projectRoot: string;
		controller: MemoryCaptureControllerPort;
		now?: () => string;
	}) {
		this.projectRoot = resolve(options.projectRoot);
		this.memoryDirectory = join(this.projectRoot, ".pi-xk", "memory");
		this.cursorPath = join(this.memoryDirectory, "source-cursors.json");
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

	private async currentCursor(): Promise<MemorySourceCursorV1 | null> {
		try {
			return exactCursor(JSON.parse(await readFile(this.cursorPath, "utf8")) as unknown);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return null;
			throw error;
		}
	}

	private async writeCursor(cursor: MemorySourceCursorV1): Promise<void> {
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
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async factHeads(): Promise<Pick<MemorySourceCursorV1, "goals" | "chains">> {
		const goals: Record<string, number> = {};
		for (const goalId of await this.goalIds()) goals[goalId] = (await this.goals.loadGoal(goalId)).head.sequence;
		const chains: Record<string, number> = {};
		for (const chainId of await this.chainIds())
			chains[chainId] = (await this.chains.replayChain(chainId)).head.sequence;
		return { goals, chains };
	}

	async initialize(): Promise<void> {
		if (!(await this.controller.getService().getConfig()).enabled) return;
		if (await this.currentCursor()) {
			this.initialCursor = null;
			return;
		}
		const heads = await this.factHeads();
		this.initialCursor = { schema: MEMORY_SOURCE_CURSOR_SCHEMA, ...heads, updatedAt: this.now() };
	}

	private async canonicalGoalRequest(event: GoalEvent, trigger: "goal_checkpoint" | "goal_completion" | "backfill") {
		const replay = await this.goals.loadGoal(event.goalId);
		const contract = contractAtEvent(replay.events, event.sequence);
		if (stableJsonStringify(contract) !== stableJsonStringify(replay.contract)) {
			throw new Error(`Goal ${event.goalId} source contract is no longer current`);
		}
		const goalDirectory = join(this.projectRoot, ".pi-xk", "goals", event.goalId);
		const diagnostics = await inspectGoalFiles(goalDirectory, replay.contract);
		if (diagnostics.state.status !== "valid") {
			throw new Error(`Goal ${event.goalId} state is not valid: ${diagnostics.state.status}`);
		}
		const state = await readFile(diagnostics.state.path, "utf8");
		if (event.eventType === "goal_ended" && replay.contract.schema === "pi-xk.goal.contract.v3") {
			const payload = event.payload;
			const stateError = validateGoalCompletionState(state, replay.contract, {
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
			contractRevision: replay.contract.schema === "pi-xk.goal.contract.v3" ? replay.contract.revision : null,
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
			query: queryText([replay.contract.title, sourceType, state]),
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
		cursor: MemorySourceCursorV1,
	): Promise<Array<{ event: GoalEvent; trigger: "goal_checkpoint" | "goal_completion" }>> {
		const result: Array<{ event: GoalEvent; trigger: "goal_checkpoint" | "goal_completion" }> = [];
		for (const goalId of await this.goalIds()) {
			const replay = await this.goals.loadGoal(goalId);
			const latestCheckpoint = [...replay.events]
				.reverse()
				.find((event) => eventSourceType(event) === "goal_checkpoint");
			for (const event of replay.events) {
				if (event.sequence <= (cursor.goals[goalId] ?? 0)) continue;
				const trigger = eventSourceType(event);
				if (!trigger || (trigger === "goal_checkpoint" && event.eventId !== latestCheckpoint?.eventId)) continue;
				result.push({ event, trigger });
			}
			cursor.goals[goalId] = replay.head.sequence;
		}
		return result;
	}

	private async unseenRollups(cursor: MemorySourceCursorV1): Promise<PublishedRollupSourceV1[]> {
		const result: PublishedRollupSourceV1[] = [];
		for (const chainId of await this.chainIds()) {
			const replay = await this.chains.replayChain(chainId);
			for (const event of replay.events) {
				if (event.sequence <= (cursor.chains[chainId] ?? 0) || event.eventType !== "rollup_published") continue;
				result.push({
					chainId,
					branchId: event.payload.branchId,
					windowIndex: event.payload.windowIndex,
					artifactId: event.payload.artifactId,
				});
			}
			cursor.chains[chainId] = replay.head.sequence;
		}
		return result;
	}

	async captureStableSources(host: MemoryGenerationHost): Promise<MemoryCaptureResultV1[]> {
		if (!(await this.controller.getService().getConfig()).enabled) return [];
		await this.controller.resumePublications();
		const storedCursor = await this.currentCursor();
		if (!storedCursor && !this.initialCursor) await this.initialize();
		const baseline = storedCursor ?? this.initialCursor;
		if (!baseline) return [];
		let cursor: MemorySourceCursorV1 = {
			...baseline,
			goals: { ...baseline.goals },
			chains: { ...baseline.chains },
		};
		const goalSources = await this.unseenGoalSources(cursor);
		const rollups = await this.unseenRollups(cursor);
		if (!storedCursor && goalSources.length === 0 && rollups.length === 0) {
			this.initialCursor = { ...cursor, updatedAt: this.now() };
			return [];
		}
		if (!storedCursor) {
			await this.writeCursor({
				...baseline,
				goals: { ...baseline.goals },
				chains: { ...baseline.chains },
				updatedAt: this.now(),
			});
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
		this.initialCursor = null;
		return results;
	}

	private async capturedSourceIds(): Promise<Set<string>> {
		const replay = await this.controller.getService().getStore().replay();
		const sourceIds = new Set<string>();
		for (const capture of replay.captures.values()) {
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
				} catch {
					// Historical Goal state is not reconstructable after later revisions; skip it rather than inventing evidence.
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

	async refreshHistoryCues(): Promise<MemoryIndexHistoryCueV1[]> {
		const cues = new Map<string, MemoryIndexHistoryCueV1>();
		for (const chainId of await this.chainIds()) {
			const replay = await this.chains.replayChain(chainId);
			for (const branch of replay.branches) {
				for (const segment of branch.segments) {
					if (segment.status !== "sealed" || !segment.seal) continue;
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
					}
					const manager = SessionManager.open(this.segmentPath(chainId, branch.branchId, segment));
					for (const entry of manager.getEntries()) {
						if (entry.type !== "compaction" || !entry.title?.trim()) continue;
						const cue: MemoryIndexHistoryCueV1 = {
							cueId: historyCueId({
								sourceType: "compaction",
								sessionId: manager.getSessionId(),
								entryId: entry.id,
							}),
							sourceType: "compaction",
							sourceId: entry.id,
							title: entry.title,
							recordedAt: entry.timestamp,
							chainId,
							branchId: branch.branchId,
							segmentId: segment.segmentId,
							ordinal: segment.ordinal,
							sessionId: manager.getSessionId(),
						};
						cues.set(cue.cueId, cue);
					}
				}
			}
		}
		const result = [...cues.values()].sort(
			(left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.cueId.localeCompare(right.cueId),
		);
		this.controller.getService().setHistoryCues(result);
		return result;
	}
}
