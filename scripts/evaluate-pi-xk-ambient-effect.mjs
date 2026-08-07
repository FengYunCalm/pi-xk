import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_AMBIENT_RECALL_BUDGET } from "../packages/pi-xk-core/src/index.ts";

const REPORT_SCHEMA = "pi-xk.ambient-effect-report.v1";
const ARMS = ["baseline", "placebo", "treatment"];
const CATEGORIES = ["history_positive", "stale_or_conflict", "unrelated_one_shot"];
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/u;
const SENSITIVE_VALUE_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|authorization)\s*[:=]\s*\S+|bearer\s+\S+)/iu;

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys, field) {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${field} has unknown or missing fields`);
	}
}

function identifier(value, field) {
	if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
		throw new Error(`${field} must be a safe identifier`);
	}
	return value;
}

function safeLabel(value, field) {
	if (typeof value !== "string" || !SAFE_LABEL_PATTERN.test(value)) {
		throw new Error(`${field} must be a safe label`);
	}
	return value;
}

function digest(value, field) {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${field} must be a sha256 digest`);
	}
	return value;
}

function nonNegativeInteger(value, field) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

function positiveInteger(value, field) {
	const parsed = nonNegativeInteger(value, field);
	if (parsed === 0) throw new Error(`${field} must be positive`);
	return parsed;
}

function nonNegativeNumber(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative number`);
	}
	return value;
}

function boolean(value, field) {
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
	return value;
}

function assertRedacted(value, seen = new WeakSet()) {
	if (typeof value === "string") {
		if (SENSITIVE_VALUE_PATTERN.test(value)) {
			throw new Error("Ambient effect report must be redacted before evaluation");
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) assertRedacted(entry, seen);
		return;
	}
	for (const entry of Object.values(value)) assertRedacted(entry, seen);
}

function validateControls(value) {
	exactKeys(value, ["model", "thinking", "maxTokens", "timeoutMs", "toolSetDigest"], "run controls");
	return {
		model: safeLabel(value.model, "run controls model"),
		thinking: safeLabel(value.thinking, "run controls thinking"),
		maxTokens: positiveInteger(value.maxTokens, "run controls maxTokens"),
		timeoutMs: positiveInteger(value.timeoutMs, "run controls timeoutMs"),
		toolSetDigest: digest(value.toolSetDigest, "run controls toolSetDigest"),
	};
}

function validateIsolation(value) {
	exactKeys(
		value,
		[
			"researchSessionDigest",
			"implementationSessionDigest",
			"implementationHasGitHistory",
			"implementationHasPriorTranscript",
			"implementationHasVerifierAccess",
			"implementationHasExpectedPatchAccess",
			"implementationHasHostTempAccess",
		],
		"run isolation",
	);
	const researchSessionDigest = digest(value.researchSessionDigest, "run isolation researchSessionDigest");
	const implementationSessionDigest = digest(
		value.implementationSessionDigest,
		"run isolation implementationSessionDigest",
	);
	if (researchSessionDigest === implementationSessionDigest) {
		throw new Error("research and implementation sessions must be isolated");
	}
	const prohibited = [
		"implementationHasGitHistory",
		"implementationHasPriorTranscript",
		"implementationHasVerifierAccess",
		"implementationHasExpectedPatchAccess",
		"implementationHasHostTempAccess",
	];
	for (const field of prohibited) {
		if (boolean(value[field], `run isolation ${field}`)) {
			throw new Error(`run isolation ${field} must be false`);
		}
	}
	return { researchSessionDigest, implementationSessionDigest };
}

function validateBudget(value) {
	exactKeys(
		value,
		[
			"totalKnowledgeActions",
			"memoryActions",
			"memorySearchCalls",
			"uniqueMemoryReads",
			"evidenceReads",
			"skillCandidateActions",
		],
		"run budget",
	);
	const budget = {
		totalKnowledgeActions: nonNegativeInteger(value.totalKnowledgeActions, "run budget totalKnowledgeActions"),
		memoryActions: nonNegativeInteger(value.memoryActions, "run budget memoryActions"),
		memorySearchCalls: nonNegativeInteger(value.memorySearchCalls, "run budget memorySearchCalls"),
		uniqueMemoryReads: nonNegativeInteger(value.uniqueMemoryReads, "run budget uniqueMemoryReads"),
		evidenceReads: nonNegativeInteger(value.evidenceReads, "run budget evidenceReads"),
		skillCandidateActions: nonNegativeInteger(value.skillCandidateActions, "run budget skillCandidateActions"),
	};
	for (const [field, limit] of Object.entries(DEFAULT_AMBIENT_RECALL_BUDGET)) {
		if (budget[field] > limit) throw new Error(`run budget exceeds ${field}`);
	}
	if (
		budget.totalKnowledgeActions < budget.memoryActions ||
		budget.totalKnowledgeActions < budget.skillCandidateActions
	) {
		throw new Error("run budget totalKnowledgeActions is inconsistent");
	}
	return budget;
}

function validateStateCounts(value, field) {
	exactKeys(value, ["trust", "freshness"], field);
	exactKeys(value.trust, ["verified", "model_inferred", "disputed"], `${field} trust`);
	exactKeys(value.freshness, ["current", "stale", "unknown"], `${field} freshness`);
	const trust = {
		verified: nonNegativeInteger(value.trust.verified, `${field} trust verified`),
		model_inferred: nonNegativeInteger(value.trust.model_inferred, `${field} trust model_inferred`),
		disputed: nonNegativeInteger(value.trust.disputed, `${field} trust disputed`),
	};
	const freshness = {
		current: nonNegativeInteger(value.freshness.current, `${field} freshness current`),
		stale: nonNegativeInteger(value.freshness.stale, `${field} freshness stale`),
		unknown: nonNegativeInteger(value.freshness.unknown, `${field} freshness unknown`),
	};
	return { trust, freshness };
}

function sumCounts(value) {
	return Object.values(value).reduce((total, count) => total + count, 0);
}

function validateTelemetry(value) {
	exactKeys(
		value,
		[
			"d1SearchCalls",
			"d2Reads",
			"relevantD2Reads",
			"d3EvidenceReads",
			"budget",
			"totalTokens",
			"elapsedMs",
			"memoryStateUse",
		],
		"run telemetry",
	);
	const d1SearchCalls = nonNegativeInteger(value.d1SearchCalls, "run telemetry d1SearchCalls");
	const d2Reads = nonNegativeInteger(value.d2Reads, "run telemetry d2Reads");
	const relevantD2Reads = nonNegativeInteger(value.relevantD2Reads, "run telemetry relevantD2Reads");
	const d3EvidenceReads = nonNegativeInteger(value.d3EvidenceReads, "run telemetry d3EvidenceReads");
	const budget = validateBudget(value.budget);
	const memoryStateUse = validateStateCounts(value.memoryStateUse, "run telemetry memoryStateUse");
	if (budget.memorySearchCalls !== d1SearchCalls) {
		throw new Error("run telemetry D1 search count does not match the recall ledger");
	}
	if (budget.uniqueMemoryReads < d2Reads || budget.evidenceReads < d3EvidenceReads) {
		throw new Error("run telemetry D2/D3 count exceeds the recall ledger");
	}
	if (relevantD2Reads > d2Reads) throw new Error("run telemetry relevant D2 count exceeds D2 reads");
	if (sumCounts(memoryStateUse.trust) !== d2Reads || sumCounts(memoryStateUse.freshness) !== d2Reads) {
		throw new Error("run telemetry Memory state counts do not match D2 reads");
	}
	return {
		d1SearchCalls,
		d2Reads,
		relevantD2Reads,
		d3EvidenceReads,
		budget,
		totalTokens: positiveInteger(value.totalTokens, "run telemetry totalTokens"),
		elapsedMs: positiveInteger(value.elapsedMs, "run telemetry elapsedMs"),
		memoryStateUse,
	};
}

function validateVerifier(value, reportKind) {
	exactKeys(value, ["executor", "resultDigest", "passed", "blindFollowedStaleOrDisputed"], "run verifier");
	const executor = safeLabel(value.executor, "run verifier executor");
	if (reportKind === "provider_run" && executor !== "external") {
		throw new Error("provider-run verifier must be external");
	}
	if (reportKind === "deterministic_fixture" && executor !== "deterministic_fixture") {
		throw new Error("deterministic fixture verifier must identify its synthetic source");
	}
	return {
		executor,
		resultDigest: digest(value.resultDigest, "run verifier resultDigest"),
		passed: boolean(value.passed, "run verifier passed"),
		blindFollowedStaleOrDisputed: boolean(
			value.blindFollowedStaleOrDisputed,
			"run verifier blindFollowedStaleOrDisputed",
		),
	};
}

function validateRun(value, reportKind) {
	exactKeys(
		value,
		[
			"arm",
			"runId",
			"memoryCondition",
			"metadataShapeDigest",
			"routingShapeDigest",
			"isolation",
			"telemetry",
			"verifier",
		],
		"run report",
	);
	if (!ARMS.includes(value.arm)) throw new Error("run report arm is invalid");
	const expectedCondition =
		value.arm === "baseline" ? "none" : value.arm === "placebo" ? "unrelated_metadata" : "relevant_memory";
	if (value.memoryCondition !== expectedCondition) throw new Error("run report memory condition is inconsistent with arm");
	const shapeFields = ["metadataShapeDigest", "routingShapeDigest"];
	for (const field of shapeFields) {
		if (value.arm === "baseline") {
			if (value[field] !== null) throw new Error(`baseline ${field} must be null`);
		} else {
			digest(value[field], `run report ${field}`);
		}
	}
	return {
		arm: value.arm,
		runId: identifier(value.runId, "run report runId"),
		metadataShapeDigest: value.metadataShapeDigest,
		routingShapeDigest: value.routingShapeDigest,
		isolation: validateIsolation(value.isolation),
		telemetry: validateTelemetry(value.telemetry),
		verifier: validateVerifier(value.verifier, reportKind),
	};
}

function validateGroup(value, reportKind, runIds) {
	exactKeys(value, ["occurrences", "controls", "runs"], "task run group");
	const occurrences = positiveInteger(value.occurrences, "task run group occurrences");
	if (reportKind === "provider_run" && occurrences !== 1) {
		throw new Error("provider-run groups must contain one physical occurrence");
	}
	if (reportKind === "deterministic_fixture" && occurrences > 2) {
		throw new Error("deterministic fixture occurrences must remain bounded");
	}
	if (!Array.isArray(value.runs) || value.runs.length !== ARMS.length) {
		throw new Error("task run group must contain one report per arm");
	}
	const runs = value.runs.map((run) => validateRun(run, reportKind));
	const byArm = new Map(runs.map((run) => [run.arm, run]));
	if (byArm.size !== ARMS.length || ARMS.some((arm) => !byArm.has(arm))) {
		throw new Error("task run group arms must be unique and complete");
	}
	for (const run of runs) {
		if (runIds.has(run.runId)) throw new Error("run report IDs must be unique");
		runIds.add(run.runId);
	}
	const placebo = byArm.get("placebo");
	const treatment = byArm.get("treatment");
	if (!placebo || !treatment) throw new Error("task run group lacks placebo or treatment");
	if (
		placebo.metadataShapeDigest !== treatment.metadataShapeDigest ||
		placebo.routingShapeDigest !== treatment.routingShapeDigest
	) {
		throw new Error("placebo and treatment must match Memory metadata scale and routing shape");
	}
	const implementationSessions = new Set(runs.map((run) => run.isolation.implementationSessionDigest));
	if (implementationSessions.size !== ARMS.length) {
		throw new Error("tri-arm implementation sessions must be isolated from one another");
	}
	return { occurrences, controls: validateControls(value.controls), byArm };
}

function validateMetadata(value) {
	exactKeys(value, ["commit", "node", "platform", "commandId", "commandDigest", "costForecastUsd"], "report metadata");
	if (typeof value.commit !== "string" || !COMMIT_PATTERN.test(value.commit)) {
		throw new Error("report metadata commit is invalid");
	}
	return {
		commit: value.commit,
		node: safeLabel(value.node, "report metadata node"),
		platform: safeLabel(value.platform, "report metadata platform"),
		commandId: identifier(value.commandId, "report metadata commandId"),
		commandDigest: digest(value.commandDigest, "report metadata commandDigest"),
		costForecastUsd: nonNegativeNumber(value.costForecastUsd, "report metadata costForecastUsd"),
	};
}

function validateReport(value) {
	assertRedacted(value);
	exactKeys(value, ["schema", "reportKind", "metadata", "tasks"], "Ambient effect report");
	if (value.schema !== REPORT_SCHEMA) throw new Error("Ambient effect report schema is unsupported");
	if (value.reportKind !== "deterministic_fixture" && value.reportKind !== "provider_run") {
		throw new Error("Ambient effect report kind is unsupported");
	}
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
		throw new Error("Ambient effect report must contain sealed tasks");
	}
	const taskIds = new Set();
	const runIds = new Set();
	const tasks = value.tasks.map((task) => {
		exactKeys(task, ["id", "category", "sealed", "taskDigest", "groups"], "sealed task");
		const id = identifier(task.id, "sealed task id");
		if (taskIds.has(id)) throw new Error("sealed task IDs must be unique");
		taskIds.add(id);
		if (!CATEGORIES.includes(task.category)) throw new Error("sealed task category is invalid");
		if (task.sealed !== true) throw new Error("all evaluation tasks must remain sealed");
		if (!Array.isArray(task.groups) || task.groups.length === 0) {
			throw new Error("sealed task must contain run groups");
		}
		return {
			id,
			category: task.category,
			taskDigest: digest(task.taskDigest, "sealed task taskDigest"),
			groups: task.groups.map((group) => validateGroup(group, value.reportKind, runIds)),
		};
	});
	return { reportKind: value.reportKind, metadata: validateMetadata(value.metadata), tasks };
}

function median(values) {
	if (values.length === 0) return null;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function weightedRuns(tasks, categoryFilter) {
	const runs = [];
	for (const task of tasks) {
		if (!categoryFilter(task.category)) continue;
		for (const group of task.groups) {
			for (let occurrence = 0; occurrence < group.occurrences; occurrence += 1) {
				runs.push({ task, group, occurrence });
			}
		}
	}
	return runs;
}

function summarizeArmRuns(weighted, arm) {
	const runs = weighted.map(({ group }) => group.byArm.get(arm));
	const sum = (select) => runs.reduce((total, run) => total + select(run), 0);
	const sumState = (dimension, state) =>
		sum((run) => run.telemetry.memoryStateUse[dimension][state]);
	return {
		runs: runs.length,
		d1SearchCalls: sum((run) => run.telemetry.d1SearchCalls),
		d2Reads: sum((run) => run.telemetry.d2Reads),
		relevantD2Reads: sum((run) => run.telemetry.relevantD2Reads),
		d3EvidenceReads: sum((run) => run.telemetry.d3EvidenceReads),
		budget: {
			totalKnowledgeActions: sum((run) => run.telemetry.budget.totalKnowledgeActions),
			memoryActions: sum((run) => run.telemetry.budget.memoryActions),
			memorySearchCalls: sum((run) => run.telemetry.budget.memorySearchCalls),
			uniqueMemoryReads: sum((run) => run.telemetry.budget.uniqueMemoryReads),
			evidenceReads: sum((run) => run.telemetry.budget.evidenceReads),
			skillCandidateActions: sum((run) => run.telemetry.budget.skillCandidateActions),
		},
		totalTokens: sum((run) => run.telemetry.totalTokens),
		elapsedMs: sum((run) => run.telemetry.elapsedMs),
		memoryStateUse: {
			trust: {
				verified: sumState("trust", "verified"),
				model_inferred: sumState("trust", "model_inferred"),
				disputed: sumState("trust", "disputed"),
			},
			freshness: {
				current: sumState("freshness", "current"),
				stale: sumState("freshness", "stale"),
				unknown: sumState("freshness", "unknown"),
			},
		},
		verifier: {
			passed: sum((run) => (run.verifier.passed ? 1 : 0)),
			failed: sum((run) => (run.verifier.passed ? 0 : 1)),
			blindFollowedStaleOrDisputed: sum((run) => (run.verifier.blindFollowedStaleOrDisputed ? 1 : 0)),
		},
	};
}

function addFinding(findings, category, details = {}) {
	findings.push({ category, ...details });
}

export function evaluateAmbientEffectReport(input) {
	const report = validateReport(input);
	const findings = [];
	const taskCounts = {
		history_positive: report.tasks.filter((task) => task.category === "history_positive").length,
		stale_or_conflict: report.tasks.filter((task) => task.category === "stale_or_conflict").length,
		unrelated_one_shot: report.tasks.filter((task) => task.category === "unrelated_one_shot").length,
	};
	if (
		report.tasks.length !== 12 ||
		taskCounts.history_positive !== 6 ||
		taskCounts.stale_or_conflict !== 3 ||
		taskCounts.unrelated_one_shot !== 3
	) {
		addFinding(findings, "sealed_task_matrix_mismatch", { taskCounts });
	}

	const historical = weightedRuns(
		report.tasks,
		(category) => category === "history_positive" || category === "stale_or_conflict",
	);
	const unrelated = weightedRuns(report.tasks, (category) => category === "unrelated_one_shot");
	if (historical.length !== 18) addFinding(findings, "historical_pair_count_mismatch", { actual: historical.length });
	if (unrelated.length !== 3) addFinding(findings, "unrelated_pair_count_mismatch", { actual: unrelated.length });

	const treatmentD1Runs = historical.filter(({ group }) => group.byArm.get("treatment").telemetry.d1SearchCalls > 0).length;
	const relevantD2Runs = historical.filter(
		({ group }) => group.byArm.get("treatment").telemetry.relevantD2Reads > 0,
	).length;
	if (treatmentD1Runs < 15) addFinding(findings, "treatment_d1_below_threshold", { actual: treatmentD1Runs });
	if (relevantD2Runs < 12) addFinding(findings, "treatment_relevant_d2_below_threshold", { actual: relevantD2Runs });

	const treatmentPasses = historical.filter(({ group }) => group.byArm.get("treatment").verifier.passed).length;
	const placeboPasses = historical.filter(({ group }) => group.byArm.get("placebo").verifier.passed).length;
	const passDelta = treatmentPasses - placeboPasses;
	if (passDelta < 3) addFinding(findings, "treatment_verifier_gain_below_threshold", { passDelta });

	for (const { task, group } of historical) {
		if (
			task.category === "stale_or_conflict" &&
			group.byArm.get("treatment").verifier.blindFollowedStaleOrDisputed
		) {
			addFinding(findings, "blind_stale_or_conflict_follow", { taskId: task.id });
		}
	}

	const unrelatedTreatmentD1Runs = unrelated.filter(
		({ group }) => group.byArm.get("treatment").telemetry.d1SearchCalls > 0,
	).length;
	if (unrelatedTreatmentD1Runs > Math.floor(unrelated.length / 3)) {
		addFinding(findings, "unrelated_d1_above_threshold", { actual: unrelatedTreatmentD1Runs });
	}

	const treatmentTokens = historical.map(({ group }) => group.byArm.get("treatment").telemetry.totalTokens);
	const placeboTokens = historical.map(({ group }) => group.byArm.get("placebo").telemetry.totalTokens);
	const treatmentElapsedMs = historical.map(({ group }) => group.byArm.get("treatment").telemetry.elapsedMs);
	const placeboElapsedMs = historical.map(({ group }) => group.byArm.get("placebo").telemetry.elapsedMs);
	const medianTreatmentTokens = median(treatmentTokens);
	const medianPlaceboTokens = median(placeboTokens);
	const medianTreatmentElapsedMs = median(treatmentElapsedMs);
	const medianPlaceboElapsedMs = median(placeboElapsedMs);
	const armSummary = {
		historical: {
			baseline: summarizeArmRuns(historical, "baseline"),
			placebo: summarizeArmRuns(historical, "placebo"),
			treatment: summarizeArmRuns(historical, "treatment"),
		},
		unrelated: {
			baseline: summarizeArmRuns(unrelated, "baseline"),
			placebo: summarizeArmRuns(unrelated, "placebo"),
			treatment: summarizeArmRuns(unrelated, "treatment"),
		},
	};
	if (
		medianTreatmentTokens === null ||
		medianPlaceboTokens === null ||
		medianTreatmentElapsedMs === null ||
		medianPlaceboElapsedMs === null
	) {
		addFinding(findings, "missing_historical_overhead_measurement");
	} else {
		if (medianTreatmentTokens > medianPlaceboTokens * 1.25) {
			addFinding(findings, "token_overhead_above_threshold", {
				medianTreatmentTokens,
				medianPlaceboTokens,
			});
		}
		if (medianTreatmentElapsedMs > medianPlaceboElapsedMs * 1.25) {
			addFinding(findings, "latency_overhead_above_threshold", {
				medianTreatmentElapsedMs,
				medianPlaceboElapsedMs,
			});
		}
	}

	return {
		schema: REPORT_SCHEMA,
		evidenceClass: report.reportKind,
		realProviderEvidence: report.reportKind === "provider_run",
		metadata: report.metadata,
		tasks: {
			total: report.tasks.length,
			historical: taskCounts.history_positive + taskCounts.stale_or_conflict,
			staleOrConflict: taskCounts.stale_or_conflict,
			unrelated: taskCounts.unrelated_one_shot,
		},
		measurements: {
			historicalTreatmentRuns: historical.length,
			treatmentD1Runs,
			relevantD2Runs,
			treatmentPasses,
			placeboPasses,
			passDelta,
			unrelatedTreatmentD1Runs,
			medianTreatmentTokens,
			medianPlaceboTokens,
			medianTreatmentElapsedMs,
			medianPlaceboElapsedMs,
			armSummary,
		},
		findings,
	};
}

async function main() {
	const reportPath = process.argv[2];
	if (!reportPath) {
		throw new Error("usage: node --import tsx scripts/evaluate-pi-xk-ambient-effect.mjs <redacted-run-report.json>");
	}
	const input = JSON.parse(await readFile(resolve(reportPath), "utf8"));
	const report = evaluateAmbientEffectReport(input);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
