---
name: Bug report
about: Something misbehaves against a real beads tracker
title: "bug: "
labels: bug

---

<!-- Title starts with 🐛 (gitmoji convention) — e.g. "🐛 fix: task claim race returns 500 instead of 409" -->

## What happened

A clear description of the actual behavior.

## What you expected

A clear description of the expected behavior.

## Minimal repro

Start from a cold start — a fresh tracker and a fresh shell — so the steps are complete:

```bash
bd version
bd init /tmp/repro-tracker
# ...mount snippet and commands that trigger the bug
```

If it involves code, paste the smallest `board({ backend: beads({ dir }) })` snippet that reproduces it.

## Environment

- `bd version` output (paste verbatim):
- `node --version`:
- `bun --version` (if used):
- OS:

## Notes

- Any bind-time warnings board-beads emitted
- Whether the tracker was touched by anything outside board-beads (`bd` writes, `coord`/`beadle`, git pulls) — out-of-band writers break the single-writer contract
