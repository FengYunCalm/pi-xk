import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRunEvidenceRefV2, type EvidenceRefV2, validateEvidenceRefV2 } from "./ambient-memory-contract.ts";
import { captureGitFreshnessBasis, resolveGitFreshness, resolveGitRepositoryId } from "./memory-freshness.ts";
import {
	SKILL_CANDIDATE_SCHEMA,
	SKILL_SOURCE_EVIDENCE_SCHEMA,
	SKILL_USE_EVIDENCE_SCHEMA,
	type SkillCandidateV1,
	type SkillReviewDecisionV1,
	type SkillRevisionV1,
	type SkillSourceEvidenceV1,
	type SkillUseEvidenceV1,
	SkillValidationError,
	validateSkillCandidateV1,
	validateSkillReviewDecisionV1,
} from "./skill-contract.ts";
import type {
	SkillIndexCandidateV1,
	SkillIndexSearchInputV1,
	SkillIndexSearchResultV1,
	SkillIndexSkillV1,
	SkillIndexSnapshotV1,
	SkillIndexStatusV1,
} from "./skill-index.ts";
import { SkillIndexWorkerClient } from "./skill-index-worker-client.ts";
import {
	type SkillDoctorReportV1,
	type SkillHead,
	type SkillMutationOptions,
	type SkillPublicationFailureV1,
	type SkillPurgeResultV1,
	type SkillReadModelV1,
	SkillStore,
	type SkillStoreOptions,
	type SkillStoreStatusV1,
} from "./skill-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";

export const SKILL_CONFIG_SCHEMA = "pi-xk.skill-config.v1";

export interface SkillConfigV1 {
	enabled: boolean;
}

export interface SkillServiceStatusV1 {
	enabled: boolean;
	facts: SkillStoreStatusV1;
	indexState: "absent" | "current" | "rebuilt" | "unavailable";
	index: SkillIndexStatusV1 | null;
}

export interface SkillCandidateReadV1 {
	candidate: SkillCandidateV1;
	files: Array<{ path: string; content: string; executable: boolean }>;
}

export interface SkillServiceDoctorReportV1 {
	ok: boolean;
	diagnostics: SkillDoctorReportV1["diagnostics"];
	checkedEvents: number;
	checkedArtifacts: number;
	index: SkillIndexStatusV1 | null;
}

export interface SkillReviewPublicationV1 {
	decisionId: string;
	head: SkillReadModelV1["head"];
	useIds: string[];
	candidateId: string | null;
	skillId: string | null;
	revision: number | null;
	status: "kept" | "candidate" | "applied";
	projectionPublished: boolean;
}

export interface SkillDerivedStateRefreshV1 {
	changed: boolean;
	changedSkills: Array<{ skillId: string; revision: number; projected: boolean }>;
	index: SkillIndexStatusV1;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameHead(left: SkillReadModelV1["head"], right: SkillReadModelV1["head"]): boolean {
	return left.sequence === right.sequence && left.hash === right.hash;
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeSuffix(value: string): string {
	return digest(value).slice("sha256:".length, "sha256:".length + 32);
}

export class SkillService {
	private readonly projectRoot: string;
	private readonly store: SkillStore;
	private readonly factsDirectory: string;
	private readonly configPath: string;
	private readonly indexPath: string;
	private index: SkillIndexWorkerClient | undefined;
	private indexState: SkillServiceStatusV1["indexState"] = "absent";
	private projectionQueue: Promise<void> = Promise.resolve();
	private readonly evidenceProjectId: Promise<string>;

	constructor(projectRoot: string, options: SkillStoreOptions = {}, store = new SkillStore(projectRoot, options)) {
		this.projectRoot = projectRoot;
		this.store = store;
		this.factsDirectory = store.getFactsDirectory();
		this.configPath = join(this.factsDirectory, "skill-config.json");
		this.indexPath = join(this.factsDirectory, "index.sqlite");
		this.evidenceProjectId = resolveGitRepositoryId(projectRoot).then(
			(repositoryId) => repositoryId ?? store.getProjectId(),
		);
	}

	getStore(): SkillStore {
		return this.store;
	}

	async getEvidenceProjectId(): Promise<string> {
		return await this.evidenceProjectId;
	}

	private withProjectionOperation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
		const current = this.projectionQueue.then(operation, operation);
		this.projectionQueue = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}

	async getConfig(): Promise<SkillConfigV1> {
		try {
			const value = JSON.parse(await readFile(this.configPath, "utf8")) as unknown;
			if (
				typeof value !== "object" ||
				value === null ||
				Array.isArray(value) ||
				Object.keys(value).sort().join(",") !== "enabled,schema" ||
				!("schema" in value) ||
				value.schema !== SKILL_CONFIG_SCHEMA ||
				!("enabled" in value) ||
				typeof value.enabled !== "boolean"
			) {
				throw new Error("Skill config is invalid");
			}
			return { enabled: value.enabled };
		} catch (error) {
			if (isErrno(error, "ENOENT")) return { enabled: true };
			throw error;
		}
	}

	async setConfig(enabled: boolean): Promise<void> {
		await mkdir(this.factsDirectory, { recursive: true });
		const temporary = join(this.factsDirectory, `.skill-config-${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify({ schema: SKILL_CONFIG_SCHEMA, enabled }, null, "\t")}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.configPath);
			await syncDirectory(this.factsDirectory);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async indexSnapshot(model: SkillReadModelV1): Promise<SkillIndexSnapshotV1> {
		return {
			head: model.head,
			skills: await this.indexSkills(
				model,
				model.revisions.map((reference) => reference.skillId),
			),
			candidates: await this.indexCandidates(
				model,
				model.candidates
					.filter((candidate) => candidate.status === "pending")
					.map((candidate) => candidate.candidateId),
			),
		};
	}

	private async indexSkills(model: SkillReadModelV1, skillIds: readonly string[]): Promise<SkillIndexSkillV1[]> {
		const useBySkill = new Map<string, SkillReadModelV1["uses"]>();
		for (const use of model.uses) {
			const values = useBySkill.get(use.skillId) ?? [];
			values.push(use);
			useBySkill.set(use.skillId, values);
		}
		const skills: SkillIndexSkillV1[] = [];
		for (const skillId of [...new Set(skillIds)].sort()) {
			const reference = model.revisions.find((entry) => entry.skillId === skillId);
			if (!reference) continue;
			const { revision } = await this.store.readRevision(reference.skillId, reference.revision);
			const uses = (useBySkill.get(reference.skillId) ?? []).filter((use) => use.revision === reference.revision);
			const latest = uses.slice(-2);
			const freshnessBasis = revision.evidenceRefs
				.filter((evidence) => evidence.schema === SKILL_SOURCE_EVIDENCE_SCHEMA)
				.map((evidence) => evidence.freshnessBasis)
				.filter((basis) => basis !== null)
				.at(-1);
			skills.push({
				skillId: revision.skillId,
				revision: revision.revision,
				artifactId: reference.artifactId,
				bundleArtifactId: reference.bundleArtifactId,
				scope: revision.scope,
				lifecycle: revision.lifecycle,
				name: revision.name,
				description: revision.description,
				applicability: revision.applicability,
				divergenceConditions: revision.divergenceConditions,
				stale:
					revision.scope === "project" && freshnessBasis
						? (await resolveGitFreshness(this.projectRoot, freshnessBasis)) !== "current"
						: false,
				needsReview: latest.length === 2 && latest.every((use) => use.outcome === "failure"),
				successfulUses: uses.filter((use) => use.outcome === "success").length,
				failedUses: uses.filter((use) => use.outcome === "failure").length,
				recordedAt: revision.provenance.recordedAt,
				sourceDigest: revision.sourceDigest,
			});
		}
		return skills;
	}

	private async indexCandidates(
		model: SkillReadModelV1,
		candidateIds: readonly string[],
	): Promise<SkillIndexCandidateV1[]> {
		const candidates: SkillIndexCandidateV1[] = [];
		for (const candidateId of [...new Set(candidateIds)].sort()) {
			const reference = model.candidates.find(
				(candidate) => candidate.candidateId === candidateId && candidate.status === "pending",
			);
			if (!reference) continue;
			const candidate = await this.store.readCandidate(reference.candidateId);
			candidates.push({
				candidateId: candidate.candidateId,
				skillId: candidate.skillId,
				targetScope: candidate.targetScope,
				expectedRevision: candidate.expectedRevision,
				name: candidate.name,
				description: candidate.description,
				applicability: candidate.applicability,
				divergenceConditions: candidate.divergenceConditions,
				status: reference.status,
				sourceDigest: candidate.sourceDigest,
			});
		}
		return candidates;
	}

	private async adoptIndex(model: SkillReadModelV1): Promise<boolean> {
		if (this.index) {
			try {
				const status = await this.index.status();
				if (sameHead(status.head, model.head) && (await this.index.integrityCheck()) === "ok") {
					this.indexState = "current";
					return true;
				}
			} catch {
				// Reopen or rebuild the disposable projection below.
			}
			await this.index.close().catch(() => {});
			this.index = undefined;
		}
		try {
			await stat(this.indexPath);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return false;
			throw error;
		}
		const candidate = new SkillIndexWorkerClient({ databasePath: this.indexPath });
		try {
			const status = await candidate.status();
			if (sameHead(status.head, model.head) && (await candidate.integrityCheck()) === "ok") {
				this.index = candidate;
				this.indexState = "current";
				return true;
			}
		} catch {
			// Rebuild from facts below.
		}
		await candidate.close().catch(() => {});
		return false;
	}

	private async rebuildIndex(model: SkillReadModelV1): Promise<void> {
		await this.index?.close().catch(() => {});
		this.index = undefined;
		await mkdir(this.factsDirectory, { recursive: true });
		const temporary = join(this.factsDirectory, `.index-${randomUUID()}.sqlite`);
		let builder: SkillIndexWorkerClient | undefined;
		try {
			builder = new SkillIndexWorkerClient({ databasePath: temporary });
			const snapshot = await this.indexSnapshot(model);
			await builder.rebuild(snapshot);
			if ((await builder.integrityCheck()) !== "ok") throw new Error("Skill index rebuild failed integrity check");
			const status = await builder.status();
			if (!sameHead(status.head, model.head) || status.skillCount !== snapshot.skills.length) {
				throw new Error("Skill index rebuild does not match Skill facts");
			}
			await builder.close();
			builder = undefined;
			await rename(temporary, this.indexPath);
			await syncDirectory(this.factsDirectory);
		} finally {
			await builder?.close().catch(() => {});
			await rm(temporary, { force: true });
			await rm(`${temporary}-wal`, { force: true });
			await rm(`${temporary}-shm`, { force: true });
		}
		this.index = new SkillIndexWorkerClient({ databasePath: this.indexPath });
		this.indexState = "rebuilt";
	}

	private async ensureIndex(): Promise<{ model: SkillReadModelV1; index: SkillIndexWorkerClient }> {
		const model = await this.store.loadReadModel();
		if (!(await this.adoptIndex(model))) await this.rebuildIndex(model);
		if (!this.index) throw new Error("Skill index is unavailable after rebuild");
		return { model, index: this.index };
	}

	private async prepareIndexForMutation(model: SkillReadModelV1): Promise<boolean> {
		try {
			if (!(await this.adoptIndex(model))) await this.rebuildIndex(model);
			return this.index !== undefined;
		} catch {
			await this.index?.close().catch(() => {});
			this.index = undefined;
			this.indexState = "unavailable";
			return false;
		}
	}

	private async applyFactDelta(
		expectedHead: SkillReadModelV1["head"],
		skillIds: ReadonlySet<string>,
		candidateIds: ReadonlySet<string>,
	): Promise<void> {
		if (!this.index) return;
		try {
			const model = await this.store.loadReadModel();
			const indexedSkillIds = new Set(model.revisions.map((reference) => reference.skillId));
			const indexedCandidateIds = new Set(
				model.candidates
					.filter((candidate) => candidate.status === "pending")
					.map((candidate) => candidate.candidateId),
			);
			await this.index.applyDelta({
				expectedHead,
				head: model.head,
				skills: await this.indexSkills(model, [...skillIds]),
				candidates: await this.indexCandidates(model, [...candidateIds]),
				removeSkillIds: [...skillIds].filter((skillId) => !indexedSkillIds.has(skillId)),
				removeCandidateIds: [...candidateIds].filter((candidateId) => !indexedCandidateIds.has(candidateId)),
			});
			this.indexState = "current";
		} catch {
			await this.index.close().catch(() => {});
			this.index = undefined;
			this.indexState = "unavailable";
		}
	}

	async search(
		input: Omit<SkillIndexSearchInputV1, "limit" | "includeCandidates"> &
			Partial<Pick<SkillIndexSearchInputV1, "limit" | "includeCandidates">>,
	): Promise<SkillIndexSearchResultV1> {
		return await this.withProjectionOperation(async () => {
			const { index } = await this.ensureIndex();
			return await index.search({
				query: input.query,
				includeCandidates: input.includeCandidates ?? true,
				limit: input.limit ?? 12,
				...(input.offset === undefined ? {} : { offset: input.offset }),
			});
		});
	}

	async readCandidate(candidateId: string): Promise<SkillCandidateReadV1> {
		const candidate = await this.store.readCandidate(candidateId);
		return { candidate, files: await this.store.readBundleFiles(candidate.bundleArtifactId) };
	}

	async readSkill(
		skillId: string,
		revision?: number,
	): Promise<{ revision: SkillRevisionV1; files: SkillCandidateReadV1["files"] }> {
		const result = await this.store.readRevision(skillId, revision);
		return { revision: result.revision, files: await this.store.readBundleFiles(result.reference.bundleArtifactId) };
	}

	async publishReview(
		decisionInput: SkillReviewDecisionV1,
		runEvidence: AgentRunEvidenceRefV2,
		reviewEvidenceInput: readonly EvidenceRefV2[] = [],
	): Promise<SkillReviewPublicationV1> {
		if (!(await this.getConfig()).enabled) throw new SkillValidationError("Skill evolution is disabled");
		return await this.withProjectionOperation(async () => {
			const beforeModel = await this.store.loadReadModel();
			const updateIndex = await this.prepareIndexForMutation(beforeModel);
			const changedSkillIds = new Set<string>();
			const changedCandidateIds = new Set<string>();
			try {
				const decision = validateSkillReviewDecisionV1(decisionInput);
				const reviewEvidence = reviewEvidenceInput.map(validateEvidenceRefV2);
				const evidenceProjectId = await this.getEvidenceProjectId();
				const reviewEvidenceById = new Map(reviewEvidence.map((evidence) => [evidence.evidenceId, evidence]));
				if (
					reviewEvidenceById.size !== reviewEvidence.length ||
					stableJsonStringify([...reviewEvidenceById.keys()].sort()) !==
						stableJsonStringify([...decision.evidenceIds].sort())
				) {
					throw new SkillValidationError("Skill review evidence does not match the decision evidenceIds");
				}
				const currentSourceFreshness =
					decision.action === "revise"
						? ((await this.store.readRevision(decision.sourceSkills[0]!.skillId)).revision.evidenceRefs
								.filter((evidence) => evidence.schema === SKILL_SOURCE_EVIDENCE_SCHEMA)
								.map((evidence) => evidence.freshnessBasis)
								.filter((basis) => basis !== null)
								.at(-1) ?? null)
						: null;
				const gitScopePaths = [
					...new Set(
						reviewEvidence.flatMap((evidence) =>
							evidence.sourceType === "git" ? evidence.locator.scopePaths : [],
						),
					),
				].sort();
				const freshnessBasis =
					this.store.getScope() === "project" && gitScopePaths.length > 0
						? await captureGitFreshnessBasis(this.projectRoot, gitScopePaths)
						: currentSourceFreshness;
				for (const source of decision.sourceSkills) {
					changedSkillIds.add(source.skillId);
					const current = await this.store.readRevision(source.skillId);
					if (current.revision.revision !== source.expectedRevision) {
						throw new SkillValidationError(
							`Skill review revision conflict for ${source.skillId}: expected ${source.expectedRevision}, actual ${current.revision.revision}`,
						);
					}
				}
				let head = (await this.store.loadReadModel()).head;
				const useEvidence: SkillUseEvidenceV1[] = [];
				for (const use of decision.uses) {
					changedSkillIds.add(use.skillId);
					if (
						!decision.sourceSkills.some(
							(source) => source.skillId === use.skillId && source.expectedRevision === use.expectedRevision,
						)
					) {
						throw new SkillValidationError(`Skill review use is not one of its source Skills: ${use.skillId}`);
					}
					const useId = `skill_use_${safeSuffix(stableJsonStringify({ runId: decision.runId, use }))}`;
					const evidence: SkillUseEvidenceV1 = {
						schema: SKILL_USE_EVIDENCE_SCHEMA,
						useId,
						skillId: use.skillId,
						revision: use.expectedRevision,
						projectId: evidenceProjectId,
						runId: decision.runId,
						outcome: use.outcome,
						evidenceRefs: [runEvidence, ...reviewEvidence],
						divergenceObserved: use.divergenceObserved,
						recordedAt: decision.provenance.recordedAt,
					};
					head = await this.store.recordUse(evidence, {
						eventId: `evt_${useId}`,
						idempotencyKey: `skill:use:${useId}`,
						expectedHead: head,
						actor: "model",
						timestamp: decision.provenance.recordedAt,
					});
					useEvidence.push(evidence);
				}
				const reviewArtifact = await this.store.recordReviewArtifact(decision);
				if (decision.action === "keep") {
					return {
						decisionId: decision.decisionId,
						head,
						useIds: useEvidence.map((use) => use.useId),
						candidateId: null,
						skillId: null,
						revision: null,
						status: "kept",
						projectionPublished: true,
					};
				}
				const replacement = decision.replacement;
				if (!replacement) throw new SkillValidationError("Skill semantic review requires a replacement");
				if (replacement.targetScope !== this.store.getScope()) {
					throw new SkillValidationError("Skill review targets another Store scope");
				}
				let skillId: string;
				let expectedRevision: number | null;
				if (decision.action === "revise") {
					skillId = decision.sourceSkills[0]!.skillId;
					expectedRevision = decision.sourceSkills[0]!.expectedRevision;
				} else {
					const sameName = (await this.store.listRevisions()).find(
						(entry) => entry.revision.name === replacement.name,
					);
					skillId = sameName?.revision.skillId ?? `skill_${safeSuffix(replacement.name)}`;
					expectedRevision = sameName?.revision.revision ?? null;
				}
				const sourceEvidence: SkillSourceEvidenceV1 = {
					schema: SKILL_SOURCE_EVIDENCE_SCHEMA,
					evidenceId: `skill_source_${safeSuffix(`${decision.decisionId}:${runEvidence.evidenceId}`)}`,
					projectId: evidenceProjectId,
					runId: decision.runId,
					outcome: "success",
					evidenceRefs: [runEvidence, ...reviewEvidence],
					freshnessBasis,
					recordedAt: decision.provenance.recordedAt,
				};
				const candidateId = `candidate_${safeSuffix(stableJsonStringify({ decisionId: decision.decisionId, skillId, replacement }))}`;
				const bundle = await this.store.createBundle(
					{
						candidateId,
						skillId,
						name: replacement.name,
						description: replacement.description,
						applicability: replacement.applicability,
						divergenceConditions: replacement.divergenceConditions,
						provenance: decision.provenance,
					},
					{ instructions: replacement.instructions, resources: replacement.resources },
				);
				const candidate = validateSkillCandidateV1({
					schema: SKILL_CANDIDATE_SCHEMA,
					candidateId,
					skillId,
					targetScope: replacement.targetScope,
					expectedRevision,
					name: replacement.name,
					description: replacement.description,
					applicability: replacement.applicability,
					divergenceConditions: replacement.divergenceConditions,
					bundleArtifactId: bundle.bundleArtifactId,
					evidenceRefs: [sourceEvidence, ...useEvidence],
					sourceDigest: digest(
						stableJsonStringify({
							decisionId: decision.decisionId,
							bundleArtifactId: bundle.bundleArtifactId,
							evidence: [sourceEvidence, ...useEvidence],
						}),
					),
					provenance: decision.provenance,
				});
				for (const pending of await this.store.listPendingCandidates()) {
					if (pending.skillId !== skillId || pending.candidateId === candidateId) continue;
					changedCandidateIds.add(pending.candidateId);
					head = await this.store.rejectCandidate(
						pending.candidateId,
						`Superseded by newer candidate ${candidateId}`,
						{
							eventId: `evt_skill_candidate_replaced_${safeSuffix(`${pending.candidateId}:${candidateId}`)}`,
							idempotencyKey: `skill:candidate-replaced:${pending.candidateId}:${candidateId}`,
							expectedHead: head,
							actor: "runtime",
							timestamp: decision.provenance.recordedAt,
						},
					);
				}
				const recorded = await this.store.recordCandidate(
					candidate,
					{
						eventId: `evt_skill_candidate_${safeSuffix(candidateId)}`,
						idempotencyKey: `skill:candidate:${candidateId}`,
						expectedHead: head,
						actor: "model",
						timestamp: decision.provenance.recordedAt,
					},
					reviewArtifact.artifactId,
				);
				changedCandidateIds.add(candidateId);
				if (this.store.getScope() === "global") {
					return {
						decisionId: decision.decisionId,
						head: recorded.head,
						useIds: useEvidence.map((use) => use.useId),
						candidateId,
						skillId,
						revision: null,
						status: "candidate",
						projectionPublished: true,
					};
				}
				const supersedes =
					decision.action === "supersede"
						? decision.sourceSkills.map((source) => ({
								skillId: source.skillId,
								revision: source.expectedRevision,
							}))
						: [];
				const applied = await this.store.applyCandidate(
					candidateId,
					{
						eventId: `evt_skill_apply_${safeSuffix(candidateId)}`,
						idempotencyKey: `skill:apply:${candidateId}`,
						expectedHead: recorded.head,
						actor: "model",
						timestamp: decision.provenance.recordedAt,
					},
					supersedes,
				);
				changedSkillIds.add(skillId);
				for (const source of supersedes) changedSkillIds.add(source.skillId);
				return {
					decisionId: decision.decisionId,
					head: applied.head,
					useIds: useEvidence.map((use) => use.useId),
					candidateId,
					skillId,
					revision: applied.revision.revision,
					status: "applied",
					projectionPublished: applied.projectionPublished,
				};
			} finally {
				if (updateIndex) await this.applyFactDelta(beforeModel.head, changedSkillIds, changedCandidateIds);
			}
		});
	}

	async recordUse(use: SkillUseEvidenceV1, options: SkillMutationOptions): Promise<SkillHead> {
		return await this.withProjectionOperation(async () => {
			const beforeModel = await this.store.loadReadModel();
			const updateIndex = await this.prepareIndexForMutation(beforeModel);
			try {
				return await this.store.recordUse(use, options);
			} finally {
				if (updateIndex) await this.applyFactDelta(beforeModel.head, new Set([use.skillId]), new Set());
			}
		});
	}

	async promoteCandidate(
		candidateId: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		return await this.withProjectionOperation(async () => {
			const beforeModel = await this.store.loadReadModel();
			const updateIndex = await this.prepareIndexForMutation(beforeModel);
			const candidate = await this.store.readCandidate(candidateId);
			try {
				return await this.store.promoteCandidate(candidateId, options);
			} finally {
				if (updateIndex) {
					await this.applyFactDelta(beforeModel.head, new Set([candidate.skillId]), new Set([candidateId]));
				}
			}
		});
	}

	private changedFactIds(
		before: SkillReadModelV1,
		after: SkillReadModelV1,
	): { skillIds: Set<string>; candidateIds: Set<string> } {
		const skillIds = new Set<string>();
		const candidateIds = new Set<string>();
		const beforeSkills = new Map(before.revisions.map((reference) => [reference.skillId, reference] as const));
		const afterSkills = new Map(after.revisions.map((reference) => [reference.skillId, reference] as const));
		for (const skillId of new Set([...beforeSkills.keys(), ...afterSkills.keys()])) {
			if (stableJsonStringify(beforeSkills.get(skillId)) !== stableJsonStringify(afterSkills.get(skillId))) {
				skillIds.add(skillId);
			}
		}
		const beforeCandidates = new Map(
			before.candidates.map((reference) => [reference.candidateId, reference] as const),
		);
		const afterCandidates = new Map(after.candidates.map((reference) => [reference.candidateId, reference] as const));
		for (const candidateId of new Set([...beforeCandidates.keys(), ...afterCandidates.keys()])) {
			if (
				stableJsonStringify(beforeCandidates.get(candidateId)) !==
				stableJsonStringify(afterCandidates.get(candidateId))
			) {
				candidateIds.add(candidateId);
			}
		}
		return { skillIds, candidateIds };
	}

	private async indexedFactMutation<TResult>(mutation: () => Promise<TResult>): Promise<TResult> {
		return await this.withProjectionOperation(async () => {
			const beforeModel = await this.store.loadReadModel();
			const updateIndex = await this.prepareIndexForMutation(beforeModel);
			try {
				return await mutation();
			} finally {
				if (updateIndex) {
					const changes = this.changedFactIds(beforeModel, await this.store.loadReadModel());
					await this.applyFactDelta(beforeModel.head, changes.skillIds, changes.candidateIds);
				}
			}
		});
	}

	async applyCandidate(
		candidateId: string,
		options: SkillMutationOptions,
		supersedesRevisions: SkillRevisionV1["supersedesRevisions"] = [],
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		return await this.indexedFactMutation(
			async () => await this.store.applyCandidate(candidateId, options, supersedesRevisions),
		);
	}

	async rejectCandidate(candidateId: string, reason: string, options: SkillMutationOptions): Promise<SkillHead> {
		return await this.indexedFactMutation(async () => await this.store.rejectCandidate(candidateId, reason, options));
	}

	async archive(
		skillId: string,
		reason: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		return await this.indexedFactMutation(async () => await this.store.archive(skillId, reason, options));
	}

	async rollback(
		skillId: string,
		targetRevision: number,
		reason: string,
		options: SkillMutationOptions,
	): Promise<{ revision: SkillRevisionV1; head: SkillHead; projectionPublished: boolean }> {
		return await this.indexedFactMutation(
			async () => await this.store.rollback(skillId, targetRevision, reason, options),
		);
	}

	async purge(skillId: string, options: SkillMutationOptions): Promise<SkillPurgeResultV1> {
		return await this.indexedFactMutation(async () => await this.store.purge(skillId, options));
	}

	async recordPublicationFailure(
		failure: SkillPublicationFailureV1,
		options: SkillMutationOptions,
	): Promise<SkillHead> {
		return await this.withProjectionOperation(async () => {
			const beforeModel = await this.store.loadReadModel();
			const updateIndex = await this.prepareIndexForMutation(beforeModel);
			try {
				return await this.store.recordPublicationFailure(failure, options);
			} finally {
				if (updateIndex) await this.applyFactDelta(beforeModel.head, new Set(), new Set());
			}
		});
	}

	async refreshDerivedState(skillIds?: readonly string[]): Promise<SkillDerivedStateRefreshV1> {
		return await this.withProjectionOperation(async () => {
			const { model, index } = await this.ensureIndex();
			const targetSkillIds = skillIds ?? model.revisions.map((reference) => reference.skillId);
			const skills = await this.indexSkills(model, targetSkillIds);
			const changedSkills: SkillDerivedStateRefreshV1["changedSkills"] = [];
			for (const skill of skills) {
				const projected = skill.lifecycle === "active" && !skill.stale && !skill.needsReview;
				if (await this.store.setProjectionAvailable(skill.skillId, projected)) {
					changedSkills.push({ skillId: skill.skillId, revision: skill.revision, projected });
				}
			}
			await index.applyDelta({
				expectedHead: model.head,
				head: model.head,
				skills,
				candidates: [],
				removeSkillIds: [],
				removeCandidateIds: [],
			});
			this.indexState = "current";
			return { changed: changedSkills.length > 0, changedSkills, index: await index.status() };
		});
	}

	async repairProjections(): Promise<SkillIndexStatusV1> {
		return await this.withProjectionOperation(async () => {
			await this.store.repairProjections();
			await this.rebuildIndex(await this.store.loadReadModel());
			if (!this.index) throw new Error("Skill index is unavailable after repair");
			return await this.index.status();
		});
	}

	async doctor(deep = false): Promise<SkillServiceDoctorReportV1> {
		const facts = await this.store.doctor(deep);
		const diagnostics = [...facts.diagnostics];
		let index: SkillIndexStatusV1 | null = null;
		try {
			const model = await this.store.loadReadModel();
			if (await this.adoptIndex(model)) index = (await this.index?.status()) ?? null;
			else
				diagnostics.push({
					code: "index_missing_or_stale",
					message: "Skill SQLite projection must be rebuilt",
					repairable: true,
				});
		} catch (error) {
			diagnostics.push({
				code: "index_unavailable",
				message: error instanceof Error ? error.message : String(error),
				repairable: true,
			});
		}
		return {
			ok: facts.ok && diagnostics.length === 0,
			diagnostics,
			checkedEvents: facts.checkedEvents,
			checkedArtifacts: facts.checkedArtifacts,
			index,
		};
	}

	async status(): Promise<SkillServiceStatusV1> {
		const [config, facts] = await Promise.all([this.getConfig(), this.store.status()]);
		if (facts.head.sequence === 0) return { enabled: config.enabled, facts, indexState: "absent", index: null };
		return await this.withProjectionOperation(async () => {
			try {
				const { index } = await this.ensureIndex();
				const indexStatus = await index.status();
				return {
					enabled: config.enabled,
					facts: { ...facts, stale: indexStatus.staleCount, needsReview: indexStatus.needsReviewCount },
					indexState: this.indexState,
					index: indexStatus,
				};
			} catch {
				this.indexState = "unavailable";
				return { enabled: config.enabled, facts, indexState: this.indexState, index: null };
			}
		});
	}

	async close(): Promise<void> {
		await this.withProjectionOperation(async () => {
			await this.index?.close().catch(() => {});
			this.index = undefined;
		});
	}
}
