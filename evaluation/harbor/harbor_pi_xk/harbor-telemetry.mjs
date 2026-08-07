import { createInterface } from "node:readline";

const schema = "pi-xk.harbor-telemetry.v1";
let assistantMessages = 0;
let toolCalls = 0;

function nonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emit(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		continue;
	}
	if (parsed?.type !== "message_end" || parsed?.message?.role !== "assistant") continue;
	const usage = parsed.message.usage ?? {};
	assistantMessages += 1;
	if (Array.isArray(parsed.message.content)) {
		toolCalls += parsed.message.content.filter((block) => block?.type === "toolCall").length;
	}
	emit({
		schema,
		event: "assistant_usage",
		input_tokens: nonNegativeNumber(usage.input),
		output_tokens: nonNegativeNumber(usage.output),
		cache_read_tokens: nonNegativeNumber(usage.cacheRead),
		cache_write_tokens: nonNegativeNumber(usage.cacheWrite),
		cost_usd: nonNegativeNumber(usage.cost?.total),
	});
}

emit({ schema, event: "stream_summary", assistant_messages: assistantMessages, tool_calls: toolCalls });
