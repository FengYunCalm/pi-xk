import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..");
const inheritedTempDir = tmpdir();
const testTempDir =
	process.platform === "linux" && inheritedTempDir.startsWith("/mnt/") && existsSync("/tmp")
		? "/tmp"
		: inheritedTempDir;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
	[
		"--workspace",
		"pi-xk-core",
		"run",
		"test",
		"--",
		"test/goal-store.test.ts",
		"test/goal-lifecycle.test.ts",
		"test/artifact-store.test.ts",
		"test/goal-read-model.test.ts",
	],
	[
		"--workspace",
		"@earendil-works/pi-coding-agent",
		"run",
		"test",
		"--",
		"test/suite/pi-xk-session-link.test.ts",
		"test/suite/pi-xk-checkpoint-bridge.test.ts",
		"test/suite/pi-xk-goal-extension.test.ts",
	],
];

for (const args of commands) {
	const result = spawnSync(npmCommand, args, {
		cwd: workspaceRoot,
		stdio: "inherit",
		env: { ...process.env, TEMP: testTempDir, TMP: testTempDir, TMPDIR: testTempDir },
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
