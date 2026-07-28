# Pi-XK Changelog

## [Unreleased]

### Added

- Goal V3 contracts with a stable Intent Anchor, revisioned Current Objective, controlled objective-only refinement, protected-field confirmation, and separate Objective/State projections.
- L1 Segment Summary V2 titles exposed through verified Session Chain list/read flows while preserving L1 V1 compatibility.

### Changed

- Native compaction now records a safe historical title and adds one-time recovery guidance to the next actual Agent run instead of resending the last user request or creating a second Goal kickoff.
- Goal runtime guidance now provides Objective/State paths and contract revision diagnostics instead of repeating the original request or complete contract.

### Fixed

- Goal revision state is scoped to the current binding's Goal ID and generation, and automatic objective refinement terminates superseded feedback so stale entries cannot block or leak into later Goal runs.
- Goal revision review content remains visible to the user but is excluded from subsequent model context.
- V3 Goals can no longer start at a later revision or be downgraded through the legacy V2 update/event path.
- Compaction and L1 title validation now accepts technical noun phrases and pure envelope whitespace without accepting extra response text.

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
