import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(suiteDirectory, "../../../..");
const extensionPackageDirectory = join(workspaceRoot, "packages", "pi-xk-extension");
const runtimeCheckPath = join(workspaceRoot, "scripts", "check-pi-xk-runtime.mjs");
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function writeTestExecutable(path: string): Promise<void> {
	if (process.platform === "win32") {
		await copyFile(process.execPath, path);
		return;
	}
	await writeFile(path, "#!/bin/sh\nprintf 'fd 0.0.0\\n'\n", { mode: 0o700 });
	await chmod(path, 0o700);
}

function runRuntimeCheck(agentDirectory: string, path = join(agentDirectory, "empty-path")) {
	return spawnSync(process.execPath, [runtimeCheckPath], {
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDirectory,
			PI_OFFLINE: "1",
			PATH: path,
		},
	});
}

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("Pi-XK package installation", () => {
	it("persists a local package and auto-discovers its Goal extension after a cold restart", async () => {
		const rootDirectory = await createTemporaryDirectory("pi-xk-package-install-");
		const agentDirectory = join(rootDirectory, "agent");
		const projectDirectory = join(rootDirectory, "project");
		await mkdir(projectDirectory, { recursive: true });

		const installingSettings = SettingsManager.create(projectDirectory, agentDirectory, { projectTrusted: false });
		const packageManager = new DefaultPackageManager({
			cwd: projectDirectory,
			agentDir: agentDirectory,
			settingsManager: installingSettings,
		});
		await packageManager.installAndPersist(extensionPackageDirectory);

		const restartedSettings = SettingsManager.create(projectDirectory, agentDirectory, { projectTrusted: false });
		const configuredSource = restartedSettings.getGlobalSettings().packages?.[0];
		expect(typeof configuredSource).toBe("string");
		if (typeof configuredSource !== "string") throw new Error("Pi-XK package source must be a string");
		expect(resolve(agentDirectory, configuredSource)).toBe(extensionPackageDirectory);
		const resourceLoader = new DefaultResourceLoader({
			cwd: projectDirectory,
			agentDir: agentDirectory,
			settingsManager: restartedSettings,
			noContextFiles: true,
		});
		await resourceLoader.reload();

		const extensions = resourceLoader.getExtensions();
		expect(extensions.errors).toEqual([]);
		const goalExtension = extensions.extensions.find((extension) =>
			extension.path.endsWith(join("dist", "extension.js")),
		);
		expect(goalExtension?.commands.has("goal")).toBe(true);
	});

	it("fails offline preflight with actionable guidance when fd is unavailable", async () => {
		const rootDirectory = await createTemporaryDirectory("pi-xk-runtime-missing-");
		const result = runRuntimeCheck(join(rootDirectory, "agent"));

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("fd-find");
	});

	it("accepts Pi's managed fd binary without consulting PATH", async () => {
		const rootDirectory = await createTemporaryDirectory("pi-xk-runtime-managed-");
		const fdPath = join(rootDirectory, "agent", "bin", process.platform === "win32" ? "fd.exe" : "fd");
		await mkdir(dirname(fdPath), { recursive: true });
		await writeTestExecutable(fdPath);

		const result = runRuntimeCheck(join(rootDirectory, "agent"));

		expect(result.status).toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("Pi-XK runtime preflight passed");
	});

	it("accepts Ubuntu's fdfind command from PATH", async () => {
		const rootDirectory = await createTemporaryDirectory("pi-xk-runtime-fdfind-");
		const binDirectory = join(rootDirectory, "bin");
		const fdfindPath = join(binDirectory, process.platform === "win32" ? "fdfind.exe" : "fdfind");
		await mkdir(binDirectory, { recursive: true });
		await writeTestExecutable(fdfindPath);

		const result = runRuntimeCheck(join(rootDirectory, "agent"), binDirectory);

		expect(result.status).toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("fdfind");
	});
});
