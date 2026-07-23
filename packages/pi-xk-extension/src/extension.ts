import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPiXkGoalExtension, getPiXkSessionChainGateState, type PiXkGoalExtensionOptions } from "./index.ts";
import { SessionChainController } from "./session-chain-controller.ts";
import { createPiXkSessionChainExtension, type PiXkSessionChainExtensionOptions } from "./session-chain-extension.ts";

export interface PiXkRuntimeExtensionOptions {
	goal?: Omit<PiXkGoalExtensionOptions, "shouldDeferGoalContinuation">;
	chain?: Omit<PiXkSessionChainExtensionOptions, "createController" | "getGateState">;
	createController?: (projectRoot: string) => SessionChainController;
}

/** Compose the public Pi-XK Goal/Task controls with the project Session Chain. */
export function createPiXkRuntimeExtension(options: PiXkRuntimeExtensionOptions = {}): ExtensionFactory {
	const controllers = new Map<string, SessionChainController>();
	const controllerFor = (projectRoot: string): SessionChainController => {
		const existing = controllers.get(projectRoot);
		if (existing) return existing;
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

	return (pi: ExtensionAPI): void => {
		// Goal/Task input and settled gates run before physical chain replacement.
		goalExtension(pi);
		chainExtension(pi);
	};
}

const runtimeExtension = createPiXkRuntimeExtension();

export default function piXkExtension(pi: ExtensionAPI): void {
	runtimeExtension(pi);
}
