import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";

const LOCK_RETRY_LIMIT = 100;
const LOCK_RETRY_DELAY_MS = 10;

interface StoredWriteLock {
	pid: number;
	nonce: string;
	createdAt: string;
}

export type WriteLockOwnerState = "alive" | "missing" | "unknown";

export interface WriteLockDiagnostic {
	pid?: number;
	nonce?: string;
	createdAt?: string;
	ownerState: WriteLockOwnerState;
	malformed: boolean;
}

export type WriteLockFailure =
	| { kind: "locked" }
	| { kind: "recovery-locked" }
	| { kind: "malformed" }
	| { kind: "conflict" }
	| { kind: "owner-not-missing"; ownerState: WriteLockOwnerState };

export interface FileWriteLockOptions {
	directory: string;
	lockPath: string;
	recoveryLockPath: string;
	error: (failure: WriteLockFailure) => Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function parseStoredWriteLock(value: unknown): StoredWriteLock | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
	if (typeof value.nonce !== "string" || value.nonce.trim().length === 0) return undefined;
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
	return { pid: value.pid, nonce: value.nonce, createdAt: value.createdAt };
}

function ownerState(pid: number): WriteLockOwnerState {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return isErrno(error, "ESRCH") ? "missing" : "unknown";
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export async function inspectFileWriteLock(lockPath: string): Promise<WriteLockDiagnostic | undefined> {
	let raw: string;
	try {
		raw = await readFile(lockPath, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
	let stored: StoredWriteLock | undefined;
	try {
		stored = parseStoredWriteLock(JSON.parse(raw) as unknown);
	} catch {
		stored = undefined;
	}
	if (!stored) return { ownerState: "unknown", malformed: true };
	return {
		pid: stored.pid,
		nonce: stored.nonce,
		createdAt: stored.createdAt,
		ownerState: ownerState(stored.pid),
		malformed: false,
	};
}

export async function withFileWriteLock<TResult>(
	options: FileWriteLockOptions,
	action: () => Promise<TResult>,
): Promise<TResult> {
	await mkdir(options.directory, { recursive: true });
	const lock: StoredWriteLock = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
	for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
		let handle: FileHandle | undefined;
		let ownsLock = false;
		try {
			try {
				handle = await open(options.lockPath, "wx", 0o600);
				ownsLock = true;
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				await wait(LOCK_RETRY_DELAY_MS);
				continue;
			}
			await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			return await action();
		} finally {
			await handle?.close().catch(() => {});
			if (ownsLock) await unlink(options.lockPath).catch(() => {});
		}
	}
	throw options.error({ kind: "locked" });
}

export async function repairAbandonedFileWriteLock(
	options: FileWriteLockOptions,
	expectedNonce: string,
): Promise<boolean> {
	await mkdir(options.directory, { recursive: true });
	const recoveryLock: StoredWriteLock = {
		pid: process.pid,
		nonce: randomUUID(),
		createdAt: new Date().toISOString(),
	};
	let handle: FileHandle | undefined;
	let ownsRecoveryLock = false;
	try {
		try {
			handle = await open(options.recoveryLockPath, "wx", 0o600);
			ownsRecoveryLock = true;
		} catch (error) {
			if (isErrno(error, "EEXIST")) throw options.error({ kind: "recovery-locked" });
			throw error;
		}
		await handle.writeFile(`${JSON.stringify(recoveryLock)}\n`, "utf8");
		await handle.sync();
		const diagnostic = await inspectFileWriteLock(options.lockPath);
		if (!diagnostic) return false;
		if (diagnostic.malformed || !diagnostic.nonce) throw options.error({ kind: "malformed" });
		if (diagnostic.nonce !== expectedNonce) throw options.error({ kind: "conflict" });
		if (diagnostic.ownerState !== "missing") {
			throw options.error({ kind: "owner-not-missing", ownerState: diagnostic.ownerState });
		}
		await unlink(options.lockPath);
		return true;
	} finally {
		await handle?.close().catch(() => {});
		if (ownsRecoveryLock) await unlink(options.recoveryLockPath).catch(() => {});
	}
}
