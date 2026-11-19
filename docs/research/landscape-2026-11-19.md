# Adapter landscape: beads ↔ Vercel Board — scan of 2026-11-19

## Purpose

This document is the durable record of the public-evidence scan run on 2026-11-19 — the day after Vercel Board launched (2026-11-18) — which established that no beads ↔ Board adapter existed in public view and is the reason board-beads was built first. It is a dated snapshot, not a standing guarantee: every query below is re-runnable, and [Re-running the scan](#re-running-the-scan) lists exactly what to check before claiming the field is still clear.

## The claim

No shipped, in-progress, or discussed beads ↔ Vercel Board adapter was findable in public search as of 2026-11-19.

## Search log

All searches run 2026-11-19. "FP" = false positive.

| Query                              | Platform                                                                                                      | Results                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo:vercel/board beads`          | [GitHub issues+PRs search](https://github.com/vercel/board/issues?q=beads) (via api.github.com/search/issues) | **0**                                                                                                                                                                                                                                                                                                                                                                |
| `vercel board beads`               | [GitHub repo search](https://github.com/search?q=vercel+board+beads&type=repositories)                        | **0**                                                                                                                                                                                                                                                                                                                                                                |
| `beads "vercel board"`             | [GitHub global issues search](https://github.com/search?q=beads+%22vercel+board%22&type=issues)               | 6, all FPs — "beads" decorative in unrelated PRs (PopBoard, bulletin-board, dot-matrix, yuetranslation, orbit-with-ben, history-of-science)                                                                                                                                                                                                                          |
| `beads board`                      | [GitHub repo search](https://github.com/search?q=beads+board&type=repositories)                               | 68; every top hit is a beads UI — perles (194★), bead-me-up-scotty (176★), herdr-beads, beads-orca, maggie, [jeanpfs/bd-board](https://github.com/jeanpfs/bd-board), [srimel/beads-board](https://github.com/srimel/beads-board), [awhitty/bb](https://github.com/awhitty/bb), orca-beads, azedarach. Zero reference [vercel/board](https://github.com/vercel/board) |
| `"vercel"`                         | [gastownhall/beads issues search](https://github.com/gastownhall/beads/issues?q=%22vercel%22)                 | 8, none Board-related (Dolt refs in docs, dependabot)                                                                                                                                                                                                                                                                                                                |
| `vercel-board`                     | [npm registry](https://www.npmjs.com/package/@vercel/board)                                                   | only `@vercel/board` itself (v0.53.0, published 2026-11-19 — same-day patch cadence)                                                                                                                                                                                                                                                                                 |
| `board-beads`                      | npm registry direct lookup                                                                                    | 404 — no package                                                                                                                                                                                                                                                                                                                                                     |
| `beads-board`                      | [npm registry](https://registry.npmjs.org/beads-board)                                                        | exists — a Feb-2026 blessed-based terminal kanban TUI for beads by linliwei06; pre-dates Board, not an adapter                                                                                                                                                                                                                                                       |
| `beads-board`                      | [PyPI JSON API](https://pypi.org/pypi/beads-board/json)                                                       | 404 — no package                                                                                                                                                                                                                                                                                                                                                     |
| `"vercel board"`                   | [HN Algolia stories](https://hn.algolia.com/?q=%22vercel+board%22)                                            | 3 total; 1 relevant = Show HN 2026-11-19 (10 pts, 1 comment); 2 irrelevant (board-of-directors)                                                                                                                                                                                                                                                                      |
| `vercel board beads`               | HN Algolia (stories+comments)                                                                                 | 2 hits, both coincidental word matches; no adapter announcement                                                                                                                                                                                                                                                                                                      |
| `"vercel board" beads` + reactions | web search                                                                                                    | launch coverage (The New Stack, Agent Brief, dev blogs) mentions no beads integration                                                                                                                                                                                                                                                                                |

Named gaps in coverage:

- GitHub code search requires authentication — not reachable unauthenticated this session.
- Reddit (`reddit.com/search.json`) returned HTTP 403 — unreachable, single attempt.
- Private/WIP adapters are invisible to public search by definition.

Adjacency proxy for "is anyone building Board backends at all": [vercel/board](https://github.com/vercel/board) showed **3 forks, 0 watchers** on 2026-11-19, and all 13 most recent PRs (#754–#765) came from one Vercel member (NicolasMontone, Claude-generated).

## Near misses (adjacent, not adapters)

- **beads UI ecosystem** — the 68-repo `beads board` search above is entirely board-shaped UIs over beads. beads' own curated ecosystem list, [`docs/community-tools.md`](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md) (~50 tools, fetched 2026-11-19), has **no Vercel Board entry**.
- **Multi-tracker sync tools** — the Lista Beads VSCode extension (syncs beads with Azure DevOps, GitHub, Jira, Linear, GitLab) and jira-beads-sync connect beads to issue trackers, not to Board ([community-tools.md](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md)).
- **Coordination servers** — [BeadHub](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md) (open-source coordination server: work claiming, file reservations, async mail + sync chat) and aweb (federated agent mail/chat) overlap Board's messaging role; neither speaks Board's protocol.
- **Board's own sync adapters** — Board ships sync to Slack, GitHub, and Linear plus custom providers via `sync-chat-sdk` ([github.com/vercel/board](https://github.com/vercel/board)); no beads entry exists.

## Board + beads facts at scan time

- **Board** — [github.com/vercel/board](https://github.com/vercel/board), [`@vercel/board` v0.53.0 on npm](https://www.npmjs.com/package/@vercel/board), Apache-2.0. The hosted store (`api.vercel.com/v1/messageboard`) is a closed service; the open repo ships the client, SDK, CLI, `local()` SQLite backend, conformance suite, and sync adapters. The `Backend` and `Protocol` types are exported — any object answering the protocol mounts via `board()` — and `vb conformance` checks a backend against the whole protocol.
- **beads** — [github.com/gastownhall/beads](https://github.com/gastownhall/beads) (steveyegge/beads redirects), MIT, **28.8k stars**, 1.9k forks, 11.6k commits. Storage is Dolt-backed (`.beads/issues.jsonl` is interchange, not source of truth); integration surfaces are the `bd` CLI (`bd list --json`), the events journal (`bd events tail --follow`, v1.3+), and an experimental HTTP backend (`bd serve`).

## Re-running the scan

Before claiming the field is still clear, re-run:

1. [vercel/board issues for `beads`](https://github.com/vercel/board/issues?q=beads) — expect no adapter hits
2. [GitHub repo search `vercel board beads`](https://github.com/search?q=vercel+board+beads&type=repositories) — expect 0
3. [GitHub issues search `beads "vercel board"`](https://github.com/search?q=beads+%22vercel+board%22&type=issues) — sort recent first, eyeball the FPs
4. [gastownhall/beads issues for `"vercel"`](https://github.com/gastownhall/beads/issues?q=%22vercel%22) — expect nothing Board-related
5. npm: [`board-beads`](https://www.npmjs.com/package/board-beads), [`beads-board`](https://www.npmjs.com/package/beads-board), and a `vercel-board` search — check for new adapter packages
6. PyPI: [`beads-board`](https://pypi.org/pypi/beads-board/json) — expect 404 or a non-adapter
7. [HN Algolia](https://hn.algolia.com/?q=%22vercel+board%22) stories and comments — no adapter announcements

Known blind spots no re-run can close: GitHub code search (auth-gated), Reddit (403 at scan time), and anything private or WIP. Absence claims weaken daily — this document is a snapshot of 2026-11-19, not a standing guarantee.

---

Scan performed during session research for the board-beads plan; searches were run via the GitHub API, npm registry, PyPI, and HN Algolia on 2026-11-19.
