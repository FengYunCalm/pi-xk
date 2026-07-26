import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateSessionChainSummaryFixture } from "../../../../scripts/evaluate-session-chain-summaries.mjs";

const fixturePath = resolve(
	fileURLToPath(new URL("../fixtures/pi-xk/session-chain-summary-golden.json", import.meta.url)),
);

describe("Session Chain summary semantic quality", () => {
	it("preserves golden decisions, constraints, rejections, and unresolved work across L1 and L2", async () => {
		const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
		const report = evaluateSessionChainSummaryFixture(fixture);

		expect(report).toMatchObject({
			facts: 6,
			l1Summaries: 5,
			counts: { omission: 0, reversal: 0, stale: 0, false_completion: 0 },
			findings: [],
		});
	});

	it("classifies omission, reversal, stale carry-forward, and false completion independently", async () => {
		const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
		fixture.l1[4].carryForward =
			"The default Rollup interval is 10. TaskSupervisor remains rejected. A temporary provider retry is pending.";
		fixture.l2.constraints = ["The Policy layer remains out of scope."];
		fixture.l2.completed.push("Release smoke remains unresolved.");
		fixture.l2.unresolved = [];
		const report = evaluateSessionChainSummaryFixture(fixture);

		expect(report.counts.omission).toBeGreaterThan(0);
		expect(report.counts.reversal).toBeGreaterThan(0);
		expect(report.counts.stale).toBeGreaterThan(0);
		expect(report.counts.false_completion).toBe(1);
	});
});
