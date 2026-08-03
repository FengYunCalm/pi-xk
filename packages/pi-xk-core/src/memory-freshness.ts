import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
	type GitEvidenceLocatorV1,
	type GitFreshnessBasisV1,
	MEMORY_GIT_FRESHNESS_SCHEMA,
	type MemoryFreshness,
	validateGitFreshnessBasisV1,
} from "./memory-contract.ts";
import { stableJsonStringify } from "./stable-json.ts";

const execFile = promisify(execFileCallback);
const MAX_GIT_EVIDENCE_BYTES = 64 * 1024;

interface RepositoryContext {
	root: string;
	repositoryId: string;
}

export async function verifyGitEvidenceLocator(projectRoot: string, locator: GitEvidenceLocatorV1): Promise<void> {
	const context = await repositoryContext(projectRoot);
	if (context.repositoryId !== locator.repositoryId) {
		throw new Error("Memory Git evidence belongs to another repository");
	}
	await execFile("git", ["cat-file", "-e", `${locator.baselineCommit}^{commit}`], { cwd: context.root });
	for (const scopePath of locator.scopePaths) {
		const absolutePath = resolve(context.root, scopePath);
		if (normalizedRelative(context.root, absolutePath) !== scopePath) {
			throw new Error("Memory Git evidence scope path is not normalized");
		}
		await execFile("git", ["cat-file", "-e", `${locator.baselineCommit}:${scopePath}`], { cwd: context.root });
	}
}

export async function readGitEvidence(projectRoot: string, locator: GitEvidenceLocatorV1): Promise<string> {
	await verifyGitEvidenceLocator(projectRoot, locator);
	const context = await repositoryContext(projectRoot);
	const listed = (
		await execFile("git", ["ls-tree", "-r", "--name-only", locator.baselineCommit, "--", ...locator.scopePaths], {
			cwd: context.root,
			encoding: "utf8",
			maxBuffer: MAX_GIT_EVIDENCE_BYTES,
		})
	).stdout;
	const paths = listed.split("\n").filter((path) => path.length > 0);
	if (paths.length === 0) throw new Error("Memory Git evidence baseline contains no files");
	if (paths.length > 200) throw new Error("Memory Git evidence expands to more than 200 files");
	const files: Array<{ path: string; content: string }> = [];
	let bytes = 0;
	for (const path of paths) {
		const content = (
			await execFile("git", ["show", `${locator.baselineCommit}:${path}`], {
				cwd: context.root,
				encoding: "utf8",
				maxBuffer: MAX_GIT_EVIDENCE_BYTES,
			})
		).stdout;
		if (content.includes("\0")) throw new Error(`Memory Git evidence is binary and cannot be expanded: ${path}`);
		bytes += Buffer.byteLength(path) + Buffer.byteLength(content);
		if (bytes > MAX_GIT_EVIDENCE_BYTES) throw new Error("Memory Git evidence exceeds the D3 expansion limit");
		files.push({ path, content });
	}
	return stableJsonStringify({
		schema: "pi-xk.memory-git-evidence.v1",
		repositoryId: locator.repositoryId,
		baselineCommit: locator.baselineCommit,
		scopePaths: locator.scopePaths,
		files,
	});
}

function normalizedRelative(root: string, path: string): string {
	const result = relative(root, path).split(sep).join("/");
	if (result.length === 0 || result === ".." || result.startsWith("../")) {
		throw new Error("Memory freshness path resolves outside the repository");
	}
	return result;
}

async function repositoryContext(projectRoot: string): Promise<RepositoryContext> {
	const resolvedProjectRoot = await realpath(resolve(projectRoot));
	const topLevel = (
		await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: resolvedProjectRoot, encoding: "utf8" })
	).stdout.trim();
	const root = await realpath(topLevel);
	let identityBasis = root;
	try {
		const remote = (
			await execFile("git", ["config", "--get", "remote.origin.url"], { cwd: root, encoding: "utf8" })
		).stdout.trim();
		if (remote.length > 0) identityBasis = remote;
	} catch {
		// A repository without an origin remains locally identifiable by its canonical root.
	}
	return { root, repositoryId: `repo_${createHash("sha256").update(identityBasis).digest("hex").slice(0, 32)}` };
}

export async function resolveGitRepositoryId(projectRoot: string): Promise<string | null> {
	try {
		return (await repositoryContext(projectRoot)).repositoryId;
	} catch {
		return null;
	}
}

async function appendPathDigest(
	hash: ReturnType<typeof createHash>,
	root: string,
	absolutePath: string,
): Promise<void> {
	const metadata = await lstat(absolutePath);
	const relativePath = normalizedRelative(root, absolutePath);
	if (metadata.isSymbolicLink()) {
		hash.update(`link\0${relativePath}\0${await readlink(absolutePath)}\0`);
		return;
	}
	if (metadata.isFile()) {
		hash.update(`file\0${relativePath}\0${metadata.mode & 0o111 ? "executable" : "regular"}\0`);
		hash.update(await readFile(absolutePath));
		hash.update("\0");
		return;
	}
	if (!metadata.isDirectory()) throw new Error(`Memory freshness path has an unsupported file type: ${relativePath}`);
	hash.update(`directory\0${relativePath}\0`);
	const entries = await readdir(absolutePath, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) await appendPathDigest(hash, root, resolve(absolutePath, entry.name));
}

async function pathDigest(root: string, scopePath: string): Promise<string | undefined> {
	const absolutePath = resolve(root, scopePath);
	if (normalizedRelative(root, absolutePath) !== scopePath) {
		throw new Error("Memory freshness scope path is not normalized");
	}
	const hash = createHash("sha256");
	try {
		await appendPathDigest(hash, root, absolutePath);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	return `sha256:${hash.digest("hex")}`;
}

export async function captureGitFreshnessBasis(
	projectRoot: string,
	scopePaths: readonly string[],
): Promise<GitFreshnessBasisV1> {
	const context = await repositoryContext(projectRoot);
	const baselineCommit = (
		await execFile("git", ["rev-parse", "HEAD"], { cwd: context.root, encoding: "utf8" })
	).stdout.trim();
	const pathDigests = [];
	for (const path of scopePaths) {
		const digest = await pathDigest(context.root, path);
		if (!digest) throw new Error(`Memory freshness source path does not exist: ${path}`);
		pathDigests.push({ path, digest });
	}
	return validateGitFreshnessBasisV1({
		schema: MEMORY_GIT_FRESHNESS_SCHEMA,
		repositoryId: context.repositoryId,
		baselineCommit,
		scopePaths: [...scopePaths],
		pathDigests,
	});
}

export async function resolveGitFreshness(
	projectRoot: string,
	basisInput: GitFreshnessBasisV1,
): Promise<MemoryFreshness> {
	const basis = validateGitFreshnessBasisV1(basisInput);
	try {
		const context = await repositoryContext(projectRoot);
		if (context.repositoryId !== basis.repositoryId) return "unknown";
		await execFile("git", ["cat-file", "-e", `${basis.baselineCommit}^{commit}`], { cwd: context.root });
		for (const [index, path] of basis.scopePaths.entries()) {
			const current = await pathDigest(context.root, path);
			if (!current || current !== basis.pathDigests[index]?.digest) return "stale";
		}
		return "current";
	} catch {
		return "unknown";
	}
}
