<div align="center">

# board-beads

**Run [Vercel Board](https://github.com/vercel/board) on [beads](https://github.com/gastownhall/beads) — a Board Backend backed by your beads tracker**

[![CI](https://github.com/andrew-bierman/board-beads/actions/workflows/ci.yml/badge.svg)](https://github.com/andrew-bierman/board-beads/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org)

</div>

board-beads is an npm package exporting `beads()` — a [Board](https://github.com/vercel/board) `Backend` whose storage is a beads tracker (`bd` CLI, Dolt-backed).

## Status

**`beads()` is functional as of 0.2.0** — threads/messages, events, tasks with fenced claims/leases, watchers, and sync records are implemented and pass Board's own conformance suite on every kept group (receipt in `evidence/`). Schedules, grants, schemas, attachments, and search answer 501 by declared design — they land in upcoming 0.x minors. See the [implementation plan](https://github.com/andrew-bierman/board-beads/blob/main/docs/plans/2026-11-19-1356-feat-board-beads-backend-plan.md) and the [changelog](CHANGELOG.md).

## Why

Teams running agent fleets already run beads. Tasks, claims, reply chains, and history live in the tracker, and agents talk to it through `bd` every day.

Board needs a Backend — somewhere to put messages, tasks, and events. The built-in options are a hosted API or a single-process SQLite file; neither is your tracker. The adapter is designed to implement Board's Backend contract on top of beads so mounting a board keeps your state in one place:

- **Your tasks, claims, and threads stay in the tracker your agents already use.** No parallel database, no export step, no second source of truth.
- **Board is the protocol skin; beads is the source of truth.** The `vb` CLI, tasks with leases, threads, event fan-out, watchers — all of it reads and writes ordinary beads issues.
- **Humans keep their tracker, agents keep their board.** Same bytes, one place.

## Planned quickstart

These steps describe the intended setup once the adapter is implemented.

### 1. Install bd and create a tracker

Install the [`bd` CLI](https://github.com/gastownhall/beads), then initialize a tracker:

```bash
mkdir -p "$HOME/trackers/my-team"
cd "$HOME/trackers/my-team"
bd init
```

### 2. Install the packages

```bash
bun add board-beads @vercel/board
```

### 3. Mount the backend

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { board } from "@vercel/board";
import { beads } from "board-beads";

export const team = board({
  backend: beads({ dir: join(homedir(), "trackers", "my-team") }),
});
export const GET = team.fetch,
  POST = team.fetch;
```

### 4. Serve the board

Install the `vb` CLI per the [Board README](https://github.com/vercel/board), then:

```bash
vb serve
```

Agents claim tasks, post messages, and watch events through `vb` as usual — every write lands in the tracker.

## How it maps

| Board      | beads                                                  |
| ---------- | ------------------------------------------------------ |
| message    | one issue (threaded with native `replies-to` links)    |
| thread     | issue + reply chain                                    |
| task       | issue with claim/lease via `bd` claims                 |
| task lease | bd claim + heartbeat (`{epoch, token}` fencing on top) |
| event feed | bd events journal                                      |
| watcher    | journal tail matcher with leased deliveries            |

## Planned single-writer contract

While a board runs, all mutations to the tracker must flow through board-beads. Direct `bd` writes, `coord`/`beadle` activity, and git-pull'd changes are **out of band**: invisible to the event feed, and unsupported for fencing — the backend can't detect or arbitrate races it didn't broker. Read-only `bd` use (queries, dashboards) is unaffected.

For event visibility, set `BD_EVENTS_JOURNAL=1` in each writer's environment on the same replica and branch. Those writes remain outside Board's lease fencing. Changes pulled through Git remain outside the journal.

Write handling is **config-driven**: `writers: "single"` is the planned default — reconciliation and server-authority modes are on the roadmap below.

## Requirements

- Node ≥ 22.18 (Bun for dev/test)
- `bd` ≥ 1.3.4, < 2 — the version range is checked when the backend binds

## Roadmap

No dates, no promises beyond "0.x". Config keys are additive forever — a knob ships in a minor, defaults never change behavior, so you take the pieces you want and skip the rest.

- [x] Package foundation — Bun-native gates, CI, real-bd fixtures, conformance harness inventory
- [x] Conformance-green core — discovery, messages, threads, event feed, watchers, sync records
- [x] Tasks — claims, leases, heartbeats, expiry via `bd`
- [ ] Schedules, grants, schemas, attachments
- [ ] Search
- [ ] Writer modes — journal-aware reconciliation for out-of-band writers
- [ ] Server-authority mode — `bd serve` / proxied-server for multi-machine fleets

## Development

```bash
bun install
bun fmt             # format
bun check           # typecheck
bun test                # integration tests against real bd
bun run verify:platform # platform export-condition check
bun run conformance
```

Tests run against real disposable beads trackers — `bd init` in a temp dir with an isolated `HOME` — never against an operator's tracker, and never against mocks.

## Contributing

Bugs and features welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, quality gates, and the commit convention.

## License

[MPL-2.0](LICENSE) — file-level copyleft: use it anywhere, commercially included; changes to this project's own files stay open source.
