import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DirectorySyncHandle, syncDirectory } from "../src/sync-directory.ts";

const tempDirectories: string[] = [];

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function fakeHandle(sync: () => Promise<void>, close: () => Promise<void> = async () => {}): DirectorySyncHandle {
	return { sync, close };
}

afterEach(async () => {
	while (tempDirectories.length > 0) {
		const directory = tempDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("syncDirectory", () => {
	it.each(["EPERM", "EACCES", "EINVAL", "ENOTSUP"])(
		"ignores Windows directory sync capability error %s and closes the handle",
		async (code) => {
			const close = vi.fn(async () => {});
			const handle = fakeHandle(async () => {
				throw errno(code);
			}, close);

			await expect(
				syncDirectory("C:\\project", { platform: "win32", openDirectory: async () => handle }),
			).resolves.toBeUndefined();
			expect(close).toHaveBeenCalledOnce();
		},
	);

	it("does not ignore EPERM outside Windows and still closes the handle", async () => {
		const close = vi.fn(async () => {});
		const error = errno("EPERM");
		const handle = fakeHandle(async () => {
			throw error;
		}, close);

		await expect(syncDirectory("/project", { platform: "linux", openDirectory: async () => handle })).rejects.toBe(
			error,
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("does not ignore Windows I/O failures and still closes the handle", async () => {
		const close = vi.fn(async () => {});
		const error = errno("EIO");
		const handle = fakeHandle(async () => {
			throw error;
		}, close);

		await expect(syncDirectory("C:\\project", { platform: "win32", openDirectory: async () => handle })).rejects.toBe(
			error,
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("ignores a Windows capability error while opening the directory", async () => {
		const openDirectory = vi.fn(async (): Promise<DirectorySyncHandle> => {
			throw errno("EINVAL");
		});

		await expect(syncDirectory("C:\\project", { platform: "win32", openDirectory })).resolves.toBeUndefined();
		expect(openDirectory).toHaveBeenCalledOnce();
	});

	it("propagates handle close failures", async () => {
		const error = errno("EIO");
		const handle = fakeHandle(
			async () => {},
			async () => {
				throw error;
			},
		);

		await expect(syncDirectory("C:\\project", { platform: "win32", openDirectory: async () => handle })).rejects.toBe(
			error,
		);
	});

	it("syncs a real directory on supported hosts", async () => {
		const directory = join(tmpdir(), `pi-xk-sync-directory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(directory, { recursive: true });
		tempDirectories.push(directory);

		await expect(syncDirectory(directory)).resolves.toBeUndefined();
	});
});
