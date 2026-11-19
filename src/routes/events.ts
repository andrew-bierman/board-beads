/**
 * The `events` route: the long-poll the board serves its SSE feed from.
 *
 * Contract (the protocol's event feed, served method-by-method):
 *   - `after` is a journal seq as a decimal string, or a message cursor: a
 *     message ID anchors the feed after that message's own post, and an
 *     empty messages page's composite boundary starts the feed. A page
 *     answers at once when records exist past it, otherwise it waits up to
 *     `wait` seconds (capped at the protocol's 300) and answers an empty
 *     page, releasing early the moment the journal head moves.
 *   - The page's `cursor` is the last journal seq examined, matched or not,
 *     so reading on from it never repeats and never rescans. Each event's
 *     own `cursor` is the seq it sits at.
 *   - Omitted `after` reads from the journal head the consumer has seen
 *     (production binds the poller at startup; without it, from the
 *     journal's start).
 *   - Hostile cursors are 400 `invalid_cursor`; a journal whose retention
 *     has cut below the requested cursor answers 400 `invalid_cursor` with
 *     a re-baseline hint — mid-poll included, never a hang; a journal that
 *     has never recorded answers an empty feed, and the poller carries the
 *     bind warning naming the fix.
 *   - `last` is refused as 501 `not_supported`: this feed reads forward
 *     only.
 *
 * Filters (`channel`, `re`, `by`, `mentions`, `label`, `from`, `text`) run
 * against the message as it stands when the row is read, the protocol's
 * "matched before the event or after it" arm.
 *
 * Export shape: `createEventRoutes(deps)` builds the route bundle with zero
 * side effects — the orchestrator wires `events` into the backend's method
 * table and starts/stops `poller` with the backend's lifecycle.
 */
import {
  HttpError,
  type Backend,
  type BoardEventView,
  type Caller,
  type EventsPage,
  type MessageView,
} from "@vercel/board";
import type { BdEventsPage, BdJournalRecord } from "../bd/transport.ts";
import {
  createEventPoller,
  createEventTranslator,
  createMessageLoader,
  type AuthorLookup,
  type BdReadTransport,
  type EventPoller,
} from "../events/poller.ts";
import { decodeEventCursor, decodeMessageCursor, decodeOlderCursor } from "../model/cursors.ts";
import type { LabelsApi, MetadataCodec } from "../model/types.ts";

/** The protocol's long-poll ceiling, in seconds. */
const WAIT_CAP_SECONDS = 300;
const DEFAULT_CADENCE_MS = 500;

/** The parsed events query board() hands the backend, exactly as served. */
export type EventsInput = Parameters<Backend["events"]>[1];

export interface EventRouteTransport extends BdReadTransport {
  /** The typed journal read after an opaque seq cursor. */
  tailEvents(cursor: string): Promise<BdEventsPage>;
}

export interface EventRouteDeps {
  /** The bd transport: the only bd access this route gets. */
  transport: EventRouteTransport;
  codec: MetadataCodec;
  labels: LabelsApi;
  /** bd actor slug → the writer's identity card (the actor map). */
  authorFor?: AuthorLookup;
  /** Journal re-read cadence while a long-poll waits (ms). */
  cadenceMs?: number;
  /** How long a bare create may wait for its metadata (ms). */
  holdMs?: number;
}

/** The route bundle: the protocol method plus the consumer behind it. */
export interface EventRoutes {
  events: (
    caller: Caller,
    input: EventsInput,
    signal: AbortSignal,
  ) => Promise<EventsPage>;
  poller: EventPoller;
}

function invalidAfter(raw: string): HttpError {
  return new HttpError(
    400,
    "invalid_cursor",
    `after: ${JSON.stringify(raw)} is not an events cursor`,
    { hint: "pass the cursor a previous events page answered" },
  );
}

function channelMatches(channel: string, filter: string): boolean {
  if (filter.endsWith("/")) {
    // A subtree filter covers the channel itself and everything under it.
    return channel === filter.slice(0, -1) || channel.startsWith(filter);
  }
  return channel === filter;
}

/** The thread key an event's payload carries; every emitted type has one. */
function payloadThread(event: BoardEventView): string | undefined {
  if (event.type === "message.posted") return event.payload.thread;
  if (event.type === "message.edited") return event.payload.thread;
  if (event.type === "message.deleted") return event.payload.thread;
  if (event.type === "reaction.added") return event.payload.thread;
  if (event.type === "reaction.removed") return event.payload.thread;
  if (event.type === "labels.changed") return event.payload.thread;
  return undefined;
}

/** The writer an event's payload carries, or null for the types without one. */
function payloadBy(event: BoardEventView): MessageView["by"] | null {
  if (event.type === "message.posted") return event.payload.by;
  if (event.type === "message.edited") return event.payload.by;
  if (event.type === "message.deleted") return event.payload.by;
  if (event.type === "reaction.added") return event.payload.by;
  if (event.type === "reaction.removed") return event.payload.by;
  if (event.type === "labels.changed") return event.payload.by;
  return null;
}

function matchesFilters(event: BoardEventView, input: EventsInput): boolean {
  const message = event.message;
  if (input.channel !== undefined) {
    if (message === undefined) return false;
    if (!channelMatches(message.channel, input.channel)) return false;
  }
  if (input.re !== undefined && payloadThread(event) !== input.re) return false;
  if (input.by !== undefined) {
    const by = payloadBy(event);
    const matched =
      (by !== null && (by.actor === input.by || by.principal === input.by)) ||
      message?.author?.handle === input.by;
    if (!matched) return false;
  }
  if (input.mentions !== undefined && input.mentions !== "") {
    if (message === undefined) return false;
    const needle = `@${input.mentions.replace(/^@/, "").toLowerCase()}`;
    if (!message.text.toLowerCase().includes(needle)) return false;
  }
  if (input.from !== undefined) {
    if (message === undefined) return false;
    const matched =
      input.from === "board"
        ? message.from === null
        : message.from === input.from;
    if (!matched) return false;
  }
  if (input.text !== undefined && input.text !== "") {
    if (message === undefined) return false;
    if (!message.text.toLowerCase().includes(input.text.toLowerCase())) {
      return false;
    }
  }
  if (input.label !== undefined) {
    if (message === undefined) return false;
    for (const [key, values] of input.label) {
      const carried = message.labels[key];
      if (values === null) {
        if (carried === undefined) return false;
      } else if (!values.some((value) => carried === value)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Where a journal row's op places it on the feed, for anchor resolution: a
 * message's post is its create row, so reading "after this message" means
 * reading rows past that row's seq.
 */
export function createAnchorResolver(
  transport: EventRouteTransport,
  loadMessage: (issueId: string) => Promise<MessageView | null>,
): (raw: string) => Promise<string> {
  /** message id → the seq of its create row, once placed. */
  const postSeqs = new Map<string, number>();
  /** The newest journal seq the placement scan has already read. */
  let scanned = 0;

  /**
   * The seq a message's post sits at, found by scanning the journal for its
   * create row. A message whose create row is gone (a pruned journal) or was
   * never journaled re-baselines the feed to its start: the rows it wanted
   * may be gone too, and the retained ones are what this board can serve.
   */
  async function postSeqOf(issueId: string): Promise<string> {
    const cached = postSeqs.get(issueId);
    if (cached !== undefined) return String(cached);
    for (;;) {
      const page = await transport.tailEvents(String(scanned));
      if (page.kind === "disabled") break;
      if (page.kind === "truncated") {
        // Rows at or under the floor are gone; the survivors start just
        // above it, and the scan resumes from there.
        scanned = Math.max(scanned, page.floor);
        continue;
      }
      let matched: number | null = null;
      for (const row of page.events) {
        if (matched === null && row.op === "create" && row.issueId === issueId) {
          matched = row.seq;
        }
      }
      scanned = Math.max(scanned, Number(page.cursor));
      if (matched !== null) {
        postSeqs.set(issueId, matched);
        return String(matched);
      }
      if (Number(page.cursor) <= scanned && page.events.length === 0) break;
    }
    return "0";
  }

  /**
   * Resolve one `after` in either form the protocol takes: a journal seq, an
   * empty messages page's boundary (from the feed's start), or a message id
   * on this board (past its post). Anything else is a hostile cursor.
   */
  return async (raw: string): Promise<string> => {
    const asSeq = decodeEventCursor(raw);
    if (asSeq.ok) return String(asSeq.value);
    const asBoundary = decodeOlderCursor(raw);
    const id = asBoundary.ok ? asBoundary.value.id : raw;
    if (!asBoundary.ok) {
      const asMessage = decodeMessageCursor(raw);
      if (!asMessage.ok) throw invalidAfter(raw);
    }
    if (id === "0") return "0";
    if ((await loadMessage(id)) === null) throw invalidAfter(raw);
    return postSeqOf(id);
  };
}

export function createEventRoutes(deps: EventRouteDeps): EventRoutes {
  const cadenceMs = deps.cadenceMs ?? DEFAULT_CADENCE_MS;
  const loader = createMessageLoader(deps);
  const poller = createEventPoller({
    tail: (cursor) => deps.transport.tailEvents(cursor),
    loadMessage: loader,
    authorFor: deps.authorFor,
    cadenceMs,
    holdMs: deps.holdMs,
  });
  // The route classifies rows at the reading caller's own cursor, so it
  // keeps its own diff state; the poller keeps the backend's.
  const translator = createEventTranslator({
    loadMessage: loader,
    authorFor: deps.authorFor,
    holdMs: deps.holdMs,
  });
  const resolveAnchor = createAnchorResolver(deps.transport, loader);

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** One journal read, classified and filtered at the caller's cursor. */
  async function readPage(
    cursor: string,
    input: EventsInput,
  ): Promise<
    | { kind: "page"; events: BoardEventView[]; cursor: string }
    | { kind: "truncated"; floor: number; head: number | null }
    | { kind: "disabled" }
  > {
    const base = decodeEventCursor(cursor);
    if (!base.ok) throw invalidAfter(cursor);
    const page = await deps.transport.tailEvents(cursor);
    if (page.kind === "truncated") {
      return { kind: "truncated", floor: page.floor, head: page.head };
    }
    if (page.kind === "disabled") return { kind: "disabled" };
    const matched: BoardEventView[] = [];
    let advanced = base.value;
    for (const row of page.events) {
      if (row.seq <= advanced) continue;
      const outcome = await translator.translate(row);
      // A held row pins the cursor: a bare create may still become a post,
      // and the consumer must not skip past what it cannot yet classify.
      if (outcome.kind === "hold") break;
      advanced = row.seq;
      if (outcome.kind === "event" && matchesFilters(outcome.view, input)) {
        matched.push(outcome.view);
      }
    }
    return { kind: "page", events: matched, cursor: String(advanced) };
  }

  const events = async (
    _caller: Caller,
    input: EventsInput,
    signal: AbortSignal,
  ): Promise<EventsPage> => {
    if (input.last !== undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "this feed cannot be read from its end",
        { hint: "poll with `after` to follow the feed" },
      );
    }
    const requested = input.wait ?? 0;
    const waitMs =
      Math.min(Math.max(Math.floor(requested), 0), WAIT_CAP_SECONDS) * 1000;
    const deadline = Date.now() + waitMs;
    // Resolved lazily inside the loop so a bd hiccup during anchor
    // resolution retries on cadence like any other read; a hostile cursor
    // (an HttpError) throws at once and never waits.
    let cursor: string | null = null;

    for (;;) {
      if (signal.aborted || poller.status === "stopped") {
        return { events: [], cursor: cursor ?? input.after ?? poller.head() };
      }
      if (cursor === null) {
        try {
          cursor =
            input.after === undefined
              ? poller.head()
              : await resolveAnchor(input.after);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (Date.now() >= deadline) throw error;
          await sleep(Math.min(cadenceMs, deadline - Date.now()));
          continue;
        }
      }
      let page: Awaited<ReturnType<typeof readPage>>;
      try {
        page = await readPage(cursor, input);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // A failed read retries on cadence until the wait runs out: bd
        // pays engine startup per call, and one refusal is not fatal.
        if (Date.now() >= deadline) throw error;
        await sleep(Math.min(cadenceMs, deadline - Date.now()));
        continue;
      }
      if (page.kind === "truncated") {
        throw new HttpError(
          400,
          "invalid_cursor",
          `the events journal was truncated below ${JSON.stringify(cursor)}: records under seq ${page.floor} are gone`,
          {
            hint: "re-baseline: read the feed without `after` (or from its head) and continue from the cursor it answers",
          },
        );
      }
      if (page.kind === "disabled") {
        // A never-enabled journal is an empty feed, not an error, and the
        // poller carries the bind warning naming the fix. The read itself
        // behaves like an empty page, so a from-the-start long-poll still
        // waits for the first journaled write instead of answering early.
        page = { kind: "page", events: [], cursor };
      }
      if (page.events.length > 0) {
        return { events: page.events, cursor: page.cursor };
      }
      // A held row keeps the caller anchored: the page it belongs to is
      // decidable on a later read, so the wait continues from the same
      // cursor instead of skipping past it.
      cursor = page.cursor;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { events: [], cursor };
      // Early release when the poller sees journal movement; the cadence
      // sleep is the fallback when it is not running.
      await Promise.race([
        poller.waitBeyond(cursor, remaining, signal),
        sleep(Math.min(cadenceMs, remaining)),
      ]);
    }
  };

  return { events, poller };
}
