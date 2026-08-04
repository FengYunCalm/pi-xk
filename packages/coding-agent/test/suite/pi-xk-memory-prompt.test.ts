import { describe, expect, it } from "vitest";
import { MEMORY_CAPTURE_PROMPT, MEMORY_CAPTURE_PROMPT_VERSION } from "../../../pi-xk-extension/src/memory-prompt.ts";

describe("Pi-XK Memory capture prompt", () => {
	it("names every constrained enum so providers cannot invent semantic kinds", () => {
		expect(MEMORY_CAPTURE_PROMPT_VERSION).toBe("pi-xk.memory-capture-v3");
		expect(MEMORY_CAPTURE_PROMPT).toContain(
			"cue.kind must be exactly one of project, domain, component, symbol, workflow, topic.",
		);
		expect(MEMORY_CAPTURE_PROMPT).toContain(
			"replacement.kind must be exactly one of fact, decision, constraint, preference, procedure, lesson, outcome, open_question.",
		);
		expect(MEMORY_CAPTURE_PROMPT).toContain("Do not invent enum values such as artifact.");
	});
});
