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
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--platform-smoke")) {
	throw new Error(`Unknown argument: ${args.find((arg) => arg !== "--platform-smoke")}`);
}
const platformSmoke = args.includes("--platform-smoke");
const buildCommands = [
	["--workspace", "@earendil-works/pi-tui", "run", "build"],
	["exec", "--workspace", "@earendil-works/pi-ai", "--", "tsgo", "-p", "tsconfig.build.json"],
	["exec", "--workspace", "@earendil-works/pi-ai", "--", "shx", "rm", "-rf", "dist/providers/data"],
	["exec", "--workspace", "@earendil-works/pi-ai", "--", "shx", "cp", "-r", "src/providers/data", "dist/providers/data"],
	["--workspace", "@earendil-works/pi-agent-core", "run", "build"],
	["--workspace", "@earendil-works/pi-coding-agent", "run", "build"],
	["--workspace", "pi-xk-core", "run", "build"],
	["--workspace", "pi-xk-extension", "run", "build"],
];
const commands = platformSmoke
	? [
			...buildCommands,
			[
				"--workspace",
				"pi-xk-core",
				"run",
				"test",
				"--",
				"test/sync-directory.test.ts",
				"test/artifact-store.test.ts",
				"test/goal-store.test.ts",
				"test/task-store.test.ts",
				"test/session-chain-store.test.ts",
			],
			[
				"--workspace",
				"@earendil-works/pi-coding-agent",
				"run",
				"test",
				"--",
				"test/session-manager/file-operations.test.ts",
				"test/suite/pi-xk-package-install.test.ts",
				"test/suite/pi-xk-github-release.test.ts",
			],
		]
	: [
			...buildCommands,
	[
		"--workspace",
		"pi-xk-core",
		"run",
		"test",
		"--",
		"test/goal-store.test.ts",
		"test/goal-contract-v2.test.ts",
		"test/goal-contract-v3.test.ts",
		"test/goal-lifecycle.test.ts",
		"test/artifact-store.test.ts",
		"test/goal-read-model.test.ts",
		"test/task-contract.test.ts",
		"test/task-store.test.ts",
		"test/task-read-model.test.ts",
		"test/session-chain-contract.test.ts",
		"test/session-chain-store.test.ts",
		"test/session-chain-read-model.test.ts",
		"test/session-chain-summary-v2.test.ts",
		"test/sync-directory.test.ts",
	],
	[
		"--workspace",
		"@earendil-works/pi-coding-agent",
		"run",
		"test",
		"--",
		"test/compaction.test.ts",
		"test/compaction-recovery.test.ts",
		"test/suite/agent-session-compaction.test.ts",
		"test/suite/pi-xk-session-link.test.ts",
		"test/suite/pi-xk-checkpoint-bridge.test.ts",
		"test/suite/pi-xk-goal-extension.test.ts",
		"test/suite/pi-xk-session-chain-controller.test.ts",
		"test/suite/pi-xk-session-chain-extension.test.ts",
		"test/suite/agent-session-rollover.test.ts",
		"test/suite/agent-session-queue.test.ts",
		"test/suite/pi-xk-task-runner.test.ts",
		"test/suite/pi-xk-task-extension.test.ts",
		"test/suite/pi-xk-package-install.test.ts",
		"test/suite/pi-xk-github-release.test.ts",
		"test/suite/pi-xk-session-chain-summary-quality.test.ts",
	],
		];

for (const args of commands) {
	const result = spawnSync(npmCommand, args, {
		cwd: workspaceRoot,
		stdio: "inherit",
		env: { ...process.env, TEMP: testTempDir, TMP: testTempDir, TMPDIR: testTempDir },
		shell: process.platform === "win32",
		windowsHide: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
