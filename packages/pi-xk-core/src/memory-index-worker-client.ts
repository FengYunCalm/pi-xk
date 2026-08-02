import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
	MemoryIndexDeltaV1,
	MemoryIndexGraphInputV1,
	MemoryIndexGraphResultV1,
	MemoryIndexPort,
	MemoryIndexRebuildChunkV1,
	MemoryIndexRebuildPlanV1,
	MemoryIndexSearchInputV1,
	MemoryIndexSearchResultV1,
	MemoryIndexSnapshotV1,
	MemoryIndexStatusV1,
} from "./memory-index.ts";
import type {
	MemoryIndexWorkerDataV1,
	MemoryIndexWorkerOperationV1,
	MemoryIndexWorkerRequestV1,
	MemoryIndexWorkerResponseV1,
	MemoryIndexWorkerResultV1,
} from "./memory-index-worker-protocol.ts";

export interface MemoryIndexWorkerClientOptions {
	databasePath: string;
	nodeWorkerUrl?: URL;
	bunWorkerUrl?: URL;
}

interface PendingRequest {
	resolve: (result: MemoryIndexWorkerResultV1) => void;
	reject: (error: Error) => void;
}

export class MemoryIndexWorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryIndexWorkerError";
	}
}

export class MemoryIndexWorkerClient implements MemoryIndexPort {
	private readonly worker: Worker;
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;
	private terminalError: Error | undefined;

	constructor(options: MemoryIndexWorkerClientOptions) {
		const isBun = typeof process.versions.bun === "string";
		const workerUrl = isBun
			? (options.bunWorkerUrl ?? new URL("./memory-index-bun-worker.mjs", import.meta.url))
			: (options.nodeWorkerUrl ??
				new URL(
					import.meta.url.endsWith(".ts") ? "./memory-index-node-worker.ts" : "./memory-index-node-worker.js",
					import.meta.url,
				));
		const workerData: MemoryIndexWorkerDataV1 = {
			schema: "pi-xk.memory-index-worker-data.v1",
			databasePath: options.databasePath,
		};
		this.worker = new Worker(
			workerUrl,
			isBun ? { workerData } : { workerData, execArgv: ["--disable-warning=ExperimentalWarning"] },
		);
		this.worker.on("message", (response: MemoryIndexWorkerResponseV1) => this.onResponse(response));
		this.worker.on("error", (error) => {
			this.terminalError = error;
			this.failAll(error);
		});
		this.worker.on("exit", (code) => {
			if (this.closed || code === 0) return;
			const error = new MemoryIndexWorkerError(`Memory index worker exited with code ${code}`);
			this.terminalError = error;
			this.failAll(error);
		});
	}

	private onResponse(response: MemoryIndexWorkerResponseV1): void {
		if (response.schema !== "pi-xk.memory-index-worker-response.v1") {
			this.failAll(new MemoryIndexWorkerError("Memory index worker response is invalid"));
			return;
		}
		const pending = this.pending.get(response.requestId);
		if (!pending) return;
		this.pending.delete(response.requestId);
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new MemoryIndexWorkerError(`${response.error.name}: ${response.error.message}`));
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private async request(operation: MemoryIndexWorkerOperationV1): Promise<MemoryIndexWorkerResultV1> {
		if (this.closed) throw new MemoryIndexWorkerError("Memory index worker is closed");
		if (this.terminalError) throw this.terminalError;
		const requestId = randomUUID();
		const request: MemoryIndexWorkerRequestV1 = {
			schema: "pi-xk.memory-index-worker-request.v1",
			requestId,
			operation,
		};
		return await new Promise<MemoryIndexWorkerResultV1>((resolve, reject) => {
			this.pending.set(requestId, { resolve, reject });
			this.worker.postMessage(request);
		});
	}

	async rebuild(snapshot: MemoryIndexSnapshotV1): Promise<void> {
		const plan: MemoryIndexRebuildPlanV1 = {
			head: snapshot.head,
			memoryCount: snapshot.memories.length,
			cueCount: snapshot.cues.length,
			edgeCount: snapshot.edges.length,
			historyCueCount: snapshot.historyCues.length,
		};
		async function* chunks(): AsyncGenerator<MemoryIndexRebuildChunkV1> {
			yield {
				memories: snapshot.memories,
				cues: snapshot.cues,
				edges: snapshot.edges,
				historyCues: snapshot.historyCues,
			};
		}
		await this.rebuildFromChunks(plan, chunks());
	}

	async rebuildFromChunks(
		plan: MemoryIndexRebuildPlanV1,
		chunks: AsyncIterable<MemoryIndexRebuildChunkV1>,
	): Promise<void> {
		const begin = await this.request({ kind: "rebuild_begin", plan });
		if (begin.kind !== "void") {
			throw new MemoryIndexWorkerError("Memory index rebuild begin returned an invalid result");
		}
		try {
			for await (const chunk of chunks) {
				const appended = await this.request({ kind: "rebuild_chunk", chunk });
				if (appended.kind !== "void") {
					throw new MemoryIndexWorkerError("Memory index rebuild chunk returned an invalid result");
				}
			}
			const finished = await this.request({ kind: "rebuild_finish" });
			if (finished.kind !== "void") {
				throw new MemoryIndexWorkerError("Memory index rebuild finish returned an invalid result");
			}
		} catch (error) {
			await this.request({ kind: "rebuild_abort" }).catch(() => {});
			throw error;
		}
	}

	async search(input: MemoryIndexSearchInputV1): Promise<MemoryIndexSearchResultV1> {
		const result = await this.request({ kind: "search", input });
		if (result.kind !== "search") throw new MemoryIndexWorkerError("Memory index search returned an invalid result");
		return result.value;
	}

	async applyDelta(delta: MemoryIndexDeltaV1): Promise<void> {
		const result = await this.request({ kind: "apply_delta", delta });
		if (result.kind !== "void") throw new MemoryIndexWorkerError("Memory index delta returned an invalid result");
	}

	async graph(input: MemoryIndexGraphInputV1): Promise<MemoryIndexGraphResultV1> {
		const result = await this.request({ kind: "graph", input });
		if (result.kind !== "graph") throw new MemoryIndexWorkerError("Memory index graph returned an invalid result");
		return result.value;
	}

	async recordAccess(
		memoryIds: readonly string[],
		accessedAt: string,
		head: MemoryIndexSnapshotV1["head"],
	): Promise<void> {
		const result = await this.request({ kind: "record_access", memoryIds: [...memoryIds], accessedAt, head });
		if (result.kind !== "void") throw new MemoryIndexWorkerError("Memory index access returned an invalid result");
	}

	async status(): Promise<MemoryIndexStatusV1> {
		const result = await this.request({ kind: "status" });
		if (result.kind !== "status") throw new MemoryIndexWorkerError("Memory index status returned an invalid result");
		return result.value;
	}

	async integrityCheck(): Promise<"ok" | string> {
		const result = await this.request({ kind: "integrity_check" });
		if (result.kind !== "integrity_check") {
			throw new MemoryIndexWorkerError("Memory index integrity check returned an invalid result");
		}
		return result.value;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		try {
			if (!this.terminalError) {
				try {
					const result = await this.request({ kind: "close" });
					if (result.kind !== "void")
						throw new MemoryIndexWorkerError("Memory index close returned an invalid result");
				} catch (error) {
					if (!this.terminalError) throw error;
				}
			}
		} finally {
			this.closed = true;
			await this.worker.terminate();
			this.failAll(new MemoryIndexWorkerError("Memory index worker closed"));
		}
	}
}
