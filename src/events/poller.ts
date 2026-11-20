/**
 * The journal consumer: tails bd's events journal through the transport's
 * typed read, translates journal rows into Board event shapes through the
 * model layer, and maintains the seq checkpoint that the events feed and
 * the wake subscribers advance on.
 *
 * Row classification, op by op:
 *   - `create`  → `message.posted`. A create row may land before the
 *     metadata write every board post commits right after it, so a bare
 *     create holds the feed open briefly instead of answering a wrong
 *     classification; past the hold it settles as not-a-message.
 *   - `update`  → diffed against the issue's last classified state:
 *     `message.edited`, `message.deleted`, `reaction.added`,
 *     `reaction.removed`, or `labels.changed`. A row that changes nothing
 *     board-visible (the trailing metadata write of a post, an unknown
 *     field) is a no-op.
 *   - `close`   → `message.deleted` when the tombstone is set; a status-only
 *     close carries no board change and is a no-op.
 *   - `delete`  → `message.deleted`, recalled from the cache when the issue
 *     is already gone (a delete row carries no issue at all).
 *   - `dep_add` / `dep_remove` / `comment` → no-ops for the feed: the
 *     board-visible state of a dep or a native comment arrives in the
 *     metadata rows the same write commits. The rows still fan out as wake
 *     signals to subscribers (claim scans wait on `dep_add`; watchers match
 *     translated events).
 *
 * Enrichment reads the row's own issue snapshot first — bd attaches the
 * issue exactly as the write left it, metadata and labels included — so a
 * row that carries both classifies with no bd spawn at all; only a bare
 * create (its metadata still in flight) falls back to reading the issue as
 * it stands now (`bd show` + `bd label list`, through the transport's own
 * run). The row's own fields (seq, ts, actor) ride the event as its cursor,
 * time, and actor.
 *
 * A journal that has never recorded is a typed disabled state — not an
 * error — with a warning naming the fix (`BD_EVENTS_JOURNAL=1`), and a
 * journal whose retention cut below the cursor re-baselines to the floor.
 */
import type { BoardEventView, MessageView } from "@vercel/board";
import type {
  BdEventsPage,
  BdJournalRecord,
  BdResult,
} from "../bd/transport.ts";
import { issueToMessage } from "../model/message.ts";
import type {
  BdIssue,
  LabelsApi,
  MessageAuthorIdentity,
  MetadataCodec,
} from "../model/types.ts";

/** Why the journal cannot currently serve a faithful feed. */
export interface JournalWarning {
  code: "journal_disabled";
  message: string;
  /** The operator fix, naming the flag that turns journaling on. */
  fix: string;
}

/** The poller's lifecycle state. */
export type PollerStatus =
  "idle" | "live" | "disabled" | "truncated" | "stopped";

/** The raw wake signal one journal row fans out to subscribers. */
export interface JournalSignal {
  seq: number;
  op: string;
  issueId: string;
  actor: string;
}

/** What one journal row classifies as. */
export type RowOutcome =
  | { kind: "event"; view: BoardEventView }
  | { kind: "noop" }
  | { kind: "skip" }
  | { kind: "hold" };

/** How the translator resolves a bd actor slug to the writer's identity. */
export type AuthorLookup = (
  slug: string | null,
) => MessageAuthorIdentity | null;

export interface TranslatorDeps {
  /**
   * The issue a row names, as the row's own snapshot when it carries one
   * (the write's exact truth, no spawns), else as it stands now — or null
   * when it is gone or not a message.
   */
  loadMessage: (
    issueId: string,
    row?: BdJournalRecord,
  ) => Promise<MessageView | null>;
  authorFor?: AuthorLookup;
  /**
   * The label decoder, for reading a row's own snapshot: bd attaches the
   * labels a write left behind, and replayed walks classify from them
   * instead of the issue's present. Without it, every row reads as-now.
   */
  labels?: LabelsApi;
  /** How long a bare create may wait for its metadata to land (ms). */
  holdMs?: number;
}

export interface EventTranslator {
  translate(row: BdJournalRecord): Promise<RowOutcome>;
}

/** The transport surface enrichment reads through: the bd module's own. */
export interface BdReadTransport {
  run(
    args: readonly string[],
    options?: {
      extraEnv?: Readonly<Record<string, string>>;
      omitEnv?: readonly string[];
    },
  ): Promise<BdResult>;
}

export interface EnrichmentDeps {
  transport: BdReadTransport;
  codec: MetadataCodec;
  labels: LabelsApi;
  authorFor?: AuthorLookup;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Decode one `bd show` row (object or one-element array) for the model. */
function decodeShowRow(data: unknown): BdIssue | null {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) return null;
  const row = asRecord(rows[0]);
  if (!row) return null;
  const id = row.id;
  if (typeof id !== "string" || id === "") return null;
  return {
    id,
    title: typeof row.title === "string" ? row.title : undefined,
    description:
      typeof row.description === "string" ? row.description : undefined,
    status: typeof row.status === "string" ? row.status : undefined,
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    metadata: row.metadata,
  };
}

/** Decode `bd label list <id> --json`: an array of bd label strings. */
function decodeLabelList(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The row's own issue snapshot, as a decodable issue with its at-row labels,
 * or null when the snapshot is missing either piece (a bare create's is —
 * its metadata and labels land in the rows after it).
 */
function snapshotOf(
  row: BdJournalRecord,
): { issue: BdIssue; labels: string[] } | null {
  let snapshot: unknown = row.issue;
  if (typeof snapshot === "string" && snapshot !== "") {
    try {
      snapshot = JSON.parse(snapshot) as unknown;
    } catch {
      return null;
    }
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return null;
  }
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.labels)) return null;
  const labels = record.labels.filter(
    (entry): entry is string => typeof entry === "string",
  );
  let metadata: unknown = record.metadata;
  if (typeof metadata === "string" && metadata !== "") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      /* bd's own format is an object; leave a string to the decoder */
    }
  }
  const issue = decodeShowRow({ ...record, metadata });
  if (issue === null) return null;
  return { issue, labels };
}

/**
 * The enrichment read behind classification: a row's own snapshot when it
 * serves (the write's exact truth, at no spawn cost), else the issue as it
 * stands now. Anything unreadable — a gone issue, a non-message, a failed
 * read — answers null; none of it throws.
 */
export function createMessageLoader(
  deps: EnrichmentDeps,
): (issueId: string, row?: BdJournalRecord) => Promise<MessageView | null> {
  const authorFor =
    deps.authorFor ?? ((): MessageAuthorIdentity | null => null);
  return async (issueId, row) => {
    if (row !== undefined) {
      const snapshot = snapshotOf(row);
      if (snapshot !== null) {
        const view = issueToMessage(snapshot.issue, {
          codec: deps.codec,
          labels: deps.labels,
          authorFor,
          bdLabels: snapshot.labels,
        });
        if (view.ok) return view.value;
        if (
          snapshot.issue.metadata !== undefined &&
          snapshot.issue.metadata !== null
        ) {
          // The row's own snapshot is whole and says not-a-message: no
          // as-now read can make this row one.
          return null;
        }
        // A bare create's snapshot: what stands now may already be whole —
        // read it, and its null takes the hold below.
      }
    }
    let shown: BdResult;
    try {
      shown = await deps.transport.run(["show", issueId, "--json"]);
    } catch {
      return null;
    }
    const issue = decodeShowRow(shown.data);
    if (!issue) return null;
    let bdLabels: string[] = [];
    try {
      const listed = await deps.transport.run([
        "label",
        "list",
        issueId,
        "--json",
      ]);
      bdLabels = decodeLabelList(listed.data);
    } catch {
      bdLabels = [];
    }
    const view = issueToMessage(issue, {
      codec: deps.codec,
      labels: deps.labels,
      authorFor,
      bdLabels,
    });
    return view.ok ? view.value : null;
  };
}

/** The event's writer fields: the payload `by`, and the `actor` card. */
function writerOf(
  row: BdJournalRecord,
  authorFor: AuthorLookup,
): {
  by: MessageView["by"];
  actor: (MessageAuthorIdentity["view"] & { id: string }) | undefined;
} {
  const identity = authorFor(row.actor);
  if (identity === null) {
    return {
      by: { actor: row.actor, principal: "", profile: null },
      actor: undefined,
    };
  }
  return {
    by: identity.by,
    actor: { ...identity.view, id: identity.by.actor },
  };
}

/** The `message.posted` event a create row carries once its message reads. */
export function postedEvent(
  row: BdJournalRecord,
  view: MessageView,
  authorFor: AuthorLookup,
): BoardEventView {
  const { by, actor } = writerOf(row, authorFor);
  return {
    cursor: String(row.seq),
    type: "message.posted",
    createdAt: row.ts,
    payload: {
      channel: view.channel,
      text: view.text,
      re: view.re,
      replyTo: view.replyTo,
      thread: view.thread,
      labels: { ...view.labels },
      noSync: view.noSync,
      by,
      origin: view.origin,
      from: view.from,
    },
    message: view,
    actor,
  };
}

function editedEvent(
  row: BdJournalRecord,
  view: MessageView,
  authorFor: AuthorLookup,
): BoardEventView {
  const { by, actor } = writerOf(row, authorFor);
  return {
    cursor: String(row.seq),
    type: "message.edited",
    createdAt: row.ts,
    payload: {
      id: view.id,
      thread: view.thread,
      text: view.text,
      by,
      from: view.from,
    },
    message: view,
    actor,
  };
}

function deletedEvent(
  row: BdJournalRecord,
  id: string,
  thread: string,
  from: string | null,
  authorFor: AuthorLookup,
  view: MessageView | undefined,
): BoardEventView {
  const { by, actor } = writerOf(row, authorFor);
  return {
    cursor: String(row.seq),
    type: "message.deleted",
    createdAt: row.ts,
    payload: { id, thread, by, from },
    message: view,
    actor,
  };
}

function reactionEvent(
  row: BdJournalRecord,
  view: MessageView,
  emoji: string,
  added: boolean,
  authorFor: AuthorLookup,
): BoardEventView {
  const { by, actor } = writerOf(row, authorFor);
  return {
    cursor: String(row.seq),
    type: added ? "reaction.added" : "reaction.removed",
    createdAt: row.ts,
    payload: { id: view.id, thread: view.thread, emoji, by, from: view.from },
    message: view,
    actor,
  };
}

function labelsEvent(
  row: BdJournalRecord,
  view: MessageView,
  set: MessageView["labels"],
  unset: string[],
  authorFor: AuthorLookup,
): BoardEventView {
  const { by, actor } = writerOf(row, authorFor);
  return {
    cursor: String(row.seq),
    type: "labels.changed",
    createdAt: row.ts,
    payload: { id: view.id, thread: view.thread, set, unset, by },
    message: view,
    actor,
  };
}

/** The first board-visible delta between two label maps. */
function labelsDelta(
  prior: MessageView["labels"],
  current: MessageView["labels"],
): { set: MessageView["labels"]; unset: string[] } | null {
  const set: MessageView["labels"] = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (prior[key] !== value) set[key] = value;
  }
  for (const key of Object.keys(prior)) {
    if (current[key] === undefined) unset.push(key);
  }
  if (Object.keys(set).length === 0 && unset.length === 0) return null;
  return { set, unset };
}

/** The first board-visible reaction delta between two reaction maps. */
function reactionDelta(
  prior: MessageView["reactions"],
  current: MessageView["reactions"],
): { emoji: string; added: boolean } | null {
  for (const [emoji, actors] of Object.entries(current)) {
    const before = prior[emoji] ?? [];
    if (actors.some((actor) => !before.includes(actor))) {
      return { emoji, added: true };
    }
  }
  for (const [emoji, actors] of Object.entries(prior)) {
    const now = current[emoji] ?? [];
    if (actors.some((actor) => !now.includes(actor))) {
      return { emoji, added: false };
    }
  }
  return null;
}

/**
 * The labels a row's own issue snapshot carries, as bd label strings, or
 * null when the row names none — a write that moved no label (a bare
 * metadata write) attaches no `labels`, which is how the two cases differ.
 */
function labelsAtRow(row: BdJournalRecord): string[] | null {
  const issue: unknown = row.issue;
  let snapshot: unknown = issue;
  if (typeof issue === "string" && issue !== "") {
    try {
      snapshot = JSON.parse(issue) as unknown;
    } catch {
      return null;
    }
  }
  const record = asRecord(snapshot);
  const labels = record?.labels;
  if (!Array.isArray(labels)) return null;
  return labels.filter((entry): entry is string => typeof entry === "string");
}

/**
 * The row classifier. State lives across rows (per issue: the last
 * classified message state, and a create row's first hold), so one
 * translator instance serves one consumer; the feed and the poller each
 * carry their own.
 */
export function createEventTranslator(deps: TranslatorDeps): EventTranslator {
  const holdMs = deps.holdMs ?? 2_000;
  const authorFor =
    deps.authorFor ?? ((): MessageAuthorIdentity | null => null);
  /** issueId → the message as the consumer last classified it. */
  const seen = new Map<string, MessageView>();
  /** issueId → epoch ms of the first unclassifiable read of a bare create. */
  const holds = new Map<string, number>();

  async function translate(row: BdJournalRecord): Promise<RowOutcome> {
    // dep_add / dep_remove / comment: no-op rows for the feed (their
    // board-visible state arrives in the metadata rows of the same write),
    // and the poller fans their wake signals out before this runs — skip
    // them without spending enrichment spawns on what they cannot say.
    if (
      row.op === "dep_add" ||
      row.op === "dep_remove" ||
      row.op === "comment"
    ) {
      return { kind: "noop" };
    }
    const prior = seen.get(row.issueId) ?? null;
    const view = await deps.loadMessage(row.issueId, row);

    if (view === null) {
      if (row.op === "delete" && prior !== null) {
        // The issue is gone outright; the cache is the only memory it was
        // ever a message, and the tombstone names no message view.
        seen.delete(row.issueId);
        holds.delete(row.issueId);
        return {
          kind: "event",
          view: deletedEvent(
            row,
            prior.id,
            prior.thread,
            prior.from,
            authorFor,
            undefined,
          ),
        };
      }
      const heldAt = holds.get(row.issueId);
      if (row.op === "create") {
        // A post's metadata write commits right after its create: hold the
        // row open once, then settle it as not-a-message.
        const first = heldAt ?? Date.now();
        if (heldAt === undefined) holds.set(row.issueId, first);
        if (Date.now() - first < holdMs) return { kind: "hold" };
      }
      holds.delete(row.issueId);
      return { kind: "skip" };
    }

    holds.delete(row.issueId);
    // What this row says the labels were: the snapshot's own, decoded, when
    // it names them; the row before it's, when the write moved no label; the
    // issue's present, when there is nothing else to go on. A replayed walk
    // thus reads the transitions a write made, not just where things stand.
    const atRow = labelsAtRow(row);
    const labeled: MessageView =
      atRow === null
        ? prior === null
          ? view
          : { ...view, labels: prior.labels }
        : deps.labels === undefined
          ? view
          : { ...view, labels: deps.labels.fromBdLabels(atRow) };
    seen.set(row.issueId, labeled);

    if (row.op === "create") {
      return { kind: "event", view: postedEvent(row, view, authorFor) };
    }
    if (row.op === "update") {
      return classifyUpdate(row, prior ?? null, labeled);
    }
    if (row.op === "close") {
      return view.deleted
        ? {
            kind: "event",
            view: deletedEvent(
              row,
              view.id,
              view.thread,
              view.from,
              authorFor,
              view,
            ),
          }
        : { kind: "noop" };
    }
    if (row.op === "delete") {
      return {
        kind: "event",
        view: deletedEvent(
          row,
          view.id,
          view.thread,
          view.from,
          authorFor,
          view,
        ),
      };
    }
    // dep_add / dep_remove / comment: the rows fan out as wake signals;
    // their board-visible state arrives in the metadata rows of the write.
    return { kind: "noop" };
  }

  function classifyUpdate(
    row: BdJournalRecord,
    prior: MessageView | null,
    view: MessageView,
  ): RowOutcome {
    if (prior === null) {
      // First sight of the issue through an update row: the create row was
      // never consumed by this consumer (a resume, or a cursor handed in
      // from elsewhere). Say what the state itself proves, nothing more.
      if (view.deleted) {
        return {
          kind: "event",
          view: deletedEvent(
            row,
            view.id,
            view.thread,
            view.from,
            authorFor,
            view,
          ),
        };
      }
      if (view.revision > 1 || view.editedAt !== null) {
        return { kind: "event", view: editedEvent(row, view, authorFor) };
      }
      return { kind: "noop" };
    }
    if (!prior.deleted && view.deleted) {
      return {
        kind: "event",
        view: deletedEvent(
          row,
          view.id,
          view.thread,
          view.from,
          authorFor,
          view,
        ),
      };
    }
    if (view.text !== prior.text || view.revision > prior.revision) {
      return { kind: "event", view: editedEvent(row, view, authorFor) };
    }
    const labels = labelsDelta(prior.labels, view.labels);
    if (labels) {
      return {
        kind: "event",
        view: labelsEvent(row, view, labels.set, labels.unset, authorFor),
      };
    }
    const reaction = reactionDelta(prior.reactions, view.reactions);
    if (reaction) {
      return {
        kind: "event",
        view: reactionEvent(
          row,
          view,
          reaction.emoji,
          reaction.added,
          authorFor,
        ),
      };
    }
    return { kind: "noop" };
  }

  return { translate };
}

export interface EventPollerDeps extends TranslatorDeps {
  /** The typed journal read (the transport's tailEvents). */
  tail: (cursor: string) => Promise<BdEventsPage>;
  /** How often a running poller re-tails (ms). */
  cadenceMs?: number;
}

export interface EventPoller {
  readonly status: PollerStatus;
  /** Warnings observed so far, newest last; the disabled fix names the flag. */
  readonly warnings: readonly JournalWarning[];
  /** The newest journal seq seen raw, as a cursor string; "0" before any. */
  head(): string;
  /** Begin the background tail loop. Nothing runs before this. */
  start(): void;
  /**
   * One tail cycle, synchronously awaited: the deterministic probe. A cycle
   * already running when this is called is waited out first, so the call
   * ends with a full cycle that read the journal no earlier than the call —
   * never a silent no-op.
   */
  tick(): Promise<void>;
  /** Stop the loop, release every waiter, and settle as stopped. */
  stop(): Promise<void>;
  onRecord(fn: (signal: JournalSignal) => void): () => void;
  onEvent(fn: (view: BoardEventView) => void): () => void;
  onTruncated(
    fn: (info: { floor: number; head: number | null }) => void,
  ): () => void;
  /**
   * Resolves true once the journal head has moved past `cursor`, false on
   * timeout, abort, or stop. This is the long-poll's early release.
   */
  waitBeyond(
    cursor: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

interface Waiter {
  cursor: number;
  settle: (ok: boolean) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

export function createEventPoller(deps: EventPollerDeps): EventPoller {
  const cadenceMs = deps.cadenceMs ?? 250;
  const translator = createEventTranslator(deps);
  let status: PollerStatus = "idle";
  let rawHead = "0";
  /**
   * The classified checkpoint: rows past a held row are never skipped.
   * Null until the start probe ran: the loop begins at the journal head, not
   * at zero — every row before this process existed is served by reads that
   * anchor below the head (a read tails from its caller's own cursor), and
   * translating all of history here would only spend bd invocations that no
   * consumer waits on.
   */
  let checkpoint: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** The tail cycle in flight, if any; set at its start, cleared at its end. */
  let pending: Promise<void> | null = null;
  const warnings: JournalWarning[] = [];
  const recordSubs = new Set<(signal: JournalSignal) => void>();
  const eventSubs = new Set<(view: BoardEventView) => void>();
  const truncatedSubs = new Set<
    (info: { floor: number; head: number | null }) => void
  >();
  const waiters = new Set<Waiter>();

  function rawHeadNumber(): number {
    const value = Number(rawHead);
    return Number.isSafeInteger(value) ? value : 0;
  }

  function release(waiter: Waiter, ok: boolean): void {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.settle(ok);
  }

  /** Resolve every waiter past the raw head; called when the head moves. */
  function wakeWaiters(): void {
    const head = rawHeadNumber();
    for (const waiter of [...waiters]) {
      if (head > waiter.cursor) release(waiter, true);
    }
  }

  /**
   * One tail cycle. At most one runs at a time: a call while one is in
   * flight rides the in-flight promise instead of stacking a new cycle, so
   * the cadence can never queue work up behind a slow journal.
   */
  function runCycle(): Promise<void> {
    if (pending !== null) return pending;
    pending = (async () => {
      try {
        if (checkpoint === null) {
          // Start at the head: one probe read places the checkpoint past
          // everything that happened before this process existed. History
          // stays servable — a read anchors on its own cursor and tails the
          // journal directly — so the rows below the head are skipped here
          // rather than translated one spawn at a time.
          const probe = await deps.tail("0");
          if (stopped) return;
          if (probe.kind === "records") {
            status = "live";
            rawHead = probe.cursor;
            const head = Number(probe.cursor);
            checkpoint = Number.isSafeInteger(head) && head > 0 ? head : 0;
            wakeWaiters();
            return;
          }
          if (probe.kind === "truncated") {
            status = "truncated";
            rawHead = String(probe.head ?? probe.floor);
            checkpoint = Math.max(0, probe.floor - 1);
            for (const fn of truncatedSubs)
              fn({ floor: probe.floor, head: probe.head });
            wakeWaiters();
            return;
          }
          // A journal that has never recorded: the disabled warning names
          // the flag, and later cycles still re-check in case journaling
          // turns on under this process.
          status = "disabled";
          checkpoint = 0;
          if (!warnings.some((entry) => entry.code === "journal_disabled")) {
            warnings.push({
              code: "journal_disabled",
              message:
                "the events journal has never recorded on this workspace: writes made without the journal flag (and out-of-band writers) are invisible to the feed",
              fix: "set BD_EVENTS_JOURNAL=1 on the backend's bd invocations, or enable the workspace with `bd config set events-journal true`",
            });
          }
          return;
        }
        const page = await deps.tail(String(checkpoint));
        if (stopped) return;
        if (page.kind === "records") {
          status = "live";
          rawHead = page.cursor;
          for (const row of page.events) {
            for (const fn of recordSubs) {
              fn({
                seq: row.seq,
                op: row.op,
                issueId: row.issueId,
                actor: row.actor,
              });
            }
            const outcome = await translator.translate(row);
            // A held row pins the checkpoint: its classification (a post, or
            // a plain issue) is decided on a later cycle, never skipped.
            if (outcome.kind === "hold") break;
            if (outcome.kind === "event") {
              for (const fn of eventSubs) fn(outcome.view);
            }
            checkpoint = Math.max(checkpoint, row.seq);
          }
          wakeWaiters();
          return;
        }
        if (page.kind === "truncated") {
          status = "truncated";
          rawHead = String(page.head ?? page.floor);
          checkpoint = Math.max(0, Math.max(checkpoint, page.floor - 1));
          for (const fn of truncatedSubs)
            fn({ floor: page.floor, head: page.head });
          wakeWaiters();
          return;
        }
        if (checkpoint === 0) {
          // Nothing was ever classified: an empty read here really is a
          // journal that has never recorded. Past a nonzero checkpoint the
          // same read is just a caught-up consumer — this backend journals
          // writes through the per-process flag, so the workspace config
          // being off does not make the feed disabled.
          status = "disabled";
          if (!warnings.some((entry) => entry.code === "journal_disabled")) {
            warnings.push({
              code: "journal_disabled",
              message:
                "the events journal has never recorded on this workspace: writes made without the journal flag (and out-of-band writers) are invisible to the feed",
              fix: "set BD_EVENTS_JOURNAL=1 on the backend's bd invocations, or enable the workspace with `bd config set events-journal true`",
            });
          }
        }
      } catch {
        // A failed read keeps the checkpoint and retries next cadence; the
        // consumer never crashes on one bad invocation.
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  async function tick(): Promise<void> {
    while (pending !== null) await pending;
    if (!stopped) await runCycle();
  }

  function start(): void {
    if (stopped || timer !== undefined) return;
    void runCycle();
    timer = setInterval(() => {
      if (pending === null) void runCycle();
    }, cadenceMs);
    // A backend that closes without stop() must not hold the loop open.
    timer.unref?.();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    for (const waiter of [...waiters]) release(waiter, false);
    status = "stopped";
  }

  function head(): string {
    return rawHead;
  }

  function waitBeyond(
    cursor: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const base = Number(cursor);
    const from = Number.isSafeInteger(base) ? base : 0;
    if (signal?.aborted || stopped || waitMs <= 0)
      return Promise.resolve(false);
    if (rawHeadNumber() > from) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        cursor: from,
        settle: resolve,
        timer: setTimeout(() => release(waiter, false), waitMs),
        signal,
        onAbort: () => release(waiter, false),
      };
      waiter.timer.unref?.();
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      // The head may have moved while the waiter was being built.
      if (rawHeadNumber() > from || stopped)
        release(waiter, rawHeadNumber() > from);
      else waiters.add(waiter);
    });
  }

  function onRecord(fn: (signal: JournalSignal) => void): () => void {
    recordSubs.add(fn);
    return () => recordSubs.delete(fn);
  }

  function onEvent(fn: (view: BoardEventView) => void): () => void {
    eventSubs.add(fn);
    return () => eventSubs.delete(fn);
  }

  function onTruncated(
    fn: (info: { floor: number; head: number | null }) => void,
  ): () => void {
    truncatedSubs.add(fn);
    return () => truncatedSubs.delete(fn);
  }

  return {
    get status() {
      return status;
    },
    get warnings() {
      return warnings;
    },
    head,
    start,
    tick,
    stop,
    onRecord,
    onEvent,
    onTruncated,
    waitBeyond,
  };
}
