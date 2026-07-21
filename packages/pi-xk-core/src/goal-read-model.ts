import { ArtifactCorruptionError, ArtifactNotFoundError, type ArtifactStore } from "./artifact-store.ts";
import {
	assertGoalId,
	GOAL_READ_MODEL_SCHEMA,
	type GoalArtifactDiagnostic,
	type GoalCheckpointV2,
	type GoalLifecycleProjection,
	type GoalReadModel,
	type GoalRunProjection,
	GoalValidationError,
	upcastGoalCheckpoint,
	validateGoalCheckpoint,
} from "./contract.ts";
import type { GoalReplay } from "./goal-store.ts";
import { stableJsonStringify } from "./stable-json.ts";

export class GoalReadModelStaleError extends Error {
	constructor(goalId: string) {
		super(`Goal read model is stale or no longer matches facts: ${goalId}`);
		this.name = "GoalReadModelStaleError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new GoalValidationError(`${field} has unknown or missing fields`);
	}
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new GoalValidationError(`${field} must be a non-negative integer`);
	}
	return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GoalValidationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
	const timestamp = requireNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(timestamp))) {
		throw new GoalValidationError(`${field} must be an ISO timestamp`);
	}
	return timestamp;
}

function validateRunProjection(value: unknown, index: number): GoalRunProjection {
	if (!isRecord(value)) {
		throw new GoalValidationError(`Goal read model lifecycle runs[${index}] must be an object`);
	}
	const hasEndedAt = "endedAt" in value;
	requireExactKeys(
		value,
		hasEndedAt
			? ["runId", "sessionId", "startedAt", "endedAt", "status"]
			: ["runId", "sessionId", "startedAt", "status"],
		`Goal read model lifecycle runs[${index}]`,
	);
	if (value.status !== "settled" && value.status !== "interrupted") {
		throw new GoalValidationError(`Goal read model lifecycle runs[${index}].status is invalid`);
	}
	return {
		runId: requireNonEmptyString(value.runId, `runs[${index}].runId`),
		sessionId: requireNonEmptyString(value.sessionId, `runs[${index}].sessionId`),
		startedAt: requireIsoTimestamp(value.startedAt, `runs[${index}].startedAt`),
		...(hasEndedAt ? { endedAt: requireIsoTimestamp(value.endedAt, `runs[${index}].endedAt`) } : {}),
		status: value.status,
	};
}

function requireGoalActor(value: unknown, field: string): "user" | "runtime" | "model" | "child-task" | "system" {
	if (value !== "user" && value !== "runtime" && value !== "model" && value !== "child-task" && value !== "system") {
		throw new GoalValidationError(`${field} is invalid`);
	}
	return value;
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new GoalValidationError(`${field} must be a string array`);
	}
	return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function validatePauseRecord(value: unknown): NonNullable<GoalLifecycleProjection["lastPause"]> {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal read model lifecycle lastPause must be an object");
	}
	requireExactKeys(
		value,
		["actor", "reason", "userRequest", "nextBestAction", "audit"],
		"Goal read model lifecycle lastPause",
	);
	if (!isRecord(value.audit)) {
		throw new GoalValidationError("Goal read model lifecycle lastPause.audit must be an object");
	}
	requireExactKeys(
		value.audit,
		["unmetRequiredAcceptanceIds", "currentEvidence", "incompleteConclusion"],
		"Goal read model lifecycle lastPause.audit",
	);
	if (value.userRequest !== null && typeof value.userRequest !== "string") {
		throw new GoalValidationError("Goal read model lifecycle lastPause.userRequest must be a string or null");
	}
	return {
		actor: requireGoalActor(value.actor, "lifecycle.lastPause.actor"),
		reason: requireNonEmptyString(value.reason, "lifecycle.lastPause.reason"),
		userRequest:
			value.userRequest === null
				? null
				: requireNonEmptyString(value.userRequest, "lifecycle.lastPause.userRequest"),
		nextBestAction: requireNonEmptyString(value.nextBestAction, "lifecycle.lastPause.nextBestAction"),
		audit: {
			unmetRequiredAcceptanceIds: requireStringArray(
				value.audit.unmetRequiredAcceptanceIds,
				"lifecycle.lastPause.audit.unmetRequiredAcceptanceIds",
			),
			currentEvidence: requireNonEmptyString(
				value.audit.currentEvidence,
				"lifecycle.lastPause.audit.currentEvidence",
			),
			incompleteConclusion: requireNonEmptyString(
				value.audit.incompleteConclusion,
				"lifecycle.lastPause.audit.incompleteConclusion",
			),
		},
	};
}

function validateResumeRecord(value: unknown): NonNullable<GoalLifecycleProjection["lastResume"]> {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal read model lifecycle lastResume must be an object");
	}
	requireExactKeys(value, ["actor", "reason", "resumeEvidence"], "Goal read model lifecycle lastResume");
	return {
		actor: requireGoalActor(value.actor, "lifecycle.lastResume.actor"),
		reason: requireNonEmptyString(value.reason, "lifecycle.lastResume.reason"),
		resumeEvidence: requireNonEmptyString(value.resumeEvidence, "lifecycle.lastResume.resumeEvidence"),
	};
}

function validateEndRecord(value: unknown): NonNullable<GoalLifecycleProjection["end"]> {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal read model lifecycle end must be an object");
	}
	requireExactKeys(
		value,
		["actor", "outcome", "reason", "verifiedAcceptanceIds", "finalEvidence", "finalSummary"],
		"Goal read model lifecycle end",
	);
	return {
		actor: requireGoalActor(value.actor, "lifecycle.end.actor"),
		outcome: requireNonEmptyString(value.outcome, "lifecycle.end.outcome"),
		reason: requireNonEmptyString(value.reason, "lifecycle.end.reason"),
		verifiedAcceptanceIds: requireStringArray(value.verifiedAcceptanceIds, "lifecycle.end.verifiedAcceptanceIds"),
		finalEvidence: requireNonEmptyString(value.finalEvidence, "lifecycle.end.finalEvidence"),
		finalSummary: requireNonEmptyString(value.finalSummary, "lifecycle.end.finalSummary"),
	};
}

function validateLifecycleProjection(value: unknown): GoalLifecycleProjection {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal read model lifecycle must be an object");
	}
	const optionalKeys = ["activatedAt", "pausedAt", "endedAt", "openRunId", "lastPause", "lastResume", "end"].filter(
		(key) => key in value,
	);
	requireExactKeys(
		value,
		["status", "wallElapsed", "activeElapsed", "busyElapsed", "runs", ...optionalKeys],
		"Goal read model lifecycle",
	);
	if (
		value.status !== "inactive" &&
		value.status !== "active" &&
		value.status !== "paused" &&
		value.status !== "ended"
	) {
		throw new GoalValidationError("Goal read model lifecycle status is invalid");
	}
	if (!Array.isArray(value.runs)) {
		throw new GoalValidationError("Goal read model lifecycle runs must be an array");
	}
	return {
		status: value.status,
		...(value.activatedAt === undefined
			? {}
			: { activatedAt: requireIsoTimestamp(value.activatedAt, "lifecycle.activatedAt") }),
		...(value.pausedAt === undefined ? {} : { pausedAt: requireIsoTimestamp(value.pausedAt, "lifecycle.pausedAt") }),
		...(value.endedAt === undefined ? {} : { endedAt: requireIsoTimestamp(value.endedAt, "lifecycle.endedAt") }),
		wallElapsed: requireNonNegativeInteger(value.wallElapsed, "lifecycle.wallElapsed"),
		activeElapsed: requireNonNegativeInteger(value.activeElapsed, "lifecycle.activeElapsed"),
		busyElapsed: requireNonNegativeInteger(value.busyElapsed, "lifecycle.busyElapsed"),
		runs: value.runs.map(validateRunProjection),
		...(value.openRunId === undefined
			? {}
			: { openRunId: requireNonEmptyString(value.openRunId, "lifecycle.openRunId") }),
		...(value.lastPause === undefined ? {} : { lastPause: validatePauseRecord(value.lastPause) }),
		...(value.lastResume === undefined ? {} : { lastResume: validateResumeRecord(value.lastResume) }),
		...(value.end === undefined ? {} : { end: validateEndRecord(value.end) }),
	};
}

function validateArtifactDiagnostics(value: unknown): GoalArtifactDiagnostic[] {
	if (!Array.isArray(value)) {
		throw new GoalValidationError("Goal read model artifactDiagnostics must be an array");
	}
	const artifactIds = new Set<string>();
	return value.map((candidate, index) => {
		if (!isRecord(candidate)) {
			throw new GoalValidationError(`Goal read model artifactDiagnostics[${index}] must be an object`);
		}
		requireExactKeys(candidate, ["artifactId", "status"], `Goal read model artifactDiagnostics[${index}]`);
		const artifactId = requireNonEmptyString(candidate.artifactId, `artifactDiagnostics[${index}].artifactId`);
		if (!/^sha256:[a-f0-9]{64}$/.test(artifactId)) {
			throw new GoalValidationError(`artifactDiagnostics[${index}].artifactId is invalid`);
		}
		if (candidate.status !== "valid" && candidate.status !== "missing" && candidate.status !== "corrupt") {
			throw new GoalValidationError(`artifactDiagnostics[${index}].status is invalid`);
		}
		if (artifactIds.has(artifactId)) {
			throw new GoalValidationError("Goal read model artifactDiagnostics must not duplicate artifact IDs");
		}
		artifactIds.add(artifactId);
		return { artifactId, status: candidate.status };
	});
}

export function validateGoalReadModel(value: unknown): GoalReadModel {
	if (!isRecord(value)) {
		throw new GoalValidationError("Goal read model must be an object");
	}
	const hasLatestCheckpoint = "latestCheckpoint" in value;
	requireExactKeys(
		value,
		hasLatestCheckpoint
			? [
					"schema",
					"goalId",
					"sequence",
					"baseHash",
					"lifecycle",
					"checkpointCount",
					"latestCheckpoint",
					"artifactDiagnostics",
				]
			: ["schema", "goalId", "sequence", "baseHash", "lifecycle", "checkpointCount", "artifactDiagnostics"],
		"Goal read model",
	);
	if (value.schema !== GOAL_READ_MODEL_SCHEMA) {
		throw new GoalValidationError("Goal read model schema is unsupported");
	}
	const goalId = requireNonEmptyString(value.goalId, "Goal read model goalId");
	assertGoalId(goalId);
	const sequence = requireNonNegativeInteger(value.sequence, "Goal read model sequence");
	const baseHash = requireNonEmptyString(value.baseHash, "Goal read model baseHash");
	if (!baseHash.startsWith("sha256:")) {
		throw new GoalValidationError("Goal read model baseHash is invalid");
	}
	const lifecycle = validateLifecycleProjection(value.lifecycle);
	const checkpointCount = requireNonNegativeInteger(value.checkpointCount, "Goal read model checkpointCount");
	const artifactDiagnostics = validateArtifactDiagnostics(value.artifactDiagnostics);
	if (!hasLatestCheckpoint) {
		return {
			schema: GOAL_READ_MODEL_SCHEMA,
			goalId,
			sequence,
			baseHash,
			lifecycle,
			checkpointCount,
			artifactDiagnostics,
		};
	}
	if (!isRecord(value.latestCheckpoint)) {
		throw new GoalValidationError("Goal read model latestCheckpoint must be an object");
	}
	requireExactKeys(value.latestCheckpoint, ["eventId", "checkpoint"], "Goal read model latestCheckpoint");
	const eventId = requireNonEmptyString(value.latestCheckpoint.eventId, "Goal read model latestCheckpoint eventId");
	const checkpoint = validateGoalCheckpoint(value.latestCheckpoint.checkpoint);
	if (checkpoint.schema !== "pi-xk.goal-checkpoint.v2") {
		throw new GoalValidationError("Goal read model latestCheckpoint must use checkpoint v2");
	}
	if (checkpointCount === 0) {
		throw new GoalValidationError("Goal read model latestCheckpoint requires a checkpoint");
	}
	return {
		schema: GOAL_READ_MODEL_SCHEMA,
		goalId,
		sequence,
		baseHash,
		lifecycle,
		checkpointCount,
		latestCheckpoint: { eventId, checkpoint },
		artifactDiagnostics,
	};
}

async function buildArtifactDiagnostics(
	checkpoints: readonly GoalCheckpointV2[],
	artifactStore: ArtifactStore,
): Promise<GoalArtifactDiagnostic[]> {
	const artifactIds = new Set<string>();
	for (const checkpoint of checkpoints) {
		for (const artifact of checkpoint.evidence.artifacts) {
			artifactIds.add(artifact.artifactId);
		}
	}
	const diagnostics: GoalArtifactDiagnostic[] = [];
	for (const artifactId of [...artifactIds].sort()) {
		try {
			await artifactStore.read(artifactId);
			diagnostics.push({ artifactId, status: "valid" });
		} catch (error) {
			if (error instanceof ArtifactNotFoundError) {
				diagnostics.push({ artifactId, status: "missing" });
			} else if (error instanceof ArtifactCorruptionError) {
				diagnostics.push({ artifactId, status: "corrupt" });
			} else {
				throw error;
			}
		}
	}
	return diagnostics;
}

export async function buildGoalReadModel(replay: GoalReplay, artifactStore: ArtifactStore): Promise<GoalReadModel> {
	const checkpoints = replay.events
		.filter((event) => event.eventType === "goal_checkpointed")
		.map((event) => ({ eventId: event.eventId, checkpoint: upcastGoalCheckpoint(event.payload.checkpoint) }));
	const checkpointValues = checkpoints.map(({ checkpoint }) => checkpoint);
	const latestCheckpoint = checkpoints.at(-1);
	return {
		schema: GOAL_READ_MODEL_SCHEMA,
		goalId: replay.goalId,
		sequence: replay.head.sequence,
		baseHash: replay.head.hash,
		lifecycle: replay.lifecycle,
		checkpointCount: checkpoints.length,
		...(latestCheckpoint === undefined ? {} : { latestCheckpoint }),
		artifactDiagnostics: await buildArtifactDiagnostics(checkpointValues, artifactStore),
	};
}

export function sameGoalReadModel(left: GoalReadModel, right: GoalReadModel): boolean {
	return stableJsonStringify(left) === stableJsonStringify(right);
}
