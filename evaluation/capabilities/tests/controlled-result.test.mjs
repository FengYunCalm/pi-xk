import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const resultRoot = join(workspaceRoot, "evaluation", "capabilities", "results", "2026-08-06");
const reportNames = [
	"public-evaluation.json",
	"workflow-validation.json",
	"workflow-smoke-chain-memory.json",
	"workflow-smoke-goal-task.json",
	"workflow-smoke-skill.json",
];
const evaluator = spawnSync(
	process.execPath,
	[
		join(workspaceRoot, "scripts", "evaluate-pi-xk-capabilities.mjs"),
		"--matrix",
		join(workspaceRoot, "evaluation", "capabilities", "capability-matrix.json"),
		...reportNames.flatMap((name) => ["--report", join(resultRoot, name)]),
		"--format",
		"json",
	],
	{ cwd: workspaceRoot, encoding: "utf8" },
);
assert.equal(evaluator.status, 0, evaluator.stderr);
const generated = JSON.parse(evaluator.stdout);
const checkedIn = JSON.parse(await readFile(join(resultRoot, "summary.json"), "utf8"));
assert.deepEqual(checkedIn, generated);
assert.deepEqual(generated.statistics.publicParity, {
	comparisons: 5,
	piXkAdvantages: 0,
	piNativeAdvantages: 0,
	ties: 5,
});
assert.deepEqual(generated.statistics.workflow, {
	runs: 15,
	passed: 15,
	failed: 0,
	inconclusive: 0,
	other: 0,
});
assert.equal(generated.coverage.publicParity[0].sufficient, true);
assert.equal(generated.coverage.workflow.every((entry) => entry.covered), true);

const resultFiles = [
	...reportNames,
	"workflow-smoke-chain-memory.diagnostics.json",
	"workflow-smoke-goal-task.diagnostics.json",
	"workflow-smoke-skill.diagnostics.json",
	"summary.json",
];
for (const name of resultFiles) {
	const content = await readFile(join(resultRoot, name), "utf8");
	assert.doesNotMatch(content, /"sk-[A-Za-z0-9_-]{8,}/u);
}

const goalTaskDiagnostics = JSON.parse(
	await readFile(join(resultRoot, "workflow-smoke-goal-task.diagnostics.json"), "utf8"),
);
assert.equal(Object.values(goalTaskDiagnostics.scenarios[0].checks).every(Boolean), true);
const skillDiagnostics = JSON.parse(await readFile(join(resultRoot, "workflow-smoke-skill.diagnostics.json"), "utf8"));
const skillChecks = skillDiagnostics.scenarios[0].checks;
assert.equal(
	Object.entries(skillChecks)
		.filter(([key]) => key !== "skillDoctorDiagnosticCodes")
		.every(([, value]) => value === true),
	true,
);
assert.deepEqual(skillChecks.skillDoctorDiagnosticCodes, []);
