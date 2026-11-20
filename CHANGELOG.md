# Changelog

All notable changes to board-beads are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are 0.x
SemVer during early development.

License: MPL-2.0. Requires Node ≥ 22.18 and `bd` ≥ 1.3.4, < 2 (the `bd` range
is checked when the backend binds).

## 0.2.0 — 2026-11-20

The first backend release: `beads()` returns a working Board Backend backed by
a beads tracker, conformance-tested against Board's own conformance suite.
Schedules, grants, schemas, attachments, and search are declared 501
(`not_supported`) by design until their routes land.

### Added

- **Threads and messages** — Board messages become `bd` issues, threaded with
  native `replies-to` links.
- **Events** — long-poll event feed reading bd's events journal, with
  early-release waiters; journal truncation answers `invalid_cursor`.
- **Tasks** — claims and leases through `bd`, with `{epoch, token}` fencing on
  top and claim long-poll.
- **Watchers** — journal tail matchers with persisted match leases.
- **Sync** — sync/inbox record routes.
- **bd transport + domain model** — typed exit taxonomy, `bb.v:1` issue
  metadata, cursors, actors, and a single-writer write gate.
- **Conformance harness** — Board's conformance suite wired as
  `bun run conformance`, with a 91-check stub inventory as the contract
  baseline for routes not yet landed.
- **Hardening** — typed failures on every route (typed 4xx/501, never a bare
  500), corrupt-state tolerance, and a hostile-input sweep.
- **Tests** — real `bd` against disposable trackers (temp `bd init` with an
  isolated `HOME`); no mocks.

## 0.1.2 — 2026-11-19

Release-pipeline validation. No runtime code changes.

- npm releases gated on conformance; CI unblocked.
- Release version-gate job and concurrency guard.
- Shared agent instructions (AGENTS.md).

## 0.1.1 — 2026-11-19

Release-pipeline validation. Docs and version bump only.

- Hardening-sweep plan docs (unit and verification gates).

## 0.1.0 — 2026-11-19

npm scaffold and name reservation. Exports `beads()`, which throws when
called — no backend yet.

- Package scaffold: Bun toolchain, CI, real-bd test fixtures, platform
  export-condition check.
- Tag-triggered npm publish with provenance and a sub-v1 guard.
- Relicensed MIT → MPL-2.0 before first publish.
- Storefront README, contributing guide, issue/PR templates, implementation
  plan, config-driven design docs.
- Release fixes: official `bd` binary in CI, isolated declarations via Oxc,
  Node 24 / npm 11.x for trusted publishing.

[unreleased]: https://github.com/andrew-bierman/board-beads/compare/v0.1.2...HEAD
