# Pi-XK Goal And Task Extension

Pi-XK adds durable Goal and single-child Task workflows to Pi without modifying Pi core. Pi keeps the parent conversation and tool transcript; Pi-XK keeps Goal/Task events, checkpoint evidence, artifacts, derived read models, and each child transcript under the project `.pi-xk` directory.

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

The captured objective is sent only to a hidden draft kickoff, not as a normal chat message. The draft model must submit one structured contract and cannot perform Goal work or call lifecycle tools. In TUI mode, Pi-XK displays the normalized Markdown in a native full-width `ctx.ui.custom` dialog. Page Up and Page Down scroll the contract, the two actions confirm or revise it, Escape closes the dialog without changing the draft, and revision opens an empty native multi-line editor before repeating the draft loop. In print, RPC, or other no-TUI modes, use the review, confirm, revise, and cancel commands above.

Confirmation is the first operation that creates `.pi-xk/goals/<goalId>`, its event log, `goal-objective.md`, and mutable `goal-state.md`. At the start of every active run, Pi-XK tells the model to read both files and audit required acceptance evidence.

Each session branch has one current Goal. A new draft is rejected while that Goal is active or paused; end the current Goal before creating another one. This prevents an old Goal from remaining active after its branch binding is replaced.

`pi_xk_start_goal`, `pi_xk_pause_goal`, and `pi_xk_end_goal` are model tools. Start requires a paused Goal plus new recovery evidence. Pause requires an audit of unmet required acceptance IDs, current evidence, the incomplete conclusion, any user request, and the next best action. End requires verification evidence for every required acceptance. Model pause and end requests are committed only after the final observable checkpoint is durable. A failed checkpoint leaves the lifecycle intent pending for a later safe-boundary retry; user `/goal end` remains an immediate terminal override.

While a Goal is active, Pi-XK starts another run after a settled run. A normal assistant response, plan, or partial result does not end the Goal. The model must call `pi_xk_end_goal` only after it has updated `goal-state.md` and verified the objective and declared acceptance evidence. If it needs user input or an external change, it must update state and call `pi_xk_pause_goal`. There is no run-count completion limit. Provider failures leave the Goal active and retry with exponential backoff rather than fabricating an ended state.

In TUI mode, Pi-XK adds a composable native footer status such as `Goal active · 12m 34s`. The timer displays lifecycle `activeElapsed`, updates once per second only while the Goal is active, and freezes while paused or after the Goal ends. It uses `ctx.ui.setStatus`; it does not replace Pi's footer or persist per-second events. `/goal status` reports `wall` time including pauses, `active` time excluding pauses, and closed-run `busy` time.

## Task Commands And Model Tools

```text
/task start <prompt>              Start one user-controlled implementation Task.
/task status [taskId]             Show status, elapsed time, role, child session, summary, and artifacts.
/task cancel [reason]             Cancel the current running Task.
/task cancel <taskId> [reason]    Cancel a linked running Task by ID.
```

The parent model can call `pi_xk_start_task(role, prompt, expectedResult)` for one bounded research, implementation, verification, or review child. That tool terminates the current parent run. The child runs in an independent Pi `AgentSession` and must call its child-only `pi_xk_finish_task` tool exactly once; a normal text reply is treated as a failed result. The parent never sees `pi_xk_finish_task`, and the child loads with `noExtensions: true`, so it cannot call Goal tools or create a nested Task.

Only one Task can run at a time. While it is running, ordinary user input is rejected and the parent Goal cannot auto-continue. A model-started Task delivers a structured result and resumes the settled parent exactly once. A user-started Task only notifies the user. Cancelling a Task bound to an active Goal also pauses that Goal; resume it explicitly with `/goal start`.

Task states are `pending -> running -> succeeded|failed|cancelled|orphaned`. Graceful shutdown, extension reload, and tree navigation request child cancellation; confirmed cancellation records `cancelled`, while a child that does not settle within the five-second shutdown window records `orphaned` and is detached. A failed tree-navigation cancellation rejects the navigation. Startup marks a leftover `pending` Task cancelled and a leftover `running` Task orphaned, then backfills a missing terminal result message without starting the parent model. Terminal Tasks never restart. Model switching and parent compaction do not change Task state; the child keeps its launch-time provider/model and thinking-level snapshot.

## Files And Recovery

Each confirmed Goal is stored below the current project root. Pi-XK does not create a project-local `.pi` directory:

```text
.pi-xk/goals/<goalId>/
  events.jsonl
  contract.json
  goal-objective.md
  goal-state.md
  goal-read-model.json

.pi-xk/tasks/<taskId>/
  events.jsonl
  task-read-model.json
  session/
    <child-session>.jsonl
```

Project-scoped checkpoint and Task result artifacts are stored under `.pi-xk/artifacts/`. Before Goal confirmation, a draft exists only as a Pi native session custom entry and creates nothing under the project `.pi-xk` directory.

`events.jsonl` is the Goal fact source. `contract.json`, `goal-objective.md`, and `goal-read-model.json` are rebuildable projections; `goal-state.md` is the mutable execution state. Pi-XK validates the complete objective projection against the current contract, not only its identity header. Pi session custom entries contain Goal bindings, pending drafts, lifecycle intents, and checkpoint references; drafts never become Goal events before confirmation. Do not edit Goal JSONL files by hand; use the SDK recovery APIs when a corruption diagnostic is reported.

For Tasks, `events.jsonl` is the fact source, `task-read-model.json` is rebuildable, and parent-session `task_link` entries store only event references. Complete result envelopes remain in the project artifact store and child messages remain in the child transcript.

## Security Boundary

The extension runs with the same permissions as Pi. It does not implement a sandbox or per-tool approval flow. Pi-XK checkpoint evidence stores runtime provenance and artifact references, not provider credentials, raw prompts, Goal state contents, or tool result bodies.
