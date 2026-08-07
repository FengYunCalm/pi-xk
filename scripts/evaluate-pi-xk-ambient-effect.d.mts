export interface AmbientEffectArmSummaryV1 {
	runs: number;
	d1SearchCalls: number;
	d2Reads: number;
	relevantD2Reads: number;
	d3EvidenceReads: number;
	budget: {
		totalKnowledgeActions: number;
		memoryActions: number;
		memorySearchCalls: number;
		uniqueMemoryReads: number;
		evidenceReads: number;
		skillCandidateActions: number;
	};
	totalTokens: number;
	elapsedMs: number;
	memoryStateUse: {
		trust: { verified: number; model_inferred: number; disputed: number };
		freshness: { current: number; stale: number; unknown: number };
	};
	verifier: { passed: number; failed: number; blindFollowedStaleOrDisputed: number };
}

export interface AmbientEffectEvaluationReportV1 {
	schema: "pi-xk.ambient-effect-report.v1";
	evidenceClass: "deterministic_fixture" | "provider_run";
	realProviderEvidence: boolean;
	metadata: {
		commit: string;
		node: string;
		platform: string;
		commandId: string;
		commandDigest: string;
		costForecastUsd: number;
	};
	tasks: { total: number; historical: number; staleOrConflict: number; unrelated: number };
	measurements: {
		historicalTreatmentRuns: number;
		treatmentD1Runs: number;
		relevantD2Runs: number;
		treatmentPasses: number;
		placeboPasses: number;
		passDelta: number;
		unrelatedTreatmentD1Runs: number;
		medianTreatmentTokens: number | null;
		medianPlaceboTokens: number | null;
		medianTreatmentElapsedMs: number | null;
		medianPlaceboElapsedMs: number | null;
		armSummary: {
			historical: Record<"baseline" | "placebo" | "treatment", AmbientEffectArmSummaryV1>;
			unrelated: Record<"baseline" | "placebo" | "treatment", AmbientEffectArmSummaryV1>;
		};
	};
	findings: Array<{ category: string; [key: string]: unknown }>;
}

export function evaluateAmbientEffectReport(input: unknown): AmbientEffectEvaluationReportV1;
