import { describe, expect, it } from "vitest";
import {
	SEGMENT_SUMMARY_SCHEMA,
	SESSION_CHAIN_SPEC_SCHEMA,
	type SegmentSummaryV1,
	type SessionChainSpecV1,
	SessionChainValidationError,
	validateSegmentSummaryV1,
	validateSessionChainSpecV1,
} from "../src/session-chain-contract.ts";

function createSpec(): SessionChainSpecV1 {
	return {
		schema: SESSION_CHAIN_SPEC_SCHEMA,
		chainId: "chain_contract",
		title: "Session chain contract",
		cwd: "/project",
		rootBranchId: "branch_main",
		rootSegment: {
			segmentId: "019f-session-root",
			ordinal: 1,
			location: { kind: "managed", fileName: "000001_019f-session-root.jsonl" },
			predecessorSegmentId: null,
			summaryInArtifactId: null,
			createdAt: "2026-07-22T00:00:00.000Z",
		},
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function createSummary(): SegmentSummaryV1 {
	return {
		schema: SEGMENT_SUMMARY_SCHEMA,
		chainId: "chain_contract",
		branchId: "branch_main",
		sourceSegmentId: "019f-session-root",
		sourceLeafId: "leaf-source",
		targetSegmentId: "019f-session-next",
		baseSummaryArtifactId: null,
		sourceRange: {
			firstEntryId: "entry-first",
			lastEntryId: "leaf-source",
			entryCount: 8,
			entriesHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
		segmentDeltaMarkdown: "## Segment delta\n\n- Added chain contracts.",
		carryForwardMarkdown: "## Carry forward\n\nContinue with the host rollover API.",
		generator: {
			provider: "faux",
			modelId: "faux-model",
			promptVersion: "session-chain-summary-v1",
			inputTokens: 1200,
			outputTokens: 240,
			generatedAt: "2026-07-22T00:01:00.000Z",
		},
	};
}

describe("Session Chain contracts", () => {
	it("strictly validates a managed root Segment", () => {
		expect(validateSessionChainSpecV1(createSpec())).toEqual(createSpec());
		expect(() => validateSessionChainSpecV1({ ...createSpec(), extra: true })).toThrow(SessionChainValidationError);
		expect(() =>
			validateSessionChainSpecV1({
				...createSpec(),
				rootSegment: {
					...createSpec().rootSegment,
					location: { kind: "managed", fileName: "../root.jsonl" },
				},
			}),
		).toThrow("fileName");
	});

	it("accepts an external root without converting it to a managed Segment", () => {
		const spec = createSpec();
		spec.rootSegment.location = { kind: "external-root", absolutePath: "/home/user/session.jsonl" };
		expect(validateSessionChainSpecV1(spec).rootSegment.location).toEqual(spec.rootSegment.location);
		expect(() =>
			validateSessionChainSpecV1({
				...spec,
				rootSegment: {
					...spec.rootSegment,
					location: { kind: "external-root", absolutePath: "relative/session.jsonl" },
				},
			}),
		).toThrow("absolutePath");
	});

	it("validates the recursive Segment summary provenance", () => {
		expect(validateSegmentSummaryV1(createSummary())).toEqual(createSummary());
		expect(() =>
			validateSegmentSummaryV1({
				...createSummary(),
				sourceRange: { ...createSummary().sourceRange, entriesHash: "not-a-hash" },
			}),
		).toThrow("entriesHash");
		expect(() =>
			validateSegmentSummaryV1({
				...createSummary(),
				carryForwardMarkdown: "",
			}),
		).toThrow("carryForwardMarkdown");
	});
});
