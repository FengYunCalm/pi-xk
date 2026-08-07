import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateAmbientEffectReport } from "../../../../scripts/evaluate-pi-xk-ambient-effect.mjs";

const fixturePath = resolve(fileURLToPath(new URL("../fixtures/pi-xk/ambient-effect-golden.json", import.meta.url)));

interface AmbientEffectFixtureRun {
	arm: "baseline" | "placebo" | "treatment";
	runId: string;
	verifier: { executor: string; blindFollowedStaleOrDisputed: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

interface AmbientEffectFixtureGroup {
	occurrences: number;
	runs: AmbientEffectFixtureRun[];
	[key: string]: unknown;
}

interface AmbientEffectFixtureTask {
	category: string;
	groups: AmbientEffectFixtureGroup[];
	[key: string]: unknown;
}

interface AmbientEffectFixture {
	reportKind: "deterministic_fixture" | "provider_run";
	metadata: { costForecastUsd: number; [key: string]: unknown };
	tasks: AmbientEffectFixtureTask[];
	[key: string]: unknown;
}

async function loadFixture(): Promise<AmbientEffectFixture> {
	return JSON.parse(await readFile(fixturePath, "utf8")) as AmbientEffectFixture;
}

describe("Pi-XK Ambient Recall effect evaluation", () => {
	it("accepts a physically expanded provider report with an external verifier", async () => {
		const fixture = await loadFixture();
		fixture.reportKind = "provider_run";
		fixture.metadata.costForecastUsd = 1.25;
		for (const task of fixture.tasks) {
			task.groups = task.groups.flatMap((group) =>
				Array.from({ length: group.occurrences }, (_, occurrence) => ({
					...group,
					occurrences: 1,
					runs: group.runs.map((run) => ({
						...run,
						runId: `${run.runId}-physical-${occurrence + 1}`,
						verifier: { ...run.verifier, executor: "external" },
					})),
				})),
			);
		}

		const report = evaluateAmbientEffectReport(fixture);
		expect(report).toMatchObject({ realProviderEvidence: true, findings: [] });
	});

	it("accepts the sealed deterministic tri-arm fixture without claiming real-provider evidence", async () => {
		const fixture = await loadFixture();
		const report = evaluateAmbientEffectReport(fixture);

		expect(report).toMatchObject({
			evidenceClass: "deterministic_fixture",
			tasks: { total: 12, historical: 9, staleOrConflict: 3, unrelated: 3 },
			measurements: { historicalTreatmentRuns: 18, treatmentD1Runs: 18, relevantD2Runs: 18 },
			findings: [],
		});
		const treatment = report.measurements.armSummary.historical.treatment;
		expect(treatment).toMatchObject({
			runs: 18,
			d1SearchCalls: 18,
			d2Reads: 18,
			relevantD2Reads: 18,
			d3EvidenceReads: 6,
			budget: {
				totalKnowledgeActions: 42,
				memoryActions: 42,
				memorySearchCalls: 18,
				uniqueMemoryReads: 18,
				evidenceReads: 6,
			},
			verifier: { passed: 18, failed: 0, blindFollowedStaleOrDisputed: 0 },
		});
		expect(Object.values(treatment.memoryStateUse.trust).reduce((total, count) => total + count, 0)).toBe(
			treatment.d2Reads,
		);
		expect(Object.values(treatment.memoryStateUse.freshness).reduce((total, count) => total + count, 0)).toBe(
			treatment.d2Reads,
		);
	});

	it("rejects a leaked credential-like value and a stale-memory blind-follow result", async () => {
		const fixture = await loadFixture();
		fixture.tasks[0].groups[0].runs[0].runId = "sk-0123456789abcdef0123456789abcdef";
		expect(() => evaluateAmbientEffectReport(fixture)).toThrow(/redacted/i);

		const safe = await loadFixture();
		const staleTask = safe.tasks.find((task) => task.category === "stale_or_conflict");
		if (!staleTask) throw new Error("Missing stale/conflict fixture task");
		const treatment = staleTask.groups[0]?.runs.find((run) => run.arm === "treatment");
		if (!treatment) throw new Error("Missing stale/conflict treatment fixture run");
		treatment.verifier.blindFollowedStaleOrDisputed = true;
		const report = evaluateAmbientEffectReport(safe);
		expect(report.findings).toEqual(
			expect.arrayContaining([expect.objectContaining({ category: "blind_stale_or_conflict_follow" })]),
		);
	});
});
