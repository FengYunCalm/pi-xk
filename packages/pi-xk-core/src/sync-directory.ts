import { open } from "node:fs/promises";

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EPERM", "EACCES", "EINVAL", "ENOTSUP"]);

export interface DirectorySyncHandle {
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface SyncDirectoryOptions {
	/** Test-only platform override. */
	platform?: NodeJS.Platform;
	/** Test-only directory opener override. */
	openDirectory?: (directory: string) => Promise<DirectorySyncHandle>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsupportedDirectorySync(error: unknown, platform: NodeJS.Platform): boolean {
	return (
		platform === "win32" &&
		isRecord(error) &&
		typeof error.code === "string" &&
		WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code)
	);
}

export async function syncDirectory(directory: string, options: SyncDirectoryOptions = {}): Promise<void> {
	const platform = options.platform ?? process.platform;
	const openDirectory = options.openDirectory ?? (async (path: string) => await open(path, "r"));
	let handle: DirectorySyncHandle;
	try {
		handle = await openDirectory(directory);
	} catch (error) {
		if (isUnsupportedDirectorySync(error, platform)) return;
		throw error;
	}
	try {
		try {
			await handle.sync();
		} catch (error) {
			if (!isUnsupportedDirectorySync(error, platform)) throw error;
		}
	} finally {
		await handle.close();
	}
}
