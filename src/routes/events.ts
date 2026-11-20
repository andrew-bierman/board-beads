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
 *   - Omitted `after` follows from the journal's true head at the read: the
 *     page answers the events that land from the call onward, never the
 *     history a lagging checkpoint would replay.
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
import {
  decodeEventCursor,
  decodeMessageCursor,
  decodeOlderCursor,
} from "../model/cursors.ts";
import type { LabelsApi, MetadataCodec } from "../model/types.ts";
import { guardBdRoute } from "./unavailable.ts";

/** The protocol's long-poll ceiling, in seconds. */
const WAIT_CAP_SECONDS = 300;
/**
 * The quiet wait's re-poll cadence, and how a held row's re-read spaces
 * itself. The running poller is the wake source for a waiting read, so
 * this bounds idle latency, not throughput — and every tick is a bd spawn
 * against the tracker's lock, so it stays at a spawn rate the full suite's
 * many live backends can sustain (the watchers matcher idles at 1s).
 */
const DEFAULT_CADENCE_MS = 1_000;
/**
 * The quiet wait's safety re-poll, for out-of-band journal mutation. The
 * poller only wakes a reader when rows are APPENDED; retention pruning cuts
 * rows away silently, and a reader parked past the cut would otherwise
 * lapse quiet instead of answering its re-baseline error. Once per wait
 * window (not once per cadence) — this bounds detection, not latency.
 */
const SAFETY_QUIET_REPOLL_MS = 30_000;

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

/** The typed re-baseline answer when retention has cut below a cursor. */
function truncatedAnswer(
  cursor: string,
  floor: number,
  head: number | null,
): HttpError {
  return new HttpError(
    400,
    "invalid_cursor",
    `the events journal was truncated below ${JSON.stringify(cursor)}: records under seq ${floor} are gone`,
    {
      hint: "re-baseline: read the feed without `after` (or from its head) and continue from the cursor it answers",
    },
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

function matchesFilters(
  event: BoardEventView,
  input: EventsInput,
  priorLabels?: MessageView["labels"],
): boolean {
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
    // Matched before the event or after it: a `board.task=ready` feed shows
    // the claim whose message left `ready`, and the readying whose message
    // arrived at it. A task state's event carries both, its prior labels
    // beside its message's own.
    const wanted = input.label;
    const matched = (labels: MessageView["labels"] | undefined): boolean => {
      if (labels === undefined) return false;
      for (const [key, values] of wanted) {
        const carried = labels[key];
        if (values === null) {
          if (carried === undefined) return false;
        } else if (!values.some((value) => carried === value)) {
          return false;
        }
      }
      return true;
    };
    if (!matched(message?.labels) && !matched(priorLabels)) return false;
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
        if (
          matched === null &&
          row.op === "create" &&
          row.issueId === issueId
        ) {
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
    // The read behind `loadMessage` swallows bd failures as nulls (the
    // enrichment contract), so one slow spawn must not read as a hostile
    // cursor: a well-formed poll would 400 on a hiccup. Retry briefly
    // before declaring the id names nothing — a cursor that names
    // nothing stays null across every attempt.
    for (let attempt = 0; ; attempt += 1) {
      if ((await loadMessage(id)) !== null) break;
      if (attempt >= 2) throw invalidAfter(raw);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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
    labels: deps.labels,
    cadenceMs,
    holdMs: deps.holdMs,
  });
  // The route classifies rows at the reading caller's own cursor, so it
  // keeps its own diff state; the poller keeps the backend's.
  const translator = createEventTranslator({
    loadMessage: loader,
    authorFor: deps.authorFor,
    labels: deps.labels,
    codec: deps.codec,
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
    | { kind: "page"; events: BoardEventView[]; cursor: string; held: boolean }
    | { kind: "truncated"; floor: number; head: number | null }
    | { kind: "disabled" }
  > {
    const base = decodeEventCursor(cursor);
    if (!base.ok) throw invalidAfter(cursor);
    const page = await deps.transport.tailEvents(cursor);
    // This read just proved the journal answers (a records page — an empty
    // one included). The loop tails independently and may still be saying
    // `disabled` off its own empty probe, so the fact travels: the status
    // is decided by what the journal has answered, not by who asked first.
    if (page.kind === "records") poller.noteAnswered();
    if (page.kind === "truncated") {
      return { kind: "truncated", floor: page.floor, head: page.head };
    }
    if (page.kind === "disabled") return { kind: "disabled" };
    const matched: BoardEventView[] = [];
    let advanced = base.value;
    let held = false;
    for (const row of page.events) {
      if (row.seq <= advanced) continue;
      const outcome = await translator.translate(row);
      // A held row pins the cursor: a bare create may still become a post,
      // and the consumer must not skip past what it cannot yet classify.
      if (outcome.kind === "hold") {
        held = true;
        break;
      }
      advanced = row.seq;
      if (outcome.kind !== "event") continue;
      // A task-only row's view IS its first task event: the feed serves it
      // from `taskEvents`, or the event would land on the page twice.
      if (
        outcome.viewIsTaskEvent !== true &&
        matchesFilters(
          outcome.view,
          input,
          outcome.taskEvents?.[0]?.priorLabels,
        )
      ) {
        matched.push(outcome.view);
      }
      for (const one of outcome.taskEvents ?? []) {
        if (matchesFilters(one.view, input, one.priorLabels)) {
          matched.push(one.view);
        }
      }
    }
    return { kind: "page", events: matched, cursor: String(advanced), held };
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
    /** The caller's own anchor, once resolved: what the probe re-checks. */
    let anchor: string | null = null;

    for (;;) {
      const status = poller.status;
      if (signal.aborted || status === "stopped") {
        return { events: [], cursor: cursor ?? input.after ?? poller.head() };
      }
      if (cursor === null) {
        try {
          if (input.after === undefined) {
            // An after-less read follows from the journal's own head right
            // now — not from wherever this consumer's checkpoint happens to
            // sit. Its answer is the events that land from this call
            // onward: a task created before the read is history, and a
            // checkpoint that lags (the loop idles when nobody waits) must
            // not turn that history into the page. One tail places the
            // anchor at the true head; the delivering read tails from it.
            const headPage = await deps.transport.tailEvents(poller.head());
            if (headPage.kind === "records") {
              poller.noteAnswered();
              cursor = headPage.cursor;
            } else {
              cursor = poller.head();
            }
          } else {
            cursor = await resolveAnchor(input.after);
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (Date.now() >= deadline) throw error;
          await sleep(Math.min(cadenceMs, deadline - Date.now()));
          continue;
        }
        anchor = cursor;
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
        throw truncatedAnswer(cursor, page.floor, page.head);
      }
      if (page.kind === "disabled") {
        // A never-enabled journal is an empty feed, not an error, and the
        // poller carries the bind warning naming the fix. The read itself
        // behaves like an empty page, so a from-the-start long-poll still
        // waits for the first journaled write instead of answering early.
        page = { kind: "page", events: [], cursor, held: false };
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
      // The running poller is the wake source: it tails the journal on its
      // own cadence and releases this read the moment the head moves past
      // the cursor, so a waiting read spends no bd reads of its own. The
      // cadence sleep is only the fallback — a poller that is not running
      // (or still placing its first checkpoint) — and the re-read a held
      // row wants stays on the cadence too, bounded by the hold window.
      // A quiet wait lapses on the slow safety re-poll instead: the poller
      // cannot wake anyone for a write that was PRUNED away, so the wait
      // must check for that out-of-band cut itself, once per window.
      const held = page.held || poller.status === "idle";
      const wake = poller.waitBeyond(cursor, remaining, signal);
      const woken = await (held
        ? Promise.race([wake, sleep(Math.min(cadenceMs, remaining))])
        : Promise.race([
            wake,
            sleep(Math.min(SAFETY_QUIET_REPOLL_MS, remaining)),
          ]));
      // The safety lapse (not a wake, not a stop) re-checks the caller's
      // own anchor: bd refuses a read below the retained window, and that
      // refusal is this poll's typed re-baseline answer. A real wake skips
      // it — the delivering read refuses on its own when the floor rose
      // past the cursor.
      if (
        !held &&
        !woken &&
        !signal.aborted &&
        poller.status !== "stopped" &&
        anchor !== null
      ) {
        try {
          const probed = await deps.transport.tailEvents(anchor);
          if (probed.kind === "truncated") {
            throw truncatedAnswer(anchor, probed.floor, probed.head);
          }
        } catch (error) {
          if (error instanceof HttpError) throw error;
          // Any other probe failure is a bd hiccup the next read retries.
        }
      }
    }
  };

  return {
    // A bd failure the route itself declines to classify (journal truncation
    // is already a typed 400 above) answers typed 503 `unavailable` here,
    // naming the fix — never a raw transport error after the wait.
    events: guardBdRoute(events),
    poller,
  };
}
