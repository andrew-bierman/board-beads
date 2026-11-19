<div align="center">

# board-beads

**Run [Vercel Board](https://github.com/vercel/board) on [beads](https://github.com/gastownhall/beads) — a Board Backend backed by your beads tracker**

[![CI](https://github.com/andrew-bierman/board-beads/actions/workflows/ci.yml/badge.svg)](https://github.com/andrew-bierman/board-beads/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org)

</div>

board-beads is an npm package exporting `beads()` — a [Board](https://github.com/vercel/board) `Backend` whose storage is a beads tracker (`bd` CLI, Dolt-backed).

## Why

Teams running agent fleets already run beads. Tasks, claims, reply chains, and history live in the tracker, and agents talk to it through `bd` every day.

Board needs a Backend — somewhere to put messages, tasks, and events. The built-in options are a hosted API or a single-process SQLite file; neither is your tracker. board-beads implements Board's Backend contract on top of beads, so mounting a board doesn't fork your state:

- **Your tasks, claims, and threads stay in the tracker your agents already use.** No parallel database, no export step, no second source of truth.
- **Board is the protocol skin; beads is the source of truth.** The `vb` CLI, tasks with leases, threads, event fan-out, watchers — all of it reads and writes ordinary beads issues.
- **Humans keep their tracker, agents keep their board.** Same bytes, one place.

## Status

> **Under active construction (0.x).** The backend is being implemented against [Board's conformance suite](https://github.com/vercel/board) right now — current builds are a scaffold and a partial backend, not a finished adapter. APIs may change until further notice: we ship small patch/minor bumps and hold the 1.0 line until the surface is proven conformance-green. The construction plan lives under [`docs/plans/`](docs/plans/).

Nothing on this page describes a stable API yet — pin exact versions if you build on it.

## Quickstart

### 1. Install bd and create a tracker

beads ships as the [`bd` CLI](https://github.com/gastownhall/beads) with Dolt embedded — no separate database server to run. Install it, then initialize a tracker:

```bash
bd init ~/trackers/my-team
```

Board's event feed reads bd's events journal. If your tracker has none, board-beads warns at bind time; setting `BD_EVENTS_JOURNAL=1` enables one.

### 2. Install the packages

```bash
bun add board-beads @vercel/board
```

### 3. Mount the backend

```ts
import { board } from "@vercel/board";
import { beads } from "board-beads";

export const team = board({ backend: beads({ dir: "~/trackers/my-team" }) });
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

| Board      | beads                                               |
| ---------- | --------------------------------------------------- |
| message    | one issue (threaded with native `replies-to` links) |
| thread     | issue + reply chain                                 |
| task       | issue with claim/lease via `bd` claims              |
| task lease | bd claim + heartbeat (`{epoch, token}` fencing on top) |
| event feed | bd events journal                                   |
| watcher    | journal tail matcher with leased deliveries         |

## The single-writer contract

While a board runs, all mutations to the tracker must flow through board-beads. Direct `bd` writes, `coord`/`beadle` activity, and git-pull'd changes are **out of band**: invisible to the event feed, and unsupported for fencing — the backend can't detect or arbitrate races it didn't broker. Read-only `bd` use (queries, dashboards) is unaffected.

**One-line fix for same-machine tools:** export `BD_EVENTS_JOURNAL=1` in the environment before starting the board — then `coord`, `beadle`, and direct `bd` calls journal their writes too, and the event feed sees them. Git-pull'd changes remain out of band.

Write handling is **config-driven**: `writers: "single"` is the default today — reconciliation and server-authority modes are on the roadmap below.

## Requirements

- Node ≥ 22.18 (Bun for dev/test)
- `bd` ≥ 1.3.4, < 2 — the version range is checked when the backend binds

## Roadmap

No dates, no promises beyond "0.x". Config keys are additive forever — a knob ships in a minor, defaults never change behavior, so you take the pieces you want and skip the rest.

- [ ] Conformance-green core — discovery, messages, threads, event feed, watchers, sync records
- [ ] Tasks — claims, leases, heartbeats, expiry via `bd`
- [ ] Schedules, grants, schemas, attachments
- [ ] Search
- [ ] Writer modes — journal-aware reconciliation for out-of-band writers
- [ ] Server-authority mode — `bd serve` / proxied-server for multi-machine fleets

## Development

```bash
bun install
bun run fmt             # format
bun run check           # typecheck
bun test                # integration tests against real bd
bun run verify:platform # platform export-condition check
bun run conformance
```

Tests run against real disposable beads trackers — `bd init` in a temp dir with an isolated `HOME` — never against an operator's tracker, and never against mocks.

## Contributing

Bugs and features welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, quality gates, and the commit convention.

## License

[MPL-2.0](LICENSE) — file-level copyleft: use it anywhere, commercially included; changes to this project's own files stay open source.
