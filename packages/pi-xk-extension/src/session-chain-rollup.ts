import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	assertSessionBranchId,
	assertSessionChainId,
	assertSessionSegmentId,
	CHAIN_ROLLUP_SCHEMA,
	type SegmentSummary,
	type SessionBranchProjectionV1,
	SessionChainHeadConflictError,
	SessionChainLockedError,
	type SessionChainRollupV1,
	type SessionChainStore,
	type SessionSegmentProjectionV1,
} from "pi-xk-core";
import type { SessionChainHost } from "./session-chain-controller.ts";
import { SessionChainControllerError } from "./session-chain-errors.ts";
import {
	classifyRollupFailure,
	parseRollupEnvelope,
	renderRollupMarkdown,
	rollupSourceDigest,
	SESSION_CHAIN_L2_SUMMARIZATION_PROMPT,
	summaryBudget,
} from "./session-chain-summary.ts";

export const DEFAULT_SESSION_CHAIN_ROLLUP_INTERVAL = 5;
export const SESSION_CHAIN_ROLLUP_PROMPT_VERSION = "session-chain-rollup-v3";
export const MAX_AUTOMATIC_ROLLUP_ATTEMPTS = 3;

const SESSION_CHAIN_CONFIG_SCHEMA = "pi-xk.session-chain-config.v1";

interface StoredSessionChainConfigV1 {
	schema: typeof SESSION_CHAIN_CONFIG_SCHEMA;
	rollup: SessionChainRollupConfig;
}

interface PendingRollupPublicationV1 {
	schema: "pi-xk.session-chain-rollup-pending.v1";
	chainId: string;
	branchId: string;
	windowIndex: number;
	sourceDigest: string;
	artifactId: string;
}

interface SessionChainRollupRuntimeStateV1 {
	schema: "pi-xk.session-chain-rollup-state.v1";
	migrationBackfillEndOrdinal: number;
}

export type SessionChainRollupPublicationState = "scheduled" | "generating" | "artifact_ready" | "failed" | "published";

export interface SessionChainRollupPublicationV1 {
	schema: "pi-xk.session-chain-rollup-publication.v1";
	chainId: string;
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	segmentIds: string[];
	summaryArtifactIds: string[];
	sourceDigest: string;
	status: SessionChainRollupPublicationState;
	artifactId: string | null;
	attempt: number;
	errorCode: string | null;
	retryable: boolean | null;
	updatedAt: string;
}

export function isAutomaticRollupRetryExhausted(
	publication: Pick<SessionChainRollupPublicationV1, "status" | "attempt" | "errorCode" | "retryable">,
): boolean {
	return (
		publication.status === "failed" &&
		publication.errorCode === "rollup_invalid_response" &&
		publication.retryable === false &&
		publication.attempt >= MAX_AUTOMATIC_ROLLUP_ATTEMPTS
	);
}

export function formatSessionChainRollupPublicationStatus(
	publication: Pick<SessionChainRollupPublicationV1, "windowIndex" | "status" | "attempt" | "errorCode" | "retryable">,
): string {
	const details = [
		publication.errorCode,
		...(publication.attempt > 0 ? [`attempt=${publication.attempt}`] : []),
		...(isAutomaticRollupRetryExhausted(publication)
			? ["automatic retries exhausted"]
			: publication.status === "failed" && publication.retryable === false
				? ["manual repair required"]
				: publication.status === "failed" && publication.retryable === true
					? ["automatic retry pending"]
					: []),
	].filter((detail): detail is string => detail !== null);
	return `W${publication.windowIndex} ${publication.status}${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
}

export interface SessionChainRollupConfig {
	enabled: boolean;
	interval: number;
}

interface SessionChainRollupWindow {
	chainId: string;
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	segments: Array<SessionSegmentProjectionV1 & { seal: NonNullable<SessionSegmentProjectionV1["seal"]> }>;
	summaries: SegmentSummary[];
	summaryArtifactIds: string[];
	sourceDigest: string;
}

interface SessionChainRollupManagerOptions {
	projectRoot: string;
	store: SessionChainStore;
	now: () => string;
	verifyL1SummaryEvidence: (
		chainId: string,
		branch: SessionBranchProjectionV1,
		segment: SessionSegmentProjectionV1,
	) => Promise<SegmentSummary>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHeadConflict(error: unknown): boolean {
	return (
		error instanceof SessionChainHeadConflictError ||
		(error instanceof Error && error.name === "SessionChainHeadConflictError")
	);
}

async function syncDerivedDirectory(directory: string): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(directory, "r");
	} catch (error) {
		if (
			process.platform === "win32" &&
			isRecord(error) &&
			["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(String(error.code))
		) {
			return;
		}
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		if (
			!(
				process.platform === "win32" &&
				isRecord(error) &&
				["EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(String(error.code))
			)
		) {
			throw error;
		}
	} finally {
		await handle.close();
	}
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function findBranch(
	projection: { branches: readonly SessionBranchProjectionV1[] },
	branchId: string,
): SessionBranchProjectionV1 {
	const branch = projection.branches.find((candidate) => candidate.branchId === branchId);
	if (!branch) throw new SessionChainControllerError(`Session Chain branch not found: ${branchId}`);
	return branch;
}

export class SessionChainRollupManager {
	private readonly projectRoot: string;
	private readonly store: SessionChainStore;
	private readonly now: () => string;
	private readonly verifyL1SummaryEvidence: SessionChainRollupManagerOptions["verifyL1SummaryEvidence"];
	private readonly publicationQueues = new Map<string, Promise<void>>();
	private readonly publicationErrors = new Map<string, unknown>();

	constructor(options: SessionChainRollupManagerOptions) {
		this.projectRoot = options.projectRoot;
		this.store = options.store;
		this.now = options.now;
		this.verifyL1SummaryEvidence = options.verifyL1SummaryEvidence;
	}

	private queueKey(chainId: string, branchId: string): string {
		return `${chainId}/${branchId}`;
	}

	private enqueuePublication(host: SessionChainHost, job: SessionChainRollupPublicationV1): void {
		const key = this.queueKey(job.chainId, job.branchId);
		const previous = this.publicationQueues.get(key) ?? Promise.resolve();
		const publication = previous
			.then(async () => {
				this.publicationErrors.delete(key);
				let current = job;
				for (;;) {
					await this.processPublication(host, current);
					const completed = await this.getPublication(current.chainId, current.branchId, current.windowIndex);
					if (completed?.status !== "published") return;
					const next = await this.ensureScheduledPublication(current.chainId, current.branchId);
					if (!next || next.windowIndex <= current.windowIndex || next.status === "failed") return;
					current = next;
				}
			})
			.catch((error: unknown) => {
				this.publicationErrors.set(key, error);
			});
		this.publicationQueues.set(key, publication);
		void publication.finally(() => {
			if (this.publicationQueues.get(key) === publication) this.publicationQueues.delete(key);
		});
	}

	async schedulePublication(host: SessionChainHost, chainId: string, branchId: string): Promise<void> {
		const key = this.queueKey(chainId, branchId);
		let job: SessionChainRollupPublicationV1 | null;
		try {
			job = await this.ensureScheduledPublication(chainId, branchId);
		} catch (error) {
			this.publicationErrors.set(key, error);
			return;
		}
		this.publicationErrors.delete(key);
		if (!job || job.status === "published" || (job.status === "failed" && job.retryable === false)) return;
		if (this.publicationQueues.has(key)) return;
		this.enqueuePublication(host, job);
	}

	async resumePublications(host: SessionChainHost, chainId: string, branchId: string): Promise<void> {
		await this.schedulePublication(host, chainId, branchId);
	}

	async waitForPublications(chainId?: string, branchId?: string): Promise<void> {
		for (;;) {
			const matchesKey = (key: string): boolean => {
				if (!chainId) return true;
				if (branchId) return key === this.queueKey(chainId, branchId);
				return key.startsWith(`${chainId}/`);
			};
			const publications = [...this.publicationQueues.entries()]
				.filter(([key]) => matchesKey(key))
				.map(([, publication]) => publication);
			if (publications.length > 0) {
				await Promise.all(publications);
				continue;
			}
			const failure = [...this.publicationErrors.entries()].find(([key]) => matchesKey(key));
			if (!failure) return;
			this.publicationErrors.delete(failure[0]);
			throw failure[1];
		}
	}

	private configPath(): string {
		return join(this.projectRoot, ".pi-xk", "session-chain.json");
	}

	async getConfig(): Promise<SessionChainRollupConfig> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.configPath(), "utf8")) as unknown;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") {
				return { enabled: true, interval: DEFAULT_SESSION_CHAIN_ROLLUP_INTERVAL };
			}
			throw new SessionChainControllerError(
				`Session Chain config is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, ["schema", "rollup"]) ||
			parsed.schema !== SESSION_CHAIN_CONFIG_SCHEMA ||
			!isRecord(parsed.rollup) ||
			!hasExactKeys(parsed.rollup, ["enabled", "interval"]) ||
			typeof parsed.rollup.enabled !== "boolean" ||
			typeof parsed.rollup.interval !== "number" ||
			!Number.isInteger(parsed.rollup.interval) ||
			parsed.rollup.interval <= 0
		) {
			throw new SessionChainControllerError("Session Chain config has an invalid Rollup definition");
		}
		return { enabled: parsed.rollup.enabled, interval: parsed.rollup.interval };
	}

	async setConfig(config: SessionChainRollupConfig): Promise<void> {
		if (typeof config.enabled !== "boolean" || !Number.isInteger(config.interval) || config.interval <= 0) {
			throw new SessionChainControllerError("Session Chain Rollup interval must be a positive integer");
		}
		const stored: StoredSessionChainConfigV1 = {
			schema: SESSION_CHAIN_CONFIG_SCHEMA,
			rollup: { enabled: config.enabled, interval: config.interval },
		};
		const path = this.configPath();
		const directory = join(this.projectRoot, ".pi-xk");
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.session-chain-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, `${JSON.stringify(stored, null, "\t")}\n`, { mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private directory(chainId: string, branchId: string): string {
		assertSessionChainId(chainId);
		assertSessionBranchId(branchId);
		return join(this.projectRoot, ".pi-xk", "sessions", "chains", chainId, "branches", branchId, "rollups");
	}

	markdownPath(chainId: string, branchId: string, windowIndex: number): string {
		return join(this.directory(chainId, branchId), `${String(windowIndex).padStart(6, "0")}.md`);
	}

	private pendingPath(chainId: string, branchId: string, windowIndex: number): string {
		return join(this.directory(chainId, branchId), `${String(windowIndex).padStart(6, "0")}.pending.json`);
	}

	private publicationPath(chainId: string, branchId: string, windowIndex: number): string {
		return join(this.directory(chainId, branchId), `${String(windowIndex).padStart(6, "0")}.job.json`);
	}

	private statePath(chainId: string, branchId: string): string {
		return join(this.directory(chainId, branchId), "state.json");
	}

	private async replaceDerivedFile(path: string, content: string): Promise<void> {
		const directory = dirname(path);
		await mkdir(directory, { recursive: true });
		const temporary = join(directory, `.${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
			await syncDerivedDirectory(directory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async writePublication(publication: SessionChainRollupPublicationV1): Promise<void> {
		await this.replaceDerivedFile(
			this.publicationPath(publication.chainId, publication.branchId, publication.windowIndex),
			`${JSON.stringify(publication, null, "\t")}\n`,
		);
	}

	async getPublication(
		chainId: string,
		branchId: string,
		windowIndex: number,
	): Promise<SessionChainRollupPublicationV1 | null> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.publicationPath(chainId, branchId, windowIndex), "utf8")) as unknown;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return null;
			throw error;
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, [
				"schema",
				"chainId",
				"branchId",
				"windowIndex",
				"startOrdinal",
				"endOrdinal",
				"segmentIds",
				"summaryArtifactIds",
				"sourceDigest",
				"status",
				"artifactId",
				"attempt",
				"errorCode",
				"retryable",
				"updatedAt",
			]) ||
			parsed.schema !== "pi-xk.session-chain-rollup-publication.v1" ||
			parsed.chainId !== chainId ||
			parsed.branchId !== branchId ||
			parsed.windowIndex !== windowIndex ||
			typeof parsed.startOrdinal !== "number" ||
			!Number.isInteger(parsed.startOrdinal) ||
			parsed.startOrdinal <= 0 ||
			typeof parsed.endOrdinal !== "number" ||
			!Number.isInteger(parsed.endOrdinal) ||
			parsed.endOrdinal < parsed.startOrdinal ||
			!Array.isArray(parsed.segmentIds) ||
			!parsed.segmentIds.every(isNonEmptyString) ||
			!Array.isArray(parsed.summaryArtifactIds) ||
			!parsed.summaryArtifactIds.every(isHash) ||
			parsed.segmentIds.length !== parsed.summaryArtifactIds.length ||
			!isHash(parsed.sourceDigest) ||
			!(["scheduled", "generating", "artifact_ready", "failed", "published"] as const).includes(
				parsed.status as SessionChainRollupPublicationState,
			) ||
			(parsed.artifactId !== null && !isHash(parsed.artifactId)) ||
			typeof parsed.attempt !== "number" ||
			!Number.isInteger(parsed.attempt) ||
			parsed.attempt < 0 ||
			(parsed.errorCode !== null && !isNonEmptyString(parsed.errorCode)) ||
			(parsed.retryable !== null && typeof parsed.retryable !== "boolean") ||
			!isNonEmptyString(parsed.updatedAt) ||
			Number.isNaN(Date.parse(parsed.updatedAt))
		) {
			throw new SessionChainControllerError("Session Chain Rollup publication state is invalid");
		}
		for (const segmentId of parsed.segmentIds) assertSessionSegmentId(segmentId);
		return parsed as unknown as SessionChainRollupPublicationV1;
	}

	async initializeState(chainId: string, branchId: string, migrationBackfillEndOrdinal = 0): Promise<void> {
		const path = this.statePath(chainId, branchId);
		await mkdir(this.directory(chainId, branchId), { recursive: true });
		const state: SessionChainRollupRuntimeStateV1 = {
			schema: "pi-xk.session-chain-rollup-state.v1",
			migrationBackfillEndOrdinal,
		};
		try {
			await writeFile(path, `${JSON.stringify(state, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
	}

	private async loadState(
		chainId: string,
		branchId: string,
		sealedThroughOrdinal: number,
		interval: number,
	): Promise<SessionChainRollupRuntimeStateV1> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.statePath(chainId, branchId), "utf8")) as unknown;
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
			const baseline = Math.floor(sealedThroughOrdinal / interval) * interval;
			await this.initializeState(chainId, branchId, baseline);
			parsed = JSON.parse(await readFile(this.statePath(chainId, branchId), "utf8")) as unknown;
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, ["schema", "migrationBackfillEndOrdinal"]) ||
			parsed.schema !== "pi-xk.session-chain-rollup-state.v1" ||
			typeof parsed.migrationBackfillEndOrdinal !== "number" ||
			!Number.isInteger(parsed.migrationBackfillEndOrdinal) ||
			parsed.migrationBackfillEndOrdinal < 0
		) {
			throw new SessionChainControllerError("Session Chain Rollup runtime state is invalid");
		}
		return {
			schema: "pi-xk.session-chain-rollup-state.v1",
			migrationBackfillEndOrdinal: parsed.migrationBackfillEndOrdinal,
		};
	}

	private async ensureScheduledPublication(
		chainId: string,
		branchId: string,
	): Promise<SessionChainRollupPublicationV1 | null> {
		const config = await this.getConfig();
		if (!config.enabled) return null;
		const readModel = await this.store.loadChainReadModel(chainId);
		const branch = findBranch(readModel, branchId);
		const previous = branch.rollups.at(-1);
		const windowIndex = (previous?.windowIndex ?? 0) + 1;
		const existing = await this.getPublication(chainId, branchId, windowIndex);
		if (existing) {
			const expectedStartOrdinal = (previous?.endOrdinal ?? 0) + 1;
			const segments = branch.segments.filter(
				(segment) => segment.ordinal >= existing.startOrdinal && segment.ordinal <= existing.endOrdinal,
			);
			const segmentIds = segments.map((segment) => segment.segmentId);
			const summaryArtifactIds = segments.map((segment) => segment.seal?.summaryArtifactId);
			const sourceDigest = rollupSourceDigest({
				chainId,
				branchId,
				windowIndex,
				startOrdinal: existing.startOrdinal,
				endOrdinal: existing.endOrdinal,
				segmentIds,
				summaryArtifactIds: summaryArtifactIds.filter(
					(artifactId): artifactId is string => artifactId !== undefined,
				),
			});
			if (
				existing.startOrdinal !== expectedStartOrdinal ||
				segments.length !== existing.segmentIds.length ||
				segments.some((segment) => segment.status !== "sealed" || !segment.seal) ||
				existing.sourceDigest !== sourceDigest ||
				existing.segmentIds.some((segmentId, index) => segmentId !== segmentIds[index]) ||
				existing.summaryArtifactIds.some((artifactId, index) => artifactId !== summaryArtifactIds[index])
			) {
				throw new SessionChainControllerError("Session Chain Rollup publication sources changed");
			}
			return existing;
		}
		const sealedThroughOrdinal = branch.segments.reduce(
			(highest, segment) => (segment.status === "sealed" ? Math.max(highest, segment.ordinal) : highest),
			0,
		);
		const state = await this.loadState(chainId, branchId, sealedThroughOrdinal, config.interval);
		if ((previous?.endOrdinal ?? 0) < state.migrationBackfillEndOrdinal) return null;
		const startOrdinal = (previous?.endOrdinal ?? 0) + 1;
		const endOrdinal = startOrdinal + config.interval - 1;
		const segments: Array<SessionSegmentProjectionV1 & { seal: NonNullable<SessionSegmentProjectionV1["seal"]> }> =
			[];
		for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal++) {
			const segment = branch.segments.find((candidate) => candidate.ordinal === ordinal);
			if (!segment || segment.status !== "sealed" || !segment.seal) return null;
			segments.push({ ...segment, seal: segment.seal });
		}
		const segmentIds = segments.map((segment) => segment.segmentId);
		const summaryArtifactIds = segments.map((segment) => segment.seal.summaryArtifactId);
		const sourceDigest = rollupSourceDigest({
			chainId,
			branchId,
			windowIndex,
			startOrdinal,
			endOrdinal,
			segmentIds,
			summaryArtifactIds,
		});
		const publication: SessionChainRollupPublicationV1 = {
			schema: "pi-xk.session-chain-rollup-publication.v1",
			chainId,
			branchId,
			windowIndex,
			startOrdinal,
			endOrdinal,
			segmentIds,
			summaryArtifactIds,
			sourceDigest,
			status: "scheduled",
			artifactId: null,
			attempt: 0,
			errorCode: null,
			retryable: null,
			updatedAt: this.now(),
		};
		await this.writePublication(publication);
		return publication;
	}

	private async nextWindow(
		chainId: string,
		branchId: string,
		interval: number,
	): Promise<SessionChainRollupWindow | null> {
		const replay = await this.store.replayChain(chainId);
		const branch = findBranch(replay, branchId);
		const previous = branch.rollups.at(-1);
		const windowIndex = (previous?.windowIndex ?? 0) + 1;
		const startOrdinal = (previous?.endOrdinal ?? 0) + 1;
		const endOrdinal = startOrdinal + interval - 1;
		return await this.windowForRange(chainId, branchId, windowIndex, startOrdinal, endOrdinal);
	}

	private async windowForRange(
		chainId: string,
		branchId: string,
		windowIndex: number,
		startOrdinal: number,
		endOrdinal: number,
	): Promise<SessionChainRollupWindow | null> {
		const replay = await this.store.replayChain(chainId);
		const branch = findBranch(replay, branchId);
		const segments: SessionChainRollupWindow["segments"] = [];
		for (let ordinal = startOrdinal; ordinal <= endOrdinal; ordinal++) {
			const segment = branch.segments.find((candidate) => candidate.ordinal === ordinal);
			if (!segment || segment.status !== "sealed" || !segment.seal) return null;
			segments.push({ ...segment, seal: segment.seal });
		}
		const summaries: SegmentSummary[] = [];
		const summaryArtifactIds: string[] = [];
		for (const segment of segments) {
			const artifactId = segment.seal.summaryArtifactId;
			const summary = await this.verifyL1SummaryEvidence(chainId, branch, segment);
			summaries.push(summary);
			summaryArtifactIds.push(artifactId);
		}
		const sourceDigest = rollupSourceDigest({
			chainId,
			branchId,
			windowIndex,
			startOrdinal,
			endOrdinal,
			segmentIds: segments.map((segment) => segment.segmentId),
			summaryArtifactIds,
		});
		return {
			chainId,
			branchId,
			windowIndex,
			startOrdinal,
			endOrdinal,
			segments,
			summaries,
			summaryArtifactIds,
			sourceDigest,
		};
	}

	private async generateArtifact(host: SessionChainHost, window: SessionChainRollupWindow): Promise<string> {
		if (!host.model) throw new SessionChainControllerError("Session Chain Rollup requires a selected model");
		const timestamp = Date.now();
		const finalSummary = window.summaries.at(-1);
		if (!finalSummary) throw new SessionChainControllerError("Session Chain Rollup source window is empty");
		const source = {
			schema: "pi-xk.session-chain-rollup-source.v1",
			chainId: window.chainId,
			branchId: window.branchId,
			windowIndex: window.windowIndex,
			startOrdinal: window.startOrdinal,
			endOrdinal: window.endOrdinal,
			segmentDeltas: window.summaries.map((summary, index) => ({
				ordinal: window.startOrdinal + index,
				segmentId: summary.sourceSegmentId,
				artifactId: window.summaryArtifactIds[index],
				title: "title" in summary ? summary.title : null,
				markdown: summary.segmentDeltaMarkdown,
			})),
			finalCarryForward: {
				ordinal: window.endOrdinal,
				segmentId: finalSummary.sourceSegmentId,
				artifactId: window.summaryArtifactIds.at(-1),
				markdown: finalSummary.carryForwardMarkdown,
			},
		};
		const generated = await host.summarizeSessionContext({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: JSON.stringify(source),
						},
					],
					timestamp,
				},
			],
			customInstructions: SESSION_CHAIN_L2_SUMMARIZATION_PROMPT,
			replaceInstructions: true,
			maxOutputTokens: Math.min(4_000, summaryBudget(host.model.contextWindow)),
		});
		const rollup: SessionChainRollupV1 = {
			schema: CHAIN_ROLLUP_SCHEMA,
			chainId: window.chainId,
			branchId: window.branchId,
			windowIndex: window.windowIndex,
			startOrdinal: window.startOrdinal,
			endOrdinal: window.endOrdinal,
			segmentIds: window.segments.map((segment) => segment.segmentId),
			summaryArtifactIds: window.summaryArtifactIds,
			sourceDigest: window.sourceDigest,
			rollup: parseRollupEnvelope(generated.summary),
			provenance: {
				generator: "pi-xk",
				model: `${generated.model.provider}/${generated.model.modelId}`,
				promptVersion: SESSION_CHAIN_ROLLUP_PROMPT_VERSION,
				generatedAt: this.now(),
			},
		};
		return await this.store.putChainRollup(rollup);
	}

	private async windowForArtifact(
		artifactId: string,
		chainId: string,
		branchId: string,
		windowIndex: number,
	): Promise<SessionChainRollupWindow> {
		const rollup = await this.store.readChainRollup(artifactId);
		if (rollup.chainId !== chainId || rollup.branchId !== branchId || rollup.windowIndex !== windowIndex) {
			throw new SessionChainControllerError("Session Chain Rollup artifact identity changed");
		}
		const window = await this.windowForRange(chainId, branchId, windowIndex, rollup.startOrdinal, rollup.endOrdinal);
		if (!window) throw new SessionChainControllerError("Session Chain Rollup artifact sources are incomplete");
		if (
			rollup.segmentIds.some((segmentId, index) => segmentId !== window.segments[index]?.segmentId) ||
			rollup.summaryArtifactIds.some(
				(sourceArtifactId, index) => sourceArtifactId !== window.summaryArtifactIds[index],
			) ||
			rollup.sourceDigest !== window.sourceDigest
		) {
			throw new SessionChainControllerError("Session Chain Rollup artifact source digest changed");
		}
		return window;
	}

	async readOrphanedRollup(
		chainId: string,
		branchId: string,
		windowIndex: number,
	): Promise<{ artifactId: string; window: SessionChainRollupWindow } | null> {
		const artifactIds = await this.store.findChainRollupArtifacts({ chainId, branchId, windowIndex });
		for (const artifactId of artifactIds) {
			try {
				return {
					artifactId,
					window: await this.windowForArtifact(artifactId, chainId, branchId, windowIndex),
				};
			} catch {
				// Continue to another valid content-addressed candidate for the same window.
			}
		}
		if (artifactIds.length > 0) {
			throw new SessionChainControllerError("Session Chain orphaned Rollup sources no longer match the branch");
		}
		return null;
	}

	async readPendingRollup(
		chainId: string,
		branchId: string,
		windowIndex: number,
	): Promise<{ artifactId: string; window: SessionChainRollupWindow } | null> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.pendingPath(chainId, branchId, windowIndex), "utf8")) as unknown;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return null;
			throw error;
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, ["schema", "chainId", "branchId", "windowIndex", "sourceDigest", "artifactId"]) ||
			parsed.schema !== "pi-xk.session-chain-rollup-pending.v1" ||
			parsed.chainId !== chainId ||
			parsed.branchId !== branchId ||
			parsed.windowIndex !== windowIndex ||
			!isHash(parsed.sourceDigest) ||
			!isHash(parsed.artifactId)
		) {
			throw new SessionChainControllerError("Session Chain pending Rollup publication is invalid");
		}
		const window = await this.windowForArtifact(parsed.artifactId, chainId, branchId, windowIndex);
		if (window.sourceDigest !== parsed.sourceDigest) {
			throw new SessionChainControllerError("Session Chain pending Rollup source digest changed");
		}
		return { artifactId: parsed.artifactId, window };
	}

	private async writePending(window: SessionChainRollupWindow, artifactId: string): Promise<void> {
		const pending: PendingRollupPublicationV1 = {
			schema: "pi-xk.session-chain-rollup-pending.v1",
			chainId: window.chainId,
			branchId: window.branchId,
			windowIndex: window.windowIndex,
			sourceDigest: window.sourceDigest,
			artifactId,
		};
		await this.replaceDerivedFile(
			this.pendingPath(window.chainId, window.branchId, window.windowIndex),
			`${JSON.stringify(pending, null, "\t")}\n`,
		);
	}

	private async recordFailure(
		window: Pick<SessionChainRollupWindow, "chainId" | "branchId" | "windowIndex" | "startOrdinal" | "endOrdinal">,
		stage: string,
		error: unknown,
	): Promise<void> {
		const classification = classifyRollupFailure(stage, error);
		for (let conflictAttempt = 0; conflictAttempt < 3; conflictAttempt++) {
			const replay = await this.store.replayChain(window.chainId);
			const branch = findBranch(replay, window.branchId);
			const attempt =
				branch.rollupFailures.filter((failure) => failure.windowIndex === window.windowIndex).length + 1;
			try {
				await this.store.appendRollupFailed(
					window.chainId,
					{
						branchId: window.branchId,
						windowIndex: window.windowIndex,
						startOrdinal: window.startOrdinal,
						endOrdinal: window.endOrdinal,
						stage,
						errorCode: classification.errorCode,
						retryable: classification.retryable,
						attempt,
					},
					{
						eventId: `${window.chainId}:${window.branchId}:rollup:${window.windowIndex}:failed:${attempt}`,
						idempotencyKey: `${window.chainId}:${window.branchId}:rollup:${window.windowIndex}:failed:${attempt}`,
						expectedHead: replay.head,
						actor: "runtime",
						timestamp: this.now(),
					},
				);
				return;
			} catch (appendError) {
				if (!isHeadConflict(appendError) || conflictAttempt === 2) throw appendError;
			}
		}
	}

	private async processPublication(host: SessionChainHost, scheduled: SessionChainRollupPublicationV1): Promise<void> {
		try {
			await this.store.withRollupGenerationLock(
				scheduled.chainId,
				scheduled.branchId,
				scheduled.windowIndex,
				async () => this.processPublicationLocked(host, scheduled),
			);
			return;
		} catch (error) {
			if (!(error instanceof SessionChainLockedError)) throw error;
		}
		const diagnostic = await this.store.inspectRollupGenerationLock(
			scheduled.chainId,
			scheduled.branchId,
			scheduled.windowIndex,
		);
		if (!diagnostic || diagnostic.ownerState !== "missing" || !diagnostic.nonce) return;
		await this.store.repairAbandonedRollupGenerationLock(
			scheduled.chainId,
			scheduled.branchId,
			scheduled.windowIndex,
			diagnostic.nonce,
		);
		await this.store.withRollupGenerationLock(
			scheduled.chainId,
			scheduled.branchId,
			scheduled.windowIndex,
			async () => this.processPublicationLocked(host, scheduled),
		);
	}

	private async processPublicationLocked(
		host: SessionChainHost,
		scheduled: SessionChainRollupPublicationV1,
	): Promise<void> {
		let job = (await this.getPublication(scheduled.chainId, scheduled.branchId, scheduled.windowIndex)) ?? scheduled;
		if (job.status === "published" || (job.status === "failed" && job.retryable === false)) return;
		const recoverOrphan = job.status === "generating";
		let replay = await this.store.replayChain(job.chainId);
		let branch = findBranch(replay, job.branchId);
		const existing = branch.rollups.find(
			(rollup) => rollup.windowIndex === job.windowIndex && rollup.sourceDigest === job.sourceDigest,
		);
		if (existing) {
			await this.writePublication({
				...job,
				status: "published",
				artifactId: existing.artifactId,
				errorCode: null,
				retryable: null,
				updatedAt: this.now(),
			});
			return;
		}
		if (!(await this.getConfig()).enabled) {
			if (job.status === "generating") {
				await this.writePublication({ ...job, status: "scheduled", updatedAt: this.now() });
			}
			return;
		}
		job = {
			...job,
			status: "generating",
			attempt: job.attempt + 1,
			errorCode: null,
			retryable: null,
			updatedAt: this.now(),
		};
		await this.writePublication(job);
		await this.publishNext(
			host,
			job.chainId,
			job.branchId,
			"auto",
			job,
			async (artifactId) => {
				job = {
					...job,
					status: "artifact_ready",
					artifactId,
					updatedAt: this.now(),
				};
				await this.writePublication(job);
			},
			recoverOrphan,
		);
		replay = await this.store.replayChain(job.chainId);
		branch = findBranch(replay, job.branchId);
		const published = branch.rollups.find(
			(rollup) => rollup.windowIndex === job.windowIndex && rollup.sourceDigest === job.sourceDigest,
		);
		if (published) {
			await this.writePublication({
				...job,
				status: "published",
				artifactId: published.artifactId,
				errorCode: null,
				retryable: null,
				updatedAt: this.now(),
			});
			return;
		}
		const failure = branch.rollupFailures
			.filter((candidate) => candidate.windowIndex === job.windowIndex)
			.sort((left, right) => right.attempt - left.attempt)[0];
		if (!failure) {
			await this.writePublication({ ...job, status: "scheduled", updatedAt: this.now() });
			return;
		}
		await this.writePublication({
			...job,
			status: "failed",
			errorCode: failure.errorCode,
			retryable:
				failure.retryable &&
				(failure.errorCode !== "rollup_invalid_response" || job.attempt < MAX_AUTOMATIC_ROLLUP_ATTEMPTS),
			updatedAt: this.now(),
		});
	}

	private async publishNext(
		host: SessionChainHost,
		chainId: string,
		branchId: string,
		mode: "auto" | "backfill" = "auto",
		publication?: SessionChainRollupPublicationV1,
		onArtifactReady?: (artifactId: string) => Promise<void>,
		recoverOrphan = false,
	): Promise<boolean> {
		const config = await this.getConfig();
		if (!config.enabled && mode === "auto") return false;
		const initialReplay = await this.store.replayChain(chainId);
		const initialBranch = findBranch(initialReplay, branchId);
		const sealedThroughOrdinal = initialBranch.segments.reduce(
			(highest, segment) => (segment.status === "sealed" ? Math.max(highest, segment.ordinal) : highest),
			0,
		);
		const state = await this.loadState(chainId, branchId, sealedThroughOrdinal, config.interval);
		if (
			mode === "auto" &&
			!publication &&
			(initialBranch.rollups.at(-1)?.endOrdinal ?? 0) < state.migrationBackfillEndOrdinal
		) {
			return false;
		}
		const previous = initialBranch.rollups.at(-1);
		const expectedWindow = publication ?? {
			chainId,
			branchId,
			windowIndex: (previous?.windowIndex ?? 0) + 1,
			startOrdinal: (previous?.endOrdinal ?? 0) + 1,
			endOrdinal: (previous?.endOrdinal ?? 0) + config.interval,
		};
		let stage = "source_validation";
		try {
			const pending = await this.readPendingRollup(chainId, branchId, expectedWindow.windowIndex);
			const publicationArtifact =
				!pending && publication?.artifactId
					? {
							artifactId: publication.artifactId,
							window: await this.windowForArtifact(
								publication.artifactId,
								chainId,
								branchId,
								expectedWindow.windowIndex,
							),
						}
					: null;
			const configuredWindow = pending
				? null
				: publication
					? await this.windowForRange(
							chainId,
							branchId,
							publication.windowIndex,
							publication.startOrdinal,
							publication.endOrdinal,
						)
					: await this.nextWindow(chainId, branchId, config.interval);
			if (!pending && !configuredWindow && mode === "auto") return false;
			const orphaned =
				pending || publicationArtifact || (!recoverOrphan && mode !== "backfill")
					? null
					: await this.readOrphanedRollup(chainId, branchId, expectedWindow.windowIndex);
			const window = pending?.window ?? publicationArtifact?.window ?? orphaned?.window ?? configuredWindow;
			if (!window) return false;
			stage = "artifact_generation";
			let artifactId = pending?.artifactId ?? publicationArtifact?.artifactId ?? orphaned?.artifactId ?? null;
			let pendingWritten = false;
			if (!artifactId) {
				artifactId = await this.generateArtifact(host, window);
				await this.writePending(window, artifactId);
				pendingWritten = true;
				await onArtifactReady?.(artifactId);
			}
			if (!pending && !pendingWritten) {
				await this.writePending(window, artifactId);
			}
			stage = "event_publication";
			const replay = await this.store.replayChain(chainId);
			await this.store.appendRollupPublished(
				chainId,
				{
					branchId,
					windowIndex: window.windowIndex,
					startOrdinal: window.startOrdinal,
					endOrdinal: window.endOrdinal,
					artifactId,
					sourceDigest: window.sourceDigest,
				},
				{
					eventId: `${chainId}:${branchId}:rollup:${window.windowIndex}:published`,
					idempotencyKey: `${chainId}:${branchId}:rollup:${window.windowIndex}:${window.sourceDigest}:published`,
					expectedHead: replay.head,
					actor: "runtime",
					timestamp: this.now(),
				},
			);
			await rm(this.pendingPath(chainId, branchId, window.windowIndex), { force: true });
			stage = "markdown_projection";
			const rollup = await this.store.readChainRollup(artifactId);
			await this.replaceDerivedFile(
				this.markdownPath(chainId, branchId, window.windowIndex),
				renderRollupMarkdown(artifactId, rollup),
			);
			return true;
		} catch (error) {
			await this.recordFailure(expectedWindow, stage, error);
			return false;
		}
	}

	async backfill(host: SessionChainHost, chainId: string, branchId: string, limit = 1): Promise<number> {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new SessionChainControllerError("Session Chain Rollup backfill limit must be a positive integer");
		}
		await this.waitForPublications(chainId, branchId);
		let published = 0;
		while (published < limit && (await this.publishNext(host, chainId, branchId, "backfill"))) published += 1;
		return published;
	}

	async repairProjections(chainId: string): Promise<string[]> {
		const replay = await this.store.replayChain(chainId);
		const repaired: string[] = [];
		for (const branch of replay.branches) {
			for (const projection of branch.rollups) {
				const rollup = await this.store.readChainRollup(projection.artifactId);
				if (
					rollup.chainId !== chainId ||
					rollup.branchId !== branch.branchId ||
					rollup.windowIndex !== projection.windowIndex ||
					rollup.sourceDigest !== projection.sourceDigest
				) {
					continue;
				}
				const expected = renderRollupMarkdown(projection.artifactId, rollup);
				const path = this.markdownPath(chainId, branch.branchId, projection.windowIndex);
				let current: string | undefined;
				try {
					current = await readFile(path, "utf8");
				} catch (error) {
					if (!isRecord(error) || error.code !== "ENOENT") throw error;
				}
				if (current === expected) continue;
				await this.replaceDerivedFile(path, expected);
				repaired.push(`${branch.branchId}/W${projection.windowIndex}: rebuilt Markdown projection`);
			}
		}
		return repaired;
	}
}
