import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptPath = join(workspaceRoot, "scripts", "prepare-pi-xk-harbor-bundle.mjs");
const temporaryRoot = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-xk-harbor-bundle-test-"),
);
const output = join(temporaryRoot, "bundle");

try {
	const result = spawnSync(process.execPath, [scriptPath, "--out", output], {
		cwd: workspaceRoot,
		encoding: "utf8",
	});
	const extensionEntrypoint = join(workspaceRoot, "packages", "pi-xk-extension", "dist", "extension.js");
	if (!existsSync(extensionEntrypoint)) {
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Pi-XK extension dist is missing/u);
		assert.equal(existsSync(output), false);
	} else {
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
		assert.equal(manifest.schema, "pi-xk.harbor-extension-bundle.v2");
		assert.match(manifest.piVersion, /^\d+\.\d+\.\d+/u);
		assert.ok(manifest.files.length > 0);
		const paths = manifest.files.map((file) => file.path);
		assert.equal(new Set(paths).size, paths.length, "bundle manifest must not contain duplicate file paths");
		assert.equal(paths.some((path) => path.includes("\\")), false, "bundle paths must use POSIX separators");
		assert.ok(paths.includes("node_modules/pi-xk-core/package.json"));
		assert.ok(paths.includes("node_modules/typebox/package.json"));
		assert.ok(paths.includes("pi-agent-core.tgz"));
		assert.ok(paths.includes("pi-ai.tgz"));
		assert.ok(paths.includes("pi-tui.tgz"));
		assert.ok(paths.includes("pi-coding-agent.tgz"));
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
