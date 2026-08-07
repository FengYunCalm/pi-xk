import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInsideRoot } from "./pi-xk-evaluation-paths.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(workspaceRoot, "packages", "pi-xk-extension");
const extensionDist = join(extensionRoot, "dist");
const bundledCore = join(extensionRoot, "node_modules", "pi-xk-core");
const bundledTypebox = join(workspaceRoot, "node_modules", "typebox");
const codingAgentPackagePath = join(workspaceRoot, "packages", "coding-agent", "package.json");
const telemetrySource = join(workspaceRoot, "evaluation", "harbor", "harbor_pi_xk", "harbor-telemetry.mjs");
const piRuntimePackages = [
	{
		label: "Pi agent core",
		name: "@earendil-works/pi-agent-core",
		root: join(workspaceRoot, "packages", "agent"),
		archive: "pi-agent-core.tgz",
	},
	{
		label: "Pi AI",
		name: "@earendil-works/pi-ai",
		root: join(workspaceRoot, "packages", "ai"),
		archive: "pi-ai.tgz",
	},
	{
		label: "Pi TUI",
		name: "@earendil-works/pi-tui",
		root: join(workspaceRoot, "packages", "tui"),
		archive: "pi-tui.tgz",
	},
	{
		label: "Pi coding agent",
		name: "@earendil-works/pi-coding-agent",
		root: join(workspaceRoot, "packages", "coding-agent"),
		archive: "pi-coding-agent.tgz",
	},
];

function usage() {
	console.log(`Usage: node scripts/prepare-pi-xk-harbor-bundle.mjs --out <dir> [--force]

Build Pi-XK first with:
  npm --workspace pi-xk-core run build
  npm --workspace pi-xk-extension run build`);
}

function parseArgs(argv) {
	let out;
	let force = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--out") {
			out = argv[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") return { help: true };
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!out) throw new Error("--out is required");
	return { help: false, out: resolve(out), force };
}

async function assertFile(path, label) {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
	} catch (error) {
		throw new Error(`${label} is missing: ${path}`, { cause: error });
	}
}

async function assertDirectory(path, label) {
	try {
		const stat = await lstat(path);
		if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
	} catch (error) {
		throw new Error(`${label} is missing: ${path}`, { cause: error });
	}
}

function assertSafeOutput(target) {
	const disallowed = new Set([resolve("/"), workspaceRoot, resolve(homedir())]);
	if (disallowed.has(target)) throw new Error(`Refusing unsafe bundle output directory: ${target}`);
	if (isPathInsideRoot(workspaceRoot, target)) {
		throw new Error("Harbor bundle output must be outside the repository worktree");
	}
}

async function hashFiles(root, bundleRelative = "") {
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
		const path = join(root, entry.name);
		if (entry.name.includes("\\")) throw new Error(`Bundle contains an unsafe path component: ${entry.name}`);
		const relativePath = posix.join(bundleRelative, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Bundle contains a symbolic link: ${path}`);
		if (entry.isDirectory()) {
			files.push(...(await hashFiles(path, relativePath)));
			continue;
		}
		if (!entry.isFile()) throw new Error(`Bundle contains an unsupported entry: ${path}`);
		const content = await readFile(path);
		files.push({ path: relativePath, sha256: createHash("sha256").update(content).digest("hex") });
	}
	return files;
}

function currentSourceCommit() {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
}

async function readPiVersion() {
	const codingAgentPackage = JSON.parse(await readFile(codingAgentPackagePath, "utf8"));
	if (typeof codingAgentPackage.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(codingAgentPackage.version)) {
		throw new Error("Pi coding-agent package version is invalid");
	}
	return codingAgentPackage.version;
}

async function assertPiRuntimePackages(piVersion) {
	for (const runtimePackage of piRuntimePackages) {
		await assertDirectory(runtimePackage.root, runtimePackage.label);
		const packagePath = join(runtimePackage.root, "package.json");
		await assertFile(packagePath, `${runtimePackage.label} package metadata`);
		const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
		if (packageMetadata.name !== runtimePackage.name || packageMetadata.version !== piVersion) {
			throw new Error(`${runtimePackage.label} must match the Pi coding-agent package identity and version`);
		}
		await assertDirectory(join(runtimePackage.root, "dist"), `${runtimePackage.label} dist`);
	}
}

async function packPiRuntimePackages(stage) {
	for (const runtimePackage of piRuntimePackages) {
		const packedName = execFileSync(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", stage, "--silent"],
			{ cwd: runtimePackage.root, encoding: "utf8" },
		).trim();
		if (!packedName || packedName.includes("\n")) {
			throw new Error(`Unable to identify the packed ${runtimePackage.label} archive`);
		}
		await rename(join(stage, packedName), join(stage, runtimePackage.archive));
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	assertSafeOutput(options.out);
	await assertDirectory(extensionDist, "Pi-XK extension dist");
	await assertFile(join(extensionDist, "extension.js"), "Pi-XK extension entrypoint");
	await assertDirectory(bundledCore, "Bundled Pi-XK core");
	await assertFile(join(bundledCore, "package.json"), "Bundled Pi-XK core package metadata");
	await assertDirectory(bundledTypebox, "Bundled Pi-XK typebox peer dependency");
	await assertFile(join(bundledTypebox, "package.json"), "Bundled Pi-XK typebox package metadata");
	await assertFile(codingAgentPackagePath, "Pi coding-agent package metadata");
	await assertFile(telemetrySource, "Harbor telemetry filter");
	const piVersion = await readPiVersion();
	await assertPiRuntimePackages(piVersion);

	await mkdir(dirname(options.out), { recursive: true });
	const stage = await mkdtemp(join(dirname(options.out), `.${basename(options.out)}.`));
	try {
		await cp(extensionDist, stage, { recursive: true, verbatimSymlinks: true });
		await mkdir(join(stage, "node_modules"), { recursive: true });
		await cp(bundledCore, join(stage, "node_modules", "pi-xk-core"), { recursive: true, verbatimSymlinks: true });
		await cp(bundledTypebox, join(stage, "node_modules", "typebox"), { recursive: true, verbatimSymlinks: true });
		await cp(telemetrySource, join(stage, "harbor-telemetry.mjs"));
		await packPiRuntimePackages(stage);
		const files = await hashFiles(stage);
		const manifest = {
			schema: "pi-xk.harbor-extension-bundle.v2",
			sourceCommit: currentSourceCommit(),
			piVersion,
			files,
		};
		await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		try {
			await lstat(options.out);
			if (!options.force) throw new Error(`Output already exists: ${options.out}; pass --force to replace it`);
			await rm(options.out, { recursive: true, force: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				// The requested output does not exist.
			} else if (error instanceof Error && error.message.startsWith("Output already exists")) {
				throw error;
			} else if (error) {
				throw error;
			}
		}
		await rename(stage, options.out);
		console.log(`Pi-XK Harbor bundle created at ${options.out}`);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
