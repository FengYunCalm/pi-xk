import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPORT_SCHEMA = "pi-xk.capability-report.v1";
const MATRIX_SCHEMA = "pi-xk.capability-matrix.v1";
const AGENTS = new Set(["pi-native", "pi-xk"]);
const EXECUTIONS = new Set(["faux-provider", "real-provider"]);
const STATUSES = new Set(["passed", "failed", "unsupported", "not-run", "inconclusive"]);
const REPORT_KINDS = new Set(["public-calibration", "public-evaluation", "workflow-smoke", "workflow-validation"]);
const FORBIDDEN_FIELD = /(?:api[_-]?key|authorization|credential|secret|prompt|transcript|content|message)/iu;
const REPORT_KEYS = new Set(["schema", "reportKind", "generatedAt", "runs"]);
const RUN_KEYS = new Set([
	"id",
	"scenarioId",
	"comparisonId",
	"agent",
	"execution",
	"status",
	"control",
	"metrics",
	"verification",
]);
const CONTROL_KEYS = new Set(["model", "thinking", "piVersion", "runtimeId", "taskDigest", "budget"]);
const BUDGET_KEYS = new Set(["wallSeconds", "toolPolicy"]);
const METRIC_KEYS = new Set([
	"reward",
	"inputTokensIncludingCache",
	"outputTokens",
	"cacheReadTokens",
	"costUsd",
	"elapsedSeconds",
]);
const VERIFICATION_KEYS = new Set(["structural", "independent"]);

function usage() {
	console.log(`Usage: node scripts/evaluate-pi-xk-capabilities.mjs --matrix <path> --report <path> [--report <path> ...] [--format json|markdown]

Validate a sanitized Pi-XK capability report. Public parity runs are compared only
when every declared control is identical; Pi-XK workflow scenarios are reported
separately and never converted into a native-agent failure score.`);
}

function parseArgs(argv) {
	let matrix;
	const reports = [];
	let format = "json";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--matrix") {
			matrix = argv[++index];
			continue;
		}
		if (argument === "--report") {
			reports.push(argv[++index]);
			continue;
		}
		if (argument === "--format") {
			format = argv[++index];
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!matrix || reports.length === 0) throw new Error("--matrix and at least one --report are required");
	if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown");
	return { help: false, matrix: resolve(matrix), reports: reports.map((report) => resolve(report)), format };
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function requireFiniteNumber(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative finite number`);
	}
	return value;
}

function assertNoSensitiveFields(value, path = "report") {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) assertNoSensitiveFields(entry, `${path}[${index}]`);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		if (FORBIDDEN_FIELD.test(key)) throw new Error(`${path}.${key} is forbidden in a sanitized report`);
		assertNoSensitiveFields(entry, `${path}.${key}`);
	}
}

function assertExactKeys(value, expected, path) {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) throw new Error(`${path}.${key} is forbidden in a sanitized report`);
	}
	for (const key of expected) {
		if (!(key in value)) throw new Error(`${path}.${key} is required`);
	}
}

function assertAllowedKeys(value, allowed, path) {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path}.${key} is forbidden in a sanitized report`);
	}
}

function parseMatrix(value) {
	if (!isRecord(value) || value.schema !== MATRIX_SCHEMA || !Array.isArray(value.scenarios)) {
		throw new Error("Capability matrix schema is invalid");
	}
	const scenarioDefinitions = new Map();
	for (const scenario of value.scenarios) {
		if (!isRecord(scenario)) throw new Error("Capability matrix scenario is invalid");
		const id = requireString(scenario.id, "matrix scenario id");
		const scenarioClass = requireString(scenario.class, `matrix scenario ${id} class`);
		if (scenarioClass !== "public-parity" && scenarioClass !== "pi-xk-workflow") {
			throw new Error(`matrix scenario ${id} has an unsupported class`);
		}
		if (scenarioDefinitions.has(id)) throw new Error(`Capability matrix scenario is duplicated: ${id}`);
		let minimumComparisons = 0;
		if (scenarioClass === "public-parity") {
			minimumComparisons = scenario.minimumComparisons;
			if (!Number.isInteger(minimumComparisons) || minimumComparisons <= 0) {
				throw new Error(`matrix scenario ${id} minimumComparisons must be a positive integer`);
			}
		}
		scenarioDefinitions.set(id, { scenarioClass, minimumComparisons });
	}
	return scenarioDefinitions;
}

function normalizedControl(control, runId) {
	assertExactKeys(control, CONTROL_KEYS, `Run ${runId} control`);
	assertExactKeys(control.budget, BUDGET_KEYS, `Run ${runId} control budget`);
	return {
		model: requireString(control.model, `Run ${runId} control model`),
		thinking: requireString(control.thinking, `Run ${runId} control thinking`),
		piVersion: requireString(control.piVersion, `Run ${runId} control piVersion`),
		runtimeId: requireString(control.runtimeId, `Run ${runId} control runtimeId`),
		taskDigest: requireString(control.taskDigest, `Run ${runId} control taskDigest`),
		budget: {
			wallSeconds: requireFiniteNumber(control.budget.wallSeconds, `Run ${runId} control budget wallSeconds`),
			toolPolicy: requireString(control.budget.toolPolicy, `Run ${runId} control budget toolPolicy`),
		},
	};
}

function parseRun(value, scenarioDefinitions, reportKind) {
	assertAllowedKeys(value, RUN_KEYS, "Capability report run");
	const id = requireString(value.id, "run id");
	const scenarioId = requireString(value.scenarioId, `Run ${id} scenarioId`);
	const scenarioDefinition = scenarioDefinitions.get(scenarioId);
	if (!scenarioDefinition) throw new Error(`Run ${id} references an unknown scenario: ${scenarioId}`);
	const { scenarioClass } = scenarioDefinition;
	const agent = requireString(value.agent, `Run ${id} agent`);
	if (!AGENTS.has(agent)) throw new Error(`Run ${id} has an unsupported agent`);
	const execution = requireString(value.execution, `Run ${id} execution`);
	if (!EXECUTIONS.has(execution)) throw new Error(`Run ${id} has an unsupported execution`);
	const status = requireString(value.status, `Run ${id} status`);
	if (!STATUSES.has(status)) throw new Error(`Run ${id} has an unsupported status`);
	assertExactKeys(value.metrics, METRIC_KEYS, `Run ${id} metrics`);
	const metrics = {
		reward: requireFiniteNumber(value.metrics.reward, `Run ${id} reward`),
		inputTokensIncludingCache: requireFiniteNumber(
			value.metrics.inputTokensIncludingCache,
			`Run ${id} inputTokensIncludingCache`,
		),
		outputTokens: requireFiniteNumber(value.metrics.outputTokens, `Run ${id} outputTokens`),
		cacheReadTokens: requireFiniteNumber(value.metrics.cacheReadTokens, `Run ${id} cacheReadTokens`),
		costUsd: requireFiniteNumber(value.metrics.costUsd, `Run ${id} costUsd`),
		elapsedSeconds: requireFiniteNumber(value.metrics.elapsedSeconds, `Run ${id} elapsedSeconds`),
	};
	assertExactKeys(value.verification, VERIFICATION_KEYS, `Run ${id} verification`);
	if (typeof value.verification.structural !== "boolean" || typeof value.verification.independent !== "boolean") {
		throw new Error(`Run ${id} verification results must be boolean`);
	}
	const comparisonId = value.comparisonId === undefined ? undefined : requireString(value.comparisonId, `Run ${id} comparisonId`);
	if (scenarioClass === "public-parity" && !comparisonId) {
		throw new Error(`Public parity run ${id} requires comparisonId`);
	}
	if (scenarioClass === "public-parity" && !["public-calibration", "public-evaluation"].includes(reportKind)) {
		throw new Error(`Public parity run ${id} must use a public report kind`);
	}
	if (scenarioClass === "public-parity" && reportKind === "public-evaluation" && execution !== "real-provider") {
		throw new Error(`Public evaluation run ${id} must use a real provider`);
	}
	if (scenarioClass === "public-parity" && reportKind === "public-evaluation" && !value.verification.independent) {
		throw new Error(`Public evaluation run ${id} requires an independent verifier`);
	}
	if (scenarioClass === "pi-xk-workflow" && agent !== "pi-xk") {
		throw new Error(`Pi-XK workflow run ${id} must use pi-xk rather than treating native Pi as a failure`);
	}
	if (scenarioClass === "pi-xk-workflow" && !["workflow-smoke", "workflow-validation"].includes(reportKind)) {
		throw new Error(`Pi-XK workflow run ${id} must use a workflow report kind`);
	}
	return {
		id,
		scenarioId,
		scenarioClass,
		reportKind,
		comparisonId,
		agent,
		execution,
		status,
		control: normalizedControl(value.control, id),
		metrics,
		verification: { structural: value.verification.structural, independent: value.verification.independent },
	};
}

function controlsMatch(left, right) {
	return (
		left.model === right.model &&
		left.thinking === right.thinking &&
		left.piVersion === right.piVersion &&
		left.runtimeId === right.runtimeId &&
		left.taskDigest === right.taskDigest &&
		left.budget.wallSeconds === right.budget.wallSeconds &&
		left.budget.toolPolicy === right.budget.toolPolicy
	);
}

function compareParityRuns(runs, reportKind) {
	const byComparison = new Map();
	for (const run of runs.filter(
		(candidate) => candidate.scenarioClass === "public-parity" && candidate.reportKind === reportKind,
	)) {
		const group = byComparison.get(run.comparisonId) ?? [];
		group.push(run);
		byComparison.set(run.comparisonId, group);
	}
	const comparisons = [];
	for (const [comparisonId, group] of byComparison) {
		const native = group.filter((candidate) => candidate.agent === "pi-native");
		const xk = group.filter((candidate) => candidate.agent === "pi-xk");
		if (native.length !== 1 || xk.length !== 1) {
			throw new Error(`Public parity comparison ${comparisonId} requires exactly one pi-native and one pi-xk run`);
		}
		const nativeRun = native[0];
		const xkRun = xk[0];
		if (!controlsMatch(nativeRun.control, xkRun.control)) {
			throw new Error(`Public parity comparison ${comparisonId} does not have identical controls`);
		}
		const nativePass = nativeRun.status === "passed" && nativeRun.metrics.reward >= 1;
		const xkPass = xkRun.status === "passed" && xkRun.metrics.reward >= 1;
		const outcome = nativePass === xkPass ? "tied" : xkPass ? "pi-xk-pass-advantage" : "pi-native-pass-advantage";
		comparisons.push({
			comparisonId,
			outcome,
			piNative: {
				reward: nativeRun.metrics.reward,
				inputTokensIncludingCache: nativeRun.metrics.inputTokensIncludingCache,
				outputTokens: nativeRun.metrics.outputTokens,
				costUsd: nativeRun.metrics.costUsd,
				elapsedSeconds: nativeRun.metrics.elapsedSeconds,
			},
			piXk: {
				reward: xkRun.metrics.reward,
				inputTokensIncludingCache: xkRun.metrics.inputTokensIncludingCache,
				outputTokens: xkRun.metrics.outputTokens,
				costUsd: xkRun.metrics.costUsd,
				elapsedSeconds: xkRun.metrics.elapsedSeconds,
			},
		});
	}
	return comparisons.sort((left, right) => left.comparisonId.localeCompare(right.comparisonId));
}

function comparisonCount(runs, reportKind, scenarioId) {
	return new Set(
		runs
			.filter((run) => run.reportKind === reportKind && run.scenarioId === scenarioId)
			.map((run) => run.comparisonId),
	).size;
}

function summarizeCoverage(scenarioDefinitions, runs) {
	const calibrated = new Set(
		runs.filter((run) => run.reportKind === "public-calibration").map((run) => run.scenarioId),
	);
	const workflows = new Set(runs.filter((run) => run.scenarioClass === "pi-xk-workflow").map((run) => run.scenarioId));
	const publicParity = [];
	const workflow = [];
	for (const [scenarioId, definition] of scenarioDefinitions) {
		const { scenarioClass, minimumComparisons } = definition;
		const target = scenarioClass === "public-parity" ? publicParity : workflow;
		if (scenarioClass === "public-parity") {
			const count = comparisonCount(runs, "public-evaluation", scenarioId);
			target.push({
				scenarioId,
				covered: count > 0,
				calibrated: calibrated.has(scenarioId),
				comparisonCount: count,
				minimumComparisons,
				sufficient: count >= minimumComparisons,
			});
			continue;
		}
		target.push({ scenarioId, covered: workflows.has(scenarioId) });
	}
	return { publicParity, workflow };
}

function summarizeComparisonStatistics(comparisons) {
	const statistics = { comparisons: comparisons.length, piXkAdvantages: 0, piNativeAdvantages: 0, ties: 0 };
	for (const comparison of comparisons) {
		if (comparison.outcome === "pi-xk-pass-advantage") statistics.piXkAdvantages += 1;
		else if (comparison.outcome === "pi-native-pass-advantage") statistics.piNativeAdvantages += 1;
		else statistics.ties += 1;
	}
	return statistics;
}

function summarizeWorkflowStatistics(workflows) {
	const statistics = { runs: workflows.length, passed: 0, failed: 0, inconclusive: 0, other: 0 };
	for (const workflow of workflows) {
		if (workflow.status === "passed") statistics.passed += 1;
		else if (workflow.status === "failed") statistics.failed += 1;
		else if (workflow.status === "inconclusive") statistics.inconclusive += 1;
		else statistics.other += 1;
	}
	return statistics;
}

function summarizeWorkflows(runs) {
	return runs
		.filter((run) => run.scenarioClass === "pi-xk-workflow")
		.map((run) => ({
			id: run.id,
			scenarioId: run.scenarioId,
			execution: run.execution,
			status: run.status,
			structural: run.verification.structural,
			independent: run.verification.independent,
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

function renderMarkdown(summary) {
	const lines = [
		"# Pi-XK capability evaluation",
		"",
		"## Summary",
		`- Public evaluation: ${summary.statistics.publicParity.comparisons} pair(s); Pi-XK advantage ${summary.statistics.publicParity.piXkAdvantages}; native advantage ${summary.statistics.publicParity.piNativeAdvantages}; ties ${summary.statistics.publicParity.ties}.`,
		`- Pi-XK workflows: ${summary.statistics.workflow.passed}/${summary.statistics.workflow.runs} passed; failed ${summary.statistics.workflow.failed}; inconclusive ${summary.statistics.workflow.inconclusive}.`,
		"",
		"## Public parity",
	];
	if (summary.publicParity.length === 0) lines.push("No public parity comparisons were supplied.");
	for (const comparison of summary.publicParity) {
		lines.push(
			`- ${comparison.comparisonId}: ${comparison.outcome}; native reward ${comparison.piNative.reward}, Pi-XK reward ${comparison.piXk.reward}; native input ${comparison.piNative.inputTokensIncludingCache}, Pi-XK input ${comparison.piXk.inputTokensIncludingCache}; native output ${comparison.piNative.outputTokens}, Pi-XK output ${comparison.piXk.outputTokens}; native cost $${comparison.piNative.costUsd.toFixed(6)}, Pi-XK cost $${comparison.piXk.costUsd.toFixed(6)}.`,
		);
	}
	lines.push("", "## Public calibration");
	if (summary.publicCalibration.length === 0) lines.push("No public calibration records were supplied.");
	for (const comparison of summary.publicCalibration) {
		lines.push(
			`- ${comparison.comparisonId}: ${comparison.outcome}; native reward ${comparison.piNative.reward}, Pi-XK reward ${comparison.piXk.reward}. Calibration records are not counted as public parity evidence.`,
		);
	}
	lines.push("", "## Pi-XK workflow evidence");
	if (summary.workflow.length === 0) lines.push("No Pi-XK workflow results were supplied.");
	for (const workflow of summary.workflow) {
		lines.push(
			`- ${workflow.scenarioId}: ${workflow.status}; structural=${workflow.structural}; independent=${workflow.independent}; execution=${workflow.execution}.`,
		);
	}
	lines.push("", "## Coverage");
	for (const coverage of summary.coverage.publicParity) {
		lines.push(
			`- public parity ${coverage.scenarioId}: ${coverage.comparisonCount}/${coverage.minimumComparisons} formal pair(s); sufficient=${coverage.sufficient}; calibration=${coverage.calibrated ? "present" : "absent"}.`,
		);
	}
	for (const coverage of summary.coverage.workflow) {
		lines.push(`- Pi-XK workflow ${coverage.scenarioId}: ${coverage.covered ? "covered" : "not covered"}.`);
	}
	lines.push(
		"",
		"Workflow results establish feature behavior, not a public benchmark score against native Pi. A public advantage requires precommitted, paired, identical-control verifier results.",
	);
	return `${lines.join("\n")}\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const [matrixValue, ...reportValues] = await Promise.all([
		readFile(options.matrix, "utf8").then((content) => JSON.parse(content)),
		...options.reports.map((report) => readFile(report, "utf8").then((content) => JSON.parse(content))),
	]);
	const scenarioDefinitions = parseMatrix(matrixValue);
	const runs = reportValues.flatMap((reportValue, index) => {
		assertNoSensitiveFields(reportValue, `report[${index}]`);
		assertExactKeys(reportValue, REPORT_KEYS, `report[${index}]`);
		if (reportValue.schema !== REPORT_SCHEMA || !Array.isArray(reportValue.runs)) {
			throw new Error("Capability report schema is invalid");
		}
		const reportKind = requireString(reportValue.reportKind, `report[${index}] reportKind`);
		if (!REPORT_KINDS.has(reportKind)) throw new Error(`report[${index}] has an unsupported reportKind`);
		const generatedAt = requireString(reportValue.generatedAt, `report[${index}] generatedAt`);
		if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("report generatedAt must be an ISO timestamp");
		return reportValue.runs.map((run) => parseRun(run, scenarioDefinitions, reportKind));
	});
	if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new Error("Capability report run ids must be unique");
	const publicParity = compareParityRuns(runs, "public-evaluation");
	const publicCalibration = compareParityRuns(runs, "public-calibration");
	const workflow = summarizeWorkflows(runs);
	const summary = {
		schema: "pi-xk.capability-summary.v1",
		publicParity,
		publicCalibration,
		workflow,
		statistics: {
			publicParity: summarizeComparisonStatistics(publicParity),
			publicCalibration: summarizeComparisonStatistics(publicCalibration),
			workflow: summarizeWorkflowStatistics(workflow),
		},
		coverage: summarizeCoverage(scenarioDefinitions, runs),
	};
	process.stdout.write(options.format === "markdown" ? renderMarkdown(summary) : `${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
