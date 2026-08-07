import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryService, MemoryStore } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Memory incremental publication", () => {
	it("takes the shared projection lock before doctor reads a projection snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-memory-doctor-lock-"));
		roots.push(root);
		const ownerStore = new MemoryStore(root);
		let signalOwnerEntered: (() => void) | undefined;
		let releaseOwner: (() => void) | undefined;
		const ownerEntered = new Promise<void>((resolve) => {
			signalOwnerEntered = resolve;
		});
		const ownerGate = new Promise<void>((resolve) => {
			releaseOwner = resolve;
		});
		const owner = ownerStore.withProjectionLock(async () => {
			signalOwnerEntered?.();
			await ownerGate;
		});
		await ownerEntered;

		let signalDoctorLockAttempt: (() => void) | undefined;
		const doctorLockAttempted = new Promise<void>((resolve) => {
			signalDoctorLockAttempt = resolve;
		});
		class ObservedMemoryStore extends MemoryStore {
			override async withProjectionLock<TResult>(action: () => Promise<TResult>): Promise<TResult> {
				signalDoctorLockAttempt?.();
				return await super.withProjectionLock(action);
			}
		}
		const service = new MemoryService(root, new ObservedMemoryStore(root));
		let doctorCompleted = false;
		const doctor = service.doctor().then((report) => {
			doctorCompleted = true;
			return report;
		});

		await expect(
			Promise.race([doctorLockAttempted.then(() => "lock-attempted"), doctor.then(() => "doctor-completed")]),
		).resolves.toBe("lock-attempted");
		expect(doctorCompleted).toBe(false);
		releaseOwner?.();
		await expect(owner).resolves.toBeUndefined();
		await expect(doctor).resolves.toMatchObject({ ok: true, diagnostics: [] });
		await service.close();
	});

	it("updates only changed Markdown and keeps the open SQLite projection current", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-xk-memory-incremental-"));
		roots.push(root);
		const service = new MemoryService(root);
		const first = await service.remember("The release workflow validates Node artifacts before Bun binaries.", {
			commandId: "command_incremental_first",
			recordedAt: "2026-08-03T00:00:00.000Z",
		});
		const firstProjection = join(
			root,
			".pi-xk",
			"memory",
			"projections",
			"memories",
			`${first.revision.memoryId}.md`,
		);
		await utimes(firstProjection, 1, 1);

		await service.remember("The release workflow records isolated interactive smoke evidence.", {
			commandId: "command_incremental_second",
			recordedAt: "2026-08-03T00:01:00.000Z",
		});

		expect((await stat(firstProjection)).mtimeMs).toBe(1_000);
		expect(await service.status()).toMatchObject({
			indexState: "current",
			index: { memoryCount: 2 },
		});
		expect(await service.doctor()).toMatchObject({ ok: true, diagnostics: [] });
		await service.close();
	});
});
