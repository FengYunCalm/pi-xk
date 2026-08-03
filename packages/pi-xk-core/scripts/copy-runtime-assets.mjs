import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
await copyFile(join(packageRoot, "src", "memory-index-bun-worker.mjs"), join(packageRoot, "dist", "memory-index-bun-worker.mjs"));
await copyFile(join(packageRoot, "src", "skill-index-bun-worker.mjs"), join(packageRoot, "dist", "skill-index-bun-worker.mjs"));
