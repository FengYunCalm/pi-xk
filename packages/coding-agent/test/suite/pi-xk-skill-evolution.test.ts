import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SkillService } from "../../../pi-xk-core/src/index.ts";
import { MemoryController } from "../../../pi-xk-extension/src/memory-controller.ts";
import { createPiXkMemoryExtension } from "../../../pi-xk-extension/src/memory-extension.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const skillServices: SkillService[] = [];
const memoryControllers: MemoryController[] = [];
const temporaryRoots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
	await Promise.all(skillServices.splice(0).map(async (service) => await service.close()));
	for (const controller of memoryControllers.splice(0)) await controller.close();
	for (const harness of harnesses.splice(0)) await harness.shutdown();
	await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Pi-XK Ambient Skill evolution", () => {
	it("publishes a project Skill at settlement, hot-loads it, and records a later managed read as use", async () => {
		let projectSkills: SkillService | undefined;
		let memoryController: MemoryController | undefined;
		const skillErrors: Error[] = [];
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkMemoryExtension({
					onSkillError: (error) => skillErrors.push(error),
					createController: (projectRoot) => {
						memoryController = new MemoryController({ projectRoot });
						memoryControllers.push(memoryController);
						return memoryController;
					},
					createProjectSkillService: (projectRoot) => {
						projectSkills = new SkillService(projectRoot, {
							scope: "project",
							projectId: "project_skill_evolution",
						});
						skillServices.push(projectSkills);
						return projectSkills;
					},
					createGlobalSkillService: (projectRoot) => {
						const service = new SkillService(projectRoot, {
							scope: "global",
							agentDir: join(projectRoot, "agent"),
							projectId: "project_skill_evolution",
						});
						skillServices.push(service);
						return service;
					},
				}),
			],
			resourceLoaderFactory: async ({ tempDir, settingsManager, extensionsResult }) => {
				if (!extensionsResult) throw new Error("Skill evolution test requires its Extension result");
				settingsManager.setProjectTrusted(true);
				const loader = new DefaultResourceLoader({
					cwd: tempDir,
					agentDir: join(tempDir, "agent"),
					settingsManager,
					noExtensions: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionsOverride: () => extensionsResult,
				});
				await loader.reload();
				return loader;
			},
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_skills", {
					action: "create",
					sourceSkills: [],
					uses: [],
					replacement: {
						targetScope: "project",
						name: "ambient-review-workflow",
						description: "Review Ambient Memory changes at the settled publication boundary.",
						applicability: "Use when validating Pi-XK Ambient Memory evolution.",
						divergenceConditions: ["The run has no durable validation evidence."],
						instructions: {
							steps: "Inspect the staged review and wait for the settled publication boundary.",
							validation: "Confirm the immutable Skill revision and managed projection both exist.",
							failureHandling: "Keep the candidate for audit and report the publication failure.",
						},
						resources: [],
					},
					reason: "The current run established a reusable Ambient Memory review workflow.",
				}),
			),
			fauxAssistantMessage("The reusable workflow is staged for settled publication."),
		]);

		await harness.session.prompt("Create a reusable Skill for the workflow validated in this run.");
		if (!projectSkills || !memoryController) throw new Error("Pi-XK services were not initialized");
		const active = await projectSkills.getStore().listRevisions();
		expect(active).toHaveLength(1);
		expect(active[0]?.revision.name).toBe("ambient-review-workflow");
		expect(
			await readFile(join(harness.tempDir, ".pi", "skills", "ambient-review-workflow", "SKILL.md"), "utf8"),
		).toContain("## Validation");
		expect(harness.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain(
			"ambient-review-workflow",
		);
		const memoryReplay = await memoryController.getService().getStore().replay();
		expect(memoryReplay.reconstructions.size).toBe(1);
		expect([...memoryReplay.reconstructions.values()][0]?.outcome).toBe("succeeded");

		const skillPath = join(harness.tempDir, ".pi", "skills", "ambient-review-workflow", "SKILL.md");
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("read", { path: skillPath }));
			},
			fauxAssistantMessage("The managed Skill was applied successfully."),
		]);
		await harness.session.prompt("Use the newly available workflow.");

		expect(prompts[0]).toContain("ambient-review-workflow");
		const model = await projectSkills.getStore().loadReadModel();
		expect(model.uses).toEqual([
			expect.objectContaining({ skillId: active[0]?.revision.skillId, revision: 1, outcome: "success" }),
		]);
		expect(await stat(skillPath)).toMatchObject({ isFile: expect.any(Function) });

		const skillId = active[0]!.revision.skillId;
		for (const failure of ["first reusable divergence", "second reusable divergence"]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: skillPath })),
				fauxAssistantMessage(
					fauxToolCall("pi_xk_review_skills", {
						action: "keep",
						sourceSkills: [{ skillId, expectedRevision: 1 }],
						uses: [
							{
								skillId,
								expectedRevision: 1,
								outcome: "failure",
								divergenceObserved: failure,
							},
						],
						reason: "The managed Skill diverged from the current workflow.",
					}),
				),
				fauxAssistantMessage("The evidence-backed Skill failure is recorded."),
			]);
			await harness.session.prompt("Apply and review the managed Skill.");
		}
		expect((await projectSkills.status()).facts.needsReview).toBe(1);
		await expect(stat(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(harness.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toContain(
			"ambient-review-workflow",
		);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("pi_xk_search_skill_candidates", { query: "Ambient Memory review" })),
			fauxAssistantMessage(fauxToolCall("pi_xk_read_skill_candidate", { skillId, revision: 1, scope: "project" })),
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_skills", {
					action: "revise",
					sourceSkills: [{ skillId, expectedRevision: 1 }],
					uses: [
						{
							skillId,
							expectedRevision: 1,
							outcome: "success",
							divergenceObserved: null,
						},
					],
					replacement: {
						targetScope: "project",
						name: "ambient-review-workflow",
						description: "Review Ambient Memory changes with divergence checks before settled publication.",
						applicability: "Use when validating Pi-XK Ambient Memory evolution after a workflow divergence.",
						divergenceConditions: ["The current run cannot resolve the publication evidence."],
						instructions: {
							steps: "Inspect divergence evidence before applying the settled publication workflow.",
							validation: "Confirm the revised immutable Skill revision and managed projection both exist.",
							failureHandling: "Return to needs_review when two later evidence-backed uses fail.",
						},
						resources: [],
					},
					reason: "Two failures established a reusable divergence check.",
				}),
			),
			fauxAssistantMessage("The revised Skill is staged."),
		]);
		await harness.session.prompt("Review and repair the cooled-down Skill.");

		expect(skillErrors).toEqual([]);
		const finalToolResults = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.slice(-3)
			.map(getMessageText);
		expect(finalToolResults).toEqual([
			expect.stringContaining("skill-candidate-d1"),
			expect.stringContaining("skill-d2"),
			expect.stringContaining('"status":"staged"'),
		]);
		expect((await projectSkills.getStore().timeline(skillId)).map((entry) => entry.revision.revision)).toEqual([
			1, 2,
		]);
		expect((await projectSkills.status()).facts.needsReview).toBe(0);
		expect(await readFile(skillPath, "utf8")).toContain("divergence checks");
		expect(harness.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain(
			"ambient-review-workflow",
		);
	}, 60_000);

	it("keeps an aborted Skill review diagnostic-only", async () => {
		let projectSkills: SkillService | undefined;
		let memoryController: MemoryController | undefined;
		const harness = await createHarness({
			persistedSession: true,
			extensionFactories: [
				createPiXkMemoryExtension({
					createController: (projectRoot) => {
						memoryController = new MemoryController({ projectRoot });
						memoryControllers.push(memoryController);
						return memoryController;
					},
					createProjectSkillService: (projectRoot) => {
						projectSkills = new SkillService(projectRoot, { scope: "project", projectId: "project_aborted" });
						skillServices.push(projectSkills);
						return projectSkills;
					},
					createGlobalSkillService: (projectRoot) => {
						const service = new SkillService(projectRoot, {
							scope: "global",
							agentDir: join(projectRoot, "agent"),
							projectId: "project_aborted",
						});
						skillServices.push(service);
						return service;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_skills", {
					action: "create",
					sourceSkills: [],
					uses: [],
					replacement: {
						targetScope: "project",
						name: "aborted-workflow",
						description: "This candidate must not publish from an aborted run.",
						applicability: "Never active because the source run aborts.",
						divergenceConditions: ["The run did not settle successfully."],
						instructions: {
							steps: "Do not publish.",
							validation: "Require successful settlement.",
							failureHandling: "Retain only the body-free diagnostic.",
						},
						resources: [],
					},
					reason: "Exercise the failed-run publication gate.",
				}),
			),
			fauxAssistantMessage("aborted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("Stage a Skill and then abort.");
		if (!projectSkills || !memoryController) throw new Error("Pi-XK services were not initialized");

		expect(await projectSkills.getStore().listRevisions()).toEqual([]);
		const replay = await memoryController.getService().getStore().replay();
		expect([...replay.reconstructions.values()]).toEqual([expect.objectContaining({ outcome: "aborted" })]);
	}, 20_000);

	it("promotes a project Skill after three successful uses across two Git repositories", async () => {
		const sharedRoot = await mkdtemp(join("/tmp", "pi-xk-global-skill-evolution-"));
		temporaryRoots.push(sharedRoot);
		const agentDir = join(sharedRoot, "agent");
		const skillErrors: Error[] = [];
		const createProject = async (projectId: string, remote: string) => {
			let globalSkills: SkillService | undefined;
			const harness = await createHarness({
				persistedSession: true,
				extensionFactories: [
					createPiXkMemoryExtension({
						agentDir,
						onSkillError: (error) => skillErrors.push(error),
						createController: (projectRoot) => {
							const controller = new MemoryController({ projectRoot });
							memoryControllers.push(controller);
							return controller;
						},
						createProjectSkillService: (projectRoot) => {
							const service = new SkillService(projectRoot, { scope: "project", projectId });
							skillServices.push(service);
							return service;
						},
						createGlobalSkillService: (projectRoot) => {
							globalSkills = new SkillService(projectRoot, { scope: "global", agentDir, projectId });
							skillServices.push(globalSkills);
							return globalSkills;
						},
					}),
				],
				resourceLoaderFactory: async ({ tempDir, settingsManager, extensionsResult }) => {
					if (!extensionsResult) throw new Error("Skill promotion test requires its Extension result");
					settingsManager.setProjectTrusted(true);
					const loader = new DefaultResourceLoader({
						cwd: tempDir,
						agentDir,
						settingsManager,
						noExtensions: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						extensionsOverride: () => extensionsResult,
					});
					await loader.reload();
					return loader;
				},
			});
			harnesses.push(harness);
			await execFile("git", ["init", "--quiet"], { cwd: harness.tempDir });
			await execFile("git", ["remote", "add", "origin", remote], { cwd: harness.tempDir });
			await harness.session.bindExtensions({});
			return {
				harness,
				globalSkills: () => {
					if (!globalSkills) throw new Error("Global Skill service was not initialized");
					return globalSkills;
				},
			};
		};

		const origin = await createProject("project_origin", "https://example.invalid/origin/ambient-skill.git");
		origin.harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("pi_xk_review_skills", {
					action: "create",
					sourceSkills: [],
					uses: [],
					replacement: {
						targetScope: "project",
						name: "cross-project-review",
						description: "Review reusable Ambient Memory publication evidence across projects.",
						applicability: "Use when the same settled publication workflow applies in another repository.",
						divergenceConditions: ["The target repository uses a different publication boundary."],
						instructions: {
							steps: "Inspect the settled publication evidence before applying the workflow.",
							validation: "Require a successful repository-local result.",
							failureHandling: "Record the divergence and keep the global candidate inactive.",
						},
						resources: [],
					},
					reason: "The origin repository established a reusable publication workflow.",
				}),
			),
			fauxAssistantMessage("The project Skill is staged."),
		]);
		await origin.harness.session.prompt("Create the reusable project Skill.");
		const pending = await origin.globalSkills().getStore().listPendingCandidates();
		expect(pending).toHaveLength(1);
		const candidate = pending[0]!;

		const second = await createProject("project_second", "https://example.invalid/second/ambient-skill.git");
		for (let attempt = 0; attempt < 2; attempt += 1) {
			second.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("pi_xk_search_skill_candidates", { query: "cross project review" })),
				fauxAssistantMessage(
					fauxToolCall("pi_xk_read_skill_candidate", { candidateId: candidate.candidateId, scope: "global" }),
				),
				fauxAssistantMessage(
					fauxToolCall("pi_xk_review_skills", {
						action: "keep",
						sourceSkills: [{ skillId: candidate.skillId, expectedRevision: 1 }],
						uses: [
							{
								skillId: candidate.skillId,
								expectedRevision: 1,
								outcome: "success",
								divergenceObserved: null,
							},
						],
						reason: "The candidate workflow succeeded in the second repository.",
					}),
				),
				fauxAssistantMessage(`Candidate trial ${attempt + 1} succeeded.`),
			]);
			await second.harness.session.prompt(`Trial ${attempt + 1} of the global Skill candidate.`);
		}

		expect(skillErrors).toEqual([]);
		const globalModel = await second.globalSkills().getStore().loadReadModel();
		expect(globalModel.promotedCandidateIds).toContain(candidate.candidateId);
		expect(globalModel.uses.filter((use) => use.skillId === candidate.skillId)).toHaveLength(2);
		expect(await readFile(join(agentDir, "skills", "cross-project-review", "SKILL.md"), "utf8")).toContain(
			"successful repository-local result",
		);

		const prompts: string[] = [];
		second.harness.setResponses([
			(context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("The promoted global Skill is available.");
			},
		]);
		await second.harness.session.prompt("Confirm the next run sees the promoted Skill.");
		expect(prompts[0]).toContain("cross-project-review");
	}, 60_000);
});
