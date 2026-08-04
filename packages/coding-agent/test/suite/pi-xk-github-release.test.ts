import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validatePiXkReleaseManifest } from "../../src/bun/pi-xk-release-manifest.ts";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(suiteDirectory, "../../../..");
const buildScriptPath = join(workspaceRoot, "scripts", "build-pi-xk-binaries.sh");
const zipArchiveScriptPath = join(workspaceRoot, "scripts", "create-zip-archive.sh");
const extractZipArchiveScriptPath = join(workspaceRoot, "scripts", "extract-zip-archive.sh");
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

type PackagerOptions = {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	stageOnly?: boolean;
};

function runPackager(fixture: ReleaseFixture, tag: string, options: PackagerOptions = {}) {
	const platform = options.platform ?? "linux-x64";
	const arguments_ = [
		packagerPath,
		"--input",
		fixture.binaryRoot,
		"--platform",
		platform,
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
	];
	if (options.stageOnly ?? true) arguments_.push("--stage-only");
	return spawnSync(process.execPath, arguments_, {
		encoding: "utf8",
		env: options.env,
		timeout: 60_000,
	});
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
		expect(workflow).toContain(`tag_commit="$(git rev-parse "\${RELEASE_TAG}^{commit}")"`);
		expect(workflow).toContain(`if [[ "\${head_commit}" != "\${tag_commit}" ]]`);
	});

	it("validates the complete release manifest identity without accepting extra fields", () => {
		const manifest = {
			schema: "pi-xk.github-release.v1",
			version: "0.1.0",
			tag: "pi-xk-v0.1.0",
			sourceCommit,
			piBaseVersion: "0.80.10",
			entrypoint: "pi-xk",
			extension: "pi-xk-extension/dist/extension.js",
		};

		expect(validatePiXkReleaseManifest(manifest, "0.80.10")).toEqual(manifest);
		for (const invalid of [
			{ ...manifest, tag: "pi-xk-v0.2.0" },
			{ ...manifest, sourceCommit: sourceCommit.toUpperCase() },
			{ ...manifest, piBaseVersion: "0.80.9" },
			{ ...manifest, entrypoint: "pi" },
			{ ...manifest, extension: "other.js" },
			{ ...manifest, unexpected: true },
		]) {
			expect(validatePiXkReleaseManifest(invalid, "0.80.10")).toBeUndefined();
		}
		const { extension: _extension, ...missingExtension } = manifest;
		expect(validatePiXkReleaseManifest(missingExtension, "0.80.10")).toBeUndefined();
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

	// These two cases exercise Linux-side WSL command discovery. Native Windows is covered below.
	it.skipIf(process.platform === "win32")("falls back to PowerShell when zip is unavailable in WSL", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-zip-fallback-"));
		temporaryDirectories.push(root);
		const sourceDirectory = join(root, "source");
		const archivePath = join(root, "release.zip");
		const capturePath = join(root, "powershell-args.txt");
		const fakeBin = join(root, "bin");
		await mkdir(sourceDirectory);
		await mkdir(fakeBin);
		await writeFile(join(sourceDirectory, "payload.txt"), "payload\n");
		const fakeWslPath = join(fakeBin, "wslpath");
		await writeFile(fakeWslPath, '#!/bin/bash\n[[ "$1" == "-w" ]] || exit 2\nprintf "%s\\n" "$2"\n');
		const fakePowerShell = join(fakeBin, "powershell.exe");
		await writeFile(
			fakePowerShell,
			[
				"#!/bin/bash",
				'capture="$' + '{PI_XK_TEST_CAPTURE:?}"',
				'source_directory=""',
				'destination_path=""',
				"while (($#)); do",
				'\tcase "$1" in',
				'\t\t-SourceDirectory) source_directory="$2"; shift 2 ;;',
				'\t\t-DestinationPath) destination_path="$2"; shift 2 ;;',
				"\t\t*) shift ;;",
				"\tesac",
				"done",
				'printf "%s\\n%s\\n" "$source_directory" "$destination_path" > "$capture"',
				': > "$destination_path"',
				"",
			].join("\n"),
		);
		await Promise.all([chmod(fakeWslPath, 0o755), chmod(fakePowerShell, 0o755)]);
		const bashLookup = spawnSync("bash", ["-lc", "command -v bash"], { encoding: "utf8" });
		expect(bashLookup.status, `${bashLookup.stdout}${bashLookup.stderr}`).toBe(0);

		const result = spawnSync(bashLookup.stdout.trim(), [zipArchiveScriptPath, sourceDirectory, archivePath], {
			encoding: "utf8",
			env: { ...process.env, PATH: fakeBin, PI_XK_TEST_CAPTURE: capturePath },
		});

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		expect(existsSync(archivePath)).toBe(true);
		expect((await readFile(capturePath, "utf8")).trim().split("\n")).toEqual([sourceDirectory, archivePath]);
	});

	it.skipIf(process.platform === "win32")("falls back to PowerShell when unzip is unavailable in WSL", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-unzip-fallback-"));
		temporaryDirectories.push(root);
		const archivePath = join(root, "release.zip");
		const destinationDirectory = join(root, "extracted");
		const capturePath = join(root, "powershell-args.txt");
		const fakeBin = join(root, "bin");
		await mkdir(fakeBin);
		await writeFile(archivePath, "archive fixture\n");
		const fakeWslPath = join(fakeBin, "wslpath");
		await writeFile(fakeWslPath, '#!/bin/bash\n[[ "$1" == "-w" ]] || exit 2\nprintf "%s\\n" "$2"\n');
		const fakePowerShell = join(fakeBin, "powershell.exe");
		await writeFile(
			fakePowerShell,
			[
				"#!/bin/bash",
				'capture="$' + '{PI_XK_TEST_CAPTURE:?}"',
				'source_archive=""',
				'destination_directory=""',
				"while (($#)); do",
				'\tcase "$1" in',
				'\t\t-SourceArchive) source_archive="$2"; shift 2 ;;',
				'\t\t-DestinationDirectory) destination_directory="$2"; shift 2 ;;',
				"\t\t*) shift ;;",
				"\tesac",
				"done",
				'printf "%s\\n%s\\n" "$source_archive" "$destination_directory" > "$capture"',
				'command -p mkdir -p "$destination_directory"',
				"",
			].join("\n"),
		);
		await Promise.all([chmod(fakeWslPath, 0o755), chmod(fakePowerShell, 0o755)]);
		const bashLookup = spawnSync("bash", ["-lc", "command -v bash"], { encoding: "utf8" });
		expect(bashLookup.status, `${bashLookup.stdout}${bashLookup.stderr}`).toBe(0);

		const result = spawnSync(
			bashLookup.stdout.trim(),
			[extractZipArchiveScriptPath, archivePath, destinationDirectory],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: fakeBin, PI_XK_TEST_CAPTURE: capturePath },
			},
		);

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		expect(existsSync(destinationDirectory)).toBe(true);
		expect((await readFile(capturePath, "utf8")).trim().split("\n")).toEqual([archivePath, destinationDirectory]);
	});

	it("packages Windows Pi-XK releases through the platform zip helper", async () => {
		const fixture = await createReleaseFixture();
		const platformRoot = join(fixture.binaryRoot, "windows-x64");
		await mkdir(platformRoot);
		await Promise.all([
			writeFile(join(platformRoot, "pi.exe"), "base pi binary\n"),
			writeFile(join(platformRoot, "pi-xk.exe"), "pi-xk binary\n"),
		]);

		let packagerEnvironment = process.env;
		let capturePath: string | undefined;
		if (process.platform !== "win32") {
			const fakeBin = join(dirname(fixture.binaryRoot), "bin");
			capturePath = join(dirname(fixture.binaryRoot), "powershell-args.txt");
			await mkdir(fakeBin);
			const bashLookup = spawnSync("bash", ["-lc", "command -v bash"], { encoding: "utf8" });
			expect(bashLookup.status, `${bashLookup.stdout}${bashLookup.stderr}`).toBe(0);
			await symlink(bashLookup.stdout.trim(), join(fakeBin, "bash"));
			const fakeWslPath = join(fakeBin, "wslpath");
			await writeFile(fakeWslPath, '#!/bin/bash\n[[ "$1" == "-w" ]] || exit 2\nprintf "%s\\n" "$2"\n');
			const fakePowerShell = join(fakeBin, "powershell.exe");
			await writeFile(
				fakePowerShell,
				[
					"#!/bin/bash",
					'capture="$' + '{PI_XK_TEST_CAPTURE:?}"',
					'destination_path=""',
					"while (($#)); do",
					'\tif [[ "$1" == "-DestinationPath" ]]; then destination_path="$2"; shift 2; else shift; fi',
					"done",
					'printf "%s\\n" "$destination_path" > "$capture"',
					': > "$destination_path"',
					"",
				].join("\n"),
			);
			await Promise.all([chmod(fakeWslPath, 0o755), chmod(fakePowerShell, 0o755)]);
			packagerEnvironment = { ...process.env, PATH: fakeBin, PI_XK_TEST_CAPTURE: capturePath };
		}

		const result = runPackager(fixture, "pi-xk-v0.1.0", {
			env: packagerEnvironment,
			platform: "windows-x64",
			stageOnly: false,
		});

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		const archivePath = join(fixture.binaryRoot, "pi-xk-windows-x64.zip");
		expect(existsSync(archivePath)).toBe(true);
		if (capturePath) expect((await readFile(capturePath, "utf8")).trim()).toBe(archivePath);
		expect(await readFile(join(fixture.binaryRoot, "SHA256SUMS"), "utf8")).toContain("pi-xk-windows-x64.zip");
	}, 90_000);

	it("rejects a mismatched local release tag before replacing existing output", async () => {
		const releaseConfig = JSON.parse(await readFile(join(workspaceRoot, "pi-xk-release.json"), "utf8")) as {
			version: string;
		};
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
		expect(`${result.stdout}${result.stderr}`).toContain(
			`does not match Pi-XK release version ${releaseConfig.version}`,
		);
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
