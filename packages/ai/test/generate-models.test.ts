import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const VERCEL_URL = "https://ai-gateway.vercel.sh/v1/models";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/models";
const generatorPath = fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url));

const roots: string[] = [];

function createPackageRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-model-generator-test-"));
	roots.push(root);
	mkdirSync(join(root, "src", "providers", "data"), { recursive: true });
	writeFileSync(join(root, "src", "models.generated.ts"), "original aggregator\n");
	writeFileSync(join(root, "src", "providers", "sentinel.models.ts"), "original provider\n");
	writeFileSync(join(root, "src", "providers", "data", "sentinel.json"), '{"original":true}\n');
	return root;
}

function snapshotGeneratedFiles(root: string): Record<string, string> {
	const providersDir = join(root, "src", "providers");
	const snapshot: Record<string, string> = {
		"src/models.generated.ts": readFileSync(join(root, "src", "models.generated.ts"), "utf8"),
	};
	for (const entry of readdirSync(providersDir).sort()) {
		if (entry.endsWith(".models.ts")) {
			snapshot[`src/providers/${entry}`] = readFileSync(join(providersDir, entry), "utf8");
		}
	}
	for (const entry of readdirSync(join(providersDir, "data")).sort()) {
		snapshot[`src/providers/data/${entry}`] = readFileSync(join(providersDir, "data", entry), "utf8");
	}
	return snapshot;
}

function runGenerator(
	packageRoot: string,
	options: { failUrl?: string; emptyUrl?: string } = {},
): ReturnType<typeof spawnSync> {
	const preloaderPath = join(packageRoot, "fetch-fixture.mjs");
	writeFileSync(
		preloaderPath,
		`const failUrl = process.env.PI_TEST_FAIL_URL;
const emptyUrl = process.env.PI_TEST_EMPTY_URL;
const response = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (url === failUrl) return response({ error: "fixture failure" }, 503);
	if (url === emptyUrl) return response(url === ${JSON.stringify(MODELS_DEV_URL)} ? {} : { data: [] });
	if (url === ${JSON.stringify(MODELS_DEV_URL)}) {
		return response({
			openai: {
				models: {
					"fixture-openai": {
						name: "Fixture OpenAI",
						tool_call: true,
						modalities: { input: ["text"] },
						cost: { input: 1, output: 1 },
						limit: { context: 8192, output: 1024 },
					},
				},
			},
			nvidia: {
				models: {
					"fixture/nvidia": {
						name: "Fixture NVIDIA",
						tool_call: true,
						modalities: { input: ["text"] },
						cost: { input: 1, output: 1 },
						limit: { context: 8192, output: 1024 },
					},
				},
			},
		});
	}
	if (url === ${JSON.stringify(OPENROUTER_URL)}) {
		return response({
			data: [{
				id: "fixture/openrouter",
				name: "Fixture OpenRouter",
				supported_parameters: ["tools"],
				architecture: { modality: "text->text" },
				pricing: { prompt: "0.000001", completion: "0.000002" },
				context_length: 8192,
			}],
		});
	}
	if (url === ${JSON.stringify(VERCEL_URL)}) {
		return response({
			data: [{
				id: "fixture/vercel",
				name: "Fixture Vercel",
				tags: ["tool-use"],
				pricing: { input: "0.000001", output: "0.000002" },
				context_window: 8192,
				max_tokens: 1024,
			}],
		});
	}
	if (url === ${JSON.stringify(NVIDIA_URL)}) {
		return response({ data: [{ id: "fixture/nvidia" }] });
	}
	throw new Error(\`Unexpected URL: \${url}\`);
};
`,
	);
	return spawnSync(
		process.execPath,
		["--import", preloaderPath, generatorPath, "--strict", "--package-root", packageRoot],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PI_TEST_FAIL_URL: options.failUrl ?? "",
				PI_TEST_EMPTY_URL: options.emptyUrl ?? "",
			},
		},
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model catalog generation", () => {
	for (const failure of [
		{ name: "models.dev", url: MODELS_DEV_URL },
		{ name: "OpenRouter", url: OPENROUTER_URL },
		{ name: "Vercel AI Gateway", url: VERCEL_URL },
		{ name: "NVIDIA NIM", url: NVIDIA_URL },
	]) {
		it(`preserves the complete catalog when ${failure.name} fails`, () => {
			const packageRoot = createPackageRoot();
			const before = snapshotGeneratedFiles(packageRoot);

			const result = runGenerator(packageRoot, {
				failUrl: failure.url,
			});

			expect(result.status).not.toBe(0);
			expect(snapshotGeneratedFiles(packageRoot)).toEqual(before);
		});
	}

	for (const source of [
		{ name: "models.dev", url: MODELS_DEV_URL },
		{ name: "OpenRouter", url: OPENROUTER_URL },
		{ name: "Vercel AI Gateway", url: VERCEL_URL },
		{ name: "NVIDIA NIM", url: NVIDIA_URL },
	]) {
		it(`preserves the complete catalog when ${source.name} returns an empty catalog`, () => {
			const packageRoot = createPackageRoot();
			const before = snapshotGeneratedFiles(packageRoot);

			const result = runGenerator(packageRoot, { emptyUrl: source.url });

			expect(result.status).not.toBe(0);
			expect(snapshotGeneratedFiles(packageRoot)).toEqual(before);
		});
	}

	it("publishes a complete staged catalog only after all sources succeed", () => {
		const packageRoot = createPackageRoot();

		const result = runGenerator(packageRoot);

		expect(result.status, String(result.stderr)).toBe(0);
		const snapshot = snapshotGeneratedFiles(packageRoot);
		expect(snapshot["src/models.generated.ts"]).toContain("export const MODELS");
		expect(snapshot["src/providers/openrouter.models.ts"]).toContain("OPENROUTER_MODELS");
		expect(snapshot["src/providers/data/openrouter.json"]).toContain("openrouter/fusion");
		expect(snapshot).not.toHaveProperty("src/providers/sentinel.models.ts");
		expect(snapshot).not.toHaveProperty("src/providers/data/sentinel.json");
	});
});
