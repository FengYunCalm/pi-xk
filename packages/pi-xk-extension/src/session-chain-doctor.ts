import { stat } from "node:fs/promises";
import type { SessionChainStore } from "pi-xk-core";
import {
	formatSessionChainRollupPublicationStatus,
	isAutomaticRollupRetryExhausted,
	MAX_AUTOMATIC_ROLLUP_ATTEMPTS,
} from "./session-chain-rollup.ts";

export interface SessionChainDiagnostic {
	severity: "warning" | "error";
	code: string;
	message: string;
	branchId?: string;
	segmentId?: string;
}

export interface SessionChainDoctorReport {
	chainId: string;
	mode: "quick" | "deep";
	durationMs: number;
	filesChecked: number;
	bytesRead: number;
	diagnostics: SessionChainDiagnostic[];
}

interface RollupPublicationDiagnosticState {
	windowIndex: number;
	status: string;
	artifactId: string | null;
	attempt: number;
	errorCode: string | null;
	retryable: boolean | null;
}

export function diagnoseRollupPublication(
	publication: RollupPublicationDiagnosticState,
	branchId: string,
): SessionChainDiagnostic | null {
	if (publication.status === "published") return null;
	const retryExhausted = isAutomaticRollupRetryExhausted({
		status: publication.status === "failed" ? "failed" : "scheduled",
		attempt: publication.attempt,
		errorCode: publication.errorCode,
		retryable: publication.retryable,
	});
	return {
		severity: "warning",
		code:
			publication.artifactId !== null
				? "rollup_publication_pending"
				: retryExhausted
					? "rollup_generation_review_required"
					: publication.status === "failed" && publication.retryable === false
						? "rollup_source_repair_required"
						: "rollup_retry_pending",
		message: retryExhausted
			? `Rollup W${publication.windowIndex} produced invalid model output ${publication.attempt} times; automatic retries are exhausted and the response contract requires review`
			: `Rollup publication is ${formatSessionChainRollupPublicationStatus({
					...publication,
					status:
						publication.status === "scheduled" ||
						publication.status === "generating" ||
						publication.status === "artifact_ready" ||
						publication.status === "failed" ||
						publication.status === "published"
							? publication.status
							: "failed",
				})}`,
		branchId,
	};
}

interface QuickSessionChainDoctorOptions {
	chainId: string;
	store: SessionChainStore;
	getRollupPublication: (
		chainId: string,
		branchId: string,
		windowIndex: number,
	) => Promise<RollupPublicationDiagnosticState | null | undefined>;
	rollupMarkdownPath: (chainId: string, branchId: string, windowIndex: number) => string;
}

export async function runQuickSessionChainDoctor(
	options: QuickSessionChainDoctorOptions,
): Promise<SessionChainDoctorReport> {
	const { chainId, store } = options;
	const startedAt = Date.now();
	const diagnostics: SessionChainDiagnostic[] = [];
	let filesChecked = 0;
	let bytesRead = 0;
	try {
		filesChecked += 1;
		const lock = await store.inspectWriteLock(chainId);
		if (lock) {
			const abandoned = !lock.malformed && lock.ownerState === "missing" && lock.nonce;
			diagnostics.push({
				severity: abandoned ? "warning" : "error",
				code: abandoned ? "write_lock_abandoned" : "write_lock_unrecoverable",
				message: abandoned
					? `Write lock owner PID ${lock.pid} is missing; run /chain doctor repair-lock ${lock.nonce}`
					: lock.malformed
						? "Write lock metadata is malformed and cannot be automatically recovered"
						: `Write lock owner state is ${lock.ownerState}; explicit recovery is not allowed`,
			});
		}
	} catch (error) {
		diagnostics.push({
			severity: "error",
			code: "write_lock_diagnostic_failed",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	let readModel: Awaited<ReturnType<SessionChainStore["loadChainReadModel"]>> | undefined;
	try {
		filesChecked += 2;
		const loaded = await store.loadChainReadModelSnapshot(chainId);
		readModel = loaded.readModel;
		bytesRead += loaded.diagnostic.bytesRead;
	} catch (error) {
		diagnostics.push({
			severity: "error",
			code: "manifest_read_model_inconsistent",
			message: `Session Chain summary manifest cannot trust the current read model: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	if (readModel) {
		try {
			filesChecked += 1;
			const catalog = await store.loadCatalog();
			const entry = catalog.chains.find((candidate) => candidate.chainId === chainId);
			if (!entry || entry.sequence !== readModel.sequence || entry.baseHash !== readModel.baseHash) {
				throw new Error("Session Chain catalog head does not match its read model");
			}
		} catch (error) {
			diagnostics.push({
				severity: "error",
				code: "catalog_projection_inconsistent",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		for (const branch of readModel.branches) {
			const diagnosedRollupWindows = new Set<number>();
			if (branch.pendingRollover) {
				diagnostics.push({
					severity: "warning",
					code: "rollover_recovery_required",
					message: `Prepared rollover to ${branch.pendingRollover.targetSegment.segmentId} requires recovery`,
					branchId: branch.branchId,
					segmentId: branch.pendingRollover.sourceSegmentId,
				});
			}
			const nextWindowIndex = (branch.rollups.at(-1)?.windowIndex ?? 0) + 1;
			try {
				filesChecked += 1;
				const publication = await options.getRollupPublication(chainId, branch.branchId, nextWindowIndex);
				if (publication) {
					const diagnostic = diagnoseRollupPublication(publication, branch.branchId);
					if (diagnostic) {
						diagnostics.push(diagnostic);
						diagnosedRollupWindows.add(publication.windowIndex);
					}
				}
			} catch (error) {
				diagnostics.push({
					severity: "error",
					code: "rollup_publication_state_invalid",
					message: error instanceof Error ? error.message : String(error),
					branchId: branch.branchId,
				});
			}
			for (const projection of branch.rollups) {
				filesChecked += 1;
				try {
					await stat(options.rollupMarkdownPath(chainId, branch.branchId, projection.windowIndex));
				} catch (error) {
					diagnostics.push({
						severity: "warning",
						code: "rollup_markdown_missing",
						message: `Rollup W${projection.windowIndex} Markdown projection is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						branchId: branch.branchId,
					});
				}
			}
			const latestFailures = new Map<number, (typeof branch.rollupFailures)[number]>();
			for (const failure of branch.rollupFailures) {
				const previous = latestFailures.get(failure.windowIndex);
				if (!previous || previous.attempt < failure.attempt) latestFailures.set(failure.windowIndex, failure);
			}
			for (const failure of latestFailures.values()) {
				if (branch.rollups.some((rollup) => rollup.windowIndex === failure.windowIndex)) continue;
				if (diagnosedRollupWindows.has(failure.windowIndex)) continue;
				const retryExhausted =
					failure.errorCode === "rollup_invalid_response" &&
					failure.retryable &&
					failure.attempt >= MAX_AUTOMATIC_ROLLUP_ATTEMPTS;
				diagnostics.push({
					severity: "warning",
					code: retryExhausted
						? "rollup_generation_review_required"
						: failure.retryable
							? "rollup_retry_pending"
							: "rollup_source_repair_required",
					message: retryExhausted
						? `Rollup W${failure.windowIndex} produced invalid model output ${failure.attempt} times; automatic retries are exhausted`
						: failure.retryable
							? `Rollup W${failure.windowIndex} can be retried automatically`
							: `Rollup W${failure.windowIndex} requires source or configuration repair`,
					branchId: branch.branchId,
				});
			}
		}
	}
	return {
		chainId,
		mode: "quick",
		durationMs: Date.now() - startedAt,
		filesChecked,
		bytesRead,
		diagnostics,
	};
}
