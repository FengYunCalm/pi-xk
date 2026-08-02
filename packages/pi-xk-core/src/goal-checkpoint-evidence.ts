export const GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA = "pi-xk.checkpoint-evidence.v2";

export interface GoalCheckpointEvidenceArtifactV2 {
	schema: typeof GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA;
	goalId: string;
	sessionId: string;
	leafId: string;
	turnIndex: number;
	toolResultCount: number;
	reason: "turn_end";
	contractRevision: number | null;
	goalState: string;
	createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Goal checkpoint evidence artifact ${field} must be a non-empty string`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`Goal checkpoint evidence artifact ${field} must be a non-negative integer`);
	}
	return value;
}

export function validateGoalCheckpointEvidenceArtifactV2(value: unknown): GoalCheckpointEvidenceArtifactV2 {
	if (!isRecord(value)) throw new Error("Goal checkpoint evidence artifact must be an object");
	const expectedKeys = [
		"contractRevision",
		"createdAt",
		"goalId",
		"goalState",
		"leafId",
		"reason",
		"schema",
		"sessionId",
		"toolResultCount",
		"turnIndex",
	];
	if (Object.keys(value).sort().join(",") !== expectedKeys.join(",")) {
		throw new Error("Goal checkpoint evidence artifact has unknown or missing fields");
	}
	if (value.schema !== GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA) {
		throw new Error("Goal checkpoint evidence artifact schema is unsupported");
	}
	if (value.reason !== "turn_end") throw new Error("Goal checkpoint evidence artifact reason is unsupported");
	if (
		value.contractRevision !== null &&
		(typeof value.contractRevision !== "number" ||
			!Number.isInteger(value.contractRevision) ||
			value.contractRevision < 1)
	) {
		throw new Error("Goal checkpoint evidence artifact contractRevision is invalid");
	}
	const createdAt = nonEmptyString(value.createdAt, "createdAt");
	if (Number.isNaN(Date.parse(createdAt))) {
		throw new Error("Goal checkpoint evidence artifact createdAt must be an ISO timestamp");
	}
	return {
		schema: GOAL_CHECKPOINT_EVIDENCE_ARTIFACT_SCHEMA,
		goalId: nonEmptyString(value.goalId, "goalId"),
		sessionId: nonEmptyString(value.sessionId, "sessionId"),
		leafId: nonEmptyString(value.leafId, "leafId"),
		turnIndex: nonNegativeInteger(value.turnIndex, "turnIndex"),
		toolResultCount: nonNegativeInteger(value.toolResultCount, "toolResultCount"),
		reason: "turn_end",
		contractRevision: value.contractRevision,
		goalState: nonEmptyString(value.goalState, "goalState"),
		createdAt,
	};
}
