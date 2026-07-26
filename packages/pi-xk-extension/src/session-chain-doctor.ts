import { stat } from "node:fs/promises";
import type { SessionChainStore } from "pi-xk-core";

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
	errorCode: string | null;
	retryable: boolean | null;
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
				if (publication && publication.status !== "published") {
					const artifactReady = publication.artifactId !== null;
					diagnostics.push({
						severity: "warning",
						code: artifactReady
							? "rollup_publication_pending"
							: publication.status === "failed" && publication.retryable === false
								? "rollup_source_repair_required"
								: "rollup_retry_pending",
						message: `Rollup W${publication.windowIndex} publication is ${publication.status}${publication.errorCode ? ` (${publication.errorCode})` : ""}`,
						branchId: branch.branchId,
					});
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
			for (const failure of branch.rollupFailures) {
				if (branch.rollups.some((rollup) => rollup.windowIndex === failure.windowIndex)) continue;
				if (
					diagnostics.some(
						(diagnostic) => diagnostic.branchId === branch.branchId && diagnostic.code.startsWith("rollup_"),
					)
				) {
					continue;
				}
				diagnostics.push({
					severity: "warning",
					code: failure.retryable ? "rollup_retry_pending" : "rollup_source_repair_required",
					message: failure.retryable
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
