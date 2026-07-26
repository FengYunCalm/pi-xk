# Pi-XK Changelog

## [Unreleased]

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
