import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ArtifactStore } from "./artifact-store.ts";
import { GoalStore } from "./goal-store.ts";
import {
	type EvidenceRefV1,
	MEMORY_CAPTURE_SOURCE_SCHEMA,
	MEMORY_CHANGE_PROPOSAL_SCHEMA,
	MEMORY_EVIDENCE_REF_SCHEMA,
	MEMORY_REVISION_SCHEMA,
	type MemoryAccessEventV1,
	type MemoryCaptureSourceV1,
	type MemoryChangeProposalV1,
	type MemoryKind,
	MemoryValidationError,
} from "./memory-contract.ts";
import { readGitEvidence, verifyGitEvidenceLocator } from "./memory-freshness.ts";
import type {
	MemoryHistoryCueCandidateV1,
	MemoryIndexCandidateV1,
	MemoryIndexHistoryCueV1,
	MemoryIndexRebuildChunkV1,
	MemoryIndexRebuildPlanV1,
	MemoryIndexStatusV1,
} from "./memory-index.ts";
import { MemoryIndexWorkerClient } from "./memory-index-worker-client.ts";
import {
	type MemoryMutationOptions,
	type MemoryPurgeResultV1,
	type MemoryReadModelV1,
	type MemoryReadResultV1,
	MemoryStore,
	type MemoryWriteResult,
} from "./memory-store.ts";
import { SessionChainStore } from "./session-chain-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";
import { TaskStore } from "./task-store.ts";

const MEMORY_CONFIG_SCHEMA = "pi-xk.memory-config.v1";
const EXPLICIT_MEMORY_PROMPT_VERSION = "pi-xk.memory-explicit.v1";
const MEMORY_INDEX_ENTITY_CHUNK_SIZE = 256;
const MEMORY_INDEX_EDGE_CHUNK_SIZE = 2_048;

export interface MemoryConfigV1 {
	enabled: boolean;
}

export interface MemoryRememberOptions {
	commandId: string;
	recordedAt?: string;
	kind?: MemoryKind;
	applicability?: string;
}

export interface MemorySearchInputV1 {
	query: string;
	kinds?: MemoryKind[];
	asOf?: string;
	includeHistoryCues?: boolean;
	cursor?: string;
	limit?: number;
	graphDepth?: 0 | 1 | 2;
}

export interface MemorySearchResultV1 {
	items: MemoryIndexCandidateV1[];
	historyCues: MemoryHistoryCueCandidateV1[];
	nextCursor: string | null;
}

export interface MemoryEvidenceExpansionV1 {
	memoryId: string;
	revision: number;
	evidence: Array<{
		evidenceId: string;
		sourceType: string;
		sourceId: string;
		historicalEvidence: true;
		content: string | null;
		unavailableReason: string | null;
	}>;
}

export interface MemoryServiceStatusV1 {
	enabled: boolean;
	head: { sequence: number; hash: string | null };
	indexState: "absent" | "current" | "rebuilt";
	index: MemoryIndexStatusV1 | null;
	captures: {
		scheduled: number;
		generating: number;
		failed: number;
		proposed: number;
		applied: number;
		rejected: number;
	};
	lock: Awaited<ReturnType<MemoryStore["inspectWriteLock"]>>;
}

export interface MemoryGraphResultV1 {
	rootMemoryId: string;
	depth: 1 | 2;
	nodes: Array<
		| { kind: "memory"; id: string; title: string; state: MemoryIndexCandidateV1["state"] }
		| { kind: "cue"; id: string; label: string; key: string }
	>;
	edges: Array<{
		edgeId: string;
		from: { kind: "memory" | "cue"; id: string };
		to: { kind: "memory" | "cue"; id: string };
		relation: string;
	}>;
}

export interface MemoryDoctorReportV1 {
	mode: "quick" | "deep";
	ok: boolean;
	diagnostics: Array<{ code: string; message: string; repairable: boolean }>;
	checked: {
		events: number;
		memories: number;
		cues: number;
		edges: number;
		artifacts: number;
		files: number;
		bytesRead: number;
	};
	durationMs: number;
}

interface MemoryCursorV1 {
	schema: "pi-xk.memory-search-cursor.v1";
	queryDigest: string;
	offset: number;
}

interface MemoryProjectionManifestEntryV1 {
	memoryId: string;
	revision: number;
	digest: string;
}

interface MemoryProjectionManifestV1 {
	schema: "pi-xk.memory-projection-manifest.v1";
	head: { sequence: number; hash: string | null };
	memoryCount: number;
	indexDigest: string;
	memories: MemoryProjectionManifestEntryV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function chainRollupSourceDigest(input: {
	chainId: string;
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	segmentIds: readonly string[];
	summaryArtifactIds: readonly string[];
}): string {
	return sha256(
		JSON.stringify({
			schema: "pi-xk.session-chain-rollup.v1",
			chainId: input.chainId,
			branchId: input.branchId,
			windowIndex: input.windowIndex,
			startOrdinal: input.startOrdinal,
			endOrdinal: input.endOrdinal,
			segments: input.segmentIds.map((segmentId, index) => ({
				segmentId,
				summaryArtifactId: input.summaryArtifactIds[index],
			})),
		}),
	);
}

function validateProjectionManifest(value: unknown): MemoryProjectionManifestV1 {
	if (!isRecord(value) || !exactKeys(value, ["schema", "head", "memoryCount", "indexDigest", "memories"])) {
		throw new MemoryValidationError("Memory projection manifest has unknown or missing fields");
	}
	if (value.schema !== "pi-xk.memory-projection-manifest.v1") {
		throw new MemoryValidationError("Memory projection manifest schema is unsupported");
	}
	if (!isRecord(value.head) || !exactKeys(value.head, ["sequence", "hash"])) {
		throw new MemoryValidationError("Memory projection manifest head is invalid");
	}
	if (
		typeof value.head.sequence !== "number" ||
		!Number.isInteger(value.head.sequence) ||
		value.head.sequence < 0 ||
		(value.head.hash !== null &&
			(typeof value.head.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.head.hash))) ||
		(value.head.sequence === 0) !== (value.head.hash === null)
	) {
		throw new MemoryValidationError("Memory projection manifest head is invalid");
	}
	if (typeof value.memoryCount !== "number" || !Number.isInteger(value.memoryCount) || value.memoryCount < 0) {
		throw new MemoryValidationError("Memory projection manifest memoryCount is invalid");
	}
	if (typeof value.indexDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.indexDigest)) {
		throw new MemoryValidationError("Memory projection manifest indexDigest is invalid");
	}
	if (!Array.isArray(value.memories) || value.memories.length !== value.memoryCount) {
		throw new MemoryValidationError("Memory projection manifest memories are invalid");
	}
	const memories = value.memories.map((entry, index): MemoryProjectionManifestEntryV1 => {
		if (!isRecord(entry) || !exactKeys(entry, ["memoryId", "revision", "digest"])) {
			throw new MemoryValidationError(`Memory projection manifest memories[${index}] is invalid`);
		}
		if (
			typeof entry.memoryId !== "string" ||
			entry.memoryId.trim().length === 0 ||
			typeof entry.revision !== "number" ||
			!Number.isInteger(entry.revision) ||
			entry.revision < 1 ||
			typeof entry.digest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(entry.digest)
		) {
			throw new MemoryValidationError(`Memory projection manifest memories[${index}] is invalid`);
		}
		return { memoryId: entry.memoryId, revision: entry.revision, digest: entry.digest };
	});
	if (new Set(memories.map((entry) => entry.memoryId)).size !== memories.length) {
		throw new MemoryValidationError("Memory projection manifest memory IDs must be unique");
	}
	return {
		schema: "pi-xk.memory-projection-manifest.v1",
		head: { sequence: value.head.sequence, hash: value.head.hash },
		memoryCount: value.memoryCount,
		indexDigest: value.indexDigest,
		memories,
	};
}

function safeSuffix(digest: string): string {
	return digest.slice("sha256:".length, "sha256:".length + 32);
}

function boundedText(value: string, field: string, maximum: number): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length === 0) throw new MemoryValidationError(`${field} must not be empty`);
	if ([...normalized].length > maximum) throw new MemoryValidationError(`${field} is too long`);
	return normalized;
}

function titleFor(text: string): string {
	const characters = [...text];
	return characters.length <= 120 ? text : `${characters.slice(0, 117).join("")}...`;
}

function cursorDigest(
	input: Pick<MemorySearchInputV1, "query" | "kinds" | "asOf" | "includeHistoryCues" | "graphDepth">,
): string {
	return sha256(stableJsonStringify(input));
}

function decodeCursor(cursor: string, expectedDigest: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
	} catch {
		throw new MemoryValidationError("Memory search cursor is invalid");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).sort().join(",") !== "offset,queryDigest,schema" ||
		!("schema" in parsed) ||
		parsed.schema !== "pi-xk.memory-search-cursor.v1" ||
		!("queryDigest" in parsed) ||
		parsed.queryDigest !== expectedDigest ||
		!("offset" in parsed) ||
		typeof parsed.offset !== "number" ||
		!Number.isInteger(parsed.offset) ||
		parsed.offset < 0 ||
		parsed.offset > 200
	) {
		throw new MemoryValidationError("Memory search cursor is invalid or belongs to another query");
	}
	return parsed.offset;
}

function encodeCursor(queryDigest: string, offset: number): string {
	const cursor: MemoryCursorV1 = { schema: "pi-xk.memory-search-cursor.v1", queryDigest, offset };
	return Buffer.from(stableJsonStringify(cursor), "utf8").toString("base64url");
}

export class MemoryService {
	private readonly projectRoot: string;
	private readonly memoryDirectory: string;
	private readonly configPath: string;
	private readonly indexPath: string;
	private readonly store: MemoryStore;
	private readonly artifacts: ArtifactStore;
	private index: MemoryIndexWorkerClient | undefined;
	private historyCues: MemoryIndexHistoryCueV1[] = [];
	private historyGeneration = 0;
	private indexedHistoryGeneration = -1;
	private lastIndexState: MemoryServiceStatusV1["indexState"] = "absent";
	private projectionQueue: Promise<void> = Promise.resolve();

	constructor(projectRoot: string, store = new MemoryStore(projectRoot)) {
		this.projectRoot = resolve(projectRoot);
		this.memoryDirectory = join(this.projectRoot, ".pi-xk", "memory");
		this.configPath = join(this.memoryDirectory, "memory-config.json");
		this.indexPath = join(this.memoryDirectory, "index.sqlite");
		this.store = store;
		this.artifacts = new ArtifactStore(this.projectRoot);
	}

	getStore(): MemoryStore {
		return this.store;
	}

	async getConfig(): Promise<MemoryConfigV1> {
		try {
			const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed) ||
				Object.keys(parsed).sort().join(",") !== "enabled,schema" ||
				!("schema" in parsed) ||
				parsed.schema !== MEMORY_CONFIG_SCHEMA ||
				!("enabled" in parsed) ||
				typeof parsed.enabled !== "boolean"
			) {
				throw new MemoryValidationError("Memory config is invalid");
			}
			return { enabled: parsed.enabled };
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				return { enabled: true };
			}
			throw error;
		}
	}

	private async replaceFile(path: string, content: string): Promise<void> {
		await mkdir(this.memoryDirectory, { recursive: true });
		const temporary = join(this.memoryDirectory, `.${basename(path)}-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await syncDirectory(this.memoryDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async setConfig(config: MemoryConfigV1): Promise<void> {
		if (typeof config.enabled !== "boolean") throw new MemoryValidationError("Memory config enabled must be boolean");
		await this.replaceFile(
			this.configPath,
			`${JSON.stringify({ schema: MEMORY_CONFIG_SCHEMA, enabled: config.enabled }, null, "\t")}\n`,
		);
	}

	private async assertWritable(): Promise<void> {
		if (!(await this.getConfig()).enabled) {
			throw new MemoryValidationError("Memory is disabled and read-only");
		}
	}

	setHistoryCues(cues: readonly MemoryIndexHistoryCueV1[]): void {
		const next = [...cues].sort((left, right) => left.cueId.localeCompare(right.cueId));
		if (stableJsonStringify(next) === stableJsonStringify(this.historyCues)) return;
		this.historyCues = next;
		this.historyGeneration += 1;
	}

	private withProjectionOperation<T>(operation: () => Promise<T>): Promise<T> {
		const current = this.projectionQueue.then(operation, operation);
		this.projectionQueue = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}

	private indexRebuildPlan(
		readModel: MemoryReadModelV1,
		historyCues: readonly MemoryIndexHistoryCueV1[],
	): MemoryIndexRebuildPlanV1 {
		return {
			head: readModel.head,
			memoryCount: readModel.memories.length,
			cueCount: readModel.cues.length,
			edgeCount: readModel.edges.length,
			historyCueCount: historyCues.length,
		};
	}

	private async *indexRebuildChunks(
		readModel: MemoryReadModelV1,
		historyCues: readonly MemoryIndexHistoryCueV1[],
	): AsyncGenerator<MemoryIndexRebuildChunkV1> {
		let accessIndex = 0;
		const cueExists = (cueId: string): boolean => {
			let lower = 0;
			let upper = readModel.cues.length - 1;
			while (lower <= upper) {
				const middle = Math.floor((lower + upper) / 2);
				const comparison = readModel.cues[middle]!.cueId.localeCompare(cueId);
				if (comparison === 0) return true;
				if (comparison < 0) lower = middle + 1;
				else upper = middle - 1;
			}
			return false;
		};
		for (let offset = 0; offset < readModel.memories.length; offset += MEMORY_INDEX_ENTITY_CHUNK_SIZE) {
			const references = readModel.memories.slice(offset, offset + MEMORY_INDEX_ENTITY_CHUNK_SIZE);
			const memories = await this.store.readMemoriesByReferences(references, cueExists);
			yield {
				memories: memories.map((memory) => {
					const access = readModel.accesses[accessIndex];
					if (access && access.memoryId.localeCompare(memory.revision.memoryId) < 0) {
						throw new MemoryValidationError("Memory access projection ordering is inconsistent");
					}
					const matchingAccess = access?.memoryId === memory.revision.memoryId ? access : undefined;
					if (matchingAccess) accessIndex += 1;
					return {
						memoryId: memory.revision.memoryId,
						revision: memory.revision.revision,
						artifactId: memory.artifactId,
						kind: memory.revision.kind,
						title: memory.revision.title,
						statement: memory.revision.statement,
						applicability: memory.revision.applicability,
						trust: memory.state.trust,
						freshness: memory.state.freshness,
						lifecycle: memory.state.lifecycle,
						effectiveFrom: memory.revision.effectiveFrom,
						effectiveTo: memory.revision.effectiveTo,
						recordedAt: memory.revision.provenance.recordedAt,
						sourceDigest: memory.revision.sourceDigest,
						evidenceIds: memory.revision.evidenceRefs.map((evidence) => evidence.evidenceId),
						accessCount: matchingAccess?.accessCount ?? 0,
						lastAccessedAt: matchingAccess?.lastAccessedAt ?? null,
					};
				}),
				cues: [],
				edges: [],
				historyCues: [],
			};
		}
		if (accessIndex !== readModel.accesses.length) {
			throw new MemoryValidationError("Memory access projection references an unindexed Memory");
		}
		for (let offset = 0; offset < readModel.cues.length; offset += MEMORY_INDEX_ENTITY_CHUNK_SIZE) {
			const cues = await this.store.readCuesByReferences(
				readModel.cues.slice(offset, offset + MEMORY_INDEX_ENTITY_CHUNK_SIZE),
			);
			yield {
				memories: [],
				cues: cues.map(({ cue, artifactId }) => ({
					cueId: cue.cueId,
					revision: cue.revision,
					artifactId,
					kind: cue.kind,
					key: cue.key,
					label: cue.label,
					aliases: cue.aliases,
				})),
				edges: [],
				historyCues: [],
			};
		}
		for (let offset = 0; offset < readModel.edges.length; offset += MEMORY_INDEX_EDGE_CHUNK_SIZE) {
			const edges = await this.store.readEdgesByReferences(
				readModel.edges.slice(offset, offset + MEMORY_INDEX_EDGE_CHUNK_SIZE),
			);
			yield {
				memories: [],
				cues: [],
				edges: edges.map(({ edge, artifactId }) => ({
					edgeId: edge.edgeId,
					artifactId,
					fromKind: edge.from.kind,
					fromId: edge.from.id,
					toKind: edge.to.kind,
					toId: edge.to.id,
					relation: edge.relation,
				})),
				historyCues: [],
			};
		}
		for (let offset = 0; offset < historyCues.length; offset += MEMORY_INDEX_ENTITY_CHUNK_SIZE) {
			yield {
				memories: [],
				cues: [],
				edges: [],
				historyCues: historyCues.slice(offset, offset + MEMORY_INDEX_ENTITY_CHUNK_SIZE),
			};
		}
	}

	private async existingIndexMatches(readModel: MemoryReadModelV1): Promise<boolean> {
		try {
			await stat(this.indexPath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
		const candidate = new MemoryIndexWorkerClient({ databasePath: this.indexPath });
		try {
			const [status, integrity] = await Promise.all([candidate.status(), candidate.integrityCheck()]);
			if (
				integrity === "ok" &&
				status.head.sequence === readModel.head.sequence &&
				status.head.hash === readModel.head.hash &&
				status.memoryCount === readModel.memories.length &&
				status.cueCount === readModel.cues.length &&
				status.edgeCount === readModel.edges.length &&
				status.historyCueCount === 0 &&
				this.historyGeneration === 0
			) {
				this.index = candidate;
				this.indexedHistoryGeneration = 0;
				this.lastIndexState = "current";
				return true;
			}
		} catch {
			// A corrupt or unsupported projection is rebuilt from facts below.
		}
		await candidate.close();
		return false;
	}

	private async rebuildIndex(readModel: MemoryReadModelV1): Promise<void> {
		await this.index?.close();
		this.index = undefined;
		await mkdir(this.memoryDirectory, { recursive: true });
		const temporaryPath = join(this.memoryDirectory, `.index-${randomUUID()}.sqlite`);
		const historyCues = this.historyCues;
		const historyGeneration = this.historyGeneration;
		let builder: MemoryIndexWorkerClient | undefined;
		try {
			builder = new MemoryIndexWorkerClient({ databasePath: temporaryPath });
			try {
				const plan = this.indexRebuildPlan(readModel, historyCues);
				await builder.rebuildFromChunks(plan, this.indexRebuildChunks(readModel, historyCues));
				if ((await builder.integrityCheck()) !== "ok")
					throw new MemoryValidationError("Memory index rebuild failed integrity check");
				const status = await builder.status();
				if (
					status.head.sequence !== plan.head.sequence ||
					status.head.hash !== plan.head.hash ||
					status.memoryCount !== plan.memoryCount ||
					status.cueCount !== plan.cueCount ||
					status.edgeCount !== plan.edgeCount ||
					status.historyCueCount !== plan.historyCueCount
				) {
					throw new MemoryValidationError("Memory index rebuild metadata does not match Memory facts");
				}
			} finally {
				await builder.close();
				builder = undefined;
			}
			await rename(temporaryPath, this.indexPath);
			await syncDirectory(this.memoryDirectory);
		} finally {
			await builder?.close().catch(() => {});
			await rm(temporaryPath, { force: true });
			await rm(`${temporaryPath}-wal`, { force: true });
			await rm(`${temporaryPath}-shm`, { force: true });
		}
		this.index = new MemoryIndexWorkerClient({ databasePath: this.indexPath });
		this.indexedHistoryGeneration = historyGeneration;
		this.lastIndexState = "rebuilt";
	}

	private async ensureIndex(): Promise<{ index: MemoryIndexWorkerClient; readModel: MemoryReadModelV1 }> {
		let rebuilt = false;
		while (true) {
			const readModel = (await this.store.loadReadModelSnapshot()).readModel;
			if (this.index) {
				try {
					const status = await this.index.status();
					if (
						status.head.sequence === readModel.head.sequence &&
						status.head.hash === readModel.head.hash &&
						status.memoryCount === readModel.memories.length &&
						status.cueCount === readModel.cues.length &&
						status.edgeCount === readModel.edges.length &&
						status.historyCueCount === this.historyCues.length &&
						this.indexedHistoryGeneration === this.historyGeneration &&
						(await this.index.integrityCheck()) === "ok"
					) {
						if (!rebuilt) this.lastIndexState = "current";
						return { index: this.index, readModel };
					}
				} catch {
					// Rebuild the disposable projection below.
				}
			}
			if (!this.index && (await this.existingIndexMatches(readModel))) continue;
			await this.rebuildIndex(readModel);
			rebuilt = true;
		}
	}

	async remember(textInput: string, options: MemoryRememberOptions): Promise<MemoryReadResultV1> {
		await this.assertWritable();
		const text = boundedText(textInput, "Memory text", 16_384);
		const commandId = boundedText(options.commandId, "Memory commandId", 160);
		const recordedAt = options.recordedAt ?? new Date().toISOString();
		if (Number.isNaN(Date.parse(recordedAt)))
			throw new MemoryValidationError("Memory recordedAt must be an ISO timestamp");
		const evidenceArtifact = await this.artifacts.put({
			contentType: "text/plain",
			text,
			producer: EXPLICIT_MEMORY_PROMPT_VERSION,
			sensitivity: "internal",
			sourceIds: [commandId],
			createdAt: recordedAt,
		});
		const canonicalEvidence = await this.artifacts.read(evidenceArtifact.artifactId);
		if (
			canonicalEvidence.metadata.contentType !== "text/plain" ||
			canonicalEvidence.metadata.producer !== EXPLICIT_MEMORY_PROMPT_VERSION ||
			!canonicalEvidence.metadata.sourceIds.includes(commandId)
		) {
			throw new MemoryValidationError("Explicit Memory artifact failed canonical read-back validation");
		}
		const canonicalText = boundedText(canonicalEvidence.content, "Canonical Memory text", 16_384);
		const sourceDigest = evidenceArtifact.artifactId;
		const suffix = safeSuffix(sourceDigest);
		const captureId = `capture_${suffix}`;
		const replay = await this.store.replay();
		const existingCapture = replay.captures.get(captureId);
		if (existingCapture) {
			if (existingCapture.status !== "applied") {
				throw new MemoryValidationError(`Explicit Memory capture requires recovery: ${existingCapture.status}`);
			}
			const existingMemory = [...replay.memories.values()].find((memory) => memory.sourceDigest === sourceDigest);
			if (!existingMemory) throw new MemoryValidationError("Applied explicit Memory capture has no Memory revision");
			return await this.store.readMemory(existingMemory.memoryId);
		}
		const source: MemoryCaptureSourceV1 = {
			schema: MEMORY_CAPTURE_SOURCE_SCHEMA,
			captureId,
			trigger: "explicit",
			sourceIds: [commandId, evidenceArtifact.artifactId],
			sourceDigest,
			promptVersion: EXPLICIT_MEMORY_PROMPT_VERSION,
			createdAt: recordedAt,
		};
		const scheduled = await this.store.scheduleCapture(source, {
			eventId: `evt_memory_schedule_${suffix}`,
			idempotencyKey: `memory:schedule:${captureId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: recordedAt,
		});
		const memoryId = `memory_${suffix}`;
		const evidenceId = `evidence_${suffix}`;
		const proposal: MemoryChangeProposalV1 = {
			schema: MEMORY_CHANGE_PROPOSAL_SCHEMA,
			proposalId: `proposal_${suffix}`,
			captureId,
			sourceDigest,
			expectedEventHead: scheduled.head,
			expectedRevisions: [],
			reason: "Store the user's explicit project memory without semantic transformation.",
			operations: [
				{
					kind: "publish_revision",
					revision: {
						schema: MEMORY_REVISION_SCHEMA,
						memoryId,
						revision: 1,
						kind: options.kind ?? "fact",
						title: titleFor(canonicalText),
						statement: canonicalText,
						applicability: options.applicability ?? "Current Pi-XK project",
						trust: "verified",
						lifecycle: "active",
						effectiveFrom: recordedAt,
						effectiveTo: null,
						cueIds: [],
						evidenceRefs: [
							{
								schema: MEMORY_EVIDENCE_REF_SCHEMA,
								evidenceId,
								sourceType: "explicit",
								sourceId: commandId,
								artifactId: evidenceArtifact.artifactId,
								sourceDigest,
								recordedAt,
								locator: { commandId },
							},
						],
						freshnessBasis: null,
						sourceDigest,
						supersedesRevision: null,
						provenance: { producer: "user", model: null, promptVersion: null, recordedAt },
					},
				},
			],
			provenance: { producer: "user", model: null, promptVersion: null, recordedAt },
		};
		const resultArtifact = await this.artifacts.put({
			contentType: "application/json",
			value: { schema: "pi-xk.memory-explicit-result.v1", proposal },
			producer: EXPLICIT_MEMORY_PROMPT_VERSION,
			sensitivity: "internal",
			sourceIds: [captureId, evidenceArtifact.artifactId],
			createdAt: recordedAt,
		});
		const recorded = await this.store.recordProposal(proposal, resultArtifact.artifactId, {
			eventId: `evt_memory_proposal_${suffix}`,
			idempotencyKey: `memory:proposal:${proposal.proposalId}`,
			expectedHead: scheduled.head,
			actor: "user",
			timestamp: recordedAt,
		});
		const applied = await this.store.applyProposal(recorded.proposalArtifactId, {
			eventId: `evt_memory_apply_${suffix}`,
			idempotencyKey: `memory:apply:${proposal.proposalId}`,
			expectedHead: recorded.write.head,
			actor: "user",
			timestamp: recordedAt,
			confirmed: true,
		});
		try {
			await this.repairProjections();
		} catch (error) {
			try {
				await this.store.markCaptureFailed(
					{
						captureId,
						stage: "projection",
						errorCode: "memory_projection_failed",
						retryable: true,
						message: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
					},
					{
						eventId: `evt_memory_projection_${suffix}`,
						idempotencyKey: `memory:projection:${captureId}`,
						expectedHead: applied.write.head,
						actor: "runtime",
						timestamp: recordedAt,
					},
				);
			} catch {
				// The Memory fact is committed; doctor can still detect and rebuild incomplete projections.
			}
		}
		return await this.store.readMemory(memoryId);
	}

	async search(input: MemorySearchInputV1): Promise<MemorySearchResultV1> {
		const query = boundedText(input.query, "Memory search query", 2048);
		const limit = input.limit ?? 12;
		if (!Number.isInteger(limit) || limit < 1 || limit > 50)
			throw new MemoryValidationError("Memory search limit must be 1 to 50");
		const digest = cursorDigest({
			query,
			...(input.kinds ? { kinds: input.kinds } : {}),
			...(input.asOf ? { asOf: input.asOf } : {}),
			...(input.includeHistoryCues ? { includeHistoryCues: true } : {}),
			graphDepth: input.graphDepth ?? 1,
		});
		const offset = input.cursor ? decodeCursor(input.cursor, digest) : 0;
		const result = await this.withProjectionOperation(async () => {
			const { index } = await this.ensureIndex();
			return await index.search({
				query,
				...(input.kinds ? { kinds: input.kinds } : {}),
				...(input.asOf ? { asOf: input.asOf } : {}),
				...(input.includeHistoryCues ? { includeHistoryCues: true } : {}),
				limit,
				offset,
				graphDepth: input.graphDepth ?? 1,
			});
		});
		return {
			items: result.memories,
			historyCues: result.historyCues,
			nextCursor:
				result.memories.length === limit || result.historyCues.length === limit
					? encodeCursor(digest, offset + limit)
					: null,
		};
	}

	async read(input: { memoryIds: readonly string[]; asOf?: string }): Promise<{ memories: MemoryReadResultV1[] }> {
		if (
			input.memoryIds.length < 1 ||
			input.memoryIds.length > 5 ||
			new Set(input.memoryIds).size !== input.memoryIds.length
		) {
			throw new MemoryValidationError("Memory read requires 1 to 5 unique memory IDs");
		}
		const memories = await this.store.readMemories(input.memoryIds);
		for (const memory of memories) {
			for (const evidence of memory.revision.evidenceRefs) await this.validateEvidenceOwnership(evidence);
		}
		if (input.asOf) {
			const asOf = Date.parse(input.asOf);
			if (Number.isNaN(asOf)) throw new MemoryValidationError("Memory asOf must be an ISO timestamp");
			for (const memory of memories) {
				if (
					asOf < Date.parse(memory.revision.effectiveFrom) ||
					(memory.revision.effectiveTo !== null && asOf >= Date.parse(memory.revision.effectiveTo))
				) {
					throw new MemoryValidationError(`Memory is not effective at asOf: ${memory.revision.memoryId}`);
				}
			}
		}
		return { memories };
	}

	async expandEvidence(input: {
		memoryId: string;
		revision?: number;
		evidenceIds?: readonly string[];
	}): Promise<MemoryEvidenceExpansionV1> {
		const memory = await this.store.readMemory(input.memoryId);
		for (const evidence of memory.revision.evidenceRefs) await this.validateEvidenceOwnership(evidence);
		if (input.revision !== undefined && input.revision !== memory.revision.revision) {
			throw new MemoryValidationError("Historical revision expansion requires the timeline API");
		}
		const selected = input.evidenceIds
			? memory.revision.evidenceRefs.filter((evidence) => input.evidenceIds?.includes(evidence.evidenceId))
			: memory.revision.evidenceRefs;
		if (selected.length > 3) throw new MemoryValidationError("Memory evidence expansion is limited to 3 items");
		if (input.evidenceIds && selected.length !== input.evidenceIds.length) {
			throw new MemoryValidationError("Memory evidence selection contains an unrelated evidence ID");
		}
		const evidence: MemoryEvidenceExpansionV1["evidence"] = [];
		for (const reference of selected) {
			let content: string | null = null;
			let unavailableReason: string | null = null;
			if (reference.artifactId) content = (await this.artifacts.read(reference.artifactId)).content;
			else if (reference.sourceType === "compaction") {
				content = stableJsonStringify(await this.resolveCompactionEvidence(reference));
			} else if (reference.sourceType === "git")
				content = await readGitEvidence(this.projectRoot, reference.locator);
			else unavailableReason = "Evidence has no Artifact Store object and must be resolved by its source domain.";
			evidence.push({
				evidenceId: reference.evidenceId,
				sourceType: reference.sourceType,
				sourceId: reference.sourceId,
				historicalEvidence: true,
				content,
				unavailableReason,
			});
		}
		return { memoryId: memory.revision.memoryId, revision: memory.revision.revision, evidence };
	}

	async timeline(
		memoryId: string,
	): Promise<{ memoryId: string; revisions: Awaited<ReturnType<MemoryStore["readMemoryTimeline"]>> }> {
		return { memoryId, revisions: await this.store.readMemoryTimeline(memoryId) };
	}

	async graph(memoryId: string, depth: 1 | 2 = 1): Promise<MemoryGraphResultV1> {
		if (depth !== 1 && depth !== 2) throw new MemoryValidationError("Memory graph depth must be 1 or 2");
		await this.store.readMemory(memoryId);
		const allEdges = await this.store.readEdges();
		let frontier = new Set([`memory:${memoryId}`]);
		const nodes = new Set(frontier);
		const selectedEdges = new Map<string, (typeof allEdges)[number]>();
		for (let level = 0; level < depth; level++) {
			const next = new Set<string>();
			for (const edge of allEdges) {
				const from = `${edge.edge.from.kind}:${edge.edge.from.id}`;
				const to = `${edge.edge.to.kind}:${edge.edge.to.id}`;
				if (!frontier.has(from) && !frontier.has(to)) continue;
				selectedEdges.set(edge.edge.edgeId, edge);
				nodes.add(from);
				nodes.add(to);
				next.add(from);
				next.add(to);
			}
			frontier = next;
		}
		const memoryIds = [...nodes]
			.filter((node) => node.startsWith("memory:"))
			.map((node) => node.slice("memory:".length));
		const cueIds = [...nodes].filter((node) => node.startsWith("cue:")).map((node) => node.slice("cue:".length));
		const [memories, cues] = await Promise.all([this.store.readMemories(memoryIds), this.store.readCues(cueIds)]);
		return {
			rootMemoryId: memoryId,
			depth,
			nodes: [
				...memories.map((memory) => ({
					kind: "memory" as const,
					id: memory.revision.memoryId,
					title: memory.revision.title,
					state: memory.state,
				})),
				...cues.map(({ cue }) => ({ kind: "cue" as const, id: cue.cueId, label: cue.label, key: cue.key })),
			],
			edges: [...selectedEdges.values()].map(({ edge }) => ({
				edgeId: edge.edgeId,
				from: edge.from,
				to: edge.to,
				relation: edge.relation,
			})),
		};
	}

	async refresh(memoryId: string): Promise<MemoryReadResultV1> {
		await this.store.readMemory(memoryId);
		await this.withProjectionOperation(async () => {
			await this.rebuildIndex((await this.store.loadReadModelSnapshot()).readModel);
			await this.ensureIndex();
		});
		return await this.store.readMemory(memoryId);
	}

	async changeLifecycle(
		memoryId: string,
		lifecycle: "archived" | "invalidated",
		reason: string,
	): Promise<MemoryReadResultV1> {
		await this.assertWritable();
		const memory = await this.store.readMemory(memoryId);
		const replay = await this.store.replay();
		const operationId = randomUUID().replaceAll("-", "");
		await this.store.changeMemoryLifecycle(memoryId, memory.revision.revision, lifecycle, reason, {
			eventId: `evt_memory_lifecycle_${operationId}`,
			idempotencyKey: `memory:lifecycle:${operationId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: new Date().toISOString(),
			confirmed: true,
		});
		return await this.store.readMemory(memoryId);
	}

	async detachEvidence(memoryId: string, evidenceId: string, reason: string): Promise<MemoryReadResultV1> {
		await this.assertWritable();
		const memory = await this.store.readMemory(memoryId);
		const replay = await this.store.replay();
		const operationId = randomUUID().replaceAll("-", "");
		await this.store.detachMemoryEvidence(memoryId, memory.revision.revision, evidenceId, reason, {
			eventId: `evt_memory_detach_${operationId}`,
			idempotencyKey: `memory:detach:${operationId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: new Date().toISOString(),
			confirmed: true,
		});
		return await this.store.readMemory(memoryId);
	}

	async purge(memoryId: string, reason: string): Promise<MemoryPurgeResultV1> {
		await this.assertWritable();
		const memory = await this.store.readMemory(memoryId);
		const replay = await this.store.replay();
		const operationId = randomUUID().replaceAll("-", "");
		return await this.store.purgeMemory(memoryId, memory.revision.revision, reason, {
			eventId: `evt_memory_purge_${operationId}`,
			idempotencyKey: `memory:purge:${operationId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: new Date().toISOString(),
			confirmed: true,
		});
	}

	async recordAccess(
		access: MemoryAccessEventV1,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"access_recorded"> | null> {
		if (!(await this.getConfig()).enabled) return null;
		return await this.withProjectionOperation(async () => {
			let updateIndex = false;
			if (this.index) {
				try {
					const status = await this.index.status();
					updateIndex =
						status.head.sequence === options.expectedHead.sequence &&
						status.head.hash === options.expectedHead.hash;
				} catch {
					await this.index.close().catch(() => {});
					this.index = undefined;
				}
			}
			const write = await this.store.recordAccess(access, options);
			if (this.index && updateIndex) {
				try {
					await this.index.recordAccess(access.memoryIds, write.event.timestamp, write.head);
					this.lastIndexState = "current";
				} catch {
					await this.index.close().catch(() => {});
					this.index = undefined;
					this.lastIndexState = "absent";
				}
			}
			return write;
		});
	}

	private async resolveCompactionEvidence(
		evidence: Extract<EvidenceRefV1, { sourceType: "compaction" }>,
	): Promise<Record<string, unknown>> {
		const invalid = (message: string): never => {
			throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} ${message}`);
		};
		const chains = new SessionChainStore(this.projectRoot);
		for (const chain of await chains.listChains()) {
			const replay = await chains.replayChain(chain.chainId);
			for (const branch of replay.branches) {
				for (const segment of branch.segments) {
					if (segment.segmentId !== evidence.locator.sessionId) continue;
					const path =
						segment.location.kind === "external-root"
							? resolve(segment.location.absolutePath)
							: join(
									this.projectRoot,
									".pi-xk",
									"sessions",
									"chains",
									chain.chainId,
									"branches",
									branch.branchId,
									"segments",
									segment.location.fileName,
								);
					let raw: string;
					try {
						raw = await readFile(path, "utf8");
					} catch (error) {
						if (isRecord(error) && error.code === "ENOENT") {
							invalid("Session compaction source file is missing");
						}
						throw error;
					}
					let sessionHeaderMatches = false;
					let compaction: Record<string, unknown> | undefined;
					for (const line of raw.split("\n")) {
						if (!line) continue;
						let entry: unknown;
						try {
							entry = JSON.parse(line) as unknown;
						} catch {
							invalid("Session compaction source JSONL is malformed");
						}
						if (!isRecord(entry)) continue;
						if (entry.type === "session" && entry.id === evidence.locator.sessionId) {
							sessionHeaderMatches = true;
						}
						if (
							entry.type === "compaction" &&
							entry.id === evidence.locator.entryId &&
							entry.title === evidence.locator.title
						) {
							compaction = entry;
						}
					}
					if (!sessionHeaderMatches) invalid("does not match its Session header");
					if (evidence.sourceId !== evidence.locator.entryId && evidence.sourceId !== evidence.locator.sessionId) {
						invalid("does not match a Session compaction entry");
					}
					return compaction ?? invalid("does not match a Session compaction entry");
				}
			}
		}
		return invalid("does not match a Session compaction entry");
	}

	private async validateEvidenceOwnership(evidence: EvidenceRefV1): Promise<void> {
		const invalid = (message: string): never => {
			throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} ${message}`);
		};
		if (evidence.sourceType === "explicit") {
			if (evidence.sourceId !== evidence.locator.commandId) invalid("does not match its explicit command");
			const artifactId = evidence.artifactId;
			if (!artifactId) {
				throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no explicit artifact`);
			}
			const artifact = await this.artifacts.read(artifactId);
			if (
				evidence.sourceDigest !== artifactId ||
				artifact.metadata.contentType !== "text/plain" ||
				artifact.metadata.producer !== EXPLICIT_MEMORY_PROMPT_VERSION ||
				!artifact.metadata.sourceIds.includes(evidence.locator.commandId)
			) {
				invalid("artifact is not owned by its explicit command");
			}
			return;
		}
		if (evidence.sourceType === "goal_checkpoint" || evidence.sourceType === "goal_completion") {
			const goalId = evidence.locator.goalId;
			const eventId =
				evidence.sourceType === "goal_checkpoint" ? evidence.locator.checkpointEventId : evidence.locator.eventId;
			const replay = await new GoalStore(this.projectRoot).replayGoal(goalId);
			const event = replay.events.find((candidate) => candidate.eventId === eventId);
			if (!event) throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no Goal event`);
			if (evidence.sourceId !== eventId) invalid("does not match its Goal event");
			if (
				(evidence.sourceType === "goal_checkpoint" && event.eventType !== "goal_checkpointed") ||
				(evidence.sourceType === "goal_completion" && event.eventType !== "goal_ended")
			) {
				invalid("has the wrong Goal event type");
			}
			const artifactId = evidence.artifactId;
			if (!artifactId) {
				throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no Goal source artifact`);
			}
			const stored = await this.artifacts.read(artifactId);
			if (
				evidence.sourceDigest !== artifactId ||
				stored.metadata.contentType !== "application/json" ||
				stored.metadata.producer !== "pi-xk.memory-goal-source.v1" ||
				!stored.metadata.sourceIds.includes(goalId) ||
				!stored.metadata.sourceIds.includes(eventId)
			) {
				invalid("Goal source artifact metadata or digest is invalid");
			}
			let source: unknown;
			try {
				source = JSON.parse(stored.content) as unknown;
			} catch {
				invalid("Goal source artifact is not JSON");
			}
			if (!isRecord(source)) {
				throw new MemoryValidationError(
					`Memory evidence ${evidence.evidenceId} Goal source artifact schema is invalid`,
				);
			}
			if (!exactKeys(source, ["schema", "goalId", "contractRevision", "event", "state"])) {
				invalid("Goal source artifact schema is invalid");
			}
			let contractRevision: number | null = null;
			for (const candidate of replay.events) {
				if (candidate.sequence > event.sequence) break;
				if (candidate.eventType === "goal_created" || candidate.eventType === "goal_contract_updated") {
					contractRevision =
						candidate.payload.contract.schema === "pi-xk.goal.contract.v3"
							? candidate.payload.contract.revision
							: null;
				}
			}
			if (
				source.schema !== "pi-xk.memory-goal-source.v1" ||
				source.goalId !== goalId ||
				source.contractRevision !== contractRevision ||
				typeof source.state !== "string" ||
				stableJsonStringify(source.event) !== stableJsonStringify(event)
			) {
				invalid("Goal source artifact does not preserve the located event");
			}
			return;
		}
		if (evidence.sourceType === "chain_summary") {
			const locator = evidence.locator;
			const chains = new SessionChainStore(this.projectRoot);
			const replay = await chains.replayChain(locator.chainId);
			const branch = replay.branches.find((candidate) => candidate.branchId === locator.branchId);
			if (!branch) {
				throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no Session Chain branch`);
			}
			const artifactId = evidence.artifactId;
			if (!artifactId) {
				throw new MemoryValidationError(
					`Memory evidence ${evidence.evidenceId} has no Session Chain summary artifact`,
				);
			}
			if (evidence.sourceDigest !== artifactId) invalid("summary sourceDigest does not match its artifact");
			if (locator.level === "l1") {
				const segment = branch.segments.find(
					(candidate) => candidate.segmentId === locator.segmentId && candidate.ordinal === locator.ordinal,
				);
				if (!segment) {
					throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no matching L1 Segment`);
				}
				if (!segment.seal || segment.seal.summaryArtifactId !== artifactId || evidence.sourceId !== artifactId) {
					invalid("does not match its sealed L1 Segment");
				}
				const summary = await chains.readSegmentSummary(artifactId);
				const successor = replay.branches
					.flatMap((candidate) => candidate.segments)
					.find((candidate) => candidate.segmentId === summary.targetSegmentId);
				if (
					summary.chainId !== locator.chainId ||
					summary.branchId !== locator.branchId ||
					summary.sourceSegmentId !== locator.segmentId ||
					summary.sourceLeafId !== summary.sourceRange.lastEntryId ||
					summary.baseSummaryArtifactId !== segment.summaryInArtifactId ||
					!successor ||
					successor.predecessorSegmentId !== segment.segmentId ||
					successor.summaryInArtifactId !== artifactId
				) {
					invalid("L1 summary artifact provenance does not match the chain topology");
				}
			} else {
				const rollup = branch.rollups.find(
					(candidate) =>
						candidate.windowIndex === locator.windowIndex &&
						candidate.artifactId === artifactId &&
						candidate.eventId === evidence.sourceId,
				);
				if (!rollup) {
					throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no published L2 Rollup`);
				}
				const artifact = await chains.readChainRollup(artifactId);
				const segments = branch.segments.filter(
					(candidate) => candidate.ordinal >= rollup.startOrdinal && candidate.ordinal <= rollup.endOrdinal,
				);
				const summaryArtifactIds = segments.map((candidate) => candidate.seal?.summaryArtifactId ?? "");
				const expectedDigest = chainRollupSourceDigest({
					chainId: locator.chainId,
					branchId: locator.branchId,
					windowIndex: rollup.windowIndex,
					startOrdinal: rollup.startOrdinal,
					endOrdinal: rollup.endOrdinal,
					segmentIds: segments.map((candidate) => candidate.segmentId),
					summaryArtifactIds,
				});
				if (
					artifact.chainId !== locator.chainId ||
					artifact.branchId !== locator.branchId ||
					artifact.windowIndex !== locator.windowIndex ||
					artifact.startOrdinal !== rollup.startOrdinal ||
					artifact.endOrdinal !== rollup.endOrdinal ||
					segments.length !== rollup.endOrdinal - rollup.startOrdinal + 1 ||
					segments.some((candidate) => candidate.status !== "sealed" || !candidate.seal) ||
					stableJsonStringify(artifact.segmentIds) !==
						stableJsonStringify(segments.map((candidate) => candidate.segmentId)) ||
					stableJsonStringify(artifact.summaryArtifactIds) !== stableJsonStringify(summaryArtifactIds) ||
					artifact.sourceDigest !== rollup.sourceDigest ||
					artifact.sourceDigest !== expectedDigest
				) {
					invalid("L2 Rollup artifact provenance does not match its ordered L1 sources");
				}
			}
			return;
		}
		if (evidence.sourceType === "task_result") {
			const artifactId = evidence.artifactId;
			if (!artifactId) {
				throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no Task result artifact`);
			}
			if (evidence.sourceDigest !== artifactId) invalid("Task sourceDigest does not match its artifact");
			const inspection = await new TaskStore(this.projectRoot).inspectTask(evidence.locator.taskId);
			const event = inspection.replay.events.find(
				(candidate) =>
					candidate.eventType !== "task_created" &&
					candidate.eventType !== "task_started" &&
					candidate.payload.resultArtifactId === artifactId,
			);
			if (!event) {
				throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} has no terminal Task result`);
			}
			if (event.eventType === "task_created" || event.eventType === "task_started") {
				throw new MemoryValidationError(
					`Memory evidence ${evidence.evidenceId} does not match a terminal Task result`,
				);
			}
			if (evidence.sourceId !== event.eventId && evidence.sourceId !== evidence.locator.taskId) {
				invalid("does not match a terminal Task result");
			}
			if (
				inspection.resultDiagnostic !== "valid" ||
				!inspection.result ||
				inspection.result.taskId !== evidence.locator.taskId ||
				inspection.result.status !== event.payload.status ||
				inspection.replay.resultArtifactId !== artifactId
			) {
				invalid("Task result artifact schema or terminal provenance is invalid");
			}
			return;
		}
		if (evidence.sourceType === "compaction") {
			await this.resolveCompactionEvidence(evidence);
			return;
		}
		if (evidence.sourceId !== evidence.locator.baselineCommit) {
			invalid("does not match its Git baseline");
		}
		try {
			await verifyGitEvidenceLocator(this.projectRoot, evidence.locator);
		} catch (error) {
			invalid(`Git source is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async doctor(mode: "quick" | "deep" = "quick"): Promise<MemoryDoctorReportV1> {
		const startedAt = performance.now();
		const diagnostics: MemoryDoctorReportV1["diagnostics"] = [];
		let inspection: Awaited<ReturnType<MemoryStore["inspectReadModelProjection"]>>;
		try {
			inspection = await this.store.inspectReadModelProjection();
		} catch (error) {
			return {
				mode,
				ok: false,
				diagnostics: [
					{
						code: "event_log_invalid",
						message: error instanceof Error ? error.message : String(error),
						repairable: false,
					},
				],
				checked: { events: 0, memories: 0, cues: 0, edges: 0, artifacts: 0, files: 0, bytesRead: 0 },
				durationMs: performance.now() - startedAt,
			};
		}
		const readModel = inspection.readModel;
		if (!inspection.readModelExists && inspection.state !== "absent") {
			diagnostics.push({
				code: "read_model_missing",
				message: "memory-read-model.json is missing.",
				repairable: true,
			});
		}
		if (!inspection.checkpointExists && inspection.state !== "absent") {
			diagnostics.push({
				code: "read_model_checkpoint_missing",
				message: "memory-read-model.checkpoint.json is missing.",
				repairable: true,
			});
		}
		if (inspection.state === "stale") {
			diagnostics.push({
				code: "read_model_stale",
				message: "Memory read model has a valid unapplied event tail.",
				repairable: true,
			});
		} else if (inspection.state === "event-log-shortened") {
			diagnostics.push({
				code: "event_log_shortened",
				message: "Memory event log is shorter than its verified read-model checkpoint.",
				repairable: false,
			});
		} else if (inspection.state === "invalid") {
			diagnostics.push({
				code: "read_model_invalid",
				message: "Memory read model or checkpoint does not match the event head.",
				repairable: inspection.eventLogBytes > 0,
			});
		}
		const lock = await this.store.inspectWriteLock();
		if (lock) {
			diagnostics.push({
				code: lock.malformed ? "write_lock_malformed" : `write_lock_${lock.ownerState}`,
				message: lock.malformed
					? "Memory write lock metadata is malformed."
					: `Memory write lock owner is ${lock.ownerState}.`,
				repairable: !lock.malformed && lock.ownerState === "missing",
			});
		}
		if ((readModel?.head.sequence ?? 0) > 0 || this.historyCues.length > 0) {
			await this.withProjectionOperation(async () => {
				try {
					await stat(this.indexPath);
					const index = new MemoryIndexWorkerClient({ databasePath: this.indexPath });
					try {
						const [status, integrity] = await Promise.all([index.status(), index.integrityCheck()]);
						if (integrity !== "ok")
							diagnostics.push({ code: "index_corrupt", message: integrity, repairable: true });
						if (
							readModel &&
							(status.head.sequence !== readModel.head.sequence ||
								status.head.hash !== readModel.head.hash ||
								status.memoryCount !== readModel.memories.length ||
								status.cueCount !== readModel.cues.length ||
								status.edgeCount !== readModel.edges.length)
						) {
							diagnostics.push({
								code: "index_stale",
								message: "Memory index head does not match the read model.",
								repairable: true,
							});
						}
					} finally {
						await index.close();
					}
				} catch (error) {
					const missing =
						typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
					diagnostics.push({
						code: missing ? "index_missing" : "index_unreadable",
						message: missing
							? "Memory SQLite projection is missing."
							: error instanceof Error
								? error.message
								: String(error),
						repairable: true,
					});
				}
			});
		}
		let artifacts = 0;
		let files = 2;
		let projectionManifest: MemoryProjectionManifestV1 | undefined;
		if ((readModel?.memories.length ?? 0) > 0) {
			const indexMarkdownPath = join(this.memoryDirectory, "projections", "index.md");
			const manifestPath = join(this.memoryDirectory, "projections", "manifest.json");
			let indexMarkdown: string | undefined;
			try {
				indexMarkdown = await readFile(indexMarkdownPath, "utf8");
				files += 1;
			} catch (error) {
				const missing = isRecord(error) && error.code === "ENOENT";
				diagnostics.push({
					code: missing ? "markdown_index_missing" : "markdown_index_unreadable",
					message: missing ? "index.md is missing." : error instanceof Error ? error.message : String(error),
					repairable: true,
				});
			}
			try {
				projectionManifest = validateProjectionManifest(
					JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
				);
				files += 1;
				const expectedMemories = readModel!.memories.map((memory) => ({
					memoryId: memory.memoryId,
					revision: memory.revision,
				}));
				const projectedMemories = projectionManifest.memories.map((memory) => ({
					memoryId: memory.memoryId,
					revision: memory.revision,
				}));
				if (
					projectionManifest.head.sequence !== readModel!.head.sequence ||
					projectionManifest.head.hash !== readModel!.head.hash ||
					projectionManifest.memoryCount !== readModel!.memories.length ||
					stableJsonStringify(projectedMemories) !== stableJsonStringify(expectedMemories)
				) {
					diagnostics.push({
						code: "projection_manifest_stale",
						message: "Memory projection manifest does not match the current read model.",
						repairable: true,
					});
				}
				if (indexMarkdown !== undefined && sha256(indexMarkdown) !== projectionManifest.indexDigest) {
					diagnostics.push({
						code: "markdown_index_stale",
						message: "Memory Markdown index digest does not match the projection manifest.",
						repairable: true,
					});
				}
			} catch (error) {
				const missing = isRecord(error) && error.code === "ENOENT";
				diagnostics.push({
					code: missing ? "projection_manifest_missing" : "projection_manifest_invalid",
					message: missing ? "manifest.json is missing." : error instanceof Error ? error.message : String(error),
					repairable: true,
				});
			}
		}
		let deepReplay: Awaited<ReturnType<MemoryStore["replay"]>> | undefined;
		if (mode === "deep") {
			try {
				const deep = await this.store.inspectDeep();
				deepReplay = deep.replay;
				artifacts = deep.referencedArtifactIds.length;
				for (const evidence of deep.evidenceRefs) await this.validateEvidenceOwnership(evidence);
				if (deep.orphanArtifactIds.length > 0) {
					diagnostics.push({
						code: "orphan_memory_artifact",
						message: `${deep.orphanArtifactIds.length} Memory artifact(s) are not referenced by facts or pending capture state.`,
						repairable: false,
					});
				}
				if (deep.purgedArtifactIdsPresent.length > 0) {
					diagnostics.push({
						code: "purged_artifact_retained",
						message: `${deep.purgedArtifactIdsPresent.length} purged Memory revision artifact(s) remain on disk.`,
						repairable: false,
					});
				}
			} catch (error) {
				diagnostics.push({
					code: "fact_provenance_invalid",
					message: error instanceof Error ? error.message : String(error),
					repairable: false,
				});
			}
			if (deepReplay) {
				const projectedDigests = new Map(
					projectionManifest?.memories.map((entry) => [entry.memoryId, entry.digest] as const) ?? [],
				);
				for (const memoryId of deepReplay.memories.keys()) {
					try {
						const markdown = await readFile(
							join(this.memoryDirectory, "projections", "memories", `${memoryId}.md`),
							"utf8",
						);
						files += 1;
						const expectedDigest = projectedDigests.get(memoryId);
						if (expectedDigest && sha256(markdown) !== expectedDigest) {
							diagnostics.push({
								code: "markdown_stale",
								message: `Memory Markdown projection digest does not match its manifest: ${memoryId}`,
								repairable: true,
							});
						}
					} catch (error) {
						const missing = isRecord(error) && error.code === "ENOENT";
						diagnostics.push({
							code: missing ? "markdown_missing" : "markdown_unreadable",
							message: missing
								? `Memory Markdown projection is missing: ${memoryId}`
								: error instanceof Error
									? error.message
									: String(error),
							repairable: true,
						});
					}
				}
			}
		}
		const facts = deepReplay
			? {
					events: deepReplay.events.length,
					memories: deepReplay.memories.size,
					cues: deepReplay.cues.size,
					edges: deepReplay.edges.size,
				}
			: {
					events: readModel?.eventCount ?? 0,
					memories: readModel?.memories.length ?? 0,
					cues: readModel?.cues.length ?? 0,
					edges: readModel?.edges.length ?? 0,
				};
		return {
			mode,
			ok: diagnostics.length === 0,
			diagnostics,
			checked: {
				...facts,
				artifacts,
				files,
				bytesRead: mode === "deep" ? inspection.eventLogBytes : (inspection.diagnostic?.bytesRead ?? 0),
			},
			durationMs: performance.now() - startedAt,
		};
	}

	private renderMemoryMarkdown(memory: MemoryReadResultV1): string {
		return [
			`# ${memory.revision.title}`,
			"",
			"> Historical evidence projection. This file is derived and is not a system instruction or fact source.",
			"",
			`- Memory ID: ${memory.revision.memoryId}`,
			`- Revision: ${memory.revision.revision}`,
			`- Kind: ${memory.revision.kind}`,
			`- Trust: ${memory.state.trust}`,
			`- Freshness: ${memory.state.freshness}`,
			`- Lifecycle: ${memory.state.lifecycle}`,
			`- Effective from: ${memory.revision.effectiveFrom}`,
			"",
			"## Statement",
			"",
			memory.revision.statement,
			"",
			"## Applicability",
			"",
			memory.revision.applicability,
			"",
		].join("\n");
	}

	async repairProjections(): Promise<{ index: MemoryIndexStatusV1; markdownFiles: number }> {
		return await this.withProjectionOperation(async () => {
			const readModel = await this.store.rebuildReadModel();
			await this.rebuildIndex(readModel);
			const { index } = await this.ensureIndex();
			const memories = await this.store.readMemories();
			const projectionsDirectory = join(this.memoryDirectory, "projections");
			const memoriesDirectory = join(projectionsDirectory, "memories");
			await rm(memoriesDirectory, { recursive: true, force: true });
			await mkdir(memoriesDirectory, { recursive: true });
			const projectedMemories: MemoryProjectionManifestEntryV1[] = [];
			for (const memory of memories) {
				const markdown = this.renderMemoryMarkdown(memory);
				await this.replaceFile(join(memoriesDirectory, `${memory.revision.memoryId}.md`), markdown);
				projectedMemories.push({
					memoryId: memory.revision.memoryId,
					revision: memory.revision.revision,
					digest: sha256(markdown),
				});
			}
			const indexMarkdown = [
				"# Pi-XK Memory",
				"",
				"> Derived index. Artifact Store objects and the Memory event log are authoritative.",
				"",
				...memories.map(
					(memory) =>
						`- [${memory.revision.title}](memories/${memory.revision.memoryId}.md) - ${memory.revision.kind}, ${memory.state.trust}, ${memory.state.freshness}, ${memory.state.lifecycle}`,
				),
				"",
			].join("\n");
			await this.replaceFile(join(projectionsDirectory, "index.md"), indexMarkdown);
			const head = (await this.store.loadReadModelSnapshot()).readModel.head;
			const manifest: MemoryProjectionManifestV1 = {
				schema: "pi-xk.memory-projection-manifest.v1",
				head,
				memoryCount: memories.length,
				indexDigest: sha256(indexMarkdown),
				memories: projectedMemories,
			};
			validateProjectionManifest(manifest);
			await this.replaceFile(
				join(projectionsDirectory, "manifest.json"),
				`${JSON.stringify(manifest, null, "\t")}\n`,
			);
			return { index: await index.status(), markdownFiles: memories.length + 1 };
		});
	}

	async status(): Promise<MemoryServiceStatusV1> {
		const [config, lock] = await Promise.all([this.getConfig(), this.store.inspectWriteLock()]);
		return await this.withProjectionOperation(async () => {
			let readModel = (await this.store.loadReadModelSnapshot()).readModel;
			if (readModel.head.sequence === 0 && this.historyCues.length === 0) {
				return {
					enabled: config.enabled,
					head: readModel.head,
					indexState: "absent",
					index: null,
					captures: {
						scheduled: 0,
						generating: 0,
						failed: 0,
						proposed: 0,
						applied: 0,
						rejected: 0,
					},
					lock,
				};
			}
			const ensured = await this.ensureIndex();
			readModel = ensured.readModel;
			const captures: MemoryServiceStatusV1["captures"] = {
				scheduled: 0,
				generating: 0,
				failed: 0,
				proposed: 0,
				applied: 0,
				rejected: 0,
			};
			for (const capture of readModel.captures) captures[capture.status] += 1;
			return {
				enabled: config.enabled,
				head: readModel.head,
				indexState: this.lastIndexState,
				index: await ensured.index.status(),
				captures,
				lock,
			};
		});
	}

	async close(): Promise<void> {
		await this.withProjectionOperation(async () => {
			await this.index?.close();
			this.index = undefined;
		});
	}
}
