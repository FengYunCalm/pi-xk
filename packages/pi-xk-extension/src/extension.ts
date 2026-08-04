import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SkillService } from "pi-xk-core";
import { createPiXkGoalExtension, getPiXkSessionChainGateState, type PiXkGoalExtensionOptions } from "./index.ts";
import { MemoryController } from "./memory-controller.ts";
import { createPiXkMemoryExtension, type PiXkMemoryExtensionOptions } from "./memory-extension.ts";
import { MemorySourceBridge } from "./memory-source-bridge.ts";
import { renderPiXkRuntimeStatus } from "./runtime-status.ts";
import { SessionChainController } from "./session-chain-controller.ts";
import { createPiXkSessionChainExtension, type PiXkSessionChainExtensionOptions } from "./session-chain-extension.ts";

export interface PiXkRuntimeExtensionOptions {
	goal?: Omit<PiXkGoalExtensionOptions, "shouldDeferGoalContinuation">;
	chain?: Omit<PiXkSessionChainExtensionOptions, "createController" | "getGateState">;
	memory?: Omit<PiXkMemoryExtensionOptions, "createController" | "createSourceBridge" | "getCompactionGateState">;
	createController?: (projectRoot: string) => SessionChainController;
	createMemoryController?: (projectRoot: string) => MemoryController;
}

/** Compose the public Pi-XK Goal/Task controls with the project Session Chain. */
export function createPiXkRuntimeExtension(options: PiXkRuntimeExtensionOptions = {}): ExtensionFactory {
	const skillAgentDir = resolve(options.memory?.agentDir ?? getAgentDir());
	const skillProjectId = (projectRoot: string): string =>
		`project_${createHash("sha256").update(projectRoot).digest("hex").slice(0, 32)}`;
	const projectSkillServices = new Map<string, SkillService>();
	const globalSkillServices = new Map<string, SkillService>();
	const projectSkillServiceFor = (projectRoot: string): SkillService => {
		const existing = projectSkillServices.get(projectRoot);
		if (existing) return existing;
		const service =
			options.memory?.createProjectSkillService?.(projectRoot) ??
			new SkillService(projectRoot, { scope: "project", projectId: skillProjectId(projectRoot) });
		projectSkillServices.set(projectRoot, service);
		return service;
	};
	const globalSkillServiceFor = (projectRoot: string): SkillService => {
		const existing = globalSkillServices.get(projectRoot);
		if (existing) return existing;
		const service =
			options.memory?.createGlobalSkillService?.(projectRoot, skillAgentDir) ??
			new SkillService(projectRoot, {
				scope: "global",
				agentDir: skillAgentDir,
				projectId: skillProjectId(projectRoot),
			});
		globalSkillServices.set(projectRoot, service);
		return service;
	};
	const memoryControllers = new Map<string, MemoryController>();
	const memoryControllerFor = (projectRoot: string): MemoryController => {
		const existing = memoryControllers.get(projectRoot);
		if (existing) return existing;
		const controller = options.createMemoryController?.(projectRoot) ?? new MemoryController({ projectRoot });
		memoryControllers.set(projectRoot, controller);
		return controller;
	};
	const memoryBridges = new Map<string, MemorySourceBridge>();
	const memoryBridgeFor = (projectRoot: string): MemorySourceBridge => {
		const existing = memoryBridges.get(projectRoot);
		if (existing) return existing;
		const bridge = new MemorySourceBridge({ projectRoot, controller: memoryControllerFor(projectRoot) });
		memoryBridges.set(projectRoot, bridge);
		return bridge;
	};
	const controllers = new Map<string, SessionChainController>();
	const controllerFor = (projectRoot: string): SessionChainController => {
		const existing = controllers.get(projectRoot);
		if (existing) return existing;
		// Memory discovers durable rollup_published events with a fresh settled or started session context.
		const controller = options.createController?.(projectRoot) ?? new SessionChainController({ projectRoot });
		controllers.set(projectRoot, controller);
		return controller;
	};
	const goalExtension = createPiXkGoalExtension({
		...options.goal,
		shouldDeferGoalContinuation: async (ctx: ExtensionContext) => {
			const controller = controllerFor(ctx.cwd);
			if (!controller.getCurrentBinding(ctx.sessionManager)) return false;
			return (await controller.getThreshold(ctx.sessionManager)).threshold !== "none";
		},
	});
	const chainExtension = createPiXkSessionChainExtension({
		...options.chain,
		createController: controllerFor,
		getGateState: getPiXkSessionChainGateState,
	});
	const memoryExtension = createPiXkMemoryExtension({
		...options.memory,
		createController: memoryControllerFor,
		createSourceBridge: memoryBridgeFor,
		createProjectSkillService: projectSkillServiceFor,
		createGlobalSkillService: globalSkillServiceFor,
		getCompactionGateState: async (ctx) => {
			const gates = await getPiXkSessionChainGateState(ctx);
			const activeGate = Object.entries(gates).find(([, blocked]) => blocked);
			if (activeGate) return { blocked: true, reason: `${activeGate[0]} is active` };
			const chain = controllerFor(ctx.cwd);
			const status = await chain.getCurrentStatus(ctx.sessionManager);
			if (status?.pendingRolloverTargetSegmentId) {
				return { blocked: true, reason: "Session Chain rollover is pending" };
			}
			return { blocked: false };
		},
		onProjectClosed: async (projectRoot, controller, bridge) => {
			if (memoryControllers.get(projectRoot) === controller) memoryControllers.delete(projectRoot);
			if (memoryBridges.get(projectRoot) === bridge) memoryBridges.delete(projectRoot);
			projectSkillServices.delete(projectRoot);
			globalSkillServices.delete(projectRoot);
			await options.memory?.onProjectClosed?.(projectRoot, controller, bridge);
		},
	});

	return (pi: ExtensionAPI): void => {
		// Goal/Task input and settled gates run before physical chain replacement.
		goalExtension(pi);
		chainExtension(pi);
		memoryExtension(pi);
		pi.registerCommand("xk", {
			description: "Inspect the current Pi-XK Chain, Goal, Task, Rollup, and recovery state",
			handler: async (args, ctx) => {
				if (args.trim() !== "status") {
					ctx.ui.notify("Pi-XK: usage: /xk status", "error");
					return;
				}
				ctx.ui.notify(
					await renderPiXkRuntimeStatus(ctx, controllerFor(ctx.cwd), memoryControllerFor(ctx.cwd).getService(), {
						project: projectSkillServiceFor(ctx.cwd),
						global: globalSkillServiceFor(ctx.cwd),
					}),
					"info",
				);
			},
		});
	};
}

const runtimeExtension = createPiXkRuntimeExtension();

export default function piXkExtension(pi: ExtensionAPI): void {
	runtimeExtension(pi);
}
