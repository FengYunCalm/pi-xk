# Pi-XK Capability Evaluation

This directory separates three questions that cannot be answered by one score.

1. Does Pi-XK improve a public, independently verified code task when the base Pi runtime, model, thinking level, task digest, tool policy, and wall-time budget are the same?
2. Do Pi-XK-only workflows preserve their stated facts and recover correctly under their own deterministic verifiers?
3. When durable context is material, does the model actually select and use the relevant Pi-XK workflow rather than merely starting it?

The first question uses paired public benchmarks. The second verifies Goal, Task, Session Chain, compaction recovery, Memory, Skill, doctor, and local installation behavior. The third uses a minimal real-provider smoke after deterministic proof is already present. A native Pi row is never counted as a failed Pi-XK-only workflow: it lacks the corresponding feature.

## Public Parity

The initial probe uses [Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark) task fixtures through [Harbor](https://github.com/harbor-framework/harbor). The local adapter bundles the same locally built Pi runtime for `pi-native` and `pi-xk`; only Pi-XK loads the extension. Harbor runs each task in an isolated container and writes an independent verifier reward.

`first-public-parity-report.json` is a sanitized `public-calibration` record, not a leaderboard result. It contains no prompts, transcript content, tool arguments, model output, or credential. The paired `aider-polyglot-python-phone-number` DeepSeek run passed for both agents, but it followed asymmetric Pi-XK troubleshooting attempts and is therefore displayed separately rather than counted as formal public parity evidence. Its observed token, time, and cost overhead remains useful calibration for a short one-shot task, not evidence of a general Pi-XK advantage.

The formal public code-task layer uses five pinned Aider Polyglot languages on Harbor `0.20.0` at commit `459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc`. The generated Harbor task keeps environment setup public only where build dependencies require it; the agent phase is limited to the selected model provider host and the verifier has no network access. This prevents general web retrieval or remote solution lookup from becoming a hidden treatment variable. The checked-in public plan fixes the harness, all five tasks, one paired attempt per task, alternating agent order, DeepSeek controls, a 900-second agent timeout enforced by both the plan and generated task, and a no-single-side-retry rule.

The controlled run completed on 2026-08-06: Native Pi and Pi-XK both passed all five tasks, so verifier outcome was tied. Pi-XK used more aggregate input tokens and cost while completing the five-task total slightly faster; the five-run Pi-XK elapsed median was lower, but variance across languages was large. This establishes small-task parity, not a general task-quality advantage. See the [full controlled result](./results/2026-08-06/README.md) and reproduce its validated summary with:

```bash
npm run evaluate:pi-xk-controlled-result
```

```bash
npm run evaluate:pi-xk-public-plan
```

Build the checked-in probe and Pi-XK runtime bundle first, then validate the exact ten-trial command schedule without spending provider credit:

```bash
npm run evaluate:pi-xk-public-parity -- \
  --probe-dir /tmp/pi-xk-harbor-aider-polyglot-probe \
  --bundle /tmp/pi-xk-harbor-bundle \
  --harbor-root /tmp/harbor \
  --harbor-bin /tmp/harbor-venv/bin/harbor \
  --out /tmp/pi-xk-public-parity-dry-run \
  --dry-run
```

For the formal run, inject `DEEPSEEK_API_KEY` into the process environment, remove `--dry-run`, and use a new output directory. The runner rejects dirty Harbor checkouts, including untracked files, and never resumes an interrupted directory or retries only one side of a pair.

A formal public coverage claim requires all five registered pairs. Fewer results remain visible, but the evaluator reports them as insufficient rather than converting one successful task into a complete benchmark claim.

| External suite | What it can establish | What it cannot establish for Pi-XK |
| --- | --- | --- |
| [Aider Polyglot](https://github.com/Aider-AI/polyglot-benchmark) through [Harbor](https://github.com/harbor-framework/harbor) | Controlled multi-language code-editing parity with a deterministic verifier. | Long-running state, real issue triage, or Pi-XK-only workflow benefit. |
| [Terminal-Bench 2.0](https://github.com/harbor-framework/terminal-bench) | End-to-end terminal work in isolated environments. | A direct comparison until the same Pi/Pi-XK adapter, provider, task version, and resource budget are pinned. |
| [SWE-bench Verified](https://github.com/SWE-bench/SWE-bench) | Real repository issue repair with a containerized verifier. | Cheap iteration or a valid cross-model leaderboard comparison; its documented storage and CPU requirements are materially larger. |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | Memory extraction, updates, temporal reasoning, and abstention. | Goal, Task, Session Chain, Rollup, Skill, or ordinary code-editing performance. |
| [tau3-bench](https://github.com/sierra-research/tau2-bench) | Stateful tool-agent-user conversations. | Coding-agent quality or Pi-XK benefit until a Pi tool adapter and a controlled user simulator are added. |
| [DeepSWE/Pier](https://github.com/datacurve-ai/pier) | Long-horizon CLI-agent tasks with air-gapped execution and trajectory capture. | A neutral Pi-XK score until the exact dataset revision, Pi/Pi-XK adapters, verifier, attempt schedule, and resource budget are pinned. |

Published leaderboard numbers from other agents are context, not a Pi-XK comparison. They differ in model, prompt, tools, task revision, budget, and often verifier. Pi-XK claims require a same-model, same-runtime paired trial generated here. A later Pi-XK-versus-third-party-agent lane may deliberately compare whole products with the same provider, task, verifier, and budget, but those results must remain separate from the native-Pi causal comparison because the prompts and tool implementations differ.

## Pi-XK Workflow Evidence

The matrix requires these independent evidence classes:

| Scenario | Required result |
| --- | --- |
| Goal contract continuity | Contract, state revision, acceptance evidence, and restart lifecycle agree. |
| Task child delivery | A single child session produces one durable result and queued parent input remains ordered. |
| Chain rollover and Rollup | L1/L2 provenance, successor, read model, and Markdown projection agree after restart. |
| Compaction continuation | Compaction causes one continuation path and never resends a prior user prompt. |
| Ambient Memory | Search/read/review remains evidence-scoped and state transitions remain valid. |
| Skill evolution | Candidate evidence, managed projection, reload generation, and rollback history agree. |
| Doctor repair | Derived projections rebuild without rewriting event or artifact facts; live locks remain protected. |
| Local installation | Isolated install, upgrade, uninstall, and cold-start extension discovery preserve the ordinary Pi profile boundary. |

Run deterministic workflow evidence with:

```bash
node scripts/run-pi-xk-workflow-validation.mjs --out /tmp/pi-xk-workflow-validation --force
node scripts/evaluate-pi-xk-capabilities.mjs \
  --matrix evaluation/capabilities/capability-matrix.json \
  --report /tmp/pi-xk-workflow-validation/capability-report.json \
  --format markdown
```

Deterministic Pi-XK suite tests are the primary proof of workflow invariants. A real-provider smoke supplements them only where it demonstrates that the model actually chooses the relevant tool or workflow. A smoke that only starts a command does not establish task benefit; a successful workflow report is still not a public code-benchmark win.

The 2026-08-06 result combines all eight deterministic workflow rows with seven real DeepSeek assertions. The real smoke verifies Goal/Task fact completion, Chain/Memory/compaction behavior, Skill publication and no-restart hot reload, and zero-diagnostic doctor checks. Metrics are grouped by actual model execution so records sharing one run are not double-counted.

## Memory Retention And Transfer

The Memory transfer lane tests whether a recorded Memory changes later work in a fresh Session. It separates four matched arms: native Pi, Pi-XK with Memory disabled, Pi-XK with an equal-size irrelevant placebo Memory, and Pi-XK with the relevant learned Memory. Each attempt runs a learning task followed by exact reuse, similar transfer, a changed-rule counterexample, and an unrelated task.

Exact reuse and similar transfer report candidate exposure, successful D2 reads, candidate-to-read conversion, independent verifier pass rate, input/output tokens, elapsed model time, cost, tool calls, and project exploration. Learned-vs-placebo isolates relevant Memory content; learned-vs-Memory-off exposes total Memory-path overhead. The learning episode is retained as the initial acquisition baseline, but cross-task timing is never treated as a causal comparison without the matched placebo and disabled arms.

The runner persists a sanitized `progress-report.json` after every provider turn. Provider, authentication, network, timeout, and balance failures are classified as `inconclusive`, not task failures. The first provider-side prompt failure stops the remaining schedule after that run is recorded, because the registered paired matrix can no longer support a claim and further requests would only spend budget. A required seed that was not produced stops the attempt before exact or similar work, and the final capability report is written before threshold evaluation so a rejected claim remains auditable.

Validate the deterministic report contract without provider spend:

```bash
npm run evaluate:pi-xk-memory-transfer-fixture
```

Run the registered three-attempt real-provider matrix in an isolated output directory:

```bash
npm run smoke:pi-xk-memory-transfer -- --out /tmp/pi-xk-memory-transfer --attempts 3
```

A valid claim requires all registered attempts, verified seeds, complete D1/D2 observability, and every configured threshold. A partial diagnostic or provider-blocked run remains evidence about the harness only; it is not a Memory benefit result.

## Report Protocol

Run `npm run evaluate:pi-xk-capabilities` to validate the checked-in calibration. The evaluator rejects reports containing sensitive or trajectory-bearing fields, including API keys, prompts, message bodies, transcript data, credentials, or authorization values.

Use `scripts/summarize-pi-xk-harbor-report.mjs` to create a sanitized `public-evaluation` paired report from two Harbor trial directories. It retains only independent reward, aggregate usage, elapsed time, model/runtime controls, and task digest. Runtime identity is derived from the validated bundle source commit, a digest covering every bundle file, and the combined digest of the four Pi runtime archives; it is never supplied manually. The summarizer requires `--plan evaluation/capabilities/public-parity-plan.json` and the registered `--attempt`; it rejects a pair unless task identity, execution order, task digest, model, Pi version, thinking level, derived runtime identity, and budget match exactly. Never retry only one agent and use its later success as a parity result.

Workflow results remain a separate table. They can establish that Pi-XK works as specified, but only paired public verifier results can establish a task-outcome advantage over native Pi.

The evaluator reports coverage explicitly. A calibration report with only one Aider pair is useful evidence about that pair, but it is not a complete Pi-XK evaluation. Missing matrix rows remain visible rather than becoming implied passes.
