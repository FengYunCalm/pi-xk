import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validatePlan } from "../../../scripts/validate-pi-xk-public-parity-plan.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const plan = JSON.parse(
	await readFile(`${workspaceRoot}/evaluation/capabilities/public-parity-plan.json`, "utf8"),
);
const probe = JSON.parse(await readFile(`${workspaceRoot}/evaluation/harbor/aider-polyglot-probe.json`, "utf8"));

const normalized = validatePlan(plan, probe);
assert.equal(normalized.pairs.length, 5);
assert.equal(normalized.controls.model, "deepseek-chat");
assert.equal(normalized.controls.networkPolicyProfile, "portable-loopback-v1");
assert.equal(normalized.controls.agentSetupSeconds, 900);
assert.equal(normalized.harness.version, "0.20.0");
assert.equal(normalized.harness.commit, "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc");
assert.deepEqual(
	normalized.pairs.map((pair) => pair.taskId),
	probe.tasks.map((task) => task.id),
);

const duplicateTask = structuredClone(plan);
duplicateTask.pairs[1].taskId = duplicateTask.pairs[0].taskId;
assert.throws(() => validatePlan(duplicateTask, probe), /exactly once/u);

const nonAlternatingOrder = structuredClone(plan);
nonAlternatingOrder.pairs[1].agentOrder = ["pi-native", "pi-xk"];
assert.throws(() => validatePlan(nonAlternatingOrder, probe), /alternate/u);

const unsupportedRetry = structuredClone(plan);
unsupportedRetry.retryPolicy = "retry-one-side";
assert.throws(() => validatePlan(unsupportedRetry, probe), /retryPolicy/u);

const mismatchedRuntimeBudget = structuredClone(probe);
mismatchedRuntimeBudget.agentTimeoutSeconds += 1;
assert.throws(() => validatePlan(plan, mismatchedRuntimeBudget), /wallSeconds/u);

const invalidSetupBudget = structuredClone(plan);
invalidSetupBudget.controls.agentSetupSeconds = 0;
assert.throws(() => validatePlan(invalidSetupBudget, probe), /agentSetupSeconds/u);

const mismatchedHarness = structuredClone(plan);
mismatchedHarness.harness.commit = "b".repeat(40);
assert.throws(() => validatePlan(mismatchedHarness, probe), /harness commit/u);

const mismatchedNetworkPolicy = structuredClone(plan);
mismatchedNetworkPolicy.controls.networkPolicyProfile = "different-profile";
assert.throws(() => validatePlan(mismatchedNetworkPolicy, probe), /network policy profile/u);
