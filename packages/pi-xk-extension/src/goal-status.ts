import type { GoalFilesDiagnostic, GoalLifecycleStatus, GoalReplay } from "pi-xk-core";

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export interface GoalStatusSnapshot {
	status: GoalLifecycleStatus;
	activeElapsed: number;
	observedAt: number;
}

export function formatGoalFooterStatus(snapshot: GoalStatusSnapshot, now: number): string {
	const activeElapsed =
		snapshot.status === "active"
			? snapshot.activeElapsed + Math.max(0, now - snapshot.observedAt)
			: snapshot.activeElapsed;
	return `Goal ${snapshot.status} · ${formatDuration(activeElapsed)}`;
}

export function readGoalStateSection(markdown: string, section: string, fallback = "Not recorded."): string {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${section.toLowerCase()}`);
	if (start < 0) return fallback;
	const values: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s+/.test(line.trim())) break;
		const normalized = line.trim().replace(/^[-*]\s+/, "");
		if (normalized.length > 0) values.push(normalized);
	}
	return values.join(" ") || fallback;
}

export function renderGoalStatus(
	goalId: string,
	replay: GoalReplay,
	files: GoalFilesDiagnostic,
	stateMarkdown?: string,
): string {
	const unavailable = "Unavailable while goal-state.md is invalid.";
	const nextAction = stateMarkdown ? readGoalStateSection(stateMarkdown, "next_best_action") : unavailable;
	const blockers = stateMarkdown ? readGoalStateSection(stateMarkdown, "blocked_on") : unavailable;
	const acceptanceGaps = stateMarkdown ? readGoalStateSection(stateMarkdown, "acceptance_gaps") : unavailable;
	const requiredAcceptanceIds = replay.contract.acceptance
		.filter((acceptance) => acceptance.required)
		.map((acceptance) => acceptance.id);
	const verifiedAcceptanceIds = new Set(replay.lifecycle.end?.verifiedAcceptanceIds ?? []);
	const missingAcceptanceIds = new Set(replay.lifecycle.lastPause?.audit.unmetRequiredAcceptanceIds ?? []);
	const acceptanceStatus = requiredAcceptanceIds.map((id) =>
		verifiedAcceptanceIds.has(id)
			? `${id}=verified`
			: missingAcceptanceIds.has(id)
				? `${id}=missing`
				: `${id}=unverified`,
	);
	const latestCheckpoint = [...replay.events].reverse().find((event) => event.eventType === "goal_checkpointed");
	const latestRun = replay.lifecycle.runs.at(-1);
	return [
		`Pi-XK Goal ${replay.contract.title} (${goalId})`,
		`Objective: ${replay.contract.objective}`,
		`Lifecycle: ${replay.lifecycle.status}; wall ${formatDuration(replay.lifecycle.wallElapsed)}, active ${formatDuration(replay.lifecycle.activeElapsed)}, busy ${formatDuration(replay.lifecycle.busyElapsed)}`,
		`Runs: ${replay.lifecycle.runs.length}; current ${replay.lifecycle.openRunId ?? "none"}; latest ${latestRun ? `${latestRun.runId} ${latestRun.status}` : "none"}`,
		`Required acceptance: ${acceptanceStatus.length > 0 ? acceptanceStatus.join(", ") : "none"}`,
		`Latest checkpoint: ${latestCheckpoint ? `${latestCheckpoint.payload.checkpoint.reason} at ${latestCheckpoint.timestamp}` : "none"}`,
		`Latest pause/blocker: ${replay.lifecycle.lastPause ? `${replay.lifecycle.lastPause.reason}; next ${replay.lifecycle.lastPause.nextBestAction}` : "none"}`,
		`goal-state.md: ${files.state.path} (${files.state.status})`,
		`Next action: ${nextAction}`,
		`Blockers: ${blockers}`,
		`Acceptance gaps: ${acceptanceGaps}`,
		`Files: objective ${files.objective.status}, state ${files.state.status}`,
	].join("\n");
}
