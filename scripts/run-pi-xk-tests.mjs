import { existsSync, readdirSync } from "node:fs";
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
const windowsPlatformSmokeOptions = process.platform === "win32" ? ["--maxWorkers=1", "--testTimeout=20000"] : [];
const aiSourceRoot = resolve(workspaceRoot, "packages/ai/src");
const aiProviderDataDir = resolve(aiSourceRoot, "providers/data");
const requiredAiProviderData = readdirSync(resolve(aiSourceRoot, "providers"), { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".models.ts"))
	.map((entry) => entry.name.replace(/\.models\.ts$/, ".json"));
const hasCompleteAiProviderData =
	existsSync(aiProviderDataDir) &&
	requiredAiProviderData.every((entry) => existsSync(resolve(aiProviderDataDir, entry)));
const aiBuildCommands = hasCompleteAiProviderData
	? [
			["exec", "--workspace", "@earendil-works/pi-ai", "--", "tsgo", "-p", "tsconfig.build.json"],
			["exec", "--workspace", "@earendil-works/pi-ai", "--", "shx", "rm", "-rf", "dist/providers/data"],
			["exec", "--workspace", "@earendil-works/pi-ai", "--", "shx", "cp", "-r", "src/providers/data", "dist/providers/data"],
		]
	: [["--workspace", "@earendil-works/pi-ai", "run", "build"]];
const buildCommands = [
	["--workspace", "@earendil-works/pi-tui", "run", "build"],
	...aiBuildCommands,
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
				"@earendil-works/pi-ai",
				"run",
				"test",
				"--",
				"test/generate-models.test.ts",
			],
			[
				"--workspace",
				"pi-xk-core",
				"run",
				"test",
				"--",
				...windowsPlatformSmokeOptions,
				"test/sync-directory.test.ts",
				"test/artifact-store.test.ts",
				"test/goal-store.test.ts",
				"test/task-store.test.ts",
				"test/session-chain-store.test.ts",
				"test/memory-contract.test.ts",
				"test/ambient-memory-contract.test.ts",
				"test/ambient-memory-store.test.ts",
				"test/memory-evidence.test.ts",
				"test/memory-freshness.test.ts",
				"test/memory-incremental-publication.test.ts",
				"test/memory-store.test.ts",
				"test/memory-index.test.ts",
				"test/memory-service.test.ts",
				"test/skill-contract.test.ts",
				"test/skill-index.test.ts",
				"test/skill-service.test.ts",
				"test/skill-store.test.ts",
			],
			[
				"--workspace",
				"@earendil-works/pi-coding-agent",
				"run",
				"test",
				"--",
				...windowsPlatformSmokeOptions,
				"test/session-manager/file-operations.test.ts",
				"test/suite/pi-xk-package-install.test.ts",
				"test/suite/pi-xk-github-release.test.ts",
				"test/suite/pi-xk-memory-extension.test.ts",
				"test/suite/pi-xk-ambient-effect.test.ts",
				"test/suite/pi-xk-memory-source-bridge.test.ts",
				"test/suite/pi-xk-skill-evolution.test.ts",
				"test/suite/pi-xk-skill-reload.test.ts",
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
		"test/memory-contract.test.ts",
		"test/ambient-memory-contract.test.ts",
		"test/ambient-memory-store.test.ts",
		"test/memory-evidence.test.ts",
		"test/memory-freshness.test.ts",
		"test/memory-incremental-publication.test.ts",
		"test/memory-store.test.ts",
		"test/memory-index.test.ts",
		"test/memory-service.test.ts",
		"test/skill-contract.test.ts",
		"test/skill-index.test.ts",
		"test/skill-service.test.ts",
		"test/skill-store.test.ts",
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
		"test/suite/pi-xk-memory-extension.test.ts",
		"test/suite/pi-xk-ambient-effect.test.ts",
		"test/suite/pi-xk-memory-source-bridge.test.ts",
		"test/suite/pi-xk-skill-evolution.test.ts",
		"test/suite/pi-xk-skill-reload.test.ts",
	],
		];

for (const args of commands) {
	const env = { ...process.env, TEMP: testTempDir, TMP: testTempDir, TMPDIR: testTempDir };
	if (platformSmoke) env.PI_XK_PLATFORM_SMOKE = "1";
	const result = spawnSync(npmCommand, args, {
		cwd: workspaceRoot,
		stdio: "inherit",
		env,
		shell: process.platform === "win32",
		windowsHide: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
