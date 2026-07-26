import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CHAIN_ROLLUP_SCHEMA,
	SEGMENT_SUMMARY_SCHEMA,
	SESSION_CHAIN_SPEC_SCHEMA,
	type SegmentSummaryV1,
	type SessionChainRollupV1,
	type SessionChainSpecV1,
	type SessionSegmentDescriptorV1,
} from "../src/session-chain-contract.ts";
import {
	SessionChainHeadConflictError,
	SessionChainIdempotencyConflictError,
	SessionChainLifecycleTransitionError,
	SessionChainLockedError,
	SessionChainRecoveryRequiredError,
	SessionChainStore,
} from "../src/session-chain-store.ts";

const tempDirs: string[] = [];

function rootSegment(): SessionSegmentDescriptorV1 {
	return {
		segmentId: "session-root",
		ordinal: 1,
		location: { kind: "managed", fileName: "000001_session-root.jsonl" },
		predecessorSegmentId: null,
		summaryInArtifactId: null,
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function createSpec(chainId: string): SessionChainSpecV1 {
	return {
		schema: SESSION_CHAIN_SPEC_SCHEMA,
		chainId,
		title: "Long-running work",
		cwd: "/project",
		rootBranchId: "branch_main",
		rootSegment: rootSegment(),
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function createSummary(chainId: string): SegmentSummaryV1 {
	return {
		schema: SEGMENT_SUMMARY_SCHEMA,
		chainId,
		branchId: "branch_main",
		sourceSegmentId: "session-root",
		sourceLeafId: "leaf-root",
		targetSegmentId: "session-next",
		baseSummaryArtifactId: null,
		sourceRange: {
			firstEntryId: "entry-first",
			lastEntryId: "leaf-root",
			entryCount: 4,
			entriesHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		segmentDeltaMarkdown: "## Segment delta\n\n- Core contract complete.",
		carryForwardMarkdown: "## Carry forward\n\nImplement host rollover.",
		generator: {
			provider: "faux",
			modelId: "faux-model",
			promptVersion: "session-chain-summary-v1",
			inputTokens: 800,
			outputTokens: 160,
			generatedAt: "2026-07-22T00:01:00.000Z",
		},
	};
}

function createRollup(chainId: string, summaryArtifactId: string): SessionChainRollupV1 {
	return {
		schema: CHAIN_ROLLUP_SCHEMA,
		chainId,
		branchId: "branch_main",
		windowIndex: 1,
		startOrdinal: 1,
		endOrdinal: 1,
		segmentIds: ["session-root"],
		summaryArtifactIds: [summaryArtifactId],
		sourceDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		rollup: {
			state: "The first Segment is sealed.",
			decisions: ["Publish a Rollup event."],
			constraints: ["Keep v1 events unchanged."],
			completed: ["Window one was summarized."],
			unresolved: [],
			nextActions: ["Continue with S2."],
		},
		provenance: {
			generator: "pi-xk",
			model: "faux/faux-model",
			promptVersion: "session-chain-rollup-v1",
			generatedAt: "2026-07-22T00:04:00.000Z",
		},
	};
}

async function createStore(): Promise<{ store: SessionChainStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("SessionChainStore", () => {
	it("prepares and commits one hash-chained rollover", async () => {
		const { store } = await createStore();
		const spec = createSpec("chain_happy_path");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_happy_path",
		});
		const summaryArtifactId = await store.putSegmentSummary(createSummary(spec.chainId));
		const target: SessionSegmentDescriptorV1 = {
			segmentId: "session-next",
			ordinal: 2,
			location: { kind: "managed", fileName: "000002_session-next.jsonl" },
			predecessorSegmentId: "session-root",
			summaryInArtifactId: summaryArtifactId,
			createdAt: "2026-07-22T00:02:00.000Z",
		};
		const prepared = await store.appendRolloverPrepared(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				sourceLeafId: "leaf-root",
				targetSegment: target,
				summaryArtifactId,
				reason: "soft-threshold",
			},
			{
				eventId: "event-prepared",
				idempotencyKey: "rollover:prepare",
				expectedHead: created.head,
				timestamp: "2026-07-22T00:02:00.000Z",
			},
		);
		await store.appendRolloverCommitted(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				targetSegmentId: "session-next",
				sourceSeal: {
					bytes: 4096,
					fileHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					leafId: "summary-out-entry",
					summaryArtifactId,
					summaryOutEntryId: "summary-out-entry",
				},
				targetMarkers: {
					chainLinkEntryId: "chain-link-entry",
					summaryInEntryId: "summary-in-entry",
				},
			},
			{
				eventId: "event-committed",
				idempotencyKey: "rollover:commit",
				expectedHead: prepared.head,
				timestamp: "2026-07-22T00:03:00.000Z",
			},
		);

		const replay = await store.replayChain(spec.chainId);
		const branch = replay.branches.find((candidate) => candidate.branchId === "branch_main");
		expect(replay.events.map((event) => event.eventType)).toEqual([
			"chain_created",
			"rollover_prepared",
			"rollover_committed",
		]);
		expect(branch?.headSegmentId).toBe("session-next");
		expect(branch?.segments.map((segment) => [segment.segmentId, segment.status])).toEqual([
			["session-root", "sealed"],
			["session-next", "active"],
		]);
		expect(branch?.pendingRollover).toBeUndefined();
	});

	it("replays mixed v1 and v2 events with a verified Rollup artifact", async () => {
		const { store } = await createStore();
		const spec = createSpec("chain_rollup_events");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_rollup_events",
		});
		const summaryArtifactId = await store.putSegmentSummary(createSummary(spec.chainId));
		const target: SessionSegmentDescriptorV1 = {
			segmentId: "session-next",
			ordinal: 2,
			location: { kind: "managed", fileName: "000002_session-next.jsonl" },
			predecessorSegmentId: "session-root",
			summaryInArtifactId: summaryArtifactId,
			createdAt: "2026-07-22T00:02:00.000Z",
		};
		const prepared = await store.appendRolloverPrepared(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				sourceLeafId: "leaf-root",
				targetSegment: target,
				summaryArtifactId,
				reason: "rollup fixture",
			},
			{
				eventId: "event-prepared",
				idempotencyKey: "rollup-fixture:prepared",
				expectedHead: created.head,
			},
		);
		const committed = await store.appendRolloverCommitted(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				targetSegmentId: "session-next",
				sourceSeal: {
					bytes: 4096,
					fileHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					leafId: "summary-out-entry",
					summaryArtifactId,
					summaryOutEntryId: "summary-out-entry",
				},
				targetMarkers: { chainLinkEntryId: "chain-link-entry", summaryInEntryId: "summary-in-entry" },
			},
			{
				eventId: "event-committed",
				idempotencyKey: "rollup-fixture:committed",
				expectedHead: prepared.head,
			},
		);
		const rollup = createRollup(spec.chainId, summaryArtifactId);
		const artifactId = await store.putChainRollup(rollup);
		expect(
			await store.findChainRollupArtifacts({
				chainId: spec.chainId,
				branchId: "branch_main",
				windowIndex: 1,
				sourceDigest: rollup.sourceDigest,
			}),
		).toEqual([artifactId]);
		const published = await store.appendRollupPublished(
			spec.chainId,
			{
				branchId: "branch_main",
				windowIndex: 1,
				startOrdinal: 1,
				endOrdinal: 1,
				artifactId,
				sourceDigest: rollup.sourceDigest,
			},
			{
				eventId: "event-rollup",
				idempotencyKey: "rollup-fixture:published",
				expectedHead: committed.head,
			},
		);
		await store.appendMetadataUpdated(
			spec.chainId,
			{ title: "After Rollup" },
			{
				eventId: "event-after-rollup",
				idempotencyKey: "rollup-fixture:metadata",
				expectedHead: published.head,
			},
		);

		const replay = await store.replayChain(spec.chainId);
		expect(replay.events.map((event) => [event.schemaVersion, event.eventType])).toEqual([
			[1, "chain_created"],
			[1, "rollover_prepared"],
			[1, "rollover_committed"],
			[2, "rollup_published"],
			[1, "chain_metadata_updated"],
		]);
		expect(replay.branches[0]?.rollups).toEqual([
			expect.objectContaining({ artifactId, windowIndex: 1, startOrdinal: 1, endOrdinal: 1 }),
		]);
		expect(await store.readChainRollup(artifactId)).toEqual(rollup);
	});

	it("replays a v3 archive event without changing historical v1 events", async () => {
		const { store } = await createStore();
		const spec = createSpec("chain_archive_event");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:archive",
		});
		await store.appendArchiveUpdated(
			spec.chainId,
			{ archived: true },
			{
				eventId: "event-archived",
				idempotencyKey: "archive:true",
				expectedHead: created.head,
			},
		);

		const replay = await store.replayChain(spec.chainId);
		expect(replay.archived).toBe(true);
		expect(replay.events.map((event) => [event.schemaVersion, event.eventType])).toEqual([
			[1, "chain_created"],
			[3, "chain_archive_updated"],
		]);
		expect(await store.loadChainReadModel(spec.chainId)).toMatchObject({ archived: true });
		expect(await store.listChains()).toEqual([expect.objectContaining({ chainId: spec.chainId, archived: true })]);
	});

	it("deduplicates retries and rejects stale heads and invalid transitions", async () => {
		const { store } = await createStore();
		const spec = createSpec("chain_guards");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_guards",
		});
		const retry = await store.createChain(spec, {
			eventId: "event-retry",
			idempotencyKey: "create:chain_guards",
		});
		expect(retry).toEqual(created);
		await expect(
			store.createChain(
				{ ...spec, title: "Different title" },
				{ eventId: "event-conflict", idempotencyKey: "create:chain_guards" },
			),
		).rejects.toBeInstanceOf(SessionChainIdempotencyConflictError);
		await expect(
			store.appendRolloverAborted(
				spec.chainId,
				{
					branchId: "branch_main",
					sourceSegmentId: "session-root",
					targetSegmentId: "session-next",
					reason: "nothing prepared",
				},
				{
					eventId: "event-abort",
					idempotencyKey: "rollover:abort",
					expectedHead: created.head,
				},
			),
		).rejects.toBeInstanceOf(SessionChainLifecycleTransitionError);
		await expect(
			store.appendMetadataUpdated(
				spec.chainId,
				{ title: "Renamed" },
				{
					eventId: "event-stale",
					idempotencyKey: "metadata:stale",
					expectedHead: { sequence: 0, hash: "sha256:stale" },
				},
			),
		).rejects.toBeInstanceOf(SessionChainHeadConflictError);
	});

	it("aborts a prepared rollover without publishing the staged target", async () => {
		const { store } = await createStore();
		const spec = createSpec("chain_abort");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_abort",
		});
		const summaryArtifactId = await store.putSegmentSummary(createSummary(spec.chainId));
		const prepared = await store.appendRolloverPrepared(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				sourceLeafId: "leaf-root",
				targetSegment: {
					segmentId: "session-next",
					ordinal: 2,
					location: { kind: "managed", fileName: "000002_session-next.jsonl" },
					predecessorSegmentId: "session-root",
					summaryInArtifactId: summaryArtifactId,
					createdAt: "2026-07-22T00:02:00.000Z",
				},
				summaryArtifactId,
				reason: "manual",
			},
			{
				eventId: "event-prepared",
				idempotencyKey: "rollover:prepare",
				expectedHead: created.head,
			},
		);
		await store.appendRolloverAborted(
			spec.chainId,
			{
				branchId: "branch_main",
				sourceSegmentId: "session-root",
				targetSegmentId: "session-next",
				reason: "target file could not be published",
			},
			{
				eventId: "event-aborted",
				idempotencyKey: "rollover:abort",
				expectedHead: prepared.head,
			},
		);

		const branch = (await store.replayChain(spec.chainId)).branches[0];
		expect(branch?.headSegmentId).toBe("session-root");
		expect(branch?.segments).toEqual([expect.objectContaining({ segmentId: "session-root", status: "active" })]);
		expect(branch?.pendingRollover).toBeUndefined();
	});

	it("serializes concurrent writers and lets CAS reject the stale mutation", async () => {
		const { store, projectRoot } = await createStore();
		const otherStore = new SessionChainStore(projectRoot);
		const spec = createSpec("chain_concurrent");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_concurrent",
		});
		const results = await Promise.allSettled([
			store.appendMetadataUpdated(
				spec.chainId,
				{ title: "Writer A" },
				{
					eventId: "event-a",
					idempotencyKey: "metadata:a",
					expectedHead: created.head,
				},
			),
			otherStore.appendMetadataUpdated(
				spec.chainId,
				{ title: "Writer B" },
				{
					eventId: "event-b",
					idempotencyKey: "metadata:b",
					expectedHead: created.head,
				},
			),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
			SessionChainHeadConflictError,
		);
		expect((await store.replayChain(spec.chainId)).events).toHaveLength(2);
	});

	it("repairs missing projections when an append is retried idempotently", async () => {
		const { store, projectRoot } = await createStore();
		const spec = createSpec("chain_retry_repair");
		const created = await store.createChain(spec, {
			eventId: "event-created",
			idempotencyKey: "create:chain_retry_repair",
		});
		const options = {
			eventId: "event-metadata",
			idempotencyKey: "metadata:repair",
			expectedHead: created.head,
			timestamp: "2026-07-22T00:04:00.000Z",
		};
		const first = await store.appendMetadataUpdated(spec.chainId, { title: "Repaired" }, options);
		const chainDirectory = join(projectRoot, ".pi-xk", "sessions", "chains", spec.chainId);
		await rm(join(chainDirectory, "chain-read-model.json"));
		await rm(join(projectRoot, ".pi-xk", "sessions", "catalog.json"));

		const retry = await store.appendMetadataUpdated(spec.chainId, { title: "Repaired" }, options);
		expect(retry).toEqual(first);
		expect(JSON.parse(await readFile(join(chainDirectory, "chain-read-model.json"), "utf8"))).toMatchObject({
			title: "Repaired",
			baseHash: first.head.hash,
		});
		expect(JSON.parse(await readFile(join(projectRoot, ".pi-xk", "sessions", "catalog.json"), "utf8"))).toMatchObject(
			{
				chains: [expect.objectContaining({ chainId: spec.chainId, title: "Repaired" })],
			},
		);
	});

	it("diagnoses and repairs a trailing partial event", async () => {
		const { store, projectRoot } = await createStore();
		const spec = createSpec("chain_partial_tail");
		await store.createChain(spec, { eventId: "event-created", idempotencyKey: "create:partial" });
		const eventsPath = join(projectRoot, ".pi-xk", "sessions", "chains", spec.chainId, "events.jsonl");
		await appendFile(eventsPath, '{"schema":"pi-xk.session-chain-event.v1"');

		const replay = await store.replayChain(spec.chainId);
		expect(replay.tailDiagnostic?.discardedBytes).toBeGreaterThan(0);
		await expect(
			store.appendMetadataUpdated(
				spec.chainId,
				{ title: "Blocked" },
				{
					eventId: "event-metadata",
					idempotencyKey: "metadata:partial",
					expectedHead: replay.head,
				},
			),
		).rejects.toBeInstanceOf(SessionChainRecoveryRequiredError);

		const repaired = await store.repairTrailingPartialEvent(spec.chainId);
		expect(repaired.tailDiagnostic).toBeUndefined();
		expect(await readFile(eventsPath, "utf8")).toMatch(/\n$/);
	});

	it("fails closed and explicitly repairs an abandoned Session Chain write lock", async () => {
		const { store, projectRoot } = await createStore();
		const spec = createSpec("chain_abandoned_lock");
		const created = await store.createChain(spec, { eventId: "event-created", idempotencyKey: "create:lock" });
		const lockPath = join(projectRoot, ".pi-xk", "sessions", "chains", spec.chainId, "locks", "write.lock");
		await writeFile(
			lockPath,
			`${JSON.stringify({ pid: 999_999_999, nonce: "abandoned-chain", createdAt: "2026-07-22T00:01:00.000Z" })}\n`,
		);

		await expect(
			store.appendMetadataUpdated(
				spec.chainId,
				{ title: "Must remain locked" },
				{
					eventId: "event-metadata-locked",
					idempotencyKey: "metadata:locked",
					expectedHead: created.head,
				},
			),
		).rejects.toBeInstanceOf(SessionChainLockedError);
		expect(await store.inspectWriteLock(spec.chainId)).toMatchObject({
			nonce: "abandoned-chain",
			ownerState: "missing",
			malformed: false,
		});
		await expect(store.repairAbandonedWriteLock(spec.chainId, "wrong-owner")).rejects.toThrow("conflicted");
		await expect(store.repairAbandonedWriteLock(spec.chainId, "abandoned-chain")).resolves.toBe(true);
		await expect(
			store.appendMetadataUpdated(
				spec.chainId,
				{ title: "Recovered" },
				{
					eventId: "event-metadata-recovered",
					idempotencyKey: "metadata:recovered",
					expectedHead: created.head,
				},
			),
		).resolves.toMatchObject({ head: { sequence: 2 } });
	});

	it("serializes Rollup generation across Store instances", async () => {
		const { store, projectRoot } = await createStore();
		const secondStore = new SessionChainStore(projectRoot);
		const chainId = "chain_rollup_generation_lock";
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted = false;
		let secondStarted = false;
		const first = store.withRollupGenerationLock(chainId, "branch_main", 1, async () => {
			firstStarted = true;
			await firstGate;
			return "first";
		});
		while (!firstStarted) await new Promise<void>((resolve) => setTimeout(resolve, 5));
		const second = secondStore.withRollupGenerationLock(chainId, "branch_main", 1, async () => {
			secondStarted = true;
			return "second";
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		expect(secondStarted).toBe(false);

		releaseFirst?.();
		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
	});

	it("fails closed and CAS-repairs abandoned Rollup generation locks", async () => {
		const { store, projectRoot } = await createStore();
		const secondStore = new SessionChainStore(projectRoot);
		const chainId = "chain_rollup_generation_repair";
		const lockDirectory = join(
			projectRoot,
			".pi-xk",
			"sessions",
			"chains",
			chainId,
			"branches",
			"branch_main",
			"rollups",
		);
		const lockPath = join(lockDirectory, "000001.generation.lock");
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(
			lockPath,
			`${JSON.stringify({ pid: 999_999_999, nonce: "abandoned-rollup", createdAt: "2026-07-22T00:01:00.000Z" })}\n`,
		);

		expect(await store.inspectRollupGenerationLock(chainId, "branch_main", 1)).toMatchObject({
			nonce: "abandoned-rollup",
			ownerState: "missing",
			malformed: false,
		});
		await expect(store.repairAbandonedRollupGenerationLock(chainId, "branch_main", 1, "wrong-owner")).rejects.toThrow(
			"conflicted",
		);
		const recoveries = await Promise.allSettled([
			store.repairAbandonedRollupGenerationLock(chainId, "branch_main", 1, "abandoned-rollup"),
			secondStore.repairAbandonedRollupGenerationLock(chainId, "branch_main", 1, "abandoned-rollup"),
		]);
		expect(recoveries.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(1);
		expect(await store.inspectRollupGenerationLock(chainId, "branch_main", 1)).toBeUndefined();

		await writeFile(
			lockPath,
			`${JSON.stringify({ pid: process.pid, nonce: "live-rollup", createdAt: "2026-07-22T00:02:00.000Z" })}\n`,
		);
		await expect(store.repairAbandonedRollupGenerationLock(chainId, "branch_main", 1, "live-rollup")).rejects.toThrow(
			"owner is alive",
		);
		await writeFile(lockPath, "not-json\n");
		expect(await store.inspectRollupGenerationLock(chainId, "branch_main", 1)).toMatchObject({
			ownerState: "unknown",
			malformed: true,
		});
		await expect(store.repairAbandonedRollupGenerationLock(chainId, "branch_main", 1, "live-rollup")).rejects.toThrow(
			"malformed",
		);
	});
});
