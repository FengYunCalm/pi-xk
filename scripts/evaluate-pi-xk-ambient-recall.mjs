import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	DEFAULT_AMBIENT_RECALL_BUDGET,
	validateMemoryReconstructionTraceV1,
} from "../packages/pi-xk-core/src/index.ts";

const FIXTURE_SCHEMA = "pi-xk.ambient-recall-golden.v1";
const KNOWLEDGE_ACTIONS = new Set([
	"memory_search",
	"memory_read",
	"memory_evidence",
	"skill_search",
	"skill_read",
]);

function digest(value) {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertFixture(fixture) {
	if (fixture?.schema !== FIXTURE_SCHEMA || !Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
		throw new Error("unsupported or incomplete Ambient Recall golden fixture");
	}
	const ids = fixture.scenarios.map((scenario) => scenario.id);
	if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
		throw new Error("Ambient Recall scenario IDs must be unique strings");
	}
}

function evaluateScenario(scenario) {
	const findings = [];
	const usage = {
		totalKnowledgeActions: 0,
		memoryActions: 0,
		memorySearchCalls: 0,
		uniqueMemoryReads: 0,
		evidenceReads: 0,
		skillCandidateActions: 0,
	};
	const readMemories = new Set();
	const readEvidence = new Set();
	let memorySearches = 0;
	let skillSearches = 0;
	let knowledgeActions = 0;
	let semanticReviews = 0;

	for (const action of scenario.actions) {
		if (!action || typeof action.type !== "string") {
			findings.push({ category: "invalid_action" });
			continue;
		}
		if (KNOWLEDGE_ACTIONS.has(action.type)) {
			knowledgeActions += 1;
			usage.totalKnowledgeActions += 1;
		}
		switch (action.type) {
			case "memory_search":
				usage.memoryActions += 1;
				usage.memorySearchCalls += 1;
				memorySearches += 1;
				break;
			case "memory_read": {
				usage.memoryActions += 1;
				if (memorySearches === 0) findings.push({ category: "d2_before_d1" });
				for (const memoryId of action.memoryIds ?? []) readMemories.add(memoryId);
				break;
			}
			case "memory_evidence":
				usage.memoryActions += 1;
				if (!readMemories.has(action.memoryId)) findings.push({ category: "d3_before_d2" });
				for (const evidenceId of action.evidenceIds ?? []) readEvidence.add(evidenceId);
				break;
			case "memory_review":
				semanticReviews += action.mode === "keep" ? 0 : 1;
				for (const memoryId of action.sourceMemoryIds ?? []) {
					if (!readMemories.has(memoryId)) findings.push({ category: "review_without_d2", memoryId });
				}
				break;
			case "skill_search":
				usage.skillCandidateActions += 1;
				skillSearches += 1;
				break;
			case "skill_read":
				usage.skillCandidateActions += 1;
				if (skillSearches === 0) findings.push({ category: "skill_d2_before_d1" });
				break;
			case "skill_review":
				semanticReviews += action.mode === "keep" ? 0 : 1;
				break;
			default:
				findings.push({ category: "unknown_action", action: action.type });
		}
	}
	usage.uniqueMemoryReads = readMemories.size;
	usage.evidenceReads = readEvidence.size;

	if (!scenario.recallExpected && knowledgeActions > 0) findings.push({ category: "unnecessary_recall" });
	if (scenario.recallExpected && scenario.candidateAvailable && memorySearches + skillSearches === 0) {
		findings.push({ category: "missed_recall" });
	}
	if (scenario.outcome !== "succeeded" && semanticReviews > 0 && scenario.semanticPublication === true) {
		findings.push({ category: "failed_run_publication" });
	}
	if (scenario.outcome === "succeeded" && semanticReviews > 0 && scenario.semanticPublication !== true) {
		findings.push({ category: "missing_settled_publication" });
	}

	const trace = {
		schema: "pi-xk.memory-reconstruction-trace.v1",
		runId: `run_${scenario.id}`,
		sessionId: "session_ambient_evaluator",
		startedAt: "2026-08-03T00:00:00.000Z",
		settledAt: "2026-08-03T00:00:01.000Z",
		queryDigests: memorySearches + skillSearches > 0 ? [digest(scenario.id)] : [],
		candidateIds: [...readMemories],
		readRevisions: [...readMemories].map((memoryId) => ({ memoryId, revision: 1 })),
		evidenceIds: [...readEvidence],
		decisions: scenario.actions
			.filter((action) => action.type === "memory_review")
			.map((action, index) => action.decisionId ?? `review_${scenario.id}_${index}`),
		budgetUsage: usage,
		stopReason: scenario.stopReason,
		outcome: scenario.outcome,
	};
	let budgetAccepted = true;
	try {
		validateMemoryReconstructionTraceV1(trace);
	} catch {
		budgetAccepted = false;
	}
	if (budgetAccepted !== scenario.budgetAccepted) {
		findings.push({ category: "budget_expectation_mismatch", expected: scenario.budgetAccepted, actual: budgetAccepted });
	}
	return { id: scenario.id, usage, budgetAccepted, findings };
}

export function evaluateAmbientRecallFixture(fixture) {
	assertFixture(fixture);
	const scenarios = fixture.scenarios.map(evaluateScenario);
	const findings = scenarios.flatMap((scenario) =>
		scenario.findings.map((finding) => ({ scenarioId: scenario.id, ...finding })),
	);
	return {
		schema: fixture.schema,
		budget: DEFAULT_AMBIENT_RECALL_BUDGET,
		scenarios: scenarios.length,
		accepted: scenarios.filter((scenario) => scenario.budgetAccepted).length,
		rejected: scenarios.filter((scenario) => !scenario.budgetAccepted).length,
		findings,
	};
}

async function main() {
	const fixturePath = process.argv[2];
	if (!fixturePath) {
		throw new Error("usage: node --import tsx scripts/evaluate-pi-xk-ambient-recall.mjs <fixture.json>");
	}
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
	const report = evaluateAmbientRecallFixture(fixture);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
