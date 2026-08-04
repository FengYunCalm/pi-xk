import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AMBIENT_RECALL_BUDGET, GoalStore, type MemoryService, type SkillService, TaskStore } from "pi-xk-core";
import { getGoalRequiredAcceptanceStatus, readGoalStateSection } from "./goal-status.ts";
import { isPiXkSessionLink, isPiXkTaskLink, PI_XK_SESSION_LINK_CUSTOM_TYPE } from "./index.ts";
import { formatSessionChainRollupPublicationStatus, type SessionChainController } from "./session-chain-controller.ts";

function currentGoalId(ctx: ExtensionContext): string | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkSessionLink(entry.data)
		) {
			return entry.data.goalId;
		}
	}
	return undefined;
}

function currentTaskId(ctx: ExtensionContext): string | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (
			entry.type === "custom" &&
			entry.customType === PI_XK_SESSION_LINK_CUSTOM_TYPE &&
			isPiXkTaskLink(entry.data)
		) {
			return entry.data.taskId;
		}
	}
	return undefined;
}

function lockDiagnostic(entity: string, diagnostic: { ownerState: string; malformed: boolean } | undefined): string[] {
	if (!diagnostic) return [];
	return [`${entity}_write_lock_${diagnostic.malformed ? "malformed" : diagnostic.ownerState}`];
}

async function goalStatus(ctx: ExtensionContext): Promise<{ line: string; diagnostics: string[] }> {
	const goalId = currentGoalId(ctx);
	if (!goalId) return { line: "Goal: none", diagnostics: [] };
	try {
		const store = new GoalStore(ctx.cwd);
		const replay = await store.replayGoal(goalId);
		const files = await store.inspectGoalFiles(goalId);
		let stateMarkdown: string | undefined;
		let nextAction = "unavailable";
		if (files.state.status === "valid") {
			stateMarkdown = await readFile(files.state.path, "utf8");
			nextAction = readGoalStateSection(stateMarkdown, "next_best_action", "not recorded");
		}
		const requiredAcceptance = getGoalRequiredAcceptanceStatus(replay, stateMarkdown);
		const verifiedRequired = requiredAcceptance.filter((item) => item.status === "verified").length;
		const diagnostics = [
			...(replay.tailDiagnostic ? ["goal_event_log_partial_tail"] : []),
			...(files.objective.status === "valid" ? [] : [`goal_objective_${files.objective.status}`]),
			...(files.state.status === "valid" ? [] : [`goal_state_${files.state.status}`]),
			...lockDiagnostic("goal", await store.inspectWriteLock(goalId)),
		];
		return {
			line: `Goal: ${replay.contract.title} · ${replay.lifecycle.status} · acceptance ${verifiedRequired}/${requiredAcceptance.length} · next ${nextAction}`,
			diagnostics,
		};
	} catch (error) {
		return {
			line: `Goal: ${goalId} unavailable`,
			diagnostics: [`goal_status_failed:${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

async function taskStatus(ctx: ExtensionContext): Promise<{ line: string; diagnostics: string[] }> {
	const taskId = currentTaskId(ctx);
	if (!taskId) return { line: "Task: none", diagnostics: [] };
	try {
		const store = new TaskStore(ctx.cwd);
		const replay = await store.replayTask(taskId);
		return {
			line: `Task: ${taskId} · ${replay.status} · ${replay.spec.role}`,
			diagnostics: [
				...(replay.tailDiagnostic ? ["task_event_log_partial_tail"] : []),
				...lockDiagnostic("task", await store.inspectWriteLock(taskId)),
			],
		};
	} catch (error) {
		return {
			line: `Task: ${taskId} unavailable`,
			diagnostics: [`task_status_failed:${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

async function chainStatus(
	ctx: ExtensionContext,
	controller: SessionChainController,
): Promise<{ lines: string[]; diagnostics: string[] }> {
	const binding = controller.getCurrentBinding(ctx.sessionManager);
	if (!binding) return { lines: ["Chain: none", "Rollup: none"], diagnostics: [] };
	try {
		const status = await controller.getCurrentStatus(ctx.sessionManager);
		if (!status) return { lines: ["Chain: none", "Rollup: none"], diagnostics: [] };
		const readModel = await controller.getStore().loadChainReadModel(status.chainId);
		const branch = readModel.branches.find((candidate) => candidate.branchId === status.branchId);
		if (!branch) throw new Error(`branch not found: ${status.branchId}`);
		const nextWindow = (branch.rollups.at(-1)?.windowIndex ?? 0) + 1;
		const publication = await controller.getRollupPublication(status.chainId, status.branchId, nextWindow);
		const doctor = await controller.doctor(status.chainId, "quick");
		return {
			lines: [
				`Chain: ${status.title ?? status.chainId} · ${status.branchId} · S${status.ordinal} ${status.segmentStatus}${status.archived ? " · archived" : ""}`,
				`Rollup: ${branch.rollups.length} published · ${publication ? formatSessionChainRollupPublicationStatus(publication) : "idle"}`,
			],
			diagnostics: doctor.diagnostics.map((diagnostic) => `chain_${diagnostic.code}`),
		};
	} catch (error) {
		return {
			lines: [`Chain: ${binding.chainId} unavailable`, "Rollup: unavailable"],
			diagnostics: [`chain_status_failed:${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

export async function renderPiXkRuntimeStatus(
	ctx: ExtensionContext,
	controller: SessionChainController,
	memory: MemoryService,
	skills?: { project: SkillService; global: SkillService },
): Promise<string> {
	const [
		chain,
		goal,
		task,
		memoryStatus,
		memoryReadModel,
		projectSkills,
		globalSkills,
		projectSkillReadModel,
		globalSkillReadModel,
	] = await Promise.all([
		chainStatus(ctx, controller),
		goalStatus(ctx),
		taskStatus(ctx),
		memory.status().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
		memory
			.getStore()
			.loadReadModelSnapshot()
			.then((snapshot) => snapshot.readModel)
			.catch(() => null),
		skills?.project.status().catch(() => null) ?? null,
		skills?.global.status().catch(() => null) ?? null,
		skills?.project
			.getStore()
			.loadReadModel()
			.catch(() => null) ?? null,
		skills?.global
			.getStore()
			.loadReadModel()
			.catch(() => null) ?? null,
	]);
	const memoryFailed = "error" in memoryStatus;
	const captures = memoryReadModel?.captures ?? [];
	const retryableMemoryFailures = captures.filter(
		(capture) => capture.status === "failed" && capture.retryable === true,
	).length;
	const memoryConflictCooldowns = captures.filter(
		(capture) => capture.errorCode === "memory_capture_revision_conflict_cooldown",
	).length;
	const skillPublicationFailures = [projectSkillReadModel, globalSkillReadModel].flatMap(
		(readModel) => readModel?.publicationFailures ?? [],
	);
	const skillProjectionState = skillPublicationFailures.some(
		(failure) => failure.stage === "projection" || failure.stage === "promotion",
	)
		? "pending repair"
		: "current";
	const skillReloadState = skillPublicationFailures.some((failure) => failure.stage === "reload")
		? "pending repair"
		: "current";
	const diagnostics = [
		...chain.diagnostics,
		...goal.diagnostics,
		...task.diagnostics,
		...(memoryFailed ? [`memory_status_failed:${memoryStatus.error}`] : []),
		...(!memoryFailed && retryableMemoryFailures > 0 ? ["memory_capture_failed_retryable"] : []),
		...(!memoryFailed && memoryConflictCooldowns > 0 ? ["memory_capture_revision_conflict_cooldown"] : []),
		...(skillProjectionState === "current" ? [] : ["skill_projection_pending_repair"]),
		...(skillReloadState === "current" ? [] : ["skill_reload_pending_repair"]),
	];
	const memoryLine = memoryFailed
		? "Memory: unavailable"
		: `Memory: ${memoryStatus.index?.memoryCount ?? 0} · pending ${memoryStatus.captures.scheduled + memoryStatus.captures.generating + memoryStatus.captures.proposed} · failed ${memoryStatus.captures.failed} (retryable ${retryableMemoryFailures}, cooldown ${memoryConflictCooldowns}) · stale ${memoryStatus.index?.stateCounts.freshness.stale ?? 0} · disputed ${memoryStatus.index?.stateCounts.trust.disputed ?? 0} · index ${memoryStatus.indexState}`;
	const latestReconstruction = memoryReadModel?.reconstructions.at(-1);
	const recallLine = `Recall: budget ${DEFAULT_AMBIENT_RECALL_BUDGET.maxTotalKnowledgeActions} total / ${DEFAULT_AMBIENT_RECALL_BUDGET.maxMemoryActions} Memory / ${DEFAULT_AMBIENT_RECALL_BUDGET.maxSkillCandidateActions} Skill · latest ${latestReconstruction ? `${latestReconstruction.runId} ${latestReconstruction.outcome}` : "none"}`;
	const skillLine =
		projectSkills && globalSkills
			? `Skills: active ${projectSkills.facts.active + globalSkills.facts.active} · candidates ${projectSkills.facts.candidates + globalSkills.facts.candidates} · stale ${projectSkills.facts.stale + globalSkills.facts.stale} · cooldown ${projectSkills.facts.needsReview + globalSkills.facts.needsReview} · promotion eligible ${(projectSkillReadModel?.promotionEligibleSkillIds.length ?? 0) + (globalSkillReadModel?.promotionEligibleSkillIds.length ?? 0)} · index ${projectSkills.indexState}/${globalSkills.indexState} · projection ${skillProjectionState} · reload ${skillReloadState}`
			: "Skills: unavailable";
	const recovery =
		diagnostics.length === 0
			? "Recovery: clear"
			: `Recovery: ${diagnostics.length} diagnostic(s) · ${diagnostics.slice(0, 3).join(", ")}${diagnostics.length > 3 ? ", ..." : ""}`;
	return ["Pi-XK status", ...chain.lines, goal.line, task.line, memoryLine, recallLine, skillLine, recovery].join(
		"\n",
	);
}
