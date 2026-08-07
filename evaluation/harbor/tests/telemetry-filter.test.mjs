import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../harbor_pi_xk/harbor-telemetry.mjs", import.meta.url));
const input = [
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "sensitive assistant answer" }],
			usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.001 } },
		},
	}),
	JSON.stringify({ type: "message_start", message: { role: "user", content: "sensitive user prompt" } }),
	"DEEPSEEK_API_KEY=fixture-key-must-not-persist",
].join("\n");

const result = spawnSync(process.execPath, [scriptPath], { input, encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stderr, "");
assert.doesNotMatch(result.stdout, /sensitive assistant answer|sensitive user prompt|fixture-key/);

const events = result.stdout
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
assert.deepEqual(events, [
	{
		schema: "pi-xk.harbor-telemetry.v1",
		event: "assistant_usage",
		input_tokens: 12,
		output_tokens: 7,
		cache_read_tokens: 3,
		cache_write_tokens: 2,
		cost_usd: 0.001,
	},
	{
		schema: "pi-xk.harbor-telemetry.v1",
		event: "stream_summary",
		assistant_messages: 1,
		tool_calls: 0,
	},
]);
