export type SessionChainSummaryQualityCategory = "omission" | "reversal" | "stale" | "false_completion";

export interface SessionChainSummaryQualityFinding {
	category: SessionChainSummaryQualityCategory;
	level: "l1" | "l2";
	ordinal?: number;
	factId: string;
}

export interface SessionChainSummaryQualityReport {
	schema: string;
	facts: number;
	l1Summaries: number;
	counts: Record<SessionChainSummaryQualityCategory, number>;
	findings: SessionChainSummaryQualityFinding[];
}

export interface SessionChainSummaryProtocolReport extends SessionChainSummaryQualityReport {
	providerCalls: number;
	l2Rollups: number;
}

export function evaluateSessionChainSummaryFixture(fixture: unknown): SessionChainSummaryQualityReport;
export function executeSessionChainSummaryProtocolFixture(fixture: unknown): Promise<SessionChainSummaryProtocolReport>;
