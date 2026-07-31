import { ArtifactCorruptionError, ArtifactNotFoundError, type ArtifactStore } from "./artifact-store.ts";
import { stableJsonStringify } from "./stable-json.ts";
import {
	TASK_READ_MODEL_SCHEMA,
	type TaskEvent,
	type TaskReadModel,
	type TaskTerminalStatus,
} from "./task-contract.ts";
import type { TaskReplay } from "./task-store.ts";

export class TaskReadModelStaleError extends Error {
	constructor(taskId: string) {
		super(`Task read model is stale or no longer matches facts: ${taskId}`);
		this.name = "TaskReadModelStaleError";
	}
}

export async function assertTaskArtifactReferences(
	artifactIds: readonly string[],
	artifacts: ArtifactStore,
): Promise<void> {
	for (const artifactId of new Set(artifactIds)) await artifacts.read(artifactId);
}

async function artifactStatusFor(
	artifactIds: readonly string[],
	artifacts: ArtifactStore,
): Promise<"valid" | "missing" | "corrupt"> {
	let missing = false;
	for (const artifactId of new Set(artifactIds)) {
		try {
			await artifacts.read(artifactId);
		} catch (error) {
			if (error instanceof ArtifactCorruptionError) return "corrupt";
			if (error instanceof ArtifactNotFoundError) missing = true;
			else throw error;
		}
	}
	return missing ? "missing" : "valid";
}

function statusForTerminal(event: TaskEvent): TaskTerminalStatus {
	switch (event.eventType) {
		case "task_succeeded":
			return "succeeded";
		case "task_failed":
			return "failed";
		case "task_cancelled":
			return "cancelled";
		case "task_orphaned":
			return "orphaned";
		default:
			throw new Error("Task event is not terminal");
	}
}

export async function buildTaskReadModel(replay: TaskReplay, artifacts: ArtifactStore): Promise<TaskReadModel> {
	const started = replay.events.find((event) => event.eventType === "task_started");
	const terminal = replay.events.find(
		(event) =>
			event.eventType === "task_succeeded" ||
			event.eventType === "task_failed" ||
			event.eventType === "task_cancelled" ||
			event.eventType === "task_orphaned",
	);
	let artifactStatus: "valid" | "missing" | "corrupt" | undefined;
	if (terminal) {
		artifactStatus = await artifactStatusFor(
			[terminal.payload.resultArtifactId, ...terminal.payload.artifactIds],
			artifacts,
		);
	}
	return {
		schema: TASK_READ_MODEL_SCHEMA,
		taskId: replay.taskId,
		sequence: replay.head.sequence,
		baseHash: replay.head.hash,
		spec: replay.spec,
		status: replay.status,
		createdAt: replay.events[0]?.timestamp ?? replay.spec.createdAt,
		...(started?.eventType === "task_started" ? { startedAt: started.timestamp, child: started.payload.child } : {}),
		...(terminal && artifactStatus
			? {
					result: {
						eventId: terminal.eventId,
						status: statusForTerminal(terminal),
						resultArtifactId: terminal.payload.resultArtifactId,
						summary: terminal.payload.summary,
						artifactIds: [...terminal.payload.artifactIds],
						error: terminal.payload.error,
						endedAt: terminal.timestamp,
						artifactStatus,
					},
				}
			: {}),
	};
}

export function sameTaskReadModel(left: TaskReadModel, right: TaskReadModel): boolean {
	return stableJsonStringify(left) === stableJsonStringify(right);
}
