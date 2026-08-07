import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { EvidenceRefV2, MemoryReconstructionTraceV1, MemoryReviewDecisionV1 } from "./ambient-memory-contract.ts";
import { ArtifactStore } from "./artifact-store.ts";
import {
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
import { resolveMemoryCompactionEvidence, validateMemoryEvidenceOwnership } from "./memory-evidence.ts";
import { readGitEvidence } from "./memory-freshness.ts";
import type {
	MemoryHistoryCueCandidateV1,
	MemoryIndexCandidateV1,
	MemoryIndexCueV1,
	MemoryIndexDeltaV1,
	MemoryIndexEdgeV1,
	MemoryIndexHistoryCueV1,
	MemoryIndexMemoryV1,
	MemoryIndexRebuildChunkV1,
	MemoryIndexRebuildPlanV1,
	MemoryIndexStatusV1,
} from "./memory-index.ts";
import { MemoryIndexWorkerClient } from "./memory-index-worker-client.ts";
import {
	type MemoryApplyOptions,
	type MemoryApplyResultV1,
	type MemoryMutationOptions,
	type MemoryPurgeResultV1,
	type MemoryReadModelV1,
	type MemoryReadResultV1,
	type MemoryReviewApplyResultV1,
	type MemoryReviewPublicationContextV1,
	MemoryStore,
	type MemoryWriteResult,
} from "./memory-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";

const MEMORY_CONFIG_SCHEMA = "pi-xk.memory-config.v1";
const MEMORY_CONFIG_V2_SCHEMA = "pi-xk.memory-config.v2";
const EXPLICIT_MEMORY_PROMPT_VERSION = "pi-xk.memory-explicit.v1";
const MEMORY_INDEX_ENTITY_CHUNK_SIZE = 256;
const MEMORY_INDEX_EDGE_CHUNK_SIZE = 2_048;

export interface MemoryConfigV1 {
	enabled: boolean;
	ambient: boolean;
	evolution: boolean;
}

export interface MemoryConfigUpdateV1 {
	enabled?: boolean;
	ambient?: boolean;
	evolution?: boolean;
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
		skipped: number;
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

function memorySearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function memorySearchTokens(query: string): string[] {
	return [...new Set([...query.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => memorySearchText(match[0])))];
}

function isTemporalMemoryQuery(query: string): boolean {
	return /(?:上次|最近|近期|刚才|previous|recent|latest|last(?:\s+time)?)/iu.test(query);
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
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new MemoryValidationError("Memory config is invalid");
			}
			if (
				Object.keys(parsed).sort().join(",") === "enabled,schema" &&
				"schema" in parsed &&
				parsed.schema === MEMORY_CONFIG_SCHEMA &&
				"enabled" in parsed &&
				typeof parsed.enabled === "boolean"
			) {
				return { enabled: parsed.enabled, ambient: true, evolution: true };
			}
			if (
				Object.keys(parsed).sort().join(",") !== "ambient,enabled,evolution,schema" ||
				!("schema" in parsed) ||
				parsed.schema !== MEMORY_CONFIG_V2_SCHEMA ||
				!("enabled" in parsed) ||
				typeof parsed.enabled !== "boolean" ||
				!("ambient" in parsed) ||
				typeof parsed.ambient !== "boolean" ||
				!("evolution" in parsed) ||
				typeof parsed.evolution !== "boolean"
			) {
				throw new MemoryValidationError("Memory config is invalid");
			}
			return { enabled: parsed.enabled, ambient: parsed.ambient, evolution: parsed.evolution };
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				return { enabled: true, ambient: true, evolution: true };
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

	async setConfig(config: MemoryConfigUpdateV1): Promise<void> {
		const keys = Object.keys(config);
		if (
			keys.length === 0 ||
			keys.some((key) => !["enabled", "ambient", "evolution"].includes(key)) ||
			Object.values(config).some((value) => typeof value !== "boolean")
		) {
			throw new MemoryValidationError("Memory config update is invalid");
		}
		const current = await this.getConfig();
		const next = { ...current, ...config };
		await this.replaceFile(
			this.configPath,
			`${JSON.stringify({ schema: MEMORY_CONFIG_V2_SCHEMA, ...next }, null, "\t")}\n`,
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

	private withProjectionMutation<T>(operation: () => Promise<T>): Promise<T> {
		return this.withProjectionOperation(async () => await this.store.withProjectionLock(operation));
	}

	private async indexCanApply(expectedHead: MemoryReadModelV1["head"]): Promise<boolean> {
		if (!this.index) return false;
		try {
			const status = await this.index.status();
			return status.head.sequence === expectedHead.sequence && status.head.hash === expectedHead.hash;
		} catch {
			await this.index.close().catch(() => {});
			this.index = undefined;
			this.lastIndexState = "absent";
			return false;
		}
	}

	private async prepareIndexForMutation(expectedHead: MemoryReadModelV1["head"]): Promise<boolean> {
		try {
			const readModel = (await this.store.loadReadModelSnapshot()).readModel;
			if (readModel.head.sequence !== expectedHead.sequence || readModel.head.hash !== expectedHead.hash)
				return false;
			await this.ensureIndexForReadModel(readModel);
			return true;
		} catch {
			await this.index?.close().catch(() => {});
			this.index = undefined;
			this.lastIndexState = "absent";
			return false;
		}
	}

	private async advanceProjectionManifest(
		expectedHead: MemoryReadModelV1["head"],
		head: MemoryReadModelV1["head"],
	): Promise<void> {
		try {
			const path = join(this.memoryDirectory, "projections", "manifest.json");
			const manifest = validateProjectionManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
			if (manifest.head.sequence !== expectedHead.sequence || manifest.head.hash !== expectedHead.hash) return;
			await this.replaceFile(path, `${JSON.stringify({ ...manifest, head }, null, "\t")}\n`);
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return;
			// Derived projection damage is reported by doctor and must not roll back a fact event.
		}
	}

	private async projectionNeutralMutation<TResult>(
		expectedHead: MemoryReadModelV1["head"],
		mutation: () => Promise<TResult>,
		resultHead: (result: TResult) => MemoryReadModelV1["head"],
	): Promise<TResult> {
		return await this.withProjectionMutation(async () => {
			const updateIndex = await this.prepareIndexForMutation(expectedHead);
			const result = await mutation();
			const head = resultHead(result);
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				await this.applyIndexDelta(expectedHead, readModel, {});
			}
			await this.advanceProjectionManifest(expectedHead, head);
			return result;
		});
	}

	async scheduleCapture(
		source: Parameters<MemoryStore["scheduleCapture"]>[0],
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["scheduleCapture"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.scheduleCapture(source, options),
			(result) => result.head,
		);
	}

	async markGenerationStarted(
		captureId: string,
		attempt: number,
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["markGenerationStarted"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.markGenerationStarted(captureId, attempt, options),
			(result) => result.head,
		);
	}

	async markCaptureFailed(
		failure: Parameters<MemoryStore["markCaptureFailed"]>[0],
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["markCaptureFailed"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.markCaptureFailed(failure, options),
			(result) => result.head,
		);
	}

	async markCaptureSkipped(
		captureId: string,
		resultArtifactId: string,
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["markCaptureSkipped"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.markCaptureSkipped(captureId, resultArtifactId, options),
			(result) => result.head,
		);
	}

	async recordProposal(
		proposal: Parameters<MemoryStore["recordProposal"]>[0],
		resultArtifactId: string,
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["recordProposal"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.recordProposal(proposal, resultArtifactId, options),
			(result) => result.write.head,
		);
	}

	async rejectProposal(
		proposalId: string,
		reason: string,
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["rejectProposal"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.rejectProposal(proposalId, reason, options),
			(result) => result.head,
		);
	}

	async recordReconstruction(
		trace: MemoryReconstructionTraceV1,
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["recordReconstruction"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.recordReconstruction(trace, options),
			(result) => result.write.head,
		);
	}

	async recordMemoryReviewFailure(
		failure: Parameters<MemoryStore["recordMemoryReviewFailure"]>[0],
		options: MemoryMutationOptions,
	): Promise<Awaited<ReturnType<MemoryStore["recordMemoryReviewFailure"]>>> {
		return await this.projectionNeutralMutation(
			options.expectedHead,
			async () => await this.store.recordMemoryReviewFailure(failure, options),
			(result) => result.head,
		);
	}

	private async indexEntities(
		readModel: MemoryReadModelV1,
		memoryIds: ReadonlySet<string>,
		cueIds: ReadonlySet<string>,
		edgeIds: ReadonlySet<string>,
	): Promise<{ memories: MemoryIndexMemoryV1[]; cues: MemoryIndexCueV1[]; edges: MemoryIndexEdgeV1[] }> {
		const memoryReferences = readModel.memories.filter((reference) => memoryIds.has(reference.memoryId));
		const cueReferences = readModel.cues.filter((reference) => cueIds.has(reference.cueId));
		const edgeReferences = readModel.edges.filter((reference) => edgeIds.has(reference.edgeId));
		const cueIdSet = new Set(readModel.cues.map((reference) => reference.cueId));
		const accessByMemoryId = new Map(readModel.accesses.map((access) => [access.memoryId, access]));
		const [memories, cues, edges] = await Promise.all([
			this.store.readMemoriesByReferences(memoryReferences, (cueId) => cueIdSet.has(cueId)),
			this.store.readCuesByReferences(cueReferences),
			this.store.readEdgesByReferences(edgeReferences),
		]);
		return {
			memories: memories.map((memory) => {
				const access = accessByMemoryId.get(memory.revision.memoryId);
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
					accessCount: access?.accessCount ?? 0,
					lastAccessedAt: access?.lastAccessedAt ?? null,
				};
			}),
			cues: cues.map(({ cue, artifactId }) => ({
				cueId: cue.cueId,
				revision: cue.revision,
				artifactId,
				kind: cue.kind,
				key: cue.key,
				label: cue.label,
				aliases: cue.aliases,
			})),
			edges: edges.map(({ edge, artifactId }) => ({
				edgeId: edge.edgeId,
				artifactId,
				fromKind: edge.from.kind,
				fromId: edge.from.id,
				toKind: edge.to.kind,
				toId: edge.to.id,
				relation: edge.relation,
				effectiveFrom: edge.effectiveFrom,
				effectiveTo: edge.effectiveTo,
			})),
		};
	}

	private async applyIndexDelta(
		expectedHead: MemoryReadModelV1["head"],
		readModel: MemoryReadModelV1,
		changes: {
			memoryIds?: Iterable<string>;
			cueIds?: Iterable<string>;
			edgeIds?: Iterable<string>;
			removeMemoryIds?: Iterable<string>;
			removeCueIds?: Iterable<string>;
			removeEdgeIds?: Iterable<string>;
			historyCues?: Iterable<MemoryIndexHistoryCueV1>;
		},
	): Promise<boolean> {
		if (!this.index) return false;
		try {
			const entities = await this.indexEntities(
				readModel,
				new Set(changes.memoryIds ?? []),
				new Set(changes.cueIds ?? []),
				new Set(changes.edgeIds ?? []),
			);
			const delta: MemoryIndexDeltaV1 = {
				expectedHead,
				head: readModel.head,
				...entities,
				historyCues: [...(changes.historyCues ?? [])],
				removeMemoryIds: [...(changes.removeMemoryIds ?? [])],
				removeCueIds: [...(changes.removeCueIds ?? [])],
				removeEdgeIds: [...(changes.removeEdgeIds ?? [])],
			};
			await this.index.applyDelta(delta);
			this.lastIndexState = "current";
			return true;
		} catch {
			await this.index.close().catch(() => {});
			this.index = undefined;
			this.lastIndexState = "absent";
			return false;
		}
	}

	async synchronizeHistoryCues(
		cues: readonly MemoryIndexHistoryCueV1[],
		options: { newCueIds?: readonly string[]; forceRebuild?: boolean } = {},
	): Promise<void> {
		const next = [...cues].sort((left, right) => left.cueId.localeCompare(right.cueId));
		const nextCueIds = new Set(next.map((cue) => cue.cueId));
		if (nextCueIds.size !== next.length) throw new MemoryValidationError("Memory history cue IDs must be unique");
		const newCueIds = new Set(options.newCueIds ?? []);
		if ([...newCueIds].some((cueId) => !nextCueIds.has(cueId))) {
			throw new MemoryValidationError("Memory history cue delta references an unknown cue");
		}
		await this.withProjectionMutation(async () => {
			this.setHistoryCues(next);
			const readModel = (await this.store.loadReadModelSnapshot()).readModel;
			if (options.forceRebuild) {
				await this.rebuildIndex(readModel);
				return;
			}
			const delta = next.filter((cue) => newCueIds.has(cue.cueId));
			const expectedExistingCount = next.length - delta.length;
			if (!(await this.adoptMatchingIndex(readModel, expectedExistingCount, true))) {
				await this.rebuildIndex(readModel);
				return;
			}
			if (delta.length > 0) {
				if (!(await this.applyIndexDelta(readModel.head, readModel, { historyCues: delta }))) {
					await this.rebuildIndex(readModel);
					return;
				}
			}
			this.indexedHistoryGeneration = this.historyGeneration;
			this.lastIndexState = "current";
		});
	}

	async applyProposal(proposalArtifactId: string, options: MemoryApplyOptions): Promise<MemoryApplyResultV1> {
		return await this.withProjectionMutation(async () => {
			const updateIndex = await this.prepareIndexForMutation(options.expectedHead);
			const result = await this.store.applyProposal(proposalArtifactId, options);
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				const purgedMemoryIds = new Set((result.write.event.payload.purges ?? []).map((purge) => purge.memoryId));
				await this.applyIndexDelta(options.expectedHead, readModel, {
					memoryIds: result.write.event.payload.revisions
						.map((reference) => reference.memoryId)
						.filter((memoryId) => !purgedMemoryIds.has(memoryId)),
					cueIds: result.write.event.payload.cues.map((reference) => reference.cueId),
					edgeIds: result.write.event.payload.edges.map((reference) => reference.edgeId),
					removeMemoryIds: purgedMemoryIds,
				});
			}
			return result;
		});
	}

	async applyMemoryReviews(
		decisions: readonly MemoryReviewDecisionV1[],
		evidenceRefs: readonly EvidenceRefV2[],
		traceArtifactId: string,
		options: MemoryMutationOptions,
		context: MemoryReviewPublicationContextV1 = {},
	): Promise<MemoryReviewApplyResultV1> {
		return await this.withProjectionMutation(async () => {
			const updateIndex = await this.prepareIndexForMutation(options.expectedHead);
			const result = await this.store.applyMemoryReviews(decisions, evidenceRefs, traceArtifactId, options, context);
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				await this.applyIndexDelta(options.expectedHead, readModel, {
					memoryIds: result.write.event.payload.revisions.map((reference) => reference.memoryId),
					cueIds: result.write.event.payload.cues.map((reference) => reference.cueId),
					edgeIds: result.write.event.payload.edges.map((reference) => reference.edgeId),
				});
			}
			return result;
		});
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
					effectiveFrom: edge.effectiveFrom,
					effectiveTo: edge.effectiveTo,
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

	private async adoptMatchingIndex(
		readModel: MemoryReadModelV1,
		historyCueCount: number,
		allowStaleHistoryGeneration = false,
	): Promise<boolean> {
		if (this.index) {
			const staleHistoryGeneration = this.indexedHistoryGeneration !== this.historyGeneration;
			try {
				const [status, integrity] = await Promise.all([this.index.status(), this.index.integrityCheck()]);
				if (
					(allowStaleHistoryGeneration || !staleHistoryGeneration) &&
					integrity === "ok" &&
					status.head.sequence === readModel.head.sequence &&
					status.head.hash === readModel.head.hash &&
					status.memoryCount === readModel.memories.length &&
					status.cueCount === readModel.cues.length &&
					status.edgeCount === readModel.edges.length &&
					status.historyCueCount === historyCueCount
				) {
					return true;
				}
			} catch {
				// Close and retry from the on-disk projection below.
			}
			await this.index.close().catch(() => {});
			this.index = undefined;
			if (staleHistoryGeneration && !allowStaleHistoryGeneration) return false;
		}
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
				status.historyCueCount === historyCueCount
			) {
				this.index = candidate;
				this.indexedHistoryGeneration = this.historyGeneration;
				this.lastIndexState = "current";
				return true;
			}
		} catch {
			// A corrupt or unsupported projection is rebuilt from facts below.
		}
		await candidate.close();
		return false;
	}

	private async ensureIndexForReadModel(readModel: MemoryReadModelV1): Promise<MemoryIndexWorkerClient> {
		if (!(await this.adoptMatchingIndex(readModel, this.historyCues.length))) {
			await this.rebuildIndex(readModel);
		}
		if (!this.index) throw new MemoryValidationError("Memory index is unavailable after rebuild");
		this.indexedHistoryGeneration = this.historyGeneration;
		return this.index;
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
			await this.ensureIndexForReadModel(readModel);
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
		const scheduled = await this.scheduleCapture(source, {
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
		const recorded = await this.recordProposal(proposal, resultArtifact.artifactId, {
			eventId: `evt_memory_proposal_${suffix}`,
			idempotencyKey: `memory:proposal:${proposal.proposalId}`,
			expectedHead: scheduled.head,
			actor: "user",
			timestamp: recordedAt,
		});
		const applied = await this.applyProposal(recorded.proposalArtifactId, {
			eventId: `evt_memory_apply_${suffix}`,
			idempotencyKey: `memory:apply:${proposal.proposalId}`,
			expectedHead: recorded.write.head,
			actor: "user",
			timestamp: recordedAt,
			confirmed: true,
		});
		try {
			await this.synchronizeProjections({ memoryIds: [memoryId] });
		} catch (error) {
			try {
				await this.markCaptureFailed(
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
		if (input.asOf) {
			return await this.searchAtHistoricalRevision(input, query, limit, offset, digest);
		}
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
			nextCursor: result.hasMore ? encodeCursor(digest, offset + limit) : null,
		};
	}

	private async searchAtHistoricalRevision(
		input: MemorySearchInputV1,
		query: string,
		limit: number,
		offset: number,
		digest: string,
	): Promise<MemorySearchResultV1> {
		const asOf = input.asOf!;
		if (Number.isNaN(Date.parse(asOf)))
			throw new MemoryValidationError("Memory search asOf must be an ISO timestamp");
		const normalizedQuery = memorySearchText(query);
		const tokens = memorySearchTokens(query);
		const temporal = isTemporalMemoryQuery(query);
		const historical = (await this.store.readMemoriesAt(asOf)).filter(
			(memory) =>
				memory.revision.lifecycle === "active" && (!input.kinds || input.kinds.includes(memory.revision.kind)),
		);
		const ranked = historical
			.map((memory) => {
				const text = memorySearchText(
					`${memory.revision.title}\n${memory.revision.statement}\n${memory.revision.applicability}`,
				);
				const tokenHits = tokens.filter((token) => text.includes(token)).length;
				const relevance = text.includes(normalizedQuery) ? 2 : tokens.length > 0 ? tokenHits / tokens.length : 0;
				return { memory, relevance };
			})
			.filter((entry) => entry.relevance > 0 || temporal)
			.sort(
				(left, right) =>
					right.relevance - left.relevance ||
					Date.parse(right.memory.revision.provenance.recordedAt) -
						Date.parse(left.memory.revision.provenance.recordedAt) ||
					left.memory.revision.memoryId.localeCompare(right.memory.revision.memoryId),
			)
			.slice(0, 200);

		const { index, historyCues } = await this.withProjectionOperation(async () => {
			const { index } = await this.ensureIndex();
			const historyCues: MemoryHistoryCueCandidateV1[] = [];
			if (input.includeHistoryCues) {
				for (let historyOffset = 0; historyOffset < 200; historyOffset += 50) {
					const page = await index.search({
						query,
						kinds: [],
						asOf,
						includeHistoryCues: true,
						limit: 50,
						offset: historyOffset,
						graphDepth: 0,
					});
					historyCues.push(...page.historyCues);
					if (!page.hasMore) break;
				}
			}
			return { index, historyCues };
		});
		const candidates: MemoryIndexCandidateV1[] = [];
		for (const [rank, entry] of ranked.entries()) {
			let relations: MemoryIndexCandidateV1["relations"] = [];
			if ((input.graphDepth ?? 1) > 0) {
				try {
					const graph = await index.graph({
						rootMemoryId: entry.memory.revision.memoryId,
						depth: input.graphDepth === 2 ? 2 : 1,
						asOf,
					});
					relations = graph.edges
						.filter(
							(edge) =>
								(edge.from.kind === "memory" && edge.from.id === entry.memory.revision.memoryId) ||
								(edge.to.kind === "memory" && edge.to.id === entry.memory.revision.memoryId),
						)
						.map((edge) => {
							const other =
								edge.from.kind === "memory" && edge.from.id === entry.memory.revision.memoryId
									? edge.to
									: edge.from;
							return { edgeId: edge.edgeId, relation: edge.relation, otherKind: other.kind, otherId: other.id };
						});
				} catch {
					// A purged or projection-missing historical root can still be returned from its verified revision artifact.
				}
			}
			candidates.push({
				memoryId: entry.memory.revision.memoryId,
				revision: entry.memory.revision.revision,
				artifactId: entry.memory.artifactId,
				kind: entry.memory.revision.kind,
				title: entry.memory.revision.title,
				state: entry.memory.state,
				effectiveFrom: entry.memory.revision.effectiveFrom,
				effectiveTo: entry.memory.revision.effectiveTo,
				recordedAt: entry.memory.revision.provenance.recordedAt,
				relations,
				score: entry.relevance + 1 / (60 + rank + 1),
			});
		}
		const merged = [
			...candidates.map((value) => ({ kind: "memory" as const, id: value.memoryId, score: value.score, value })),
			...historyCues.map((value) => ({ kind: "history" as const, id: value.cueId, score: value.score, value })),
		]
			.sort(
				(left, right) =>
					right.score - left.score || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
			)
			.slice(0, 200);
		const page = merged.slice(offset, offset + limit);
		return {
			items: page
				.filter((entry): entry is Extract<(typeof page)[number], { kind: "memory" }> => entry.kind === "memory")
				.map((entry) => entry.value),
			historyCues: page
				.filter((entry): entry is Extract<(typeof page)[number], { kind: "history" }> => entry.kind === "history")
				.map((entry) => entry.value),
			nextCursor: offset + limit < merged.length ? encodeCursor(digest, offset + limit) : null,
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
		const memories = input.asOf
			? await Promise.all(
					input.memoryIds.map(async (memoryId) => await this.store.readMemoryAt(memoryId, input.asOf!)),
				)
			: await this.store.readMemories(input.memoryIds);
		for (const memory of memories) {
			for (const evidence of memory.revision.evidenceRefs) {
				await validateMemoryEvidenceOwnership(this.projectRoot, evidence);
			}
		}
		return { memories };
	}

	async expandEvidence(input: {
		memoryId: string;
		revision?: number;
		evidenceIds?: readonly string[];
	}): Promise<MemoryEvidenceExpansionV1> {
		const memory =
			input.revision === undefined
				? await this.store.readMemory(input.memoryId)
				: await this.store.readMemoryRevision(input.memoryId, input.revision);
		for (const evidence of memory.revision.evidenceRefs) {
			await validateMemoryEvidenceOwnership(this.projectRoot, evidence);
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
				content = stableJsonStringify(await resolveMemoryCompactionEvidence(this.projectRoot, reference));
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
		const graph = await this.withProjectionOperation(async () => {
			const { index } = await this.ensureIndex();
			return await index.graph({ rootMemoryId: memoryId, depth });
		});
		const [memories, cues] = await Promise.all([
			this.store.readMemories(graph.memoryIds),
			this.store.readCues(graph.cueIds),
		]);
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
			edges: graph.edges,
		};
	}

	async refresh(memoryId: string): Promise<MemoryReadResultV1> {
		await this.store.readMemory(memoryId);
		await this.withProjectionMutation(async () => {
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
		await this.withProjectionMutation(async () => {
			const updateIndex = await this.indexCanApply(replay.head);
			await this.store.changeMemoryLifecycle(memoryId, memory.revision.revision, lifecycle, reason, {
				eventId: `evt_memory_lifecycle_${operationId}`,
				idempotencyKey: `memory:lifecycle:${operationId}`,
				expectedHead: replay.head,
				actor: "user",
				timestamp: new Date().toISOString(),
				confirmed: true,
			});
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				await this.applyIndexDelta(replay.head, readModel, { memoryIds: [memoryId] });
			}
		});
		await this.synchronizeProjections({ memoryIds: [memoryId] });
		return await this.store.readMemory(memoryId);
	}

	async detachEvidence(memoryId: string, evidenceId: string, reason: string): Promise<MemoryReadResultV1> {
		await this.assertWritable();
		const memory = await this.store.readMemory(memoryId);
		const replay = await this.store.replay();
		const operationId = randomUUID().replaceAll("-", "");
		await this.withProjectionMutation(async () => {
			const updateIndex = await this.indexCanApply(replay.head);
			await this.store.detachMemoryEvidence(memoryId, memory.revision.revision, evidenceId, reason, {
				eventId: `evt_memory_detach_${operationId}`,
				idempotencyKey: `memory:detach:${operationId}`,
				expectedHead: replay.head,
				actor: "user",
				timestamp: new Date().toISOString(),
				confirmed: true,
			});
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				await this.applyIndexDelta(replay.head, readModel, { memoryIds: [memoryId] });
			}
		});
		await this.synchronizeProjections({ memoryIds: [memoryId] });
		return await this.store.readMemory(memoryId);
	}

	async purge(memoryId: string, reason: string): Promise<MemoryPurgeResultV1> {
		await this.assertWritable();
		const memory = await this.store.readMemory(memoryId);
		const replay = await this.store.replay();
		const operationId = randomUUID().replaceAll("-", "");
		const result = await this.withProjectionMutation(async () => {
			const updateIndex = await this.indexCanApply(replay.head);
			const result = await this.store.purgeMemory(memoryId, memory.revision.revision, reason, {
				eventId: `evt_memory_purge_${operationId}`,
				idempotencyKey: `memory:purge:${operationId}`,
				expectedHead: replay.head,
				actor: "user",
				timestamp: new Date().toISOString(),
				confirmed: true,
			});
			if (updateIndex) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				await this.applyIndexDelta(replay.head, readModel, { removeMemoryIds: [memoryId] });
			}
			return result;
		});
		await this.synchronizeProjections({ removeMemoryIds: [memoryId] });
		return result;
	}

	async recordAccess(
		access: MemoryAccessEventV1,
		options: MemoryMutationOptions,
	): Promise<MemoryWriteResult<"access_recorded"> | null> {
		if (!(await this.getConfig()).enabled) return null;
		return await this.withProjectionMutation(async () => {
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
			await this.advanceProjectionManifest(options.expectedHead, write.head);
			return write;
		});
	}

	async doctor(mode: "quick" | "deep" = "quick"): Promise<MemoryDoctorReportV1> {
		return await this.withProjectionMutation(async () => await this.doctorLocked(mode));
	}

	private async doctorLocked(mode: "quick" | "deep"): Promise<MemoryDoctorReportV1> {
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
		for (const capture of readModel?.captures ?? []) {
			if (capture.status === "failed") {
				diagnostics.push({
					code: capture.retryable === true ? "capture_failed_retryable" : "capture_failed_non_retryable",
					message: `Memory capture ${capture.captureId} failed with ${capture.errorCode ?? "unknown_error"}; ${
						capture.retryable === true
							? "the next matching stable-source boundary may retry it"
							: "its source or configuration requires explicit correction"
					}.`,
					repairable: false,
				});
				continue;
			}
			if (capture.status !== "generating") continue;
			try {
				await stat(join(this.memoryDirectory, "pending", `${capture.captureId}.json`));
			} catch (error) {
				if (!isRecord(error) || error.code !== "ENOENT") throw error;
				diagnostics.push({
					code: "capture_indeterminate",
					message: `Memory capture ${capture.captureId} started generation but has no durable result pointer; do not retry it automatically.`,
					repairable: false,
				});
			}
		}
		if ((readModel?.head.sequence ?? 0) > 0 || this.historyCues.length > 0) {
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
				const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
				for (const evidence of deep.evidenceRefs) {
					await validateMemoryEvidenceOwnership(this.projectRoot, evidence);
				}
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
						message: `${deep.purgedArtifactIdsPresent.length} unreferenced purged Memory artifact(s) remain on disk.`,
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

	private renderMemoryIndexLine(memory: MemoryReadResultV1): string {
		return `- [${memory.revision.title}](memories/${memory.revision.memoryId}.md) - ${memory.revision.kind}, ${memory.state.trust}, ${memory.state.freshness}, ${memory.state.lifecycle}`;
	}

	async synchronizeProjections(changes: {
		memoryIds?: readonly string[];
		removeMemoryIds?: readonly string[];
	}): Promise<{ markdownFiles: number }> {
		return await this.withProjectionMutation(async () => {
			const readModel = (await this.store.loadReadModelSnapshot()).readModel;
			const changedMemoryIds = new Set(changes.memoryIds ?? []);
			const removedMemoryIds = new Set(changes.removeMemoryIds ?? []);
			for (const memoryId of changedMemoryIds) {
				if (!readModel.memories.some((reference) => reference.memoryId === memoryId)) {
					removedMemoryIds.add(memoryId);
				}
			}
			const projectionsDirectory = join(this.memoryDirectory, "projections");
			const memoriesDirectory = join(projectionsDirectory, "memories");
			const manifestPath = join(projectionsDirectory, "manifest.json");
			const indexPath = join(projectionsDirectory, "index.md");
			await mkdir(memoriesDirectory, { recursive: true });

			let manifest: MemoryProjectionManifestV1;
			let indexMarkdown: string;
			try {
				manifest = validateProjectionManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
				indexMarkdown = await readFile(indexPath, "utf8");
				if (sha256(indexMarkdown) !== manifest.indexDigest) {
					throw new MemoryValidationError("Memory Markdown index does not match its projection manifest");
				}
			} catch (error) {
				if (!isRecord(error) || error.code !== "ENOENT") throw error;
				const unchanged = readModel.memories.filter((reference) => !changedMemoryIds.has(reference.memoryId));
				if (unchanged.length > 0) {
					throw new MemoryValidationError(
						"Memory projections require explicit repair before incremental publication",
					);
				}
				manifest = {
					schema: "pi-xk.memory-projection-manifest.v1",
					head: { sequence: 0, hash: null },
					memoryCount: 0,
					indexDigest: sha256(""),
					memories: [],
				};
				indexMarkdown = "";
			}

			const currentById = new Map(readModel.memories.map((reference) => [reference.memoryId, reference] as const));
			const manifestById = new Map(manifest.memories.map((entry) => [entry.memoryId, entry] as const));
			for (const entry of manifest.memories) {
				if (changedMemoryIds.has(entry.memoryId) || removedMemoryIds.has(entry.memoryId)) continue;
				const current = currentById.get(entry.memoryId);
				if (!current || current.revision !== entry.revision) {
					throw new MemoryValidationError("Memory projection manifest has an unrelated stale revision");
				}
			}
			for (const current of readModel.memories) {
				if (changedMemoryIds.has(current.memoryId)) continue;
				const projected = manifestById.get(current.memoryId);
				if (!projected || projected.revision !== current.revision) {
					throw new MemoryValidationError("Memory projection manifest is missing an unchanged revision");
				}
			}

			const existingLines = indexMarkdown.split("\n");
			const lineByMemoryId = new Map<string, string>();
			for (const entry of manifest.memories) {
				const href = `](memories/${entry.memoryId}.md) - `;
				const matching = existingLines.filter((line) => line.includes(href));
				if (matching.length !== 1) {
					throw new MemoryValidationError(`Memory Markdown index entry is invalid: ${entry.memoryId}`);
				}
				lineByMemoryId.set(entry.memoryId, matching[0]!);
			}

			const targetReferences = readModel.memories.filter((reference) => changedMemoryIds.has(reference.memoryId));
			const cueIds = new Set(readModel.cues.map((reference) => reference.cueId));
			const changedMemories = await this.store.readMemoriesByReferences(targetReferences, (cueId) =>
				cueIds.has(cueId),
			);
			for (const memory of changedMemories) {
				const markdown = this.renderMemoryMarkdown(memory);
				await this.replaceFile(join(memoriesDirectory, `${memory.revision.memoryId}.md`), markdown);
				manifestById.set(memory.revision.memoryId, {
					memoryId: memory.revision.memoryId,
					revision: memory.revision.revision,
					digest: sha256(markdown),
				});
				lineByMemoryId.set(memory.revision.memoryId, this.renderMemoryIndexLine(memory));
			}
			for (const memoryId of removedMemoryIds) {
				manifestById.delete(memoryId);
				lineByMemoryId.delete(memoryId);
				await rm(join(memoriesDirectory, `${memoryId}.md`), { force: true });
			}

			const projectedMemories = readModel.memories.map((reference) => {
				const entry = manifestById.get(reference.memoryId);
				if (!entry || entry.revision !== reference.revision) {
					throw new MemoryValidationError(`Memory projection is incomplete: ${reference.memoryId}`);
				}
				return entry;
			});
			const orderedLines = readModel.memories.map((reference) => {
				const line = lineByMemoryId.get(reference.memoryId);
				if (!line) throw new MemoryValidationError(`Memory Markdown index is incomplete: ${reference.memoryId}`);
				return line;
			});
			const nextIndexMarkdown = [
				"# Pi-XK Memory",
				"",
				"> Derived index. Artifact Store objects and the Memory event log are authoritative.",
				"",
				...orderedLines,
				"",
			].join("\n");
			await this.replaceFile(indexPath, nextIndexMarkdown);
			const nextManifest: MemoryProjectionManifestV1 = {
				schema: "pi-xk.memory-projection-manifest.v1",
				head: readModel.head,
				memoryCount: projectedMemories.length,
				indexDigest: sha256(nextIndexMarkdown),
				memories: projectedMemories,
			};
			validateProjectionManifest(nextManifest);
			await this.replaceFile(manifestPath, `${JSON.stringify(nextManifest, null, "\t")}\n`);
			return { markdownFiles: changedMemories.length + 1 };
		});
	}

	async repairProjections(): Promise<{ index: MemoryIndexStatusV1; markdownFiles: number }> {
		return await this.withProjectionMutation(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const readModel = (await this.store.loadReadModelSnapshot()).readModel;
				const index = await this.ensureIndexForReadModel(readModel);
				const cueIds = new Set(readModel.cues.map((reference) => reference.cueId));
				const memories = await this.store.readMemoriesByReferences(readModel.memories, (cueId) =>
					cueIds.has(cueId),
				);
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
				const manifest: MemoryProjectionManifestV1 = {
					schema: "pi-xk.memory-projection-manifest.v1",
					head: readModel.head,
					memoryCount: memories.length,
					indexDigest: sha256(indexMarkdown),
					memories: projectedMemories,
				};
				validateProjectionManifest(manifest);
				await this.replaceFile(
					join(projectionsDirectory, "manifest.json"),
					`${JSON.stringify(manifest, null, "\t")}\n`,
				);
				const latestHead = (await this.store.loadReadModelSnapshot()).readModel.head;
				if (latestHead.sequence === readModel.head.sequence && latestHead.hash === readModel.head.hash) {
					return { index: await index.status(), markdownFiles: memories.length + 1 };
				}
			}
			throw new MemoryValidationError("Memory facts changed repeatedly while projections were being repaired");
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
						skipped: 0,
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
				skipped: 0,
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
