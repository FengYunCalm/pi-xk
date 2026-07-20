import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = join(packageRoot, "..", "pi-xk-core");
const targetRoot = join(packageRoot, "node_modules", "pi-xk-core");
const corePackage = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"));

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await cp(join(coreRoot, "dist"), join(targetRoot, "dist"), { recursive: true });
await writeFile(
	join(targetRoot, "package.json"),
	`${JSON.stringify(
		{
			name: corePackage.name,
			version: corePackage.version,
			type: corePackage.type,
			main: corePackage.main,
			types: corePackage.types,
			exports: corePackage.exports,
		},
		null,
		2,
	)}\n`,
	"utf8",
);
