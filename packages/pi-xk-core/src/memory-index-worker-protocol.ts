import type {
	MemoryIndexDeltaV1,
	MemoryIndexGraphInputV1,
	MemoryIndexGraphResultV1,
	MemoryIndexRebuildChunkV1,
	MemoryIndexRebuildPlanV1,
	MemoryIndexSearchInputV1,
	MemoryIndexSearchResultV1,
	MemoryIndexSnapshotV1,
	MemoryIndexStatusV1,
	MemoryRecallCoverageInputV1,
	MemoryRecallCoverageV1,
} from "./memory-index.ts";

export type MemoryIndexWorkerOperationV1 =
	| { kind: "rebuild_begin"; plan: MemoryIndexRebuildPlanV1 }
	| { kind: "rebuild_chunk"; chunk: MemoryIndexRebuildChunkV1 }
	| { kind: "rebuild_finish" }
	| { kind: "rebuild_abort" }
	| { kind: "apply_delta"; delta: MemoryIndexDeltaV1 }
	| { kind: "search"; input: MemoryIndexSearchInputV1 }
	| { kind: "graph"; input: MemoryIndexGraphInputV1 }
	| { kind: "recall_coverage"; input: MemoryRecallCoverageInputV1 }
	| { kind: "record_access"; memoryIds: string[]; accessedAt: string; head: MemoryIndexSnapshotV1["head"] }
	| { kind: "status" }
	| { kind: "integrity_check" }
	| { kind: "close" };

export interface MemoryIndexWorkerRequestV1 {
	schema: "pi-xk.memory-index-worker-request.v1";
	requestId: string;
	operation: MemoryIndexWorkerOperationV1;
}

export type MemoryIndexWorkerResultV1 =
	| { kind: "void" }
	| { kind: "search"; value: MemoryIndexSearchResultV1 }
	| { kind: "graph"; value: MemoryIndexGraphResultV1 }
	| { kind: "recall_coverage"; value: MemoryRecallCoverageV1 }
	| { kind: "status"; value: MemoryIndexStatusV1 }
	| { kind: "integrity_check"; value: "ok" | string };

export type MemoryIndexWorkerResponseV1 =
	| {
			schema: "pi-xk.memory-index-worker-response.v1";
			requestId: string;
			ok: true;
			result: MemoryIndexWorkerResultV1;
	  }
	| {
			schema: "pi-xk.memory-index-worker-response.v1";
			requestId: string;
			ok: false;
			error: { name: string; message: string };
	  };

export interface MemoryIndexWorkerDataV1 {
	schema: "pi-xk.memory-index-worker-data.v1";
	databasePath: string;
}
