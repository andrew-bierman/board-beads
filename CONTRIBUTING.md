# Contributing

## Dev setup

- Node ≥ 22.18 and [Bun](https://bun.sh)
- [`bd`](https://github.com/gastownhall/beads) ≥ 1.3.4, < 2 on PATH — tests drive the real CLI
- `bun install`

## Commit convention

[Gitmoji](https://gitmoji.dev/) prefixes:

| Emoji | Use                                     |
| ----- | --------------------------------------- |
| ✨    | `feat:` new capability                  |
| 🐛    | `fix:` bug fix                          |
| ✅    | `test:` tests                           |
| 📝    | `docs:` documentation                   |
| 🔧    | `chore:` tooling/config                 |
| ♻️    | `refactor:` no behavior change          |
| ⚡️    | `perf:` performance                     |
| 🔖    | `chore(release): vX.Y.Z` — version tags |

## Quality gates

Every change passes:

```bash
bun run fmt             # format (bun fmt)
bun run check           # typecheck (bun check)
bun test                # real-bd integration tests (no mocks)
bun run verify:platform
bun run conformance     # non-blocking in CI until the suite fully lands
```

Tests run against real disposable beads trackers — never against the operator's tracker, and always with an isolated `HOME`.

## Pull requests

- Run the gates locally; CI must come back green.
- Cover behavior changes with focused tests — no mocks.
- Keep diffs focused; one change per PR.
- Title starts with a gitmoji.
- API changes: open an issue first so we can settle the shape before code lands. Pre-1.0, APIs may change freely.

## Releases

Regular PRs merge with the existing package version. To cut a release, commit a
fresh 0.x version in a release PR and tag the merged commit with the matching
`vX.Y.Z` tag. Use a patch for compatible fixes and a minor for new functionality
or pre-1.0 contract changes. The first working adapter is planned for `0.2.0`.

Release tags require the Board conformance suite to pass. Stable versions go to
npm's `latest` dist-tag and prereleases such as `0.2.0-rc.1` go to `next`.
