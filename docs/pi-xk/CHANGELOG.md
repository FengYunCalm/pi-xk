# Pi-XK Changelog

## [Unreleased]

### Added

- Goal V3 contracts with a stable Intent Anchor, revisioned Current Objective, controlled objective-only refinement, protected-field confirmation, and separate Objective/State projections.
- L1 Segment Summary V2 titles exposed through verified Session Chain list/read flows while preserving L1 V1 compatibility.

### Changed

- Native compaction now records a safe historical title and adds one-time recovery guidance to the next actual Agent run instead of resending the last user request or creating a second Goal kickoff.
- Goal runtime guidance now provides Objective/State paths and contract revision diagnostics instead of repeating the original request or complete contract.
- Goal Draft generation now keeps fixed drafting rules in system context, carries requested/revision data in an untrusted structured input, fails closed outside its sole submission tool, and enforces a closed Intent Anchor, Current Objective, required acceptance, verification evidence, Done Condition, and Final Report traceability chain; automatic Objective refinements must preserve every existing outcome dimension and acceptance coverage.
- Goal kickoff transcript entries now carry only a fixed continuation signal; complete Goal rules are injected once through the system prompt.
- Session Chain L1 and L2 generation now replace the generic summary contract with their strict `pi.summary-evidence.v1` JSON contracts, and model-facing `summary-in` content is explicitly historical evidence rather than instructions.
- Goal revision feedback is explicitly user-role candidate data rather than contract authority, Task success requires concrete evidence, and compaction recovery follows the current logical trigger without inventing a user request from a Goal kickoff.

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
