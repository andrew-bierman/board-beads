# Conformance check inventory — stub-backend run

Machine receipt: [`conformance-inventory.json`](./conformance-inventory.json) (same run).
Source of truth for the suite, cited below as `kit L<line>`: the mounted package source at
`/tmp/opencode/board-src/packages/board/src/conformance/index.ts` (@vercel/board 0.53.0).
Other citations name that tree's files.

## 1. How this was produced

- Harness: `scripts/conformance.ts` — `conformance(board({ backend: createBackend() }))` in
  process, per `docs/04-reference/05-conformance.md` ("A backend of your own goes through
  `board()` in the same process, with no URL"). Prints the per-group report; `--json out=<path>`
  writes the receipt; exits **0 only when every check passed or skipped**, else nonzero.
- Backend: `scripts/conformance-stub-backend.ts` — a `Backend` answering three methods for real
  (`discovery`, `me`, `channelMessages`) and refusing the other 62 of the 65 protocol methods
  (`src/server/routing.ts` `METHODS`, L29-46) with the family code:
  `no_scheduler`, `no_tasks`, `no_grants`, `no_schemas`, `no_files`, `no_direct_uploads`;
  everything with no doc-assigned family code (core reads/writes, `channels`, search reads,
  `watchers`/`register`/`matches`/`ack`, all sync/inbox) answers 501 `not_supported`.
- Run: 2026-11-19T22:59:19.851Z → 2026-11-19T22:59:19.885Z (UTC), suite `@vercel/board/conformance`.
- Exit code: **1** (36 failures) — expected
  and honest. The stub cannot pass: core writes are refused.

## 2. Per-group summary in the stub run

| group | total | passed | failed | skipped | note |
| ----- | ----- | ------ | ------ | ------- | ---- |

| `core` | 29 | 2 | 22 | 5 | Board writes/reads/everything. 2 passed: discovery (board() assembles it itself) and 400-validation (board() validates shapes before the backend is reached). |

| `paging` | 2 | 0 | 2 | 0 | `older` cursor paging of `threads` — fails on 501, not optional. |

| `search` | 2 | 0 | 1 | 1 | OPTIONAL. One true 501 skip; the other fails through `needRoot` (posting failed first). |

| `schedules` | 2 | 0 | 2 | 0 | OPTIONAL family code `no_scheduler` — never reached in this run: both checks bail at `needRoot` before touching `schedule`. |

| `tasks` | 24 | 0 | 0 | 24 | OPTIONAL (`no_tasks`). All 24 skipped; one skipped by credential-shape wording, the rest by 501. |

| `grants` | 14 | 0 | 0 | 14 | OPTIONAL (`no_grants`). Includes 2 checks that skip unconditionally by design, 3 gated on `x-board-can`, 2 on `principals`. |

| `schemas` | 5 | 0 | 1 | 4 | OPTIONAL (`no_schemas`) — but one check FAILS on 501: it demands 409 `reserved_schema` and catches the error itself (see §3). |

| `attachments` | 3 | 0 | 0 | 3 | OPTIONAL (`no_files`). The third check probes `tasks.list` first and skips on `no_tasks`. |

| `watchers` | 3 | 0 | 2 | 1 | NOT optional: 501 fails. Both real checks failed on `watchers` 501. |

| `sync` | 7 | 0 | 6 | 1 | NOT optional: 501 fails. 6 failed — 5 through `registerSync` → `watchers()` 501, one through `needRoot`. |

## 3. Per-501-code skip semantics (the contract the four route units build against)

The kit's OPTIONAL set — kit L176:
`{ search, schedules, tasks, grants, schemas, attachments }`. The check loop, kit L2536-2548:

- Any check in an OPTIONAL group that throws `BoardError` with status **501** →
  **skipped**, detail `not kept here: <board's message>` (kit L2541). The code string is not
  matched — only the status. Empirically confirmed: `no_tasks` (23 skips), `no_grants` (8),
  `no_schemas` (3), `no_files` (2), `not_supported` (1 search skip).
- Every other group — **core, paging, watchers, sync** — a 501 is a **failure**. Confirmed:
  watchers 2 fails and sync 5 fails carry `501` details.
- Two code-specific skips beside 501 (kit L2543, L2545): watchers checks throwing
  `watchers_need_project` → skip ("only a deployment registers watchers here"); grants checks
  throwing `unsupported_principal` → skip ("this board takes no GitHub or OIDC principals in a
  grant").
- In-check skips that beat 501s: `register()` converts only a 403 on `createSchema` to a skip
  (kit L360-367); `registerSync()` converts only a 403 on `register` (kit L376-388); a 400
  `*_not_found` from a board that looks names up skips grants checks that named an unknown
  principal (`unnamed`, kit L213-216).

Three asymmetries found empirically, which a real backend must know:

1. **OPTIONAL-group skip only fires when the check itself receives the 501.** Checks that bail
   earlier through `needRoot` (kit L178-181) fail with `posting failed, so there's nothing to
read` even inside an OPTIONAL group: search's second check failed, both schedules checks
   failed, sync's `noSync` check failed. Until posts/threads work, optional groups fail through
   dependency, not skip.
2. **`no_scheduler` was never observed.** Both schedules checks call `needRoot` before any
   `schedule`/`schedules`/`cancelSchedule` call, so the stub's `no_scheduler` code went
   unexercised. It still matters for a partially-implemented backend (kit L2541 skips on 501).
3. **One schemas check cannot skip on 501.** "refuses a built-in's name, and a definition it
   couldn't check a value against" (kit L2036-2051) catches `createSchema`'s error itself and
   demands 409 `reserved_schema` (kit L2040-2046) — a board keeping no schemas FAILS it
   (`expected 409 reserved_schema, got 501 no_schemas`). Upstream behavior; fine once beads
   implements schemas, worth knowing before then. (`no_direct_uploads` is likewise never
   exercised: no check calls `uploadStart`/`uploadFinish`.)

## 4. Does setup survive a `createSchema` 501? Yes.

Setup (kit L2495-2534) touches exactly: `discovery()` (L2497 — must answer an object with
`url`, `audience`, and array `sync`, else the run aborts with one failed core check, L2501-2507;
board() itself reads only `.sync` off the backend's answer, serve.ts L1147-1152, and fills
`version`/`url`/`audience`/`team_id`/`project_id` itself); `me()` (L2511 — no guard: a throw
kills the whole run); the principal guards (`namesCaller` L2453-2465 and `ownProjectByName`
L2474-2489, which no-op unless the run is a `vercel:project:*` deployment and `principals.project`
was passed); and the channel cursor read `(await board.channel(channel).messages({limit:1})).cursor`
(L2522 — no guard: this is why the stub answers `channelMessages` for real).

`createSchema` is **not** part of setup. First schemas contact happens inside checks via
`register()` (kit L360-367): a 501 propagates and the OPTIONAL rule (L2541) skips. The stub run
is the proof: `createSchema` answering 501 `no_schemas` produced 4 schemas skips, and the suite
ran to a full report. The runner-level caveat for the harness remains: a backend factory throw,
or refused `discovery`/`me`/`channelMessages`, kills the run before a report exists.

## 5. Header-gated checks (14) and how to unlock them

Two `ConformanceOptions` handlers, kit L42-52: `withCan(can)` (a handle whose requests carry
`x-board-can: can`) and `withHeaders(headers)` (arbitrary headers, e.g. `x-board-profile`;
it also stands in for `withCan` — the kit builds `withCan` as `withHeaders({'x-board-can': can})`,
kit L2525). Without them, gated checks return the skip strings `NO_CAN`/`NO_HEADERS` (kit
L100-101): "this run can't call the board with an x-board-can header" / "...headers of its own".

| group    | check (kit line)                                                        | unlocked by                                                                              |
| -------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| core     | narrows a caller to what its x-board-can says (L880)                    | `withCan`                                                                                |
| core     | takes a profile and its avatar as one x-board-profile header… (L897)    | `withHeaders`                                                                            |
| core     | lets a profile change only its own messages… (L913)                     | `withHeaders`                                                                            |
| core     | ignores x-board-avatar… (L946)                                          | `withHeaders`                                                                            |
| core     | ignores x-board-session… (L958)                                         | `withHeaders`                                                                            |
| tasks    | lets a profile change only the tasks it made… (L1500)                   | `withHeaders` (+can) — but calls `task()` first, so the family 501 fires before the gate |
| tasks    | takes label in its channel to claim a task… (L1547)                     | `withCan` — `task()` first                                                               |
| tasks    | takes read in a prerequisite's channel… (L1561)                         | `withCan` — `taskBeside()` first                                                         |
| grants   | takes manage at each pattern a grant names… (L1869)                     | `withCan` via `narrow()` (L291)                                                          |
| grants   | lets no caller narrowed with x-board-can grant past its can… (L1893)    | `withCan`                                                                                |
| grants   | lets no caller narrowed… let anyone in where everyone gets more (L1910) | `withCan`                                                                                |
| schemas  | refuses a caller narrowed with x-board-can a schema… (L2086)            | `withCan`                                                                                |
| watchers | refuses a caller narrowed… its principal's watchers (L2192)             | `withCan`                                                                                |
| sync     | refuses a caller narrowed… sync's records (L2416)                       | `withCan` — `registerSync()` first                                                       |

Unlock mechanism, with sources:

- How `vb conformance` does it over HTTP: `withHeaders: (headers) => connection(undefined,
{ headers }).board` — `src/cli/main.ts` L1330. The board client spreads an options `headers`
  field into every request (`src/client/client.ts` L106-107, L355), and merges `x-board-can` the
  same way (`main.ts` L1120).
- For this in-process harness, the same shape works — each handler builds another handle on the
  same backend, hence the same credential/principal:

  ```ts
  conformance(board({ backend: createBackend() }), {
    withHeaders: (headers) => board({ backend: createBackend(), headers }),
    withCan: (can) =>
      board({ backend: createBackend(), headers: { "x-board-can": can } }),
  });
  ```

- Passing only `withHeaders` unlocks all 14 (via the L2525 fallback); `withCan` alone leaves the
  4 profile/session checks skipped. Gated checks that make a family call first (tasks ×3, sync)
  need the family implemented before their gate is even reached — in the stub run their skip
  details are `not kept here`, not `NO_CAN`/`NO_HEADERS`.
- The stub run skipped 10 of the 14 for gate reasons (6 × `NO_CAN`, 4 × `NO_HEADERS`); the
  tasks trio skipped on the family 501 first.

## 6. What the sync checks call (the sync worker's build list)

Setup per sync check: `registerSync()` (kit L376-388) — `watchers()`, find the run's own
registration (`owner === me.principal`); skip if it already has watch keys or sync entries
(registering would replace them); `register({ watch: {}, sync: [{ key: 'conformance',
platform: 'conformance' }] })` (`SYNC_KEY='conformance'`, kit L370); 403 → skip; on the way out
`register({ ...where, watch: {} })` restores the previous wake location (`wokenAt`, kit L138-141).

| calls                               | what the checks demand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncImport` op `post`              | author is a platform user `{ id: 'conformance:user:<run>', handle: 'conformance', name: 'Conformance', avatar: null, isBot: false }`, `from: 'conformance'`, channel/text/labels/`noSync`, `origin { channel: 'conformance:<run>', thread: 'conformance:<run>:1', subthread: null, message: '1', context: null }`, idempotency `id: 'conformance-sync-<run>'`. Retry with the same id → the same message. A second root from the same platform thread → 409 `already_synced`. The board view: `by.actor = '<me.principal>+<author.id>'`, `by.principal = me.principal`, `by.profile = author.id`, `author.name` set, `author.via` present, `from = 'conformance'`, `origin.thread` set (kit L2204-2269) |
| `syncImport` op `edit` / `delete`   | edit by `origin`+text rewrites the imported root; delete is cleanup (failures swallowed — only an import can take an import down). Editing an imported thread's root after it was made a task holds the task (`blocked.kind: 'edited'`) and fences its claim (`claim_lost`) (kit L1662-1701)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `syncImport` with `mentioned`       | a platform user mentioned in `mentioned[]` is stored as `@[<principal>+<platform-id>]` in the text and listed by `actors()` with its platform name (kit L2271-2307)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `syncFind({ thread, message })`     | platform-ID lookup → `{ thread, message }` naming the board thread/copy (kit L2240-2243)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `syncThread(thread)`                | → `{ root }` of the synced board thread (kit L2243)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `syncReceipt`                       | kind `'thread'` `{ target, targetKind: 'thread', cause: 'request' }` and kind `'message'` `{ target, external: { thread, message } }`; then `syncCopies([id])[id][target]` equals the external copy, and `sync(id).targets` shows the same row (kit L2254-2260)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `linked(url)`                       | a link no sync here knows → 404 `message_not_found` (kit L2261)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `inboxPush(key, events)`            | ≤50 per batch, event `id` 1..`INBOX_EVENT_ID_MAX`=300 chars (`routes.ts` L723-725; a 301-char id is 400 — kit refuses it whatever the code, L2363-2367); retry of an id lands once; events `{ id, event: { kind: 'message'\|'edited', channel, thread, subthread, message, isRoot, text, context, author }, raw }`                                                                                                                                                                                                                                                                                                                                                                                      |
| `inboxNext(key, { limit })`         | leases until acked, **one platform thread at a time, in order** — the next of a thread only after the previous is acked (`docs/03-http.md` L191-192); `raw` payload round-trips verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `inboxAck(key, id, { lease })`      | done; error → retry with a wait, given up after 5 tries (doc L192)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `matches({ wait: 5 })` (as `@sync`) | while a sync is registered, a post yields a match with `watcher: '@sync'`, `event.type: 'message.posted'`; ack it (kit L2381-2402)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thread` (noSync read-back)         | a post's and reply's `noSync: true` read back — no registration needed (kit L2404-2413)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| narrowed caller (needs `withCan`)   | `syncImport` / `syncReceipt` / `inboxPush` / `inboxNext` / `inboxAck` by an `x-board-can`-narrowed caller → 403 `forbidden` (kit L2414-2445)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Skip wording to expect: `this token can't register a sync here` (403 on register),
`this token can't sync in <channel>` (403 on import), `this token has watchers or a sync
registered here, which registering would replace` (pre-existing registration).

## 7. What the watcher checks call (the watchers worker's build list)

| calls                                                                                   | what the checks demand                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchers()`                                                                            | list registrations `{ owner, watch: { name: { tail } }, sync[], hash, url\|path/branch }`; the run's own is `owner === me.principal`. Skip when it already has watch keys or sync entries (kit L2140-2144)                                                                                                                                |
| `register({ watch: { conformance: { tail: '<channel> --label conformance=<run>' } } })` | replaces the principal's registration (never on one that has some); restored afterwards via `register({ ...wokenAt(previous), watch: {} })` (kit L2147-2159)                                                                                                                                                                              |
| `matches({ wait: 5 })`                                                                  | pull: the match for the labeled post, `{ id, watcher: 'conformance', thread, lease, attempt, event }`, **leased for 5 minutes** (`docs/03-http.md` L147), one thread at a time in order, long-poll held up to `wait` seconds (≤25); 404 `no_registration` without a registration                                                          |
| `ack(id, { lease })`                                                                    | done; a second ack → 404 `no_match`; a lease that ran out → 409 `stale_lease`; `error` retries with a wait (`watch.failed` after 5), `skip` drops (doc L148)                                                                                                                                                                              |
| `register({ path, branch?, watch: {} })`                                                | wake-by-path is discovery-driven: `discovery().wake_by_path` absent → must answer **501 `no_wake_by_path`** (implementable with no wake infra — beads should omit `wake_by_path` and answer exactly this); with `wake_by_path` and a non-`vercel:project:*` principal → 403 `not_a_project`; a preview may pass `branch` (kit L2162-2188) |
| narrowed caller (needs `withCan`)                                                       | `register` / `matches` / `ack` by an `x-board-can`-narrowed caller → 403 `forbidden`; a board deployment-only throws `watchers_need_project` through as a skip instead (kit L2190-2203)                                                                                                                                                   |

**The watchers group is not OPTIONAL**: any 501 in it fails (both real checks failed in this
run). `discovery.wake_by_path` must stay absent for beads unless real wake infra exists — the
check then demands the 403 `not_a_project` path.

## 8. Suite side effects a real backend must survive

- **Channel `conformance`** (default; `options.channel`), every post labeled
  `conformance=<8 hex>`; second tasks channel **`conformance/tasks`** (kit L421); grants work
  confined to the **`conformance/grants/`** subtree (`ci/`, `closed/`, `inner/`, `secret/`,
  `open/`, `batch/`, `lockout/`, `apps/` patterns; `explain` on `.../thread` channels, kit
  L192-200). A run leaves no channel behind and creates none of its own (`createChannel` on the
  posted channel answers `created: false`).
- **Schema `conformance@1`** registered once and never removed (kit L339-353): the same
  definition every run, key order irrelevant (canonical compare); re-register answers
  `created: false`; a changed definition or description → 409 `schema_immutable`; a built-in's
  name → 409 `reserved_schema`; definitions with a non-object root, `$ref`, `pattern`, or
  `uniqueItems` → 400 `invalid_schema`. Blocks referencing it are validated on post and edit.
- **Deletes**: every posted id — replies first (reversed order), task roots included (they are
  pushed into the same list), imported messages via `syncImport` op `delete` — tombstones stay;
  failures are swallowed (`catch(() => {})`, kit L2549-2552). A deleted message keeps no labels
  and drops out of label reads.
- **Grants**: every grant a check made is revoked, newest first, at the check's end; a failed
  revoke fails the check (kit L246-315). `lockMeOut` probe then a 409 `grant_lockout` attempt;
  batch make-or-none. **Run one at a time**: two concurrent runs see each other's grants there.
- **Schedules** canceled in `finally`; **watchers/sync registrations** restored to
  `{ ...where, watch: {} }` after every check that replaced them.
- **Client IDs**: `conformance-<run>`, `conformance-task-<run>`, `conformance-batch-<run>`,
  `conformance-sync-<run>`, `conformance-mentioned-<run>`, `conformance-inbox-<run>-*`,
  `conformance-nobody-<base36 ts>` — idempotent writes under them.
- **Time behavior**: long-polls held open (`poll wait: 10`, `matches wait: 5`, task claim
  `wait: 10`); `soon()` polls every 250 ms for up to 10 s for derived states (a task becoming
  ready once its needs completed); 3-way races on replies, edits at a revision, label claims,
  and task claims — exactly one winner, losers get the specified 409.

## 9. Notes the four route units should take from this run

- **board() validates before the backend**: the core check "answers 400 for a request that does
  not validate" PASSED on the stub — malformed channel paths are refused by board()'s own
  serving layer, never reaching the backend. Storage absence is the backend's: "answers 404 for
  an ID that names nothing" FAILED (`expected 404 message_not_found, got 501`) — the backend
  must answer 404 `message_not_found` for unknown message/thread ids itself.
- **Order of work is forced by dependency**, not the report: posts/threads first (every group's
  checks ride on `needRoot`), then reads/paging/events, then the optional families, then
  watchers/sync (whose checks all start at `registerSync`/`watchers()`).
- **tasks**: the method list is `TASK_METHODS` (`routing.ts` L39, 16 methods); claim leases are
  seconds, 900 by default, a board may not give under 5 minutes or honor an ask for under 30 s
  (kit L1085-1101, `docs/03-http.md` L499-501); claims are fenced by `epoch`+`token`; the
  backend maintains the `board.*` label and refuses caller writes to it (400 `reserved_label`);
  `task.*` events ride the normal feed with state after each change.
- **events**: `poll` is client sugar over the `events` method; per-event cursors; newest-first
  via `last` may answer 501 `not_supported` and the check then follows from now (kit L780-784 —
  the one sanctioned core skip); no `session` key anywhere in `by`, event payloads, or `me`.

## 10. The 91 checks, per group, in the stub run

### `core` — 2 passed / 22 failed / 5 skipped

| status | check                                                                                                | detail in the stub run                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| pass   | says in its discovery where it is                                                                    |                                                                                                |
| FAIL   | posts a message, and reads it back by its ID                                                         | this stub keeps nothing, so post is refused                                                    |
| FAIL   | puts a reply in its root's thread                                                                    | posting failed, so there's nothing to read                                                     |
| FAIL   | replies after a message only while it's the thread's newest, one of any that race                    | this stub keeps nothing, so post is refused                                                    |
| FAIL   | posts once for a client ID, however many times it is sent                                            | this stub keeps nothing, so post is refused                                                    |
| FAIL   | raises the version with each edit, reaction, and label                                               | posting failed, so there's nothing to read                                                     |
| FAIL   | labels a message only while its labels are as the write says, one of any that race                   | this stub keeps nothing, so post is refused                                                    |
| FAIL   | edits and deletes a message only at the revision it was read at, which only edits and deletes change | this stub keeps nothing, so post is refused                                                    |
| FAIL   | reads one channel's messages after a cursor of its own, oldest first, and on from where it stopped   | posting failed, so there's nothing to read                                                     |
| FAIL   | lists channels a page at a time, and the ones under a prefix                                         | this stub keeps nothing, so channels is refused                                                |
| FAIL   | reads a thread's replies after one of its messages, and as many of its newest as it's asked for      | posting failed, so there's nothing to read                                                     |
| FAIL   | reads one channel's newest messages, as many as it's asked for                                       | posting failed, so there's nothing to read                                                     |
| FAIL   | lists threads, each with its reply count and latest reply                                            | posting failed, so there's nothing to read                                                     |
| FAIL   | stores a handle one actor has as a mention of them, and keeps one no one has as typed                | posting failed, so there's no thread to reply in                                               |
| FAIL   | reads events after a cursor, each with a cursor of its own                                           | posting failed, so there's nothing to read                                                     |
| FAIL   | reads a channel's newest events, oldest first, and goes on from their cursor                         | posting failed, so there's nothing to read                                                     |
| FAIL   | holds a long-poll open until the next event                                                          | this stub keeps nothing, so events is refused                                                  |
| FAIL   | deletes a message, leaving a tombstone                                                               | this stub keeps nothing, so post is refused                                                    |
| FAIL   | drops a deleted message from what its labels find                                                    | this stub keeps nothing, so post is refused                                                    |
| FAIL   | lists the channel and you in it                                                                      | this stub keeps nothing, so channels is refused                                                |
| FAIL   | creates a channel only once: one a post made is there already                                        | posting failed, so there's nothing to read                                                     |
| FAIL   | answers 404 for an ID that names nothing                                                             | reading a message that was never posted: expected 404 message_not_found, got 501 not_supported |
| pass   | answers 400 for a request that does not validate                                                     |                                                                                                |
| skip   | narrows a caller to what its x-board-can says                                                        | this run can't call the board with an x-board-can header                                       |
| skip   | takes a profile and its avatar as one x-board-profile header, and shows both on what it writes       | this run can't call the board with headers of its own                                          |
| skip   | lets a profile change only its own messages, and its principal all of them                           | this run can't call the board with headers of its own                                          |
| skip   | ignores x-board-avatar, which x-board-profile's avatar parameter replaced                            | this run can't call the board with headers of its own                                          |
| skip   | ignores x-board-session: who writes is the principal and its profile                                 | this run can't call the board with headers of its own                                          |
| FAIL   | shows no session on a message, its event, or you                                                     | posting failed, so there's nothing to read                                                     |

### `paging` — 0 passed / 2 failed / 0 skipped

| status | check                                                                     | detail in the stub run                         |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| FAIL   | pages back through a channel's threads by their `older`, each thread once | this stub keeps nothing, so post is refused    |
| FAIL   | refuses to page threads back and forward at once                          | this stub keeps nothing, so threads is refused |

### `search` — 0 passed / 1 failed / 1 skipped

| status | check                                                                               | detail in the stub run                                     |
| ------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| skip   | finds threads by text anywhere in a message of theirs, in any case, as it reads now | not kept here: this stub keeps nothing, so post is refused |
| FAIL   | lists the threads of every channel under a pattern at once                          | posting failed, so there's nothing to read                 |

### `schedules` — 0 passed / 2 failed / 0 skipped

| status | check                                                            | detail in the stub run                     |
| ------ | ---------------------------------------------------------------- | ------------------------------------------ |
| FAIL   | schedules a reply, lists it, and cancels it                      | posting failed, so there's nothing to read |
| FAIL   | keeps noSync on a schedule, so its sends stay off every platform | posting failed, so there's nothing to read |

### `tasks` — 0 passed / 0 failed / 24 skipped

| status | check                                                                                                                                            | detail in the stub run                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| skip   | starts a thread as a task, or makes one of a thread that was there: it reads as its thread, and board.task finds it                              | not kept here: this board keeps no tasks                                             |
| skip   | makes a task once for a client ID, and none under an ID a reply or a plain thread landed with                                                    | not kept here: this board keeps no tasks                                             |
| skip   | gives a task to one of the claims that race for it, and takes its result                                                                         | not kept here: this board keeps no tasks                                             |
| skip   | gives a claim the lease it asks for, up to 5 minutes, and says when it ends                                                                      | not kept here: this board keeps no tasks                                             |
| skip   | fences what a claim does: once it's over, its writes are lost and change nothing                                                                 | not kept here: this board keeps no tasks                                             |
| skip   | holds a task until the tasks it needs complete, which a failed or canceled one never does                                                        | not kept here: this board keeps no tasks                                             |
| skip   | refuses a prerequisite that was canceled, which can never complete, and takes one that failed                                                    | not kept here: this board keeps no tasks                                             |
| skip   | lists the tasks that wait for one in the channel a list names, or its subtree, and no other                                                      | not kept here: this board keeps no tasks                                             |
| skip   | lists the last active tasks with latest, wherever they come in the order they were made                                                          | not kept here: this board keeps no tasks                                             |
| skip   | says task.ready each time a task that needs others becomes ready: right after it is made or unblocked, once they have completed                  | not kept here: this board keeps no tasks                                             |
| skip   | changes what a task needs: it waits for the new ones, is ready once they have completed, and at once with none                                   | not kept here: this board keeps no tasks                                             |
| skip   | refuses a change of needs that would make a task wait for itself, straight back or through others                                                | not kept here: this board keeps no tasks                                             |
| skip   | changes what a task needs only while no one holds it and it has not finished                                                                     | not kept here: this board keeps no tasks                                             |
| skip   | makes several tasks in one write, in the order given: each waits for the ones it names, of the batch or there already, and an id makes them once | not kept here: this board keeps no tasks                                             |
| skip   | makes none of a batch when one of its tasks can not be made, wherever it comes in it                                                             | not kept here: this board keeps no tasks                                             |
| skip   | holds a task for a person, by its owner or its claim, and gives it back when unblocked                                                           | not kept here: this board keeps no tasks                                             |
| skip   | keeps a task assigned to a profile for that actor alone                                                                                          | this credential writes as one actor only, so no other actor of its principal can try |
| skip   | lets a profile change only the tasks it made, and its principal all of them                                                                      | not kept here: this board keeps no tasks                                             |
| skip   | takes label in its channel to claim a task: a caller narrowed to reading and posting claims none                                                 | not kept here: this board keeps no tasks                                             |
| skip   | takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it                                   | not kept here: this board keeps no tasks                                             |
| skip   | claims the oldest ready task in a channel or its subtree that has the labels asked for, and waits for one                                        | not kept here: this board keeps no tasks                                             |
| skip   | shows a feed that filters on board.task=ready a task becoming ready and being claimed, and never a token                                         | not kept here: this board keeps no tasks                                             |
| skip   | keeps labels under board. its own: a label write or a post that sets one is refused                                                              | not kept here: this board keeps no tasks                                             |
| skip   | holds a task when anyone but its owner edits its root, which ends its claim                                                                      | not kept here: this board keeps no tasks                                             |

### `grants` — 0 passed / 0 failed / 14 skipped

| status | check                                                                                              | detail in the stub run                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| skip   | grants a principal, lists it, and revokes it                                                       | not kept here: this board keeps no grants                                                                                        |
| skip   | makes another grant for the same principals, and changes one by its ID                             | not kept here: this board keeps no grants                                                                                        |
| skip   | keeps a grant's can as written, a pattern with no permissions included                             | not kept here: this board keeps no grants                                                                                        |
| skip   | lets the most specific pattern decide, then the closest principal there, and adds up ties          | not kept here: this board keeps no grants                                                                                        |
| skip   | lets everyone narrow what something else lets in, and lets no one in itself                        | not kept here: this board keeps no grants                                                                                        |
| skip   | caps a person by their team role, so a viewer reads but neither posts nor manages                  | name a viewer in principals to check it: a board without team roles caps no one                                                  |
| skip   | names an app by its slug or client ID, keeps it by client ID, and every app as a group             | name an app in principals to check it: a local board has no apps                                                                 |
| skip   | takes manage at each pattern a grant names to change it, and at * to list them                     | this run can't call the board with an x-board-can header                                                                         |
| skip   | lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it | this run can't call the board with an x-board-can header                                                                         |
| skip   | lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has        | this run can't call the board with an x-board-can header                                                                         |
| skip   | refuses a grant its maker couldn't take back, unless it says lockMeOut                             | not kept here: this board keeps no grants                                                                                        |
| skip   | makes several grants in one write, or none of them, a lock with the grant that keeps its maker in  | not kept here: this board keeps no grants                                                                                        |
| skip   | lets a member grant on a pattern after a lock under it                                             | a run can't be shut out by a lock and lift it afterwards: the board's own tests check it                                         |
| skip   | lets a project on another team in, in its environments                                             | grants across teams aren't specified yet: what a project on another team needs, and what all-projects means for one, comes later |

### `schemas` — 0 passed / 1 failed / 4 skipped

| status | check                                                                                              | detail in the stub run                                                                 |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| skip   | lists the built-in schemas first, and reads a schema by its ID                                     | not kept here: this board keeps no schemas                                             |
| skip   | registers a schema version once: the same definition again changes nothing, and another is refused | not kept here: this board keeps no schemas                                             |
| FAIL   | refuses a built-in's name, and a definition it couldn't check a value against                      | a version of the built-in git-commit: expected 409 reserved_schema, got 501 no_schemas |
| skip   | carries a block in a message, checked against the schema its fence names                           | not kept here: this board keeps no schemas                                             |
| skip   | refuses a caller narrowed with x-board-can a schema, and lets it read them                         | this run can't call the board with an x-board-can header                               |

### `attachments` — 0 passed / 0 failed / 3 skipped

| status | check                                             | detail in the stub run                   |
| ------ | ------------------------------------------------- | ---------------------------------------- |
| skip   | takes a file, posts it, and gives it back         | not kept here: this board keeps no files |
| skip   | refuses a name that would download as a dotfile   | not kept here: this board keeps no files |
| skip   | starts a task with a file, which its root carries | not kept here: this board keeps no tasks |

### `watchers` — 0 passed / 2 failed / 1 skipped

| status | check                                                                                                 | detail in the stub run                                   |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| FAIL   | matches a registered tail, hands the match to a pull, and takes its ack                               | this stub keeps nothing, so watchers is refused          |
| FAIL   | wakes by path only where its discovery says so, and only a Vercel project                             | this stub keeps nothing, so watchers is refused          |
| skip   | refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking | this run can't call the board with an x-board-can header |

### `sync` — 0 passed / 6 failed / 1 skipped

| status | check                                                                                                                         | detail in the stub run                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| FAIL   | keeps sync's records: an import as a profile of its importer, its lookups by platform ID, a receipt, and where it's synced    | this stub keeps nothing, so watchers is refused          |
| FAIL   | meets a platform user an import's text mentions: an actor as one who wrote would be, whom the text names by that actor's ID   | this stub keeps nothing, so watchers is refused          |
| FAIL   | queues a platform thread's events in its sync's inbox once, and leases each after the one before is acked                     | this stub keeps nothing, so watchers is refused          |
| FAIL   | takes an edit of a long message in its sync's inbox, under the longest event ID the protocol allows, and refuses a longer one | this stub keeps nothing, so watchers is refused          |
| FAIL   | hands a sync each message change as a match of its @sync watcher                                                              | this stub keeps nothing, so watchers is refused          |
| FAIL   | keeps noSync on a post and a reply, so sync sends neither                                                                     | posting failed, so there's nothing to read               |
| skip   | refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox                                   | this run can't call the board with an x-board-can header |
