import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPiXkGoalExtension, getPiXkSessionChainGateState, type PiXkGoalExtensionOptions } from "./index.ts";
import { MemoryController, type MemoryGenerationHost } from "./memory-controller.ts";
import { createPiXkMemoryExtension, type PiXkMemoryExtensionOptions } from "./memory-extension.ts";
import { MemorySourceBridge } from "./memory-source-bridge.ts";
import { renderPiXkRuntimeStatus } from "./runtime-status.ts";
import { SessionChainController, type SessionChainHost } from "./session-chain-controller.ts";
import { createPiXkSessionChainExtension, type PiXkSessionChainExtensionOptions } from "./session-chain-extension.ts";

export interface PiXkRuntimeExtensionOptions {
	goal?: Omit<PiXkGoalExtensionOptions, "shouldDeferGoalContinuation">;
	chain?: Omit<PiXkSessionChainExtensionOptions, "createController" | "getGateState">;
	memory?: Omit<PiXkMemoryExtensionOptions, "createController" | "createSourceBridge" | "getCompactionGateState">;
	createController?: (projectRoot: string) => SessionChainController;
	createMemoryController?: (projectRoot: string) => MemoryController;
}

function memoryGenerationHost(host: SessionChainHost): MemoryGenerationHost {
	const modelId = host.model?.id ?? host.model?.modelId;
	return {
		model:
			host.model?.provider && modelId
				? { provider: host.model.provider, modelId, contextWindow: host.model.contextWindow }
				: undefined,
		generate: async (input) => {
			const generated = await host.summarizeSessionContext({
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: input.source }],
						timestamp: Date.now(),
					},
				],
				customInstructions: input.instructions,
				replaceInstructions: true,
				maxOutputTokens: input.maxOutputTokens,
			});
			return { text: generated.summary, model: generated.model };
		},
	};
}

/** Compose the public Pi-XK Goal/Task controls with the project Session Chain. */
export function createPiXkRuntimeExtension(options: PiXkRuntimeExtensionOptions = {}): ExtensionFactory {
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
		const controller =
			options.createController?.(projectRoot) ??
			new SessionChainController({
				projectRoot,
				onRollupPublished: (source, host) => {
					void memoryBridgeFor(projectRoot)
						.capturePublishedRollup(source, memoryGenerationHost(host))
						.catch((error) =>
							options.memory?.onMemoryError?.(error instanceof Error ? error : new Error(String(error))),
						);
				},
			});
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
					await renderPiXkRuntimeStatus(ctx, controllerFor(ctx.cwd), memoryControllerFor(ctx.cwd).getService()),
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
