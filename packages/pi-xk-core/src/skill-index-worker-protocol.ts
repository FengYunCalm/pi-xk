import type {
	SkillIndexDeltaV1,
	SkillIndexSearchInputV1,
	SkillIndexSearchResultV1,
	SkillIndexSnapshotV1,
	SkillIndexStatusV1,
} from "./skill-index.ts";

export type SkillIndexWorkerOperationV1 =
	| { kind: "rebuild"; snapshot: SkillIndexSnapshotV1 }
	| { kind: "apply_delta"; delta: SkillIndexDeltaV1 }
	| { kind: "search"; input: SkillIndexSearchInputV1 }
	| { kind: "status" }
	| { kind: "integrity_check" }
	| { kind: "close" };

export interface SkillIndexWorkerRequestV1 {
	schema: "pi-xk.skill-index-worker-request.v1";
	requestId: string;
	operation: SkillIndexWorkerOperationV1;
}

export type SkillIndexWorkerResultV1 =
	| { kind: "void" }
	| { kind: "search"; value: SkillIndexSearchResultV1 }
	| { kind: "status"; value: SkillIndexStatusV1 }
	| { kind: "integrity_check"; value: "ok" | string };

export type SkillIndexWorkerResponseV1 =
	| {
			schema: "pi-xk.skill-index-worker-response.v1";
			requestId: string;
			ok: true;
			result: SkillIndexWorkerResultV1;
	  }
	| {
			schema: "pi-xk.skill-index-worker-response.v1";
			requestId: string;
			ok: false;
			error: { name: string; message: string };
	  };

export interface SkillIndexWorkerDataV1 {
	schema: "pi-xk.skill-index-worker-data.v1";
	databasePath: string;
}
