import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

const workspaceRoot = resolve(import.meta.dirname, "..");
const coreSource = join(workspaceRoot, "packages", "pi-xk-core", "src");

async function sourceFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function moduleSpecifiers(sourceText, filePath) {
	const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const specifiers = [];
	for (const statement of source.statements) {
		if (
			(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
			statement.moduleSpecifier &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			specifiers.push(statement.moduleSpecifier.text);
		}
	}
	return specifiers;
}

const violations = [];
for (const filePath of await sourceFiles(coreSource)) {
	const sourceText = await readFile(filePath, "utf8");
	for (const specifier of moduleSpecifiers(sourceText, filePath)) {
		if (specifier === "@earendil-works/pi-coding-agent" || specifier.startsWith("pi-xk-extension")) {
			violations.push(`${relative(workspaceRoot, filePath)} imports forbidden host module ${specifier}`);
			continue;
		}
		if (specifier.startsWith(".")) {
			const target = resolve(dirname(filePath), specifier);
			const fromCore = relative(coreSource, target);
			if (fromCore.startsWith("..") || isAbsolute(fromCore)) {
				violations.push(`${relative(workspaceRoot, filePath)} escapes pi-xk-core/src via ${specifier}`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error(violations.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Pi-XK module boundaries are valid.");
}
