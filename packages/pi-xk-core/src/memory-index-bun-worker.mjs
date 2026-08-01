import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { MemorySqliteProjection } from "./memory-index-database.js";

if (workerData?.schema !== "pi-xk.memory-index-worker-data.v1") {
	throw new Error("Memory index worker data is invalid");
}
if (!parentPort) throw new Error("Memory index worker requires a parent port");

const database = new Database(workerData.databasePath, { create: true, strict: true });
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
const projection = new MemorySqliteProjection(database);

function execute(request) {
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
	if (operation.kind === "search") return { kind: "search", value: projection.search(operation.input) };
	if (operation.kind === "record_access") {
		projection.recordAccess(operation.memoryIds, operation.accessedAt, operation.head);
		return { kind: "void" };
	}
	if (operation.kind === "status") return { kind: "status", value: projection.status() };
	if (operation.kind === "integrity_check") return { kind: "integrity_check", value: projection.integrityCheck() };
	if (operation.kind === "close") {
		projection.abortRebuild();
		database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		database.close();
		return { kind: "void" };
	}
	throw new Error("Memory index worker operation is unsupported");
}

parentPort.on("message", (request) => {
	let response;
	try {
		if (request?.schema !== "pi-xk.memory-index-worker-request.v1") throw new Error("Memory index worker request is invalid");
		response = {
			schema: "pi-xk.memory-index-worker-response.v1",
			requestId: request.requestId,
			ok: true,
			result: execute(request),
		};
	} catch (error) {
		response = {
			schema: "pi-xk.memory-index-worker-response.v1",
			requestId: request?.requestId ?? "invalid",
			ok: false,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
	parentPort.postMessage(response);
});
