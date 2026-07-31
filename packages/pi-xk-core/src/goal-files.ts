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
			"## Title",
			contract.title,
			"",
			"## Goal identity",
			`- Schema: ${contract.schema}`,
			`- Goal ID: ${contract.goalId}`,
			`- Owner session: ${contract.ownerSessionId}`,
			`- Created at: ${contract.createdAt}`,
			`- Revision: ${contract.revision}`,
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
			...contract.acceptance.flatMap((item) => [
				`- ${item.id} (${item.required ? "required" : "optional"}, ${item.kind}): ${item.description}`,
				...(item.command === undefined ? [] : [`  - Command: ${item.command}`]),
			]),
			"",
			"## Capabilities",
			`- filesystem: ${contract.capabilities.filesystem}`,
			`- network: ${contract.capabilities.network}`,
			`- spawn: ${contract.capabilities.spawn}`,
			"",
			"## Budgets",
			`- tokens: ${contract.budgets.tokens}`,
			`- costCents: ${contract.budgets.costCents}`,
			`- wallSeconds: ${contract.budgets.wallSeconds}`,
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
			"## Canonical contract JSON",
			"```json",
			stableJsonStringify(contract),
			"```",
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
			"Keep every required section and JSON field unchanged. Non-placeholder done entries must end with `evidence: <concrete evidence>`; non-placeholder tried_and_rejected entries must end with `reconsider_when: <specific condition>`.",
			"",
			"## contract_revision",
			`- ${contract.revision}`,
			"",
			"## current_snapshot",
			"- Goal created; execution evidence has not been audited yet.",
			"",
			"## done",
			"- None yet.",
			"",
			"## open",
			"- Audit required acceptance and choose the highest-value next action.",
			"",
			"## decisions",
			"- None yet.",
			"",
			"## tried_and_rejected",
			"- None yet.",
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
				(item) => `- ${item.id}: ${item.required ? "required" : "optional"}; unverified; evidence: not recorded.`,
			),
			"",
			"## recent_work_log",
			"- Goal initialized.",
			"",
			"## pause_audit",
			'- {"unmetRequiredAcceptanceIds":[],"currentEvidence":"","incompleteConclusion":"","userRequest":null,"nextBestAction":""}',
			"",
			"## final_evidence",
			'- {"evidence":"","summary":"","verifiedAcceptanceIds":[]}',
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

const V3_STATE_SECTIONS = [
	"contract_revision",
	"current_snapshot",
	"done",
	"open",
	"decisions",
	"tried_and_rejected",
	"assumptions",
	"latest_evidence",
	"blocked_on",
	"next_best_action",
	"acceptance_matrix",
	"recent_work_log",
	"pause_audit",
	"final_evidence",
] as const;

export interface GoalStateAcceptanceEntry {
	id: string;
	required: boolean;
	status: "verified" | "unverified";
	evidence: string;
}

export interface GoalPauseStateEvidence {
	unmetRequiredAcceptanceIds: string[];
	currentEvidence: string;
	incompleteConclusion: string;
	userRequest: string | null;
	nextBestAction: string;
}

export interface GoalStateProjectionV3 {
	contractRevision: number;
	sections: Record<(typeof V3_STATE_SECTIONS)[number], string[]>;
	acceptanceMatrix: GoalStateAcceptanceEntry[];
	recentWorkLog: string[];
	pauseAudit: GoalPauseStateEvidence;
	finalEvidence: GoalCompletionStateEvidence;
}

function parseSingleJsonBullet(lines: string[], section: string): Record<string, unknown> {
	if (lines.length !== 1 || !/^[-*]\s+/.test(lines[0] ?? "")) {
		throw new GoalFileError(`state ${section} must contain exactly one JSON object`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse((lines[0] ?? "").replace(/^[-*]\s+/, "")) as unknown;
	} catch {
		throw new GoalFileError(`state ${section} is not valid JSON`);
	}
	if (!isRecord(parsed)) throw new GoalFileError(`state ${section} must contain a JSON object`);
	return parsed;
}

function validateExactKeys(value: Record<string, unknown>, keys: readonly string[], section: string): void {
	if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
		throw new GoalFileError(`state ${section} has unknown or missing fields`);
	}
}

function isMissingEvidence(value: string): boolean {
	return /^(?:not recorded|none)\.?$/iu.test(value.trim());
}

function validateStructuredLedgerSection(
	lines: string[],
	section: "done" | "tried_and_rejected",
	field: "evidence" | "reconsider_when",
): void {
	const values = lines.map((line) => line.replace(/^[-*]\s+/, ""));
	const placeholders = values.filter((value) => value === "None yet.");
	if (placeholders.length > 0) {
		if (placeholders.length !== 1 || values.length !== 1) {
			throw new GoalFileError(`state ${section} placeholder must be the only entry`);
		}
		return;
	}
	for (const value of values) {
		const match = new RegExp(`\\b${field}\\s*:\\s*(.+)$`, "iu").exec(value);
		if (!match?.[1]?.trim() || isMissingEvidence(match[1])) {
			throw new GoalFileError(`state ${section} entries must include concrete ${field}`);
		}
	}
}

export function parseGoalStateProjection(
	content: string,
	contract: Extract<GoalCurrentContract, { schemaVersion: 3 }>,
): GoalStateProjectionV3 {
	const lines = content.split(/\r?\n/);
	const headingIndexes = new Map<string, number[]>();
	for (const [index, line] of lines.entries()) {
		const match = /^##\s+(.+?)\s*$/.exec(line.trim());
		if (!match?.[1]) continue;
		const name = match[1].toLowerCase();
		headingIndexes.set(name, [...(headingIndexes.get(name) ?? []), index]);
	}
	const allowedSections = new Set<string>(V3_STATE_SECTIONS);
	for (const section of headingIndexes.keys()) {
		if (!allowedSections.has(section)) throw new GoalFileError(`state contains unknown section ${section}`);
	}
	for (const section of V3_STATE_SECTIONS) {
		if ((headingIndexes.get(section)?.length ?? 0) !== 1) {
			throw new GoalFileError(`state ${section} section must appear exactly once`);
		}
	}
	const sections = {} as Record<(typeof V3_STATE_SECTIONS)[number], string[]>;
	for (const section of V3_STATE_SECTIONS) {
		const start = headingIndexes.get(section)?.[0];
		if (start === undefined) throw new GoalFileError(`state ${section} section is missing`);
		const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line.trim()));
		const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
		const values = lines
			.slice(start + 1, end)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (values.length === 0) throw new GoalFileError(`state ${section} section must be non-empty`);
		sections[section] = values;
	}

	const revisionLines = sections.contract_revision;
	const revisionValue =
		revisionLines.length === 1 && /^[-*]\s+\d+$/.test(revisionLines[0] ?? "")
			? revisionLines[0]?.replace(/^[-*]\s+/, "")
			: undefined;
	const revision = revisionValue !== undefined && /^\d+$/.test(revisionValue) ? Number(revisionValue) : undefined;
	if (revision === undefined || revision !== contract.revision) {
		throw new GoalFileError(
			`state contract revision ${revision ?? "missing"} does not match current revision ${contract.revision}`,
		);
	}

	const bulletSections = V3_STATE_SECTIONS.filter(
		(section) => section !== "contract_revision" && section !== "acceptance_matrix",
	);
	for (const section of bulletSections) {
		if (sections[section].some((line) => !/^[-*]\s+/.test(line))) {
			throw new GoalFileError(`state ${section} entries must be Markdown bullets`);
		}
	}
	validateStructuredLedgerSection(sections.done, "done", "evidence");
	validateStructuredLedgerSection(sections.tried_and_rejected, "tried_and_rejected", "reconsider_when");

	const recentWorkLog = sections.recent_work_log.map((line) => line.replace(/^[-*]\s+/, ""));
	if (recentWorkLog.length > 20) {
		throw new GoalFileError(`state recent_work_log has ${recentWorkLog.length} entries; at most 20 are allowed`);
	}

	const acceptanceMatrix: GoalStateAcceptanceEntry[] = [];
	for (const line of sections.acceptance_matrix) {
		const body = /^[-*]\s+(.+)$/u.exec(line)?.[1];
		const matches = body
			? contract.acceptance.flatMap((acceptance) => {
					if (!body.startsWith(acceptance.id)) return [];
					const match = /^:\s+(required|optional);\s+(verified|unverified);\s+evidence:\s*(.+)$/iu.exec(
						body.slice(acceptance.id.length),
					);
					return match?.[1] && match[2] && match[3]?.trim() ? [{ acceptance, match }] : [];
				})
			: [];
		if (matches.length !== 1) {
			throw new GoalFileError("state acceptance_matrix entries have an invalid format");
		}
		const [{ acceptance, match }] = matches;
		if (acceptanceMatrix.some((entry) => entry.id === acceptance.id)) {
			throw new GoalFileError(`state acceptance_matrix repeats acceptance ${acceptance.id}`);
		}
		acceptanceMatrix.push({
			id: acceptance.id,
			required: match[1].toLowerCase() === "required",
			status: match[2].toLowerCase() as "verified" | "unverified",
			evidence: match[3].trim(),
		});
	}
	if (acceptanceMatrix.length !== contract.acceptance.length) {
		throw new GoalFileError("state acceptance_matrix does not contain exactly the contract acceptance entries");
	}
	for (const acceptance of contract.acceptance) {
		const entry = acceptanceMatrix.find((candidate) => candidate.id === acceptance.id);
		if (!entry) throw new GoalFileError(`state acceptance_matrix is missing acceptance ${acceptance.id}`);
		if (entry.required !== acceptance.required) {
			throw new GoalFileError(
				`state acceptance_matrix ${acceptance.id} required classification does not match the contract`,
			);
		}
		if (entry.status === "verified" && isMissingEvidence(entry.evidence)) {
			throw new GoalFileError(`state verified acceptance ${acceptance.id} requires concrete evidence`);
		}
	}

	const pauseAuditValue = parseSingleJsonBullet(sections.pause_audit, "pause_audit");
	validateExactKeys(
		pauseAuditValue,
		["unmetRequiredAcceptanceIds", "currentEvidence", "incompleteConclusion", "userRequest", "nextBestAction"],
		"pause_audit",
	);
	if (
		!Array.isArray(pauseAuditValue.unmetRequiredAcceptanceIds) ||
		pauseAuditValue.unmetRequiredAcceptanceIds.some((id) => typeof id !== "string") ||
		typeof pauseAuditValue.currentEvidence !== "string" ||
		typeof pauseAuditValue.incompleteConclusion !== "string" ||
		(pauseAuditValue.userRequest !== null && typeof pauseAuditValue.userRequest !== "string") ||
		typeof pauseAuditValue.nextBestAction !== "string"
	) {
		throw new GoalFileError("state pause_audit has invalid field types");
	}
	const requiredAcceptanceIds = new Set(contract.acceptance.filter((item) => item.required).map((item) => item.id));
	const unmetRequiredAcceptanceIds = pauseAuditValue.unmetRequiredAcceptanceIds as string[];
	if (
		new Set(unmetRequiredAcceptanceIds).size !== unmetRequiredAcceptanceIds.length ||
		unmetRequiredAcceptanceIds.some((id) => !requiredAcceptanceIds.has(id))
	) {
		throw new GoalFileError("state pause_audit contains duplicate or ineligible acceptance IDs");
	}
	for (const acceptanceId of unmetRequiredAcceptanceIds) {
		if (acceptanceMatrix.find((entry) => entry.id === acceptanceId)?.status === "verified") {
			throw new GoalFileError(`state pause_audit marks verified acceptance ${acceptanceId} as unmet`);
		}
	}

	const finalEvidenceValue = parseSingleJsonBullet(sections.final_evidence, "final_evidence");
	validateExactKeys(finalEvidenceValue, ["evidence", "summary", "verifiedAcceptanceIds"], "final_evidence");
	if (
		!Array.isArray(finalEvidenceValue.verifiedAcceptanceIds) ||
		finalEvidenceValue.verifiedAcceptanceIds.some((id) => typeof id !== "string") ||
		typeof finalEvidenceValue.evidence !== "string" ||
		typeof finalEvidenceValue.summary !== "string"
	) {
		throw new GoalFileError("state final_evidence has invalid field types");
	}
	const verifiedAcceptanceIds = finalEvidenceValue.verifiedAcceptanceIds as string[];
	const acceptanceIds = new Set(contract.acceptance.map((item) => item.id));
	if (new Set(verifiedAcceptanceIds).size !== verifiedAcceptanceIds.length) {
		throw new GoalFileError("state final_evidence contains duplicate acceptance IDs");
	}
	for (const acceptanceId of verifiedAcceptanceIds) {
		if (!acceptanceIds.has(acceptanceId)) {
			throw new GoalFileError(`state final_evidence contains unknown acceptance ${acceptanceId}`);
		}
		if (acceptanceMatrix.find((entry) => entry.id === acceptanceId)?.status !== "verified") {
			throw new GoalFileError(
				`state final_evidence acceptance ${acceptanceId} is not verified in acceptance_matrix`,
			);
		}
	}
	if (
		verifiedAcceptanceIds.length > 0 &&
		(!finalEvidenceValue.evidence.trim() || !finalEvidenceValue.summary.trim())
	) {
		throw new GoalFileError("state final_evidence requires evidence and summary when acceptance IDs are recorded");
	}

	return {
		contractRevision: revision,
		sections,
		acceptanceMatrix,
		recentWorkLog,
		pauseAudit: {
			unmetRequiredAcceptanceIds,
			currentEvidence: pauseAuditValue.currentEvidence,
			incompleteConclusion: pauseAuditValue.incompleteConclusion,
			userRequest: pauseAuditValue.userRequest,
			nextBestAction: pauseAuditValue.nextBestAction,
		},
		finalEvidence: {
			verifiedAcceptanceIds,
			finalEvidence: finalEvidenceValue.evidence,
			finalSummary: finalEvidenceValue.summary,
		},
	};
}

function inspectV3State(
	content: string,
	contract: Extract<GoalCurrentContract, { schemaVersion: 3 }>,
): string | undefined {
	try {
		parseGoalStateProjection(content, contract);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export interface GoalCompletionStateEvidence {
	verifiedAcceptanceIds: string[];
	finalEvidence: string;
	finalSummary: string;
}

export function validateGoalPauseState(
	content: string,
	contract: Extract<GoalCurrentContract, { schemaVersion: 3 }>,
	evidence: GoalPauseStateEvidence,
): string | undefined {
	let state: GoalStateProjectionV3;
	try {
		state = parseGoalStateProjection(content, contract);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const unverifiedRequiredAcceptanceIds = contract.acceptance
		.filter(
			(acceptance) =>
				acceptance.required &&
				state.acceptanceMatrix.find((entry) => entry.id === acceptance.id)?.status === "unverified",
		)
		.map((acceptance) => acceptance.id);
	if (
		state.pauseAudit.unmetRequiredAcceptanceIds.length !== unverifiedRequiredAcceptanceIds.length ||
		state.pauseAudit.unmetRequiredAcceptanceIds.some((id, index) => id !== unverifiedRequiredAcceptanceIds[index])
	) {
		return "state pause_audit must list every unverified required acceptance in contract order";
	}
	if (
		state.pauseAudit.unmetRequiredAcceptanceIds.length !== evidence.unmetRequiredAcceptanceIds.length ||
		state.pauseAudit.unmetRequiredAcceptanceIds.some(
			(id, index) => id !== evidence.unmetRequiredAcceptanceIds[index],
		) ||
		state.pauseAudit.currentEvidence !== evidence.currentEvidence ||
		state.pauseAudit.incompleteConclusion !== evidence.incompleteConclusion ||
		state.pauseAudit.userRequest !== evidence.userRequest ||
		state.pauseAudit.nextBestAction !== evidence.nextBestAction
	) {
		return "state pause_audit does not match the requested Goal pause";
	}
	return undefined;
}

export function validateGoalCompletionState(
	content: string,
	contract: Extract<GoalCurrentContract, { schemaVersion: 3 }>,
	evidence: GoalCompletionStateEvidence,
): string | undefined {
	let state: GoalStateProjectionV3;
	try {
		state = parseGoalStateProjection(content, contract);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	for (const acceptance of contract.acceptance.filter((item) => item.required)) {
		const entry = state.acceptanceMatrix.find((candidate) => candidate.id === acceptance.id);
		if (entry?.status !== "verified" || !entry.evidence || isMissingEvidence(entry.evidence)) {
			return `state acceptance_matrix does not record verified evidence for ${acceptance.id}`;
		}
	}
	if (
		state.pauseAudit.unmetRequiredAcceptanceIds.length > 0 ||
		state.pauseAudit.currentEvidence.trim() ||
		state.pauseAudit.incompleteConclusion.trim() ||
		state.pauseAudit.userRequest !== null ||
		state.pauseAudit.nextBestAction.trim()
	) {
		return "state pause_audit must be cleared before ending the Goal";
	}
	if (
		state.finalEvidence.verifiedAcceptanceIds.length !== evidence.verifiedAcceptanceIds.length ||
		state.finalEvidence.verifiedAcceptanceIds.some((id, index) => id !== evidence.verifiedAcceptanceIds[index]) ||
		state.finalEvidence.finalEvidence !== evidence.finalEvidence ||
		state.finalEvidence.finalSummary !== evidence.finalSummary
	) {
		return "state final_evidence does not match the requested Goal ending";
	}
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
