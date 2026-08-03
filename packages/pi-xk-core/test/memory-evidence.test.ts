import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentRunEvidenceRefV2, MEMORY_EVIDENCE_REF_V2_SCHEMA } from "../src/ambient-memory-contract.ts";
import { validateMemoryEvidenceOwnership } from "../src/memory-evidence.ts";
import { stableJsonStringify } from "../src/stable-json.ts";

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

describe("Memory evidence ownership", () => {
	it("accepts a native Session whose project path is a canonical alias", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-xk-memory-evidence-"));
		try {
			const projectRoot = join(temporaryRoot, "project");
			const projectAlias = join(temporaryRoot, "project-alias");
			await mkdir(projectRoot);
			await symlink(projectRoot, projectAlias, process.platform === "win32" ? "junction" : "dir");

			const sessionId = "session_memory_evidence_alias";
			const requestEntryId = "entry_memory_evidence_request";
			const terminalEntryId = "entry_memory_evidence_terminal";
			const request = {
				type: "message",
				id: requestEntryId,
				parentId: null,
				timestamp: "2026-08-03T08:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Validate the canonical project path." }],
					timestamp: Date.parse("2026-08-03T08:00:00.000Z"),
				},
			};
			const terminal = {
				type: "message",
				id: terminalEntryId,
				parentId: requestEntryId,
				timestamp: "2026-08-03T08:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Canonical path evidence validated." }],
					stopReason: "stop",
					timestamp: Date.parse("2026-08-03T08:00:01.000Z"),
				},
			};
			const range = [request, terminal];
			const rangeDigest = digest(range);
			const sessionFile = join(projectRoot, "session.jsonl");
			await writeFile(
				sessionFile,
				`${[{ type: "session", id: sessionId, timestamp: "2026-08-03T08:00:00.000Z", cwd: projectAlias }, ...range]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			const evidence: AgentRunEvidenceRefV2 = {
				schema: MEMORY_EVIDENCE_REF_V2_SCHEMA,
				evidenceId: "evidence_agent_run_alias",
				sourceType: "agent_run",
				sourceId: `${sessionId}:${requestEntryId}`,
				artifactId: null,
				sourceDigest: rangeDigest,
				recordedAt: terminal.timestamp,
				locator: {
					projectId: "project_memory_evidence_alias",
					sessionId,
					sessionFile: join(projectAlias, "session.jsonl"),
					chainId: null,
					branchId: null,
					segmentId: null,
					requestEntryId,
					terminalAssistantEntryId: terminalEntryId,
					toolResultEntryIds: [],
					rangeDigest,
				},
			};

			await expect(validateMemoryEvidenceOwnership(projectAlias, evidence)).resolves.toBeUndefined();
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});
});
