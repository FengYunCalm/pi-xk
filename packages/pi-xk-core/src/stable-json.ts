import { GoalValidationError } from "./contract.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJson(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new GoalValidationError("Stable JSON does not support non-finite numbers");
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeJson);
	}
	if (isRecord(value)) {
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			normalized[key] = normalizeJson(value[key]);
		}
		return normalized;
	}
	throw new GoalValidationError("Stable JSON only supports plain JSON values");
}

export function stableJsonStringify(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}
