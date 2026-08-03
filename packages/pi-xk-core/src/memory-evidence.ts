import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type EvidenceRefV2, MEMORY_EVIDENCE_REF_V2_SCHEMA } from "./ambient-memory-contract.ts";
import { ArtifactStore } from "./artifact-store.ts";
import type { GoalCheckpointedEvent, GoalEvent } from "./contract.ts";
import {
	GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA,
	validateGoalCheckpointEvidenceArtifactV2,
} from "./goal-checkpoint-evidence.ts";
import { GoalStore } from "./goal-store.ts";
import { type EvidenceRefV1, MemoryValidationError } from "./memory-contract.ts";
import { verifyGitEvidenceLocator } from "./memory-freshness.ts";
import { SessionChainStore } from "./session-chain-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { TaskStore } from "./task-store.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function invalidEvidence(evidence: EvidenceRefV2, message: string): never {
	throw new MemoryValidationError(`Memory evidence ${evidence.evidenceId} ${message}`);
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
	return `sha256:${createHash("sha256")
		.update(
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
		)
		.digest("hex")}`;
}

function finalTurnEndCheckpoint(events: readonly GoalEvent[], beforeSequence: number): GoalCheckpointedEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (
			event &&
			event.sequence < beforeSequence &&
			event.eventType === "goal_checkpointed" &&
			event.payload.checkpoint.reason === "turn_end"
		) {
			return event;
		}
	}
	return null;
}

async function validateGoalCheckpointStateSnapshot(input: {
	artifacts: ArtifactStore;
	evidence: Extract<EvidenceRefV1, { sourceType: "goal_checkpoint" | "goal_completion" }>;
	event: GoalCheckpointedEvent;
	contractRevision: number | null;
	expectedState: string;
}): Promise<void> {
	const checkpoint = input.event.payload.checkpoint;
	if (checkpoint.schema !== "pi-xk.goal-checkpoint.v2" || checkpoint.reason !== "turn_end") {
		invalidEvidence(input.evidence, "has no canonical checkpoint State snapshot");
	}
	for (const reference of checkpoint.evidence.artifacts) {
		if (reference.role !== "checkpoint_evidence") continue;
		const stored = await input.artifacts.read(reference.artifactId);
		if (
			stored.metadata.contentType !== "application/json" ||
			stored.metadata.producer !== GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA
		) {
			continue;
		}
		let snapshot: ReturnType<typeof validateGoalCheckpointEvidenceArtifactV2>;
		try {
			snapshot = validateGoalCheckpointEvidenceArtifactV2(JSON.parse(stored.content) as unknown);
		} catch {
			invalidEvidence(input.evidence, "Goal checkpoint State snapshot is invalid");
		}
		if (
			snapshot.goalId !== input.event.goalId ||
			snapshot.sessionId !== checkpoint.sessionId ||
			snapshot.leafId !== checkpoint.leafId ||
			snapshot.turnIndex !== checkpoint.turnIndex ||
			snapshot.toolResultCount !== checkpoint.toolResultCount ||
			snapshot.createdAt !== checkpoint.createdAt ||
			snapshot.contractRevision !== input.contractRevision ||
			snapshot.goalState !== input.expectedState ||
			!stored.metadata.sourceIds.includes(input.event.goalId) ||
			!stored.metadata.sourceIds.includes(checkpoint.sessionId) ||
			!stored.metadata.sourceIds.includes(checkpoint.leafId)
		) {
			invalidEvidence(input.evidence, "Goal source does not match its checkpoint State snapshot");
		}
		return;
	}
	invalidEvidence(input.evidence, "has no canonical checkpoint State snapshot");
}

export async function resolveMemoryCompactionEvidence(
	projectRoot: string,
	evidence: Extract<EvidenceRefV1, { sourceType: "compaction" }>,
): Promise<Record<string, unknown>> {
	if (evidence.sourceId !== evidence.locator.entryId && evidence.sourceId !== evidence.locator.sessionId) {
		invalidEvidence(evidence, "does not match a Session compaction entry");
	}
	const chains = new SessionChainStore(projectRoot);
	let matchingSessionCount = 0;
	let matchingCompaction: Record<string, unknown> | undefined;
	let missingSegmentFiles = 0;
	let malformedSegmentFiles = 0;
	for (const chain of await chains.listChains()) {
		const replay = await chains.replayChain(chain.chainId);
		for (const branch of replay.branches) {
			for (const segment of branch.segments) {
				const path =
					segment.location.kind === "external-root"
						? resolve(segment.location.absolutePath)
						: join(
								projectRoot,
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
						missingSegmentFiles += 1;
						continue;
					}
					throw error;
				}
				const lines = raw.split("\n").filter((line) => line.length > 0);
				const headerLine = lines[0];
				if (!headerLine) continue;
				let header: unknown;
				try {
					header = JSON.parse(headerLine) as unknown;
				} catch {
					malformedSegmentFiles += 1;
					continue;
				}
				if (!isRecord(header) || header.type !== "session" || header.id !== evidence.locator.sessionId) continue;
				matchingSessionCount += 1;
				for (const line of lines.slice(1)) {
					let entry: unknown;
					try {
						entry = JSON.parse(line) as unknown;
					} catch {
						invalidEvidence(evidence, "Session compaction source JSONL is malformed");
					}
					if (!isRecord(entry)) continue;
					if (
						entry.type === "compaction" &&
						entry.id === evidence.locator.entryId &&
						entry.title === evidence.locator.title &&
						entry.timestamp === evidence.recordedAt
					) {
						matchingCompaction = entry;
					}
				}
			}
		}
	}
	if (matchingSessionCount > 1) invalidEvidence(evidence, "matches more than one Session header");
	if (matchingSessionCount === 1) {
		return matchingCompaction ?? invalidEvidence(evidence, "does not match a Session compaction entry");
	}
	if (malformedSegmentFiles > 0) {
		invalidEvidence(evidence, "Session compaction source JSONL is malformed or no longer matches its Session header");
	}
	if (missingSegmentFiles > 0) invalidEvidence(evidence, "Session compaction source file is missing");
	return invalidEvidence(evidence, "does not match a Session compaction entry");
}

export async function validateMemoryEvidenceOwnership(projectRoot: string, evidence: EvidenceRefV2): Promise<void> {
	const artifacts = new ArtifactStore(projectRoot);
	if (evidence.schema === MEMORY_EVIDENCE_REF_V2_SCHEMA) {
		const locator = evidence.locator;
		if (evidence.sourceId !== `${locator.sessionId}:${locator.requestEntryId}`) {
			invalidEvidence(evidence, "does not match its Agent run entry range");
		}
		if (evidence.sourceDigest !== locator.rangeDigest) {
			invalidEvidence(evidence, "sourceDigest does not match its Agent run rangeDigest");
		}
		let sessionPath: string;
		let projectPath: string;
		try {
			[sessionPath, projectPath] = await Promise.all([
				realpath(resolve(locator.sessionFile)),
				realpath(resolve(projectRoot)),
			]);
		} catch (error) {
			invalidEvidence(
				evidence,
				`Agent run Session path is unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		let values: unknown[];
		try {
			values = (await readFile(sessionPath, "utf8"))
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as unknown);
		} catch {
			invalidEvidence(evidence, "Agent run Session JSONL is malformed or unreadable");
		}
		const header = values[0];
		if (
			!isRecord(header) ||
			header.type !== "session" ||
			header.id !== locator.sessionId ||
			typeof header.cwd !== "string"
		) {
			invalidEvidence(evidence, "does not match its native Session header and project");
		}
		let headerProjectPath: string;
		try {
			headerProjectPath = await realpath(resolve(header.cwd));
		} catch {
			invalidEvidence(evidence, "native Session header project path is unavailable");
		}
		if (headerProjectPath !== projectPath) {
			invalidEvidence(evidence, "does not match its native Session header and project");
		}
		if (locator.chainId !== null && locator.branchId !== null && locator.segmentId !== null) {
			const replay = await new SessionChainStore(projectRoot).replayChain(locator.chainId);
			const branch = replay.branches.find((candidate) => candidate.branchId === locator.branchId);
			const segment = branch?.segments.find((candidate) => candidate.segmentId === locator.segmentId);
			if (!branch || !segment) invalidEvidence(evidence, "has no matching Session Chain Segment");
			const segmentPath =
				segment.location.kind === "external-root"
					? resolve(segment.location.absolutePath)
					: join(
							projectRoot,
							".pi-xk",
							"sessions",
							"chains",
							locator.chainId,
							"branches",
							locator.branchId,
							"segments",
							segment.location.fileName,
						);
			let canonicalSegmentPath: string;
			try {
				canonicalSegmentPath = await realpath(segmentPath);
			} catch {
				invalidEvidence(evidence, "Session Chain Segment file is unavailable");
			}
			if (canonicalSegmentPath !== sessionPath) {
				invalidEvidence(evidence, "Session file does not match its Session Chain Segment");
			}
		}
		const entries = values.slice(1);
		const start = entries.findIndex((entry) => isRecord(entry) && entry.id === locator.requestEntryId);
		const end = entries.findIndex((entry) => isRecord(entry) && entry.id === locator.terminalAssistantEntryId);
		if (start < 0 || end < start) invalidEvidence(evidence, "has no matching Agent run entry range");
		const matchedRange = entries.slice(start, end + 1);
		const matchedIds = new Set(
			matchedRange
				.filter(isRecord)
				.map((entry) => entry.id)
				.filter((id): id is string => typeof id === "string"),
		);
		if (locator.toolResultEntryIds.some((entryId) => !matchedIds.has(entryId))) {
			invalidEvidence(evidence, "does not contain every referenced tool result entry");
		}
		const request = matchedRange?.[0];
		const terminal = matchedRange?.at(-1);
		if (
			!isRecord(request) ||
			request.type !== "message" ||
			!isRecord(request.message) ||
			request.message.role !== "user"
		) {
			invalidEvidence(evidence, "does not start at a user request");
		}
		if (
			!isRecord(terminal) ||
			terminal.type !== "message" ||
			!isRecord(terminal.message) ||
			terminal.message.role !== "assistant" ||
			terminal.message.stopReason === "error" ||
			terminal.message.stopReason === "aborted" ||
			terminal.message.stopReason === "length"
		) {
			invalidEvidence(evidence, "does not end at a successful terminal assistant response");
		}
		for (const toolResultEntryId of locator.toolResultEntryIds) {
			const toolResult = matchedRange.find((entry) => isRecord(entry) && entry.id === toolResultEntryId);
			if (
				!isRecord(toolResult) ||
				toolResult.type !== "message" ||
				!isRecord(toolResult.message) ||
				toolResult.message.role !== "toolResult"
			) {
				invalidEvidence(evidence, `tool result entry is not a tool result: ${toolResultEntryId}`);
			}
		}
		const rangeDigest = `sha256:${createHash("sha256").update(stableJsonStringify(matchedRange)).digest("hex")}`;
		if (rangeDigest !== locator.rangeDigest) invalidEvidence(evidence, "Agent run entry range digest is invalid");
		return;
	}
	if (evidence.sourceType === "explicit") {
		if (evidence.sourceId !== evidence.locator.commandId) {
			invalidEvidence(evidence, "does not match its explicit command");
		}
		const artifactId = evidence.artifactId;
		if (!artifactId) invalidEvidence(evidence, "has no explicit artifact");
		const artifact = await artifacts.read(artifactId);
		if (
			evidence.sourceDigest !== artifactId ||
			artifact.metadata.contentType !== "text/plain" ||
			artifact.metadata.producer !== "pi-xk.memory-explicit.v1" ||
			!artifact.metadata.sourceIds.includes(evidence.locator.commandId)
		) {
			invalidEvidence(evidence, "artifact is not owned by its explicit command");
		}
		return;
	}
	if (evidence.sourceType === "goal_checkpoint" || evidence.sourceType === "goal_completion") {
		const goalId = evidence.locator.goalId;
		const eventId =
			evidence.sourceType === "goal_checkpoint" ? evidence.locator.checkpointEventId : evidence.locator.eventId;
		const replay = await new GoalStore(projectRoot).replayGoal(goalId);
		const event = replay.events.find((candidate) => candidate.eventId === eventId);
		if (!event) invalidEvidence(evidence, "has no Goal event");
		if (evidence.sourceId !== eventId) invalidEvidence(evidence, "does not match its Goal event");
		if (
			(evidence.sourceType === "goal_checkpoint" && event.eventType !== "goal_checkpointed") ||
			(evidence.sourceType === "goal_completion" && event.eventType !== "goal_ended")
		) {
			invalidEvidence(evidence, "has the wrong Goal event type");
		}
		const artifactId = evidence.artifactId;
		if (!artifactId) invalidEvidence(evidence, "has no Goal source artifact");
		const stored = await artifacts.read(artifactId);
		if (
			evidence.sourceDigest !== artifactId ||
			stored.metadata.contentType !== "application/json" ||
			stored.metadata.producer !== "pi-xk.memory-goal-source.v1" ||
			!stored.metadata.sourceIds.includes(goalId) ||
			!stored.metadata.sourceIds.includes(eventId)
		) {
			invalidEvidence(evidence, "Goal source artifact metadata or digest is invalid");
		}
		let source: unknown;
		try {
			source = JSON.parse(stored.content) as unknown;
		} catch {
			invalidEvidence(evidence, "Goal source artifact is not JSON");
		}
		if (!isRecord(source) || !exactKeys(source, ["schema", "goalId", "contractRevision", "event", "state"])) {
			invalidEvidence(evidence, "Goal source artifact schema is invalid");
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
			invalidEvidence(evidence, "Goal source artifact does not preserve the located event");
		}
		if (evidence.sourceType === "goal_checkpoint" && event.eventType === "goal_checkpointed") {
			await validateGoalCheckpointStateSnapshot({
				artifacts,
				evidence,
				event,
				contractRevision,
				expectedState: source.state,
			});
		}
		if (evidence.sourceType === "goal_completion" && event.eventType === "goal_ended") {
			const finalCheckpoint = finalTurnEndCheckpoint(replay.events, event.sequence);
			if (!finalCheckpoint) invalidEvidence(evidence, "has no final canonical checkpoint State snapshot");
			await validateGoalCheckpointStateSnapshot({
				artifacts,
				evidence,
				event: finalCheckpoint,
				contractRevision,
				expectedState: source.state,
			});
		}
		return;
	}
	if (evidence.sourceType === "chain_summary") {
		const locator = evidence.locator;
		const chains = new SessionChainStore(projectRoot);
		const replay = await chains.replayChain(locator.chainId);
		const branch = replay.branches.find((candidate) => candidate.branchId === locator.branchId);
		if (!branch) invalidEvidence(evidence, "has no Session Chain branch");
		const artifactId = evidence.artifactId;
		if (!artifactId) invalidEvidence(evidence, "has no Session Chain summary artifact");
		if (evidence.sourceDigest !== artifactId)
			invalidEvidence(evidence, "summary sourceDigest does not match its artifact");
		if (locator.level === "l1") {
			const segment = branch.segments.find(
				(candidate) => candidate.segmentId === locator.segmentId && candidate.ordinal === locator.ordinal,
			);
			if (!segment) invalidEvidence(evidence, "has no matching L1 Segment");
			if (!segment.seal || segment.seal.summaryArtifactId !== artifactId || evidence.sourceId !== artifactId) {
				invalidEvidence(evidence, "does not match its sealed L1 Segment");
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
				invalidEvidence(evidence, "L1 summary artifact provenance does not match the chain topology");
			}
		} else {
			const rollup = branch.rollups.find(
				(candidate) =>
					candidate.windowIndex === locator.windowIndex &&
					candidate.artifactId === artifactId &&
					candidate.eventId === evidence.sourceId,
			);
			if (!rollup) invalidEvidence(evidence, "has no published L2 Rollup");
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
				invalidEvidence(evidence, "L2 Rollup artifact provenance does not match its ordered L1 sources");
			}
		}
		return;
	}
	if (evidence.sourceType === "task_result") {
		const artifactId = evidence.artifactId;
		if (!artifactId) invalidEvidence(evidence, "has no Task result artifact");
		if (evidence.sourceDigest !== artifactId)
			invalidEvidence(evidence, "Task sourceDigest does not match its artifact");
		const inspection = await new TaskStore(projectRoot).inspectTask(evidence.locator.taskId);
		const event = inspection.replay.events.find(
			(candidate) =>
				candidate.eventType !== "task_created" &&
				candidate.eventType !== "task_started" &&
				candidate.payload.resultArtifactId === artifactId,
		);
		if (!event || event.eventType === "task_created" || event.eventType === "task_started") {
			invalidEvidence(evidence, "has no terminal Task result");
		}
		if (evidence.sourceId !== event.eventId && evidence.sourceId !== evidence.locator.taskId) {
			invalidEvidence(evidence, "does not match a terminal Task result");
		}
		if (
			inspection.resultDiagnostic !== "valid" ||
			!inspection.result ||
			inspection.result.taskId !== evidence.locator.taskId ||
			inspection.result.status !== event.payload.status ||
			inspection.replay.resultArtifactId !== artifactId
		) {
			invalidEvidence(evidence, "Task result artifact schema or terminal provenance is invalid");
		}
		return;
	}
	if (evidence.sourceType === "compaction") {
		await resolveMemoryCompactionEvidence(projectRoot, evidence);
		return;
	}
	if (evidence.sourceId !== evidence.locator.baselineCommit)
		invalidEvidence(evidence, "does not match its Git baseline");
	try {
		await verifyGitEvidenceLocator(projectRoot, evidence.locator);
	} catch (error) {
		invalidEvidence(evidence, `Git source is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}
