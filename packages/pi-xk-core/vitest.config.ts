import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// SQLite projection and atomic-replacement fixtures are I/O intensive on constrained hosts.
		maxWorkers: 4,
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
});
