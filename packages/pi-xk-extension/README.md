# Pi-XK Goal Extension

Pi-XK adds a durable Goal workflow to Pi without modifying Pi core. Pi keeps the conversation and tool transcript; Pi-XK keeps Goal events, checkpoint evidence, artifacts, and the derived Goal read model under the project `.pi-xk` directory.

## Local Installation

From a built Pi-XK checkout, install the package into the current user's Pi settings:

```bash
npm --workspace pi-xk-core run build
npm --workspace pi-xk-extension run build
npm run check:pi-xk-runtime
pi install /absolute/path/to/pi-xk/packages/pi-xk-extension
pi list
```

`pi install` stores a reference to the local package. It does not copy the package, so rebuild the checkout and restart Pi after changing Pi-XK source. Remove the local package with:

```bash
pi remove /absolute/path/to/pi-xk/packages/pi-xk-extension
```

For an isolated test profile, set `PI_CODING_AGENT_DIR` before both commands. This keeps package settings, Pi-managed binaries, and sessions out of the normal user profile.

## Runtime Prerequisite

Pi's native `find` tool needs `fd`. On Ubuntu or Debian, install `fd-find`; Pi recognizes its `fdfind` binary. `npm run check:pi-xk-runtime` checks the Pi-managed binary directory first, then `fd` and `fdfind` on `PATH`. It never downloads a binary or contacts a provider.

## Goal Commands

```text
/goal <objective>          Ask the model to draft a Goal contract for user review.
/goal                      Start or cancel multi-line objective capture.
/goal review               Display the current proposed draft.
/goal confirm              Confirm the proposed draft, create the Goal, and start it.
/goal revise <feedback>    Ask the model to revise the proposed draft.
/goal cancel               Cancel the pending draft without creating Goal files.
/goal pause [reason]       Pause the active Goal and interrupt a busy run.
/goal start                Resume a paused Goal; active and ended Goals are rejected.
/goal status               Show Goal state, diagnostics, and timing.
/goal end [reason]         End the active Goal after its final checkpoint.
/goal -- <objective>       Draft an objective beginning with a reserved subcommand.
```

The captured objective is sent only to a hidden draft kickoff, not as a normal chat message. The draft model must submit one structured contract and cannot perform Goal work or call lifecycle tools. In interactive mode, Pi-XK displays the normalized Markdown through native `ctx.ui.select`; choosing revision opens an empty native `ctx.ui.input` and repeats the draft loop. In print or other no-UI modes, use the review, confirm, revise, and cancel commands above.

Confirmation is the first operation that creates `.pi-xk/goals/<goalId>`, its event log, `goal-objective.md`, and mutable `goal-state.md`. At the start of every active run, Pi-XK tells the model to read both files and audit required acceptance evidence.

`pi_xk_start_goal`, `pi_xk_pause_goal`, and `pi_xk_end_goal` are model tools. Start requires a paused Goal plus new recovery evidence. Pause requires an audit of unmet required acceptance IDs, current evidence, the incomplete conclusion, any user request, and the next best action. End requires verification evidence for every required acceptance. Model pause and end requests are committed only after the final observable checkpoint; user `/goal end` remains an immediate terminal override.

While a Goal is active, Pi-XK starts another run after a settled run. A normal assistant response, plan, or partial result does not end the Goal. The model must call `pi_xk_end_goal` only after it has updated `goal-state.md` and verified the objective and declared acceptance evidence. If it needs user input or an external change, it must update state and call `pi_xk_pause_goal`. There is no run-count completion limit. Provider failures leave the Goal active and retry with exponential backoff rather than fabricating an ended state.

## Files And Recovery

Each Goal is stored below:

```text
.pi-xk/goals/<goalId>/
  events.jsonl
  contract.json
  goal-objective.md
  goal-state.md
  goal-read-model.json
```

`events.jsonl` is the Goal fact source. `contract.json` and `goal-read-model.json` are rebuildable projections. Pi session custom entries contain Goal bindings, pending drafts, lifecycle intents, and checkpoint references; drafts never become Goal events before confirmation. Do not edit Goal JSONL files by hand; use the SDK recovery APIs when a corruption diagnostic is reported.

## Security Boundary

The extension runs with the same permissions as Pi. It does not implement a sandbox or per-tool approval flow. Pi-XK checkpoint evidence stores runtime provenance and artifact references, not provider credentials, raw prompts, Goal state contents, or tool result bodies.
