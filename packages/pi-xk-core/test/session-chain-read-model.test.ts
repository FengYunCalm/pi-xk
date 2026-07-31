import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SESSION_CHAIN_SPEC_SCHEMA,
	type SessionChainSpecV1,
	type SessionSegmentDescriptorV1,
} from "../src/session-chain-contract.ts";
import { SessionChainReadModelStaleError } from "../src/session-chain-read-model.ts";
import { SessionChainCorruptionError, SessionChainStore } from "../src/session-chain-store.ts";

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

	it("reads only the event tail and then verifies the checkpoint head on the fast path", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_incremental_projection");
		const created = await store.createChain(chain, {
			eventId: "event-created",
			idempotencyKey: "create:incremental",
		});
		const chainDirectory = join(projectRoot, ".pi-xk", "sessions", "chains", chain.chainId);
		const readModelPath = join(chainDirectory, "chain-read-model.json");
		const checkpointPath = join(chainDirectory, "chain-read-model.checkpoint.json");
		const eventsPath = join(chainDirectory, "events.jsonl");
		const originalReadModel = await readFile(readModelPath, "utf8");
		const originalCheckpoint = await readFile(checkpointPath, "utf8");

		await store.appendMetadataUpdated(
			chain.chainId,
			{ title: "Tail title" },
			{
				eventId: "event-tail",
				idempotencyKey: "metadata:tail",
				expectedHead: created.head,
			},
		);
		await writeFile(readModelPath, originalReadModel);
		await writeFile(checkpointPath, originalCheckpoint);

		const recovered = await store.loadChainReadModelSnapshot(chain.chainId);
		expect(recovered.readModel).toMatchObject({ sequence: 2, title: "Tail title" });
		expect(recovered.diagnostic.mode).toBe("tail");
		expect(recovered.diagnostic.bytesRead).toBeGreaterThan(0);
		expect(recovered.diagnostic.bytesRead).toBeLessThanOrEqual((await stat(eventsPath)).size);

		const fast = await store.loadChainReadModelSnapshot(chain.chainId);
		expect(fast.readModel).toMatchObject({ sequence: 2, title: "Tail title" });
		expect(fast.diagnostic.mode).toBe("fast");
		expect(fast.diagnostic.bytesRead).toBeGreaterThan(0);
		expect(fast.diagnostic.bytesRead).toBeLessThan((await stat(eventsPath)).size);
	});

	it("repairs a stale catalog entry while serving a valid fast read model", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_catalog_fast_repair");
		const created = await store.createChain(chain, {
			eventId: "event-created",
			idempotencyKey: "create:catalog-fast-repair",
		});
		const catalogPath = join(projectRoot, ".pi-xk", "sessions", "catalog.json");
		const staleCatalog = await readFile(catalogPath, "utf8");
		await store.appendMetadataUpdated(
			chain.chainId,
			{ title: "Current title" },
			{
				eventId: "event-current-title",
				idempotencyKey: "metadata:current-title",
				expectedHead: created.head,
			},
		);
		await writeFile(catalogPath, staleCatalog);

		const loaded = await store.loadChainReadModelSnapshot(chain.chainId);
		expect(loaded.diagnostic.mode).toBe("fast");
		expect((await store.listChains())[0]).toMatchObject({ title: "Current title", sequence: 2 });
	});

	it("rejects an in-place mutation of the checkpoint head event", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_checkpoint_head_tamper");
		await store.createChain(chain, {
			eventId: "event-created",
			idempotencyKey: "create:head-tamper",
		});
		const eventsPath = join(projectRoot, ".pi-xk", "sessions", "chains", chain.chainId, "events.jsonl");
		const original = await readFile(eventsPath, "utf8");
		const tampered = original.replace("event-created", "event-altered");
		expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
		await writeFile(eventsPath, tampered);

		await expect(store.loadChainReadModelSnapshot(chain.chainId)).rejects.toBeInstanceOf(SessionChainCorruptionError);
	});

	it("upgrades an old read model without a checkpoint through verified full replay", async () => {
		const { store, projectRoot } = await storeForTest();
		const chain = spec("chain_checkpoint_upgrade");
		await store.createChain(chain, { eventId: "event-created", idempotencyKey: "create:upgrade" });
		const checkpointPath = join(
			projectRoot,
			".pi-xk",
			"sessions",
			"chains",
			chain.chainId,
			"chain-read-model.checkpoint.json",
		);
		await rm(checkpointPath);

		const upgraded = await store.loadChainReadModelSnapshot(chain.chainId);
		expect(upgraded.diagnostic.mode).toBe("full");
		expect(upgraded.diagnostic.bytesRead).toBeGreaterThan(0);
		await expect(stat(checkpointPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
	});
});
