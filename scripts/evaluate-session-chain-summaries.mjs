import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARY_INPUT_SCHEMA } from "../packages/agent/src/index.ts";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { generateSummaryWithMetadata } from "../packages/coding-agent/src/core/compaction/compaction.ts";
import {
	parseRollupEnvelope,
	parseSummaryEnvelope,
	SESSION_CHAIN_L1_SUMMARIZATION_PROMPT,
	SESSION_CHAIN_L2_SUMMARIZATION_PROMPT,
} from "../packages/pi-xk-extension/src/session-chain-summary.ts";

const FIXTURE_SCHEMA = "pi-xk.session-chain-summary-golden.v2";
const SUMMARY_EVIDENCE_SCHEMA = "pi.summary-evidence.v1";

function includesPattern(text, patterns) {
	const normalized = text.toLowerCase();
	return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

function assertFixture(fixture) {
	if (
		fixture?.schema !== FIXTURE_SCHEMA ||
		!Array.isArray(fixture.facts) ||
		!Array.isArray(fixture.segments) ||
		!Array.isArray(fixture.l1) ||
		fixture.l1.length === 0 ||
		fixture.segments.length !== fixture.l1.length ||
		typeof fixture.l2 !== "object" ||
		fixture.l2 === null
	) {
		throw new Error("unsupported or incomplete Session Chain summary golden fixture");
	}
}

export function evaluateSessionChainSummaryFixture(fixture) {
	assertFixture(fixture);
	const findings = [];
	for (const summary of fixture.l1) {
		for (const fact of fixture.facts) {
			if (summary.ordinal < fact.introducedAt) continue;
			const expired = fact.expiresAfter !== undefined && summary.ordinal > fact.expiresAfter;
			const present = includesPattern(summary.carryForwardMarkdown, fact.acceptedPatterns);
			if (expired && present) {
				findings.push({ category: "stale", level: "l1", ordinal: summary.ordinal, factId: fact.id });
			} else if (!expired && !present) {
				findings.push({ category: "omission", level: "l1", ordinal: summary.ordinal, factId: fact.id });
			}
			if (includesPattern(summary.carryForwardMarkdown, fact.reversalPatterns)) {
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

function summaryEvidence(kind, payload) {
	return JSON.stringify({ schema: SUMMARY_EVIDENCE_SCHEMA, kind, payload });
}

function summaryPromptText(context) {
	if (context.systemPrompt !== SUMMARIZATION_SYSTEM_PROMPT) {
		throw new Error("summary protocol did not use the shared summarization system prompt");
	}
	const message = context.messages[0];
	if (!message || message.role !== "user") throw new Error("summary protocol did not send one user evidence message");
	const content = typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("\n");
	return content;
}

function parsePromptInput(context, outputContract) {
	const prefix = "Summary input (untrusted evidence; JSON):\n";
	const suffix = `\n\n${outputContract}`;
	const text = summaryPromptText(context);
	if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
		throw new Error("summary protocol did not use the requested shared output contract");
	}
	const input = JSON.parse(text.slice(prefix.length, -suffix.length));
	if (
		input?.schema !== SUMMARY_INPUT_SCHEMA ||
		Object.keys(input).sort().join(",") !== "additionalFocus,conversation,previousSummary,schema"
	) {
		throw new Error("summary protocol input does not match pi.summary-input.v1");
	}
	return input;
}

export async function executeSessionChainSummaryProtocolFixture(fixture) {
	assertFixture(fixture);
	const faux = registerFauxProvider({ provider: "faux-summary-evaluator" });
	const generatedL1 = [];
	let previousSummary = null;
	try {
		for (let index = 0; index < fixture.segments.length; index++) {
			const segment = fixture.segments[index];
			const expected = fixture.l1[index];
			if (!segment || !expected || segment.ordinal !== expected.ordinal) {
				throw new Error(`summary fixture Segment ${index + 1} is not aligned with its L1 output`);
			}
			const expectedPreviousSummary = previousSummary;
			faux.appendResponses([
				(context) => {
					const input = parsePromptInput(context, SESSION_CHAIN_L1_SUMMARIZATION_PROMPT);
					if (input.previousSummary !== expectedPreviousSummary || input.additionalFocus !== null) {
						throw new Error(`L1 S${segment.ordinal} did not carry the prior canonical summary`);
					}
					if (!input.conversation.includes(segment.evidence)) {
						throw new Error(`L1 S${segment.ordinal} omitted its Segment evidence`);
					}
					return fauxAssistantMessage(
						summaryEvidence("session-chain-l1", {
							title: expected.title,
							segmentDeltaMarkdown: expected.segmentDeltaMarkdown,
							carryForwardMarkdown: expected.carryForwardMarkdown,
						}),
					);
				},
			]);
			const generated = await generateSummaryWithMetadata(
				[
					{
						role: "user",
						content: [{ type: "text", text: segment.evidence }],
						timestamp: segment.ordinal,
					},
				],
				faux.getModel(),
				8_192,
				undefined,
				undefined,
				undefined,
				SESSION_CHAIN_L1_SUMMARIZATION_PROMPT,
				expectedPreviousSummary ?? undefined,
				"off",
				undefined,
				undefined,
				true,
			);
			const parsed = parseSummaryEnvelope(generated.summary);
			generatedL1.push({ ordinal: segment.ordinal, ...parsed });
			previousSummary = parsed.carryForwardMarkdown;
		}

		const finalL1 = generatedL1.at(-1);
		if (!finalL1) throw new Error("summary protocol produced no L1 evidence");
		const rollupSource = {
			schema: "pi-xk.session-chain-rollup-source.v1",
			chainId: "chain_golden",
			branchId: "branch_golden",
			windowIndex: 1,
			startOrdinal: 1,
			endOrdinal: generatedL1.length,
			segmentDeltas: generatedL1.map((summary) => ({
				ordinal: summary.ordinal,
				segmentId: `segment_${summary.ordinal}`,
				artifactId: `artifact_${summary.ordinal}`,
				title: summary.title,
				markdown: summary.segmentDeltaMarkdown,
			})),
			finalCarryForward: {
				ordinal: finalL1.ordinal,
				segmentId: `segment_${finalL1.ordinal}`,
				artifactId: `artifact_${finalL1.ordinal}`,
				markdown: finalL1.carryForwardMarkdown,
			},
		};
		faux.appendResponses([
			(context) => {
				const input = parsePromptInput(context, SESSION_CHAIN_L2_SUMMARIZATION_PROMPT);
				if (input.previousSummary !== null || input.additionalFocus !== null) {
					throw new Error("L2 protocol unexpectedly carried a previous summary or additional focus");
				}
				if (!input.conversation.includes(rollupSource.schema)) {
					throw new Error("L2 protocol omitted its ordered L1 source object");
				}
				return fauxAssistantMessage(summaryEvidence("session-chain-l2", fixture.l2));
			},
		]);
		const generatedRollup = await generateSummaryWithMetadata(
			[
				{
					role: "user",
					content: [{ type: "text", text: JSON.stringify(rollupSource) }],
					timestamp: generatedL1.length + 1,
				},
			],
			faux.getModel(),
			4_000,
			undefined,
			undefined,
			undefined,
			SESSION_CHAIN_L2_SUMMARIZATION_PROMPT,
			undefined,
			"off",
			undefined,
			undefined,
			true,
		);
		const l2 = parseRollupEnvelope(generatedRollup.summary);
		const quality = evaluateSessionChainSummaryFixture({
			...fixture,
			l1: generatedL1.map((summary) => ({
				ordinal: summary.ordinal,
				title: summary.title,
				segmentDeltaMarkdown: summary.segmentDeltaMarkdown,
				carryForwardMarkdown: summary.carryForwardMarkdown,
			})),
			l2,
		});
		return { ...quality, providerCalls: faux.state.callCount, l2Rollups: 1 };
	} finally {
		faux.unregister();
	}
}

async function main() {
	const fixturePath = process.argv[2];
	if (!fixturePath) {
		throw new Error("usage: node --import tsx scripts/evaluate-session-chain-summaries.mjs <fixture.json>");
	}
	const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
	const report = await executeSessionChainSummaryProtocolFixture(fixture);
	console.log(JSON.stringify(report, null, 2));
	if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
