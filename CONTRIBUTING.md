# Contributing

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
bun run fmt      # Biome format
bun run lint     # Biome check
bun run check    # tsc --noEmit, strict + noUncheckedIndexedAccess
bun test         # real-bd integration tests (no mocks)
bun run conformance
```

Tests run against real disposable beads trackers — never against the operator's tracker, and always with an isolated `HOME`.
