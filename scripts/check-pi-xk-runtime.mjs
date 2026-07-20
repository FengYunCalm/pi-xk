import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const managedFdPath = join(agentDirectory, "bin", process.platform === "win32" ? "fd.exe" : "fd");
const candidates = [managedFdPath, "fd", "fdfind"];

function isExecutable(command) {
	if (command === managedFdPath && !existsSync(command)) return false;
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

const availableCommand = candidates.find(isExecutable);
if (!availableCommand) {
	console.error("Pi-XK runtime preflight failed: fd is unavailable.");
	console.error("Ubuntu/Debian: sudo apt-get install fd-find");
	console.error(`Without system installation, place a trusted fd binary at ${managedFdPath}.`);
	process.exit(1);
}

console.log(`Pi-XK runtime preflight passed: ${availableCommand}`);
