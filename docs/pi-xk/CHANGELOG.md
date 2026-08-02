# Pi-XK Changelog

## [Unreleased]

### Added

- Goal V3 contracts with a stable Intent Anchor, revisioned Current Objective, controlled objective-only refinement, protected-field confirmation, and separate Objective/State projections.
- L1 Segment Summary V2 titles exposed through verified Session Chain list/read flows while preserving L1 V1 compatibility.
- Project-scoped Memory v1 with typed evidence graph revisions, three-dimensional trust/freshness/lifecycle state, stable Goal/L2 capture, explicit verified remember, D0–D3 model retrieval, SQLite FTS5/graph projections, controlled proposals, timeline/doctor commands, and model-requested compaction gates.

### Changed

- Native compaction now records a safe historical title and adds one-time recovery guidance to the next actual Agent run instead of resending the last user request or creating a second Goal kickoff.
- Goal runtime guidance now provides Objective/State paths and contract revision diagnostics instead of repeating the original request or complete contract.
- Goal Draft generation now keeps fixed drafting rules in system context, carries requested/revision data in an untrusted structured input, fails closed outside its sole submission tool, and enforces a closed Intent Anchor, Current Objective, required acceptance, verification evidence, Done Condition, and Final Report traceability chain; automatic Objective refinements must preserve every existing outcome dimension and acceptance coverage.
- Goal kickoff transcript entries now carry only a fixed continuation signal; complete Goal rules are injected once through the system prompt.
- Session Chain L1 and L2 generation now replace the generic summary contract with their strict `pi.summary-evidence.v1` JSON contracts, and model-facing `summary-in` content is explicitly historical evidence rather than instructions.
- Goal revision feedback is explicitly user-role candidate data rather than contract authority, Task success requires concrete evidence, and compaction recovery follows the current logical trigger without inventing a user request from a Goal kickoff.
- Session Chain append now uses a revisioned read-model checkpoint with an exact idempotency-key index, avoiding full event-log replay for ordinary head-matched writes while retaining full replay for retries, conflicts, recovery, and old checkpoints.
- Memory capture now treats Artifact Store objects and the hash-chained Memory event log as facts while keeping read model, SQLite, History Cue, source cursors, heat, and Markdown as rebuildable projections; existing history is never automatically backfilled.

### Fixed

- Goal revision state is scoped to the current binding's Goal ID and generation, and automatic objective refinement terminates superseded feedback so stale entries cannot block or leak into later Goal runs.
- Superseded Goal revision feedback is consumed after one successful retry run while remaining available across provider error/abort recovery, and revision conflicts restart Goal preflight instead of continuing under stale contract guidance.
- Goal revision review content remains visible to the user but is excluded from subsequent model context.
- Active Goal guidance now requires material progress and acceptance evidence to be returned to `goal-state.md` before each run ends, and summary-list prompt metadata no longer describes unchecked L1 titles as trusted.
- V3 Goals can no longer start at a later revision or be downgraded through the legacy V2 update/event path.
- Compaction and L1 title validation now accepts technical noun phrases and pure envelope whitespace without accepting extra response text.
- Host summarization now keeps ordinary focus inside untrusted input, honors only non-blank explicit replacement contracts, falls back safely for blank replacements, and preserves provider cancellation semantics.
- Custom Pi system prompts retain the active tool inventory and tool-specific guidance while continuing to replace the default identity and Pi documentation text.
- Goal/Session Chain prompt-integrity failures now stop before provider execution, Goal Draft tool visibility is scoped to its single submission tool for the full logical run, and file-dependent Goal runs verify declared read/write capabilities.
- Rollup manifest, `/chain rollups`, `/chain status`, `/xk status`, and doctor now report one latest publication state per unresolved window; only invalid L2 output exhausts automatic retries after three attempts, while transient provider and publication failures remain retryable.
- Goal Draft and Task terminal prompts now distinguish rejected tool attempts from the single recorded result; Goal State guidance matches the enforced evidence/reconsideration grammar and accepts contract-defined acceptance IDs.
- Critical extension handlers remain scoped to their registered event, per-run tool projections cannot re-enable inactive tools, and recovered Rollup publication queues no longer retain stale in-memory errors or hide diagnostics from another window.
- Session Chain manifests no longer repeat summary-tool workflow and trust rules already supplied by active tool metadata, and the L2 Rollup prompt now describes its serialized `[User]: {source JSON}` input exactly.
- Pi session rewrites now publish durable temporary files atomically and keep trailing partial JSONL records from merging with later entries.
- Goal runs now persist `goal_run_started` before provider execution, and Task terminal events reject missing or corrupt referenced artifacts before publication.
- Rollup recovery now deduplicates branch queues, rechecks terminal publication under its generation lock, persists artifact ownership before publication, and retains failure events through bounded CAS recovery.
- Session Chain write locks no longer expose an empty-file creation window, fast catalogs self-repair stale entries, and L2 reads reject mismatched artifact producers.
- Pi-XK GitHub release builds now require the checkout commit to equal the release tag commit, and binary entrypoints reject incomplete, inconsistent, or extended provenance manifests.
- Windows and macOS Pi-XK CI smoke now materializes the ignored provider catalog with the strict `pi-ai` build on fresh checkouts, reuses a complete local catalog without a refresh, validates catalog publication with fixture data, launches `npm.cmd` through the Windows command shell, and skips only the 512 MiB session-file stress case that remains covered by the full suite.
- Native Windows Pi-XK release packaging now invokes the bundled PowerShell zip helper directly, while WSL retains its shell-based fallback.
- Memory retrieval now caps the combined FTS/graph candidate pool at 200 before pagination, and capture recovery applies an already-recorded low-risk proposal without repeating the provider call or losing an advanced source cursor.
- Memory SQLite rebuilds now stream bounded artifact/reference batches through one Worker transaction, cache insert statements, publish head/count metadata only at commit, roll back failed chunks, and remove failed temporary databases instead of cloning a complete index snapshot.
- Memory evidence reads now validate complete Goal, Task, Chain, compaction, Git, and explicit-source ownership; Goal checkpoints capture event-time State artifacts, and sources with no durable knowledge finish as `capture_skipped` instead of false failures.
- Memory D1 now unifies Memory/History Cue pagination, supports historical revisions, short CJK literal fallback, temporal recall, and effective-time graph edges without weakening trust, lifecycle, or evidence checks.
- Memory projection mutations now use cross-process locks and event-head CAS deltas; History Cue discovery persists a sealed-Segment cursor, stable refreshes avoid reopening old sessions, and repair publishes SQLite/Markdown/manifest from one rechecked read-model snapshot.
- Contended file locks now avoid repeated temporary-file fsync/link cycles while the owner lock exists, preventing DrvFS contention from amplifying bounded retries.
- Goal completion Memory now binds to the final event-time checkpoint State; retryable failed captures remain discoverable after cursor advancement, purge removes only exclusively owned proposal/result content, and doctor validates versioned source/History Cue cursors without guessing fact baselines.

## [0.1.1]

### Changed

- Empty persistent Pi sessions now enter a managed Session Chain only when the first ordinary request arrives; stateful existing transcripts are adopted in place, while `--no-session` runs remain ephemeral.
- Split the Pi-XK checkpoint, Goal, and Session Chain Rollup implementations into focused modules while preserving the package facade and runtime protocols.

### Fixed

- Session idle waits now include awaited `agent_settled` handlers, so mutable Chain commands cannot snapshot a Segment before post-run persistence finishes.
- Mutable `/chain` commands recheck the Task gate after settlement before changing Chain state.
- Rollover and successor-branch commits no longer conflict when an independently generated Rollup publication or diagnostic event lands after their expected topology head.
- Rollup publication state rejects path-unsafe Chain, branch, and Segment identifiers after the controller split.

## [0.1.0]

### Added

- Durable Goal V2 contracts, lifecycle recovery, evidence-gated completion, status views, and explicit abandoned-lock repair.
- Single-child Task V2 execution with native follow-up queuing, child Session Chains, terminal result delivery, and recovery diagnostics.
- Session Chain v1.1 with native Pi JSONL Segments, L1 summaries, background L2 Rollups, model manifest discovery, verified summary tools, branch continuation, archive/rename controls, and tiered doctor commands.
- Project-scoped immutable Artifact Store and rebuildable Goal, Task, and Chain read models.
- `/xk status` and supported local install, upgrade, uninstall, and runtime preflight commands.
- Independent GitHub-only Pi-XK binary releases with bundled private extension/Core payloads, provenance manifest, six platform archives, and SHA-256 checksums.

### Changed

- L2 Rollup publication no longer blocks successful rollover into the successor Segment.
- Chain manifest, status, picker, and summary pagination use incremental read-model paths instead of routine full replay or Artifact Store scans.

### Fixed

- L1 carry-forward now uses canonical Artifact Store read-back content and rejects provenance or redaction corruption before changing the branch head.
- Goal, Task, and Chain stores share nonce-bound abandoned-lock inspection and explicit repair semantics.
- Rollup failures retain actionable stage, error code, and retryability classification without persisting provider response bodies.
