# AGENTS.md

Instructions for coding agents working in this repository.

board-beads implements Vercel Board's Backend contract over a beads tracker. The
[implementation plan](docs/plans/2026-11-19-1356-feat-board-beads-backend-plan.md)
defines the intended behavior and accepted limitations.

## Working together

- Fetch `origin/main` before starting. Use a dedicated branch for each change;
  preserve concurrent work and verify the current PR head before merging.
  `main` is trunk and multiple sessions may push concurrently — rebase, don't
  merge-stray, and never rewrite `.github/workflows/*` blind (check `gh run list`
  first; the release pipeline iterates independently).
- Use Gitmoji commit and PR titles (`✨ feat:`, `🐛 fix:`, `✅ test:`, `📝 docs:`,
  `🔧 chore:`, `♻️ refactor:`, `⚡️ perf:`, `🔖 chore(release): vX.Y.Z`). Keep
  fixes focused and land them through PRs after local verification and green
  GitHub checks.
- Plan IDs (`U4`, `R23`, `KTD13`) mean nothing without the plan open — keep them
  out of written files; write what the rule says instead.

## Verification

Use Bun 1.4.4 for development and Node 22.18 or newer for the runtime. Install
dependencies with `bun install --frozen-lockfile`.

```bash
bun fmt --check      # format gate (native Bun formatter)
bun check            # typecheck — strict, noUncheckedIndexedAccess via tsconfig
bun test             # all tests
bun run verify:platform
bun run build
bun run conformance  # Board conformance suite — required for backend work and before any release
```

Tests run against real `bd` CLI (>=1.3.4, <2) via disposable trackers in
`test/helpers/bd-fixture.ts` — isolated `HOME`, never the operator's tracker,
never inherited Dolt config. **No mocks** — that is a settled product decision,
not a preference.

## Hard rules

- **One transport.** Only `src/bd/` spawns processes; routes never call bd directly.
- **Strict types.** No `any`; explicit `.ts` import extensions.
- **Namespaces.** Backend metadata uses `bb.*` (parametrized); Board's `board.*`
  label prefix is reserved — reject it from callers, never emit it yourself.
- **Single writer.** While a board runs, the backend is the only writer of the
  tracker (README: single-writer contract). Reads are always safe; never assume
  out-of-band writes are visible.
- **Config-driven surface.** Options are additive forever — a knob ships in a
  minor, defaults never change behavior.

## bd gotchas

- The Go module declares its path as `github.com/steveyegge/beads` even though
  the repo lives at `gastownhall/beads` — install by the declared path.
- Exit codes: 13 = guarded-write precondition lost (guarded arm of claim races),
  14 = migration freeze (retry later), 1 + "already claimed by" = plain claim
  race. Heartbeat loss is a plain exit 1, message-only.
- The events journal is opt-in **per bd process** (`BD_EVENTS_JOURNAL=1`) and
  per-replica — writes from processes without it (and git-pulled changes) are
  never journaled.
- `bd events tail` emits bare records (`{seq, ts, op, issue_id, actor, issue}`);
  `bd update --metadata` merges keys; `dep add --type replies-to` works on 1.3.4
  despite missing from its help text.

## Releases

Follow [CONTRIBUTING.md](CONTRIBUTING.md#releases). Ordinary PRs keep the current
package version. Cut a fresh 0.x version for each release and use the matching
tag on the merged commit. Release tags require conformance and use npm trusted
publishing. Publish a tag only when the operator asks for a release.
