import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
	SkillIndexDeltaV1,
	SkillIndexPort,
	SkillIndexSearchInputV1,
	SkillIndexSearchResultV1,
	SkillIndexSnapshotV1,
	SkillIndexStatusV1,
} from "./skill-index.ts";
import type {
	SkillIndexWorkerDataV1,
	SkillIndexWorkerOperationV1,
	SkillIndexWorkerRequestV1,
	SkillIndexWorkerResponseV1,
	SkillIndexWorkerResultV1,
} from "./skill-index-worker-protocol.ts";

export interface SkillIndexWorkerClientOptions {
	databasePath: string;
	nodeWorkerUrl?: URL;
	bunWorkerUrl?: URL;
}

interface PendingRequest {
	resolve: (result: SkillIndexWorkerResultV1) => void;
	reject: (error: Error) => void;
}

export class SkillIndexWorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillIndexWorkerError";
	}
}

export class SkillIndexWorkerClient implements SkillIndexPort {
	private readonly worker: Worker;
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;
	private terminalError: Error | undefined;

	constructor(options: SkillIndexWorkerClientOptions) {
		const isBun = typeof process.versions.bun === "string";
		const workerUrl = isBun
			? (options.bunWorkerUrl ?? new URL("./skill-index-bun-worker.mjs", import.meta.url))
			: (options.nodeWorkerUrl ??
				new URL(
					import.meta.url.endsWith(".ts") ? "./skill-index-node-worker.ts" : "./skill-index-node-worker.js",
					import.meta.url,
				));
		const workerData: SkillIndexWorkerDataV1 = {
			schema: "pi-xk.skill-index-worker-data.v1",
			databasePath: options.databasePath,
		};
		this.worker = new Worker(
			workerUrl,
			isBun ? { workerData } : { workerData, execArgv: ["--disable-warning=ExperimentalWarning"] },
		);
		this.worker.on("message", (response: SkillIndexWorkerResponseV1) => this.onResponse(response));
		this.worker.on("error", (error) => {
			this.terminalError = error;
			this.failAll(error);
		});
		this.worker.on("exit", (code) => {
			if (this.closed || code === 0) return;
			const error = new SkillIndexWorkerError(`Skill index worker exited with code ${code}`);
			this.terminalError = error;
			this.failAll(error);
		});
	}

	private onResponse(response: SkillIndexWorkerResponseV1): void {
		if (response.schema !== "pi-xk.skill-index-worker-response.v1") {
			this.failAll(new SkillIndexWorkerError("Skill index worker response is invalid"));
			return;
		}
		const pending = this.pending.get(response.requestId);
		if (!pending) return;
		this.pending.delete(response.requestId);
		if (response.ok) pending.resolve(response.result);
		else pending.reject(new SkillIndexWorkerError(`${response.error.name}: ${response.error.message}`));
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	private async request(operation: SkillIndexWorkerOperationV1): Promise<SkillIndexWorkerResultV1> {
		if (this.closed) throw new SkillIndexWorkerError("Skill index worker is closed");
		if (this.terminalError) throw this.terminalError;
		const request: SkillIndexWorkerRequestV1 = {
			schema: "pi-xk.skill-index-worker-request.v1",
			requestId: randomUUID(),
			operation,
		};
		return await new Promise<SkillIndexWorkerResultV1>((resolve, reject) => {
			this.pending.set(request.requestId, { resolve, reject });
			this.worker.postMessage(request);
		});
	}

	async rebuild(snapshot: SkillIndexSnapshotV1): Promise<void> {
		const result = await this.request({ kind: "rebuild", snapshot });
		if (result.kind !== "void") throw new SkillIndexWorkerError("Skill index rebuild returned an invalid result");
	}

	async applyDelta(delta: SkillIndexDeltaV1): Promise<void> {
		const result = await this.request({ kind: "apply_delta", delta });
		if (result.kind !== "void") throw new SkillIndexWorkerError("Skill index delta returned an invalid result");
	}

	async search(input: SkillIndexSearchInputV1): Promise<SkillIndexSearchResultV1> {
		const result = await this.request({ kind: "search", input });
		if (result.kind !== "search") throw new SkillIndexWorkerError("Skill index search returned an invalid result");
		return result.value;
	}

	async status(): Promise<SkillIndexStatusV1> {
		const result = await this.request({ kind: "status" });
		if (result.kind !== "status") throw new SkillIndexWorkerError("Skill index status returned an invalid result");
		return result.value;
	}

	async integrityCheck(): Promise<"ok" | string> {
		const result = await this.request({ kind: "integrity_check" });
		if (result.kind !== "integrity_check") {
			throw new SkillIndexWorkerError("Skill index integrity check returned an invalid result");
		}
		return result.value;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		try {
			if (!this.terminalError) {
				const result = await this.request({ kind: "close" });
				if (result.kind !== "void") throw new SkillIndexWorkerError("Skill index close returned an invalid result");
			}
		} finally {
			this.closed = true;
			await this.worker.terminate();
			this.failAll(new SkillIndexWorkerError("Skill index worker closed"));
		}
	}
}
