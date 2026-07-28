import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GOAL_FILE_SCHEMA, type GoalCurrentContract } from "./contract.ts";
import { stableJsonStringify } from "./stable-json.ts";
import { syncDirectory } from "./sync-directory.ts";

const GOAL_FILE_HEADER_PREFIX = "<!-- pi-xk-goal-file: ";
const GOAL_FILE_HEADER_SUFFIX = " -->";

export type GoalFileKind = "objective" | "state";

export type GoalFileStatus = "valid" | "missing" | "mismatched" | "corrupt";

export interface GoalFileDiagnostic {
	path: string;
	status: GoalFileStatus;
	detail?: string;
}

export interface GoalFilesDiagnostic {
	goalId: string;
	fingerprint: string;
	objective: GoalFileDiagnostic;
	state: GoalFileDiagnostic;
}

export class GoalFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalFileError";
	}
}

export class GoalFileAlreadyExistsError extends GoalFileError {
	constructor(path: string) {
		super(`Goal file already exists and will not be overwritten: ${path}`);
		this.name = "GoalFileAlreadyExistsError";
	}
}

interface GoalFileHeader {
	schema: typeof GOAL_FILE_SCHEMA;
	kind: GoalFileKind;
	goalId: string;
	fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function goalFilePaths(goalDirectory: string): Record<GoalFileKind, string> {
	return {
		objective: join(goalDirectory, "goal-objective.md"),
		state: join(goalDirectory, "goal-state.md"),
	};
}

export function goalIdentityFingerprint(contract: GoalCurrentContract): string {
	const identity = stableJsonStringify({
		schema: GOAL_FILE_SCHEMA,
		goalId: contract.goalId,
		ownerSessionId: contract.ownerSessionId,
		createdAt: contract.createdAt,
	});
	return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function headerFor(contract: GoalCurrentContract, kind: GoalFileKind): GoalFileHeader {
	return {
		schema: GOAL_FILE_SCHEMA,
		kind,
		goalId: contract.goalId,
		fingerprint: goalIdentityFingerprint(contract),
	};
}

function renderHeader(header: GoalFileHeader): string {
	return `${GOAL_FILE_HEADER_PREFIX}${stableJsonStringify(header)}${GOAL_FILE_HEADER_SUFFIX}`;
}

function renderObjective(contract: GoalCurrentContract): string {
	if (contract.schema === "pi-xk.goal.contract.v3") {
		return [
			renderHeader(headerFor(contract, "objective")),
			"# Goal Objective",
			"",
			"goal-objective.md is a read-only projection. Never edit it directly; propose revisions through Pi-XK.",
			"Read goal-state.md before substantive work, verify its contract_revision, and synchronize stale state before continuing.",
			"Pi-XK continues this Goal while it remains active. A normal assistant response does not end this Goal.",
			"Call pi_xk_end_goal only after every required acceptance has verified evidence and goal-state.md records the final summary.",
			"",
			"## Contract revision",
			String(contract.revision),
			"",
			"## Intent Anchor",
			contract.intentAnchor,
			"",
			"## Current Objective",
			contract.objective,
			"",
			"## Execution principles",
			"- Only verified results and evidence count as progress; activity and long narration do not.",
			"- After the same method fails twice without new evidence, do not repeat it unchanged. Record the failures, revise the assumption, and choose a higher-value path.",
			"- Old plans and paths are candidates, not the Goal itself. Refine the Current Objective when repository facts or learned evidence make its wording stale, without changing the Intent Anchor.",
			"- Never trade safety, user authorization, data integrity, required verification, or truthful reporting for speed. Never hide failures or incomplete evidence.",
			"",
			"## Constraints",
			...(contract.constraints.length > 0
				? contract.constraints.map((constraint) => `- ${constraint}`)
				: ["- None declared."]),
			"",
			"## Non-goals",
			...(contract.nonGoals.length > 0 ? contract.nonGoals.map((nonGoal) => `- ${nonGoal}`) : ["- None declared."]),
			"",
			"## Acceptance",
			...contract.acceptance.map(
				(item) => `- ${item.id} (${item.required ? "required" : "optional"}): ${item.description}`,
			),
			"",
			"## Done condition",
			contract.doneCondition,
			"",
			"## Pause condition",
			contract.pauseCondition,
			"",
			"## Final report",
			contract.finalReport,
			"",
			"## Execution authorization",
			contract.executionAuthorization,
			"",
		].join("\n");
	}
	return [
		renderHeader(headerFor(contract, "objective")),
		"# Goal Objective",
		"",
		"goal-objective.md is read-only. Do not modify this contract during execution.",
		"Before doing work, read goal-state.md before every new agent run and preserve its identity header.",
		"Pi-XK continues this Goal while it remains active. A normal assistant response does not end this Goal.",
		"Call pi_xk_end_goal only after every required acceptance has verified evidence and goal-state.md records the final summary.",
		"Before pausing, record the unmet required acceptance IDs, current evidence, incomplete conclusion, user request, and next best action in goal-state.md.",
		"If user input or an external change is required, update goal-state.md and call pi_xk_pause_goal; otherwise continue with the next best action.",
		"",
		"## Objective",
		contract.objective,
		"",
		"## Constraints",
		...(contract.constraints.length > 0
			? contract.constraints.map((constraint) => `- ${constraint}`)
			: ["- None declared."]),
		"",
		"## Non-goals",
		...(contract.nonGoals.length > 0 ? contract.nonGoals.map((nonGoal) => `- ${nonGoal}`) : ["- None declared."]),
		"",
		"## Acceptance",
		...(contract.acceptance.length > 0
			? contract.acceptance.map(
					(item) => `- ${item.id} (${item.required ? "required" : "optional"}): ${item.description}`,
				)
			: ["- None declared."]),
		"",
		"## Done condition",
		contract.doneCondition,
		"",
		"## Pause condition",
		contract.pauseCondition,
		"",
		"## Final report",
		contract.finalReport,
		"",
		"## Execution authorization",
		contract.executionAuthorization,
		"",
	].join("\n");
}

function renderState(contract: GoalCurrentContract): string {
	if (contract.schema === "pi-xk.goal.contract.v3") {
		return [
			renderHeader(headerFor(contract, "state")),
			"# Goal State",
			"",
			"Maintain this execution ledger with native file tools. Preserve the identity header, keep contract_revision current, and retain at most 20 important recent_work_log entries.",
			"",
			"## contract_revision",
			`- ${contract.revision}`,
			"",
			"## current_snapshot",
			"- Goal created; execution evidence has not been audited yet.",
			"",
			"## done",
			"- None yet. Record evidence with every completed item.",
			"",
			"## open",
			"- Audit required acceptance and choose the highest-value next action.",
			"",
			"## decisions",
			"- None yet.",
			"",
			"## tried_and_rejected",
			"- None yet. Every rejected path must include reconsider_when.",
			"",
			"## assumptions",
			"- None recorded.",
			"",
			"## latest_evidence",
			"- Goal created for the confirmed contract.",
			"",
			"## blocked_on",
			"- None.",
			"",
			"## next_best_action",
			"- Inspect current facts and update this state before proceeding.",
			"",
			"## acceptance_matrix",
			...contract.acceptance.map(
				(item) => `- ${item.id}: ${item.required ? "required" : "optional"}; unverified; evidence not recorded.`,
			),
			"",
			"## recent_work_log",
			"- Goal initialized.",
			"",
			"## pause_audit",
			"- Record unmet required acceptance IDs, current evidence, incomplete conclusion, user request, and next best action before pausing.",
			"",
			"## final_evidence",
			"- Record verified acceptance IDs, final evidence, and final summary before ending.",
			"",
		].join("\n");
	}
	return [
		renderHeader(headerFor(contract, "state")),
		"# Goal State",
		"",
		"Maintain this file with native file tools. Preserve the identity header and update the sections below with current evidence.",
		"",
		"## done",
		"- None yet.",
		"",
		"## open",
		"- None yet.",
		"",
		"## tried_and_rejected",
		"- None yet.",
		"",
		"## latest_evidence",
		"- Goal created for the declared objective.",
		"",
		"## next_best_action",
		"- Inspect the repository and update this state before proceeding.",
		"",
		"## blocked_on",
		"- None.",
		"",
		"## acceptance_gaps",
		"- Required acceptance evidence has not been audited yet.",
		"",
		"## pause_audit",
		"- Record unmet required acceptance IDs, current evidence, incomplete conclusion, user request, and next best action before pausing.",
		"",
		"## final_evidence",
		"- Record verified acceptance IDs, final evidence, and final summary before ending.",
		"",
	].join("\n");
}

async function writeExclusive(path: string, content: string): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(path, "wx", 0o600);
	} catch (error) {
		if (isErrno(error, "EEXIST")) throw new GoalFileAlreadyExistsError(path);
		throw error;
	}
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAtomic(path: string, content: string): Promise<void> {
	const directory = dirname(path);
	const temporaryPath = join(directory, `.goal-objective-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporaryPath, "wx", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporaryPath, path);
		await syncDirectory(directory);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export async function createGoalFiles(goalDirectory: string, contract: GoalCurrentContract): Promise<void> {
	const paths = goalFilePaths(goalDirectory);
	let objectiveCreated = false;
	let stateCreated = false;
	try {
		await writeExclusive(paths.objective, renderObjective(contract));
		objectiveCreated = true;
		await writeExclusive(paths.state, renderState(contract));
		stateCreated = true;
	} catch (error) {
		if (stateCreated) await unlink(paths.state).catch(() => {});
		if (objectiveCreated) await unlink(paths.objective).catch(() => {});
		throw error;
	}
}

export async function writeGoalObjectiveProjection(
	goalDirectory: string,
	contract: GoalCurrentContract,
): Promise<void> {
	await writeAtomic(goalFilePaths(goalDirectory).objective, renderObjective(contract));
}

function parseHeader(content: string): GoalFileHeader | undefined {
	const firstLine = content.split("\n", 1)[0];
	if (!firstLine?.startsWith(GOAL_FILE_HEADER_PREFIX) || !firstLine.endsWith(GOAL_FILE_HEADER_SUFFIX)) {
		return undefined;
	}
	const serialized = firstLine.slice(GOAL_FILE_HEADER_PREFIX.length, -GOAL_FILE_HEADER_SUFFIX.length);
	try {
		const value = JSON.parse(serialized) as unknown;
		if (!isRecord(value)) return undefined;
		const keys = Object.keys(value).sort();
		if (keys.join(",") !== "fingerprint,goalId,kind,schema") return undefined;
		if (
			value.schema !== GOAL_FILE_SCHEMA ||
			(value.kind !== "objective" && value.kind !== "state") ||
			typeof value.goalId !== "string" ||
			typeof value.fingerprint !== "string"
		) {
			return undefined;
		}
		return { schema: GOAL_FILE_SCHEMA, kind: value.kind, goalId: value.goalId, fingerprint: value.fingerprint };
	} catch {
		return undefined;
	}
}

function sectionLines(content: string, section: string): string[] | undefined {
	const lines = content.split(/\r?\n/);
	const heading = `## ${section}`.toLowerCase();
	const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
	if (start < 0) return undefined;
	const result: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s+/.test(line.trim())) break;
		if (line.trim().length > 0) result.push(line.trim());
	}
	return result;
}

function inspectV3State(
	content: string,
	contract: Extract<GoalCurrentContract, { schemaVersion: 3 }>,
): string | undefined {
	const revisionLines = sectionLines(content, "contract_revision");
	const revisionValue = revisionLines?.length === 1 ? revisionLines[0]?.replace(/^[-*]\s+/, "") : undefined;
	const revision = revisionValue !== undefined && /^\d+$/.test(revisionValue) ? Number(revisionValue) : undefined;
	if (revision === undefined || revision !== contract.revision) {
		return `state contract revision ${revision ?? "missing"} does not match current revision ${contract.revision}`;
	}
	const workLog = sectionLines(content, "recent_work_log");
	if (workLog === undefined) return "state recent_work_log section is missing";
	const entryCount = workLog.filter((line) => /^[-*]\s+/.test(line)).length;
	if (entryCount > 20) return `state recent_work_log has ${entryCount} entries; at most 20 are allowed`;
	return undefined;
}

async function inspectGoalFile(
	path: string,
	contract: GoalCurrentContract,
	kind: GoalFileKind,
): Promise<GoalFileDiagnostic> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { path, status: "missing" };
		throw error;
	}
	const header = parseHeader(content);
	if (!header || content.split("\n").slice(1).join("\n").trim().length === 0) {
		return { path, status: "corrupt", detail: "missing or invalid identity header" };
	}
	const expected = headerFor(contract, kind);
	if (
		header.schema !== expected.schema ||
		header.kind !== expected.kind ||
		header.goalId !== expected.goalId ||
		header.fingerprint !== expected.fingerprint
	) {
		return { path, status: "mismatched", detail: "identity header does not match the Goal contract" };
	}
	if (kind === "objective" && content !== renderObjective(contract)) {
		return { path, status: "mismatched", detail: "objective content does not match the Goal contract" };
	}
	if (kind === "state" && contract.schema === "pi-xk.goal.contract.v3") {
		const detail = inspectV3State(content, contract);
		if (detail) return { path, status: "mismatched", detail };
	}
	return { path, status: "valid" };
}

export async function inspectGoalFiles(
	goalDirectory: string,
	contract: GoalCurrentContract,
): Promise<GoalFilesDiagnostic> {
	const paths = goalFilePaths(goalDirectory);
	return {
		goalId: contract.goalId,
		fingerprint: goalIdentityFingerprint(contract),
		objective: await inspectGoalFile(paths.objective, contract, "objective"),
		state: await inspectGoalFile(paths.state, contract, "state"),
	};
}
