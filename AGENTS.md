# board-beads agent instructions

board-beads implements Vercel Board's Backend contract over a beads tracker. The
[implementation plan](docs/plans/2026-11-19-1356-feat-board-beads-backend-plan.md)
defines the intended behavior and accepted limitations.

## Working together

- Fetch `origin/main` before starting. Use a dedicated Git worktree and branch
  for each change. Preserve concurrent work and verify the current PR head
  before merging.
- Use Gitmoji commit and PR titles. Keep fixes focused and land them through PRs
  after local verification and green GitHub checks.

## Verification

- Use Bun 1.4.4 for development and Node 22.18 or newer for the runtime. Install
  dependencies with `bun install --frozen-lockfile`.
- Run `bun fmt --check`, `bun run check`, `bun test`,
  `bun run verify:platform`, and `bun run build`. Run
  `bun run conformance` for backend work and before any release.
- Exercise the real `bd` CLI (>=1.3.4, <2) against disposable trackers via the
  fixture in `test/helpers`. Keep tests away from operator trackers and inherited
  Dolt configuration. Use a `bd` build with embedded Dolt support.

## Releases

Follow [CONTRIBUTING.md](CONTRIBUTING.md#releases). Ordinary PRs keep the current
package version. Cut a fresh 0.x version for each release and use the matching
tag on the merged commit. Release tags require conformance and use npm trusted
publishing. Publish a tag only when the operator asks for a release.
