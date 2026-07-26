#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../config.ts";
import { runBunCli } from "./run-cli.ts";

const executableDirectory = dirname(process.execPath);
const manifestPath = join(executableDirectory, "PI-XK-RELEASE.json");
const extensionPath = join(executableDirectory, "pi-xk-extension", "dist", "extension.js");
const corePath = join(executableDirectory, "pi-xk-extension", "node_modules", "pi-xk-core", "dist", "index.js");

if (!existsSync(manifestPath) || !existsSync(extensionPath) || !existsSync(corePath)) {
	console.error("Pi-XK release payload is incomplete. Extract and run the complete Pi-XK archive.");
	process.exit(1);
}

let parsedManifest: unknown;
try {
	parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
	console.error("Pi-XK release manifest is invalid. Extract the archive again and verify SHA256SUMS.");
	process.exit(1);
}
if (
	!parsedManifest ||
	typeof parsedManifest !== "object" ||
	!("schema" in parsedManifest) ||
	parsedManifest.schema !== "pi-xk.github-release.v1" ||
	!("version" in parsedManifest) ||
	typeof parsedManifest.version !== "string" ||
	!("piBaseVersion" in parsedManifest) ||
	typeof parsedManifest.piBaseVersion !== "string"
) {
	console.error("Pi-XK release manifest is invalid. Extract the archive again and verify SHA256SUMS.");
	process.exit(1);
}
if (parsedManifest.piBaseVersion !== VERSION) {
	console.error(
		`Pi-XK release expects Pi ${parsedManifest.piBaseVersion}, but the executable contains Pi ${VERSION}.`,
	);
	process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
	console.log(`pi-xk ${parsedManifest.version} (pi ${VERSION})`);
	process.exit(0);
}

await runBunCli(["--extension", extensionPath, ...args], "pi-xk");
