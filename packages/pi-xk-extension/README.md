# Pi-XK Goal, Task, And Session Chain Extension

Pi-XK adds durable Goal, single-child Task, and Session Chain workflows to Pi without changing Pi's agent loop, provider, or native message format. Pi keeps each physical JSONL transcript; Pi-XK keeps Goal/Task/chain events, checkpoint evidence, artifacts, derived read models, and child transcripts under the project `.pi-xk` directory.

This package README is the command and installation reference. Start with the repository documentation for the complete behavior and risk model:

- [Pi-XK overview](../../docs/pi-xk/README.md)
- [Getting started](../../docs/pi-xk/getting-started.md)
- [Design and boundaries](../../docs/pi-xk/design-and-boundaries.md)
- [Operations and recovery](../../docs/pi-xk/operations-and-recovery.md)
- [Compatibility and user impact](../../docs/pi-xk/compatibility-and-impact.md)
- [Session Chain Rollups and model retrieval](../../docs/pi-xk/session-chain-rollups-and-model-retrieval.md)
- [Host patch boundary](../../docs/pi-xk/host-patch-boundary.md)

The package is currently private and installed from a built local checkout. Its supported baseline is a trusted, personal, interactive full-access profile. It does not provide a sandbox, per-tool permission policy, concurrent Tasks, worktree isolation, general long-term memory, or an unattended execution guarantee.

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
/goal end [reason]         Immediately end the active or paused Goal by explicit user request.
/goal -- <objective>       Draft an objective beginning with a reserved subcommand.
```

The captured objective is sent only to a hidden draft kickoff, not as a normal chat message. The draft model must submit one structured contract and cannot perform Goal work or call lifecycle tools. In TUI mode, Pi-XK displays the normalized Markdown in a native full-width `ctx.ui.custom` dialog. Page Up and Page Down scroll the contract, the two actions confirm or revise it, Escape closes the dialog without changing the draft, and revision opens an empty native multi-line editor before repeating the draft loop. In print, RPC, or other no-TUI modes, use the review, confirm, revise, and cancel commands above.

Confirmation is the first operation that creates `.pi-xk/goals/<goalId>`, its event log, `goal-objective.md`, and mutable `goal-state.md`. At the start of every active run, Pi-XK tells the model to read both files and audit required acceptance evidence.

Each session branch has one current Goal. A new draft is rejected while that Goal is active or paused; end the current Goal before creating another one. This prevents an old Goal from remaining active after its branch binding is replaced.

`pi_xk_start_goal`, `pi_xk_pause_goal`, and `pi_xk_end_goal` are model tools. Start requires a paused Goal plus new recovery evidence. Pause requires an audit of unmet required acceptance IDs, current evidence, the incomplete conclusion, any user request, and the next best action. End requires verification evidence for every required acceptance. Model pause and end requests are committed only after the final observable checkpoint is durable. A failed checkpoint leaves the lifecycle intent pending at later safe boundaries in the same live runtime; shutdown, startup, or tree navigation commits it only if the checkpoint is already durable, otherwise rejects it before the conservative pause. User `/goal end` remains an immediate terminal override.

While a Goal is active in the current live session, Pi-XK starts another run after a settled run. A normal assistant response, plan, or partial result does not end the Goal. The model must call `pi_xk_end_goal` only after it has updated `goal-state.md` and verified the objective and declared acceptance evidence. If it needs user input or an external change, it must update state and call `pi_xk_pause_goal`. There is no run-count completion limit. Provider failures leave the Goal active and retry with exponential backoff while that session remains live rather than fabricating an ended state.

An active Goal is conservatively paused when Pi gracefully quits, reloads extensions, switches to another/new/forked session, aborts the agent run, or navigates the session tree. A later startup also detects an active Goal left by an unclean process exit, interrupts any open run, and pauses it without contacting the provider. Reopening never auto-resumes the Goal: inspect `/goal status`, then run `/goal start` manually. A stale uncommitted start intent is rejected during recovery instead of being replayed.

| Pi action | Goal effect |
| --- | --- |
| Quit, signal shutdown, reload, new session, resume another session, fork/clone | The old session pauses its active Goal; the reopened session remains paused. |
| Unclean crash or forced kill | The next startup recovers any open run and pauses the still-active Goal. |
| Agent abort | The open run becomes interrupted and the Goal pauses. |
| Session tree undo/navigation | Navigation first pauses the active Goal; failure cancels navigation. The same Goal binding is reattached after navigation because the Goal event log is not rewound with the Pi branch. |
| Model switch | No lifecycle event, generation change, or binding change. The next run uses the newly selected model. |
| Compaction | Checkpoint evidence is written, but the Goal is not paused and Pi's native summary/tree semantics remain unchanged. |

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

## Session Chain Commands

```text
/chain                              Select a logical Session Chain head.
/chain status                       Show the current chain, branch, Segment, size, summary, and rollover gates.
/chain history                      Show the Segment and branch topology.
/chain summary [segmentId]          Show the Segment's summary-in, delta, and carry-forward summary.
/chain rollups                      List published and failed L2 windows for the current branch.
/chain rollup <window>              Show one L2 Rollup Markdown projection.
/chain rollup backfill [limit]      Explicitly generate missing complete windows; default limit is one.
/chain rollup config                Show the effective automatic Rollup configuration.
/chain rollup config off            Stop future automatic L2 generation without deleting summaries.
/chain rollup config <N>            Enable automatic L2 generation every N sealed Segments.
/chain rollover [reason]            Request a safe manual physical rollover.
/chain resume <chainId|prefix>      Switch to a logical chain head.
/chain continue <segmentId> [entryId]  Create a successor branch from historical work.
/chain doctor                       Replay the chain, recover a prepared rollover, and report diagnostics.
```

A long logical conversation is a `SessionChain` composed of complete native Pi JSONL Segments. New empty sessions are placed in a project-local managed Segment; an existing Pi transcript is adopted once as an external root without copying it. At a settled boundary, Pi-XK automatically rolls over after 16 MiB or 4,000 entries; at 64 MiB or 16,000 entries it must roll over before the next provider turn. It never rolls over while a Task is running or awaiting delivery, a Goal draft is open, or a Goal lifecycle intent is unsettled.

Rollover writes a provenance-bearing L1 Segment summary, seals the previous Segment, and replaces only the runtime's physical session. By default, every five sealed Segments on each branch produce one L2 Rollup from validated L1 artifacts only. A metadata-only manifest exposes available ranges to the model; `pi_xk_list_chain_summaries` and `pi_xk_read_chain_summary` let it read relevant L1/L2 evidence on demand. Summary bodies are never automatically injected into every request.

Active Goals continue through physical replacement without a pause, while normal quit/reload/new/resume/fork still preserve their conservative Goal-pause behavior. Compaction remains Pi-native and independent. Continuing after a historical Segment or tree position always creates a successor branch; sealed Segments are never rewritten. Pi-XK adds a compact `Chain <id> · S<n> · <size>` footer status alongside Pi's native footer.

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
  session/                      # TaskSpec V1 compatibility only
    <child-session>.jsonl

.pi-xk/sessions/
  catalog.json
  chains/<chainId>/
    events.jsonl
    chain-read-model.json
    locks/
    branches/<branchId>/
      segments/<ordinal>_<session-id>.jsonl
      rollups/<window>.md
      rollups/<window>.pending.json
      rollups/state.json

.pi-xk/session-chain.json          # Rollup enabled/interval configuration
```

Project-scoped checkpoint and Task result artifacts are stored under `.pi-xk/artifacts/`. Before Goal confirmation, a draft exists only as a Pi native session custom entry and creates nothing under the project `.pi-xk` directory.

Each domain's `events.jsonl` is its fact source. Goal contract/read-model files and Task read models are rebuildable projections; `goal-state.md` is the mutable execution state. Pi-XK validates the complete objective projection against the current contract, not only its identity header. An idempotent create retry repairs missing derived projections without duplicating the initial event. Pi session custom entries contain Goal bindings, pending drafts, lifecycle intents, checkpoint references, and small `task_link` references; they never contain the child transcript or complete Task read model. A draft without a bound Goal remains recoverable from the Pi session, while an impossible stale outstanding draft beside an active or paused bound Goal is retired during recovery. Do not edit Goal or Task JSONL files by hand; use the SDK recovery APIs when a corruption diagnostic is reported.

For Tasks, `events.jsonl` is the fact source, `task-read-model.json` is rebuildable, and parent-session `task_link` entries store only event references. Complete result envelopes remain in the project artifact store and child messages remain in the child transcript. A V2 Task started from a Session Chain records the parent `chainId/branchId/segmentId/entryId`; its `childChainId` points into `.pi-xk/sessions/chains/`. The `.pi-xk/tasks/<taskId>/session/` path is retained only for V1 Task facts, which remain readable without rewriting historical events or hashes.

For Session Chains, `events.jsonl`, native Segment JSONL, L1 artifacts, and L2 artifacts are facts. `chain-read-model.json`, `catalog.json`, Rollup Markdown, pending publication records, and runtime migration state are derived/recovery data. A sealed Segment records its final file hash, leaf, and L1 artifact. `/chain doctor` reports changed facts instead of rewriting them, recovers prepared rollover, and can rebuild missing or stale Rollup Markdown.

## Security Boundary

The extension runs with the same permissions as Pi. It does not implement a sandbox or per-tool approval flow. Pi-XK checkpoint evidence stores runtime provenance and artifact references, not provider credentials, raw prompts, Goal state contents, or tool result bodies.
