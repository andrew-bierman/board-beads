---
name: Feature request
about: Suggest a capability for board-beads
title: "feat: "
labels: enhancement
---

<!-- Title starts with ✨ (gitmoji convention) — e.g. "✨ feat: expose attachment upload size config" -->

## Problem

What are you trying to do, and what blocks you? Describe the workflow, not the solution.

## Proposed API shape

If this touches the exported surface (`beads()`, options, behavior), sketch it:

```ts
beads({ dir: "..." /* your option here */ });
```

Behavior-only changes (error codes, event ordering, mapping details) can skip this.

## Alternatives considered

Other shapes, workarounds, or upstream options you tried.

## Upstream check

Does `bd` (≥ 1.3.4, < 2) already support what's needed? If it requires a newer `bd` capability or an upstream change, say so — it changes the answer.
