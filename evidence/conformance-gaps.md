# Conformance gap report — first real-beads run

Machine receipt: [`conformance-gaps.json`](./conformance-gaps.json) (same run).
Stub baseline for comparison: [`conformance-inventory.md`](./conformance-inventory.md).
Source of truth for the suite, cited below as `kit L<line>`:
`/tmp/opencode/board-src/packages/board/src/conformance/index.ts` (@vercel/board 0.53.0).

## 1. How this was produced

- Harness: `scripts/conformance.ts --backend beads` — the new flag wires the **real** backend at the
  INJECTION POINT: `conformance(board({ backend: beads({ dir: fixture.dir }) }))`, where the fixture
  (`test/helpers/bd-fixture.ts`) boots a fresh, real bd tracker (`bd init` on Dolt, isolated temp
  HOME) per run. **No mocks.** The default (no flag) is still the stub run, byte-for-byte the old
  behavior.
- bd 1.3.4 (7ef2fd05e), dolt 2.7.3, bd Version journal on. Run: 2026-11-19T23:35:39.764Z →
  2026-11-19T23:37:15.743Z (~96 s, in process).
- Exit code: **1** — expected and honest: watchers and sync are still 501 (units in flight), and the
  landed groups have real gaps (§4). This run was **not** meant to go green; it is the gap list.
- Landed at run time: threads/messages routes + events long-poll + transport/model. Still 501 by
  design: tasks, grants, schemas, files, watchers, sync.

## 2. Headline: real run vs stub baseline

**18 passed / 16 failed / 57 skipped** of 91 — vs the stub's **2 / 36 / 53**.

| group | total | stub (P/F/S) | real beads (P/F/S) | delta |
| --- | --- | --- | --- | --- |
| `core` | 29 | 2 / 22 / 5 | 15 / 8 / 6 | 13 more pass; 14 fewer fail; +1 skip (the sanctioned `last`-read skip, §5) |
| `paging` | 2 | 0 / 2 / 0 | **2 / 0 / 0** | fully green — `older` back-paging and the before+after 400 both pass |
| `search` | 2 | 0 / 1 / 1 | 0 / 0 / 2 | the fail became a real 501 skip: beads declares text/pattern threads unsupported |
| `schedules` | 2 | 0 / 2 / 0 | 0 / 0 / 2 | the fails were `needRoot` artifacts; now clean `no_scheduler` skips |
| `tasks` | 24 | 0 / 0 / 24 | 0 / 0 / 24 | unchanged, 501 `no_tasks` skips (unit in flight) |
| `grants` | 14 | 0 / 0 / 14 | 0 / 0 / 14 | unchanged, 501 `no_grants` skips (unit in flight) |
| `schemas` | 5 | 0 / 1 / 4 | 0 / 1 / 4 | unchanged — the one check that cannot skip on 501 (inventory §3.3) still fails |
| `attachments` | 3 | 0 / 0 / 3 | 0 / 0 / 3 | unchanged, 501 `no_files` skips |
| `watchers` | 3 | 0 / 2 / 1 | 0 / 2 / 1 | **expected** — unit in flight; 501 fails |
| `sync` | 7 | 0 / 6 / 1 | **1** / 5 / 1 | "keeps noSync on a post and a reply" now **passes** (rides threads, no registration) |

Reads and writes are real: posts, replies, reply fencing (409 `newer_message`, incl. the 3-way race),
client-ID idempotency, revision-fenced edits/deletes (incl. the edit race), cursor paging of
messages, channel lists + prefix, thread replies after/limit, mentions (`@[actor]` storage), 404/400
validation, channel/actors discovery. What fails is concentrated: **labels (unset + filtered
listing), tombstones, and the event feed.**

## 3. Where each failure lands

- **U4 follow-ups (threads/messages): 5 failing checks** — label unset ×2, label-filtered listing ×2,
  tombstone text ×1 (§4.1).
- **U5 follow-ups (events/feed): 3 failing checks** — poll-after-cursor ×2, long-poll ×1 (§4.2).
- **Expected, units in flight — not gaps of the landed work:** watchers ×2, sync ×5 (each refused
  with the declared 501 "this board doesn't keep that here"), schemas ×1 (the upstream asymmetry:
  that check demands 409 `reserved_schema` and catches the 501 itself — inventory §3.3; it will
  pass once the schemas unit lands).

## 4. The gap list — landed groups (core / paging / events)

Every failing check with what it exercised, the exact receipt detail, and — from the check's source —
what the backend must answer to pass. `tracker-44t` is the run's root-post id (a bd issue id).

### 4.1 U4 follow-ups — threads/messages (5 checks, 4 distinct gaps)

**G1. `label` with `unset` is a no-op** — 2 checks fail on this one gap.

- "raises the version with each edit, reaction, and label" (kit L495-514)
  - Exercised: edit → react → `label(id, { set: { state: 'open' } })` each raise `version`; then
    `label(id, { unset: ['state'] })` must remove the label, so `labels.state` reads `undefined`.
  - Receipt: `the label unset: expected undefined, got "open"` — the set path works (set/read-back/
    version bumps all passed before it); the unset write succeeded but left the label in place.
  - To pass: a label write with `unset: [name]` must delete those labels from the message's stored
    label set (bd label removal), and the removal must still raise `version` like every write.

- "labels a message only while its labels are as the write says, one of any that race" (kit L516-542)
  - Exercised: three racing conditional claims `label(id, { set: { owner }, if: { owner: null } })`
    — exactly one lands, losers get 409 `label_conflict` (that all passed) — then release:
    `label(id, { unset: ['owner'], if: { owner: 'agent-1' } })` must remove `owner`.
  - Receipt: `the owner, released from the value it had: expected undefined, got "agent-1"`.
  - To pass: `unset` honored, **with** the `if` guard enforced (conditional on the label's current
    value; guard mismatch → 409 `label_conflict`). The conditional set path already does this — unset
    needs the same fence on the delete side.

**G2. `threads({ label })` finds nothing** — 2 checks fail on this one gap.

- "lists threads, each with its reply count and latest reply" (kit L645-653)
  - Exercised: post a root + reply, then `threads({ channel, label: ctx.labels })` — the exact labels
    the post carried — must list that thread with `replies: 1` and `last.id = reply.id`.
  - Receipt: `the threads should include tracker-44t` — the same root IS found by the unfiltered
    listing (paging passes with `threads({ channel })`), so channel listing works; adding the label
    filter zeroes it out. bd label values vs the query's values are not matching (mapping/lookup
    mismatch in the label→bd-label path), not missing data.
  - To pass: label-filtered thread reads must return every root whose message carries **all** the
    queried labels (name and value), with `replies` count and `last` latest reply per thread.

- "drops a deleted message from what its labels find" (kit L761-775)
  - Exercised: post a labeled root + reply; `threads({ channel, label })` must find it; after
    `delete(root.id)`, the root must keep no labels and drop out of the label read.
  - Receipt: `its labels should find the root's thread before the delete, got []` — failed on the
    **before** step: G2 again (nothing is found even before the delete). The after-delete demands
    (tombstone drops labels, drops out of label reads) are unexercised until G2 is fixed.
  - To pass: G2, then the tombstone behavior of G3 (a deleted root keeps no labels and leaves label
    reads).

**G3. A deleted message keeps its text** — 1 check.

- "deletes a message, leaving a tombstone" (kit L747-753)
  - Exercised: `delete(id)`, then read the thread back: `deleted: true` **and** `text === ''`.
  - Receipt: `a deleted message should be deleted with no text, got {"deleted":true,"text":"conformance: to delete"}`
    — the tombstone flag lands; the text is not blanked.
  - To pass: deleting must clear the message's text in the stored row (keep `deleted: true`; the kit
    separately demands a tombstone keeps no labels — G2's after-delete step).

**G4 (roll-up of the above).** One more consequence worth having on the list: the kit's deleted-read
check passed, but until G2/G3 land, "keeps no labels" and "drops from label reads" after a delete are
asserted nowhere. Fixing G2 will surface them; they are U4 acceptance criteria, not new work.

### 4.2 U5 follow-ups — events/feed (3 checks, 2 distinct gaps)

**G5. The feed doesn't return a post made before the read** — 2 checks fail on this one gap.

- "reads events after a cursor, each with a cursor of its own" (kit L703-713)
  - Exercised: `poll({ channel, after: ctx.start })` — the run's pre-run cursor — must return the
    run's `message.posted` event with a per-event cursor; reading on from that cursor must not
    repeat it.
  - Receipt: `the events should include tracker-44t being posted` — the page came back but held no
    posted event for the run's root: the `after` cursor → journal-seq resolution or the channel
    filter drops the run's writes (the run's posts are all labeled and in `conformance`).
  - To pass: `events` after a cursor must include every message.posted (and later edited/deleted)
    event for the channel after that cursor, oldest first, each with its own cursor.

- "shows no session on a message, its event, or you" (kit L972-979)
  - Exercised: no `session` key anywhere — on `by`, in a `message.posted` event payload, or in `me`.
    It failed before the assertion: `poll({ channel, after: ctx.start, label, wait: 0 })` must hold
    the run's post.
  - Receipt: `events after the run's start should hold its post, got []` — G5, not the session rule
    (the message-side `noSession` assertions passed earlier in the same check).
  - To pass: G5; the no-session rule itself is already met on the message path.

**G6. The long-poll doesn't wake** — 1 check.

- "holds a long-poll open until the next event" (kit L796-803)
  - Exercised: read the channel's tail cursor, start `poll({ channel, label, after: cursor, wait: 10 })`,
    post while it waits, and the pending read must return with that post's event.
  - Receipt: `the long-poll should return the post made while it waited` — the poll ended without the
    post's event (wake miss: the journal consumer's handoff to the waiting poll, or the label filter
    on live delivery — same suspicion family as G5).
  - To pass: a pending long-poll must be woken by the matching write and answer with its event within
    the wait window (kit allows `wait` ≤ 25 s).

**Declared, not a gap:** "reads a channel's newest events, oldest first, and goes on from their
cursor" (kit L716-741) **skipped** — beads answered 501 `not_supported` ("this feed cannot be read
from its end") for a `last` read, which the kit sanctions as the one legal core skip (kit L780-784).
If U5 ever implements end-reads, the check will exercise them; until then this is a conscious
limitation, and it is why core's skip count is 6, not the stub's 5.

## 5. Header-gated checks — what's reachable in-process

14 checks gate on the harness's `withCan`/`withHeaders` options (inventory §5); without them each
skips with "this run can't call the board with an x-board-can header" (6) / "...headers of its own"
(4), and 4 more (tasks ×3, sync ×1) hit their family 501 before the gate. All 14 skipped in this run,
as in the stub run.

**Reachable now — `withCan` via `handle.as(null, { can })` (10 checks).** `ProfileOption` accepts
`null` (`client/client.ts` L98), and `as(null, { can })` keeps the run's own principal while narrowing
`me.can` (board.ts `profileCaller` L403-407) — exactly what the kit's gated checks assert:
`me.principal` unchanged, `me.can` the parsed can (kit L880-895). One line in the harness's
`conformance(...)` call: `withCan: (can) => board({ backend }).as(null, { can })`. What they'd then
require of beads:
- core "narrows a caller..." — reads allowed, post → 403 `forbidden`. The routes already narrow via
  `caller.can` (`identityOf` narrows FULL_ACCESS, threads.ts L399-400), so this should pass once
  wired.
- grants ×3, schemas ×1, watchers ×1, sync ×1 (narrowed callers refused manage/grants/schemas/
  watchers/sync records with 403 `forbidden`) — need their units first; the refusal itself is
  route-level work in those units.
- tasks ×2 — gated behind the tasks family regardless.

**Not faithfully reachable in-process — the 4 `withHeaders` profile checks.** In-process, headers
don't exist on a handle ("a request is this caller's whatever its headers say: another profile is
another handle's", board.ts L388), and `as({ name, avatar })` makes the profile **its own principal**
(`board:client:<name>`, threads.ts `identityOf` L394-395) — while the checks demand the message's
`by.principal` stay the run's own with `by.profile` as the named profile (kit L897-911, L913-945).
So `as(profile)` would fail their principal assertions. Honest unlocks: run the kit over HTTP against
a served beads board (the `vb conformance` shape, `cli/main.ts` L1330: `connection(undefined,
{ headers })`), or make beads' identity treat a profile as riding the caller's principal (a model
decision for U4, not a harness flag). "ignores x-board-avatar" and "ignores x-board-session" are the
two that a served run passes almost for free (the server must ignore both headers).

## 6. Notes for the units in flight (one line each, per §3)

- **watchers ×2 fail** — `watchers()` 501 "this board doesn't keep that here"; expected, unit in
  flight. Build list in inventory §7 (registration replace semantics, 5-min leases, one-at-a-time
  ordered matches, `wake_by_path` absent → 501 `no_wake_by_path`).
- **sync ×5 fail** — same 501 via `registerSync()` → `watchers()`; expected, unit in flight. Build
  list in inventory §6 (import as importer's profile, inbox once+ordered leasing, `@sync` matches,
  receipts/copies/lookups). The group's one registration-free check (noSync read-back) already
  passes.
- **schemas ×1 fails** — the upstream asymmetry (kit L2040-2046 demands 409 `reserved_schema` and
  catches the board's error itself): a 501-keeping board cannot skip it. Will pass with the schemas
  unit; nothing to do before then.
- **tasks / grants / attachments** — clean 24/14/3 skips on their family codes; nothing observed
  beyond the inventory's build lists.
- **search / schedules** — now clean skips on declared 501s (beads declares text/pattern thread reads
  and the whole scheduler unsupported): a strict improvement over the stub run, where both schedules
  checks and one search check failed only because posts didn't work.
