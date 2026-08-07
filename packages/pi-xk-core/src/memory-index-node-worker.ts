import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { MemorySqliteProjection } from "./memory-index-database.ts";
import type {
	MemoryIndexWorkerDataV1,
	MemoryIndexWorkerRequestV1,
	MemoryIndexWorkerResponseV1,
	MemoryIndexWorkerResultV1,
} from "./memory-index-worker-protocol.ts";

const data = workerData as MemoryIndexWorkerDataV1;
if (data.schema !== "pi-xk.memory-index-worker-data.v1") throw new Error("Memory index worker data is invalid");
if (!parentPort) throw new Error("Memory index worker requires a parent port");
const port = parentPort;

const database = new DatabaseSync(data.databasePath, { timeout: 5_000 });
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
const projection = new MemorySqliteProjection(database);

function execute(request: MemoryIndexWorkerRequestV1): MemoryIndexWorkerResultV1 {
	const operation = request.operation;
	if (operation.kind === "rebuild_begin") {
		projection.beginRebuild(operation.plan);
		return { kind: "void" };
	}
	if (operation.kind === "rebuild_chunk") {
		projection.appendRebuildChunk(operation.chunk);
		return { kind: "void" };
	}
	if (operation.kind === "rebuild_finish") {
		projection.finishRebuild();
		return { kind: "void" };
	}
	if (operation.kind === "rebuild_abort") {
		projection.abortRebuild();
		return { kind: "void" };
	}
	if (operation.kind === "apply_delta") {
		projection.applyDelta(operation.delta);
		return { kind: "void" };
	}
	if (operation.kind === "search") return { kind: "search", value: projection.search(operation.input) };
	if (operation.kind === "graph") return { kind: "graph", value: projection.graph(operation.input) };
	if (operation.kind === "recall_coverage") {
		return { kind: "recall_coverage", value: projection.recallCoverage(operation.input) };
	}
	if (operation.kind === "record_access") {
		projection.recordAccess(operation.memoryIds, operation.accessedAt, operation.head);
		return { kind: "void" };
	}
	if (operation.kind === "status") return { kind: "status", value: projection.status() };
	if (operation.kind === "integrity_check") return { kind: "integrity_check", value: projection.integrityCheck() };
	if (operation.kind === "close") {
		projection.abortRebuild();
		database.close();
		return { kind: "void" };
	}
	throw new Error("Memory index worker operation is unsupported");
}

port.on("message", (request: MemoryIndexWorkerRequestV1) => {
	let response: MemoryIndexWorkerResponseV1;
	try {
		if (request.schema !== "pi-xk.memory-index-worker-request.v1")
			throw new Error("Memory index worker request is invalid");
		response = {
			schema: "pi-xk.memory-index-worker-response.v1",
			requestId: request.requestId,
			ok: true,
			result: execute(request),
		};
	} catch (error) {
		response = {
			schema: "pi-xk.memory-index-worker-response.v1",
			requestId: request.requestId,
			ok: false,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	port.postMessage(response);
});
