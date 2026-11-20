/**
 * The tasks routes: Board's task surface — the part agents actually work
 * through — mapped onto bd claims and leases. Everything here goes through
 * the transport (no bd process is ever spawned outside src/bd) and through
 * the model's metadata codec for every read-modify-write, serialized per
 * issue behind the backend's write gate.
 *
 * How a task maps onto bd:
 *   - a task is a thread whose root issue carries the backend's task record
 *     in its metadata blob (`<ns>.task`), beside the message metadata the
 *     threads routes own — bd merges metadata keys, so the two live side by
 *     side on one issue and neither clobbers the other;
 *   - the task's state is mirrored in the root's `board.task` label, Board's
 *     reserved namespace, which callers may never set (the model's label
 *     guard refuses it) and only task writes write;
 *   - a claim is bd's own atomic claim (`bd update --claim`, CAS by actor),
 *     plus the fencing state in the root's metadata: `epoch` (a per-issue
 *     counter) and `token` (a random secret, stored as its SHA-256, answered
 *     once at claim time). Every claim write re-verifies all three of
 *     epoch, token, and an unexpired lease before it lands, or answers
 *     409 `claim_lost`;
 *   - bd's lease TTL is never assumed: it is measured from the claim's own
 *     answer (`lease_expires_at − heartbeat_at`, ≈300s on bd 1.3.4), and the
 *     backend heartbeats at a third of the observed TTL while a Board lease
 *     outruns it. A Board lease that ends makes the task claimable at once —
 *     the timer flips the label and appends the expiry, and so does the next
 *     claim that finds a lapsed one;
 *   - release is bd's guarded unclaim (`--if-assignee`, a compare-and-set)
 *     plus the two-write reopen: bd's `--status open` alone leaves the
 *     assignee in place, so the unclaim clears the holder and a second write
 *     moves the record and label back to ready (or waiting, behind needs);
 *   - create/batch pre-validate every key, duplicate, and cycle before any
 *     write, so an invalid batch makes none of its tasks; a valid batch's
 *     creates land in one `bd batch` transaction, and each task's text and
 *     labels ride per-task single-op writes behind it (bd's batch grammar
 *     has no description or labels slots, and no way to name a create's id
 *     for a later dep line);
 *   - every task write stamps the move it made (`<ns>.move`, the feed's
 *     `task.*` events, each with the state it leaves the task in) beside the
 *     record, so the feed says what a write did however late its reader
 *     arrives — the write is the word, not a diff guessed from state the
 *     reader never saw;
 *   - `claimReadyTask` long-polls: one scan per wake, woken by the journal
 *     poller on any task-relevant write plus a slow 30s safety re-poll for
 *     out-of-band writers — never a fixed 1s bd list cadence. Races (bd
 *     exit 13 lost-guard or exit 1 "already claimed by") answer the loser
 *     409 `task_claimed` and offer it the next candidate inside the wait.
 *
 * Access: task reads hold to the caller's readability per channel (answered
 * as not-found); claim and creation need `label` where the task is; the
 * owner verbs — block, unblock, reopen, assign, needs, cancel — need the
 * task's owner (the profile that made it, or its principal as itself), or
 * `manage` in its channel for a caller the board resolved itself; a
 * deployment profile (`as(name)`) owns only its own tasks, whatever its
 * `can` says, and everyone else hears 403 `task_not_owned`.
 */
import {
  HttpError,
  type Caller,
  type MessageView,
  type Protocol,
  type ProtocolMethods,
} from "@vercel/board";
import { FULL_ACCESS, parseCan } from "@vercel/board/access";
import type { Access, Permission } from "@vercel/board/access";
import { deriveActorSlug } from "../model/actors.ts";
import type { BdResult } from "../bd/transport.ts";
import { createLabels } from "../model/labels.ts";
import { deriveTitle } from "../model/message.ts";
import { METADATA_BYTE_LIMIT, initialMessageMeta } from "../model/metadata.ts";
import type {
  BdIssue,
  JsonValue,
  LabelsApi,
  MessageAuthorIdentity,
  MessageMeta,
  MetadataCodec,
} from "../model/types.ts";
import type { BoardStore } from "./threads.ts";
import type { EventPoller } from "../events/poller.ts";
import {
  createLeaseTimers,
  probeLeaseTtl,
  ttlFromIssuePayload,
} from "../tasks/leases.ts";
import type { LeaseTimers } from "../tasks/leases.ts";
import {
  decodeTaskRecord,
  encodeTaskRecord,
  LEASE_CAP_S,
  leaseOutsideBand,
  LEASE_MIN_S,
  movePatch,
  newMoveNonce,
  projectTaskView,
  TASK_LABEL,
  type TaskMoveEntry,
  type TaskRecord,
  type TaskState,
} from "../tasks/record.ts";
import { createHash, randomBytes } from "node:crypto";

/** The protocol's long-poll ceiling, in seconds, and the safety re-poll. */
const WAIT_CAP_SECONDS = 300;
const SAFETY_REPOLL_MS = 30_000;

/** Leases: what a claim gets without asking. The accepted band lives with the record. */
const LEASE_DEFAULT_S = 900;

/** A task's own bounds, matching the protocol's reference board. */
const TASK_NEEDS_MAX = 20;
const TASK_BATCH_MAX = 100;
const NEEDS_WALK_MAX = 500;
const FROM_MAX = 32;
const TASK_NOTE_MAX = 1000;
const TASK_KIND_MAX = 64;
const TASK_KEY_MAX = 200;
const TASK_TEXT_MAX = 10_000;

/** An actor id is `<where it's from>:<who>`; a handle is anything else. */
const ACTOR_ID_PATTERN = /^[^\s:]+:\S+$/;
/** The profile part of an owner's actor id: one of its own word for an agent. */
const PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The open states a plain list answers; a lapsed claim reads as ready. */
const OPEN_STATES: readonly TaskState[] = [
  "waiting",
  "ready",
  "claimed",
  "blocked",
];

/** One bd list row, decoded tolerantly, with what tasks read. */
interface TaskRow {
  id: string;
  title: string;
  description: string | undefined;
  status: string;
  assignee: string | null;
  labels: string[];
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  seq: number;
}

/** A row that decodes as a task: its message metadata and its task record. */
interface TaskEntry {
  row: TaskRow;
  meta: MessageMeta;
  task: TaskRecord;
}

/** Who a caller is, normalized across board()'s two caller shapes. */
interface RouteIdentity {
  actorId: string;
  principalId: string;
  /** The profile it writes through, or null for itself. */
  profile: string | null;
  access: Access;
  handle: string;
  /**
   * Whether the board resolved this caller itself (a verified principal
   * with grants), as opposed to a deployment profile naming itself: only
   * the former's `manage` reaches past task ownership.
   */
  resolved: boolean;
  /** When its credential expires, for the author cards writes carry. */
  expiresAt: string | null;
  card: {
    actor: string;
    principal: string;
    profile: string | null;
    kind: string;
    handle: string;
    name: string;
    avatar: string | null;
  };
}

/** What one claim answers, once. */
interface TaskClaim {
  epoch: number;
  token: string;
  until: string;
}

export interface TaskRoutesDeps {
  /** The board store: transport, codec, write gate, persisted state. */
  store: BoardStore;
  /**
   * The journal poller, for waking claim scans: any journaled write moves
   * its head, and a waiting claim rescans as soon as it does. Without it
   * the safety re-poll still bounds the wait.
   */
  poller?: Pick<EventPoller, "waitBeyond" | "head">;
}

/** The wake surface a waiting claim scan uses. */
type Wake = NonNullable<TaskRoutesDeps["poller"]>;

// ---------------------------------------------------------------------------
// Protocol failure shorthands: every path answers Board's error shape.
// ---------------------------------------------------------------------------

function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function claimLost(id: string): HttpError {
  return conflict("claim_lost", `this claim on ${id} is over: claim it again`);
}

function taskClaimed(id: string, until: string | null): HttpError {
  return conflict(
    "task_claimed",
    until === null ? `${id} is claimed` : `${id} is claimed until ${until}`,
  );
}

function taskFinished(id: string, state: string): HttpError {
  return conflict("task_finished", `${id} is ${state}`);
}

function taskNotOwned(id: string, channel: string): HttpError {
  return new HttpError(
    403,
    "task_not_owned",
    `${id} is someone else's task: its owner as itself, the profile that made it, or manage in ${channel} changes it`,
  );
}

function invalidNeed(value: string, why: string): HttpError {
  return badRequest(`needs: ${JSON.stringify(value)} ${why}`, "invalid_needs");
}

function notATask(id: string): HttpError {
  return new HttpError(404, "not_a_task", `${id} isn't a task`);
}

function trackerFrozen(error: unknown): HttpError {
  const detail = error instanceof Error ? error.message : String(error);
  return new HttpError(
    503,
    "tracker_frozen",
    `the tracker is frozen for migration; try again when it lifts: ${detail}`,
  );
}

function internalAt(message: string): HttpError {
  return new HttpError(500, "internal", message);
}

// ---------------------------------------------------------------------------
// Identity: who a caller is, mirroring the threads routes' normalization.
// ---------------------------------------------------------------------------

function identityOf(caller: Caller): RouteIdentity {
  if ("identity" in caller) {
    const { principal, author, actor } = caller.identity;
    return {
      actorId: author.actor,
      principalId: author.principal,
      profile: author.profile,
      access: principal.access,
      handle: actor.handle,
      resolved: true,
      expiresAt:
        principal.expiresAt === undefined || principal.expiresAt === null
          ? null
          : principal.expiresAt.toISOString(),
      card: {
        // The bd actor slug the principal maps to (the mapIdentity
        // derivation), never the raw principal id: authorship reads back
        // through this card, so `by.actor` stays a valid BEADS_ACTOR shape.
        actor: deriveActorSlug(author.actor),
        principal: author.principal,
        profile: author.profile,
        kind: actor.kind,
        handle: actor.handle,
        name: actor.name,
        avatar: actor.avatar ?? null,
      },
    };
  }
  const actorId =
    caller.self === null ? "board:client" : `board:client:${caller.self}`;
  const access =
    caller.can === undefined
      ? FULL_ACCESS
      : FULL_ACCESS.narrow(parseCan(caller.can));
  return {
    actorId,
    principalId: actorId,
    profile: null,
    access,
    handle: caller.self ?? "client",
    resolved: false,
    expiresAt: null,
    card: {
      actor: actorId,
      principal: actorId,
      profile: null,
      kind: "deployment",
      handle: caller.self ?? "client",
      name: caller.self ?? "client",
      avatar: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Decoding: bd rows and metadata blobs, tolerant of everything hostile.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/** Decode one bd list row into what tasks read, or null. */
function decodeTaskRow(codec: MetadataCodec, raw: unknown): TaskRow | null {
  const row = asRecord(raw);
  if (row === null) return null;
  const id = row.id;
  if (typeof id !== "string" || id === "") return null;
  let metadata: unknown = row.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      metadata = undefined;
    }
  }
  let seq = 0;
  const blob = asRecord(metadata);
  if (blob !== null) {
    const carried = blob[`${codec.namespace}.seq`];
    if (typeof carried === "number" && Number.isSafeInteger(carried))
      seq = carried;
  }
  return {
    id,
    title: typeof row.title === "string" ? row.title : "",
    description:
      typeof row.description === "string" ? row.description : undefined,
    status: typeof row.status === "string" ? row.status : "",
    assignee:
      typeof row.assignee === "string" && row.assignee !== ""
        ? row.assignee
        : null,
    labels: Array.isArray(row.labels)
      ? row.labels.filter((entry): entry is string => typeof entry === "string")
      : [],
    metadata,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    seq,
  };
}

/** A task row as the threads routes build them, so views build from either. */
interface IssueRow {
  issue: BdIssue;
  labels: string[];
  seq: number;
  assignee: string | null;
}

/** A task row as the threads routes' IssueRow, so views build from either. */
function toIssueRow(row: TaskRow): IssueRow {
  const issue: BdIssue = {
    id: row.id,
    title: "",
    description: row.description ?? "",
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    created_by: row.createdBy,
    metadata: row.metadata,
  };
  return { issue, labels: row.labels, seq: row.seq, assignee: row.assignee };
}

// ---------------------------------------------------------------------------
// The route factory.
// ---------------------------------------------------------------------------

/**
 * The tasks routes, as one table the backend registry spreads in. The
 * factory takes the shared store (and, when the event feed's poller is
 * wired, that poller as the claim scans' wake source) and answers the 16
 * protocol task methods keyed as the registry expects.
 */
export function createTaskRoutes(
  deps: TaskRoutesDeps,
): Partial<ProtocolMethods> {
  const { store } = deps;
  const wake: Wake | null = deps.poller ?? null;
  const codec = store.codec;
  const ns = codec.namespace;
  const labels: LabelsApi = createLabels({ namespace: ns });
  const taskKey = `${ns}.task`;
  const batchKeyOf = (id: string): string => `${ns}.batch.${id}`;

  /** Board-side expiry timers, one per live claim. */
  const timers: LeaseTimers = createLeaseTimers((id, epoch) => {
    void expireByTimer(id, epoch).catch(() => undefined);
  });

  /** bd heartbeat keep-alives, at a third of the TTL each claim measured. */
  interface KeepAlive {
    slug: string;
    untilMs: number;
    ttlMs: number;
    timer: NodeJS.Timeout | undefined;
  }
  const keepAlives = new Map<string, KeepAlive>();

  function keepAliveKey(id: string, epoch: number): string {
    return `${id}:${epoch}`;
  }

  function stopKeepAlive(id: string, epoch: number): void {
    const alive = keepAlives.get(keepAliveKey(id, epoch));
    if (alive === undefined) return;
    if (alive.timer !== undefined) clearTimeout(alive.timer);
    keepAlives.delete(keepAliveKey(id, epoch));
  }

  /**
   * Keep bd's lease alive at a third of its observed TTL while the Board
   * lease outruns it. A heartbeat loss stops the chain quietly: the Board
   * fence still answers until its own end, and the claim's bd half lapses
   * on bd's clock — the documented weakness under out-of-band writers.
   */
  function startKeepAlive(
    id: string,
    epoch: number,
    slug: string,
    ttlMs: number,
    untilMs: number,
  ): void {
    stopKeepAlive(id, epoch);
    const alive: KeepAlive = { slug, untilMs, ttlMs, timer: undefined };
    keepAlives.set(keepAliveKey(id, epoch), alive);
    const beat = (): void => {
      if (Date.now() >= alive.untilMs - 1_000) {
        stopKeepAlive(id, epoch);
        return;
      }
      void store
        .run(["heartbeat", id, "--json"], alive.slug)
        .then(() => {
          if (keepAlives.get(keepAliveKey(id, epoch)) !== alive) return;
          alive.timer = setTimeout(beat, Math.max(250, alive.ttlMs / 3));
          alive.timer.unref?.();
        })
        .catch(() => {
          stopKeepAlive(id, epoch);
        });
    };
    alive.timer = setTimeout(beat, Math.max(250, alive.ttlMs / 3));
    alive.timer.unref?.();
  }

  /** The bd lease TTL this backend measures, probed at first use. */
  let measuredTtlMs: number | null = null;
  let ttlProbe: Promise<void> | null = null;
  function ensureTtlProbed(): void {
    if (ttlProbe === null) {
      ttlProbe = probeLeaseTtl({
        // The probe's throwaway issues never journal: their bare creates
        // would hold every feed read that walks over them (the journal
        // consumer pins an unclassifiable create), the same contract the
        // store's own probe runner keeps.
        run: (args) =>
          store.transport.run(args, { omitEnv: ["BD_EVENTS_JOURNAL"] }),
      })
        .then((result) => {
          if (result.ok) measuredTtlMs = result.value.ttlMs;
          // A failed probe is degradation, surfaced by the claims' own
          // per-claim measurements; nothing here is hardcoded to fall back on.
        })
        .catch(() => undefined);
    }
  }

  // -- reads ----------------------------------------------------------------

  async function rowsOf(args: string[]): Promise<TaskRow[]> {
    const result = await store.run([...args, "--json"]);
    const raws = Array.isArray(result.data)
      ? result.data
      : result.data === undefined || result.data === null
        ? []
        : [result.data];
    const decoded: TaskRow[] = [];
    for (const raw of raws) {
      const row = decodeTaskRow(codec, raw);
      if (row !== null) decoded.push(row);
    }
    return decoded;
  }

  /** The entry an id names, or null when it isn't a readable task. */
  async function taskEntryById(id: string): Promise<TaskEntry | null> {
    const found = await rowsOf(["list", "--all", "--id", id]);
    for (const row of found) {
      const entry = entryOfRow(row);
      if (entry !== null) return entry;
    }
    return null;
  }

  /** Every task on the board, corrupt records skipped (typed degradation). */
  async function scanTaskEntries(): Promise<TaskEntry[]> {
    const found = await rowsOf([
      "list",
      "--all",
      "--has-metadata-key",
      taskKey,
    ]);
    const entries: TaskEntry[] = [];
    for (const row of found) {
      const entry = entryOfRow(row);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /** The entries a set of ids names, in the ids' order; misses are null. */
  async function taskEntriesByIds(
    ids: readonly string[],
  ): Promise<(TaskEntry | null)[]> {
    if (ids.length === 0) return [];
    const found = await rowsOf([
      "list",
      "--all",
      "--id",
      [...new Set(ids)].join(","),
    ]);
    const byId = new Map<string, TaskEntry>();
    for (const row of found) {
      const entry = entryOfRow(row);
      if (entry !== null) byId.set(entry.row.id, entry);
    }
    return ids.map((id) => byId.get(id) ?? null);
  }

  /** Decode one row into a task entry, or null (absent, foreign, corrupt). */
  function entryOfRow(row: TaskRow): TaskEntry | null {
    const decoded = codec.decode(row.metadata);
    if (!decoded.ok || decoded.value.role !== "message") return null;
    const blob = asRecord(row.metadata);
    const rawTask = blob === null ? undefined : blob[taskKey];
    const record = decodeTaskRecord(rawTask);
    if (!record.ok) return null;
    return { row, meta: decoded.value, task: record.value };
  }

  /** The channel a task lives in, from its backend-owned bd label. */
  function channelOf(row: TaskRow): string {
    const prefix = `${ns}.channel=`;
    for (const label of row.labels) {
      if (label.startsWith(prefix)) return label.slice(prefix.length);
    }
    return "";
  }

  /** The board.task label a row carries, if any. */
  function taskLabelOf(row: TaskRow): string | null {
    const prefix = `${TASK_LABEL}=`;
    for (const label of row.labels) {
      if (label.startsWith(prefix)) return label;
    }
    return null;
  }

  // -- views ----------------------------------------------------------------

  /** The actor id a bd assignee slug writes as, per the persisted cards. */
  function actorForSlug(slug: string | null): string {
    if (slug === null) return "";
    return store.authorForSlug(slug)?.by.actor ?? slug;
  }

  /** The message view of a task's root, with the task attached. */
  function viewOf(entry: TaskEntry): MessageView {
    const view = store.view({ row: toIssueRow(entry.row), meta: entry.meta });
    if (!view.ok) {
      // A task entry always carries message metadata; this is a guard, not a path.
      throw internalAt(
        `the task at ${entry.row.id} stopped reading back as a message`,
      );
    }
    // The claim's holder reads through the assignee slug's own card, which
    // this row fetched from bd directly — the store view's projection has
    // no assignee on its row shape.
    const task = projectTaskView(
      entry.meta,
      entry.task,
      actorForSlug(entry.row.assignee) || null,
    );
    if (task !== null) view.value.task = task;
    return view.value;
  }

  /** Whether every task a record waits for has completed. */
  async function needsSatisfied(needs: readonly string[]): Promise<boolean> {
    if (needs.length === 0) return true;
    const found = await taskEntriesByIds(needs);
    return found.every((entry) => entry?.task.state === "completed");
  }

  // -- writes ---------------------------------------------------------------

  /** One bd update carrying a metadata patch and label moves together. */
  async function updateTask(
    id: string,
    actor: string,
    patch: Record<string, JsonValue>,
    moves?: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(patch), "utf8");
    if (bytes > METADATA_BYTE_LIMIT) {
      throw badRequest(
        `the task's metadata is too large to store (${bytes} > ${METADATA_BYTE_LIMIT} bytes)`,
        "metadata_too_large",
      );
    }
    const args = ["update", id, "--metadata", JSON.stringify(patch)];
    for (const label of moves?.add ?? []) args.push("--add-label", label);
    for (const label of moves?.remove ?? []) args.push("--remove-label", label);
    args.push("--json");
    await store.run(args, actor);
  }

  /** The label moves that re-point board.task at a state. */
  function stateMoves(
    row: TaskRow,
    state: TaskState,
  ): { add: string[]; remove: string[] } {
    const current = taskLabelOf(row);
    const next = `${TASK_LABEL}=${state}`;
    return {
      add: current === next ? [] : [next],
      remove: current === null || current === next ? [] : [current],
    };
  }

  /**
   * Land a task record (and any claim change) as one bd write. The caller
   * holds the issue's gate: this runs inside one, and the gate never nests.
   */
  async function writeTaskState(input: {
    id: string;
    actor: string;
    task: TaskRecord;
    claim?: MessageMeta["claim"] | null;
    epoch?: number;
    moves?: { add?: string[]; remove?: string[] };
  }): Promise<void> {
    const patch: Record<string, JsonValue> = {
      [taskKey]: encodeTaskRecord(input.task),
    };
    if (input.claim !== undefined) patch[`${ns}.claim`] = input.claim;
    if (input.epoch !== undefined) patch[`${ns}.epoch`] = input.epoch;
    await updateTask(input.id, input.actor, patch, input.moves);
  }

  /** Map a claim's asked-for lease onto milliseconds, within the bounds. */
  function leaseMs(seconds: number | undefined): number {
    const asked = seconds ?? LEASE_DEFAULT_S;
    const bounded = Math.min(
      Math.max(Math.floor(asked), LEASE_MIN_S),
      LEASE_CAP_S,
    );
    return bounded * 1000;
  }

  /**
   * A lease ask inside the board's band, or 400 before anything is read:
   * the floor and the cap are the protocol's, checked where the reference
   * board checks them — on the request's shape, ahead of the write.
   */
  function ensureLease(seconds: number | undefined): void {
    const problem = leaseOutsideBand(seconds);
    if (problem !== null) throw badRequest(problem);
  }

  /**
   * Clear a settled task's native blockers: the dep edges the batch wrote
   * (the task depends on each need) go when they say nothing anymore — a
   * bd close refuses on a blocked issue, and a satisfied edge blocks
   * nothing the record doesn't.
   */
  async function clearDeps(
    id: string,
    others: readonly string[],
    actor: string,
  ): Promise<void> {
    for (const other of others) {
      await store
        .run(["dep", "remove", id, other, "--json"], actor)
        .catch(() => undefined);
    }
  }

  /**
   * Stamp a write's move in a trailing bd write of its own. The stamp must
   * land after the write it names — bd journals a multi-part update as one
   * record per changed field, each snapshot carrying only the labels written
   * so far — so the record the feed reads the move from always wears the
   * write's whole labels, and the events it carries match on them.
   */
  async function stampMove(
    id: string,
    actor: string,
    events: TaskMoveEntry[],
  ): Promise<void> {
    await store.run(
      [
        "update",
        id,
        "--metadata",
        JSON.stringify(movePatch(codec, { n: newMoveNonce(), events })),
        "--json",
      ],
      actor,
    );
  }

  function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  function newToken(): string {
    return randomBytes(32).toString("base64url");
  }

  /** Whether a claim's lease has run out. */
  function lapsed(entry: TaskEntry, now: number): boolean {
    const claim = entry.meta.claim;
    return claim !== null && Date.parse(claim.until) <= now;
  }

  /** A task's state as claims and lists take it: a lapsed claim is ready. */
  function stateNow(entry: TaskEntry, now: number): TaskState {
    if (entry.task.state === "claimed" && lapsed(entry, now)) return "ready";
    return entry.task.state;
  }

  /** The claim fencing check: epoch, token, and an unexpired lease, or 409. */
  function fenced(
    entry: TaskEntry,
    proof: { epoch: number; token: string },
    now: number,
  ): void {
    const claim = entry.meta.claim;
    const live =
      entry.task.state === "claimed" &&
      claim !== null &&
      claim.epoch === proof.epoch &&
      Date.parse(claim.until) > now &&
      hashToken(proof.token) === claim.token;
    if (!live) throw claimLost(entry.row.id);
  }

  /**
   * Flip a lapsed claim: the task says ready (or waiting, behind needs), its
   * label follows, and bd's half of the claim is released by its guarded
   * unclaim. The journal rows the flip writes are the task.expired emission.
   */
  async function expireClaim(
    entry: TaskEntry,
    holderSlug: string | null,
  ): Promise<TaskEntry> {
    const id = entry.row.id;
    const epoch = entry.meta.claim?.epoch ?? 0;
    const satisfied = await needsSatisfied(entry.task.needs);
    const state: TaskState = satisfied ? "ready" : "waiting";
    if (holderSlug !== null) {
      await store
        .run(["unclaim", id, "--if-assignee", holderSlug, "--json"], holderSlug)
        .catch(() => undefined);
    }
    await writeTaskState({
      id,
      actor: store.systemActor,
      task: { ...entry.task, state },
      claim: null,
      epoch: entry.meta.epoch,
      moves: stateMoves(entry.row, state),
    });
    await stampMove(id, store.systemActor, [
      { type: "task.expired", state, from: "claimed" },
    ]);
    timers.cancel(id, epoch);
    stopKeepAlive(id, epoch);
    const fresh = await taskEntryById(id);
    return fresh ?? entry;
  }

  /** The timer's arm: flip a claim that is still lapsed at its end. */
  async function expireByTimer(id: string, epoch: number): Promise<void> {
    await store.gate.run(`issue:${id}`, async () => {
      const entry = await taskEntryById(id);
      if (entry === null) return;
      const claim = entry.meta.claim;
      if (
        entry.task.state !== "claimed" ||
        claim === null ||
        claim.epoch !== epoch
      )
        return;
      if (Date.parse(claim.until) > Date.now()) return;
      await expireClaim(entry, entry.row.assignee);
    });
  }

  /** The caller changes the task as its owner, or manage does. */
  function owns(identity: RouteIdentity, entry: TaskEntry): void {
    const channel = channelOf(entry.row);
    // A caller the board resolved itself (a verified principal with grants)
    // may change any task `manage` in the channel covers. A deployment
    // profile (`as(name)`) is its own principal beside every other: manage
    // is everyone's there, so ownership is the only title it holds.
    if (
      identity.resolved &&
      identity.access.can("manage" as Permission, channel)
    ) {
      return;
    }
    const madeIt =
      entry.task.owner === identity.principalId &&
      (identity.profile === null || entry.task.by === identity.actorId);
    const mayWrite =
      identity.access.can("post", channel) ||
      identity.access.can("label", channel);
    if (madeIt && mayWrite) return;
    throw taskNotOwned(entry.row.id, channel);
  }

  /** Refuse a claim of a task that can't be claimed now. */
  function claimable(
    entry: TaskEntry,
    identity: RouteIdentity,
    now: number,
  ): void {
    const id = entry.row.id;
    if (entry.task.state === "waiting") {
      throw conflict(
        "task_waiting",
        `${id} waits for ${entry.task.needs.map((need) => JSON.stringify(need)).join(", ") || "nothing"}`,
      );
    }
    if (entry.task.state === "blocked") {
      throw conflict(
        "task_blocked",
        `${id} is held for a person: ${entry.task.blocked?.reason ?? "no reason given"}`,
      );
    }
    if (
      entry.task.state === "completed" ||
      entry.task.state === "failed" ||
      entry.task.state === "canceled"
    ) {
      throw taskFinished(id, entry.task.state);
    }
    if (entry.task.for !== null) {
      const mine =
        entry.task.for === identity.actorId &&
        entry.task.owner === identity.principalId;
      if (!mine)
        throw conflict(
          "task_assigned",
          `${id} is assigned to ${entry.task.for}`,
        );
    }
    if (entry.task.state === "claimed" && !lapsed(entry, now)) {
      throw taskClaimed(id, entry.meta.claim?.until ?? null);
    }
  }

  /**
   * One claim of one task, as it stands: the bd-side atomic claim, then the
   * fencing metadata and label under the issue's gate. A lost race (exit 1
   * "already claimed by", exit 13 lost guard) answers { race: true }; in
   * `refusalsRace` mode (a queue scan) a refused candidate races too, so the
   * scan takes its next candidate, while a direct claim surfaces the exact
   * 409 the refusal carries.
   */
  async function claimOne(input: {
    identity: RouteIdentity;
    slug: string;
    entry: TaskEntry;
    leaseSeconds: number | undefined;
    token: string;
    refusalsRace?: boolean;
  }): Promise<
    { ok: true; entry: TaskEntry; claim: TaskClaim } | { ok: false; race: true }
  > {
    const { identity, slug } = input;
    const id = input.entry.row.id;
    const now = Date.now();
    try {
      let entry = input.entry;
      if (entry.task.state === "claimed" && lapsed(entry, now)) {
        await store.gate.run(`issue:${id}`, async () => {
          const fresh = await taskEntryById(id);
          if (fresh === null) throw notATask(id);
          if (fresh.task.state === "claimed" && lapsed(fresh, Date.now())) {
            await expireClaim(fresh, fresh.row.assignee);
          }
        });
        const expired = await taskEntryById(id);
        if (expired === null) throw notATask(id);
        entry = expired;
      }

      return await store.gate.run(`issue:${id}`, async () => {
        const fresh = await taskEntryById(id);
        if (fresh === null) throw notATask(id);
        claimable(fresh, identity, Date.now());

        // bd's atomic claim arbitrates the race: the loser's subprocess
        // exits 1 ("already claimed by") or 13 (lost guard).
        let claimed: BdResult;
        try {
          claimed = await store.run(["update", id, "--claim", "--json"], slug);
        } catch (error) {
          if (error instanceof Error && error.name === "BdFrozenError") {
            throw trackerFrozen(error);
          }
          if (
            error instanceof Error &&
            (error.name === "BdClaimRaceError" ||
              error.name === "BdLostGuardError")
          ) {
            return { ok: false as const, race: true as const };
          }
          throw error;
        }
        const ttl = ttlFromIssuePayload(claimed.data);
        const epoch = fresh.meta.epoch + 1;
        const until = new Date(
          Date.now() + leaseMs(input.leaseSeconds),
        ).toISOString();
        const claim: TaskClaim = { epoch, token: input.token, until };
        const state: TaskState = "claimed";
        await updateTask(
          id,
          slug,
          {
            [`${ns}.epoch`]: epoch,
            [`${ns}.claim`]: { epoch, token: hashToken(input.token), until },
            [taskKey]: encodeTaskRecord({ ...fresh.task, state }),
          },
          stateMoves(fresh.row, state),
        );
        await stampMove(id, slug, [
          { type: "task.claimed", state: "claimed", from: fresh.task.state },
        ]);
        timers.arm(id, epoch, Date.parse(until));
        const measured = ttl.ok ? ttl.value.ttlMs : measuredTtlMs;
        if (measured !== null && Date.parse(until) > Date.now() + measured) {
          startKeepAlive(id, epoch, slug, measured, Date.parse(until));
        }
        const updated = await taskEntryById(id);
        return { ok: true as const, entry: updated ?? fresh, claim };
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        if (input.refusalsRace) return { ok: false, race: true };
        if (
          error.code === "task_waiting" ||
          error.code === "task_blocked" ||
          error.code === "task_finished" ||
          error.code === "task_assigned" ||
          error.code === "task_claimed"
        ) {
          throw error;
        }
        return { ok: false, race: true };
      }
      throw error;
    }
  }

  /** The task refs a create or a needs change names, validated as new ones are. */
  async function resolveNeeds(
    identity: RouteIdentity,
    refs: readonly string[] | undefined,
    self: string | null,
  ): Promise<{ ids: string[]; completed: boolean }> {
    if ((refs?.length ?? 0) > TASK_NEEDS_MAX) {
      throw badRequest(
        `needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`,
        "invalid_needs",
      );
    }
    const named = new Map<string, string>();
    for (const value of refs ?? []) {
      if (typeof value !== "string" || value === "" || value.length > 200) {
        throw invalidNeed(String(value), "isn't a task");
      }
      if (self !== null && value === self) {
        throw invalidNeed(
          value,
          "is the task itself: it can't wait for itself",
        );
      }
      named.set(value, value);
    }
    if (named.size === 0) return { ids: [], completed: true };
    const found = await taskEntriesByIds([...named.keys()]);
    for (const [id, ref] of named) {
      const entry =
        found.find((one) => one !== null && one.row.id === id) ?? null;
      if (entry === null || !identity.access.readable(channelOf(entry.row))) {
        throw invalidNeed(ref, "isn't a task");
      }
      if (entry.task.state === "canceled") {
        throw invalidNeed(ref, "was canceled: it can never complete");
      }
    }
    const ids = [...named.keys()];
    const completed = found.every(
      (entry) => entry !== null && entry.task.state === "completed",
    );
    return { ids, completed };
  }

  /**
   * Refuse prerequisites that would make task `id` wait for itself, through
   * however many tasks, walking up to NEEDS_WALK_MAX behind the ones the
   * change adds. A task that completed and is readable ends its branch:
   * everything behind it has completed too.
   */
  async function ensureAcyclic(
    identity: RouteIdentity,
    id: string,
    added: readonly string[],
  ): Promise<void> {
    const from = new Map<string, string>(added.map((need) => [need, need]));
    let level = [...added];
    while (level.length > 0) {
      const found = await taskEntriesByIds(level);
      const next: string[] = [];
      for (const entry of found) {
        if (entry === null) continue;
        if (
          entry.task.state === "completed" &&
          identity.access.readable(channelOf(entry.row))
        ) {
          continue;
        }
        for (const need of entry.task.needs) {
          if (need === id) {
            throw invalidNeed(
              from.get(entry.row.id) ?? entry.row.id,
              `waits for ${JSON.stringify(id)} already: they would wait for each other`,
            );
          }
          if (from.has(need)) continue;
          from.set(need, from.get(entry.row.id) ?? entry.row.id);
          next.push(need);
        }
      }
      if (from.size > NEEDS_WALK_MAX) {
        throw invalidNeed(
          added[0] ?? "",
          `has more than ${NEEDS_WALK_MAX} tasks behind it and the others: too many to check that none waits for ${JSON.stringify(id)}`,
        );
      }
      level = next;
    }
  }

  /** The ready/waiting state a task lands in, given what it waits for. */
  async function settleState(
    needs: readonly string[],
    blocked: boolean,
  ): Promise<TaskState> {
    if (blocked) return "blocked";
    return (await needsSatisfied(needs)) ? "ready" : "waiting";
  }

  /**
   * The caller's own write under a client id, as a task create retries it:
   * a task root comes back as it stands; anything else that landed with the
   * id — a reply, a plain thread — is another write's, refused, and nothing
   * is made under it. Someone else's id is refused the same way, whatever
   * it landed with.
   */
  async function findOwnTaskWrite(
    identity: RouteIdentity,
    clientId: string,
  ): Promise<{ task: MessageView } | { conflict: true } | null> {
    const found = await store.rows([
      "list",
      "--has-metadata-key",
      `${ns}.client`,
    ]);
    for (const row of found) {
      const entry = await store.entryById(row.issue.id);
      if (entry === null || entry.meta.client !== clientId) continue;
      const author =
        store.authorForSlug(entry.row.issue.created_by ?? null)?.by ?? null;
      const wrote =
        author !== null &&
        author.principal === identity.principalId &&
        (identity.profile === null || author.actor === identity.actorId);
      if (!wrote) return { conflict: true };
      const record = decodeTaskRecord(
        asRecord(entry.row.issue.metadata)?.[taskKey],
      );
      if (!record.ok) return { conflict: true };
      const view = store.view(entry);
      if (!view.ok) return { conflict: true };
      return { task: view.value };
    }
    return null;
  }

  /** An assignee a task's owner may name: one of its own actor ids. */
  function ownActor(
    owner: string,
    actor: string | null | undefined,
  ): string | null {
    if (actor === undefined || actor === null) return null;
    if (
      actor.length > 200 ||
      !actor.startsWith(`${owner}+`) ||
      !PROFILE_PATTERN.test(actor.slice(owner.length + 1))
    ) {
      throw badRequest(
        `for: a task is assigned to one of its owner's profiles, ${JSON.stringify(owner)}+<profile>, got ${JSON.stringify(actor)}`,
      );
    }
    return actor;
  }

  /** A caller label this board refuses (Board's own, or ours). */
  function guardLabels(input: Record<string, string> | undefined): void {
    const guard = labels.guardCallerLabels(input ?? {});
    if (!guard.ok) {
      throw badRequest(
        guard.error.code === "reserved_label"
          ? `${JSON.stringify(guard.error.label)} is a reserved prefix: board.* is Board's, and ${ns}.* is this backend's`
          : `${JSON.stringify(guard.error.label)} isn't a label this board can store`,
        guard.error.code,
      );
    }
    for (const [name, value] of Object.entries(input ?? {})) {
      if (name.includes(",") || value.includes(",")) {
        throw badRequest(
          `${JSON.stringify(name)} isn't a label this board can store: bd splits labels on commas`,
          "invalid_label",
        );
      }
    }
  }

  /** The bd label strings a task's caller labels wear. */
  function callerLabelArgs(
    callerLabels: Record<string, string> | undefined,
  ): string[] {
    const args: string[] = [];
    for (const [name, value] of Object.entries(callerLabels ?? {})) {
      args.push(value === "" ? name : `${name}=${value}`);
    }
    return args.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Whether a task row's labels carry every named label condition. */
  function labelsMatch(
    row: TaskRow,
    conditions: readonly (readonly [string, string[] | null])[],
  ): boolean {
    return conditions.every(([name, values]) => {
      const carried = row.labels
        .filter((label) => label.startsWith(`${name}=`) || label === name)
        .map((label) => (label === name ? "" : label.slice(name.length + 1)));
      if (values === null) return carried.length > 0;
      return values.some((want) => carried.includes(want));
    });
  }

  /** The batch a request made before it, when the id names one. */
  interface BatchRecord {
    owner: string;
    request: string | null;
    channel: string;
    fingerprint: string;
    ids: string[];
  }

  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = asRecord(value);
    if (record === null) return JSON.stringify(value ?? null);
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",");
    return `{${body}}`;
  }

  async function readBatchRecord(id: string): Promise<BatchRecord | null> {
    const stateId = store.state().stateIssueId;
    if (stateId === null) return null;
    const row = await store.rowById(stateId);
    if (row === null) return null;
    const blob = asRecord(row.issue.metadata);
    const raw = blob === null ? undefined : blob[batchKeyOf(id)];
    const record = asRecord(raw);
    if (record === null) return null;
    if (
      typeof record.owner !== "string" ||
      typeof record.channel !== "string" ||
      typeof record.fingerprint !== "string" ||
      !Array.isArray(record.ids)
    ) {
      return null;
    }
    return {
      owner: record.owner,
      request: typeof record.request === "string" ? record.request : null,
      channel: record.channel,
      fingerprint: record.fingerprint,
      ids: record.ids.filter(
        (entry): entry is string => typeof entry === "string",
      ),
    };
  }

  async function saveBatchRecord(
    id: string,
    record: BatchRecord,
  ): Promise<void> {
    const stateId = store.state().stateIssueId;
    if (stateId === null) {
      throw internalAt(
        "the backend state issue is missing, so no batch can be named",
      );
    }
    await store.gate.run("state", async () => {
      await updateTask(stateId, store.systemActor, {
        [batchKeyOf(id)]: {
          owner: record.owner,
          request: record.request,
          channel: record.channel,
          fingerprint: record.fingerprint,
          ids: [...record.ids],
        },
      });
    });
  }

  /** The single-flight map for claim attempts: per candidate, per caller. */
  const inFlight = new Map<
    string,
    Promise<
      | { ok: true; entry: TaskEntry; claim: TaskClaim }
      | { ok: false; race: true }
    >
  >();

  function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending !== undefined) return pending;
    const started = run().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(
      key,
      started as unknown as Promise<
        | { ok: true; entry: TaskEntry; claim: TaskClaim }
        | { ok: false; race: true }
      >,
    );
    return started;
  }

  /** One claimReadyTask scan: claim the best candidate, or none. */
  async function claimNext(input: {
    identity: RouteIdentity;
    slug: string;
    channel: string;
    label: Record<string, string> | undefined;
    from: string[] | undefined;
    leaseSeconds: number | undefined;
    token: string;
  }): Promise<{ task: MessageView; claim: TaskClaim } | null> {
    const { identity } = input;
    const conditions: (readonly [string, string[]])[] = Object.entries(
      input.label ?? {},
    ).map(([name, value]) => [name, [value]]);
    const owners = new Set<string>([identity.principalId]);
    for (const value of input.from ?? []) {
      owners.add(value);
    }
    const subtree = input.channel.endsWith("/");
    const path = subtree ? input.channel.slice(0, -1) : input.channel;
    const inChannel = (channel: string): boolean =>
      subtree
        ? channel === path || channel.startsWith(`${path}/`)
        : channel === path;

    const entries = await scanTaskEntries();
    const now = Date.now();
    const candidates: { entry: TaskEntry; assigned: boolean }[] = [];
    for (const entry of entries) {
      const channel = channelOf(entry.row);
      if (!inChannel(channel)) continue;
      if (!identity.access.readable(channel)) continue;
      if (!identity.access.can("label", channel)) continue;
      if (!labelsMatch(entry.row, conditions)) continue;
      if (stateNow(entry, now) !== "ready") continue;
      const assignedToMe =
        entry.task.for !== null &&
        entry.task.for === identity.actorId &&
        entry.task.owner === identity.principalId;
      const inPool =
        entry.task.for === null &&
        entry.task.state !== "completed" &&
        entry.task.state !== "failed" &&
        entry.task.state !== "canceled" &&
        owners.has(entry.task.owner);
      if (assignedToMe) candidates.push({ entry, assigned: true });
      else if (inPool) candidates.push({ entry, assigned: false });
    }
    // Assigned-to-you first, then the pool, each oldest first.
    candidates.sort((a, b) => {
      if (a.assigned !== b.assigned) return a.assigned ? -1 : 1;
      if (a.entry.task.seq !== b.entry.task.seq)
        return a.entry.task.seq - b.entry.task.seq;
      return a.entry.row.id < b.entry.row.id ? -1 : 1;
    });

    for (const candidate of candidates) {
      const outcome = await singleFlight(
        `${candidate.entry.row.id}:${identity.principalId}`,
        () =>
          claimOne({
            identity,
            slug: input.slug,
            entry: candidate.entry,
            leaseSeconds: input.leaseSeconds,
            token: input.token,
            refusalsRace: true,
          }),
      );
      if (outcome.ok)
        return { task: viewOf(outcome.entry), claim: outcome.claim };
      // A race or a refusal: the next candidate, inside the same wait.
    }
    return null;
  }

  // -- the routes -----------------------------------------------------------

  return {
    /** Tasks the caller reads, oldest first, a page at a time. */
    async tasks(caller, query): Promise<Protocol["tasks"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const wanted = query.state ?? "open";
      if (query.latest && query.after !== undefined) {
        throw badRequest(
          "latest reads every task to find the last active: it takes no after",
        );
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
      const conditions: (readonly [string, string[] | null])[] = (
        query.label ?? []
      ).map((entry) => [entry[0], entry[1] === null ? null : [...entry[1]]]);

      const subtree = (query.channel ?? "").endsWith("/");
      const path = subtree
        ? (query.channel ?? "").slice(0, -1)
        : (query.channel ?? "");
      const inChannel = (channel: string): boolean => {
        if (query.channel === undefined) return true;
        return subtree
          ? channel === path || channel.startsWith(`${path}/`)
          : channel === path;
      };

      const entries = await scanTaskEntries();
      const now = Date.now();
      const owner = query.owner;
      const owners =
        owner === undefined
          ? null
          : new Set<string>(
              Object.values(store.state().assignments.principals).flatMap(
                (slug) => {
                  const card = store.authorForSlug(slug);
                  return card !== null && card.by.actor === owner
                    ? [card.by.principal, owner]
                    : [owner];
                },
              ),
            );
      const forName = query.for;
      const forActors =
        forName === undefined
          ? null
          : new Set<string>(
              Object.values(store.state().assignments.principals).flatMap(
                (slug) => {
                  const card = store.authorForSlug(slug);
                  return card !== null && card.by.actor === forName
                    ? [card.by.actor, forName]
                    : [forName];
                },
              ),
            );
      const matched = entries
        .filter((entry) => {
          const channel = channelOf(entry.row);
          if (!inChannel(channel)) return false;
          if (!identity.access.readable(channel)) return false;
          const state = stateNow(entry, now);
          if (wanted === "all") {
            /* every state */
          } else if (wanted === "open") {
            if (!OPEN_STATES.includes(state)) return false;
          } else if (wanted === "ready") {
            if (state !== "ready") return false;
          } else if (state !== wanted) {
            return false;
          }
          if (!labelsMatch(entry.row, conditions)) return false;
          if (query.by !== undefined) {
            const author = store.authorForSlug(entry.row.createdBy);
            const handle = author?.view.handle ?? "";
            if (author?.by.actor !== query.by && handle !== query.by)
              return false;
          }
          if (owners !== null && !owners.has(entry.task.owner)) return false;
          if (
            forActors !== null &&
            (entry.task.for === null || !forActors.has(entry.task.for))
          )
            return false;
          if (
            query.needs !== undefined &&
            !entry.task.needs.includes(query.needs)
          )
            return false;
          return true;
        })
        .sort((a, b) => {
          if (a.task.seq !== b.task.seq) return a.task.seq - b.task.seq;
          return a.row.id < b.row.id ? -1 : 1;
        });

      let windowed = matched;
      if (query.after !== undefined) {
        const cursor = await taskEntryById(query.after);
        const since = cursor?.task.seq;
        if (since === undefined) {
          throw badRequest(
            `${JSON.stringify(query.after)} isn't a cursor or a task on this board`,
            "invalid_cursor",
          );
        }
        windowed = matched.filter((entry) => entry.task.seq > since);
      }
      let page: TaskEntry[];
      let cursor: string;
      if (query.latest) {
        // The last active: each task's latest reply, or its root's creation;
        // a sort keeps ties as they came, in the order they were made.
        const activity = new Map<string, string>();
        for (const channel of new Set(
          windowed.map((entry) => channelOf(entry.row)),
        )) {
          for (const member of await store.channelEntries(channel)) {
            const at =
              member.row.issue.updated_at ?? member.row.issue.created_at ?? "";
            const known = activity.get(member.meta.thread);
            if (known === undefined || at > known)
              activity.set(member.meta.thread, at);
          }
        }
        const activeAt = (entry: TaskEntry): string =>
          activity.get(entry.row.id) ?? entry.row.createdAt;
        page = [...windowed]
          .sort((a, b) =>
            activeAt(a) < activeAt(b) ? -1 : activeAt(a) > activeAt(b) ? 1 : 0,
          )
          .slice(-limit);
        cursor = page.at(-1)?.row.id ?? "";
      } else {
        page = windowed.slice(0, limit);
        cursor = page.at(-1)?.row.id ?? "";
      }

      const summaries = await summarize(identity, page);
      return { tasks: summaries, cursor };
    },

    /** Starts a thread as a task, or makes a task of a thread that's there. */
    async createTask(caller, input): Promise<Protocol["createTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureLease(input.lease);
      guardLabels(input.labels);
      if ((input.text?.length ?? 0) > TASK_TEXT_MAX) {
        throw badRequest(
          "a task's text is at most 10,000 characters",
          "text_too_long",
        );
      }
      const assigned = ownActor(identity.principalId, input.for);
      const slug = await store.mapIdentity(identity);
      ensureTtlProbed();

      if (input.re !== undefined) {
        // Make a task of a thread that's there, as it is: `label` in its channel.
        const adoptId: string = input.re;
        const existing = await store.entryById(adoptId);
        if (existing === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${adoptId}`,
          );
        }
        const channel = existing.meta.channel;
        if (!identity.access.readable(channel)) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${adoptId}`,
          );
        }
        if (!identity.access.can("label", channel)) {
          throw new HttpError(
            403,
            "forbidden",
            `this caller can't label in ${channel}`,
          );
        }
        if (existing.meta.parent !== null) {
          throw badRequest(
            `${adoptId} is a reply: a task is a thread, so name its root`,
          );
        }
        if (existing.meta.deleted) {
          throw badRequest("message was deleted", "message_deleted");
        }
        const needs = await resolveNeeds(identity, input.needs, adoptId);
        const claims = input.claim === true;
        if (claims && needs.ids.length > 0 && !needs.completed) {
          throw conflict(
            "task_waiting",
            `${adoptId} would wait for ${needs.ids.map((id) => JSON.stringify(id)).join(", ")}: it wasn't made a task`,
          );
        }
        if (claims && assigned !== null && assigned !== identity.actorId) {
          throw conflict(
            "task_assigned",
            `${adoptId} would be assigned to ${assigned}: it wasn't made a task`,
          );
        }
        const seq = await store.nextSeq();
        const record: TaskRecord = {
          state: "ready",
          owner: identity.principalId,
          by: identity.actorId,
          for: assigned,
          needs: needs.ids,
          blocked: null,
          result: null,
          reason: null,
          seq,
        };
        let claim: TaskClaim | undefined;
        await store.gate.run(`issue:${adoptId}`, async () => {
          const fresh = await store.entryById(adoptId);
          if (fresh === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${adoptId}`,
            );
          }
          const row = await taskRowOfIssue(adoptId);
          if (row === null) throw notATask(adoptId);
          if (decodeTaskRecord(row.metadata[taskKey]).ok) {
            throw conflict("already_a_task", `${adoptId} is a task already`);
          }
          if (claims) {
            try {
              const claimed = await store.run(
                ["update", adoptId, "--claim", "--json"],
                slug,
              );
              const ttl = ttlFromIssuePayload(claimed.data);
              claim = {
                epoch: fresh.meta.epoch + 1,
                token: input.token ?? newToken(),
                until: new Date(
                  Date.now() + leaseMs(input.lease),
                ).toISOString(),
              };
              const measured = ttl.ok ? ttl.value.ttlMs : measuredTtlMs;
              if (
                measured !== null &&
                Date.parse(claim.until) > Date.now() + measured
              ) {
                startKeepAlive(
                  adoptId,
                  claim.epoch,
                  slug,
                  measured,
                  Date.parse(claim.until),
                );
              }
              record.state = "claimed";
              await updateTask(
                adoptId,
                slug,
                {
                  [taskKey]: encodeTaskRecord(record),
                  [`${ns}.epoch`]: claim.epoch,
                  [`${ns}.claim`]: {
                    epoch: claim.epoch,
                    token: hashToken(claim.token),
                    until: claim.until,
                  },
                },
                { add: [`${TASK_LABEL}=${record.state}`] },
              );
              await stampMove(adoptId, slug, [
                ...(needs.ids.length > 0
                  ? [
                      {
                        type: "task.created",
                        state: "waiting",
                      } as TaskMoveEntry,
                    ]
                  : [
                      { type: "task.created", state: "ready" } as TaskMoveEntry,
                    ]),
                ...(needs.ids.length > 0
                  ? [{ type: "task.ready", state: "ready" } as TaskMoveEntry]
                  : []),
                { type: "task.claimed", state: "claimed" },
              ]);
              timers.arm(adoptId, claim.epoch, Date.parse(claim.until));
              return;
            } catch (error) {
              if (
                error instanceof Error &&
                (error.name === "BdClaimRaceError" ||
                  error.name === "BdLostGuardError")
              ) {
                throw taskClaimed(adoptId, null);
              }
              if (error instanceof Error && error.name === "BdFrozenError")
                throw trackerFrozen(error);
              throw error;
            }
          }
          record.state = await settleState(needs.ids, false);
          await updateTask(
            adoptId,
            slug,
            { [taskKey]: encodeTaskRecord(record) },
            { add: [`${TASK_LABEL}=${record.state}`] },
          );
          await stampMove(adoptId, slug, [
            {
              type: "task.created",
              state: needs.ids.length > 0 ? "waiting" : "ready",
            },
            ...(needs.ids.length > 0 && record.state === "ready"
              ? [{ type: "task.ready", state: "ready" } as TaskMoveEntry]
              : []),
          ]);
        });
        const entry = await taskEntryById(adoptId);
        if (entry === null)
          throw internalAt("the task just made doesn't read back");
        return {
          task: viewOf(entry),
          ...(claim !== undefined ? { claim } : {}),
        };
      }

      // A new thread, started as a task.
      if (input.channel === undefined) {
        throw badRequest(
          "a task needs a channel and text for a new thread, or re for a thread that's there",
        );
      }
      const text = input.text ?? "";
      if (text.trim().length === 0) throw badRequest("message text is empty");
      const channel = input.channel;
      if (!identity.access.can("post", channel)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't post in ${channel}`,
        );
      }
      if (
        Object.keys(input.labels ?? {}).length > 0 &&
        !identity.access.can("label", channel)
      ) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't label in ${channel}`,
        );
      }
      const needs = await resolveNeeds(identity, input.needs, null);
      const claims = input.claim === true;
      if (claims && !identity.access.can("label", channel)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't label in ${channel}`,
        );
      }
      if (claims && needs.ids.length > 0 && !needs.completed) {
        throw conflict(
          "task_waiting",
          `the task would wait for ${needs.ids.map((id) => JSON.stringify(id)).join(", ")}: nothing was made`,
        );
      }
      if (claims && assigned !== null && assigned !== identity.actorId) {
        throw conflict(
          "task_assigned",
          `the task would be assigned to ${assigned}: nothing was made`,
        );
      }

      // One write per client id: the asks that race serialize here, and the
      // retry of a landed create is answered that task, making nothing.
      const run = async (): Promise<Protocol["createTask"]["output"]> => {
        if (input.id !== undefined) {
          const found = await findOwnTaskWrite(identity, input.id);
          if (found !== null) {
            if ("conflict" in found) {
              throw conflict(
                "duplicate_id",
                "that id was already used for a different write",
              );
            }
            return { task: found.task };
          }
        }
        return startNewThread();
      };

      /** The create itself: a new thread that is a task from its first read. */
      const startNewThread = async (): Promise<
        Protocol["createTask"]["output"]
      > => {
        const seq = await store.nextSeq();
        const created = await store.run(
          [
            "create",
            `--title=${deriveTitle(text)}`,
            `--description=${text}`,
            "--type=task",
            "--json",
          ],
          slug,
        );
        const id = createdIdOf(created);
        if (id === null)
          throw internalAt("bd create returned no issue id for the task");

        // The create row journals at once; the metadata write lands the task.
        const meta = initialMessageMeta({
          channel,
          thread: id,
          client: input.id ?? null,
          noSync: input.noSync ?? false,
        });
        const encoded = codec.encodeMessage(meta);
        if (!encoded.ok) {
          throw badRequest(
            `the task's metadata is too large to store (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
            "metadata_too_large",
          );
        }
        const record: TaskRecord = {
          state: needs.ids.length > 0 && !needs.completed ? "waiting" : "ready",
          owner: identity.principalId,
          by: identity.actorId,
          for: assigned,
          needs: needs.ids,
          blocked: null,
          result: null,
          reason: null,
          seq,
        };

        let claimPatch: Record<string, JsonValue> = {};
        let claim: TaskClaim | undefined;
        if (claims) {
          const claimed = await store.run(
            ["update", id, "--claim", "--json"],
            slug,
          );
          const ttl = ttlFromIssuePayload(claimed.data);
          claim = {
            epoch: 1,
            token: input.token ?? newToken(),
            until: new Date(Date.now() + leaseMs(input.lease)).toISOString(),
          };
          const measured = ttl.ok ? ttl.value.ttlMs : measuredTtlMs;
          if (
            measured !== null &&
            Date.parse(claim.until) > Date.now() + measured
          ) {
            startKeepAlive(
              id,
              claim.epoch,
              slug,
              measured,
              Date.parse(claim.until),
            );
          }
          claimPatch = {
            [`${ns}.epoch`]: claim.epoch,
            [`${ns}.claim`]: {
              epoch: claim.epoch,
              token: hashToken(claim.token),
              until: claim.until,
            },
          };
          record.state = "claimed";
        }

        const addLabels = [
          `${ns}.channel=${channel}`,
          `${ns}.root`,
          `${TASK_LABEL}=${record.state}`,
          ...callerLabelArgs(input.labels),
        ];
        // What making this task says, as its events: it waits while it
        // names needs, is ready in the same write once they've completed,
        // and claimed after when the write claimed it.
        const startEvents: TaskMoveEntry[] = [
          {
            type: "task.created",
            state: needs.ids.length > 0 ? "waiting" : "ready",
          },
        ];
        if (needs.ids.length > 0 && record.state !== "waiting") {
          startEvents.push({ type: "task.ready", state: "ready" });
        }
        if (record.state === "claimed") {
          startEvents.push({ type: "task.claimed", state: "claimed" });
        }
        const blob: Record<string, JsonValue> = {
          ...encoded.value,
          [`${ns}.seq`]: seq,
          [taskKey]: encodeTaskRecord(record),
          ...claimPatch,
        };
        await store.run(
          [
            "update",
            id,
            "--metadata",
            JSON.stringify(blob),
            ...addLabels.flatMap((label) => ["--add-label", label]),
            "--json",
          ],
          slug,
        );
        await stampMove(id, slug, startEvents);
        if (claim !== undefined)
          timers.arm(id, claim.epoch, Date.parse(claim.until));
        const entry = await taskEntryById(id);
        if (entry === null)
          throw internalAt("the task just created doesn't read back");
        const made = viewOf(entry);
        return {
          task: made,
          ...(claim !== undefined ? { claim } : {}),
        };
      };
      return input.id !== undefined
        ? store.gate.run(`client:${input.id}`, run)
        : run();
    },

    /** Several new threads in one channel, each a task, all or none. */
    async createTasks(
      caller,
      input,
    ): Promise<Protocol["createTasks"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const channel = input.channel;
      if (!identity.access.can("post", channel)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't post in ${channel}`,
        );
      }
      const hasLabels = input.tasks.some(
        (task) => Object.keys(task.labels ?? {}).length > 0,
      );
      if (hasLabels && !identity.access.can("label", channel)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't label in ${channel}`,
        );
      }
      for (const task of input.tasks) guardLabels(task.labels);

      // Idempotency first: the id names the batch it made, or this is a new one.
      const fingerprint = canonical({ channel, tasks: input.tasks });
      if (input.id !== undefined) {
        const prior = await readBatchRecord(input.id);
        if (prior !== null) {
          const same =
            prior.owner === identity.principalId &&
            prior.channel === channel &&
            (input.request !== undefined
              ? prior.request === input.request
              : prior.fingerprint === fingerprint);
          if (!same)
            throw conflict(
              "duplicate_id",
              `a batch was already made under ${JSON.stringify(input.id)}`,
            );
          const found = await taskEntriesByIds(prior.ids);
          const views: MessageView[] = [];
          for (const entry of found) {
            if (entry === null) continue;
            views.push(viewOf(entry));
          }
          return { tasks: views };
        }
      }

      // Pre-validate everything: an invalid batch makes none of its tasks.
      if (input.tasks.length < 1 || input.tasks.length > TASK_BATCH_MAX) {
        throw badRequest(
          `tasks: a batch makes 1 to ${TASK_BATCH_MAX} tasks, got ${input.tasks.length}`,
          "batch_too_large",
        );
      }
      const keys = new Map<string, number>();
      for (const [at, task] of input.tasks.entries()) {
        if (task.key !== undefined) {
          if (task.key.length > TASK_KEY_MAX) {
            throw invalidNeed(
              task.key,
              "is too long to name a task of the batch",
            );
          }
          const held = keys.get(task.key);
          if (held !== undefined) {
            throw invalidNeed(
              task.key,
              `is a key two of the batch's tasks have (tasks ${held + 1} and ${at + 1})`,
            );
          }
          keys.set(task.key, at);
        }
        if ((task.text ?? "").length > TASK_TEXT_MAX) {
          throw badRequest(
            "a task's text is at most 10,000 characters",
            "text_too_long",
          );
        }
        if ((task.needs?.length ?? 0) > TASK_NEEDS_MAX) {
          throw badRequest(
            `needs: a task waits for at most ${TASK_NEEDS_MAX} tasks`,
            "invalid_needs",
          );
        }
      }
      // Resolve needs: a string that is a batch key is that task; else an id out here.
      const inside = input.tasks.map((task, at) => {
        const refs: { at: number }[] = [];
        const outside: string[] = [];
        for (const need of task.needs ?? []) {
          if (typeof need === "string") {
            const named = keys.get(need);
            if (named !== undefined) {
              if (named === at) {
                throw invalidNeed(
                  need,
                  "is the task itself: it can't wait for itself",
                );
              }
              refs.push({ at: named });
            } else {
              outside.push(need);
            }
          } else {
            const named = keys.get(need.key);
            if (named === undefined)
              throw invalidNeed(need.key, "is a key no task of the batch has");
            if (named === at)
              throw invalidNeed(
                need.key,
                "is the task itself: it can't wait for itself",
              );
            refs.push({ at: named });
          }
        }
        return { refs, outside };
      });
      // Cycles among the batch's own, before anything is written.
      {
        const waitsFor = inside.map((plan) => plan.refs.map((one) => one.at));
        const settled = new Set<number>();
        const visit = (at: number, stack: Set<number>): void => {
          if (stack.has(at)) {
            throw invalidNeed(
              input.tasks[at]?.key ?? `task ${at + 1}`,
              "waits for itself, through the batch's others",
            );
          }
          if (settled.has(at)) return;
          settled.add(at);
          const next = new Set(stack);
          next.add(at);
          for (const dep of waitsFor[at] ?? []) visit(dep, next);
        };
        for (const at of input.tasks.keys()) visit(at, new Set());
      }
      const outsideIds = [...new Set(inside.flatMap((plan) => plan.outside))];
      const outsideFound = await taskEntriesByIds(outsideIds);
      for (const plan of inside) {
        for (const ref of plan.outside) {
          const entry =
            outsideFound.find((one) => one !== null && one.row.id === ref) ??
            null;
          if (
            entry === null ||
            !identity.access.readable(channelOf(entry.row))
          ) {
            throw invalidNeed(ref, "isn't a task");
          }
          if (entry.task.state === "canceled") {
            throw invalidNeed(ref, "was canceled: it can never complete");
          }
        }
      }

      // One transaction carries every create: the ids are bd's to hand out.
      const batchOps = input.tasks.map((task) => ({
        op: "create" as const,
        type: "task",
        priority: 2,
        title: deriveTitle(task.text ?? ""),
      }));
      const batch = await store.transport.batch(batchOps);
      const createdIds = batch.results
        .filter((one) => one.op === "create")
        .map((one) => one.target);
      if (createdIds.length !== input.tasks.length) {
        throw internalAt(
          `bd batch made ${createdIds.length} of ${input.tasks.length} tasks; refusing to continue half-made`,
        );
      }

      // Each task's text, metadata, and labels ride a single-op write.
      const ids: string[] = [];
      const views: MessageView[] = [];
      for (const [at, task] of input.tasks.entries()) {
        const id = createdIds[at] ?? "";
        const seq = await store.nextSeq();
        const outsideNeeds = inside[at]?.outside ?? [];
        const insideNeeds = (inside[at]?.refs ?? []).map(
          (one) => createdIds[one.at] ?? "",
        );
        const outsideEntries = await taskEntriesByIds(outsideNeeds);
        // Ready only when every need it waits for has completed, and the
        // batch's others count as never-completed: they were just made.
        const satisfied =
          insideNeeds.length === 0 &&
          outsideEntries.every(
            (entry) => entry !== null && entry.task.state === "completed",
          );
        const record: TaskRecord = {
          state:
            insideNeeds.length + outsideNeeds.length > 0 && !satisfied
              ? "waiting"
              : "ready",
          owner: identity.principalId,
          by: identity.actorId,
          for: ownActor(identity.principalId, task.for),
          needs: [...insideNeeds, ...outsideNeeds],
          blocked: null,
          result: null,
          reason: null,
          seq,
        };
        const meta = initialMessageMeta({
          channel,
          thread: id,
          client: null,
          noSync: task.noSync ?? false,
        });
        const encoded = codec.encodeMessage(meta);
        if (!encoded.ok) {
          throw badRequest(
            `a batched task's metadata is too large to store (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
            "metadata_too_large",
          );
        }
        const blob: Record<string, JsonValue> = {
          ...encoded.value,
          [`${ns}.seq`]: seq,
          [taskKey]: encodeTaskRecord(record),
        };
        const addLabels = [
          `${ns}.channel=${channel}`,
          `${ns}.root`,
          `${TASK_LABEL}=${record.state}`,
          ...callerLabelArgs(task.labels),
        ];
        await store.run(
          [
            "update",
            id,
            `--description=${task.text ?? ""}`,
            "--metadata",
            JSON.stringify(blob),
            ...addLabels.flatMap((label) => ["--add-label", label]),
            "--json",
          ],
          slug,
        );
        await stampMove(id, slug, [
          {
            type: "task.created",
            state: record.state === "waiting" ? "waiting" : "ready",
          },
          ...(record.state === "ready" && record.needs.length > 0
            ? [{ type: "task.ready", state: "ready" } as TaskMoveEntry]
            : []),
        ]);
        // The needs' edges, native: what the task waits for blocks it — the
        // task depends on its need, so bd's blocker sits on the task.
        for (const need of record.needs) {
          await store
            .run(["dep", "add", id, need], slug)
            .catch(() => undefined);
        }
        ids.push(id);
        const entry = await taskEntryById(id);
        if (entry !== null) views.push(viewOf(entry));
      }

      if (input.id !== undefined) {
        await saveBatchRecord(input.id, {
          owner: identity.principalId,
          request: input.request ?? null,
          channel,
          fingerprint,
          ids,
        });
      }
      return { tasks: views };
    },

    /** The caller's own batch made under an id, its tasks as they are now. */
    async createdTasks(
      caller,
      input,
    ): Promise<Protocol["createdTasks"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const record = await readBatchRecord(input.id);
      if (record === null || record.owner !== identity.principalId) {
        throw new HttpError(
          404,
          "batch_not_found",
          `no batch of yours was made under ${JSON.stringify(input.id)}`,
        );
      }
      if (input.request !== undefined && record.request !== input.request) {
        throw conflict(
          "duplicate_id",
          `the batch under ${JSON.stringify(input.id)} was made for another request`,
        );
      }
      const found = await taskEntriesByIds(record.ids);
      const views: MessageView[] = [];
      for (const entry of found) {
        if (entry === null) continue;
        views.push(viewOf(entry));
      }
      return { tasks: views };
    },

    /** Claims the oldest ready task in a channel or subtree, waiting for one. */
    async claimReadyTask(
      caller,
      input,
      signal,
    ): Promise<Protocol["claimReadyTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureLease(input.lease);
      const slug = await store.mapIdentity(identity);
      ensureTtlProbed();
      const subtree = input.channel.endsWith("/");
      const path = subtree ? input.channel.slice(0, -1) : input.channel;
      if (subtree) {
        if (!identity.access.anywhere("label")) {
          throw new HttpError(
            403,
            "forbidden",
            "this caller can't label anywhere, so it can't claim a task",
          );
        }
      } else if (!identity.access.can("label", path)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't label in ${path}`,
        );
      }
      const from: string[] = [];
      for (const value of input.from ?? []) {
        if (!ACTOR_ID_PATTERN.test(value)) {
          throw badRequest(
            `from: ${JSON.stringify(value)} is a handle, which several can share: name the owner by ID`,
            "invalid_from",
          );
        }
        from.push(value);
      }
      if (from.length > FROM_MAX) {
        throw badRequest(
          `from: a claim takes tasks from at most ${FROM_MAX} owners`,
        );
      }
      const token = input.token ?? newToken();
      const waitMs =
        Math.min(Math.max(Math.floor(input.wait ?? 0), 0), WAIT_CAP_SECONDS) *
        1000;
      const deadline = Date.now() + waitMs;

      for (;;) {
        if (signal?.aborted) return { task: null };
        const got = await claimNext({
          identity,
          slug,
          channel: input.channel,
          label: input.label,
          from,
          leaseSeconds: input.lease,
          token,
        });
        if (got !== null) return got;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { task: null };
        // One scan per wake: the poller moves on any journaled write; the
        // slow safety re-poll bounds out-of-band writes; abort cuts it short.
        const cursor = wake?.head() ?? "0";
        const safety = new Promise<false>((resolve) => {
          const timer = setTimeout(
            () => resolve(false),
            Math.min(SAFETY_REPOLL_MS, remaining),
          );
          timer.unref?.();
        });
        const woken =
          wake !== null
            ? wake.waitBeyond(
                cursor,
                Math.min(SAFETY_REPOLL_MS, remaining),
                signal,
              )
            : Promise.resolve(false);
        await Promise.race([woken, safety]);
      }
    },

    /** Claims one task by id, fenced: of claims that race, one lands. */
    async claimTask(caller, input): Promise<Protocol["claimTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureLease(input.lease);
      const slug = await store.mapIdentity(identity);
      ensureTtlProbed();
      const entry = await taskEntryById(input.id);
      if (entry === null) {
        const row = await store.rowById(input.id);
        if (row === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${input.id}`,
          );
        }
        throw notATask(input.id);
      }
      const channel = channelOf(entry.row);
      if (!identity.access.readable(channel)) {
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${input.id}`,
        );
      }
      if (!identity.access.can("label", channel)) {
        throw new HttpError(
          403,
          "forbidden",
          `this caller can't label in ${channel}`,
        );
      }
      // Claiming with the live claim's own token answers that claim as it is.
      if (
        input.token !== undefined &&
        entry.meta.claim !== null &&
        !lapsed(entry, Date.now())
      ) {
        const hash = hashToken(input.token);
        if (entry.meta.claim.token === hash && entry.task.state === "claimed") {
          return {
            task: viewOf(entry),
            claim: {
              epoch: entry.meta.claim.epoch,
              token: input.token,
              until: entry.meta.claim.until,
            },
          };
        }
      }
      const outcome = await claimOne({
        identity,
        slug,
        entry,
        leaseSeconds: input.lease,
        token: input.token ?? newToken(),
      });
      if (!outcome.ok) throw taskClaimed(input.id, null);
      return { task: viewOf(outcome.entry), claim: outcome.claim };
    },

    /** Extends a claim's lease from now. */
    async renewTask(caller, input): Promise<Protocol["renewTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureLease(input.lease);
      const slug = await store.mapIdentity(identity);
      const until = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<string> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          fenced(entry, input, Date.now());
          const until = new Date(
            Date.now() + leaseMs(input.lease),
          ).toISOString();
          const claim: MessageMeta["claim"] = {
            epoch: input.epoch,
            token: hashToken(input.token),
            until,
          };
          try {
            await store.run(["heartbeat", input.id, "--json"], slug);
          } catch (error) {
            if (error instanceof Error && error.name === "BdNotHolderError")
              throw claimLost(input.id);
            if (error instanceof Error && error.name === "BdFrozenError")
              throw trackerFrozen(error);
            throw error;
          }
          await updateTask(input.id, slug, { [`${ns}.claim`]: claim });
          await stampMove(input.id, slug, [
            { type: "task.renewed", state: "claimed", from: "claimed" },
          ]);
          timers.arm(input.id, input.epoch, Date.parse(until));
          return until;
        },
      );
      const entry = await taskEntryById(input.id);
      if (entry === null)
        throw internalAt("the renewed task doesn't read back");
      return { task: viewOf(entry), until };
    },

    /** Ends a claim by handing the task back: ready again, holder cleared. */
    async releaseTask(
      caller,
      input,
    ): Promise<Protocol["releaseTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          fenced(entry, input, Date.now());
          // Two writes: bd's guarded unclaim really clears the assignee
          // (`--status open` alone leaves it), then the record and label move.
          await store
            .run(["unclaim", input.id, "--if-assignee", slug, "--json"], slug)
            .catch((error) => {
              if (error instanceof Error && error.name === "BdFrozenError")
                throw trackerFrozen(error);
              throw claimLost(input.id);
            });
          stopKeepAlive(input.id, input.epoch);
          timers.cancel(input.id, input.epoch);
          const state = await settleState(entry.task.needs, false);
          await updateTask(
            input.id,
            slug,
            {
              [`${ns}.claim`]: null,
              [taskKey]: encodeTaskRecord({ ...entry.task, state }),
            },
            stateMoves(entry.row, state),
          );
          await stampMove(input.id, slug, [
            { type: "task.released", state, from: "claimed" },
          ]);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the released task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Completes a task by its claim, readying what waited only for it. */
    async completeTask(
      caller,
      input,
    ): Promise<Protocol["completeTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      if ((input.result?.length ?? 0) > TASK_NOTE_MAX) {
        throw badRequest(
          `result: a task's result is at most ${TASK_NOTE_MAX.toLocaleString("en-US")} characters`,
        );
      }
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          fenced(entry, input, Date.now());
          // The task's satisfied edges go first: bd's close refuses on a
          // blocked issue, and what it waited for has completed.
          await clearDeps(input.id, entry.task.needs, slug);
          // bd's guarded close: it refuses for anyone but the claim's holder.
          const args = ["close", input.id, "--json"];
          if (input.result !== undefined) args.push("--reason", input.result);
          try {
            await store.run(args, slug);
          } catch (error) {
            if (error instanceof Error && error.name === "BdFrozenError")
              throw trackerFrozen(error);
            throw claimLost(input.id);
          }
          stopKeepAlive(input.id, input.epoch);
          timers.cancel(input.id, input.epoch);
          await updateTask(
            input.id,
            slug,
            {
              [`${ns}.claim`]: null,
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state: "completed",
                result: input.result ?? null,
              }),
            },
            stateMoves(entry.row, "completed"),
          );
          await stampMove(input.id, slug, [
            { type: "task.completed", state: "completed", from: "claimed" },
          ]);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the completed task doesn't read back");
          return viewOf(fresh);
        },
      );
      // What waited only for this one readies here, in the same call: each
      // waiter's own write lands its flip and its journal row.
      await readyWaiters(input.id);
      return { task };
    },

    /** Fails a task by its claim; what waits for it keeps waiting. */
    async failTask(caller, input): Promise<Protocol["failTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      if (input.reason.length > TASK_NOTE_MAX) {
        throw badRequest(
          `reason: a task's reason is at most ${TASK_NOTE_MAX.toLocaleString("en-US")} characters`,
        );
      }
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          fenced(entry, input, Date.now());
          await clearDeps(input.id, entry.task.needs, slug);
          try {
            await store.run(
              ["close", input.id, "--reason", input.reason, "--json"],
              slug,
            );
          } catch (error) {
            if (error instanceof Error && error.name === "BdFrozenError")
              throw trackerFrozen(error);
            throw claimLost(input.id);
          }
          stopKeepAlive(input.id, input.epoch);
          timers.cancel(input.id, input.epoch);
          await updateTask(
            input.id,
            slug,
            {
              [`${ns}.claim`]: null,
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state: "failed",
                reason: input.reason,
              }),
            },
            stateMoves(entry.row, "failed"),
          );
          await stampMove(input.id, slug, [
            { type: "task.failed", state: "failed", from: "claimed" },
          ]);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the failed task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Holds a task for a person: by its claim, or as its owner. */
    async blockTask(caller, input): Promise<Protocol["blockTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      if (input.reason.length > TASK_NOTE_MAX) {
        throw badRequest(
          `reason: a task's reason is at most ${TASK_NOTE_MAX.toLocaleString("en-US")} characters`,
        );
      }
      if (
        input.kind !== undefined &&
        (input.kind === "edited" || input.kind.length > TASK_KIND_MAX)
      ) {
        throw badRequest(
          "kind: edited is the board's own kind, for a task whose root someone else edited",
        );
      }
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          let entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          const now = Date.now();
          if (input.epoch !== undefined && input.token !== undefined) {
            // A claimed task's hold is its claim's, and it ends the claim.
            fenced(entry, { epoch: input.epoch, token: input.token }, now);
            const holder = entry.row.assignee;
            if (holder !== null) {
              await store
                .run(
                  ["unclaim", input.id, "--if-assignee", holder, "--json"],
                  holder,
                )
                .catch((error) => {
                  if (error instanceof Error && error.name === "BdFrozenError")
                    throw trackerFrozen(error);
                  throw claimLost(input.id);
                });
            }
            stopKeepAlive(input.id, input.epoch);
            timers.cancel(input.id, input.epoch);
          } else {
            // The owner's hold: only a task no one (live) holds.
            owns(identity, entry);
            if (entry.task.state === "claimed" && lapsed(entry, now)) {
              entry = await expireClaim(entry, entry.row.assignee);
            }
            if (stateNow(entry, Date.now()) === "claimed") {
              throw taskClaimed(input.id, entry.meta.claim?.until ?? null);
            }
            if (entry.task.state === "blocked") {
              throw conflict(
                "task_blocked",
                `${input.id} is held already: ${entry.task.blocked?.reason ?? "no reason given"}`,
              );
            }
            if (
              entry.task.state === "completed" ||
              entry.task.state === "failed" ||
              entry.task.state === "canceled"
            ) {
              throw taskFinished(input.id, entry.task.state);
            }
            const holder = entry.row.assignee;
            if (holder !== null) {
              await store
                .run(
                  ["unclaim", input.id, "--if-assignee", holder, "--json"],
                  store.systemActor,
                )
                .catch(() => undefined);
            }
          }
          await updateTask(
            input.id,
            slug,
            {
              [`${ns}.claim`]: null,
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state: "blocked",
                blocked: { kind: input.kind ?? null, reason: input.reason },
              }),
            },
            stateMoves(entry.row, "blocked"),
          );
          await stampMove(input.id, slug, [
            { type: "task.blocked", state: "blocked", from: entry.task.state },
          ]);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the blocked task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Lifts a hold: ready again, or waiting behind what it needs. */
    async unblockTask(
      caller,
      input,
    ): Promise<Protocol["unblockTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          owns(identity, entry);
          if (
            entry.task.state === "completed" ||
            entry.task.state === "failed" ||
            entry.task.state === "canceled"
          ) {
            throw taskFinished(input.id, entry.task.state);
          }
          if (entry.task.state !== "blocked") return viewOf(entry);
          const state = await settleState(entry.task.needs, false);
          // Unblocked reads where the fold puts it: ready at once with no
          // needs, waiting first with some — and the ready that then follows
          // is its own event.
          const unblockEvents: TaskMoveEntry[] = [
            {
              type: "task.unblocked",
              state: entry.task.needs.length > 0 ? "waiting" : state,
              from: "blocked",
            },
          ];
          if (state === "ready" && entry.task.needs.length > 0) {
            unblockEvents.push({ type: "task.ready", state: "ready" });
          }
          await updateTask(
            input.id,
            slug,
            {
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state,
                blocked: null,
              }),
            },
            stateMoves(entry.row, state),
          );
          await stampMove(input.id, slug, unblockEvents);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the unblocked task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Makes a failed task ready again, in place. */
    async reopenTask(caller, input): Promise<Protocol["reopenTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          owns(identity, entry);
          if (
            entry.task.state === "completed" ||
            entry.task.state === "canceled"
          ) {
            throw taskFinished(input.id, entry.task.state);
          }
          if (entry.task.state !== "failed") return viewOf(entry);
          // bd's own record reopens with the record: a failed task's issue is
          // closed, and a claim of a closed issue is refused outright — the
          // reopen sets bd's status back first, and clears a holder bd's
          // close left in place.
          const holder = entry.row.assignee;
          if (holder !== null) {
            await store
              .run(
                ["unclaim", input.id, "--force", "--json"],
                store.systemActor,
              )
              .catch(() => undefined);
          }
          await store.run(
            ["update", input.id, "--status", "open", "--json"],
            slug,
          );
          await updateTask(
            input.id,
            slug,
            {
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state: "ready",
                reason: null,
              }),
            },
            stateMoves(entry.row, "ready"),
          );
          await stampMove(input.id, slug, [
            { type: "task.reopened", state: "ready", from: "failed" },
          ]);
          await clearDeps(input.id, entry.task.needs, slug);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the reopened task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Assigns a task to one of its owner's actors, or back to the pool. */
    async assignTask(caller, input): Promise<Protocol["assignTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          owns(identity, entry);
          if (
            entry.task.state === "completed" ||
            entry.task.state === "failed" ||
            entry.task.state === "canceled"
          ) {
            throw taskFinished(input.id, entry.task.state);
          }
          const assigned = ownActor(entry.task.owner, input.for);
          if (entry.task.for === assigned) return viewOf(entry);
          // A claim it has stays: assignment says who may claim it next.
          await updateTask(input.id, slug, {
            [taskKey]: encodeTaskRecord({ ...entry.task, for: assigned }),
          });
          await stampMove(input.id, slug, [
            {
              type: "task.assigned",
              state: entry.task.state,
              from: entry.task.state,
            },
          ]);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the assigned task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Replaces what a task waits for, while no one holds it and it isn't finished. */
    async setTaskNeeds(
      caller,
      input,
    ): Promise<Protocol["setTaskNeeds"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          let entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          owns(identity, entry);
          if (
            entry.task.state === "completed" ||
            entry.task.state === "failed" ||
            entry.task.state === "canceled"
          ) {
            throw taskFinished(input.id, entry.task.state);
          }
          // A claim whose lease ran out is over: its expiry goes first.
          if (entry.task.state === "claimed" && lapsed(entry, Date.now())) {
            entry = await expireClaim(entry, entry.row.assignee);
          }
          if (entry.task.state === "claimed") {
            throw taskClaimed(input.id, entry.meta.claim?.until ?? null);
          }
          const needs = await resolveNeeds(identity, input.needs, input.id);
          const same =
            needs.ids.length === entry.task.needs.length &&
            needs.ids.every((need) => entry.task.needs.includes(need));
          if (same) return viewOf(entry);
          await ensureAcyclic(
            identity,
            input.id,
            needs.ids.filter((need) => !entry.task.needs.includes(need)),
          );
          const blocked = entry.task.state === "blocked";
          const state = await settleState(needs.ids, blocked);
          // A change of needs reads where the fold puts it — waiting while it
          // has any, ready at once with none, still held when it was held —
          // and the ready that follows lands as its own event.
          const mid: TaskState =
            needs.ids.length === 0
              ? "ready"
              : blocked || state === "blocked"
                ? "blocked"
                : "waiting";
          const needsEvents: TaskMoveEntry[] = [
            {
              type: "task.needs_changed",
              state: mid,
              from: entry.task.state,
            },
          ];
          if (state === "ready" && needs.ids.length > 0 && !blocked) {
            needsEvents.push({ type: "task.ready", state: "ready" });
          }
          await updateTask(
            input.id,
            slug,
            {
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                needs: needs.ids,
                state,
              }),
            },
            stateMoves(entry.row, state),
          );
          await stampMove(input.id, slug, needsEvents);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the task whose needs changed doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },

    /** Cancels a task that hasn't completed, ending any claim. */
    async cancelTask(caller, input): Promise<Protocol["cancelTask"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const slug = await store.mapIdentity(identity);
      if (input.reason.length > TASK_NOTE_MAX) {
        throw badRequest(
          `reason: a task's reason is at most ${TASK_NOTE_MAX.toLocaleString("en-US")} characters`,
        );
      }
      const task = await store.gate.run(
        `issue:${input.id}`,
        async (): Promise<MessageView> => {
          const entry = await taskEntryById(input.id);
          if (entry === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${input.id}`,
            );
          }
          owns(identity, entry);
          if (
            entry.task.state === "completed" ||
            entry.task.state === "canceled"
          ) {
            throw taskFinished(input.id, entry.task.state);
          }
          // A failed task may yet be reopened; cancel ends it all the same.
          const holder = entry.row.assignee;
          if (holder !== null) {
            await store
              .run(
                ["unclaim", input.id, "--if-assignee", holder, "--json"],
                store.systemActor,
              )
              .catch((error) => {
                if (error instanceof Error && error.name === "BdFrozenError")
                  throw trackerFrozen(error);
                // The holder's claim may be live; the owner's cancel overrides it.
                return store.run(
                  ["unclaim", input.id, "--force", "--json"],
                  store.systemActor,
                );
              });
          }
          const epoch = entry.meta.claim?.epoch;
          if (epoch !== undefined) {
            stopKeepAlive(input.id, epoch);
            timers.cancel(input.id, epoch);
          }
          await updateTask(
            input.id,
            slug,
            {
              [`${ns}.claim`]: null,
              [taskKey]: encodeTaskRecord({
                ...entry.task,
                state: "canceled",
                reason: input.reason,
              }),
            },
            stateMoves(entry.row, "canceled"),
          );
          await stampMove(input.id, slug, [
            {
              type: "task.canceled",
              state: "canceled",
              from: entry.task.state,
            },
          ]);
          await clearDeps(input.id, entry.task.needs, slug);
          const fresh = await taskEntryById(input.id);
          if (fresh === null)
            throw internalAt("the canceled task doesn't read back");
          return viewOf(fresh);
        },
      );
      return { task };
    },
  };

  // -- helpers over the closure ---------------------------------------------

  /** The row an issue id names, fetched directly. */
  async function taskRowOfIssue(
    id: string,
  ): Promise<{ metadata: Record<string, unknown> } | null> {
    const found = await rowsOf(["list", "--all", "--id", id]);
    const row = found[0];
    if (row === undefined) return null;
    const blob = asRecord(row.metadata);
    if (blob === null) return null;
    return { metadata: blob };
  }

  /** The bd id a create answered, from either output shape bd uses. */
  function createdIdOf(result: BdResult): string | null {
    const row = Array.isArray(result.data)
      ? asRecord(result.data[0])
      : asRecord(result.data);
    const id = row?.id;
    return typeof id === "string" && id !== "" ? id : null;
  }

  /** Thread summaries for a page of task roots: replies and last reply. */
  async function summarize(
    identity: RouteIdentity,
    page: readonly TaskEntry[],
  ): Promise<Protocol["tasks"]["output"]["tasks"]> {
    const channels = [...new Set(page.map((entry) => channelOf(entry.row)))];
    const membersByThread = new Map<
      string,
      { id: string; seq: number; deleted: boolean }[]
    >();
    for (const channel of channels) {
      const members = await store.channelEntries(channel);
      for (const member of members) {
        if (!identity.access.readable(member.meta.channel)) continue;
        const list = membersByThread.get(member.meta.thread) ?? [];
        list.push({
          id: member.row.issue.id,
          seq: member.row.seq,
          deleted: member.meta.deleted,
        });
        membersByThread.set(member.meta.thread, list);
      }
    }
    const summaries: Protocol["tasks"]["output"]["tasks"] = [];
    for (const entry of page) {
      const members = membersByThread.get(entry.row.id) ?? [];
      const replies = members
        .filter((member) => member.id !== entry.row.id && !member.deleted)
        .sort((a, b) => a.seq - b.seq);
      const lastId = replies.at(-1)?.id ?? null;
      const lastEntry = lastId === null ? null : await store.entryById(lastId);
      const view = viewOf(entry);
      const last = lastEntry === null ? null : store.view(lastEntry);
      summaries.push({
        message: view,
        replies: replies.length,
        last: last !== null && last.ok ? last.value : null,
      });
    }
    return summaries;
  }

  /** Ready what waited only for `id`, in the completing call. */
  async function readyWaiters(id: string): Promise<void> {
    const entries = await scanTaskEntries();
    const waiters = entries.filter(
      (entry) =>
        entry.task.state === "waiting" && entry.task.needs.includes(id),
    );
    for (const waiter of waiters) {
      await store.gate.run(`issue:${waiter.row.id}`, async () => {
        const fresh = await taskEntryById(waiter.row.id);
        if (
          fresh === null ||
          fresh.task.state !== "waiting" ||
          !fresh.task.needs.includes(id)
        )
          return;
        if (!(await needsSatisfied(fresh.task.needs))) return;
        await updateTask(
          fresh.row.id,
          store.systemActor,
          { [taskKey]: encodeTaskRecord({ ...fresh.task, state: "ready" }) },
          stateMoves(fresh.row, "ready"),
        );
        await stampMove(fresh.row.id, store.systemActor, [
          { type: "task.ready", state: "ready", from: "waiting" },
        ]);
        await clearDeps(fresh.row.id, fresh.task.needs, store.systemActor);
      });
    }
  }
}
