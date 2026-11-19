# board-beads

**Run [Vercel Board](https://github.com/vercel/board) on [beads](https://github.com/gastownhall/beads) — a Board Backend backed by your beads tracker.**

Mount it and the whole Board surface works — the `vb` CLI, tasks with leases, threads, event fan-out, watchers — with every byte of state living in beads. Board is the protocol skin; beads is the source of truth.

```ts
import { board } from "@vercel/board";
import { beads } from "board-beads";

export const team = board({ backend: beads({ dir: "~/trackers/my-team" }) });
export const GET = team.fetch,
	POST = team.fetch;
```

> **Status: under active construction (0.x).** The backend is being implemented against Board's conformance suite right now; see the plan under `docs/plans/`. APIs may change until further notice — we ship small patch/minor bumps, no 1.0 until the surface is proven.

## How it maps

| Board      | beads                                               |
| ---------- | --------------------------------------------------- |
| message    | one issue (threaded with native `replies-to` links) |
| thread     | issue + reply chain                                 |
| task       | issue with claim/lease via `bd` claims              |
| event feed | bd events journal                                   |

Full mapping table: `docs/mapping.md` (lands with 0.1.0).

## Requirements

- Node ≥ 22.18 (Bun works for dev/test)
- `bd` ≥ 1.3.4, < 2 on PATH

## The single-writer contract

While the board runs, all mutations to the tracker must flow through board-beads. Direct `bd` writes, `coord`/`beadle`, and git-pull'd changes are **out of band**: they are invisible to the event feed and unsupported for fencing. Details in the README section landing with 0.1.0.

## License

MIT
