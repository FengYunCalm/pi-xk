import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWorkflowTestEnvironment } from "../../../scripts/run-pi-xk-workflow-validation.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "run-pi-xk-workflow-validation.mjs");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-workflow-validation-test-"),
);

assert.deepEqual(
	buildWorkflowTestEnvironment("/isolated/pi-xk-temp", {
		PATH: "/usr/bin",
		TMP: "/ambient/tmp",
		TEMP: "/ambient/temp",
		TMPDIR: "/ambient/tmpdir",
	}),
	{
		PATH: "/usr/bin",
		TMP: "/isolated/pi-xk-temp",
		TEMP: "/isolated/pi-xk-temp",
		TMPDIR: "/isolated/pi-xk-temp",
	},
);

try {
	const output = join(temporaryRoot, "output");
	const poisonedAmbientTemp = join(temporaryRoot, "ambient-temp-does-not-exist");
	const result = spawnSync(
		process.execPath,
		[scriptPath, "--out", output, "--scenario", "goal-contract-continuity"],
		{
			cwd: workspaceRoot,
			encoding: "utf8",
			env: {
				...process.env,
				TMP: poisonedAmbientTemp,
				TEMP: poisonedAmbientTemp,
				TMPDIR: poisonedAmbientTemp,
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(await readFile(join(output, "capability-report.json"), "utf8"));
	assert.equal(report.schema, "pi-xk.capability-report.v1");
	assert.equal(report.reportKind, "workflow-validation");
	assert.deepEqual(report.runs.map((run) => run.scenarioId), ["goal-contract-continuity"]);
	assert.equal(report.runs[0].execution, "faux-provider");
	assert.equal(report.runs[0].status, "passed");
	assert.equal(report.runs[0].verification.independent, false);

	const unsafe = spawnSync(process.execPath, [scriptPath, "--out", workspaceRoot], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	assert.notEqual(unsafe.status, 0);
	assert.match(unsafe.stderr, /unsafe workflow output directory/u);
	assert.equal(existsSync(join(workspaceRoot, "failure.json")), false);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
