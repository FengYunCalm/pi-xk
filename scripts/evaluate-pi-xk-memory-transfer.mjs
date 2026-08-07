import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PLAN_SCHEMA = "pi-xk.memory-transfer-plan.v1";
const REPORT_SCHEMA_V1 = "pi-xk.memory-transfer-report.v1";
const REPORT_SCHEMA = "pi-xk.memory-transfer-report.v2";
const SUMMARY_SCHEMA = "pi-xk.memory-transfer-summary.v2";
const REPORT_SCHEMAS = new Set([REPORT_SCHEMA_V1, REPORT_SCHEMA]);
const REPORT_KINDS = new Set(["deterministic-fixture", "real-provider"]);
const ARM_IDS = new Set(["pi-native", "pi-xk-memory-off", "pi-xk-placebo", "pi-xk-learned"]);
const AGENTS = new Set(["pi-native", "pi-xk"]);
const MEMORY_SETUPS = new Set(["none", "disabled", "placebo", "learned"]);
const EPISODE_KINDS = new Set(["learning", "exact-reuse", "similar-transfer", "changed-rule", "unrelated"]);
const STATUSES = new Set(["passed", "failed", "inconclusive", "not-run"]);
const REVIEW_ACTIONS = new Set(["revise", "supersede", "dispute", "create", null]);
const REVIEW_PUBLICATIONS = new Set(["applied", "failed", "none"]);
const FORBIDDEN_FIELD = /(?:api[_-]?key|authorization|credential|secret|prompt|transcript|message|content|statement|text|body|argument|artifact|sourceid|toolinput|trajectory)/iu;

const PLAN_KEYS = new Set(["schema", "title", "minimumAttempts", "controls", "arms", "episodes", "thresholds"]);
const PLAN_CONTROL_KEYS = new Set(["provider", "model", "thinking", "wallSeconds", "toolPolicy"]);
const PLAN_ARM_KEYS = new Set(["id", "agent", "memorySetup"]);
const PLAN_EPISODE_KEYS = new Set(["id", "kind", "relevantRecallExpected"]);
const THRESHOLD_KEYS = new Set([
	"exactRecallRateMin",
	"similarRecallRateMin",
	"changedRulePassRateMin",
	"changedRuleRevisionRateMin",
	"unrelatedD1RateMax",
	"exactVerifierDeltaMin",
	"similarVerifierDeltaMin",
	"exactEfficiencyGainMin",
	"medianOverheadMax",
]);
const REPORT_KEYS = new Set(["schema", "reportKind", "generatedAt", "planDigest", "runs"]);
const RUN_KEYS = new Set(["id", "attemptId", "arm", "episodeId", "status", "control", "setup", "metrics", "recall", "verification"]);
const CONTROL_KEYS = new Set(["model", "thinking", "piVersion", "runtimeId", "taskDigest", "budget"]);
const BUDGET_KEYS = new Set(["wallSeconds", "toolPolicy"]);
const SETUP_KEYS = new Set(["memorySetup", "seededMemories", "seedUtf8Bytes", "captureVerified"]);
const METRIC_KEYS = new Set([
	"inputTokensIncludingCache",
	"outputTokens",
	"cacheReadTokens",
	"costUsd",
	"elapsedSeconds",
	"toolCalls",
	"explorationCalls",
	"fileReadCalls",
	"duplicateFileReads",
	"firstRelevantEvidenceSeconds",
]);
const RECALL_KEYS_V1 = new Set([
	"d1SearchCalls",
	"d2ReadCalls",
	"d3EvidenceCalls",
	"reviewCalls",
	"relatedMemoryRead",
	"publishedReview",
	"reviewAction",
]);
const RECALL_KEYS = new Set([
	"d1SearchCalls",
	"d2ReadCalls",
	"d3EvidenceCalls",
	"d1CandidateCount",
	"reviewCalls",
	"relatedMemoryRead",
	"relatedCandidateExposed",
	"publishedReview",
	"reviewPublication",
	"reviewFailureCode",
	"reviewAction",
]);
const VERIFICATION_KEYS = new Set(["independent", "passed", "reward", "verifierDigest"]);

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected, path) {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${path} has unknown or missing fields`);
	}
}

function allowedKeys(value, allowed, path) {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path}.${key} is forbidden in a sanitized report`);
	}
}

function nonEmptyString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function boundedNonNegative(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative finite number`);
	}
	return value;
}

function boundedInteger(value, field) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
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

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digestJson(value) {
	return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

export function memoryTransferPlanDigest(plan) {
	return digestJson(plan);
}

function parseThresholds(value) {
	exactKeys(value, THRESHOLD_KEYS, "plan.thresholds");
	const thresholds = {};
	for (const key of THRESHOLD_KEYS) thresholds[key] = boundedNonNegative(value[key], `plan.thresholds.${key}`);
	if (thresholds.exactRecallRateMin > 1 || thresholds.similarRecallRateMin > 1) {
		throw new Error("Recall rate thresholds must be at most 1");
	}
	if (thresholds.changedRulePassRateMin > 1 || thresholds.changedRuleRevisionRateMin > 1) {
		throw new Error("Changed-rule rate thresholds must be at most 1");
	}
	if (thresholds.unrelatedD1RateMax > 1) throw new Error("unrelatedD1RateMax must be at most 1");
	return thresholds;
}

export function validateMemoryTransferPlan(value) {
	exactKeys(value, PLAN_KEYS, "plan");
	if (value.schema !== PLAN_SCHEMA) throw new Error("Memory transfer plan schema is invalid");
	nonEmptyString(value.title, "plan.title");
	if (!Number.isInteger(value.minimumAttempts) || value.minimumAttempts < 1) {
		throw new Error("plan.minimumAttempts must be a positive integer");
	}
	exactKeys(value.controls, PLAN_CONTROL_KEYS, "plan.controls");
	for (const key of ["provider", "model", "thinking", "toolPolicy"]) nonEmptyString(value.controls[key], `plan.controls.${key}`);
	boundedNonNegative(value.controls.wallSeconds, "plan.controls.wallSeconds");
	if (!Array.isArray(value.arms) || value.arms.length !== 4) throw new Error("plan must declare exactly four arms");
	const arms = value.arms.map((arm, index) => {
		exactKeys(arm, PLAN_ARM_KEYS, `plan.arms[${index}]`);
		if (!ARM_IDS.has(arm.id)) throw new Error(`Unsupported memory transfer arm: ${arm.id}`);
		if (!AGENTS.has(arm.agent)) throw new Error(`Unsupported agent for arm ${arm.id}`);
		if (!MEMORY_SETUPS.has(arm.memorySetup)) throw new Error(`Unsupported Memory setup for arm ${arm.id}`);
		return { ...arm };
	});
	if (new Set(arms.map((arm) => arm.id)).size !== arms.length || !arms.some((arm) => arm.id === "pi-xk-learned")) {
		throw new Error("plan arms must be unique and include pi-xk-learned");
	}
	if (!Array.isArray(value.episodes) || value.episodes.length !== 5) throw new Error("plan must declare five episodes");
	const episodes = value.episodes.map((episode, index) => {
		exactKeys(episode, PLAN_EPISODE_KEYS, `plan.episodes[${index}]`);
		if (!EPISODE_KINDS.has(episode.kind) || episode.id !== episode.kind) {
			throw new Error(`Episode ${episode.id} must use its canonical kind`);
		}
		if (typeof episode.relevantRecallExpected !== "boolean") {
			throw new Error(`Episode ${episode.id} relevantRecallExpected must be boolean`);
		}
		return { ...episode };
	});
	if (new Set(episodes.map((episode) => episode.id)).size !== episodes.length) throw new Error("plan episode IDs must be unique");
	for (const expected of ["learning", "exact-reuse", "similar-transfer", "changed-rule", "unrelated"]) {
		if (!episodes.some((episode) => episode.id === expected)) throw new Error(`plan is missing ${expected} episode`);
	}
	const thresholds = parseThresholds(value.thresholds);
	return { ...value, arms, episodes, thresholds };
}

function parseControl(value, path) {
	exactKeys(value, CONTROL_KEYS, path);
	exactKeys(value.budget, BUDGET_KEYS, `${path}.budget`);
	for (const key of ["model", "thinking", "piVersion", "runtimeId", "taskDigest"]) nonEmptyString(value[key], `${path}.${key}`);
	boundedNonNegative(value.budget.wallSeconds, `${path}.budget.wallSeconds`);
	nonEmptyString(value.budget.toolPolicy, `${path}.budget.toolPolicy`);
	return {
		model: value.model,
		thinking: value.thinking,
		piVersion: value.piVersion,
		runtimeId: value.runtimeId,
		taskDigest: value.taskDigest,
		budget: { wallSeconds: value.budget.wallSeconds, toolPolicy: value.budget.toolPolicy },
	};
}

function parseRun(value, plan, reportKind, reportSchema) {
	allowedKeys(value, RUN_KEYS, "run");
	for (const key of RUN_KEYS) if (!(key in value)) throw new Error(`run.${key} is required`);
	const id = nonEmptyString(value.id, "run.id");
	const attemptId = nonEmptyString(value.attemptId, `run ${id} attemptId`);
	if (!ARM_IDS.has(value.arm)) throw new Error(`run ${id} has an unsupported arm`);
	if (!EPISODE_KINDS.has(value.episodeId)) throw new Error(`run ${id} has an unsupported episode`);
	if (!STATUSES.has(value.status)) throw new Error(`run ${id} has an unsupported status`);
	const arm = plan.arms.find((candidate) => candidate.id === value.arm);
	if (!arm) throw new Error(`run ${id} refers to an undeclared arm`);
	const episode = plan.episodes.find((candidate) => candidate.id === value.episodeId);
	if (!episode) throw new Error(`run ${id} refers to an undeclared episode`);
	const control = parseControl(value.control, `run ${id}.control`);
	exactKeys(value.setup, SETUP_KEYS, `run ${id}.setup`);
	if (!MEMORY_SETUPS.has(value.setup.memorySetup)) throw new Error(`run ${id} Memory setup is invalid`);
	boundedInteger(value.setup.seededMemories, `run ${id}.setup.seededMemories`);
	boundedInteger(value.setup.seedUtf8Bytes, `run ${id}.setup.seedUtf8Bytes`);
	if (typeof value.setup.captureVerified !== "boolean") throw new Error(`run ${id}.setup.captureVerified must be boolean`);
	if (value.setup.memorySetup !== arm.memorySetup) throw new Error(`run ${id} Memory setup does not match its arm`);
	if (value.episodeId === "learning" && value.setup.seededMemories !== 0) {
		throw new Error(`run ${id} learning episode cannot have a seeded Memory`);
	}
	exactKeys(value.metrics, METRIC_KEYS, `run ${id}.metrics`);
	for (const key of METRIC_KEYS) {
		if (key === "firstRelevantEvidenceSeconds") {
			if (value.metrics[key] !== null) boundedNonNegative(value.metrics[key], `run ${id}.metrics.${key}`);
		} else if (key.endsWith("Calls") || key === "toolCalls" || key === "explorationCalls" || key === "fileReadCalls" || key === "duplicateFileReads") {
			boundedInteger(value.metrics[key], `run ${id}.metrics.${key}`);
		} else {
			boundedNonNegative(value.metrics[key], `run ${id}.metrics.${key}`);
		}
	}
	exactKeys(value.recall, reportSchema === REPORT_SCHEMA_V1 ? RECALL_KEYS_V1 : RECALL_KEYS, `run ${id}.recall`);
	const recall = reportSchema === REPORT_SCHEMA_V1
		? {
			...value.recall,
			d1CandidateCount: 0,
			relatedCandidateExposed: false,
			reviewPublication: value.recall.publishedReview ? "applied" : "none",
			reviewFailureCode: null,
		}
		: value.recall;
	for (const key of ["d1SearchCalls", "d2ReadCalls", "d3EvidenceCalls", "d1CandidateCount", "reviewCalls"]) {
		boundedInteger(recall[key], `run ${id}.recall.${key}`);
	}
	if (typeof recall.relatedMemoryRead !== "boolean") throw new Error(`run ${id}.recall.relatedMemoryRead must be boolean`);
	if (typeof recall.relatedCandidateExposed !== "boolean") throw new Error(`run ${id}.recall.relatedCandidateExposed must be boolean`);
	if (recall.d1SearchCalls === 0 && recall.d1CandidateCount !== 0) {
		throw new Error(`run ${id}.recall.d1CandidateCount requires a D1 search call`);
	}
	if (recall.relatedCandidateExposed && recall.d1CandidateCount === 0) {
		throw new Error(`run ${id}.recall.relatedCandidateExposed requires a D1 candidate`);
	}
	if (recall.relatedMemoryRead && recall.d2ReadCalls === 0) {
		throw new Error(`run ${id}.recall.relatedMemoryRead requires a D2 read call`);
	}
	if (typeof recall.publishedReview !== "boolean") throw new Error(`run ${id}.recall.publishedReview must be boolean`);
	if (!REVIEW_PUBLICATIONS.has(recall.reviewPublication)) throw new Error(`run ${id}.recall.reviewPublication is invalid`);
	if (recall.reviewFailureCode !== null) nonEmptyString(recall.reviewFailureCode, `run ${id}.recall.reviewFailureCode`);
	if ((recall.reviewPublication === "failed") !== (recall.reviewFailureCode !== null)) {
		throw new Error(`run ${id}.recall.reviewFailureCode does not match publication state`);
	}
	if (recall.publishedReview !== (recall.reviewPublication === "applied")) {
		throw new Error(`run ${id}.recall.publishedReview does not match publication state`);
	}
	if (!REVIEW_ACTIONS.has(recall.reviewAction)) throw new Error(`run ${id}.recall.reviewAction is invalid`);
	exactKeys(value.verification, VERIFICATION_KEYS, `run ${id}.verification`);
	for (const key of ["independent", "passed"]) if (typeof value.verification[key] !== "boolean") throw new Error(`run ${id}.verification.${key} must be boolean`);
	boundedNonNegative(value.verification.reward, `run ${id}.verification.reward`);
	nonEmptyString(value.verification.verifierDigest, `run ${id}.verification.verifierDigest`);
	if (reportKind === "real-provider" && !value.verification.independent) throw new Error(`run ${id} requires an independent verifier`);
	if (value.status === "passed" && (!value.verification.passed || value.verification.reward < 1)) {
		throw new Error(`run ${id} is passed without a passing verifier result`);
	}
	return { id, attemptId, arm: value.arm, episodeId: value.episodeId, status: value.status, control, setup: value.setup, metrics: value.metrics, recall, verification: value.verification };
}

function controlsMatch(left, right) {
	return left.model === right.model && left.thinking === right.thinking && left.piVersion === right.piVersion && left.runtimeId === right.runtimeId && left.taskDigest === right.taskDigest && left.budget.wallSeconds === right.budget.wallSeconds && left.budget.toolPolicy === right.budget.toolPolicy;
}

function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
	return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function ratio(left, right) {
	return right === 0 ? (left === 0 ? 0 : null) : (left - right) / right;
}

function aggregate(runs) {
	const passRate = runs.length === 0 ? 0 : runs.filter((run) => run.status === "passed" && run.verification.passed).length / runs.length;
	const metric = (name) => median(runs.map((run) => run.metrics[name]));
	return {
		count: runs.length,
		passRate,
		inputTokensIncludingCache: metric("inputTokensIncludingCache"),
		outputTokens: metric("outputTokens"),
		costUsd: metric("costUsd"),
		elapsedSeconds: metric("elapsedSeconds"),
		toolCalls: metric("toolCalls"),
		explorationCalls: metric("explorationCalls"),
		firstRelevantEvidenceSeconds: median(runs.map((run) => run.metrics.firstRelevantEvidenceSeconds ?? Number.POSITIVE_INFINITY)),
	};
}

function compareArms(runs, leftArm, rightArm) {
	const left = aggregate(runs.filter((run) => run.arm === leftArm));
	const right = aggregate(runs.filter((run) => run.arm === rightArm));
	return {
		leftArm,
		rightArm,
		leftPassRate: left.passRate,
		rightPassRate: right.passRate,
		verifierDelta: left.passRate - right.passRate,
		inputTokenDeltaRatio: ratio(left.inputTokensIncludingCache, right.inputTokensIncludingCache),
		elapsedDeltaRatio: ratio(left.elapsedSeconds, right.elapsedSeconds),
		costDeltaRatio: ratio(left.costUsd, right.costUsd),
		toolCallDeltaRatio: ratio(left.toolCalls, right.toolCalls),
		explorationDeltaRatio: ratio(left.explorationCalls, right.explorationCalls),
		left,
		right,
	};
}

function groupedRuns(runs, episodeId, attemptId) {
	return runs.filter((run) => run.episodeId === episodeId && (attemptId === undefined || run.attemptId === attemptId));
}

function calculateRecall(runs, episodeId) {
	const learned = runs.filter((run) => run.arm === "pi-xk-learned" && run.episodeId === episodeId);
	const exposed = learned.filter((run) => run.recall.relatedCandidateExposed);
	const relevant = learned.filter((run) => run.recall.relatedMemoryRead);
	const relevantAfterExposure = exposed.filter((run) => run.recall.relatedMemoryRead);
	return {
		attempts: learned.length,
		relevantRecallRate: learned.length === 0 ? 0 : relevant.length / learned.length,
		d1Rate: learned.length === 0 ? 0 : learned.filter((run) => run.recall.d1SearchCalls > 0).length / learned.length,
		d2Rate: learned.length === 0 ? 0 : learned.filter((run) => run.recall.d2ReadCalls > 0).length / learned.length,
		relevantD2Rate: learned.length === 0 ? 0 : relevant.filter((run) => run.recall.d2ReadCalls > 0).length / learned.length,
		candidateExposureRate: learned.length === 0 ? 0 : exposed.length / learned.length,
		candidateToReadRate: exposed.length === 0 ? 0 : relevantAfterExposure.length / exposed.length,
		relatedCandidateReadRate: learned.length === 0 ? 0 : relevantAfterExposure.length / learned.length,
		d1CandidateCountMedian: median(learned.map((run) => run.recall.d1CandidateCount)),
		taskPassRate: learned.length === 0 ? 0 : learned.filter((run) => run.verification.passed).length / learned.length,
	};
}

function calculateChangedRule(runs) {
	const changed = runs.filter((run) => run.arm === "pi-xk-learned" && run.episodeId === "changed-rule");
	const revised = changed.filter(
		(run) =>
			(run.recall.reviewAction === "revise" || run.recall.reviewAction === "supersede") &&
			run.recall.publishedReview === true,
	);
		return {
		attempts: changed.length,
		passRate: changed.length === 0 ? 0 : changed.filter((run) => run.verification.passed).length / changed.length,
		revisionRate: changed.length === 0 ? 0 : revised.length / changed.length,
			blindFollowRate: changed.length === 0 ? 0 : changed.filter((run) => run.verification.passed === false && run.recall.relatedMemoryRead && run.recall.reviewCalls === 0).length / changed.length,
			reviewPublicationRate: changed.length === 0 ? 0 : changed.filter((run) => run.recall.reviewPublication === "applied").length / changed.length,
			reviewFailureRate: changed.length === 0 ? 0 : changed.filter((run) => run.recall.reviewPublication === "failed").length / changed.length,
	};
}

function calculateUnrelated(runs) {
	const unrelated = runs.filter((run) => run.arm === "pi-xk-learned" && run.episodeId === "unrelated");
	return {
		attempts: unrelated.length,
		d1Rate: unrelated.length === 0 ? 0 : unrelated.filter((run) => run.recall.d1SearchCalls > 0).length / unrelated.length,
		candidateExposureRate: unrelated.length === 0 ? 0 : unrelated.filter((run) => run.recall.relatedCandidateExposed).length / unrelated.length,
		d1CandidateCountMedian: median(unrelated.map((run) => run.recall.d1CandidateCount)),
		passRate: unrelated.length === 0 ? 0 : unrelated.filter((run) => run.verification.passed).length / unrelated.length,
	};
}

function thresholdResult(id, actual, comparator, target) {
	const passed = comparator === ">=" ? actual >= target : actual <= target;
	return { id, actual, comparator, target, passed };
}

function assertSeedParity(runs) {
	for (const attemptId of new Set(runs.map((run) => run.attemptId))) {
		for (const episodeId of ["exact-reuse", "similar-transfer", "changed-rule", "unrelated"]) {
			const placebo = runs.find((run) => run.attemptId === attemptId && run.episodeId === episodeId && run.arm === "pi-xk-placebo");
			const learned = runs.find((run) => run.attemptId === attemptId && run.episodeId === episodeId && run.arm === "pi-xk-learned");
			if (!placebo || !learned) throw new Error(`Missing seed parity run for ${attemptId}/${episodeId}`);
			if (placebo.setup.seededMemories !== learned.setup.seededMemories || placebo.setup.seedUtf8Bytes !== learned.setup.seedUtf8Bytes) {
				throw new Error(`Placebo and learned Memory seed sizes are not matched for ${attemptId}/${episodeId}`);
			}
			if (placebo.setup.seededMemories === 0 || placebo.setup.captureVerified !== true || learned.setup.captureVerified !== true) {
				throw new Error(`Memory seed is not verified for ${attemptId}/${episodeId}`);
			}
		}
	}
}

export function evaluateMemoryTransferReport(planInput, reportInput) {
	const plan = validateMemoryTransferPlan(planInput);
	assertNoSensitiveFields(reportInput);
	exactKeys(reportInput, REPORT_KEYS, "report");
	if (!REPORT_SCHEMAS.has(reportInput.schema)) throw new Error("Memory transfer report schema is invalid");
	if (!REPORT_KINDS.has(reportInput.reportKind)) throw new Error(`Unsupported Memory transfer report kind: ${reportInput.reportKind}`);
	nonEmptyString(reportInput.generatedAt, "report.generatedAt");
	if (Number.isNaN(Date.parse(reportInput.generatedAt))) throw new Error("report.generatedAt must be an ISO timestamp");
	if (reportInput.planDigest !== memoryTransferPlanDigest(planInput)) throw new Error("Memory transfer report plan digest does not match the plan");
	if (!Array.isArray(reportInput.runs) || reportInput.runs.length === 0) throw new Error("Memory transfer report runs must not be empty");
	const runs = reportInput.runs.map((run) => parseRun(run, plan, reportInput.reportKind, reportInput.schema));
	const observabilityComplete = reportInput.schema === REPORT_SCHEMA;
	if (new Set(runs.map((run) => run.id)).size !== runs.length) throw new Error("Memory transfer run IDs must be unique");
	const expectedKeys = new Set(plan.arms.map((arm) => arm.id));
	const expectedEpisodes = new Set(plan.episodes.map((episode) => episode.id));
	const attemptIds = [...new Set(runs.map((run) => run.attemptId))].sort();
	for (const attemptId of attemptIds) {
		const attemptRuns = runs.filter((run) => run.attemptId === attemptId);
		for (const episodeId of expectedEpisodes) {
			const episodeRuns = attemptRuns.filter((run) => run.episodeId === episodeId);
			if (episodeRuns.length !== expectedKeys.size) throw new Error(`${attemptId}/${episodeId} requires exactly one run per arm`);
			if (new Set(episodeRuns.map((run) => run.arm)).size !== expectedKeys.size) throw new Error(`${attemptId}/${episodeId} has duplicate arm runs`);
			const first = episodeRuns[0];
			for (const candidate of episodeRuns.slice(1)) {
				if (!controlsMatch(first.control, candidate.control)) throw new Error(`${attemptId}/${episodeId} does not have identical controls`);
			}
		}
	}
	assertSeedParity(runs);
	const complete = attemptIds.length >= plan.minimumAttempts && attemptIds.every((attemptId) => {
		const attemptRuns = runs.filter((run) => run.attemptId === attemptId);
		return attemptRuns.length === plan.arms.length * plan.episodes.length;
	});
	const exactRuns = groupedRuns(runs, "exact-reuse");
	const similarRuns = groupedRuns(runs, "similar-transfer");
	const changedRuns = groupedRuns(runs, "changed-rule");
	const unrelatedRuns = groupedRuns(runs, "unrelated");
	const retention = {
		exactReuse: calculateRecall(runs, "exact-reuse"),
		similarTransfer: calculateRecall(runs, "similar-transfer"),
		changedRule: calculateChangedRule(runs),
		unrelated: calculateUnrelated(runs),
	};
	const comparisons = {
		exactReuse: {
			learnedVsPlacebo: compareArms(exactRuns, "pi-xk-learned", "pi-xk-placebo"),
			learnedVsMemoryOff: compareArms(exactRuns, "pi-xk-learned", "pi-xk-memory-off"),
			learnedVsNative: compareArms(exactRuns, "pi-xk-learned", "pi-native"),
			learningToLearned: compareArms(
				runs.filter((run) => run.arm === "pi-xk-learned" && ["learning", "exact-reuse"].includes(run.episodeId)).map((run) => ({ ...run, arm: run.episodeId === "exact-reuse" ? "pi-xk-learned-exact" : "pi-xk-learned-learning" })),
				"pi-xk-learned-exact",
				"pi-xk-learned-learning",
			),
		},
		similarTransfer: {
			learnedVsPlacebo: compareArms(similarRuns, "pi-xk-learned", "pi-xk-placebo"),
			learnedVsMemoryOff: compareArms(similarRuns, "pi-xk-learned", "pi-xk-memory-off"),
			learnedVsNative: compareArms(similarRuns, "pi-xk-learned", "pi-native"),
		},
		changedRule: {
			learnedVsPlacebo: compareArms(changedRuns, "pi-xk-learned", "pi-xk-placebo"),
		},
		unrelated: {
			learnedVsPlacebo: compareArms(unrelatedRuns, "pi-xk-learned", "pi-xk-placebo"),
		},
	};
	const effects = {
		sameTask: {
			retention: retention.exactReuse,
			learnedPassRate: comparisons.exactReuse.learnedVsPlacebo.leftPassRate,
			placeboPassRate: comparisons.exactReuse.learnedVsPlacebo.rightPassRate,
			memoryOffPassRate: comparisons.exactReuse.learnedVsMemoryOff.rightPassRate,
			verifierDeltaVsPlacebo: comparisons.exactReuse.learnedVsPlacebo.verifierDelta,
			inputTokenDeltaRatioVsPlacebo: comparisons.exactReuse.learnedVsPlacebo.inputTokenDeltaRatio,
			elapsedDeltaRatioVsPlacebo: comparisons.exactReuse.learnedVsPlacebo.elapsedDeltaRatio,
			costDeltaRatioVsPlacebo: comparisons.exactReuse.learnedVsPlacebo.costDeltaRatio,
		},
		similarTask: {
			retention: retention.similarTransfer,
			learnedPassRate: comparisons.similarTransfer.learnedVsPlacebo.leftPassRate,
			placeboPassRate: comparisons.similarTransfer.learnedVsPlacebo.rightPassRate,
			memoryOffPassRate: comparisons.similarTransfer.learnedVsMemoryOff.rightPassRate,
			verifierDeltaVsPlacebo: comparisons.similarTransfer.learnedVsPlacebo.verifierDelta,
			inputTokenDeltaRatioVsPlacebo: comparisons.similarTransfer.learnedVsPlacebo.inputTokenDeltaRatio,
			elapsedDeltaRatioVsPlacebo: comparisons.similarTransfer.learnedVsPlacebo.elapsedDeltaRatio,
			costDeltaRatioVsPlacebo: comparisons.similarTransfer.learnedVsPlacebo.costDeltaRatio,
		},
	};
	const exactEfficiency = comparisons.exactReuse.learningToLearned.inputTokenDeltaRatio;
	const recallThresholds = plan.thresholds;
	const thresholds = [
		thresholdResult("coverage", complete ? 1 : 0, ">=", 1),
		thresholdResult("report-observability", observabilityComplete ? 1 : 0, ">=", 1),
		thresholdResult("exact-recall-rate", retention.exactReuse.relevantRecallRate, ">=", recallThresholds.exactRecallRateMin),
		thresholdResult("similar-recall-rate", retention.similarTransfer.relevantRecallRate, ">=", recallThresholds.similarRecallRateMin),
		thresholdResult("changed-rule-pass-rate", retention.changedRule.passRate, ">=", recallThresholds.changedRulePassRateMin),
		thresholdResult("changed-rule-revision-rate", retention.changedRule.revisionRate, ">=", recallThresholds.changedRuleRevisionRateMin),
		thresholdResult("unrelated-d1-rate", retention.unrelated.d1Rate, "<=", recallThresholds.unrelatedD1RateMax),
		thresholdResult("exact-verifier-delta", comparisons.exactReuse.learnedVsPlacebo.verifierDelta, ">=", recallThresholds.exactVerifierDeltaMin),
		thresholdResult("similar-verifier-delta", comparisons.similarTransfer.learnedVsPlacebo.verifierDelta, ">=", recallThresholds.similarVerifierDeltaMin),
		thresholdResult("exact-learning-input-gain", exactEfficiency ?? Number.NEGATIVE_INFINITY, "<=", -recallThresholds.exactEfficiencyGainMin),
		thresholdResult(
			"recall-overhead",
			Math.max(
				comparisons.exactReuse.learnedVsPlacebo.inputTokenDeltaRatio ?? Number.POSITIVE_INFINITY,
				comparisons.exactReuse.learnedVsPlacebo.elapsedDeltaRatio ?? Number.POSITIVE_INFINITY,
			),
			"<=",
			recallThresholds.medianOverheadMax,
		),
	];
	return {
		schema: SUMMARY_SCHEMA,
		coverage: { attempts: attemptIds.length, minimumAttempts: plan.minimumAttempts, complete },
		retention,
		effects,
		comparisons,
		thresholds,
		claimReady: thresholds.every((threshold) => threshold.passed),
		limitations: [
			"Learned and placebo Memory are Host-seeded from independently verified learning output; this lane measures retention and transfer, not automatic capture quality.",
			"A real-provider result is not a public benchmark leaderboard score and requires the registered attempt count before a general claim.",
			...(observabilityComplete
				? []
				: ["Legacy v1 reports do not contain structured D1 candidate exposure or reliable settled review publication evidence and cannot support a claim."]),
		],
	};
}

function usage() {
	console.log("Usage: node scripts/evaluate-pi-xk-memory-transfer.mjs --plan <path> --report <path> [--format json|markdown]");
}

function parseArgs(argv) {
	let plan;
	let report;
	let format = "json";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--plan") plan = resolve(argv[++index]);
		else if (argument === "--report") report = resolve(argv[++index]);
		else if (argument === "--format") format = argv[++index];
		else if (argument === "--help" || argument === "-h") return { help: true };
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!plan || !report) throw new Error("--plan and --report are required");
	if (!new Set(["json", "markdown"]).has(format)) throw new Error("--format must be json or markdown");
	return { help: false, plan, report, format };
}

function renderMarkdown(summary) {
	const lines = [
		"# Pi-XK Memory transfer evaluation",
		"",
		`- Claim ready: ${summary.claimReady ? "yes" : "no"}.`,
		`- Attempts: ${summary.coverage.attempts}/${summary.coverage.minimumAttempts}; complete=${summary.coverage.complete}.`,
			`- Exact reuse relevant D2: ${(summary.retention.exactReuse.relevantRecallRate * 100).toFixed(1)}%; similar transfer relevant D2: ${(summary.retention.similarTransfer.relevantRecallRate * 100).toFixed(1)}%.`,
			`- Same-task candidate exposure/read: ${(summary.effects.sameTask.retention.candidateExposureRate * 100).toFixed(1)}% / ${(summary.effects.sameTask.retention.relatedCandidateReadRate * 100).toFixed(1)}%; task pass delta vs placebo: ${(summary.effects.sameTask.verifierDeltaVsPlacebo * 100).toFixed(1)}%.`,
			`- Similar-task candidate exposure/read: ${(summary.effects.similarTask.retention.candidateExposureRate * 100).toFixed(1)}% / ${(summary.effects.similarTask.retention.relatedCandidateReadRate * 100).toFixed(1)}%; task pass delta vs placebo: ${(summary.effects.similarTask.verifierDeltaVsPlacebo * 100).toFixed(1)}%.`,
		`- Changed rule pass/revision: ${(summary.retention.changedRule.passRate * 100).toFixed(1)}% / ${(summary.retention.changedRule.revisionRate * 100).toFixed(1)}%.`,
		`- Unrelated D1 rate: ${(summary.retention.unrelated.d1Rate * 100).toFixed(1)}%.`,
		"",
		"## Thresholds",
	];
	for (const threshold of summary.thresholds) {
		lines.push(`- ${threshold.id}: ${threshold.actual} ${threshold.comparator} ${threshold.target} (${threshold.passed ? "pass" : "fail"}).`);
	}
	lines.push("", "## Boundary");
	for (const limitation of summary.limitations) lines.push(`- ${limitation}`);
	return `${lines.join("\n")}\n`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const plan = JSON.parse(await readFile(options.plan, "utf8"));
	const report = JSON.parse(await readFile(options.report, "utf8"));
	const summary = evaluateMemoryTransferReport(plan, report);
	process.stdout.write(options.format === "markdown" ? renderMarkdown(summary) : `${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
