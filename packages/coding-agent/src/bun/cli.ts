#!/usr/bin/env node
import { runBunCli } from "./run-cli.ts";

await runBunCli(process.argv.slice(2));
