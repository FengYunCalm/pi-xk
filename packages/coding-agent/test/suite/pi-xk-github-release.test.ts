import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(suiteDirectory, "../../../..");
const buildScriptPath = join(workspaceRoot, "scripts", "build-pi-xk-binaries.sh");
const packagerPath = join(workspaceRoot, "scripts", "package-pi-xk-release.mjs");
const releaseNotesPath = join(workspaceRoot, "scripts", "release-notes.mjs");
const releaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "build-pi-xk-release.yml");
const modelCatalogWorkflowPath = join(workspaceRoot, ".github", "workflows", "publish-model-catalog.yml");
const binaryReleaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "build-binaries.yml");
const temporaryDirectories: string[] = [];
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

type ReleaseFixture = {
	binaryRoot: string;
	docsRoot: string;
	extensionRoot: string;
	releaseConfigPath: string;
};

async function createReleaseFixture(): Promise<ReleaseFixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-xk-github-release-"));
	temporaryDirectories.push(root);
	const binaryRoot = join(root, "binaries");
	const platformRoot = join(binaryRoot, "linux-x64");
	const extensionRoot = join(root, "extension");
	const coreRoot = join(extensionRoot, "node_modules", "pi-xk-core");
	const docsRoot = join(root, "docs");
	const releaseConfigPath = join(root, "pi-xk-release.json");

	await mkdir(join(extensionRoot, "dist"), { recursive: true });
	await mkdir(join(coreRoot, "dist"), { recursive: true });
	await mkdir(docsRoot, { recursive: true });
	await mkdir(platformRoot, { recursive: true });
	await writeFile(join(platformRoot, "pi"), "base pi binary\n");
	await writeFile(join(platformRoot, "pi-xk"), "pi-xk binary\n");
	await writeFile(join(extensionRoot, "dist", "extension.js"), "export default () => {};\n");
	await writeFile(join(extensionRoot, "package.json"), '{"name":"pi-xk-extension","private":true}\n');
	await writeFile(join(extensionRoot, "README.md"), "# Pi-XK extension\n");
	await writeFile(join(coreRoot, "dist", "index.js"), "export {};\n");
	await writeFile(join(coreRoot, "package.json"), '{"name":"pi-xk-core","private":true}\n');
	await writeFile(join(docsRoot, "README.md"), "# Pi-XK docs\n");
	await writeFile(releaseConfigPath, '{"schema":"pi-xk.release.v1","version":"0.1.0"}\n');

	return { binaryRoot, docsRoot, extensionRoot, releaseConfigPath };
}

function runPackager(fixture: ReleaseFixture, tag: string) {
	return spawnSync(
		process.execPath,
		[
			packagerPath,
			"--input",
			fixture.binaryRoot,
			"--platform",
			"linux-x64",
			"--release-config",
			fixture.releaseConfigPath,
			"--extension-root",
			fixture.extensionRoot,
			"--docs-root",
			fixture.docsRoot,
			"--tag",
			tag,
			"--source-sha",
			sourceCommit,
			"--pi-version",
			"0.80.10",
			"--stage-only",
		],
		{ encoding: "utf8" },
	);
}

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("Pi-XK GitHub release packaging", () => {
	it("uses a dedicated GitHub-only workflow without npm publication", async () => {
		const workflow = await readFile(releaseWorkflowPath, "utf8");
		const buildStepIndex = workflow.indexOf("- name: Build\n");
		const testStepIndex = workflow.indexOf("- name: Test\n");

		expect(workflow).toContain("pi-xk-v*");
		expect(buildStepIndex).toBeGreaterThan(-1);
		expect(testStepIndex).toBeGreaterThan(buildStepIndex);
		for (const platform of [
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"windows-arm64",
			"windows-x64",
		]) {
			expect(workflow).toContain(`pi-xk-${platform}`);
		}
		expect(workflow).toContain("PI-XK-RELEASE.json");
		expect(workflow).toContain("SHA256SUMS");
		expect(workflow).not.toContain("publish-npm");
		expect(workflow).not.toContain("npm publish");
	});

	it("keeps Pi-XK release tags intact when normalizing changelog links", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-release-notes-"));
		temporaryDirectories.push(root);
		const changelogPath = join(root, "CHANGELOG.md");
		await writeFile(changelogPath, "# Changelog\n\n## [0.1.0]\n\nSee [the guide](README.md).\n");
		const result = spawnSync(
			process.execPath,
			[
				releaseNotesPath,
				"extract",
				"--version",
				"0.1.0",
				"--tag",
				"pi-xk-v0.1.0",
				"--changelog",
				changelogPath,
				"--repo",
				"FengYunCalm/pi-xk",
				"--base-path",
				"docs/pi-xk",
			],
			{ encoding: "utf8" },
		);

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("https://github.com/FengYunCalm/pi-xk/blob/pi-xk-v0.1.0/docs/pi-xk/README.md");
	});

	it("pins artifact transfer actions to resolvable Node 24 revisions", async () => {
		const workflows = await Promise.all(
			[releaseWorkflowPath, modelCatalogWorkflowPath, binaryReleaseWorkflowPath].map((path) =>
				readFile(path, "utf8"),
			),
		);

		for (const workflow of workflows) {
			expect(workflow).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1");
			expect(workflow).toContain("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1");
		}
	});

	it("rejects a mismatched local release tag before replacing existing output", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-release-build-"));
		temporaryDirectories.push(root);
		const outputRoot = join(root, "output");
		const sentinelPath = join(outputRoot, "sentinel.txt");
		await mkdir(outputRoot);
		await writeFile(sentinelPath, "keep\n");
		const result = spawnSync(
			"bash",
			[
				buildScriptPath,
				"--skip-install",
				"--skip-deps",
				"--skip-build",
				"--platform",
				"linux-x64",
				"--out",
				outputRoot,
				"--tag",
				"pi-xk-v9.0.0",
				"--source-sha",
				sourceCommit,
			],
			{ cwd: workspaceRoot, encoding: "utf8" },
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("does not match Pi-XK release version 0.1.0");
		expect(await readFile(sentinelPath, "utf8")).toBe("keep\n");
	});

	it("stages a self-contained Pi-XK payload with independent version provenance", async () => {
		const fixture = await createReleaseFixture();
		const result = runPackager(fixture, "pi-xk-v0.1.0");

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		const platformRoot = join(fixture.binaryRoot, "linux-x64");
		expect(existsSync(join(platformRoot, "pi"))).toBe(true);
		expect(existsSync(join(platformRoot, "pi-xk"))).toBe(true);
		expect(existsSync(join(platformRoot, "pi-xk-extension", "dist", "extension.js"))).toBe(true);
		expect(existsSync(join(platformRoot, "pi-xk-extension", "node_modules", "pi-xk-core", "dist", "index.js"))).toBe(
			true,
		);
		expect(existsSync(join(platformRoot, "pi-xk-docs", "README.md"))).toBe(true);
		const manifest = JSON.parse(await readFile(join(platformRoot, "PI-XK-RELEASE.json"), "utf8")) as {
			schema: string;
			version: string;
			tag: string;
			sourceCommit: string;
			piBaseVersion: string;
			entrypoint: string;
			extension: string;
		};
		expect(manifest).toEqual({
			schema: "pi-xk.github-release.v1",
			version: "0.1.0",
			tag: "pi-xk-v0.1.0",
			sourceCommit,
			piBaseVersion: "0.80.10",
			entrypoint: "pi-xk",
			extension: "pi-xk-extension/dist/extension.js",
		});
	});

	it("rejects a tag that does not match the independent release version before staging", async () => {
		const fixture = await createReleaseFixture();
		const result = runPackager(fixture, "pi-xk-v0.2.0");

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("does not match Pi-XK release version 0.1.0");
		expect(existsSync(join(fixture.binaryRoot, "linux-x64", "PI-XK-RELEASE.json"))).toBe(false);
		expect(existsSync(join(fixture.binaryRoot, "linux-x64", "pi-xk-extension"))).toBe(false);
	});

	it("rejects an incomplete extension payload before staging", async () => {
		const fixture = await createReleaseFixture();
		await rm(join(fixture.extensionRoot, "node_modules", "pi-xk-core", "dist", "index.js"));
		const result = runPackager(fixture, "pi-xk-v0.1.0");

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain("pi-xk-core/dist/index.js");
		expect(existsSync(join(fixture.binaryRoot, "linux-x64", "PI-XK-RELEASE.json"))).toBe(false);
		expect(existsSync(join(fixture.binaryRoot, "linux-x64", "pi-xk-extension"))).toBe(false);
	});
});
