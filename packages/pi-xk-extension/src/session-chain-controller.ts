import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as PiSessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
	assertSessionBranchId,
	assertSessionChainId,
	assertSessionSegmentId,
	SEGMENT_SUMMARY_SCHEMA,
	SESSION_CHAIN_SPEC_SCHEMA,
	type SegmentSummaryV1,
	type SessionBranchProjectionV1,
	type SessionChainActor,
	type SessionChainReplay,
	SessionChainStore,
	type SessionSegmentDescriptorV1,
	type SessionSegmentProjectionV1,
} from "pi-xk-core";
import { isPiXkSessionLink } from "./session-link.ts";

export const PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE = "pi-xk.session-chain-link";
export const PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE = "pi-xk.session-chain-summary-in";
export const PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE = "pi-xk.session-chain-summary-out";
export const PI_XK_SESSION_CHAIN_LINK_SCHEMA = "pi-xk.session-chain-link.v1";
export const PI_XK_SESSION_CHAIN_MARKER_SCHEMA = "pi-xk.session-chain-marker.v1";
export const SESSION_CHAIN_SUMMARY_PROMPT_VERSION = "session-chain-summary-v1";
export const SESSION_CHAIN_ROOT_SUMMARY = "No previous Session Chain segment.";

export const SESSION_CHAIN_SOFT_BYTES = 16 * 1024 * 1024;
export const SESSION_CHAIN_SOFT_ENTRIES = 4_000;
export const SESSION_CHAIN_HARD_BYTES = 64 * 1024 * 1024;
export const SESSION_CHAIN_HARD_ENTRIES = 16_000;

const GOAL_SESSION_LINK_CUSTOM_TYPE = "pi-xk.session-link";

export type SessionChainThreshold = "none" | "soft" | "hard";

export interface SessionChainThresholdInput {
	bytes: number;
	entries: number;
}

export interface PiXkSessionChainBindingV1 {
	schema: typeof PI_XK_SESSION_CHAIN_LINK_SCHEMA;
	kind: "segment_link";
	chainId: string;
	branchId: string;
	segmentId: string;
	ordinal: number;
	predecessorSegmentId: string | null;
	summaryInArtifactId: string | null;
	createdAt: string;
}

export interface PiXkSessionChainSummaryInV1 {
	schema: typeof PI_XK_SESSION_CHAIN_MARKER_SCHEMA;
	kind: "summary_in";
	artifactId: string | null;
	carryForwardHash: string;
}

export interface PiXkSessionChainSummaryOutV1 {
	schema: typeof PI_XK_SESSION_CHAIN_MARKER_SCHEMA;
	kind: "summary_out";
	artifactId: string;
	targetSegmentId: string;
	sourceLeafId: string;
	segmentDeltaMarkdown: string;
	carryForwardMarkdown: string;
	segmentDeltaHash: string;
	carryForwardHash: string;
}

export interface SessionChainGateState {
	taskRunning: boolean;
	taskResultPending: boolean;
	goalDraftPending: boolean;
	goalLifecycleIntentPending: boolean;
}

export interface SessionChainSummarizeOptions {
	messages: AgentMessage[];
	previousSummary?: string;
	customInstructions?: string;
	maxOutputTokens: number;
	signal?: AbortSignal;
}

export interface SessionChainSummarizeResult {
	summary: string;
	model: { provider: string; modelId: string };
	thinkingLevel: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface SessionChainRolloverCommitContext {
	sourceSessionFile: string;
	sourceSessionId: string;
	sourceLeafId: string | null;
	targetSessionFile: string;
	targetSessionId: string;
	targetLeafId: string | null;
}

export interface SessionChainRolloverHostOptions {
	targetSessionFile: string;
	targetSessionId: string;
	reason: string;
	initializeTarget: (sessionManager: SessionManager) => Promise<void> | void;
	finalizeSource: (sessionManager: SessionManager) => Promise<void> | void;
	commit: (context: SessionChainRolloverCommitContext) => Promise<void> | void;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
}

export type SessionChainRolloverHostResult =
	| { cancelled: true }
	| ({ cancelled: false } & SessionChainRolloverCommitContext);

export interface SessionChainHost {
	readonly sessionManager: SessionManager;
	readonly model: { contextWindow: number } | undefined;
	summarizeSessionContext(options: SessionChainSummarizeOptions): Promise<SessionChainSummarizeResult>;
	rolloverSession(options: SessionChainRolloverHostOptions): Promise<SessionChainRolloverHostResult>;
}

export type CreateSessionManagerAt = (cwd: string, sessionFile: string, options: { id: string }) => SessionManager;

export interface SessionChainControllerOptions {
	projectRoot: string;
	store?: SessionChainStore;
	now?: () => string;
	createSessionManagerAt?: CreateSessionManagerAt;
}

export interface SessionChainRootOptions {
	title?: string | null;
	initializeTarget?: (sessionManager: SessionManager) => Promise<void> | void;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
}

export interface SessionChainManagedRootOptions {
	chainId?: string;
	branchId?: string;
	segmentId?: string;
	title?: string | null;
}

export interface SessionChainManagedRoot {
	binding: PiXkSessionChainBindingV1;
	sessionManager: SessionManager;
	sessionFile: string;
}

export interface SessionChainRolloverOptions {
	reason: string;
	actor?: SessionChainActor;
	gates?: Partial<SessionChainGateState>;
	initializeTarget?: (sessionManager: SessionManager) => Promise<void> | void;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
}

export interface SessionChainRolloverResult {
	cancelled: boolean;
	chainId: string;
	branchId: string;
	sourceSegmentId: string;
	sourceLeafId: string;
	targetSegmentId: string;
	summaryArtifactId: string;
}

export interface SessionChainBranchOptions {
	reason: string;
	sourceEntryId: string;
	actor?: SessionChainActor;
	gates?: Partial<SessionChainGateState>;
	initializeTarget?: (sessionManager: SessionManager) => Promise<void> | void;
	withSession?: (ctx: ExtensionCommandContext) => Promise<void>;
}

export interface SessionChainBranchSource {
	chainId: string;
	branchId: string;
	segmentId: string;
}

export interface SessionChainCreateBranchOptions {
	reason: string;
	source: SessionChainBranchSource;
	sourceEntryId?: string;
	actor?: SessionChainActor;
	gates?: Partial<SessionChainGateState>;
	initializeTarget?: (sessionManager: SessionManager) => Promise<void> | void;
}

export interface SessionChainCreatedBranchResult {
	chainId: string;
	fromBranchId: string;
	branchId: string;
	sourceSegmentId: string;
	sourceEntryId: string;
	targetSegmentId: string;
	summaryArtifactId: string;
	sessionFile: string;
}

export interface SessionChainBranchResult {
	cancelled: boolean;
	chainId: string;
	fromBranchId: string;
	branchId: string;
	sourceSegmentId: string;
	sourceEntryId: string;
	targetSegmentId: string;
	summaryArtifactId: string;
}

export interface SessionChainRecoveryResult {
	action: "none" | "aborted" | "committed" | "rebuilt-and-committed";
	chainId: string;
	branchId: string;
	targetSegmentId: string | null;
}

export interface SessionChainDiagnostic {
	severity: "warning" | "error";
	code: string;
	message: string;
	branchId?: string;
	segmentId?: string;
}

export interface SessionChainDoctorReport {
	chainId: string;
	diagnostics: SessionChainDiagnostic[];
}

export interface SessionChainCurrentStatus {
	chainId: string;
	title: string | null;
	branchId: string;
	segmentId: string;
	ordinal: number;
	segmentStatus: SessionSegmentProjectionV1["status"];
	sessionFile: string;
	bytes: number;
	entries: number;
	threshold: SessionChainThreshold;
	writableHead: boolean;
	pendingRolloverTargetSegmentId: string | null;
	summaryInArtifactId: string | null;
}

interface SummarySelection {
	baseSummary: string;
	baseSummaryArtifactId: string | null;
	sourceEntries: SessionEntry[];
	messages: AgentMessage[];
	firstEntryId: string;
	lastEntryId: string;
	entriesHash: string;
}

interface ParsedSummaryEnvelope {
	segmentDeltaMarkdown: string;
	carryForwardMarkdown: string;
}

export class SessionChainControllerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionChainControllerError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
	return value === null || isNonEmptyString(value);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function hasSafeBindingIds(
	chainId: unknown,
	branchId: unknown,
	segmentId: unknown,
	predecessorSegmentId: unknown,
): boolean {
	if (
		typeof chainId !== "string" ||
		typeof branchId !== "string" ||
		typeof segmentId !== "string" ||
		(predecessorSegmentId !== null && typeof predecessorSegmentId !== "string")
	) {
		return false;
	}
	try {
		assertSessionChainId(chainId);
		assertSessionBranchId(branchId);
		assertSessionSegmentId(segmentId);
		if (predecessorSegmentId !== null) assertSessionSegmentId(predecessorSegmentId);
		return true;
	} catch {
		return false;
	}
}

export function isPiXkSessionChainBinding(value: unknown): value is PiXkSessionChainBindingV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"schema",
			"kind",
			"chainId",
			"branchId",
			"segmentId",
			"ordinal",
			"predecessorSegmentId",
			"summaryInArtifactId",
			"createdAt",
		]) &&
		value.schema === PI_XK_SESSION_CHAIN_LINK_SCHEMA &&
		value.kind === "segment_link" &&
		hasSafeBindingIds(value.chainId, value.branchId, value.segmentId, value.predecessorSegmentId) &&
		typeof value.ordinal === "number" &&
		Number.isInteger(value.ordinal) &&
		value.ordinal > 0 &&
		isNullableNonEmptyString(value.predecessorSegmentId) &&
		(value.summaryInArtifactId === null || isHash(value.summaryInArtifactId)) &&
		isNonEmptyString(value.createdAt) &&
		!Number.isNaN(Date.parse(value.createdAt))
	);
}

function isSummaryInMarker(value: unknown): value is PiXkSessionChainSummaryInV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["schema", "kind", "artifactId", "carryForwardHash"]) &&
		value.schema === PI_XK_SESSION_CHAIN_MARKER_SCHEMA &&
		value.kind === "summary_in" &&
		(value.artifactId === null || isHash(value.artifactId)) &&
		isHash(value.carryForwardHash)
	);
}

function isSummaryOutMarker(value: unknown): value is PiXkSessionChainSummaryOutV1 {
	return (
		isRecord(value) &&
		hasExactKeys(value, [
			"schema",
			"kind",
			"artifactId",
			"targetSegmentId",
			"sourceLeafId",
			"segmentDeltaMarkdown",
			"carryForwardMarkdown",
			"segmentDeltaHash",
			"carryForwardHash",
		]) &&
		value.schema === PI_XK_SESSION_CHAIN_MARKER_SCHEMA &&
		value.kind === "summary_out" &&
		isHash(value.artifactId) &&
		isNonEmptyString(value.targetSegmentId) &&
		isNonEmptyString(value.sourceLeafId) &&
		isNonEmptyString(value.segmentDeltaMarkdown) &&
		isNonEmptyString(value.carryForwardMarkdown) &&
		isHash(value.segmentDeltaHash) &&
		isHash(value.carryForwardHash)
	);
}

function hashText(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function flushSessionDurably(manager: SessionManager): void {
	const compatible = manager as SessionManager & { flushDurable?: () => void };
	if (!compatible.flushDurable) {
		throw new SessionChainControllerError("Session Chain requires a coding-agent Host with durable session flush");
	}
	compatible.flushDurable();
}

function hashEntries(entries: readonly SessionEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`, "utf8");
	return `sha256:${hash.digest("hex")}`;
}

async function hashFile(path: string): Promise<string> {
	return `sha256:${createHash("sha256")
		.update(await readFile(path))
		.digest("hex")}`;
}

function parseSummaryEnvelope(summary: string): ParsedSummaryEnvelope {
	const match =
		/^\s*<segment-delta>\s*([\s\S]*?)\s*<\/segment-delta>\s*<carry-forward>\s*([\s\S]*?)\s*<\/carry-forward>\s*$/.exec(
			summary,
		);
	const segmentDeltaMarkdown = match?.[1]?.trim();
	const carryForwardMarkdown = match?.[2]?.trim();
	if (!segmentDeltaMarkdown || !carryForwardMarkdown) {
		throw new SessionChainControllerError(
			"Session Chain summarizer returned an invalid summary envelope; expected segment-delta and carry-forward blocks",
		);
	}
	return { segmentDeltaMarkdown, carryForwardMarkdown };
}

function summaryBudget(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		throw new SessionChainControllerError("Session Chain summary requires a positive model context window");
	}
	return Math.min(8_192, Math.max(2_048, Math.floor(contextWindow * 0.05)));
}

export function evaluateSessionChainThreshold(input: SessionChainThresholdInput): SessionChainThreshold {
	if (input.bytes >= SESSION_CHAIN_HARD_BYTES || input.entries >= SESSION_CHAIN_HARD_ENTRIES) return "hard";
	if (input.bytes >= SESSION_CHAIN_SOFT_BYTES || input.entries >= SESSION_CHAIN_SOFT_ENTRIES) return "soft";
	return "none";
}

function eventToken(): string {
	return randomUUID().replaceAll("-", "");
}

export function createSessionChainId(): string {
	return `chain_${eventToken().slice(0, 20)}`;
}

export function createSessionChainBranchId(): string {
	return `branch_${eventToken().slice(0, 20)}`;
}

export function createSessionChainSegmentId(): string {
	return randomUUID();
}

function bindingFor(chainId: string, branchId: string, segment: SessionSegmentDescriptorV1): PiXkSessionChainBindingV1 {
	return {
		schema: PI_XK_SESSION_CHAIN_LINK_SCHEMA,
		kind: "segment_link",
		chainId,
		branchId,
		segmentId: segment.segmentId,
		ordinal: segment.ordinal,
		predecessorSegmentId: segment.predecessorSegmentId,
		summaryInArtifactId: segment.summaryInArtifactId,
		createdAt: segment.createdAt,
	};
}

function findBranch(replay: SessionChainReplay, branchId: string): SessionBranchProjectionV1 {
	const branch = replay.branches.find((candidate) => candidate.branchId === branchId);
	if (!branch) throw new SessionChainControllerError(`Session Chain branch not found: ${branchId}`);
	return branch;
}

function findSegment(branch: SessionBranchProjectionV1, segmentId: string): SessionSegmentProjectionV1 {
	const segment = branch.segments.find((candidate) => candidate.segmentId === segmentId);
	if (!segment) throw new SessionChainControllerError(`Session Chain Segment not found: ${segmentId}`);
	return segment;
}

function latestEntry<TEntry extends SessionEntry["type"]>(
	entries: readonly SessionEntry[],
	type: TEntry,
): Extract<SessionEntry, { type: TEntry }> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === type) return entry as Extract<SessionEntry, { type: TEntry }>;
	}
	return undefined;
}

function copySessionProjection(source: SessionManager, target: SessionManager, sourceEntryId?: string): void {
	const sourceBranch = source.getBranch(sourceEntryId);
	const model = latestEntry(sourceBranch, "model_change");
	if (model) target.appendModelChange(model.provider, model.modelId);
	const thinking = latestEntry(sourceBranch, "thinking_level_change");
	if (thinking) target.appendThinkingLevelChange(thinking.thinkingLevel);
	const sessionInfo = latestEntry(sourceBranch, "session_info");
	if (sessionInfo?.name !== undefined) target.appendSessionInfo(sessionInfo.name);
	for (let index = sourceBranch.length - 1; index >= 0; index--) {
		const entry = sourceBranch[index];
		if (
			entry?.type === "custom" &&
			entry.customType === GOAL_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkSessionLink(entry.data)
		) {
			target.appendCustomEntry(GOAL_SESSION_LINK_CUSTOM_TYPE, entry.data);
			break;
		}
	}
}

function hasOnlyBootstrapProjectionEntries(manager: SessionManager): boolean {
	return manager
		.getEntries()
		.every(
			(entry) =>
				entry.type === "model_change" || entry.type === "thinking_level_change" || entry.type === "session_info",
		);
}

function appendSummaryIn(manager: SessionManager, artifactId: string | null, carryForward: string): string {
	const details: PiXkSessionChainSummaryInV1 = {
		schema: PI_XK_SESSION_CHAIN_MARKER_SCHEMA,
		kind: "summary_in",
		artifactId,
		carryForwardHash: hashText(carryForward),
	};
	return manager.appendCustomMessageEntry(PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE, carryForward, false, details);
}

function findSummaryInEntry(manager: SessionManager, binding: PiXkSessionChainBindingV1) {
	for (const entry of manager.getBranch()) {
		if (
			entry.type === "custom_message" &&
			entry.customType === PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE &&
			isSummaryInMarker(entry.details) &&
			entry.details.artifactId === binding.summaryInArtifactId
		) {
			const content =
				typeof entry.content === "string"
					? entry.content
					: entry.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("");
			if (hashText(content) !== entry.details.carryForwardHash) {
				throw new SessionChainControllerError("Session Chain summary-in content hash does not match its marker");
			}
			return { entry, content };
		}
	}
	throw new SessionChainControllerError(`Session Chain summary-in marker is missing for ${binding.segmentId}`);
}

function findSummaryOutEntry(
	manager: SessionManager,
	artifactId: string,
	targetSegmentId: string,
): { entry: Extract<SessionEntry, { type: "custom" }>; marker: PiXkSessionChainSummaryOutV1 } | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry?.type === "custom" &&
			entry.customType === PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE &&
			isSummaryOutMarker(entry.data) &&
			entry.data.artifactId === artifactId &&
			entry.data.targetSegmentId === targetSegmentId
		) {
			return { entry, marker: entry.data };
		}
	}
	return undefined;
}

export class SessionChainController {
	private readonly projectRoot: string;
	private readonly store: SessionChainStore;
	private readonly now: () => string;
	private readonly createSessionManagerAt: CreateSessionManagerAt;

	constructor(options: SessionChainControllerOptions) {
		this.projectRoot = resolve(options.projectRoot);
		this.store = options.store ?? new SessionChainStore(this.projectRoot);
		this.now = options.now ?? (() => new Date().toISOString());
		this.createSessionManagerAt =
			options.createSessionManagerAt ??
			((cwd, sessionFile, createOptions) => {
				const compatible = PiSessionManager as typeof PiSessionManager & {
					createAt?: CreateSessionManagerAt;
				};
				if (!compatible.createAt) {
					throw new SessionChainControllerError(
						"Session Chain recovery requires a coding-agent Host with exact-path session creation",
					);
				}
				return compatible.createAt(cwd, sessionFile, createOptions);
			});
	}

	getStore(): SessionChainStore {
		return this.store;
	}

	async getSegmentFile(chainId: string, branchId: string, segmentId: string): Promise<string> {
		const replay = await this.store.replayChain(chainId);
		const branch = findBranch(replay, branchId);
		const segment = findSegment(branch, segmentId);
		return this.segmentPath(chainId, branchId, segment);
	}

	async getBranchHeadFile(chainId: string, branchId: string): Promise<string> {
		const replay = await this.store.replayChain(chainId);
		const branch = findBranch(replay, branchId);
		return this.segmentPath(chainId, branchId, findSegment(branch, branch.headSegmentId));
	}

	private segmentPath(
		chainId: string,
		branchId: string,
		segment: Pick<SessionSegmentDescriptorV1, "location">,
	): string {
		if (segment.location.kind === "external-root") return resolve(segment.location.absolutePath);
		return join(
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
	}

	private managedSegment(
		segmentId: string,
		ordinal: number,
		predecessorSegmentId: string | null,
		summaryInArtifactId: string | null,
		createdAt: string,
	): SessionSegmentDescriptorV1 {
		return {
			segmentId,
			ordinal,
			location: { kind: "managed", fileName: `${String(ordinal).padStart(6, "0")}_${segmentId}.jsonl` },
			predecessorSegmentId,
			summaryInArtifactId,
			createdAt,
		};
	}

	getCurrentBinding(manager: SessionManager): PiXkSessionChainBindingV1 | null {
		const branch = manager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (
				entry?.type === "custom" &&
				entry.customType === PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE &&
				isPiXkSessionChainBinding(entry.data)
			) {
				return { ...entry.data };
			}
		}
		return null;
	}

	private appendRootMarkers(manager: SessionManager, binding: PiXkSessionChainBindingV1): void {
		manager.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, binding);
		appendSummaryIn(manager, null, SESSION_CHAIN_ROOT_SUMMARY);
	}

	async bootstrapManagedChain(
		host: SessionChainHost,
		options: SessionChainRootOptions = {},
	): Promise<PiXkSessionChainBindingV1> {
		if (this.getCurrentBinding(host.sessionManager)) {
			throw new SessionChainControllerError("Current Pi session is already bound to a Session Chain");
		}
		if (!hasOnlyBootstrapProjectionEntries(host.sessionManager)) {
			throw new SessionChainControllerError(
				"Managed Session Chain bootstrap requires a new Pi session without conversation body entries",
			);
		}
		const chainId = createSessionChainId();
		const branchId = createSessionChainBranchId();
		const createdAt = this.now();
		const segment = this.managedSegment(createSessionChainSegmentId(), 1, null, null, createdAt);
		const binding = bindingFor(chainId, branchId, segment);
		const targetSessionFile = this.segmentPath(chainId, branchId, segment);
		const result = await host.rolloverSession({
			targetSessionFile,
			targetSessionId: segment.segmentId,
			reason: "session-chain-bootstrap",
			initializeTarget: async (target) => {
				target.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, binding);
				copySessionProjection(host.sessionManager, target);
				await options.initializeTarget?.(target);
				appendSummaryIn(target, null, SESSION_CHAIN_ROOT_SUMMARY);
			},
			finalizeSource: () => {},
			commit: async () => {
				await this.store.createChain(
					{
						schema: SESSION_CHAIN_SPEC_SCHEMA,
						chainId,
						title: options.title ?? null,
						cwd: this.projectRoot,
						rootBranchId: branchId,
						rootSegment: segment,
						createdAt,
					},
					{
						eventId: `${chainId}:created`,
						idempotencyKey: `${chainId}:created`,
						actor: "runtime",
						timestamp: createdAt,
					},
				);
			},
			...(options.withSession ? { withSession: options.withSession } : {}),
		});
		if (result.cancelled) throw new SessionChainControllerError("Managed Session Chain bootstrap was cancelled");
		return binding;
	}

	async createManagedRoot(options: SessionChainManagedRootOptions = {}): Promise<SessionChainManagedRoot> {
		const chainId = options.chainId ?? createSessionChainId();
		const branchId = options.branchId ?? createSessionChainBranchId();
		const createdAt = this.now();
		const segment = this.managedSegment(options.segmentId ?? createSessionChainSegmentId(), 1, null, null, createdAt);
		const binding = bindingFor(chainId, branchId, segment);
		const sessionFile = this.segmentPath(chainId, branchId, segment);
		const sessionManager = this.createSessionManagerAt(this.projectRoot, sessionFile, { id: segment.segmentId });
		this.appendRootMarkers(sessionManager, binding);
		flushSessionDurably(sessionManager);
		await this.store.createChain(
			{
				schema: SESSION_CHAIN_SPEC_SCHEMA,
				chainId,
				title: options.title ?? null,
				cwd: this.projectRoot,
				rootBranchId: branchId,
				rootSegment: segment,
				createdAt,
			},
			{
				eventId: `${chainId}:created`,
				idempotencyKey: `${chainId}:created`,
				actor: "runtime",
				timestamp: createdAt,
			},
		);
		return { binding, sessionManager, sessionFile };
	}

	async adoptExternalRoot(
		manager: SessionManager,
		options: Omit<SessionChainRootOptions, "initializeTarget"> = {},
	): Promise<PiXkSessionChainBindingV1> {
		const existing = this.getCurrentBinding(manager);
		if (existing) return existing;
		const sessionFile = manager.getSessionFile();
		if (!manager.isPersisted() || !sessionFile) {
			throw new SessionChainControllerError("External Session Chain adoption requires a persisted Pi session");
		}
		const chainId = createSessionChainId();
		const branchId = createSessionChainBranchId();
		const createdAt = this.now();
		const segment: SessionSegmentDescriptorV1 = {
			segmentId: manager.getSessionId(),
			ordinal: 1,
			location: { kind: "external-root", absolutePath: resolve(sessionFile) },
			predecessorSegmentId: null,
			summaryInArtifactId: null,
			createdAt,
		};
		const binding = bindingFor(chainId, branchId, segment);
		this.appendRootMarkers(manager, binding);
		flushSessionDurably(manager);
		await this.store.createChain(
			{
				schema: SESSION_CHAIN_SPEC_SCHEMA,
				chainId,
				title: options.title ?? null,
				cwd: this.projectRoot,
				rootBranchId: branchId,
				rootSegment: segment,
				createdAt,
			},
			{
				eventId: `${chainId}:created`,
				idempotencyKey: `${chainId}:created`,
				actor: "runtime",
				timestamp: createdAt,
			},
		);
		return binding;
	}

	private async assertWritableHead(manager: SessionManager): Promise<{
		binding: PiXkSessionChainBindingV1;
		replay: SessionChainReplay;
		branch: SessionBranchProjectionV1;
		segment: SessionSegmentProjectionV1;
	}> {
		const binding = this.getCurrentBinding(manager);
		if (!binding) throw new SessionChainControllerError("Current Pi session is not bound to a Session Chain");
		if (manager.getSessionId() !== binding.segmentId) {
			throw new SessionChainControllerError("Current Pi session ID does not match its Session Chain binding");
		}
		const replay = await this.store.replayChain(binding.chainId);
		const branch = findBranch(replay, binding.branchId);
		const segment = findSegment(branch, binding.segmentId);
		if (branch.headSegmentId !== segment.segmentId || segment.status !== "active") {
			throw new SessionChainControllerError(
				"Current Session Chain Segment is sealed or is not the writable branch head",
			);
		}
		const actualPath = manager.getSessionFile();
		if (
			!actualPath ||
			resolve(actualPath) !== resolve(this.segmentPath(binding.chainId, binding.branchId, segment))
		) {
			throw new SessionChainControllerError("Current Pi session file does not match its Session Chain Segment");
		}
		return { binding, replay, branch, segment };
	}

	private assertGates(gates: Partial<SessionChainGateState> | undefined): void {
		const blocked = [
			gates?.taskRunning ? "running Task" : null,
			gates?.taskResultPending ? "pending Task result" : null,
			gates?.goalDraftPending ? "Goal draft" : null,
			gates?.goalLifecycleIntentPending ? "Goal lifecycle intent" : null,
		].filter((value): value is string => value !== null);
		if (blocked.length > 0) {
			throw new SessionChainControllerError(`Session Chain rollover is blocked by ${blocked.join(", ")}`);
		}
	}

	private buildSummarySelection(
		manager: SessionManager,
		binding: PiXkSessionChainBindingV1,
		segment: SessionSegmentProjectionV1,
		sourceLeafId: string,
	): SummarySelection {
		if (!manager.getEntry(sourceLeafId)) {
			throw new SessionChainControllerError(`Session Chain source entry does not exist: ${sourceLeafId}`);
		}
		const path = manager.getBranch(sourceLeafId);
		if (path.at(-1)?.id !== sourceLeafId) {
			throw new SessionChainControllerError("Session Chain source entry is not reachable from the selected Segment");
		}
		const summaryIn = findSummaryInEntry(manager, binding);
		let latestCompactionIndex = -1;
		for (let index = path.length - 1; index >= 0; index--) {
			if (path[index]?.type === "compaction") {
				latestCompactionIndex = index;
				break;
			}
		}
		let sourceStartIndex: number;
		let baseSummary: string;
		if (latestCompactionIndex >= 0) {
			const compaction = path[latestCompactionIndex];
			if (!compaction || compaction.type !== "compaction") {
				throw new SessionChainControllerError("Latest Pi compaction entry is invalid");
			}
			sourceStartIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
			if (sourceStartIndex < 0) {
				throw new SessionChainControllerError("Latest Pi compaction firstKeptEntryId is not on the active branch");
			}
			baseSummary = compaction.summary;
		} else {
			baseSummary = summaryIn.content;
			const summaryInIndex = path.findIndex((entry) => entry.id === summaryIn.entry.id);
			sourceStartIndex = segment.location.kind === "external-root" ? 0 : summaryInIndex + 1;
		}
		const sourceEntries = path.slice(sourceStartIndex);
		if (sourceEntries.length === 0) {
			throw new SessionChainControllerError("Session Chain Segment has no body entries to summarize");
		}
		const contextMessages = sourceEntries.flatMap((entry) => {
			if (
				entry.type === "compaction" ||
				(entry.type === "custom_message" && entry.customType === PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE) ||
				(entry.type === "custom" &&
					(entry.customType === PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE ||
						entry.customType === PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE))
			) {
				return [];
			}
			return sessionEntryToContextMessages(entry);
		});
		const timestamp = Date.now();
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "<segment-delta>" }], timestamp },
			...(contextMessages.length > 0
				? contextMessages
				: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Session entries changed: ${sourceEntries.map((entry) => entry.type).join(", ")}`,
								},
							],
							timestamp,
						},
					]),
			{ role: "user", content: [{ type: "text", text: "</segment-delta>" }], timestamp },
		];
		return {
			baseSummary,
			baseSummaryArtifactId: binding.summaryInArtifactId,
			sourceEntries,
			messages,
			firstEntryId: sourceEntries[0]?.id ?? sourceLeafId,
			lastEntryId: sourceLeafId,
			entriesHash: hashEntries(sourceEntries),
		};
	}

	private async createSegmentSummary(
		host: SessionChainHost,
		sourceManager: SessionManager,
		binding: PiXkSessionChainBindingV1,
		segment: SessionSegmentProjectionV1,
		targetSegmentId: string,
		sourceLeafId: string,
	): Promise<{ summary: SegmentSummaryV1; sourceLeafId: string }> {
		if (!host.model) throw new SessionChainControllerError("Session Chain rollover requires a selected model");
		const selection = this.buildSummarySelection(sourceManager, binding, segment, sourceLeafId);
		const maxOutputTokens = summaryBudget(host.model.contextWindow);
		const generated = await host.summarizeSessionContext({
			messages: selection.messages,
			previousSummary: selection.baseSummary,
			customInstructions: [
				"Treat <previous-summary> as the cumulative state before this Segment delta.",
				"Treat <segment-delta> as the only new source material.",
				"Return exactly two non-empty blocks in this order and no other text:",
				"<segment-delta>Markdown describing only this Segment's completed work, failures, decisions, and state changes.</segment-delta>",
				"<carry-forward>Markdown that integrates the previous summary with the Segment delta for the next Segment.</carry-forward>",
			].join("\n"),
			maxOutputTokens,
		});
		const afterSelection = this.buildSummarySelection(sourceManager, binding, segment, sourceLeafId);
		if (
			afterSelection.entriesHash !== selection.entriesHash ||
			afterSelection.lastEntryId !== selection.lastEntryId ||
			afterSelection.sourceEntries.length !== selection.sourceEntries.length
		) {
			throw new SessionChainControllerError("Session Chain source changed while its summary was being generated");
		}
		const envelope = parseSummaryEnvelope(generated.summary);
		const estimatedOutputTokens = Math.ceil(Buffer.byteLength(generated.summary, "utf8") / 4);
		if (Math.max(generated.usage.output, estimatedOutputTokens) > maxOutputTokens) {
			throw new SessionChainControllerError("Session Chain summary output exceeded its fixed token budget");
		}
		return {
			sourceLeafId,
			summary: {
				schema: SEGMENT_SUMMARY_SCHEMA,
				chainId: binding.chainId,
				branchId: binding.branchId,
				sourceSegmentId: binding.segmentId,
				sourceLeafId,
				targetSegmentId,
				baseSummaryArtifactId: selection.baseSummaryArtifactId,
				sourceRange: {
					firstEntryId: selection.firstEntryId,
					lastEntryId: selection.lastEntryId,
					entryCount: selection.sourceEntries.length,
					entriesHash: selection.entriesHash,
				},
				segmentDeltaMarkdown: envelope.segmentDeltaMarkdown,
				carryForwardMarkdown: envelope.carryForwardMarkdown,
				generator: {
					provider: generated.model.provider,
					modelId: generated.model.modelId,
					promptVersion: SESSION_CHAIN_SUMMARY_PROMPT_VERSION,
					inputTokens: generated.usage.input + generated.usage.cacheRead + generated.usage.cacheWrite,
					outputTokens: generated.usage.output,
					generatedAt: this.now(),
				},
			},
		};
	}

	private validateSummaryMarker(summary: SegmentSummaryV1, marker: PiXkSessionChainSummaryOutV1): void {
		if (
			marker.sourceLeafId !== summary.sourceLeafId ||
			marker.segmentDeltaMarkdown !== summary.segmentDeltaMarkdown ||
			marker.carryForwardMarkdown !== summary.carryForwardMarkdown ||
			marker.segmentDeltaHash !== hashText(summary.segmentDeltaMarkdown) ||
			marker.carryForwardHash !== hashText(summary.carryForwardMarkdown)
		) {
			throw new SessionChainControllerError("Session Chain summary-out marker does not match its summary artifact");
		}
	}

	private async sourceSeal(sourceManager: SessionManager, summaryArtifactId: string, summaryOutEntryId: string) {
		const sourceFile = sourceManager.getSessionFile();
		if (!sourceFile) throw new SessionChainControllerError("Session Chain source file is missing");
		if (sourceManager.getLeafId() !== summaryOutEntryId) {
			throw new SessionChainControllerError("Session Chain summary-out is not the source Segment leaf");
		}
		const fileStat = await stat(sourceFile);
		return {
			bytes: fileStat.size,
			fileHash: await hashFile(sourceFile),
			leafId: summaryOutEntryId,
			summaryArtifactId,
			summaryOutEntryId,
		};
	}

	private targetMarkers(
		targetManager: SessionManager,
		binding: PiXkSessionChainBindingV1,
		summary: SegmentSummaryV1,
	): { chainLinkEntryId: string; summaryInEntryId: string } {
		let chainLinkEntryId: string | undefined;
		let summaryInEntryId: string | undefined;
		for (const entry of targetManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE &&
				isPiXkSessionChainBinding(entry.data) &&
				entry.data.chainId === binding.chainId &&
				entry.data.branchId === binding.branchId &&
				entry.data.segmentId === binding.segmentId
			) {
				chainLinkEntryId = entry.id;
			}
			if (
				entry.type === "custom_message" &&
				entry.customType === PI_XK_SESSION_CHAIN_SUMMARY_IN_CUSTOM_TYPE &&
				isSummaryInMarker(entry.details) &&
				entry.details.artifactId === binding.summaryInArtifactId
			) {
				const content = typeof entry.content === "string" ? entry.content : "";
				if (
					content === summary.carryForwardMarkdown &&
					entry.details.carryForwardHash === hashText(summary.carryForwardMarkdown)
				) {
					summaryInEntryId = entry.id;
				}
			}
		}
		if (!chainLinkEntryId || !summaryInEntryId) {
			throw new SessionChainControllerError("Session Chain target markers are missing or do not match the summary");
		}
		if (targetManager.getLeafId() !== summaryInEntryId) {
			throw new SessionChainControllerError("Session Chain summary-in must be the target Segment leaf");
		}
		return { chainLinkEntryId, summaryInEntryId };
	}

	async rollover(host: SessionChainHost, options: SessionChainRolloverOptions): Promise<SessionChainRolloverResult> {
		if (!isNonEmptyString(options.reason)) throw new SessionChainControllerError("Rollover reason is required");
		this.assertGates(options.gates);
		const sourceManager = host.sessionManager;
		const { binding, replay, branch, segment } = await this.assertWritableHead(sourceManager);
		if (branch.pendingRollover) {
			throw new SessionChainControllerError("Session Chain recovery is required before another rollover");
		}
		const targetSegmentId = createSessionChainSegmentId();
		const sourceLeafId = sourceManager.getLeafId();
		if (!sourceLeafId) throw new SessionChainControllerError("Session Chain Segment has no source leaf to summarize");
		const generated = await this.createSegmentSummary(
			host,
			sourceManager,
			binding,
			segment,
			targetSegmentId,
			sourceLeafId,
		);
		const summaryArtifactId = await this.store.putSegmentSummary(generated.summary);
		const targetSegment = this.managedSegment(
			targetSegmentId,
			segment.ordinal + 1,
			segment.segmentId,
			summaryArtifactId,
			this.now(),
		);
		const targetBinding = bindingFor(binding.chainId, binding.branchId, targetSegment);
		const prepared = await this.store.appendRolloverPrepared(
			binding.chainId,
			{
				branchId: binding.branchId,
				sourceSegmentId: binding.segmentId,
				sourceLeafId: generated.sourceLeafId,
				targetSegment,
				summaryArtifactId,
				reason: options.reason,
			},
			{
				eventId: `${binding.chainId}:${targetSegmentId}:prepared`,
				idempotencyKey: `${binding.chainId}:${targetSegmentId}:prepared`,
				expectedHead: replay.head,
				actor: options.actor ?? "runtime",
				timestamp: this.now(),
			},
		);
		let summaryOutEntryId: string | undefined;
		try {
			const targetSessionFile = this.segmentPath(binding.chainId, binding.branchId, targetSegment);
			const hostResult = await host.rolloverSession({
				targetSessionFile,
				targetSessionId: targetSegmentId,
				reason: options.reason,
				initializeTarget: async (target) => {
					if (sourceManager.getLeafId() !== generated.sourceLeafId) {
						throw new SessionChainControllerError("Session Chain source changed before rollover freeze");
					}
					target.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, targetBinding);
					copySessionProjection(sourceManager, target);
					await options.initializeTarget?.(target);
					appendSummaryIn(target, summaryArtifactId, generated.summary.carryForwardMarkdown);
				},
				finalizeSource: () => {
					if (sourceManager.getLeafId() !== generated.sourceLeafId) {
						throw new SessionChainControllerError("Session Chain source changed before summary-out");
					}
					const marker: PiXkSessionChainSummaryOutV1 = {
						schema: PI_XK_SESSION_CHAIN_MARKER_SCHEMA,
						kind: "summary_out",
						artifactId: summaryArtifactId,
						targetSegmentId,
						sourceLeafId: generated.sourceLeafId,
						segmentDeltaMarkdown: generated.summary.segmentDeltaMarkdown,
						carryForwardMarkdown: generated.summary.carryForwardMarkdown,
						segmentDeltaHash: hashText(generated.summary.segmentDeltaMarkdown),
						carryForwardHash: hashText(generated.summary.carryForwardMarkdown),
					};
					summaryOutEntryId = sourceManager.appendCustomEntry(PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE, marker);
				},
				commit: async () => {
					if (!summaryOutEntryId) throw new SessionChainControllerError("Session Chain source was not finalized");
					const targetManager = PiSessionManager.open(targetSessionFile);
					const targetMarkers = this.targetMarkers(targetManager, targetBinding, generated.summary);
					const sourceSeal = await this.sourceSeal(sourceManager, summaryArtifactId, summaryOutEntryId);
					await this.store.appendRolloverCommitted(
						binding.chainId,
						{
							branchId: binding.branchId,
							sourceSegmentId: binding.segmentId,
							targetSegmentId,
							sourceSeal,
							targetMarkers,
						},
						{
							eventId: `${binding.chainId}:${targetSegmentId}:committed`,
							idempotencyKey: `${binding.chainId}:${targetSegmentId}:committed`,
							expectedHead: prepared.head,
							actor: "runtime",
							timestamp: this.now(),
						},
					);
				},
				...(options.withSession ? { withSession: options.withSession } : {}),
			});
			if (hostResult.cancelled) {
				await this.store.appendRolloverAborted(
					binding.chainId,
					{
						branchId: binding.branchId,
						sourceSegmentId: binding.segmentId,
						targetSegmentId,
						reason: "Host cancelled rollover before source finalization",
					},
					{
						eventId: `${binding.chainId}:${targetSegmentId}:aborted`,
						idempotencyKey: `${binding.chainId}:${targetSegmentId}:aborted`,
						expectedHead: prepared.head,
						actor: "runtime",
						timestamp: this.now(),
					},
				);
			}
			return {
				cancelled: hostResult.cancelled,
				chainId: binding.chainId,
				branchId: binding.branchId,
				sourceSegmentId: binding.segmentId,
				sourceLeafId: generated.sourceLeafId,
				targetSegmentId,
				summaryArtifactId,
			};
		} catch (error) {
			const current = await this.store.replayChain(binding.chainId);
			const currentBranch = findBranch(current, binding.branchId);
			if (currentBranch.pendingRollover?.targetSegment.segmentId === targetSegmentId) {
				const sourceOut = findSummaryOutEntry(sourceManager, summaryArtifactId, targetSegmentId);
				if (!sourceOut) {
					await this.store.appendRolloverAborted(
						binding.chainId,
						{
							branchId: binding.branchId,
							sourceSegmentId: binding.segmentId,
							targetSegmentId,
							reason: `Rollover failed before source finalization: ${error instanceof Error ? error.message : String(error)}`,
						},
						{
							eventId: `${binding.chainId}:${targetSegmentId}:aborted`,
							idempotencyKey: `${binding.chainId}:${targetSegmentId}:aborted`,
							expectedHead: current.head,
							actor: "runtime",
							timestamp: this.now(),
						},
					);
				}
			}
			throw error;
		}
	}

	private async assertSealedSegmentIntegrity(segment: SessionSegmentProjectionV1, sessionFile: string): Promise<void> {
		if (segment.status !== "sealed") return;
		if (!segment.seal) {
			throw new SessionChainControllerError(`Sealed Session Chain Segment has no seal: ${segment.segmentId}`);
		}
		const fileStat = await stat(sessionFile);
		if (fileStat.size !== segment.seal.bytes || (await hashFile(sessionFile)) !== segment.seal.fileHash) {
			throw new SessionChainControllerError(
				`Sealed Session Chain Segment was modified after commit: ${segment.segmentId}`,
			);
		}
	}

	async createSuccessorBranch(
		host: SessionChainHost,
		options: SessionChainCreateBranchOptions,
	): Promise<SessionChainCreatedBranchResult> {
		if (!isNonEmptyString(options.reason)) throw new SessionChainControllerError("Branch reason is required");
		this.assertGates(options.gates);
		assertSessionChainId(options.source.chainId);
		assertSessionBranchId(options.source.branchId);
		assertSessionSegmentId(options.source.segmentId);

		const replay = await this.store.replayChain(options.source.chainId);
		const sourceBranch = findBranch(replay, options.source.branchId);
		if (sourceBranch.pendingRollover) {
			throw new SessionChainControllerError("Session Chain recovery is required before creating a branch");
		}
		const sourceSegment = findSegment(sourceBranch, options.source.segmentId);
		if (sourceSegment.status === "prepared") {
			throw new SessionChainControllerError("A prepared Session Chain Segment cannot be used as a branch source");
		}
		const sourceSessionFile = this.segmentPath(options.source.chainId, options.source.branchId, sourceSegment);
		const activeSessionFile = host.sessionManager.getSessionFile();
		const sourceManager =
			activeSessionFile && resolve(activeSessionFile) === resolve(sourceSessionFile)
				? host.sessionManager
				: PiSessionManager.open(sourceSessionFile);
		const sourceBinding = this.getCurrentBinding(sourceManager);
		if (
			!sourceBinding ||
			sourceBinding.chainId !== options.source.chainId ||
			sourceBinding.branchId !== options.source.branchId ||
			sourceBinding.segmentId !== options.source.segmentId ||
			sourceManager.getSessionId() !== options.source.segmentId
		) {
			throw new SessionChainControllerError("Session Chain branch source transcript does not match its topology");
		}
		const sourceEntryId = options.sourceEntryId ?? sourceManager.getLeafId();
		if (!sourceEntryId || !sourceManager.getEntry(sourceEntryId)) {
			throw new SessionChainControllerError("Session Chain branch source entry does not exist");
		}
		await this.assertSealedSegmentIntegrity(sourceSegment, sourceSessionFile);

		const targetSegmentId = createSessionChainSegmentId();
		const targetBranchId = createSessionChainBranchId();
		const generated = await this.createSegmentSummary(
			host,
			sourceManager,
			sourceBinding,
			sourceSegment,
			targetSegmentId,
			sourceEntryId,
		);
		await this.assertSealedSegmentIntegrity(sourceSegment, sourceSessionFile);
		const summaryArtifactId = await this.store.putSegmentSummary(generated.summary);
		const createdAt = this.now();
		const targetSegment = this.managedSegment(
			targetSegmentId,
			1,
			sourceSegment.segmentId,
			summaryArtifactId,
			createdAt,
		);
		const targetBinding = bindingFor(options.source.chainId, targetBranchId, targetSegment);
		const targetSessionFile = this.segmentPath(options.source.chainId, targetBranchId, targetSegment);
		const targetManager = this.createSessionManagerAt(this.projectRoot, targetSessionFile, {
			id: targetSegmentId,
		});
		targetManager.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, targetBinding);
		copySessionProjection(sourceManager, targetManager, sourceEntryId);
		await options.initializeTarget?.(targetManager);
		appendSummaryIn(targetManager, summaryArtifactId, generated.summary.carryForwardMarkdown);
		flushSessionDurably(targetManager);
		this.targetMarkers(targetManager, targetBinding, generated.summary);

		try {
			await this.store.appendBranchCreated(
				options.source.chainId,
				{
					branchId: targetBranchId,
					fromBranchId: options.source.branchId,
					sourceSegmentId: options.source.segmentId,
					sourceEntryId,
					segment: targetSegment,
				},
				{
					eventId: `${options.source.chainId}:${targetBranchId}:created`,
					idempotencyKey: `${options.source.chainId}:${targetBranchId}:created`,
					expectedHead: replay.head,
					actor: options.actor ?? "user",
					timestamp: createdAt,
				},
			);
		} catch (error) {
			await rm(targetSessionFile, { force: true });
			throw error;
		}
		return {
			chainId: options.source.chainId,
			fromBranchId: options.source.branchId,
			branchId: targetBranchId,
			sourceSegmentId: options.source.segmentId,
			sourceEntryId,
			targetSegmentId,
			summaryArtifactId,
			sessionFile: targetSessionFile,
		};
	}

	async continueBranch(host: SessionChainHost, options: SessionChainBranchOptions): Promise<SessionChainBranchResult> {
		if (!isNonEmptyString(options.reason)) throw new SessionChainControllerError("Branch reason is required");
		if (!isNonEmptyString(options.sourceEntryId)) {
			throw new SessionChainControllerError("Branch source entry ID is required");
		}
		this.assertGates(options.gates);
		const sourceManager = host.sessionManager;
		const { binding, replay, branch, segment } = await this.assertWritableHead(sourceManager);
		if (branch.pendingRollover) {
			throw new SessionChainControllerError("Session Chain recovery is required before creating a branch");
		}
		if (
			sourceManager.getLeafId() !== options.sourceEntryId ||
			!sourceManager.getBranch().some((entry) => entry.id === options.sourceEntryId)
		) {
			throw new SessionChainControllerError("Session Chain branch source must be the current Segment leaf");
		}
		const targetSegmentId = createSessionChainSegmentId();
		const targetBranchId = createSessionChainBranchId();
		const sourceLeafId = sourceManager.getLeafId();
		if (!sourceLeafId) throw new SessionChainControllerError("Session Chain Segment has no source leaf to summarize");
		const generated = await this.createSegmentSummary(
			host,
			sourceManager,
			binding,
			segment,
			targetSegmentId,
			sourceLeafId,
		);
		const summaryArtifactId = await this.store.putSegmentSummary(generated.summary);
		const targetSegment = this.managedSegment(targetSegmentId, 1, segment.segmentId, summaryArtifactId, this.now());
		const targetBinding = bindingFor(binding.chainId, targetBranchId, targetSegment);
		const targetSessionFile = this.segmentPath(binding.chainId, targetBranchId, targetSegment);
		const hostResult = await host.rolloverSession({
			targetSessionFile,
			targetSessionId: targetSegmentId,
			reason: options.reason,
			initializeTarget: async (target) => {
				if (sourceManager.getLeafId() !== options.sourceEntryId) {
					throw new SessionChainControllerError("Session Chain branch source changed before rollover freeze");
				}
				target.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, targetBinding);
				copySessionProjection(sourceManager, target);
				await options.initializeTarget?.(target);
				appendSummaryIn(target, summaryArtifactId, generated.summary.carryForwardMarkdown);
			},
			finalizeSource: () => {
				if (sourceManager.getLeafId() !== options.sourceEntryId) {
					throw new SessionChainControllerError("Session Chain branch source changed before commit");
				}
			},
			commit: async () => {
				const targetManager = PiSessionManager.open(targetSessionFile);
				this.targetMarkers(targetManager, targetBinding, generated.summary);
				await this.store.appendBranchCreated(
					binding.chainId,
					{
						branchId: targetBranchId,
						fromBranchId: binding.branchId,
						sourceSegmentId: binding.segmentId,
						sourceEntryId: options.sourceEntryId,
						segment: targetSegment,
					},
					{
						eventId: `${binding.chainId}:${targetBranchId}:created`,
						idempotencyKey: `${binding.chainId}:${targetBranchId}:created`,
						expectedHead: replay.head,
						actor: options.actor ?? "user",
						timestamp: this.now(),
					},
				);
			},
			...(options.withSession ? { withSession: options.withSession } : {}),
		});
		return {
			cancelled: hostResult.cancelled,
			chainId: binding.chainId,
			fromBranchId: binding.branchId,
			branchId: targetBranchId,
			sourceSegmentId: binding.segmentId,
			sourceEntryId: options.sourceEntryId,
			targetSegmentId,
			summaryArtifactId,
		};
	}

	private initializeRecoveredTarget(
		source: SessionManager,
		target: SessionManager,
		binding: PiXkSessionChainBindingV1,
		summary: SegmentSummaryV1,
	): void {
		target.appendCustomEntry(PI_XK_SESSION_CHAIN_LINK_CUSTOM_TYPE, binding);
		copySessionProjection(source, target);
		appendSummaryIn(target, binding.summaryInArtifactId, summary.carryForwardMarkdown);
	}

	async recoverPending(chainId: string, branchId: string): Promise<SessionChainRecoveryResult> {
		const replay = await this.store.replayChain(chainId);
		const branch = findBranch(replay, branchId);
		const pending = branch.pendingRollover;
		if (!pending) return { action: "none", chainId, branchId, targetSegmentId: null };
		const sourceSegment = findSegment(branch, pending.sourceSegmentId);
		const sourcePath = this.segmentPath(chainId, branchId, sourceSegment);
		const sourceManager = PiSessionManager.open(sourcePath);
		const sourceOut = findSummaryOutEntry(sourceManager, pending.summaryArtifactId, pending.targetSegment.segmentId);
		if (!sourceOut) {
			await this.store.appendRolloverAborted(
				chainId,
				{
					branchId,
					sourceSegmentId: pending.sourceSegmentId,
					targetSegmentId: pending.targetSegment.segmentId,
					reason: "Recovered prepared rollover before source summary-out was written",
				},
				{
					eventId: `${chainId}:${pending.targetSegment.segmentId}:aborted`,
					idempotencyKey: `${chainId}:${pending.targetSegment.segmentId}:aborted`,
					expectedHead: replay.head,
					actor: "runtime",
					timestamp: this.now(),
				},
			);
			return { action: "aborted", chainId, branchId, targetSegmentId: pending.targetSegment.segmentId };
		}
		const summary = await this.store.readSegmentSummary(pending.summaryArtifactId);
		this.validateSummaryMarker(summary, sourceOut.marker);
		if (sourceManager.getLeafId() !== sourceOut.entry.id) {
			throw new SessionChainControllerError("Prepared source contains entries after summary-out");
		}
		const targetPath = this.segmentPath(chainId, branchId, pending.targetSegment);
		let targetExists = true;
		try {
			await stat(targetPath);
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
			targetExists = false;
		}
		let targetManager: SessionManager;
		if (targetExists) {
			targetManager = PiSessionManager.open(targetPath);
		} else {
			targetManager = this.createSessionManagerAt(this.projectRoot, targetPath, {
				id: pending.targetSegment.segmentId,
			});
			this.initializeRecoveredTarget(
				sourceManager,
				targetManager,
				bindingFor(chainId, branchId, pending.targetSegment),
				summary,
			);
			flushSessionDurably(targetManager);
		}
		const targetBinding = bindingFor(chainId, branchId, pending.targetSegment);
		const targetMarkers = this.targetMarkers(targetManager, targetBinding, summary);
		const sourceSeal = await this.sourceSeal(sourceManager, pending.summaryArtifactId, sourceOut.entry.id);
		await this.store.appendRolloverCommitted(
			chainId,
			{
				branchId,
				sourceSegmentId: pending.sourceSegmentId,
				targetSegmentId: pending.targetSegment.segmentId,
				sourceSeal,
				targetMarkers,
			},
			{
				eventId: `${chainId}:${pending.targetSegment.segmentId}:committed`,
				idempotencyKey: `${chainId}:${pending.targetSegment.segmentId}:committed`,
				expectedHead: replay.head,
				actor: "runtime",
				timestamp: this.now(),
			},
		);
		return {
			action: targetExists ? "committed" : "rebuilt-and-committed",
			chainId,
			branchId,
			targetSegmentId: pending.targetSegment.segmentId,
		};
	}

	async getThreshold(
		manager: SessionManager,
	): Promise<SessionChainThresholdInput & { threshold: SessionChainThreshold }> {
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new SessionChainControllerError("Session Chain threshold requires a persisted session");
		const bytes = (await stat(sessionFile)).size;
		const entries = manager.getEntries().length;
		return { bytes, entries, threshold: evaluateSessionChainThreshold({ bytes, entries }) };
	}

	async getCurrentStatus(manager: SessionManager): Promise<SessionChainCurrentStatus | null> {
		const binding = this.getCurrentBinding(manager);
		if (!binding) return null;
		const replay = await this.store.replayChain(binding.chainId);
		const branch = findBranch(replay, binding.branchId);
		const segment = findSegment(branch, binding.segmentId);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new SessionChainControllerError("Session Chain status requires a persisted session");
		const threshold = await this.getThreshold(manager);
		const pathMatches =
			resolve(sessionFile) === resolve(this.segmentPath(binding.chainId, binding.branchId, segment));
		return {
			chainId: binding.chainId,
			title: replay.title,
			branchId: binding.branchId,
			segmentId: binding.segmentId,
			ordinal: segment.ordinal,
			segmentStatus: segment.status,
			sessionFile: resolve(sessionFile),
			bytes: threshold.bytes,
			entries: threshold.entries,
			threshold: threshold.threshold,
			writableHead:
				pathMatches &&
				manager.getSessionId() === binding.segmentId &&
				branch.headSegmentId === binding.segmentId &&
				segment.status === "active",
			pendingRolloverTargetSegmentId: branch.pendingRollover?.targetSegment.segmentId ?? null,
			summaryInArtifactId: segment.summaryInArtifactId,
		};
	}

	async isCurrentWritableHead(manager: SessionManager): Promise<boolean> {
		return (await this.getCurrentStatus(manager))?.writableHead ?? false;
	}

	private addDiagnostic(
		diagnostics: SessionChainDiagnostic[],
		code: string,
		message: string,
		branchId: string,
		segmentId: string,
	): void {
		diagnostics.push({ severity: "error", code, message, branchId, segmentId });
	}

	private async diagnoseSegmentEvidence(
		chainId: string,
		branch: SessionBranchProjectionV1,
		segment: SessionSegmentProjectionV1,
		manager: SessionManager,
		binding: PiXkSessionChainBindingV1 | null,
		diagnostics: SessionChainDiagnostic[],
		readSummary: (artifactId: string) => Promise<SegmentSummaryV1>,
	): Promise<void> {
		if (binding) {
			try {
				const summaryIn = findSummaryInEntry(manager, binding);
				if (segment.summaryInArtifactId === null) {
					if (summaryIn.content !== SESSION_CHAIN_ROOT_SUMMARY) {
						this.addDiagnostic(
							diagnostics,
							"summary_in_content_mismatch",
							"Root Segment summary-in does not match the deterministic root summary",
							branch.branchId,
							segment.segmentId,
						);
					}
				} else {
					const baseSummary = await readSummary(segment.summaryInArtifactId);
					const acceptedSummaryBranches = new Set([
						branch.branchId,
						...(branch.forkedFrom ? [branch.forkedFrom.branchId] : []),
					]);
					if (
						baseSummary.chainId !== chainId ||
						!acceptedSummaryBranches.has(baseSummary.branchId) ||
						baseSummary.targetSegmentId !== segment.segmentId
					) {
						this.addDiagnostic(
							diagnostics,
							"base_summary_provenance_mismatch",
							"Segment summary-in artifact does not target this chain, branch, and Segment",
							branch.branchId,
							segment.segmentId,
						);
					}
					if (summaryIn.content !== baseSummary.carryForwardMarkdown) {
						this.addDiagnostic(
							diagnostics,
							"summary_in_content_mismatch",
							"Segment summary-in content does not match its carry-forward artifact",
							branch.branchId,
							segment.segmentId,
						);
					}
				}
			} catch (error) {
				this.addDiagnostic(
					diagnostics,
					"summary_in_invalid",
					error instanceof Error ? error.message : String(error),
					branch.branchId,
					segment.segmentId,
				);
			}
		}

		if (segment.status !== "sealed" || !segment.seal) return;
		let summary: SegmentSummaryV1;
		try {
			summary = await readSummary(segment.seal.summaryArtifactId);
		} catch (error) {
			this.addDiagnostic(
				diagnostics,
				"summary_artifact_invalid",
				error instanceof Error ? error.message : String(error),
				branch.branchId,
				segment.segmentId,
			);
			return;
		}
		if (
			summary.chainId !== chainId ||
			summary.branchId !== branch.branchId ||
			summary.sourceSegmentId !== segment.segmentId ||
			summary.sourceLeafId !== summary.sourceRange.lastEntryId ||
			summary.baseSummaryArtifactId !== segment.summaryInArtifactId
		) {
			this.addDiagnostic(
				diagnostics,
				"summary_provenance_mismatch",
				"Sealed Segment summary identity or base artifact does not match chain topology",
				branch.branchId,
				segment.segmentId,
			);
		}
		const targetSegment = branch.segments.find((candidate) => candidate.segmentId === summary.targetSegmentId);
		if (
			!targetSegment ||
			targetSegment.predecessorSegmentId !== segment.segmentId ||
			targetSegment.summaryInArtifactId !== segment.seal.summaryArtifactId
		) {
			this.addDiagnostic(
				diagnostics,
				"summary_target_mismatch",
				"Sealed Segment summary target does not match its successor Segment",
				branch.branchId,
				segment.segmentId,
			);
		}

		const sourcePath = manager.getBranch();
		const firstIndex =
			summary.sourceRange.firstEntryId === null
				? -1
				: sourcePath.findIndex((entry) => entry.id === summary.sourceRange.firstEntryId);
		const lastIndex = sourcePath.findIndex((entry) => entry.id === summary.sourceRange.lastEntryId);
		const sourceRange = firstIndex >= 0 && lastIndex >= firstIndex ? sourcePath.slice(firstIndex, lastIndex + 1) : [];
		if (
			firstIndex < 0 ||
			lastIndex < firstIndex ||
			sourceRange.length !== summary.sourceRange.entryCount ||
			hashEntries(sourceRange) !== summary.sourceRange.entriesHash
		) {
			this.addDiagnostic(
				diagnostics,
				"summary_source_range_mismatch",
				"Segment summary source range count or hash does not match the source transcript",
				branch.branchId,
				segment.segmentId,
			);
		}

		const summaryOutEntry = manager.getEntry(segment.seal.summaryOutEntryId);
		if (
			!summaryOutEntry ||
			summaryOutEntry.type !== "custom" ||
			summaryOutEntry.customType !== PI_XK_SESSION_CHAIN_SUMMARY_OUT_CUSTOM_TYPE ||
			!isSummaryOutMarker(summaryOutEntry.data)
		) {
			this.addDiagnostic(
				diagnostics,
				"summary_out_marker_invalid",
				"Sealed Segment summary-out entry is missing or invalid",
				branch.branchId,
				segment.segmentId,
			);
			return;
		}
		try {
			this.validateSummaryMarker(summary, summaryOutEntry.data);
			if (
				summaryOutEntry.data.artifactId !== segment.seal.summaryArtifactId ||
				summaryOutEntry.data.targetSegmentId !== summary.targetSegmentId ||
				summaryOutEntry.parentId !== summary.sourceLeafId
			) {
				throw new SessionChainControllerError(
					"Session Chain summary-out marker identity does not match its artifact or source leaf",
				);
			}
		} catch (error) {
			this.addDiagnostic(
				diagnostics,
				"summary_out_marker_mismatch",
				error instanceof Error ? error.message : String(error),
				branch.branchId,
				segment.segmentId,
			);
		}
	}

	async doctor(chainId: string): Promise<SessionChainDoctorReport> {
		const diagnostics: SessionChainDiagnostic[] = [];
		let replay: SessionChainReplay;
		try {
			replay = await this.store.replayChain(chainId);
		} catch (error) {
			return {
				chainId,
				diagnostics: [
					{
						severity: "error",
						code: "event_log_invalid",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
		if (replay.tailDiagnostic) {
			diagnostics.push({
				severity: "error",
				code: "event_log_partial_tail",
				message: `Session Chain event log has ${replay.tailDiagnostic.discardedBytes} trailing bytes`,
			});
		}
		const summaryCache = new Map<string, Promise<SegmentSummaryV1>>();
		const readSummary = (artifactId: string): Promise<SegmentSummaryV1> => {
			let pending = summaryCache.get(artifactId);
			if (!pending) {
				pending = this.store.readSegmentSummary(artifactId);
				summaryCache.set(artifactId, pending);
			}
			return pending;
		};
		for (const branch of replay.branches) {
			if (branch.pendingRollover) {
				diagnostics.push({
					severity: "warning",
					code: "rollover_recovery_required",
					message: `Prepared rollover to ${branch.pendingRollover.targetSegment.segmentId} requires recovery`,
					branchId: branch.branchId,
					segmentId: branch.pendingRollover.sourceSegmentId,
				});
			}
			for (const segment of branch.segments) {
				const path = this.segmentPath(chainId, branch.branchId, segment);
				let bytes: number;
				let fileHash: string;
				try {
					const fileStat = await stat(path);
					bytes = fileStat.size;
					fileHash = await hashFile(path);
				} catch (error) {
					diagnostics.push({
						severity: "error",
						code: "segment_file_missing",
						message: error instanceof Error ? error.message : String(error),
						branchId: branch.branchId,
						segmentId: segment.segmentId,
					});
					continue;
				}
				if (segment.status === "sealed" && segment.seal) {
					if (bytes !== segment.seal.bytes) {
						diagnostics.push({
							severity: "error",
							code: "sealed_file_size_mismatch",
							message: `Sealed Segment size changed from ${segment.seal.bytes} to ${bytes}`,
							branchId: branch.branchId,
							segmentId: segment.segmentId,
						});
					}
					if (fileHash !== segment.seal.fileHash) {
						diagnostics.push({
							severity: "error",
							code: "sealed_file_hash_mismatch",
							message: `Sealed Segment hash changed from ${segment.seal.fileHash} to ${fileHash}`,
							branchId: branch.branchId,
							segmentId: segment.segmentId,
						});
					}
				}
				try {
					const manager = PiSessionManager.open(path);
					const binding = this.getCurrentBinding(manager);
					if (
						!binding ||
						binding.chainId !== chainId ||
						binding.branchId !== branch.branchId ||
						binding.segmentId !== segment.segmentId ||
						binding.ordinal !== segment.ordinal ||
						binding.predecessorSegmentId !== segment.predecessorSegmentId ||
						binding.summaryInArtifactId !== segment.summaryInArtifactId ||
						binding.createdAt !== segment.createdAt
					) {
						diagnostics.push({
							severity: "error",
							code: "segment_link_mismatch",
							message: "Segment chain link is missing or does not match the chain topology",
							branchId: branch.branchId,
							segmentId: segment.segmentId,
						});
					}
					if (segment.status === "sealed" && segment.seal && manager.getLeafId() !== segment.seal.leafId) {
						diagnostics.push({
							severity: "error",
							code: "sealed_leaf_mismatch",
							message: "Sealed Segment leaf no longer matches its committed seal",
							branchId: branch.branchId,
							segmentId: segment.segmentId,
						});
					}
					await this.diagnoseSegmentEvidence(chainId, branch, segment, manager, binding, diagnostics, readSummary);
				} catch (error) {
					diagnostics.push({
						severity: "error",
						code: "segment_jsonl_invalid",
						message: error instanceof Error ? error.message : String(error),
						branchId: branch.branchId,
						segmentId: segment.segmentId,
					});
				}
			}
		}
		return { chainId, diagnostics };
	}
}
