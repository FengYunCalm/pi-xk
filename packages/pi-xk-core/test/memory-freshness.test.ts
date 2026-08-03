import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureGitFreshnessBasis,
	resolveGitFreshness,
	resolveGitRepositoryId,
	verifyGitEvidenceLocator,
} from "../src/index.ts";

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

async function createRepository(): Promise<string> {
	const root = join(tmpdir(), `pi-xk-memory-freshness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(root, "src"), { recursive: true });
	tempDirs.push(root);
	await execFile("git", ["init", "--quiet"], { cwd: root });
	await execFile("git", ["config", "user.email", "pi-xk@example.invalid"], { cwd: root });
	await execFile("git", ["config", "user.name", "Pi-XK Test"], { cwd: root });
	await writeFile(join(root, "src", "memory.ts"), "export const value = 1;\n");
	await writeFile(join(root, "README.md"), "baseline\n");
	await execFile("git", ["add", "src/memory.ts", "README.md"], { cwd: root });
	await execFile("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
	return root;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const directory = tempDirs.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("Memory Git freshness", () => {
	it("scopes freshness to captured paths instead of the whole worktree", async () => {
		const root = await createRepository();
		const basis = await captureGitFreshnessBasis(root, ["src/memory.ts"]);
		expect(await resolveGitFreshness(root, basis)).toBe("current");

		await writeFile(join(root, "README.md"), "unrelated dirty change\n");
		expect(await resolveGitFreshness(root, basis)).toBe("current");

		await writeFile(join(root, "src", "memory.ts"), "export const value = 2;\n");
		expect(await resolveGitFreshness(root, basis)).toBe("stale");
	});

	it("returns stale for a missing source and unknown for a different repository identity", async () => {
		const root = await createRepository();
		const basis = await captureGitFreshnessBasis(root, ["src/memory.ts"]);
		await rm(join(root, "src", "memory.ts"));
		expect(await resolveGitFreshness(root, basis)).toBe("stale");
		expect(await resolveGitFreshness(root, { ...basis, repositoryId: "repo_different" })).toBe("unknown");
	});

	it("rejects Git evidence from another repository, an unknown commit, or a missing baseline path", async () => {
		const root = await createRepository();
		const basis = await captureGitFreshnessBasis(root, ["src/memory.ts"]);

		await expect(
			verifyGitEvidenceLocator(root, {
				repositoryId: "repo_different",
				baselineCommit: basis.baselineCommit,
				scopePaths: basis.scopePaths,
			}),
		).rejects.toThrow("another repository");
		await expect(
			verifyGitEvidenceLocator(root, {
				repositoryId: basis.repositoryId,
				baselineCommit: "f".repeat(40),
				scopePaths: basis.scopePaths,
			}),
		).rejects.toThrow();
		await expect(
			verifyGitEvidenceLocator(root, {
				repositoryId: basis.repositoryId,
				baselineCommit: basis.baselineCommit,
				scopePaths: ["src/missing.ts"],
			}),
		).rejects.toThrow();
	});

	it("uses the repository remote as a stable cross-worktree identity", async () => {
		const first = await createRepository();
		const second = await createRepository();
		await execFile("git", ["remote", "add", "origin", "https://example.invalid/shared/repository.git"], {
			cwd: first,
		});
		await execFile("git", ["remote", "add", "origin", "https://example.invalid/shared/repository.git"], {
			cwd: second,
		});

		expect(await resolveGitRepositoryId(first)).toBe(await resolveGitRepositoryId(second));
		expect(await resolveGitRepositoryId(join(first, "missing"))).toBeNull();
	});
});
