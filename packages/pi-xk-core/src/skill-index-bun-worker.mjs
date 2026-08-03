import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { SkillSqliteProjection } from "./skill-index-database.js";

if (workerData?.schema !== "pi-xk.skill-index-worker-data.v1") throw new Error("Skill index worker data is invalid");
if (!parentPort) throw new Error("Skill index worker requires a parent port");
const database = new Database(workerData.databasePath, { create: true, strict: true });
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
const projection = new SkillSqliteProjection(database);

function execute(request) {
	const operation = request.operation;
	if (operation.kind === "rebuild") {
		projection.rebuild(operation.snapshot);
		return { kind: "void" };
	}
	if (operation.kind === "apply_delta") {
		projection.applyDelta(operation.delta);
		return { kind: "void" };
	}
	if (operation.kind === "search") return { kind: "search", value: projection.search(operation.input) };
	if (operation.kind === "status") return { kind: "status", value: projection.status() };
	if (operation.kind === "integrity_check") return { kind: "integrity_check", value: projection.integrityCheck() };
	if (operation.kind === "close") {
		database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		database.close();
		return { kind: "void" };
	}
	throw new Error("Skill index worker operation is unsupported");
}

parentPort.on("message", (request) => {
	let response;
	try {
		if (request?.schema !== "pi-xk.skill-index-worker-request.v1") throw new Error("Skill index worker request is invalid");
		response = { schema: "pi-xk.skill-index-worker-response.v1", requestId: request.requestId, ok: true, result: execute(request) };
	} catch (error) {
		response = {
			schema: "pi-xk.skill-index-worker-response.v1",
			requestId: request?.requestId ?? "invalid",
			ok: false,
			error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
		};
	}
	parentPort.postMessage(response);
});
