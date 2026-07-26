import "./restore-sandbox-env-preload.ts";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { main } from "../main.ts";
import "./register-bedrock.ts";

export async function runBunCli(args: string[], processTitle = APP_NAME): Promise<void> {
	process.title = processTitle;
	process.env.PI_CODING_AGENT = "true";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	registerBunOAuthFlows();
	configureHttpDispatcher();
	await main(args);
}
