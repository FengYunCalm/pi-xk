import { createHash } from "node:crypto";
import {
	CHAIN_ROLLUP_SCHEMA,
	type SessionChainRollupContentV1,
	type SessionChainRollupV1,
	validateSegmentSummaryTitle,
} from "pi-xk-core";
import { SessionChainControllerError } from "./session-chain-errors.ts";

export interface ParsedSummaryEnvelope {
	title: string;
	segmentDeltaMarkdown: string;
	carryForwardMarkdown: string;
}

export interface RollupFailureClassification {
	errorCode: string;
	retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function hashText(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function rollupSourceDigest(input: {
	chainId: string;
	branchId: string;
	windowIndex: number;
	startOrdinal: number;
	endOrdinal: number;
	segmentIds: readonly string[];
	summaryArtifactIds: readonly string[];
}): string {
	return hashText(
		JSON.stringify({
			schema: CHAIN_ROLLUP_SCHEMA,
			chainId: input.chainId,
			branchId: input.branchId,
			windowIndex: input.windowIndex,
			startOrdinal: input.startOrdinal,
			endOrdinal: input.endOrdinal,
			segments: input.segmentIds.map((segmentId, index) => ({
				segmentId,
				summaryArtifactId: input.summaryArtifactIds[index],
			})),
		}),
	);
}

export function parseSummaryEnvelope(summary: string): ParsedSummaryEnvelope {
	const match =
		/^\s*<title>([^\r\n]*)<\/title>\s*<segment-delta>\s*([\s\S]*?)\s*<\/segment-delta>\s*<carry-forward>\s*([\s\S]*?)\s*<\/carry-forward>\s*$/.exec(
			summary,
		);
	const segmentDeltaMarkdown = match?.[2]?.trim();
	const carryForwardMarkdown = match?.[3]?.trim();
	if (!match?.[1] || !segmentDeltaMarkdown || !carryForwardMarkdown) {
		throw new SessionChainControllerError(
			"Session Chain summarizer returned an invalid summary envelope; expected title, segment-delta, and carry-forward blocks",
		);
	}
	let title: string;
	try {
		title = validateSegmentSummaryTitle(match[1]);
	} catch (error) {
		throw new SessionChainControllerError(
			`Session Chain summarizer returned an invalid title: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { title, segmentDeltaMarkdown, carryForwardMarkdown };
}

export function parseRollupEnvelope(summary: string): SessionChainRollupContentV1 {
	const match = /^\s*<chain-rollup>([\s\S]*?)<\/chain-rollup>\s*$/.exec(summary);
	if (!match?.[1]) throw new SessionChainControllerError("Session Chain Rollup response has an invalid envelope");
	let value: unknown;
	try {
		value = JSON.parse(match[1]);
	} catch {
		throw new SessionChainControllerError("Session Chain Rollup response is not valid JSON");
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["state", "decisions", "constraints", "completed", "unresolved", "nextActions"])
	) {
		throw new SessionChainControllerError("Session Chain Rollup response has invalid fields");
	}
	if (!isNonEmptyString(value.state)) {
		throw new SessionChainControllerError("Session Chain Rollup state must be non-empty");
	}
	const readList = (field: string): string[] => {
		const list = value[field];
		if (!Array.isArray(list) || list.some((item) => !isNonEmptyString(item))) {
			throw new SessionChainControllerError(`Session Chain Rollup ${field} must be a string array`);
		}
		return [...list];
	};
	return {
		state: value.state,
		decisions: readList("decisions"),
		constraints: readList("constraints"),
		completed: readList("completed"),
		unresolved: readList("unresolved"),
		nextActions: readList("nextActions"),
	};
}

export function classifyRollupFailure(stage: string, error: unknown): RollupFailureClassification {
	if (stage === "source_validation") return { errorCode: "rollup_source_invalid", retryable: false };
	if (stage === "markdown_projection") {
		return { errorCode: "rollup_projection_rebuild_required", retryable: false };
	}
	if (stage === "event_publication") return { errorCode: "rollup_event_publication_failed", retryable: true };
	if (error instanceof SessionChainControllerError) {
		return {
			errorCode: error.message.includes("Rollup response") ? "rollup_invalid_response" : "rollup_generation_invalid",
			retryable: false,
		};
	}
	return { errorCode: "rollup_provider_failed", retryable: true };
}

export function renderRollupMarkdown(artifactId: string, rollup: SessionChainRollupV1): string {
	const section = (title: string, items: readonly string[]): string =>
		[`## ${title}`, "", ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."])].join("\n");
	return [
		`# Session Chain Rollup W${rollup.windowIndex}`,
		"",
		`- Chain: ${rollup.chainId}`,
		`- Branch: ${rollup.branchId}`,
		`- Segments: S${rollup.startOrdinal}–S${rollup.endOrdinal}`,
		`- Artifact: ${artifactId}`,
		`- Source digest: ${rollup.sourceDigest}`,
		`- Generator: ${rollup.provenance.generator}`,
		`- Model: ${rollup.provenance.model}`,
		`- Prompt: ${rollup.provenance.promptVersion}`,
		`- Generated: ${rollup.provenance.generatedAt}`,
		"",
		"## State",
		"",
		rollup.rollup.state,
		"",
		section("Decisions", rollup.rollup.decisions),
		"",
		section("Constraints", rollup.rollup.constraints),
		"",
		section("Completed", rollup.rollup.completed),
		"",
		section("Unresolved", rollup.rollup.unresolved),
		"",
		section("Next actions", rollup.rollup.nextActions),
		"",
		"## Sources",
		"",
		...rollup.segmentIds.map(
			(segmentId, index) =>
				`- S${rollup.startOrdinal + index}: ${segmentId} · ${rollup.summaryArtifactIds[index] ?? "missing"}`,
		),
		"",
	].join("\n");
}

export function summaryBudget(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		throw new SessionChainControllerError("Session Chain summary requires a positive model context window");
	}
	return Math.min(8_192, Math.max(2_048, Math.floor(contextWindow * 0.05)));
}
