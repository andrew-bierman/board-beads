/**
 * The watchers routes: `watchers`, `register`, `matches`, `ack` — the pull
 * side of Board's watchers, matched backend-side over the journal consumer.
 *
 * How it works:
 *   - `register` replaces the principal's registration with compiled tails
 *     (each tail's filter flags are parsed here, backend-side, at register
 *     time, so a hostile tail is refused with its watcher named). At most 32
 *     watchers one registration holds. Wake-by-path and wake-by-url answer
 *     501 `no_wake_by_path` / `no_wake_by_url`: this board wakes nothing —
 *     its discovery deliberately omits `wake_by_path` — so every registrant
 *     pulls.
 *   - a consumer loop over the same journal the event feed reads (the
 *     transport's typed read, classified through the model's translator and
 *     loader) matches every live registration's compiled tails — and, for a
 *     registration with sync entries, the `@sync` watcher. Each match is
 *     leased at pull time for five minutes in persisted state (bd issues —
 *     a restart mid-lease keeps both the registration and the lease). One
 *     match per event per watcher. A restart starts at the head — what the
 *     previous process hadn't matched is dropped, as the watchers doc says —
 *     which is why this bundle runs its own loop instead of replaying the
 *     feed consumer's checkpoint from zero.
 *   - `matches` answers the caller's own runnable matches, one thread at a
 *     time and in order, long-polled up to `wait` seconds; 404
 *     `no_registration` without one.
 *   - `ack` clears a leased match by its lease token: done, `error` to retry
 *     later (given up after 5 tries), `skip` to drop. A spent or wrong lease
 *     is 409 `stale_lease`; an unknown or already-settled match is 404
 *     `no_match`.
 *   - a caller narrowed with `x-board-can` is refused all three writes and
 *     pulls with 403 `forbidden`: its principal's watchers are one
 *     registration, which its project runs.
 *
 * Export shape: `createWatcherRoutes({ store })` builds the route table
 * plus its lifecycle — the orchestrator spreads `routes` into the backend's
 * method table and calls `stop()` when the backend closes. The registration
 * and its matches persist through `src/state/persisted.ts`; nothing here is
 * memory-only.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  type BoardEventView,
  type Caller,
  type MatchView,
  type ProtocolMethods,
  type RegistrationView,
} from "@vercel/board";
import type { BoardStore } from "./threads.ts";
import {
  createMessageLoader,
  createEventTranslator,
  postedEvent,
  type AuthorLookup,
} from "../events/poller.ts";
import {
  createPersistedStore,
  routeCallerOf,
  type PersistedStore,
  type RouteCaller,
} from "../state/persisted.ts";
import type { JsonValue } from "../model/types.ts";
import type { BdJournalRecord } from "../bd/transport.ts";
import { createLabels } from "../model/labels.ts";
import { guardBdRoutes } from "./unavailable.ts";

/** How many watchers one registration may hold (the protocol's own bound). */
export const REGISTERED_WATCHERS_MAX: number = 32;
/** A pulled match is leased for five minutes. */
export const MATCH_LEASE_MS: number = 5 * 60_000;
/** Pull page size: what a read answers without a limit, and at most. */
const MATCHES_LIMIT_DEFAULT = 10;
const MATCHES_LIMIT_MAX = 50;
/** How long a pull may hold, in seconds (the protocol's own cap). */
const MATCHES_WAIT_CAP_SECONDS = 25;
/** Tries a match gets before an erroring run is given up on. */
const MATCH_TRIES_MAX = 5;
/** The journal re-read cadence of the matcher (ms): bd spawns cost engine startup, so this is not a hot loop. */
const POLL_CADENCE_MS = 1000;
/** How long a bare create may wait for its metadata in the matcher (ms). */
const MATCHER_HOLD_MS = 4000;
/**
 * How long a bare create may stay pending — unreadable as a message yet —
 * before the matcher gives up on it (ms), and how many may wait at once.
 * Outliving the hold many times over keeps a slow write from being
 * mistaken for a non-message; the caps keep a pathological journal from
 * growing the probe forever.
 */
const PENDING_WINDOW_MS = 60_000;
const PENDING_MAX = 64;

/** The route table this group answers. */
export type WatcherRouteTable = Pick<
  ProtocolMethods,
  "watchers" | "register" | "matches" | "ack"
>;

export interface WatcherRouteDeps {
  store: BoardStore;
  /** Journal re-read cadence for the matcher (ms); tests may tighten it. */
  cadenceMs?: number;
}

export interface WatcherRoutes {
  /** Spread into the backend's method table. */
  routes: WatcherRouteTable;
  /** Detach from the poller; call when the backend closes. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Tails: the expression a watcher watches, compiled once at register time.
// ---------------------------------------------------------------------------

/** A compiled tail: the filters it names, and whether receipts are wanted. */
interface CompiledTail {
  channel?: string;
  re?: string;
  by?: string;
  mentions?: string;
  from?: string;
  text?: string;
  /** Each `--label` flag: a name with the values it may carry, or null for "must be unset". */
  labels: [string, string[] | null][];
}

/**
 * Split a tail expression the way a shell would: whitespace separates,
 * quotes group, backslashes escape.
 */
function words(expression: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < expression.length) {
        i += 1;
        word = (word ?? "") + (expression[i] ?? "");
      } else word = (word ?? "") + char;
    } else if (/\s/.test(char)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (char === "\\" && i + 1 < expression.length) {
      i += 1;
      word = (word ?? "") + (expression[i] ?? "");
    } else word = (word ?? "") + char;
  }
  if (quote !== null) throw new Error(`unterminated ${quote}`);
  if (word !== null) out.push(word);
  return out;
}

const TAIL_FLAG_NAMES = new Set([
  "re",
  "by",
  "mentions",
  "label",
  "source",
  "text",
  "all",
]);

/** Parse one tail expression into its compiled filters. */
function compileTail(expression: string): CompiledTail {
  const tokens = words(expression);
  const compiled: CompiledTail = { labels: [] };
  let positional: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "--") break;
    if (!token.startsWith("--")) {
      if (positional !== null)
        throw new Error(`expected one channel, got a second: ${token}`);
      positional = token;
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    if (!TAIL_FLAG_NAMES.has(name)) throw new Error(`--${name} isn't a filter`);
    const take = (): string => {
      if (eq !== -1) return token.slice(eq + 1);
      const next = tokens[i + 1];
      if (next === undefined || (next.length > 1 && next.startsWith("-"))) {
        throw new Error(`--${name} needs a value`);
      }
      i += 1;
      return next;
    };
    if (name === "all") continue; // receipts: this feed carries none of its own
    const value = take();
    if (name === "label") {
      const at = value.indexOf("=");
      if (at === -1) compiled.labels.push([value, null]);
      else
        compiled.labels.push([
          value.slice(0, at),
          value.slice(at + 1).split(","),
        ]);
    } else if (name === "source") {
      compiled.from = value.replace(/^@/, "");
    } else if (name === "re") {
      compiled.re = value.replace(/^#/, "");
    } else if (name === "by") {
      compiled.by = value.replace(/^@/, "");
    } else if (name === "mentions") {
      const raw = value.replace(/^@/, "");
      if (raw === "me")
        throw new Error(`a watcher has no "me": use --mentions @handle`);
      compiled.mentions = raw;
    } else if (name === "text") {
      compiled.text = value;
    }
  }
  if (positional !== null) compiled.channel = positional;
  return compiled;
}

/** Whether a classified event matches a compiled tail. */
function tailMatches(tail: CompiledTail, event: BoardEventView): boolean {
  const message = event.message;
  if (tail.channel !== undefined) {
    if (message === undefined) return false;
    const channel = tail.channel;
    const matched = channel.endsWith("/")
      ? message.channel === channel.slice(0, -1) ||
        message.channel.startsWith(channel)
      : message.channel === channel;
    if (!matched) return false;
  }
  const thread =
    event.type === "message.posted" ||
    event.type === "message.edited" ||
    event.type === "message.deleted" ||
    event.type === "reaction.added" ||
    event.type === "reaction.removed" ||
    event.type === "labels.changed"
      ? event.payload.thread
      : undefined;
  if (tail.re !== undefined && thread !== tail.re) return false;
  const by = (event.payload as { by?: MessageViewBy }).by ?? null;
  if (tail.by !== undefined) {
    const handle = message?.author?.handle;
    const matched =
      (by !== null && (by.actor === tail.by || by.principal === tail.by)) ||
      handle === tail.by;
    if (!matched) return false;
  }
  if (tail.mentions !== undefined) {
    if (message === undefined) return false;
    const needle = `@${tail.mentions.toLowerCase()}`;
    if (!message.text.toLowerCase().includes(needle)) return false;
  }
  if (tail.from !== undefined) {
    if (message === undefined) return false;
    if (
      tail.from === "board" ? message.from !== null : message.from !== tail.from
    ) {
      return false;
    }
  }
  if (tail.text !== undefined) {
    if (message === undefined) return false;
    if (!message.text.toLowerCase().includes(tail.text.toLowerCase()))
      return false;
  }
  if (tail.labels.length > 0) {
    if (message === undefined) return false;
    for (const [name, wanted] of tail.labels) {
      const carried = message.labels[name];
      if (wanted === null) {
        if (carried !== undefined) return false;
      } else if (!wanted.some((value) => carried === value)) {
        return false;
      }
    }
  }
  return true;
}

type MessageViewBy = NonNullable<BoardEventView["message"]>["by"];

/** Every classified event type is a message change; a sync hears them all. */
const MESSAGE_EVENT_TYPES = new Set([
  "message.posted",
  "message.edited",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "labels.changed",
]);

/** The event's thread, whatever classified it. */
function eventThread(event: BoardEventView): string {
  if (event.message !== undefined) return event.message.thread;
  const payload = event.payload as { thread?: unknown };
  return typeof payload.thread === "string" ? payload.thread : "";
}

/**
 * Whether a journal row's own snapshot says it is one of this backend's
 * persisted-state documents (`src/state/persisted.ts` writes the state
 * markers atomically with the create), which no hold can ever turn into a
 * message: holding one would only pin matching behind it.
 */
function isStateDocRow(row: BdJournalRecord, namespace: string): boolean {
  let snapshot: unknown = row.issue;
  if (typeof snapshot === "string" && snapshot !== "") {
    try {
      snapshot = JSON.parse(snapshot) as unknown;
    } catch {
      return false;
    }
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    return false;
  let metadata: unknown = (snapshot as Record<string, unknown>).metadata;
  if (typeof metadata === "string" && metadata !== "") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      return false;
    }
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  )
    return false;
  const blob = metadata as Record<string, unknown>;
  return blob[`${namespace}.role`] === "state" && `${namespace}.v` in blob;
}

// ---------------------------------------------------------------------------
// The route group.
// ---------------------------------------------------------------------------

function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

function clampLimit(
  limit: number | undefined,
  fallback: number,
  max: number,
): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw badRequest(
      `limit must be a whole number of at least 1, got ${String(limit)}`,
    );
  }
  return Math.min(limit, max);
}

/** One registration's persisted payload, as the routes read it. */
interface RegistrationData {
  owner: string;
  watch: Record<string, { tail: string }>;
  compiled: Record<string, CompiledTail>;
  sync: { key: string; platform: string }[];
  hash: string;
  /** The journal seq the registration starts matching at. */
  since: string;
}

function asRegistration(
  data: Record<string, JsonValue>,
): RegistrationData | null {
  if (
    typeof data.owner !== "string" ||
    data.watch === null ||
    typeof data.watch !== "object" ||
    Array.isArray(data.watch) ||
    data.compiled === null ||
    typeof data.compiled !== "object" ||
    Array.isArray(data.compiled) ||
    !Array.isArray(data.sync) ||
    typeof data.hash !== "string" ||
    typeof data.since !== "string"
  ) {
    return null;
  }
  const sync: { key: string; platform: string }[] = [];
  for (const entry of data.sync) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const row = entry as Record<string, JsonValue>;
    if (typeof row.key !== "string" || typeof row.platform !== "string")
      return null;
    sync.push({ key: row.key, platform: row.platform });
  }
  return {
    owner: data.owner,
    watch: data.watch as unknown as RegistrationData["watch"],
    compiled: data.compiled as unknown as RegistrationData["compiled"],
    sync,
    hash: data.hash,
    since: data.since,
  };
}

function asMatchEvent(value: JsonValue): BoardEventView | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return value as unknown as BoardEventView;
}

/** The registration view a caller sees: nothing of the compiled internals. */
function viewOf(data: RegistrationData): RegistrationView {
  return {
    owner: data.owner,
    watch: Object.fromEntries(
      Object.entries(data.watch).map(([id, spec]) => [id, { tail: spec.tail }]),
    ) as RegistrationData["watch"],
    sync: data.sync.map((entry) => ({ ...entry })),
    hash: data.hash,
    url: null,
  };
}

export function createWatcherRoutes(deps: WatcherRouteDeps): WatcherRoutes {
  const store = deps.store;
  const state: PersistedStore = createPersistedStore(store);
  const principalKeyOf = (who: RouteCaller): string => who.principalId;

  /**
   * Every live registration. Cached in memory between reads: this process
   * is the tracker's only writer (the README's single-writer contract) and
   * registrations change only through this bundle's own register, which
   * invalidates. The matcher reads this once per classified event — a
   * fresh bd read per event would put the match behind a serial backlog
   * exactly when the box is busiest.
   */
  let registrationCache: { data: RegistrationData }[] | null = null;
  const registrations = async (): Promise<{ data: RegistrationData }[]> => {
    if (registrationCache !== null) return registrationCache;
    const out: { data: RegistrationData }[] = [];
    for (const record of await state.list("registration")) {
      const data = asRegistration(record.data);
      if (data !== null) out.push({ data });
    }
    registrationCache = out;
    return out;
  };

  /** Matches already created, per (owner|watcher|event cursor): one per event per watcher. */
  const issuedKeys = new Set<string>();
  let keysLoaded = false;
  const loadIssuedKeys = async (): Promise<void> => {
    if (keysLoaded) return;
    for (const record of await state.list("match")) {
      const key = record.data.dedupe;
      if (typeof key === "string") issuedKeys.add(key);
    }
    keysLoaded = true;
  };

  const matchView = (data: Record<string, JsonValue>): MatchView | null => {
    const event = asMatchEvent(data.event);
    if (
      typeof data.key !== "string" ||
      typeof data.watcher !== "string" ||
      typeof data.thread !== "string" ||
      typeof data.lease !== "string" ||
      typeof data.attempt !== "number" ||
      event === null
    ) {
      return null;
    }
    return {
      id: data.key,
      watcher: data.watcher,
      thread: data.thread,
      lease: data.lease,
      attempt: data.attempt,
      event,
    };
  };

  /** Create one match for a registration's watcher, unleased until a pull takes it. */
  const createMatch = async (
    owner: string,
    watcher: string,
    event: BoardEventView,
    dedupe: string,
  ): Promise<void> => {
    const id = `wm-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    await state.put("match", id, {
      owner,
      watcher,
      thread: eventThread(event),
      lease: "",
      until: null,
      attempt: 0,
      cursor: event.cursor,
      done: false,
      dedupe,
      event: event as unknown as JsonValue,
    });
  };

  // --- the matcher: its own consumer over the journal the feed reads ---
  //
  // It starts at the head (a restart drops what the previous process hadn't
  // matched, as the watchers doc says), so a fresh backend is matching
  // within a cadence instead of replaying every historical create.

  const loader = createMessageLoader({
    transport: store.transport,
    codec: store.codec,
    labels: createLabels({ namespace: store.codec.namespace }),
    authorFor: (slug) => store.authorForSlug(slug),
  });
  const translator = createEventTranslator({
    loadMessage: loader,
    authorFor: (slug) => store.authorForSlug(slug),
    holdMs: MATCHER_HOLD_MS,
  });
  const cadenceMs = deps.cadenceMs ?? POLL_CADENCE_MS;
  /** The classified checkpoint; null until the start-at-head probe ran. */
  let checkpoint: number | null = null;
  let started: Promise<void> | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  /** The matcher cycle in flight, if any: at most one runs at a time. */
  let pending: Promise<void> | null = null;
  /** Waiters a fresh match releases, for the long-poll. */
  const wakers = new Set<() => void>();
  /**
   * Bare creates waiting for their metadata, each with the row that named
   * it and when the matcher first pended it: a create the translator holds
   * no longer pins the checkpoint — later rows classify while it settles,
   * and each cycle gives it one as-now read until it reads as a message.
   */
  const pendingCreates = new Map<
    string,
    { row: BdJournalRecord; sinceMs: number }
  >();
  const authorFor: AuthorLookup = (slug) => store.authorForSlug(slug);

  const wake = (): void => {
    for (const fn of [...wakers]) fn();
    wakers.clear();
  };

  /**
   * The journal's true head, freshly read: the newest seq anything has
   * written, above whatever this matcher has chewed to. A registration
   * starts matching from here — "from now on" is the journal's now, not a
   * backlog this process hasn't caught up with.
   */
  const trueHead = async (): Promise<string> => {
    const page = await store.transport.tailEvents("0");
    if (page.kind === "records") return page.cursor;
    if (page.kind === "truncated") return String(Math.max(0, page.floor - 1));
    return "0"; // a journal that has never recorded
  };

  /** One matcher cycle, serialized: a call while one is in flight rides it. */
  const runCycle = (): Promise<void> => {
    if (pending !== null) return pending;
    pending = cycle().finally(() => {
      pending = null;
    });
    return pending;
  };

  const cycle = async (): Promise<void> => {
    if (checkpoint === null) {
      // Start at the head: one probe read places the checkpoint past
      // everything that happened before this process existed.
      checkpoint = Number(await trueHead());
      return;
    }
    const page = await store.transport.tailEvents(String(checkpoint));
    if (page.kind === "truncated") {
      checkpoint = Math.max(checkpoint, page.floor - 1);
      return;
    }
    if (page.kind === "disabled") return;
    for (const row of page.events) {
      if (row.seq <= checkpoint) continue;
      // This backend's own state documents are creates that will never be
      // messages: skip them on the spot instead of spending the hold — and
      // the checkpoint — on each one.
      if (row.op === "create" && isStateDocRow(row, store.codec.namespace)) {
        checkpoint = row.seq;
        continue;
      }
      const outcome = await translator.translate(row);
      if (outcome.kind === "hold") {
        // A bare create whose message isn't readable yet: keep it pending
        // and move the checkpoint past it. Holding the checkpoint here
        // would stall every match behind this one write; the probe below
        // settles the create the moment its metadata lands instead.
        pendingCreates.set(row.issueId, { row, sinceMs: Date.now() });
        checkpoint = Math.max(checkpoint, row.seq);
        continue;
      }
      checkpoint = Math.max(checkpoint, row.seq);
      if (outcome.kind === "event") {
        await matchAll(outcome.view);
      }
    }
    // Settle pending creates, oldest first: one as-now read each, until
    // the issue reads as a message (its posted event, at its create row's
    // cursor) or its window runs out. The window outlives the translator's
    // hold many times over so a slow write is never mistaken for a
    // non-message, and never grows without bound.
    if (pendingCreates.size === 0 || stopped) return;
    const owed = [...pendingCreates.values()].sort(
      (a, b) => a.row.seq - b.row.seq,
    );
    for (const one of owed) {
      if (stopped) return;
      const view = await loader(one.row.issueId);
      if (view !== null) {
        pendingCreates.delete(one.row.issueId);
        await matchAll(postedEvent(one.row, view, authorFor));
      } else if (
        Date.now() - one.sinceMs > PENDING_WINDOW_MS ||
        pendingCreates.size > PENDING_MAX
      ) {
        pendingCreates.delete(one.row.issueId);
      }
    }
  };

  const ensureStarted = (): Promise<void> => {
    if (started === null) {
      started = (async () => {
        await runCycle();
        if (stopped) return;
        timer = setInterval(() => {
          void runCycle().catch(() => undefined);
        }, cadenceMs);
        timer.unref?.();
      })();
      started.catch(() => {
        started = null;
      });
    }
    return started;
  };

  /** The poller's event handler: match every live registration's tails. */
  const matchAll = async (event: BoardEventView): Promise<void> => {
    try {
      await loadIssuedKeys();
      const seq = Number(event.cursor);
      for (const { data } of await registrations()) {
        if (!Number.isSafeInteger(seq) || seq <= Number(data.since)) continue;
        for (const [id, tail] of Object.entries(data.compiled)) {
          const dedupe = `${data.owner}|${id}|${event.cursor}`;
          if (issuedKeys.has(dedupe)) continue;
          if (tailMatches(tail, event)) {
            issuedKeys.add(dedupe);
            await createMatch(data.owner, id, event, dedupe);
          }
        }
        if (data.sync.length > 0 && MESSAGE_EVENT_TYPES.has(event.type)) {
          const dedupe = `${data.owner}|@sync|${event.cursor}`;
          if (!issuedKeys.has(dedupe)) {
            issuedKeys.add(dedupe);
            await createMatch(data.owner, "@sync", event, dedupe);
          }
        }
      }
      wake();
    } catch {
      // A failed match write retries on the event's next classification; the
      // consumer never crashes on one bad write.
    }
  };

  const routes: WatcherRouteTable = {
    /** Registrations: every one to a caller that manages everywhere, its own otherwise. */
    async watchers(caller: Caller) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      const all = await registrations();
      const visible = who.access.everywhere("manage")
        ? all
        : all.filter((one) => one.data.owner === who.principalId);
      return { watchers: visible.map((one) => viewOf(one.data)) };
    },

    /**
     * Register: replaces the principal's registration. Wake-by-path and
     * wake-by-url answer their 501s — this board wakes nothing, and its
     * discovery omits `wake_by_path` to say so.
     */
    async register(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      if (who.narrowed) {
        throw forbidden(
          "this token is narrowed with x-board-can: registering and running watchers is its project's job",
        );
      }
      const body = input as {
        path?: unknown;
        url?: unknown;
        branch?: unknown;
        watch?: unknown;
        sync?: unknown;
      };
      if (typeof body.path === "string" && body.path.length > 0) {
        throw new HttpError(
          501,
          "no_wake_by_path",
          "this board wakes nothing by path: pull your matches instead",
        );
      }
      if (typeof body.url === "string" && body.url.length > 0) {
        throw new HttpError(
          501,
          "no_wake_by_url",
          "this board wakes nothing by url: pull your matches instead",
        );
      }
      if (
        body.watch === null ||
        typeof body.watch !== "object" ||
        Array.isArray(body.watch)
      ) {
        throw badRequest("a registration needs a watch map");
      }
      const watch = body.watch as Record<string, { tail: string }>;
      const ids = Object.keys(watch);
      if (ids.length > REGISTERED_WATCHERS_MAX) {
        throw badRequest(
          `a registration holds at most ${REGISTERED_WATCHERS_MAX} watchers, got ${ids.length}`,
          "too_many_watchers",
        );
      }
      const compiled: Record<string, CompiledTail> = {};
      for (const [id, spec] of Object.entries(watch)) {
        if (id.length === 0 || id.length > 100) {
          throw badRequest(
            `watch ${JSON.stringify(id)}: the id is 1 to 100 characters`,
          );
        }
        if (
          spec === null ||
          typeof spec !== "object" ||
          typeof spec.tail !== "string"
        ) {
          throw badRequest(`watch ${id}: a tail is a string`);
        }
        if (spec.tail.length > 1000) {
          throw badRequest(`watch ${id}: the tail is 1000 characters at most`);
        }
        try {
          compiled[id] = compileTail(spec.tail);
        } catch (error) {
          throw badRequest(
            `watch ${id}: ${(error as Error).message}`,
            "invalid_tail",
          );
        }
      }
      const sync: { key: string; platform: string }[] = [];
      if (body.sync !== undefined && body.sync !== null) {
        if (!Array.isArray(body.sync))
          throw badRequest("sync entries are an array");
        for (const entry of body.sync) {
          if (entry === null || typeof entry !== "object") {
            throw badRequest("a sync entry is { key, platform }");
          }
          const row = entry as Record<string, unknown>;
          if (typeof row.key !== "string" || typeof row.platform !== "string") {
            throw badRequest("a sync entry is { key, platform }");
          }
          if (
            row.key.length === 0 ||
            row.key.length > 64 ||
            row.platform.length === 0 ||
            row.platform.length > 64
          ) {
            throw badRequest(
              "a sync entry's key and platform are 1 to 64 characters",
            );
          }
          sync.push({ key: row.key, platform: row.platform });
        }
        if (sync.length > 32)
          throw badRequest("at most 32 sync entries", "too_many_sync");
        if (!who.access.anywhere("sync")) {
          throw forbidden(
            "this token can't register a sync here: it needs sync",
          );
        }
      }
      // The registration matches events from now on: make sure the matcher
      // is live, then take the journal's true head as the start — not this
      // process's chewed checkpoint, which may sit behind a backlog and
      // would otherwise re-match history the registration never asked for.
      await ensureStarted();
      const since = await trueHead();
      const hash = createHash("sha256")
        .update(JSON.stringify({ watch, sync }))
        .digest("hex")
        .slice(0, 32);
      const data: RegistrationData = {
        owner: who.principalId,
        watch,
        compiled,
        sync,
        hash,
        since,
      };
      await state.put(
        "registration",
        principalKeyOf(who),
        data as unknown as Record<string, JsonValue>,
      );
      registrationCache = null;
      return viewOf(data);
    },

    /**
     * Pull: the caller's runnable matches, one thread at a time and in
     * order, each leased five minutes; long-polled up to `wait` seconds.
     */
    async matches(caller, input, signal) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      if (who.narrowed) {
        throw forbidden(
          "this token is narrowed with x-board-can: registering and running watchers is its project's job",
        );
      }
      const registration = await state.get("registration", principalKeyOf(who));
      if (registration === null) {
        throw new HttpError(
          404,
          "no_registration",
          "this token has no registration here",
        );
      }
      const limit = clampLimit(
        input.limit,
        MATCHES_LIMIT_DEFAULT,
        MATCHES_LIMIT_MAX,
      );
      const waitMs =
        Math.min(
          Math.max(Math.floor(input.wait ?? 0), 0),
          MATCHES_WAIT_CAP_SECONDS,
        ) * 1000;
      const deadline = Date.now() + waitMs;

      /** The runnable matches: unleased (or lease spent), one per thread, in order. */
      const pull = async (): Promise<MatchView[]> => {
        // One document read serves the whole pull: the live scan and the
        // pick walk read the same list.
        const listed = await state.list("match");
        const byKey = new Map<string, Record<string, JsonValue>>();
        const live: { key: string; cursor: number }[] = [];
        for (const record of listed) {
          byKey.set(record.key, record.data);
          const data = record.data;
          if (data.owner !== who.principalId) continue;
          if (data.done === true) continue;
          const until = typeof data.until === "number" ? data.until : 0;
          if (
            typeof data.lease === "string" &&
            data.lease !== "" &&
            until > Date.now()
          ) {
            continue; // leased to the current pull, until it runs out
          }
          live.push({
            key: record.key,
            cursor: typeof data.cursor === "number" ? data.cursor : 0,
          });
        }
        live.sort((a, b) => a.cursor - b.cursor);
        // One at a time per thread, oldest first, at most `limit`.
        const picked: string[] = [];
        const threads = new Set<string>();
        for (const one of live) {
          if (picked.length >= limit) break;
          const data = byKey.get(one.key);
          const view = data === undefined ? null : matchView(data);
          if (view === null) continue;
          if (threads.has(view.thread)) continue;
          threads.add(view.thread);
          picked.push(one.key);
        }
        if (picked.length === 0) return [];
        // One document write leases the whole pull.
        const token = randomUUID().replace(/-/g, "").slice(0, 32);
        const until = Date.now() + MATCH_LEASE_MS;
        const leased = await state.patchAll(
          "match",
          picked.map((key) => ({
            key,
            mutate: (data) => ({ ...data, lease: token, until }),
          })),
        );
        return leased
          .map((record) => matchView(record.data))
          .filter((one): one is MatchView => one !== null);
      };

      let first = true;
      for (;;) {
        if (signal?.aborted) return { matches: [] };
        // After the first (instant) pull, every empty pull drives one
        // matcher cycle before it waits: a match lands when its write
        // lands, not when the cadence next ticks.
        if (!first) await runCycle().catch(() => undefined);
        first = false;
        const picked = await pull();
        if (picked.length > 0) return { matches: picked };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { matches: [] };
        // A fresh match releases early; the cadence sleep is the fallback.
        await new Promise<void>((resolve) => {
          const release = () => {
            clearTimeout(timer);
            wakers.delete(release);
            resolve();
          };
          const timer = setTimeout(release, Math.min(cadenceMs, remaining));
          timer.unref?.();
          wakers.add(release);
        });
      }
    },

    /** Settle one leased match: done, an error to retry, or a skip to drop. */
    async ack(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      if (who.narrowed) {
        throw forbidden(
          "this token is narrowed with x-board-can: registering and running watchers is its project's job",
        );
      }
      await store.gate.run(`match:${input.id}`, () =>
        state.patch("match", input.id, (data) => {
          if (data.owner !== who.principalId) throw NO_MATCH(input.id);
          if (data.done === true) throw NO_MATCH(input.id);
          const until = typeof data.until === "number" ? data.until : 0;
          if (data.lease !== input.lease || until <= Date.now()) {
            throw new HttpError(
              409,
              "stale_lease",
              "that lease ran out, and the match was pulled again",
            );
          }
          if (input.skip === true)
            return { ...data, done: true, dropped: true, lease: "" };
          if (input.error !== undefined) {
            const attempt = typeof data.attempt === "number" ? data.attempt : 0;
            // Five tries and the match is given up on, as watch.failed is.
            if (attempt + 1 >= MATCH_TRIES_MAX)
              return { ...data, done: true, failed: true, lease: "" };
            return { ...data, lease: "", until: null, attempt: attempt + 1 };
          }
          return { ...data, done: true, lease: "" };
        }),
      );
      return { ok: true as const };
    },
  };

  function NO_MATCH(id: string): HttpError {
    return new HttpError(
      404,
      "no_match",
      `no match ${JSON.stringify(id)} is waiting`,
    );
  }

  // The matcher runs from bundle construction: a backend that never
  // registers still serves matches for registrations that persist from a
  // previous process, and its head is caught up by the time register reads it.
  void ensureStarted();

  return {
    routes: guardBdRoutes(routes),
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      wake();
    },
  };
}
