import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../aider-polyglot-probe.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

assert.equal(manifest.schema, "pi-xk.harbor-aider-polyglot-probe.v1");
assert.deepEqual(manifest.harness, {
	name: "Harbor",
	repository: "https://github.com/harbor-framework/harbor.git",
	commit: "459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc",
	version: "0.20.0",
});
assert.match(manifest.upstream.commit, /^[0-9a-f]{40}$/);
assert.deepEqual(manifest.agentAllowedHosts, ["api.deepseek.com"]);
assert.equal(manifest.agentTimeoutSeconds, 900);
assert.equal(manifest.networkPolicyProfile, "portable-loopback-v1");
assert.equal(manifest.tasks.length, 5);
assert.equal(new Set(manifest.tasks.map((task) => task.id)).size, 5);
assert.equal(new Set(manifest.tasks.map((task) => task.language)).size, 5);
for (const task of manifest.tasks) {
	assert.match(task.upstreamPath, /^[a-z]+\/exercises\/practice\/[a-z0-9-]+$/);
	assert.ok(task.instructionFiles.length > 0);
	assert.ok(task.oracleCopies.length > 0);
	assert.ok(task.verifierCopies.length > 0);
	for (const copy of [...task.oracleCopies, ...task.verifierCopies]) {
		assert.match(copy.from, /^[A-Za-z0-9._/-]+$/);
		assert.match(copy.to, /^[A-Za-z0-9._/-]+$/);
	}
	assert.match(task.testCommand, /\S/);
}

const cppTask = manifest.tasks.find((task) => task.language === "cpp");
assert.ok(cppTask);
assert.match(cppTask.testCommand, /pi-xk-clock-source\/clock/u);
assert.match(cppTask.testCommand, /pi-xk-clock-build\/clock/u);
