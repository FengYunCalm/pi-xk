export interface PiXkReleaseManifestV1 {
	schema: "pi-xk.github-release.v1";
	version: string;
	tag: string;
	sourceCommit: string;
	piBaseVersion: string;
	entrypoint: "pi-xk";
	extension: "pi-xk-extension/dist/extension.js";
}

const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MANIFEST_KEYS = ["schema", "version", "tag", "sourceCommit", "piBaseVersion", "entrypoint", "extension"].sort();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePiXkReleaseManifest(value: unknown, piBaseVersion: string): PiXkReleaseManifestV1 | undefined {
	if (!isRecord(value)) return undefined;
	const keys = Object.keys(value).sort();
	if (keys.length !== MANIFEST_KEYS.length || keys.some((key, index) => key !== MANIFEST_KEYS[index])) {
		return undefined;
	}
	if (value.schema !== "pi-xk.github-release.v1") return undefined;
	if (typeof value.version !== "string" || !SEMVER_PATTERN.test(value.version)) return undefined;
	if (value.tag !== `pi-xk-v${value.version}`) return undefined;
	if (typeof value.sourceCommit !== "string" || !SOURCE_COMMIT_PATTERN.test(value.sourceCommit)) return undefined;
	if (value.piBaseVersion !== piBaseVersion) return undefined;
	if (value.entrypoint !== "pi-xk") return undefined;
	if (value.extension !== "pi-xk-extension/dist/extension.js") return undefined;
	return {
		schema: "pi-xk.github-release.v1",
		version: value.version,
		tag: value.tag,
		sourceCommit: value.sourceCommit,
		piBaseVersion,
		entrypoint: "pi-xk",
		extension: "pi-xk-extension/dist/extension.js",
	};
}
