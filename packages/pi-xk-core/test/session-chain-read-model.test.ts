import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SESSION_CHAIN_SPEC_SCHEMA,
	type SessionChainSpecV1,
	type SessionSegmentDescriptorV1,
} from "../src/session-chain-contract.ts";
import { SessionChainReadModelStaleError } from "../src/session-chain-read-model.ts";
import { SessionChainStore } from "../src/session-chain-store.ts";

const tempDirs: string[] = [];

function spec(chainId: string): SessionChainSpecV1 {
	return {
		schema: SESSION_CHAIN_SPEC_SCHEMA,
		chainId,
		title: "Original title",
		cwd: "/project",
		rootBranchId: "branch_main",
		rootSegment: {
			segmentId: "session-root",
			ordinal: 1,
			location: { kind: "managed", fileName: "000001_session-root.jsonl" },
			predecessorSegmentId: null,
			summaryInArtifactId: null,
			createdAt: "2026-07-22T00:00:00.000Z",
		},
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

async function storeForTest(): Promise<{ store: SessionChainStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-chain-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new SessionChainStore(projectRoot), projectRoot };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("Session Chain read models", () => {
	it("rebuilds chain and catalog projections from event facts", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_rebuild");
		const created = await store.createChain(chain, {
			eventId: "event-created",
			idempotencyKey: "create:chain_rebuild",
		});
		const branchSegment: SessionSegmentDescriptorV1 = {
			segmentId: "session-branch",
			ordinal: 1,
			location: { kind: "managed", fileName: "000001_session-branch.jsonl" },
			predecessorSegmentId: "session-root",
			summaryInArtifactId: null,
			createdAt: "2026-07-22T00:01:00.000Z",
		};
		const branched = await store.appendBranchCreated(
			chain.chainId,
			{
				branchId: "branch_review",
				fromBranchId: "branch_main",
				sourceSegmentId: "session-root",
				sourceEntryId: "entry-review",
				segment: branchSegment,
			},
			{
				eventId: "event-branch",
				idempotencyKey: "branch:review",
				expectedHead: created.head,
			},
		);
		await store.appendMetadataUpdated(
			chain.chainId,
			{ title: "Renamed title" },
			{
				eventId: "event-metadata",
				idempotencyKey: "metadata:title",
				expectedHead: branched.head,
			},
		);

		const readModelPath = join(projectRoot, ".pi-xk", "sessions", "chains", chain.chainId, "chain-read-model.json");
		await rm(readModelPath);
		const rebuilt = await store.rebuildChainReadModel(chain.chainId);
		expect(rebuilt.title).toBe("Renamed title");
		expect(rebuilt.branches.map((branch) => branch.branchId)).toEqual(["branch_main", "branch_review"]);
		expect(JSON.parse(await readFile(readModelPath, "utf8"))).toEqual(rebuilt);

		await rm(join(projectRoot, ".pi-xk", "sessions", "catalog.json"));
		const catalog = await store.rebuildCatalog();
		expect(catalog.chains).toEqual([
			expect.objectContaining({
				chainId: chain.chainId,
				title: "Renamed title",
				branchHeads: [
					{ branchId: "branch_main", segmentId: "session-root" },
					{ branchId: "branch_review", segmentId: "session-branch" },
				],
			}),
		]);
	});

	it("rejects a stale read model", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_stale_projection");
		await store.createChain(chain, { eventId: "event-created", idempotencyKey: "create:stale" });
		const readModelPath = join(projectRoot, ".pi-xk", "sessions", "chains", chain.chainId, "chain-read-model.json");
		const stored = JSON.parse(await readFile(readModelPath, "utf8")) as Record<string, unknown>;
		stored.title = "Tampered";
		await writeFile(readModelPath, `${JSON.stringify(stored)}\n`);
		await expect(store.loadChainReadModel(chain.chainId)).rejects.toBeInstanceOf(SessionChainReadModelStaleError);
	});
});
