import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ExtensionFactory, LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import type { Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness } from "./harness.ts";

function managedSkill(): Skill {
	return {
		name: "ambient-memory-review",
		description: "Review Ambient Memory using the current managed Skill revision.",
		filePath: "/managed/.pi/skills/ambient-memory-review/SKILL.md",
		baseDir: "/managed/.pi/skills/ambient-memory-review",
		sourceInfo: createSyntheticSourceInfo("/managed/.pi/skills/ambient-memory-review/SKILL.md", {
			source: "local",
			scope: "project",
		}),
		disableModelInvocation: false,
	};
}

function resourceLoader(extensions: LoadExtensionsResult, reloadSkills: () => Promise<void>): ResourceLoader {
	let skills: Skill[] = [];
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reloadSkills: async () => {
			const previousCount = skills.length;
			await reloadSkills();
			skills = [managedSkill()];
			return { previousCount, currentCount: skills.length, diagnostics: [] };
		},
		reload: async () => {},
	};
}

describe("Pi-XK Skill-only reload", () => {
	it("applies a settled Skill generation without restarting extensions or changing tools", async () => {
		let starts = 0;
		let shutdowns = 0;
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				starts += 1;
			});
			pi.on("session_shutdown", () => {
				shutdowns += 1;
			});
			pi.on("agent_settled", async (_event, ctx) => {
				await ctx.reloadSkillsAtSettledBoundary();
			});
		};
		const extensions = await createTestExtensionsResult([{ factory: extension }]);
		const reload = vi.fn(async () => {});
		const harness = await createHarness({ resourceLoader: resourceLoader(extensions, reload) });
		await harness.session.bindExtensions({});
		const activeTools = harness.session.getActiveToolNames();
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first run");
			},
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second run");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(prompts[0]).not.toContain("ambient-memory-review");
		expect(prompts[1]).toContain("ambient-memory-review");
		expect(reload).toHaveBeenCalledTimes(2);
		expect(starts).toBe(1);
		expect(shutdowns).toBe(0);
		expect(harness.session.getActiveToolNames()).toEqual(activeTools);
		harness.cleanup();
	});

	it("rejects a Skill-only reload outside agent_settled", async () => {
		const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		const harness = await createHarness({ resourceLoader: resourceLoader(extensions, async () => {}) });
		await expect(harness.session.reloadSkillsAtSettledBoundary()).rejects.toThrow("agent_settled");
		harness.cleanup();
	});

	it("retains the prior Skill snapshot and base prompt when a settled reload fails", async () => {
		let starts = 0;
		let shutdowns = 0;
		let shouldFail = false;
		const extension: ExtensionFactory = (pi) => {
			pi.on("session_start", () => {
				starts += 1;
			});
			pi.on("session_shutdown", () => {
				shutdowns += 1;
			});
			pi.on("agent_settled", async (_event, ctx) => {
				await ctx.reloadSkillsAtSettledBoundary();
			});
		};
		const extensions = await createTestExtensionsResult([{ factory: extension }]);
		const reload = vi.fn(async () => {
			if (shouldFail) throw new Error("synthetic Skill reload failure");
		});
		const harness = await createHarness({ resourceLoader: resourceLoader(extensions, reload) });
		await harness.session.bindExtensions({});
		const activeTools = harness.session.getActiveToolNames();
		const prompts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("publish initial Skill snapshot"),
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				shouldFail = true;
				return fauxAssistantMessage("reload fails after this run");
			},
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("old Skill snapshot remains active");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.prompt("third");

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("ambient-memory-review");
		expect(prompts[1]).toContain("ambient-memory-review");
		expect(reload).toHaveBeenCalledTimes(3);
		expect(starts).toBe(1);
		expect(shutdowns).toBe(0);
		expect(harness.session.getActiveToolNames()).toEqual(activeTools);
		harness.cleanup();
	});
});
