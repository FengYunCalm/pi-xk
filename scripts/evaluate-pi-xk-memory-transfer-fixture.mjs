import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildMemoryTransferEffectFixture } from "../evaluation/capabilities/fixtures/memory-transfer-effect-fixture.mjs";
import { evaluateMemoryTransferReport, validateMemoryTransferPlan } from "./evaluate-pi-xk-memory-transfer.mjs";

const planPath = resolve(process.argv[2] ?? "evaluation/capabilities/memory-transfer-plan.json");
const plan = validateMemoryTransferPlan(JSON.parse(await readFile(planPath, "utf8")));
const report = buildMemoryTransferEffectFixture(plan);
const summary = evaluateMemoryTransferReport(plan, report);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.claimReady) process.exitCode = 1;
