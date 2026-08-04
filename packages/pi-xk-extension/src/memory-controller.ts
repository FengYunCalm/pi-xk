import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	ArtifactStore,
	captureGitFreshnessBasis,
	type EvidenceRefV1,
	type EvidenceRefV2,
	MEMORY_CAPTURE_SOURCE_SCHEMA,
	MEMORY_EVIDENCE_REF_SCHEMA,
	type MemoryCaptureSourceV1,
	type MemoryCaptureStatus,
	type MemoryChangeOperationV1,
	type MemoryChangeProposalV1,
	type MemoryEvidenceSourceType,
	type MemoryExpectedRevisionV1,
	MemoryHeadConflictError,
	MemoryLockedError,
	type MemoryReadResultV1,
	MemoryRevisionConflictError,
	type MemoryScopeV1,
	MemoryService,
	MemoryValidationError,
	type MemoryWriteResult,
	stableJsonStringify,
	validateEvidenceRefV1,
	validateMemoryChangeProposalV1,
} from "pi-xk-core";
import {
	buildMemoryCaptureReview,
	MEMORY_CAPTURE_PROMPT,
	MEMORY_CAPTURE_PROMPT_VERSION,
	parseMemoryCaptureEnvelope,
} from "./memory-prompt.ts";

const MEMORY_CAPTURE_PENDING_V1_SCHEMA = "pi-xk.memory-capture-pending.v1";
const MEMORY_CAPTURE_PENDING_SCHEMA = "pi-xk.memory-capture-pending.v2";

export interface MemoryGenerationHost {
	model: { provider: string; modelId: string; contextWindow: number } | undefined;
	generate(input: { source: string; instructions: string; maxOutputTokens: number }): Promise<{
		text: string;
		model: { provider: string; modelId: string };
	}>;
}

export interface MemoryCaptureRequest {
	trigger: Exclude<MemoryCaptureSourceV1["trigger"], "explicit">;
	sourceType: Exclude<MemoryEvidenceSourceType, "explicit">;
	sourceId: string;
	artifactId: string;
	sourceDigest: string;
	locator: EvidenceRefV1["locator"];
	recordedAt: string;
	query: string;
	content: string;
	scope: Omit<MemoryScopeV1, "projectId">;
}

export interface MemoryCaptureResultV1 {
	captureId: string;
	status: MemoryCaptureStatus | "indeterminate" | "no_durable_memory";
	proposalId: string | null;
	confirmationRequired: boolean;
}

interface PendingCaptureResultV2 {
	schema: typeof MEMORY_CAPTURE_PENDING_SCHEMA;
	captureId: string;
	resultArtifactId: string;
	model: string;
	updatedAt: string;
}

type MemoryGitContext = {
	basis: Awaited<ReturnType<typeof captureGitFreshnessBasis>>;
	evidence: Extract<EvidenceRefV1, { sourceType: "git" }>;
};

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function suffix(digest: string): string {
	return digest.slice("sha256:".length, "sha256:".length + 32);
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function limitedMessage(error: unknown): string {
	return [...normalizeError(error).message.replace(/\s+/gu, " ").trim()].slice(0, 500).join("") || "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureFailure(
	error: unknown,
	stage: "source" | "generation" | "validation" | "artifact" | "publication" | "projection",
	attempt: number,
) {
	if (error instanceof MemoryRevisionConflictError) {
		return attempt >= 3
			? { errorCode: "memory_capture_revision_conflict_cooldown", retryable: false }
			: { errorCode: "memory_capture_revision_conflict", retryable: true };
	}
	if (error instanceof MemoryHeadConflictError) {
		return { errorCode: "memory_capture_event_head_conflict", retryable: true };
	}
	if (error instanceof MemoryValidationError) return { errorCode: "memory_capture_invalid", retryable: false };
	if (stage === "source") return { errorCode: "memory_capture_context_failed", retryable: true };
	if (stage === "validation") {
		return { errorCode: "memory_capture_invalid", retryable: false };
	}
	if (stage === "projection") return { errorCode: "memory_projection_failed", retryable: true };
	if (stage === "publication") return { errorCode: "memory_capture_publication_failed", retryable: true };
	if (stage === "artifact") return { errorCode: "memory_capture_artifact_failed", retryable: true };
	return { errorCode: "memory_capture_provider_failed", retryable: true };
}

export class MemoryController {
	private readonly projectRoot: string;
	private readonly pendingDirectory: string;
	private readonly service: MemoryService;
	private readonly artifacts: ArtifactStore;
	private readonly now: () => string;
	private readonly queueByCapture = new Map<string, Promise<MemoryCaptureResultV1>>();
	private publicationQueue: Promise<void> = Promise.resolve();

	constructor(options: { projectRoot: string; service?: MemoryService; now?: () => string }) {
		this.projectRoot = resolve(options.projectRoot);
		this.pendingDirectory = join(this.projectRoot, ".pi-xk", "memory", "pending");
		this.service = options.service ?? new MemoryService(this.projectRoot);
		this.artifacts = new ArtifactStore(this.projectRoot);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	getService(): MemoryService {
		return this.service;
	}

	async recordExternalProposal(input: {
		expectedEventHead: { sequence: number; hash: string | null };
		expectedRevisions: MemoryExpectedRevisionV1[];
		reason: string;
		operations: MemoryChangeOperationV1[];
		model: string;
	}): Promise<{ proposal: MemoryChangeProposalV1; proposalArtifactId: string; confirmationRequired: boolean }> {
		if (!(await this.service.getConfig()).enabled)
			throw new MemoryValidationError("Memory is disabled and read-only");
		const recordedAt = this.now();
		const sourceDigest = sha256(
			stableJsonStringify({
				reason: input.reason,
				expectedRevisions: input.expectedRevisions,
				operations: input.operations,
			}),
		);
		const provenance = {
			producer: "model" as const,
			model: input.model,
			promptVersion: "pi-xk.memory-model-proposal.v1",
			recordedAt,
		};
		const operations = input.operations.map((operation): MemoryChangeOperationV1 => {
			if (operation.kind === "publish_revision") {
				return {
					...operation,
					revision: { ...operation.revision, sourceDigest, provenance },
				};
			}
			if (operation.kind === "publish_cue") {
				return { ...operation, cue: { ...operation.cue, sourceDigest, provenance } };
			}
			if (operation.kind === "publish_edge") {
				return { ...operation, edge: { ...operation.edge, sourceDigest, provenance } };
			}
			return operation;
		});
		const proposal = validateMemoryChangeProposalV1({
			schema: "pi-xk.memory-change-proposal.v1",
			proposalId: `proposal_${suffix(sha256(`${sourceDigest}\0${recordedAt}`))}`,
			captureId: null,
			sourceDigest,
			expectedEventHead: input.expectedEventHead,
			expectedRevisions: input.expectedRevisions,
			reason: input.reason,
			operations,
			provenance,
		});
		const resultArtifact = await this.artifacts.put({
			contentType: "application/json",
			value: { schema: "pi-xk.memory-model-proposal-result.v1", proposal },
			producer: "pi-xk.memory-model-proposal.v1",
			sensitivity: "internal",
			sourceIds: [proposal.proposalId],
			createdAt: recordedAt,
		});
		const recorded = await this.service.recordProposal(proposal, resultArtifact.artifactId, {
			eventId: `evt_memory_proposal_${suffix(sha256(proposal.proposalId))}`,
			idempotencyKey: `memory:proposal:${proposal.proposalId}`,
			expectedHead: proposal.expectedEventHead,
			actor: "model",
			timestamp: recordedAt,
		});
		return {
			proposal: recorded.proposal,
			proposalArtifactId: recorded.proposalArtifactId,
			confirmationRequired: recorded.write.event.payload.confirmationRequired,
		};
	}

	async readProposal(proposalId: string): Promise<{
		proposal: MemoryChangeProposalV1;
		proposalArtifactId: string;
		confirmationRequired: boolean;
	}> {
		const replay = await this.service.getStore().replay();
		const record = replay.proposals.get(proposalId);
		if (!record) throw new MemoryValidationError(`Memory proposal not found: ${proposalId}`);
		const proposal = validateMemoryChangeProposalV1(
			JSON.parse((await this.artifacts.read(record.proposalArtifactId)).content) as unknown,
		);
		return {
			proposal,
			proposalArtifactId: record.proposalArtifactId,
			confirmationRequired: record.confirmationRequired,
		};
	}

	async confirmProposal(proposalId: string): Promise<void> {
		if (!(await this.service.getConfig()).enabled)
			throw new MemoryValidationError("Memory is disabled and read-only");
		const current = await this.readProposal(proposalId);
		const replay = await this.service.getStore().replay();
		const applied = await this.service.applyProposal(current.proposalArtifactId, {
			eventId: `evt_memory_apply_${suffix(sha256(proposalId))}`,
			idempotencyKey: `memory:apply:${proposalId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: this.now(),
			confirmed: true,
		});
		try {
			await this.service.synchronizeProjections({
				memoryIds: applied.write.event.payload.revisions.map((reference) => reference.memoryId),
				removeMemoryIds: (applied.write.event.payload.purges ?? []).map((purge) => purge.memoryId),
			});
		} catch (error) {
			if (current.proposal.captureId) await this.recordFailure(current.proposal.captureId, "projection", error);
		}
	}

	async rejectProposal(proposalId: string, reason: string): Promise<void> {
		if (!(await this.service.getConfig()).enabled)
			throw new MemoryValidationError("Memory is disabled and read-only");
		await this.readProposal(proposalId);
		const replay = await this.service.getStore().replay();
		await this.service.rejectProposal(proposalId, reason, {
			eventId: `evt_memory_reject_${suffix(sha256(proposalId))}`,
			idempotencyKey: `memory:reject:${proposalId}`,
			expectedHead: replay.head,
			actor: "user",
			timestamp: this.now(),
		});
	}

	private projectId(): string {
		return `project_${createHash("sha256").update(this.projectRoot).digest("hex").slice(0, 32)}`;
	}

	private pendingPath(captureId: string): string {
		return join(this.pendingDirectory, `${captureId}.json`);
	}

	private async replacePending(pending: PendingCaptureResultV2): Promise<void> {
		await mkdir(this.pendingDirectory, { recursive: true });
		const path = this.pendingPath(pending.captureId);
		const temporary = join(this.pendingDirectory, `.${pending.captureId}-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(pending, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async readPending(captureId: string, legacyModel: string | null): Promise<PendingCaptureResultV2 | null> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.pendingPath(captureId), "utf8")) as unknown;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return null;
			throw error;
		}
		if (!isRecord(value)) {
			throw new MemoryValidationError(`Memory pending capture is invalid: ${captureId}`);
		}
		if (
			value.captureId !== captureId ||
			typeof value.resultArtifactId !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(value.resultArtifactId) ||
			typeof value.updatedAt !== "string" ||
			Number.isNaN(Date.parse(value.updatedAt))
		) {
			throw new MemoryValidationError(`Memory pending capture is invalid: ${captureId}`);
		}
		const resultArtifactId = value.resultArtifactId;
		const updatedAt = value.updatedAt;
		if (
			value.schema === MEMORY_CAPTURE_PENDING_V1_SCHEMA &&
			Object.keys(value).sort().join(",") === "captureId,resultArtifactId,schema,updatedAt"
		) {
			if (!legacyModel) {
				throw new MemoryValidationError(`Legacy Memory pending capture requires a selected model: ${captureId}`);
			}
			const upgraded: PendingCaptureResultV2 = {
				schema: MEMORY_CAPTURE_PENDING_SCHEMA,
				captureId,
				resultArtifactId,
				model: legacyModel,
				updatedAt,
			};
			await this.replacePending(upgraded);
			return upgraded;
		}
		if (
			value.schema !== MEMORY_CAPTURE_PENDING_SCHEMA ||
			Object.keys(value).sort().join(",") !== "captureId,model,resultArtifactId,schema,updatedAt" ||
			typeof value.model !== "string" ||
			value.model.trim().length === 0
		) {
			throw new MemoryValidationError(`Memory pending capture is invalid: ${captureId}`);
		}
		return {
			schema: MEMORY_CAPTURE_PENDING_SCHEMA,
			captureId,
			resultArtifactId,
			model: value.model,
			updatedAt,
		};
	}

	private captureIdentity(request: MemoryCaptureRequest): { captureId: string; digest: string } {
		const digest = sha256(
			stableJsonStringify({
				schema: MEMORY_CAPTURE_SOURCE_SCHEMA,
				trigger: request.trigger,
				sourceType: request.sourceType,
				sourceId: request.sourceId,
				artifactId: request.artifactId,
				sourceDigest: request.sourceDigest,
				promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
			}),
		);
		return { captureId: `capture_${suffix(digest)}`, digest };
	}

	private evidence(request: MemoryCaptureRequest, captureDigest: string): EvidenceRefV1 {
		return validateEvidenceRefV1({
			schema: MEMORY_EVIDENCE_REF_SCHEMA,
			evidenceId: `evidence_${suffix(captureDigest)}`,
			sourceType: request.sourceType,
			sourceId: request.sourceId,
			artifactId: request.sourceType === "git" || request.sourceType === "compaction" ? null : request.artifactId,
			sourceDigest: request.sourceDigest,
			recordedAt: request.recordedAt,
			locator: request.locator,
		});
	}

	private async gitContexts(
		envelope: ReturnType<typeof parseMemoryCaptureEnvelope>,
		existingCues: Awaited<ReturnType<ReturnType<MemoryService["getStore"]>["readCues"]>>,
		captureDigest: string,
		recordedAt: string,
	): Promise<Array<MemoryGitContext | undefined>> {
		const pathsByCueKey = new Map(existingCues.map(({ cue }) => [cue.key, cue.scope.paths] as const));
		for (const cue of envelope.cues) pathsByCueKey.set(cue.key, cue.paths);
		const cache = new Map<string, Awaited<ReturnType<typeof captureGitFreshnessBasis>> | null>();
		const contexts: Array<MemoryGitContext | undefined> = [];
		for (const [index, review] of envelope.reviews.entries()) {
			const paths = [
				...new Set((review.replacement?.cueKeys ?? []).flatMap((key) => pathsByCueKey.get(key) ?? [])),
			].sort();
			if (paths.length === 0) {
				contexts.push(undefined);
				continue;
			}
			const cacheKey = stableJsonStringify(paths);
			let basis = cache.get(cacheKey);
			if (basis === undefined) {
				try {
					basis = await captureGitFreshnessBasis(this.projectRoot, paths);
				} catch {
					basis = null;
				}
				cache.set(cacheKey, basis);
			}
			if (!basis) {
				contexts.push(undefined);
				continue;
			}
			const evidenceDigest = sha256(stableJsonStringify({ captureDigest, index, basis }));
			const evidence = validateEvidenceRefV1({
				schema: MEMORY_EVIDENCE_REF_SCHEMA,
				evidenceId: `evidence_git_${suffix(evidenceDigest)}`,
				sourceType: "git",
				sourceId: basis.baselineCommit,
				artifactId: null,
				sourceDigest: evidenceDigest,
				recordedAt,
				locator: {
					repositoryId: basis.repositoryId,
					baselineCommit: basis.baselineCommit,
					scopePaths: basis.scopePaths,
				},
			});
			if (evidence.sourceType !== "git") {
				throw new MemoryValidationError("Memory Git evidence validation returned another source type");
			}
			contexts.push({
				basis,
				evidence,
			});
		}
		return contexts;
	}

	private async schedule(
		request: MemoryCaptureRequest,
		captureId: string,
		captureDigest: string,
	): Promise<MemoryWriteResult<"capture_scheduled">> {
		const replay = await this.service.getStore().replay();
		const source: MemoryCaptureSourceV1 = {
			schema: MEMORY_CAPTURE_SOURCE_SCHEMA,
			captureId,
			trigger: request.trigger,
			sourceIds: [request.sourceId, request.artifactId],
			sourceDigest: captureDigest,
			promptVersion: MEMORY_CAPTURE_PROMPT_VERSION,
			createdAt: request.recordedAt,
		};
		return await this.service.scheduleCapture(source, {
			eventId: `evt_memory_schedule_${suffix(captureDigest)}`,
			idempotencyKey: `memory:schedule:${captureId}`,
			expectedHead: replay.head,
			actor: "runtime",
			timestamp: request.recordedAt,
		});
	}

	private async recordFailure(
		captureId: string,
		stage: "source" | "generation" | "validation" | "artifact" | "publication" | "projection",
		error: unknown,
	): Promise<void> {
		const replay = await this.service.getStore().replay();
		const capture = replay.captures.get(captureId);
		if (
			!capture ||
			(stage === "projection"
				? capture.status !== "applied"
				: capture.status !== "scheduled" && capture.status !== "generating")
		) {
			return;
		}
		const classification = captureFailure(error, stage, capture.attempt ?? 0);
		await this.service.markCaptureFailed(
			{
				captureId,
				stage,
				errorCode: classification.errorCode,
				retryable: classification.retryable,
				message: limitedMessage(error),
			},
			{
				eventId: `evt_memory_failed_${suffix(sha256(`${captureId}\0${stage}\0${capture.attempt ?? 0}`))}`,
				idempotencyKey: `memory:failed:${captureId}:${capture.attempt ?? 0}:${stage}`,
				expectedHead: replay.head,
				actor: "runtime",
				timestamp: this.now(),
			},
		);
	}

	private async closeConflictedReconstruction(
		traceArtifactId: string,
		runId: string,
		error: MemoryRevisionConflictError,
	): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const replay = await this.service.getStore().replay();
			if (replay.failedReviewRunIds.has(runId) || replay.reviewedRunIds.has(runId)) return;
			try {
				await this.service.recordMemoryReviewFailure(
					{
						runId,
						traceArtifactId,
						stage: "validation",
						errorCode: "memory_capture_revision_conflict",
						retryable: false,
						message: limitedMessage(error),
					},
					{
						eventId: `evt_memory_review_failed_${suffix(sha256(runId))}`,
						idempotencyKey: `memory:review-failed:${runId}`,
						expectedHead: replay.head,
						actor: "runtime",
						timestamp: this.now(),
					},
				);
				return;
			} catch (failure) {
				if (!(failure instanceof MemoryHeadConflictError) || attempt === 1) throw failure;
			}
		}
	}

	private async resumeProposedCapture(captureId: string): Promise<MemoryCaptureResultV1> {
		const replay = await this.service.getStore().replay();
		const capture = replay.captures.get(captureId);
		if (!capture) throw new MemoryValidationError(`Memory capture not found: ${captureId}`);
		if (capture.status === "applied" || capture.status === "rejected") {
			return {
				captureId,
				status: capture.status,
				proposalId: capture.proposalId,
				confirmationRequired: false,
			};
		}
		if (capture.status !== "proposed" || !capture.proposalId) {
			throw new MemoryValidationError(`Memory capture is not awaiting proposal publication: ${captureId}`);
		}
		const proposal = replay.proposals.get(capture.proposalId);
		if (!proposal) throw new MemoryValidationError(`Memory capture proposal not found: ${capture.proposalId}`);
		if (proposal.confirmationRequired) {
			return {
				captureId,
				status: "proposed",
				proposalId: capture.proposalId,
				confirmationRequired: true,
			};
		}
		const applied = await this.service.applyProposal(proposal.proposalArtifactId, {
			eventId: `evt_memory_apply_${suffix(sha256(capture.proposalId))}`,
			idempotencyKey: `memory:apply:${capture.proposalId}`,
			expectedHead: replay.head,
			actor: "runtime",
			timestamp: this.now(),
		});
		await rm(this.pendingPath(captureId), { force: true });
		try {
			await this.service.synchronizeProjections({
				memoryIds: applied.write.event.payload.revisions.map((reference) => reference.memoryId),
				removeMemoryIds: (applied.write.event.payload.purges ?? []).map((purge) => purge.memoryId),
			});
		} catch (error) {
			await this.recordFailure(captureId, "projection", error);
		}
		return { captureId, status: "applied", proposalId: capture.proposalId, confirmationRequired: false };
	}

	private async existingContext(query: string) {
		const search = await this.service.search({ query, limit: 10, graphDepth: 1 });
		return await this.service.getStore().readMemories(search.items.map((item) => item.memoryId));
	}

	private async process(
		request: MemoryCaptureRequest,
		host: MemoryGenerationHost,
		captureId: string,
		captureDigest: string,
	): Promise<MemoryCaptureResultV1> {
		if (!(await this.service.getConfig()).enabled) {
			return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
		}
		const canonicalSource = await this.artifacts.read(request.artifactId);
		if (request.sourceDigest !== request.artifactId) {
			throw new MemoryValidationError("Memory capture source digest must identify the canonical artifact");
		}
		if (canonicalSource.content !== request.content) {
			throw new MemoryValidationError("Memory capture source content does not match the canonical artifact");
		}
		let replay = await this.service.getStore().replay();
		let capture = replay.captures.get(captureId);
		if (!capture) {
			await this.schedule(request, captureId, captureDigest);
			replay = await this.service.getStore().replay();
			capture = replay.captures.get(captureId);
		}
		if (!capture) throw new MemoryValidationError(`Memory capture was not scheduled: ${captureId}`);
		if (capture.status === "proposed") return await this.resumeProposedCapture(captureId);
		if (capture.status === "skipped") {
			return { captureId, status: "no_durable_memory", proposalId: null, confirmationRequired: false };
		}
		if (capture.status === "applied" || capture.status === "rejected") {
			return {
				captureId,
				status: capture.status,
				proposalId: capture.proposalId,
				confirmationRequired:
					capture.proposalId !== null && replay.proposals.get(capture.proposalId)?.confirmationRequired === true,
			};
		}
		const selectedModel = host.model ? `${host.model.provider}/${host.model.modelId}` : null;
		if (capture.status === "failed" && capture.retryable !== true) {
			return { captureId, status: "failed", proposalId: capture.proposalId, confirmationRequired: false };
		}
		if (capture.status === "failed" && capture.errorCode === "memory_capture_revision_conflict") {
			await rm(this.pendingPath(captureId), { force: true });
		}
		let pending = await this.readPending(captureId, selectedModel);
		if (capture.status === "generating" && !pending) {
			return { captureId, status: "indeterminate", proposalId: null, confirmationRequired: false };
		}
		if (!pending) {
			if (!host.model) throw new MemoryValidationError("Memory capture requires a selected model");
			const started = await this.service.markGenerationStarted(captureId, (capture.attempt ?? 0) + 1, {
				eventId: `evt_memory_generation_${suffix(captureDigest)}_${(capture.attempt ?? 0) + 1}`,
				idempotencyKey: `memory:generation:${captureId}:${(capture.attempt ?? 0) + 1}`,
				expectedHead: replay.head,
				actor: "runtime",
				timestamp: this.now(),
			});
			let existing: MemoryReadResultV1[];
			try {
				existing = await this.existingContext(request.query);
			} catch (error) {
				await this.recordFailure(captureId, "source", error);
				return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
			}
			const modelSource = stableJsonStringify({
				schema: "pi-xk.memory-capture-input.v1",
				captureId,
				source: {
					type: request.sourceType,
					id: request.sourceId,
					recordedAt: request.recordedAt,
					content: request.content,
				},
				existingMemories: existing.map((memory) => ({
					memoryId: memory.revision.memoryId,
					revision: memory.revision.revision,
					kind: memory.revision.kind,
					title: memory.revision.title,
					statement: memory.revision.statement,
					applicability: memory.revision.applicability,
					state: memory.state,
				})),
			});
			let generated: Awaited<ReturnType<MemoryGenerationHost["generate"]>>;
			try {
				generated = await host.generate({
					source: modelSource,
					instructions: MEMORY_CAPTURE_PROMPT,
					maxOutputTokens: Math.min(4_000, Math.max(2_048, Math.floor(host.model.contextWindow * 0.05))),
				});
			} catch (error) {
				await this.recordFailure(captureId, "generation", error);
				return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
			}
			try {
				const result = await this.artifacts.put({
					contentType: "text/plain",
					text: generated.text,
					producer: MEMORY_CAPTURE_PROMPT_VERSION,
					sensitivity: "internal",
					sourceIds: [captureId, request.artifactId],
					createdAt: this.now(),
				});
				await this.artifacts.read(result.artifactId);
				pending = {
					schema: MEMORY_CAPTURE_PENDING_SCHEMA,
					captureId,
					resultArtifactId: result.artifactId,
					model: `${generated.model.provider}/${generated.model.modelId}`,
					updatedAt: this.now(),
				};
				await this.replacePending(pending);
			} catch (error) {
				await this.recordFailure(captureId, "artifact", error);
				return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
			}
			replay = await this.service.getStore().replay();
			if (replay.head.sequence < started.head.sequence) {
				throw new MemoryValidationError("Memory event head regressed after generation");
			}
		}

		if (!pending) throw new MemoryValidationError("Memory capture result is unavailable");
		let review: ReturnType<typeof buildMemoryCaptureReview>;
		try {
			const result = await this.artifacts.read(pending.resultArtifactId);
			const envelope = parseMemoryCaptureEnvelope(result.content);
			const currentMemories = await this.existingContext(request.query);
			const existingCues = await this.service.getStore().readCues();
			const currentCapture = (await this.service.getStore().replay()).captures.get(captureId);
			const attempt = currentCapture?.attempt ?? 1;
			const reviewRunId = attempt > 1 ? `${captureId}:attempt:${attempt}` : captureId;
			review = buildMemoryCaptureReview(envelope, {
				captureId: reviewRunId,
				sourceDigest: captureDigest,
				evidence: this.evidence(request, captureDigest),
				recordedAt: pending.updatedAt,
				model: pending.model,
				query: request.query,
				scope: { projectId: this.projectId(), ...request.scope },
				existingMemories: new Map(currentMemories.map((memory) => [memory.revision.memoryId, memory])),
				existingCues,
				gitContexts: await this.gitContexts(envelope, existingCues, captureDigest, pending.updatedAt),
			});
		} catch (error) {
			await this.recordFailure(captureId, "validation", error);
			if (error instanceof MemoryRevisionConflictError) {
				await rm(this.pendingPath(captureId), { force: true });
			}
			return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
		}
		if (!review) {
			const replay = await this.service.getStore().replay();
			await this.service.markCaptureSkipped(captureId, pending.resultArtifactId, {
				eventId: `evt_memory_skipped_${suffix(sha256(captureId))}`,
				idempotencyKey: `memory:skipped:${captureId}`,
				expectedHead: replay.head,
				actor: "runtime",
				timestamp: this.now(),
			});
			await rm(this.pendingPath(captureId), { force: true });
			return { captureId, status: "no_durable_memory", proposalId: null, confirmationRequired: false };
		}
		try {
			const store = this.service.getStore();
			const reconstruction = await this.service.recordReconstruction(review.trace, {
				eventId: `evt_memory_reconstruction_${suffix(sha256(review.trace.runId))}`,
				idempotencyKey: `memory:reconstruction:${review.trace.runId}`,
				expectedHead: (await store.replay()).head,
				actor: "runtime",
				timestamp: review.trace.settledAt,
			});
			const applied = await this.service.applyMemoryReviews(
				review.decisions,
				review.evidenceRefs as EvidenceRefV2[],
				reconstruction.traceArtifactId,
				{
					eventId: `evt_memory_review_${suffix(sha256(review.trace.runId))}`,
					idempotencyKey: `memory:review:${review.trace.runId}`,
					expectedHead: (await store.replay()).head,
					actor: "model",
					timestamp: review.trace.settledAt,
				},
				{
					captureId,
					cues: review.cues,
					freshnessBasisByDecisionId: review.freshnessBasisByDecisionId,
				},
			);
			try {
				await this.service.synchronizeProjections({
					memoryIds: applied.write.event.payload.revisions.map((reference) => reference.memoryId),
				});
			} catch (error) {
				await this.recordFailure(captureId, "projection", error);
			}
			await rm(this.pendingPath(captureId), { force: true });
			return { captureId, status: "applied", proposalId: null, confirmationRequired: false };
		} catch (error) {
			const replay = await this.service.getStore().replay();
			if (replay.captures.get(captureId)?.status === "applied") {
				try {
					await this.service.repairProjections();
				} catch (projectionError) {
					await this.recordFailure(captureId, "projection", projectionError);
				}
				await rm(this.pendingPath(captureId), { force: true });
				return { captureId, status: "applied", proposalId: null, confirmationRequired: false };
			}
			if (error instanceof MemoryRevisionConflictError) {
				const reconstruction = replay.reconstructions.get(review.trace.runId);
				if (reconstruction) {
					try {
						await this.closeConflictedReconstruction(reconstruction.traceArtifactId, review.trace.runId, error);
					} catch (diagnosticError) {
						await this.recordFailure(captureId, "publication", diagnosticError);
						return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
					}
				}
				await this.recordFailure(captureId, "validation", error);
				await rm(this.pendingPath(captureId), { force: true });
			} else {
				await this.recordFailure(captureId, "publication", error);
			}
			return { captureId, status: "failed", proposalId: null, confirmationRequired: false };
		}
	}

	capture(request: MemoryCaptureRequest, host: MemoryGenerationHost): Promise<MemoryCaptureResultV1> {
		const identity = this.captureIdentity(request);
		const existing = this.queueByCapture.get(identity.captureId);
		if (existing) return existing;
		let resolveResult: (result: MemoryCaptureResultV1) => void;
		let rejectResult: (error: unknown) => void;
		const result = new Promise<MemoryCaptureResultV1>((resolvePromise, rejectPromise) => {
			resolveResult = resolvePromise;
			rejectResult = rejectPromise;
		});
		this.queueByCapture.set(identity.captureId, result);
		this.publicationQueue = this.publicationQueue
			.then(async () => {
				if (!(await this.service.getConfig()).enabled) {
					resolveResult({
						captureId: identity.captureId,
						status: "failed",
						proposalId: null,
						confirmationRequired: false,
					});
					return;
				}
				try {
					resolveResult(
						await this.service
							.getStore()
							.withCaptureGenerationLock(
								identity.captureId,
								async () => await this.process(request, host, identity.captureId, identity.digest),
							),
					);
				} catch (error) {
					if (!(error instanceof MemoryLockedError)) throw error;
					const replay = await this.service.getStore().replay();
					const capture = replay.captures.get(identity.captureId);
					resolveResult({
						captureId: identity.captureId,
						status: capture?.status === "generating" ? "indeterminate" : (capture?.status ?? "indeterminate"),
						proposalId: capture?.proposalId ?? null,
						confirmationRequired:
							capture?.proposalId !== null &&
							capture?.proposalId !== undefined &&
							replay.proposals.get(capture.proposalId)?.confirmationRequired === true,
					});
				}
			})
			.catch((error) => rejectResult(error))
			.finally(() => this.queueByCapture.delete(identity.captureId));
		return result;
	}

	async resumePublications(): Promise<MemoryCaptureResultV1[]> {
		if (!(await this.service.getConfig()).enabled) return [];
		const snapshot = await this.service.getStore().loadReadModelSnapshot();
		if (!snapshot.readModel.captures.some((capture) => capture.status === "proposed")) return [];
		let resolveResult: (result: MemoryCaptureResultV1[]) => void;
		let rejectResult: (error: unknown) => void;
		const result = new Promise<MemoryCaptureResultV1[]>((resolvePromise, rejectPromise) => {
			resolveResult = resolvePromise;
			rejectResult = rejectPromise;
		});
		this.publicationQueue = this.publicationQueue.then(async () => {
			try {
				const replay = await this.service.getStore().replay();
				const captureIds = [...replay.captures.values()]
					.filter(
						(capture) =>
							capture.status === "proposed" &&
							capture.proposalId !== null &&
							replay.proposals.get(capture.proposalId)?.confirmationRequired === false,
					)
					.map((capture) => capture.captureId)
					.sort();
				const recovered: MemoryCaptureResultV1[] = [];
				for (const captureId of captureIds) {
					try {
						recovered.push(
							await this.service
								.getStore()
								.withCaptureGenerationLock(captureId, async () => await this.resumeProposedCapture(captureId)),
						);
					} catch (error) {
						if (!(error instanceof MemoryLockedError)) throw error;
					}
				}
				resolveResult(recovered);
			} catch (error) {
				rejectResult(error);
			}
		});
		return result;
	}

	async waitForCaptures(): Promise<void> {
		await this.publicationQueue;
	}

	async close(): Promise<void> {
		await this.waitForCaptures();
		await this.service.close();
	}
}
