import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function includesPattern(text, patterns) {
	const normalized = text.toLowerCase();
	return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

export function evaluateSessionChainSummaryFixture(fixture) {
	if (fixture?.schema !== "pi-xk.session-chain-summary-golden.v1") {
		throw new Error("unsupported Session Chain summary golden fixture schema");
	}
	const findings = [];
	for (const summary of fixture.l1) {
		for (const fact of fixture.facts) {
			if (summary.ordinal < fact.introducedAt) continue;
			const expired = fact.expiresAfter !== undefined && summary.ordinal > fact.expiresAfter;
			const present = includesPattern(summary.carryForward, fact.acceptedPatterns);
			if (expired && present) {
				findings.push({ category: "stale", level: "l1", ordinal: summary.ordinal, factId: fact.id });
			} else if (!expired && !present) {
				findings.push({ category: "omission", level: "l1", ordinal: summary.ordinal, factId: fact.id });
			}
			if (includesPattern(summary.carryForward, fact.reversalPatterns)) {
				findings.push({ category: "reversal", level: "l1", ordinal: summary.ordinal, factId: fact.id });
			}
		}
	}

	const l2Text = Object.values(fixture.l2).flat().join("\n");
	for (const fact of fixture.facts) {
		const expired = fact.expiresAfter !== undefined && fixture.l1.at(-1).ordinal > fact.expiresAfter;
		const present = includesPattern(l2Text, fact.acceptedPatterns);
		if (expired && present) {
			findings.push({ category: "stale", level: "l2", factId: fact.id });
		} else if (!expired && !present) {
			findings.push({ category: "omission", level: "l2", factId: fact.id });
		}
		if (includesPattern(l2Text, fact.reversalPatterns)) {
			findings.push({ category: "reversal", level: "l2", factId: fact.id });
		}
		if (fact.mustRemainUnresolved && includesPattern(fixture.l2.completed.join("\n"), fact.acceptedPatterns)) {
			findings.push({ category: "false_completion", level: "l2", factId: fact.id });
		}
	}

	const counts = { omission: 0, reversal: 0, stale: 0, false_completion: 0 };
	for (const finding of findings) counts[finding.category] += 1;
	return { schema: fixture.schema, facts: fixture.facts.length, l1Summaries: fixture.l1.length, counts, findings };
}

async function main() {
	const fixturePath = process.argv[2];
	if (!fixturePath) throw new Error("usage: node scripts/evaluate-session-chain-summaries.mjs <fixture.json>");
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
	const report = evaluateSessionChainSummaryFixture(fixture);
	console.log(JSON.stringify(report, null, 2));
	if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
