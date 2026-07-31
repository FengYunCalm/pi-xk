#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../config.ts";
import { validatePiXkReleaseManifest } from "./pi-xk-release-manifest.ts";
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
const manifest = validatePiXkReleaseManifest(parsedManifest, VERSION);
if (!manifest) {
	console.error("Pi-XK release manifest is invalid. Extract the archive again and verify SHA256SUMS.");
	process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
	console.log(`pi-xk ${manifest.version} (pi ${VERSION})`);
	process.exit(0);
}

await runBunCli(["--extension", extensionPath, ...args], "pi-xk");
