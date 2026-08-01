import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ArtifactCorruptionError,
	ArtifactInputError,
	ArtifactNotFoundError,
	ArtifactStore,
	ArtifactValidationError,
	redactArtifactText,
} from "../src/index.ts";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: ArtifactStore; projectRoot: string }> {
	const projectRoot = join(tmpdir(), `pi-xk-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(projectRoot, { recursive: true });
	tempDirs.push(projectRoot);
	return { store: new ArtifactStore(projectRoot), projectRoot };
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
});

describe("ArtifactStore", () => {
	it("keeps repeated secret redaction canonical", () => {
		const once = redactArtifactText('{"statement":"Use token=secretvalue123 as a fixture."}').content;
		expect(redactArtifactText(once).content).toBe(once);
		expect(once).toContain("token=[REDACTED]");
	});

	it("stores a redacted immutable JSON artifact with durable metadata", async () => {
		const { store, projectRoot } = await createStore();
		const secret = "sk-secret-12345678901234567890";
		const metadata = await store.put({
			contentType: "application/json",
			value: { sourceLeafId: "leaf-tool-result", token: secret, summary: "tool result persisted" },
			producer: "pi-xk.checkpoint-evidence.v1",
			sensitivity: "redacted",
			sourceIds: ["session-1", "leaf-tool-result"],
			createdAt: "2026-07-20T00:00:01.000Z",
		});

		expect(metadata).toMatchObject({
			schema: "pi-xk.artifact.v1",
			artifactId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			contentType: "application/json",
			producer: "pi-xk.checkpoint-evidence.v1",
			sensitivity: "redacted",
			redactionVersion: "pi-xk.redaction.v1",
			sourceIds: ["session-1", "leaf-tool-result"],
		});

		const stored = await store.read(metadata.artifactId);
		const dataPath = join(
			projectRoot,
			".pi-xk",
			"artifacts",
			"objects",
			metadata.artifactId.slice("sha256:".length, "sha256:".length + 2),
			`${metadata.artifactId.slice("sha256:".length)}.data`,
		);
		const raw = await readFile(dataPath, "utf8");

		expect(stored.metadata).toEqual(metadata);
		expect(stored.content).not.toContain(secret);
		expect(stored.content).toContain("[REDACTED]");
		expect(raw).not.toContain(secret);
	});

	it("reuses identical content without replacing its first immutable metadata", async () => {
		const { store } = await createStore();
		const first = await store.put({
			contentType: "text/plain",
			text: "stable evidence",
			producer: "pi-xk.checkpoint-evidence.v1",
			sensitivity: "internal",
			sourceIds: ["leaf-first"],
			createdAt: "2026-07-20T00:00:01.000Z",
		});
		const retry = await store.put({
			contentType: "text/plain",
			text: "stable evidence",
			producer: "pi-xk.another-producer.v1",
			sensitivity: "redacted",
			sourceIds: ["leaf-second"],
			createdAt: "2026-07-20T00:00:02.000Z",
		});

		expect(retry).toEqual(first);
	});

	it("serializes concurrent same-content publication without exposing a partial object", async () => {
		const { store } = await createStore();
		const writes = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.put({
					contentType: "application/json",
					value: { sourceLeafId: "leaf-concurrent", result: "stable" },
					producer: "pi-xk.checkpoint-evidence.v1",
					sensitivity: "redacted",
					sourceIds: [`source-${index}`],
					createdAt: `2026-07-20T00:00:0${index}.000Z`,
				}),
			),
		);

		expect(new Set(writes.map((metadata) => metadata.artifactId)).size).toBe(1);
		expect(new Set(writes.map((metadata) => JSON.stringify(metadata))).size).toBe(1);
		await expect(store.read(writes[0]?.artifactId ?? "")).resolves.toMatchObject({ content: expect.any(String) });
	});

	it("rejects unsafe inputs and artifact IDs instead of accepting arbitrary paths", async () => {
		const { store } = await createStore();
		await expect(
			store.put({
				contentType: "text/plain",
				text: "unsafe\0content",
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-1"],
				createdAt: "2026-07-20T00:00:01.000Z",
			}),
		).rejects.toBeInstanceOf(ArtifactInputError);
		await expect(store.read("sha256:../../etc/passwd")).rejects.toBeInstanceOf(ArtifactValidationError);
	});

	it("detects a tampered immutable object before returning it", async () => {
		const { store, projectRoot } = await createStore();
		const metadata = await store.put({
			contentType: "text/plain",
			text: "verified evidence",
			producer: "pi-xk.checkpoint-evidence.v1",
			sensitivity: "internal",
			sourceIds: ["leaf-tamper"],
			createdAt: "2026-07-20T00:00:01.000Z",
		});
		const digest = metadata.artifactId.slice("sha256:".length);
		await writeFile(
			join(projectRoot, ".pi-xk", "artifacts", "objects", digest.slice(0, 2), `${digest}.data`),
			"tampered",
		);

		await expect(store.read(metadata.artifactId)).rejects.toBeInstanceOf(ArtifactCorruptionError);
	});

	it("keeps failure boundaries diagnosable across fsync, publish, and directory sync", async () => {
		const { projectRoot } = await createStore();
		const dataFsyncStore = new ArtifactStore(projectRoot, {
			onWritePhase: (phase) => {
				if (phase === "data_fsync") throw new Error("injected data fsync failure");
			},
		});
		const dataContent = "data-fsync-evidence";
		const dataArtifactId = `sha256:${createHash("sha256").update(dataContent).digest("hex")}`;
		await expect(
			dataFsyncStore.put({
				contentType: "text/plain",
				text: dataContent,
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-data-fsync"],
				createdAt: "2026-07-20T00:00:01.000Z",
			}),
		).rejects.toThrow("injected data fsync failure");
		await expect(dataFsyncStore.read(dataArtifactId)).rejects.toBeInstanceOf(ArtifactNotFoundError);

		const metadataPublishStore = new ArtifactStore(projectRoot, {
			onWritePhase: (phase) => {
				if (phase === "metadata_publish") throw new Error("injected metadata publish failure");
			},
		});
		const metadataContent = "metadata-publish-evidence";
		const metadataArtifactId = `sha256:${createHash("sha256").update(metadataContent).digest("hex")}`;
		await expect(
			metadataPublishStore.put({
				contentType: "text/plain",
				text: metadataContent,
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-metadata-publish"],
				createdAt: "2026-07-20T00:00:02.000Z",
			}),
		).rejects.toThrow("injected metadata publish failure");
		await expect(metadataPublishStore.read(metadataArtifactId)).rejects.toBeInstanceOf(ArtifactCorruptionError);
		await expect(
			new ArtifactStore(projectRoot).put({
				contentType: "text/plain",
				text: metadataContent,
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-metadata-publish-retry"],
				createdAt: "2026-07-20T00:00:02.000Z",
			}),
		).resolves.toMatchObject({ artifactId: metadataArtifactId });
		await expect(new ArtifactStore(projectRoot).read(metadataArtifactId)).resolves.toMatchObject({
			content: metadataContent,
		});

		const directorySyncStore = new ArtifactStore(projectRoot, {
			onWritePhase: (phase) => {
				if (phase === "metadata_directory_sync") throw new Error("injected metadata directory sync failure");
			},
		});
		const directorySyncContent = "directory-sync-evidence";
		await expect(
			directorySyncStore.put({
				contentType: "text/plain",
				text: directorySyncContent,
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-directory-sync"],
				createdAt: "2026-07-20T00:00:03.000Z",
			}),
		).rejects.toThrow("injected metadata directory sync failure");
		await expect(
			new ArtifactStore(projectRoot).put({
				contentType: "text/plain",
				text: directorySyncContent,
				producer: "pi-xk.test.v1",
				sensitivity: "internal",
				sourceIds: ["source-directory-sync-retry"],
				createdAt: "2026-07-20T00:00:04.000Z",
			}),
		).resolves.toMatchObject({ artifactId: expect.stringMatching(/^sha256:/) });
	});
});
