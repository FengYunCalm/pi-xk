import type { ContextSummaryEvidenceKind, SummaryEvidenceKind } from "@earendil-works/pi-agent-core";

const SUMMARY_EVIDENCE_SCHEMA = "pi.summary-evidence.v1";

export function summaryEvidence(kind: SummaryEvidenceKind, payload: object): string {
	return JSON.stringify({ schema: SUMMARY_EVIDENCE_SCHEMA, kind, payload });
}

export function contextSummaryEvidence(kind: ContextSummaryEvidenceKind, title: string, summary: string): string {
	return summaryEvidence(kind, { title, summary });
}

export function sessionChainL1Evidence(
	title: string,
	segmentDeltaMarkdown: string,
	carryForwardMarkdown: string,
): string {
	return summaryEvidence("session-chain-l1", { title, segmentDeltaMarkdown, carryForwardMarkdown });
}

export interface SessionChainL2Evidence {
	state: string;
	decisions: string[];
	constraints: string[];
	completed: string[];
	unresolved: string[];
	nextActions: string[];
}

export function sessionChainL2Evidence(payload: SessionChainL2Evidence): string {
	return summaryEvidence("session-chain-l2", payload);
}
