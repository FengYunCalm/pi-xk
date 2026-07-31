#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportedPlatforms = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"windows-arm64",
	"windows-x64",
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const createZipArchiveScriptPath = join(scriptDirectory, "create-zip-archive.sh");
const createZipArchivePowerShellPath = join(scriptDirectory, "create-zip-archive.ps1");

function usage() {
	console.log(`Usage: node scripts/package-pi-xk-release.mjs [options]

Options:
  --input <dir>             Built platform directories and release output root
  --platform <name>         Package one platform; repeatable (default: all six)
  --release-config <file>   Pi-XK release config (default: pi-xk-release.json)
  --extension-root <dir>    Built Pi-XK extension package
  --docs-root <dir>         Pi-XK documentation directory
  --tag <tag>               Required pi-xk-v<version> release tag
  --source-sha <sha>        Full source commit SHA
  --pi-version <version>    Embedded upstream Pi package version
  --stage-only              Stage and validate payloads without creating archives
  --help                    Show this help`);
}

function parseArguments(argv) {
	const options = {
		docsRoot: resolve("docs/pi-xk"),
		extensionRoot: resolve("packages/pi-xk-extension"),
		input: undefined,
		piVersion: undefined,
		platforms: [],
		releaseConfigPath: resolve("pi-xk-release.json"),
		sourceSha: undefined,
		stageOnly: false,
		tag: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") return { help: true };
		if (argument === "--stage-only") {
			options.stageOnly = true;
			continue;
		}
		const value = argv[index + 1];
		if (!value) throw new Error(`${argument} requires a value`);
		if (argument === "--input") options.input = resolve(value);
		else if (argument === "--platform") options.platforms.push(value);
		else if (argument === "--release-config") options.releaseConfigPath = resolve(value);
		else if (argument === "--extension-root") options.extensionRoot = resolve(value);
		else if (argument === "--docs-root") options.docsRoot = resolve(value);
		else if (argument === "--tag") options.tag = value;
		else if (argument === "--source-sha") options.sourceSha = value;
		else if (argument === "--pi-version") options.piVersion = value;
		else throw new Error(`unknown argument: ${argument}`);
		index += 1;
	}
	return { help: false, ...options };
}

function requireFile(path, description) {
	if (!existsSync(path)) throw new Error(`${description} is missing: ${path}`);
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
}

async function hashFile(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function replacePlatformDirectory(input, platform, stagedPlatformRoot) {
	const platformRoot = join(input, platform);
	const backupRoot = join(input, `.pi-xk-backup-${platform}-${randomUUID()}`);
	await rename(platformRoot, backupRoot);
	try {
		await rename(stagedPlatformRoot, platformRoot);
	} catch (error) {
		await rename(backupRoot, platformRoot);
		throw error;
	}
	await rm(backupRoot, { recursive: true, force: true });
}

async function createArchives(input, platforms) {
	const archives = [];
	for (const platform of platforms) {
		const platformRoot = join(input, platform);
		if (platform.startsWith("windows-")) {
			const archivePath = join(input, `pi-xk-${platform}.zip`);
			await rm(archivePath, { force: true });
			if (process.platform === "win32") {
				run(
					"powershell.exe",
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						createZipArchivePowerShellPath,
						"-SourceDirectory",
						platformRoot,
						"-DestinationPath",
						archivePath,
					],
					input,
				);
			} else {
				run(createZipArchiveScriptPath, [platformRoot, archivePath], input);
			}
			archives.push(archivePath);
			continue;
		}
		const archivePath = join(input, `pi-xk-${platform}.tar.gz`);
		await rm(archivePath, { force: true });
		run("tar", ["-czf", archivePath, "--transform", "s,^\\./,pi-xk/,", "."], platformRoot);
		archives.push(archivePath);
	}
	return archives;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	if (!options.input) throw new Error("--input is required");
	if (!options.tag) throw new Error("--tag is required");
	if (!options.sourceSha || !/^[0-9a-f]{40}$/i.test(options.sourceSha)) {
		throw new Error("--source-sha must be a full 40-character Git commit SHA");
	}
	if (!options.piVersion || !semverPattern.test(options.piVersion)) {
		throw new Error("--pi-version must be a semantic version");
	}

	const releaseConfig = JSON.parse(await readFile(options.releaseConfigPath, "utf8"));
	if (releaseConfig?.schema !== "pi-xk.release.v1" || !semverPattern.test(releaseConfig?.version ?? "")) {
		throw new Error(`invalid Pi-XK release config: ${options.releaseConfigPath}`);
	}
	const expectedTag = `pi-xk-v${releaseConfig.version}`;
	if (options.tag !== expectedTag) {
		throw new Error(`release tag ${options.tag} does not match Pi-XK release version ${releaseConfig.version}`);
	}

	const platforms = options.platforms.length > 0 ? [...new Set(options.platforms)] : supportedPlatforms;
	for (const platform of platforms) {
		if (!supportedPlatforms.includes(platform)) throw new Error(`unsupported platform: ${platform}`);
		const executableSuffix = platform.startsWith("windows-") ? ".exe" : "";
		requireFile(join(options.input, platform, `pi${executableSuffix}`), `${platform} Pi executable`);
		requireFile(join(options.input, platform, `pi-xk${executableSuffix}`), `${platform} Pi-XK executable`);
	}
	requireFile(join(options.extensionRoot, "package.json"), "Pi-XK extension package.json");
	requireFile(join(options.extensionRoot, "README.md"), "Pi-XK extension README");
	requireFile(join(options.extensionRoot, "dist", "extension.js"), "Pi-XK extension dist/extension.js");
	requireFile(
		join(options.extensionRoot, "node_modules", "pi-xk-core", "dist", "index.js"),
		"Pi-XK bundled pi-xk-core/dist/index.js",
	);
	requireFile(join(options.extensionRoot, "node_modules", "pi-xk-core", "package.json"), "Pi-XK bundled Core package.json");
	requireFile(join(options.docsRoot, "README.md"), "Pi-XK documentation README");

	const manifest = {
		schema: "pi-xk.github-release.v1",
		version: releaseConfig.version,
		tag: options.tag,
		sourceCommit: options.sourceSha.toLowerCase(),
		piBaseVersion: options.piVersion,
		entrypoint: "pi-xk",
		extension: "pi-xk-extension/dist/extension.js",
	};
	const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
	const stagingRoot = join(options.input, `.pi-xk-stage-${randomUUID()}`);
	try {
		for (const platform of platforms) {
			const stagedPlatformRoot = join(stagingRoot, platform);
			await cp(join(options.input, platform), stagedPlatformRoot, { recursive: true });
			const stagedExtensionRoot = join(stagedPlatformRoot, "pi-xk-extension");
			await mkdir(stagedExtensionRoot, { recursive: true });
			await cp(join(options.extensionRoot, "package.json"), join(stagedExtensionRoot, "package.json"));
			await cp(join(options.extensionRoot, "README.md"), join(stagedExtensionRoot, "README.md"));
			await cp(join(options.extensionRoot, "dist"), join(stagedExtensionRoot, "dist"), { recursive: true });
			await cp(
				join(options.extensionRoot, "node_modules", "pi-xk-core"),
				join(stagedExtensionRoot, "node_modules", "pi-xk-core"),
				{ recursive: true },
			);
			await cp(options.docsRoot, join(stagedPlatformRoot, "pi-xk-docs"), { recursive: true });
			await writeFile(join(stagedPlatformRoot, "PI-XK-RELEASE.json"), manifestText);
		}
		for (const platform of platforms) {
			await replacePlatformDirectory(options.input, platform, join(stagingRoot, platform));
		}
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}

	await writeFile(join(options.input, "PI-XK-RELEASE.json"), manifestText);
	if (options.stageOnly) return;

	const archives = await createArchives(options.input, platforms);
	const checksumTargets = [...archives, join(options.input, "PI-XK-RELEASE.json")];
	const checksumLines = [];
	for (const path of checksumTargets) checksumLines.push(`${await hashFile(path)}  ${basename(path)}`);
	await writeFile(join(options.input, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
}

main().catch((error) => {
	console.error(`Pi-XK release packaging failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
