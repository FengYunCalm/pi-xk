import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDirectory = join(workspaceRoot, "packages", "pi-xk-extension");

function usage() {
	console.log(`Usage: node scripts/manage-pi-xk-local.mjs <install|upgrade|uninstall> [options]

Options:
  --agent-dir <path>  Pi profile directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  --dry-run           Print planned operations without building or writing settings
  --help              Show this help`);
}

function parseArguments(argv) {
	const [action, ...args] = argv;
	if (action === "--help" || action === "-h") return { help: true };
	if (!action || !["install", "upgrade", "uninstall"].includes(action)) {
		throw new Error("the first argument must be install, upgrade, or uninstall");
	}
	let agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument === "--agent-dir") {
			const value = args[index + 1];
			if (!value) throw new Error("--agent-dir requires a path");
			agentDirectory = value;
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
		throw new Error(`unknown argument: ${argument}`);
	}
	return { help: false, action, agentDirectory: resolve(agentDirectory), dryRun };
}

function packageSource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
	return undefined;
}

function matchesExtension(entry, agentDirectory) {
	const source = packageSource(entry);
	return source !== undefined && resolve(agentDirectory, source) === extensionDirectory;
}

async function loadSettings(settingsPath) {
	if (!existsSync(settingsPath)) return {};
	const raw = await readFile(settingsPath, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`refusing to overwrite invalid Pi settings at ${settingsPath}: ${error.message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`refusing to overwrite non-object Pi settings at ${settingsPath}`);
	}
	if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
		throw new Error(`refusing to overwrite Pi settings with a non-array packages field at ${settingsPath}`);
	}
	return parsed;
}

async function writeSettingsAtomically(settingsPath, settings) {
	await mkdir(dirname(settingsPath), { recursive: true });
	const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, settingsPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function run(command, args, env = process.env) {
	const result = spawnSync(command, args, { cwd: workspaceRoot, env, encoding: "utf8", stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function buildAndPreflight(agentDirectory) {
	if (process.env.PI_XK_INSTALL_TEST_SKIP_BUILD !== "1") {
		run("npm", ["--workspace", "pi-xk-core", "run", "build"]);
		run("npm", ["--workspace", "pi-xk-extension", "run", "build"]);
	}
	run(process.execPath, [join(workspaceRoot, "scripts", "check-pi-xk-runtime.mjs")], {
		...process.env,
		PI_CODING_AGENT_DIR: agentDirectory,
	});
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const { action, agentDirectory, dryRun } = options;
	const settingsPath = join(agentDirectory, "settings.json");
	const configuredSource = relative(agentDirectory, extensionDirectory) || ".";
	console.log(`Pi-XK local ${action}`);
	console.log(`Profile: ${agentDirectory}`);
	console.log(`Extension: ${extensionDirectory}`);
	console.log(`Settings: ${settingsPath}`);
	if (dryRun) {
		console.log(action === "uninstall" ? "Would remove the local package reference." : "Would build, run runtime preflight, and update the local package reference.");
		return;
	}

	const settings = await loadSettings(settingsPath);
	const packages = settings.packages ?? [];
	const configured = packages.some((entry) => matchesExtension(entry, agentDirectory));
	if (action === "upgrade" && !configured) {
		throw new Error("Pi-XK is not installed in this profile; run install first");
	}
	if (action === "uninstall") {
		if (!configured) {
			console.log("Pi-XK is not configured in this profile; no changes made.");
			return;
		}
		settings.packages = packages.filter((entry) => !matchesExtension(entry, agentDirectory));
		await writeSettingsAtomically(settingsPath, settings);
		console.log("Pi-XK local package reference removed. Project .pi-xk data was not changed.");
		return;
	}

	buildAndPreflight(agentDirectory);
	if (!configured) settings.packages = [...packages, configuredSource];
	await writeSettingsAtomically(settingsPath, settings);
	console.log(configured ? "Pi-XK rebuilt and profile reference verified." : "Pi-XK built and installed in the profile.");
	console.log("Restart Pi to load the updated extension.");
}

main().catch((error) => {
	console.error(`Pi-XK local management failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
