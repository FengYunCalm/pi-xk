import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const FIXTURE_SCHEMA = "pi-xk.skill-evolution-golden.v1";

function assertFixture(fixture) {
	if (fixture?.schema !== FIXTURE_SCHEMA || !Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
		throw new Error("unsupported or incomplete Skill evolution golden fixture");
	}
	const ids = fixture.scenarios.map((scenario) => scenario.id);
	if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
		throw new Error("Skill evolution scenario IDs must be unique strings");
	}
}

function initialState(input = {}) {
	return {
		revision: input.revision ?? 0,
		active: input.active ?? false,
		candidate: input.candidate ?? false,
		needsReview: input.needsReview ?? false,
		promoted: input.promoted ?? false,
		successfulUses: input.successfulUses ?? 0,
		failedUsesSinceRevision: input.failedUsesSinceRevision ?? 0,
		originProject: input.originProject ?? "project_origin",
		successProjects: new Set(input.successProjects ?? []),
		rejectedModelLifecycleActions: input.rejectedModelLifecycleActions ?? 0,
	};
}

function applyEvent(state, event, findings) {
	switch (event.type) {
		case "create":
			if (state.revision !== 0) {
				findings.push({ category: "duplicate_create" });
				return;
			}
			if (event.settled === true && event.evidence === true && event.bundleValid === true) {
				state.revision = 1;
				state.active = true;
				state.candidate = false;
			} else {
				state.candidate = true;
			}
			return;
		case "success_use":
			state.successfulUses += 1;
			state.successProjects.add(event.projectId);
			return;
		case "failure_use":
			state.failedUsesSinceRevision += 1;
			if (state.failedUsesSinceRevision >= 2) {
				state.needsReview = true;
				state.active = false;
			}
			return;
		case "revise":
			if (event.settled !== true || event.evidence !== true || event.actualUse !== true || state.revision === 0) {
				findings.push({ category: "unsupported_revision" });
				return;
			}
			state.revision += 1;
			state.active = true;
			state.candidate = false;
			state.needsReview = false;
			state.failedUsesSinceRevision = 0;
			return;
		case "promote": {
			const outsideOrigin = [...state.successProjects].some((projectId) => projectId !== state.originProject);
			if (
				state.candidate &&
				state.successfulUses >= 3 &&
				state.successProjects.size >= 2 &&
				outsideOrigin &&
				state.failedUsesSinceRevision === 0
			) {
				state.promoted = true;
				state.active = true;
				state.candidate = false;
				state.revision = Math.max(1, state.revision);
			}
			return;
		}
		case "model_archive":
		case "model_purge":
			state.rejectedModelLifecycleActions += 1;
			return;
		default:
			findings.push({ category: "unknown_event", eventType: event.type });
	}
}

function comparableState(state) {
	return {
		revision: state.revision,
		active: state.active,
		candidate: state.candidate,
		needsReview: state.needsReview,
		promoted: state.promoted,
		successfulUses: state.successfulUses,
		failedUsesSinceRevision: state.failedUsesSinceRevision,
		successProjects: [...state.successProjects].sort(),
		rejectedModelLifecycleActions: state.rejectedModelLifecycleActions,
	};
}

function evaluateScenario(scenario) {
	const findings = [];
	const state = initialState(scenario.initial);
	for (const event of scenario.events) applyEvent(state, event, findings);
	const actual = comparableState(state);
	for (const [field, expected] of Object.entries(scenario.expected)) {
		if (JSON.stringify(actual[field]) !== JSON.stringify(expected)) {
			findings.push({ category: "state_mismatch", field, expected, actual: actual[field] });
		}
	}
	return { id: scenario.id, state: actual, findings };
}

export function evaluateSkillEvolutionFixture(fixture) {
	assertFixture(fixture);
	const scenarios = fixture.scenarios.map(evaluateScenario);
	const findings = scenarios.flatMap((scenario) =>
		scenario.findings.map((finding) => ({ scenarioId: scenario.id, ...finding })),
	);
	return {
		schema: fixture.schema,
		scenarios: scenarios.length,
		active: scenarios.filter((scenario) => scenario.state.active).length,
		promoted: scenarios.filter((scenario) => scenario.state.promoted).length,
		needsReview: scenarios.filter((scenario) => scenario.state.needsReview).length,
		findings,
	};
}

async function main() {
	const fixturePath = process.argv[2];
	if (!fixturePath) {
		throw new Error("usage: node scripts/evaluate-pi-xk-skill-evolution.mjs <fixture.json>");
	}
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
	const report = evaluateSkillEvolutionFixture(fixture);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
