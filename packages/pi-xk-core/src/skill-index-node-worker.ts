import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { SkillSqliteProjection } from "./skill-index-database.ts";
import type {
	SkillIndexWorkerDataV1,
	SkillIndexWorkerRequestV1,
	SkillIndexWorkerResponseV1,
	SkillIndexWorkerResultV1,
} from "./skill-index-worker-protocol.ts";

const data = workerData as SkillIndexWorkerDataV1;
if (data.schema !== "pi-xk.skill-index-worker-data.v1") throw new Error("Skill index worker data is invalid");
if (!parentPort) throw new Error("Skill index worker requires a parent port");
const port = parentPort;
const database = new DatabaseSync(data.databasePath, { timeout: 5_000 });
database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
const projection = new SkillSqliteProjection(database);

function execute(request: SkillIndexWorkerRequestV1): SkillIndexWorkerResultV1 {
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
		database.close();
		return { kind: "void" };
	}
	throw new Error("Skill index worker operation is unsupported");
}

port.on("message", (request: SkillIndexWorkerRequestV1) => {
	let response: SkillIndexWorkerResponseV1;
	try {
		if (request.schema !== "pi-xk.skill-index-worker-request.v1")
			throw new Error("Skill index worker request is invalid");
		response = {
			schema: "pi-xk.skill-index-worker-response.v1",
			requestId: request.requestId,
			ok: true,
			result: execute(request),
		};
	} catch (error) {
		response = {
			schema: "pi-xk.skill-index-worker-response.v1",
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
