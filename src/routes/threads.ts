/**
 * The threads and messages routes: Board's core conversation surface over the
 * tracker. Everything here goes through the transport — no bd process is ever
 * spawned outside src/bd — and through the model layer for every mapping
 * decision: metadata (the bb.* codec), labels (caller namespaces and the
 * reserved board.* prefix), cursors (message ids and the composite `older`
 * pair), actors (principal → BEADS_ACTOR slugs, persisted so fencing and
 * authorship survive restarts), and the per-issue write gate that serializes
 * each message's metadata read-modify-write.
 *
 * How Board state maps onto bd:
 *   - one message is one bd issue (type `task`; bd's own `message` type is an
 *     ephemeral infra bead its listings hide, so it cannot be the storage row);
 *   - the channel rides as the backend-owned bd label `<ns>.channel=<path>`,
 *     so `bd list --label` answers per-channel reads server-side; a channel
 *     with no posts yet is a marker issue carrying only that label;
 *   - a thread root carries the `<ns>.root` label; a reply carries a native
 *     `replies-to` dependency on the message it answers (capability-probed at
 *     first use) while its metadata names the thread's root, so `bd show
 *     <root> --thread` renders a Board thread as a native beads thread;
 *   - version/revision/reactions/tombstones live in the issue's versioned
 *     metadata blob; deletes are flags, never `bd delete`;
 *   - every message metadata blob also carries a backend-assigned `<ns>.seq`
 *     counter, so message order stays creation order even where bd's
 *     second-granularity timestamps tie.
 *
 * Access: board() verifies each caller and hands it over with its access; the
 * routes hold every read to channels the caller can read (answered as
 * not-found), every write to its permission in the message's channel, and
 * edits and deletes to the author (a profile owns only what it wrote; the
 * principal behind it owns what its profiles wrote, exactly as Board's own
 * engine decides it).
 */
import {
  HttpError,
  type BoardBinding,
  type Caller,
  type ChannelsPage,
  type Discovery,
  type Me,
  type MessageView,
  type Protocol,
  type ProtocolMethods,
  type ThreadSummaryView,
  type ThreadsPage,
  type ThreadView,
} from "@vercel/board";
import { FULL_ACCESS, parseCan } from "@vercel/board/access";
import type { Access, Permission } from "@vercel/board/access";
import { BdTransport, type BdResult } from "../bd/transport.ts";
import { compareBdVersions } from "../bd/version.ts";
import {
  BD_MIN_VERSION,
  BD_RANGE,
  bdUnavailable,
  guardBdRoutes,
  unavailable,
} from "./unavailable.ts";
import {
  emptyActorAssignments,
  deriveActorSlug,
  mapPrincipal,
} from "../model/actors.ts";
import { findBlocks, type FoundBlock } from "@vercel/board/schemas";
import {
  compareThreadBoundary,
  decodeMessageCursor,
  decodeOlderCursor,
  encodeMessageCursor,
  encodeOlderCursor,
  type ThreadBoundary,
} from "../model/cursors.ts";
import { createLabels } from "../model/labels.ts";
import {
  checkReplyAfter,
  deriveTitle,
  issueToMessage,
  probeRepliesTo,
} from "../model/message.ts";
import {
  applyDelete,
  applyEdit,
  applyLabelsChanged,
  applyReaction,
  checkRevisionFence,
  createMetadataCodec,
  createWriteGate,
  initialMessageMeta,
  type WriteGate,
} from "../model/metadata.ts";
import type {
  ActorAssignments,
  BdIssue,
  BdRunResult,
  JsonValue,
  LabelRefusal,
  LabelsApi,
  MessageAuthorIdentity,
  MessageMeta,
  MetadataCodec,
} from "../model/types.ts";
import {
  encodeTaskRecord,
  holdableByEdit,
  movePatch,
  newMoveNonce,
  projectTaskView,
  taskRecordOf,
  TASK_LABEL,
  type TaskMoveEntry,
  type TaskRecord,
} from "../tasks/record.ts";

/**
 * A message's text bound, as Board holds it. Long text belongs in a file with
 * a short summary as the text; this backend keeps no files, so the long part
 * has nowhere to land.
 */
const MESSAGE_TEXT_MAX = 10_000;

/** Protocol page sizes: what a read answers without a limit, and at most. */
const CHANNELS_LIMIT_DEFAULT = 100;
const CHANNELS_LIMIT_MAX = 500;
const THREADS_LIMIT_DEFAULT = 50;
const THREADS_LIMIT_MAX = 500;
/** At most this many label conditions one label write may check. */
const LABEL_CONDITIONS_MAX = 16;

/** The backend's own version, as discovery answers it. */
const BACKEND_VERSION = "0.1.0";

/** Where a board reached in-process answers as its URL when nothing else says. */
const IN_PROCESS_URL = "http://in-process.board";

/**
 * A channel path: lowercase segments joined by `/`. Commas are excluded
 * because bd splits label arguments on commas, and the channel label carries
 * the whole path as its value.
 */
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** An author record, exactly as views and writes carry it. */
interface AuthorRecord {
  actor: string;
  principal: string;
  profile: string | null;
}

/** Who a caller is, normalized across board()'s two caller shapes. */
interface RouteIdentity {
  /** The writing actor's id: the author record its writes carry. */
  actorId: string;
  /** The principal behind it: a profile and its principal-as-itself differ here. */
  principalId: string;
  /** The profile it writes through, or null for itself. */
  profile: string | null;
  /** What it may do now, already narrowed by its scope. */
  access: Access;
  /** When its credential expires, for `me`. */
  expiresAt: string | null;
  /** The display card its writes record, for the actors list and author views. */
  card: ActorCard;
}

/** An actor's display card, persisted beside its slug mapping. */
interface ActorCard {
  actor: string;
  principal: string;
  profile: string | null;
  kind: string;
  handle: string;
  name: string;
  avatar: string | null;
  /** Who the actor acts through (a sync import's platform user speaks via its importer). */
  via?: { name: string; environment: string | null };
  /** The platform a platform user came in from, as their sync key names it. */
  platform?: string;
}

/** One bd issue row, as `bd list --json` carries it, read tolerantly. */
interface IssueRow {
  issue: BdIssue;
  labels: string[];
  /** The backend-assigned sequence from the metadata blob, 0 when absent. */
  seq: number;
  /** bd's assignee slug (a task's live claim holder), null when unassigned. */
  assignee: string | null;
}

/** A row that decodes as a readable message: the issue, its labels, its metadata. */
interface MessageEntry {
  row: IssueRow;
  meta: MessageMeta;
}

/** Options for the store every route group shares. */
export interface BoardStoreOptions {
  /** Tracker workspace directory (bd's cwd for every call). */
  dir: string;
  /** Explicit bd binary path. Defaults to `bd` on PATH. */
  bdPath?: string;
  /** Actor slug for writes made outside any caller's identity (probes, markers). */
  systemActor?: string;
  /** Label and metadata namespace override (several boards over one tracker). */
  namespace?: string;
  /**
   * Per-invocation bd bound, in ms. The sweep suite drives hung-bd
   * scenarios with a short one; production takes the transport's default.
   */
  timeoutMs?: number;
}

/** The persisted state: the actor map with cards, and the message sequence. */
interface PersistedState {
  assignments: ActorAssignments;
  seq: number;
  stateIssueId: string | null;
  repliesTo: boolean;
}

/**
 * Everything the route groups share: the transport, the model pieces bound to
 * one namespace, the write gate, and the persisted state. Construction does no
 * I/O; the first route call initializes. Route groups for the event feed,
 * tasks, watchers, and sync records plug into this same store.
 */
export interface BoardStore {
  readonly transport: BdTransport;
  readonly codec: MetadataCodec;
  /** The caller-label API bound to this board's namespace. */
  readonly labels: LabelsApi;
  readonly gate: WriteGate;
  readonly systemActor: string;
  /** The board binding, once board() hands it over. */
  bind(binding: BoardBinding): void;
  binding(): BoardBinding | null;
  /** Version sanity, the replies-to capability probe, and the persisted state. */
  ensureReady(): Promise<void>;
  /** Run one bd invocation, optionally as a caller's mapped slug. */
  run(args: string[], actor?: string): Promise<BdResult>;
  /** Never-throwing runner shaped for capability probes. */
  probeRun(args: string[]): Promise<BdRunResult>;
  /** bd issue rows for one list query (already JSON-decoded). */
  rows(args: string[]): Promise<IssueRow[]>;
  /** One issue row by id, or null when bd has none. */
  rowById(id: string): Promise<IssueRow | null>;
  /** The row decoded as a message, or null (absent, foreign, corrupt). */
  entryById(id: string): Promise<MessageEntry | null>;
  /** Every message entry in one channel, in creation order. */
  channelEntries(channel: string): Promise<MessageEntry[]>;
  /** A message view for an entry, its author resolved from the persisted cards. */
  view(
    entry: MessageEntry,
  ): { ok: true; value: MessageView } | { ok: false; code: "not_found" };
  /** The persisted state (actor map, sequence counter, capability flags). */
  state(): PersistedState;
  /** Decode one persisted display card, or null when it is corrupt. */
  parseCard(raw: string | null): ActorCard | null;
  /** Map a caller to its slug, persisting the assignment and its display card. */
  mapIdentity(identity: RouteIdentity): Promise<string>;
  /** The author identity a bd actor slug belongs to, or null for an unmapped one. */
  authorForSlug(slug: string | null): MessageAuthorIdentity | null;
  /** The next message sequence: assigned in memory, persisted behind the state gate. */
  nextSeq(): Promise<number>;
}

/** Narrow an unknown bd list row into what the routes read, or null. */
function decodeRow(codec: MetadataCodec, raw: unknown): IssueRow | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const row = raw as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== "string" || id === "") return null;
  const labels = Array.isArray(row.labels)
    ? row.labels.filter((entry): entry is string => typeof entry === "string")
    : [];
  let metadata: unknown = row.metadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata) as unknown;
    } catch {
      metadata = undefined;
    }
  }
  let seq = 0;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
  ) {
    const carried = (metadata as Record<string, unknown>)[
      `${codec.namespace}.seq`
    ];
    if (typeof carried === "number" && Number.isSafeInteger(carried))
      seq = carried;
  }
  return {
    issue: {
      id,
      title: typeof row.title === "string" ? row.title : "",
      description:
        typeof row.description === "string" ? row.description : undefined,
      status: typeof row.status === "string" ? row.status : "",
      created_at:
        typeof row.created_at === "string" ? row.created_at : undefined,
      updated_at:
        typeof row.updated_at === "string" ? row.updated_at : undefined,
      created_by: typeof row.created_by === "string" ? row.created_by : null,
      metadata,
    },
    labels,
    seq,
    assignee:
      typeof row.assignee === "string" && row.assignee !== ""
        ? row.assignee
        : null,
  };
}

/** Deterministic message order: the backend sequence, then the id for safety. */
function bySeq(a: IssueRow, b: IssueRow): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.issue.id < b.issue.id ? -1 : a.issue.id > b.issue.id ? 1 : 0;
}

/** The backend-owned bd label carrying a message's channel. */
function channelLabel(channel: string): string {
  return `bb.channel=${channel}`;
}

/** The backend-owned bd label marking a thread root. */
function rootLabel(): string {
  return "bb.root";
}

/** One caller label as bd stores it: `name=value` with a value, bare without. */
function bdLabelOf(name: string, value: string | undefined): string {
  return value === undefined || value === "" ? name : `${name}=${value}`;
}

/** The bd id a create answered, from either output shape bd uses. */
function createdId(result: BdResult): string | null {
  const data = result.data;
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || typeof row !== "object" || Array.isArray(row))
    return null;
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
}

// ---------------------------------------------------------------------------
// Protocol failure shorthands: every path answers Board's error shape.
// ---------------------------------------------------------------------------

function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

function textTooLong(): HttpError {
  return badRequest(
    `A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString("en-US")} characters.`,
    "text_too_long",
  );
}

function labelRefusal(refusal: LabelRefusal): HttpError {
  return badRequest(
    refusal.code === "reserved_label"
      ? `${refusal.label} is a reserved prefix: board.* is Board's, and ${refusal.label.split(".")[0] ?? ""}.* is this backend's`
      : `${JSON.stringify(refusal.label)} isn't a label this board can store`,
    refusal.code,
  );
}

/**
 * Guard a caller label bd cannot carry: bd splits label arguments on commas,
 * so a comma in a name or a value would silently split into two labels.
 */
function ensureLabelCarryable(name: string, value: string | undefined): void {
  if (name.includes(","))
    throw labelRefusal({ code: "invalid_label", label: name });
  if (value !== undefined && value.includes(",")) {
    throw labelRefusal({ code: "invalid_label", label: `${name}=${value}` });
  }
}

/** Clamp a page size to the protocol bounds. */
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

/** Validate a channel path, for posts and channel creates. */
function ensureChannel(channel: string): string {
  if (
    channel.length === 0 ||
    channel.length > 2048 ||
    !CHANNEL_PATTERN.test(channel)
  ) {
    throw badRequest(
      `${JSON.stringify(channel)} isn't a channel: use lowercase segments joined by /`,
    );
  }
  return channel;
}

/** Who a caller is: board()'s verified identity, or this deployment's own code. */
function identityOf(caller: Caller): RouteIdentity {
  if ("identity" in caller) {
    const { principal, author, actor } = caller.identity;
    return {
      actorId: author.actor,
      principalId: author.principal,
      profile: author.profile,
      access: principal.access,
      expiresAt:
        principal.expiresAt === undefined || principal.expiresAt === null
          ? null
          : principal.expiresAt.toISOString(),
      card: {
        // The card's actor is the bd actor slug the principal maps to — the
        // same derivation mapIdentity persists — never the raw principal id,
        // which carries separators and whatever unicode its issuer allowed.
        // Authorship reads back through this card, so `by.actor` stays a
        // valid BEADS_ACTOR shape whatever a hostile principal looks like.
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

/** Whether the author record a message carries is this caller's to change. */
function wroteAs(by: AuthorRecord, identity: RouteIdentity): boolean {
  return (
    by.principal === identity.principalId &&
    (identity.profile === null || by.actor === identity.actorId)
  );
}

/** Hold a read to the channels the caller can read: out of sight is not-found. */
function ensureReadable(access: Access, channel: string): void {
  if (!access.readable(channel)) {
    throw new HttpError(404, "message_not_found", "message not found");
  }
}

/** Hold a write to its permission in the message's channel. */
function ensurePermission(
  access: Access,
  permission: Permission,
  channel: string,
): void {
  if (!access.can(permission, channel)) {
    throw forbidden(`this caller can't ${permission} in ${channel}`);
  }
}

/** A message's text within the protocol bound. */
function ensureTextFits(text: string): void {
  if (text.length > MESSAGE_TEXT_MAX) throw textTooLong();
}

/** Empty text is only meaningful beside attachments, which this board keeps none of. */
function ensureTextPresent(text: string): void {
  if (text.length === 0) throw badRequest("a message needs text");
}

// ---------------------------------------------------------------------------
// The store: transport + model, wired once, initialized on first use.
// ---------------------------------------------------------------------------

/** Build the store. No I/O here: bd is first contacted on the first route call. */
export function createBoardStore(options: BoardStoreOptions): BoardStore {
  const codec = createMetadataCodec({ namespace: options.namespace });
  const labels = createLabels({ namespace: codec.namespace });
  const gate0 = createWriteGate();
  const systemActor = options.systemActor ?? "board-beads";
  const transport = new BdTransport({
    dir: options.dir,
    bin: options.bdPath,
    actor: systemActor,
    journal: true,
    timeoutMs: options.timeoutMs,
  });

  const state: PersistedState = {
    assignments: emptyActorAssignments,
    seq: 0,
    stateIssueId: null,
    repliesTo: false,
  };
  let binding: BoardBinding | null = null;
  let ready: Promise<void> | null = null;

  /**
   * The issue keys whose gate an op currently holds. The task write guard
   * (below) runs inside `run`, which callers invoke both bare and from
   * within a gated op; re-entering the same gate would chain on itself and
   * never run, so a guard that fires under the holder's own gate skips the
   * acquisition — the holder already serializes the issue.
   */
  const gating = new Set<string>();
  const gate: WriteGate = {
    run(key, op) {
      return gate0.run(key, async () => {
        gating.add(key);
        try {
          return await op();
        } finally {
          gating.delete(key);
        }
      });
    },
  };

  /** Never-throwing runner shaped for the model's capability probe. */
  const probeRun = async (args: string[]): Promise<BdRunResult> => {
    try {
      // The probe's throwaway issues never journal: their bare creates
      // would hold every feed read that walks over them.
      const result = await transport.run(args, {
        omitEnv: ["BD_EVENTS_JOURNAL"],
      });
      return { code: 0, stdout: result.raw, stderr: "" };
    } catch (error) {
      const bd = error as {
        exitCode?: number | null;
        stdout?: string;
        stderr?: string;
      };
      return {
        code: typeof bd.exitCode === "number" ? bd.exitCode : 1,
        stdout: bd.stdout ?? "",
        stderr: bd.stderr ?? "",
      };
    }
  };

  /** Decode one row into a message entry, or null (absent, foreign, corrupt). */
  const entryOf = (row: IssueRow | null): MessageEntry | null => {
    if (row === null) return null;
    const decoded = codec.decode(row.issue.metadata);
    if (!decoded.ok || decoded.value.role !== "message") return null;
    return { row, meta: decoded.value };
  };

  const rows = async (args: string[]): Promise<IssueRow[]> => {
    const result = await transport.run([...args, "--json"]);
    const data = result.data;
    const raws = Array.isArray(data)
      ? data
      : data === undefined || data === null
        ? []
        : [data];
    const decoded: IssueRow[] = [];
    for (const raw of raws) {
      const row = decodeRow(codec, raw);
      if (row !== null) decoded.push(row);
    }
    return decoded;
  };

  const loadState = async (): Promise<void> => {
    const found = await rows([
      "list",
      "--has-metadata-key",
      `${codec.namespace}.role`,
    ]);
    for (const row of found) {
      const decoded = codec.decode(row.issue.metadata);
      if (!decoded.ok || decoded.value.role !== "backend") continue;
      const raw = row.issue.metadata;
      let seq = 0;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const carried = (raw as Record<string, unknown>)[
          `${codec.namespace}.seq`
        ];
        if (typeof carried === "number" && Number.isSafeInteger(carried))
          seq = carried;
      }
      state.assignments = { principals: { ...decoded.value.actors } };
      state.seq = seq;
      state.stateIssueId = row.issue.id;
      return;
    }
  };

  /** Persist the actor map and sequence counter on the backend's own issue. */
  const saveState = async (): Promise<void> => {
    await gate.run("state", async () => {
      const encoded = codec.encodeBackend({
        role: "backend",
        kind: "actors",
        actors: state.assignments.principals,
      });
      if (!encoded.ok) {
        throw badRequest(
          `backend state too large to persist (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
        );
      }
      const blob: Record<string, JsonValue> = {
        ...encoded.value,
        [`${codec.namespace}.seq`]: state.seq,
      };
      // The backend's own bookkeeping stays off the events feed: a state
      // issue's bare create row would hold any feed read that walks over it
      // (the journal consumer pins an unclassifiable create), and a wait-less
      // poll would answer empty until the hold expired.
      const withoutJournal = { omitEnv: ["BD_EVENTS_JOURNAL"] } as const;
      if (state.stateIssueId !== null) {
        await transport.run(
          [
            "update",
            state.stateIssueId,
            `--metadata=${JSON.stringify(blob)}`,
            "--json",
          ],
          withoutJournal,
        );
        return;
      }
      const created = await transport.run(
        [
          "create",
          "--title=board-beads backend state",
          "--type=task",
          `--metadata=${JSON.stringify(blob)}`,
          "--json",
        ],
        withoutJournal,
      );
      const id = createdId(created);
      if (id === null) {
        throw new HttpError(
          500,
          "internal",
          "bd create returned no issue id for backend state",
        );
      }
      state.stateIssueId = id;
    });
  };

  const cardRaw = (slug: string): string | null => {
    const value = state.assignments.principals[`card:${slug}`];
    return value === undefined ? null : value;
  };

  // ---------------------------------------------------------------------------
  // The task write guard: an edit of a task's root by anyone but its owner
  // holds the task (which ends its claim), and a delete of one cancels it —
  // whichever surface wrote the change. The threads edit route and the sync
  // import both land their text writes through `run` as an `update` carrying
  // `--description`, so this one seam covers both, exactly as Board's own
  // engine holds a task when its root's text changes under it: the task says
  // what its owner read, so it waits for them to read it again. One already
  // held or finished stays as it is.
  // ---------------------------------------------------------------------------

  /** Why a task is held once its root was edited by someone who doesn't own it. */
  const EDITED_REASON =
    "its text was edited by someone who does not own the task";

  /** The task's current `board.task` bd label, if it wears one. */
  const taskLabelOn = (labels: readonly string[]): string | null => {
    for (const label of labels) {
      if (label === TASK_LABEL || label.startsWith(`${TASK_LABEL}=`)) {
        return label;
      }
    }
    return null;
  };

  /** Best-effort: clear bd's half of the claim, so the task is claimable at once. */
  const dropBdClaim = async (
    id: string,
    holder: string | null,
  ): Promise<void> => {
    if (holder !== null) {
      const guarded = await store
        .run(["unclaim", id, "--if-assignee", holder, "--json"], holder)
        .catch(() => null);
      if (guarded !== null) return;
    }
    await store
      .run(["unclaim", id, "--force", "--json"], systemActor)
      .catch(() => undefined);
  };

  /**
   * Land a task-record flip beside the message metadata: bd merges metadata
   * keys, so the patch carries only the task's keys and the label moves.
   * The move rides a trailing write of its own (stampMove's reasoning: bd
   * journals a multi-part update one record per field, each snapshot with
   * only the labels written so far, and the feed reads the move from a
   * record that wears the write's whole labels).
   */
  const flipTaskRecord = async (
    id: string,
    record: TaskRecord,
    moves: { add: string[]; remove: string[] },
    move: TaskMoveEntry[],
  ): Promise<void> => {
    await store.run(
      [
        "update",
        id,
        "--metadata",
        JSON.stringify({
          [`${codec.namespace}.task`]: encodeTaskRecord(record),
          [`${codec.namespace}.claim`]: null,
        }),
        ...moves.add.flatMap((label) => ["--add-label", label]),
        ...moves.remove.flatMap((label) => ["--remove-label", label]),
        "--json",
      ],
      systemActor,
    );
    await stampMove(id, move);
  };

  /** The trailing move stamp (the feed's `task.*` events for the flip). */
  const stampMove = async (
    id: string,
    events: TaskMoveEntry[],
  ): Promise<void> => {
    await store.run(
      [
        "update",
        id,
        "--metadata",
        JSON.stringify(movePatch(codec, { n: newMoveNonce(), events })),
        "--json",
      ],
      systemActor,
    );
  };

  /** The text a text-write (`update <id> --description=…`) carries, or null. */
  function textUpdateOf(args: readonly string[]): string | null {
    if (args[0] !== "update") return null;
    for (const arg of args) {
      if (arg === "--description") return "";
      if (arg.startsWith("--description=")) {
        return arg.slice("--description=".length);
      }
    }
    return null;
  }

  /** Whether `card` is who the task's record names as its maker. */
  const madeTheTask = (
    card: {
      actor: string;
      principal: string;
      profile: string | null;
      kind: string;
    } | null,
    record: TaskRecord,
  ): boolean =>
    card !== null &&
    card.kind !== "external" &&
    card.principal === record.owner &&
    (card.profile === null || record.by === card.actor);

  /**
   * The guard proper, best-effort and never throwing: the primary write has
   * landed by the time this runs, and a flip that could not land must not
   * fail the caller's edit — the next look at the task still sees it.
   */
  const taskWriteGuard = async (
    id: string,
    actor: string,
    description: string,
  ): Promise<void> => {
    const apply = async (): Promise<void> => {
      const entry = await store.entryById(id);
      if (entry === null || entry.meta.thread !== id) return;
      const record = taskRecordOf(codec, entry.row.issue.metadata);
      if (record === null) return;
      const card = parseCard(cardRaw(actor));
      if (description === "") {
        // A delete: the tombstone cancels the task, before the labels go.
        if (record.state === "completed" || record.state === "canceled") {
          return;
        }
        await dropBdClaim(id, entry.row.assignee);
        const current = taskLabelOn(entry.row.labels);
        await flipTaskRecord(
          id,
          { ...record, state: "canceled", reason: "deleted" },
          {
            add:
              current === `${TASK_LABEL}=canceled`
                ? []
                : [`${TASK_LABEL}=canceled`],
            remove: current === null ? [] : [current],
          },
          [{ type: "task.canceled", state: "canceled", from: record.state }],
        );
        return;
      }
      if (!holdableByEdit(record.state)) return;
      if (madeTheTask(card, record)) return;
      await dropBdClaim(id, entry.row.assignee);
      const current = taskLabelOn(entry.row.labels);
      await flipTaskRecord(
        id,
        {
          ...record,
          state: "blocked",
          blocked: { kind: "edited", reason: EDITED_REASON },
        },
        {
          add:
            current === `${TASK_LABEL}=blocked`
              ? []
              : [`${TASK_LABEL}=blocked`],
          remove: current === null ? [] : [current],
        },
        [{ type: "task.blocked", state: "blocked", from: record.state }],
      );
    };
    // Under the issue's own gate when the caller already holds it; otherwise
    // take it, so the flip lands serialized against the task's own writes.
    const key = `issue:${id}`;
    if (gating.has(key)) {
      await apply().catch(() => undefined);
      return;
    }
    await gate0.run(key, () => apply().catch(() => undefined));
  };

  const parseCard = (raw: string | null): ActorCard | null => {
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const card = parsed as Record<string, unknown>;
    if (typeof card.actor !== "string" || typeof card.principal !== "string")
      return null;
    let via: ActorCard["via"];
    if (
      card.via !== null &&
      typeof card.via === "object" &&
      !Array.isArray(card.via) &&
      typeof (card.via as Record<string, unknown>).name === "string"
    ) {
      const environment = (card.via as Record<string, unknown>).environment;
      via = {
        name: (card.via as Record<string, unknown>).name as string,
        environment: typeof environment === "string" ? environment : null,
      };
    }
    return {
      actor: card.actor,
      principal: card.principal,
      profile: typeof card.profile === "string" ? card.profile : null,
      kind: typeof card.kind === "string" ? card.kind : "agent",
      handle: typeof card.handle === "string" ? card.handle : card.actor,
      name: typeof card.name === "string" ? card.name : card.actor,
      avatar: typeof card.avatar === "string" ? card.avatar : null,
      ...(via !== undefined && { via }),
      ...(typeof card.platform === "string" &&
        card.platform !== "" && { platform: card.platform }),
    };
  };

  const store: BoardStore = {
    transport,
    codec,
    labels,
    gate,
    systemActor,
    bind(given: BoardBinding): void {
      if (binding !== null) {
        throw new Error(
          "board-beads: this backend already serves a board: create one beads() per board()",
        );
      }
      binding = given;
    },
    binding: () => binding,
    ensureReady: async (): Promise<void> => {
      if (ready === null) {
        ready = (async () => {
          const version = await transport.version();
          // The README's bind gate: `bd >= 1.3.4, < 2`. Older bd predates
          // the journal and metadata shapes this backend reads; a major
          // ahead is unexplored churn. Either answers typed, naming the
          // range — bind never half-serves a tracker it can't decode.
          if (
            compareBdVersions(version, BD_MIN_VERSION) < 0 ||
            version.major >= 2
          ) {
            throw unavailable(
              `bd ${version.major}.${version.minor}.${version.patch} is outside the documented range (${BD_RANGE}): upgrade bd, then rebind`,
            );
          }
          state.repliesTo = (await probeRepliesTo(probeRun)).repliesTo;
          await loadState();
        })();
        ready.catch(() => {
          ready = null;
        });
      }
      try {
        await ready;
      } catch (error) {
        // A bd the environment broke (missing, wedged, wrong version,
        // uninitialized tracker) is the 503 the caller acts on, with the
        // fix named — never a raw transport error answering 500 internal.
        throw bdUnavailable(error);
      }
    },
    run: async (args, actor) => {
      const result =
        actor === undefined
          ? await transport.run(args)
          : await transport.run(args, { extraEnv: { BEADS_ACTOR: actor } });
      // The task write guard: a text write (an `update` that carries
      // `--description`) to a task's root holds or cancels the task when the
      // rules say so, whichever surface wrote it. System writes skip it.
      const description = textUpdateOf(args);
      if (
        description !== null &&
        actor !== undefined &&
        actor !== systemActor
      ) {
        const id = args[1];
        if (typeof id === "string" && id !== "") {
          await taskWriteGuard(id, actor, description).catch(() => undefined);
        }
      }
      return result;
    },
    probeRun,
    rows,
    async rowById(id: string): Promise<IssueRow | null> {
      const found = await rows(["list", "--id", id]);
      return found[0] ?? null;
    },
    async entryById(id: string): Promise<MessageEntry | null> {
      return entryOf(await store.rowById(id));
    },
    async channelEntries(channel: string): Promise<MessageEntry[]> {
      const found = await rows(["list", "--label", channelLabel(channel)]);
      return found
        .map(entryOf)
        .filter((entry): entry is MessageEntry => entry !== null)
        .sort((a, b) => bySeq(a.row, b.row));
    },
    view: (entry: MessageEntry) => {
      const built = issueToMessage(entry.row.issue, {
        codec,
        labels,
        authorFor: (slug) => store.authorForSlug(slug),
        bdLabels: entry.row.labels,
      });
      if (!built.ok) return built;
      // A task root reads as its thread: the record rides the same metadata
      // blob the message decodes from, so the projection costs no extra bd
      // read. A claim's holder shows through the assignee slug's card.
      const record = taskRecordOf(codec, entry.row.issue.metadata);
      if (record !== null) {
        const claimActor =
          store.authorForSlug(entry.row.assignee)?.by.actor ??
          entry.row.assignee;
        const task = projectTaskView(entry.meta, record, claimActor);
        if (task !== null) built.value.task = task;
      }
      return built;
    },
    state: () => state,
    parseCard,
    mapIdentity: async (identity: RouteIdentity): Promise<string> => {
      const existing = state.assignments.principals[identity.actorId];
      const card = JSON.stringify(identity.card);
      if (existing !== undefined) {
        if (cardRaw(existing) !== card) {
          state.assignments = {
            principals: {
              ...state.assignments.principals,
              [`card:${existing}`]: card,
            },
          };
          await saveState();
        }
        return existing;
      }
      const mapped = mapPrincipal(state.assignments, identity.actorId, {
        reserved: [systemActor],
      });
      if (!mapped.ok) {
        if (mapped.error.code !== "actor_collision") {
          throw badRequest(
            `the principal ${JSON.stringify(identity.actorId)} can't be an actor`,
            "invalid_request",
          );
        }
        const heldBy = mapped.error.heldBy;
        throw new HttpError(
          409,
          "actor_collision",
          `the actor slug for ${identity.actorId} is already held${heldBy === null ? "" : ` by ${heldBy}`}`,
        );
      }
      state.assignments = {
        principals: {
          ...mapped.value.assignments.principals,
          [`card:${mapped.value.slug}`]: card,
        },
      };
      await saveState();
      return mapped.value.slug;
    },
    authorForSlug: (slug: string | null): MessageAuthorIdentity | null => {
      if (slug === null) return null;
      const card = parseCard(cardRaw(slug));
      if (card === null) return null;
      return {
        by: {
          actor: card.actor,
          principal: card.principal,
          profile: card.profile,
        },
        view: {
          kind: card.kind as MessageAuthorIdentity["view"]["kind"],
          handle: card.handle,
          name: card.name,
          avatar: card.avatar,
          ...(card.via !== undefined && { via: card.via }),
          ...(card.platform !== undefined && { platform: card.platform }),
        },
      };
    },
    nextSeq: async (): Promise<number> => {
      state.seq += 1;
      await saveState();
      return state.seq;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// Shared route machinery over the store.
// ---------------------------------------------------------------------------

/** Create the bd issue a message lives in; returns its id. */
async function createIssue(
  store: BoardStore,
  input: {
    title: string;
    description: string;
    actor: string;
    dep?: string | null;
    /** Keep the issue's bare create off the events feed (never-message rows hold feed walks). */
    withoutJournal?: boolean;
  },
): Promise<string> {
  const args = [
    "create",
    `--title=${input.title}`,
    `--description=${input.description}`,
    "--type=task",
    "--json",
  ];
  if (input.dep !== undefined && input.dep !== null) {
    args.push(`--deps=replies-to:${input.dep}`);
  }
  const id = createdId(
    await (input.withoutJournal === true
      ? store.transport.run(args, {
          extraEnv: { BEADS_ACTOR: input.actor },
          omitEnv: ["BD_EVENTS_JOURNAL"],
        })
      : store.run(args, input.actor)),
  );
  if (id === null)
    throw new HttpError(500, "internal", "bd create returned no issue id");
  return id;
}

/** Write one message's metadata blob (bd merges keys; the gate serializes callers). */
async function writeMeta(
  store: BoardStore,
  id: string,
  meta: MessageMeta,
  seq: number,
  actor: string,
): Promise<void> {
  const encoded = store.codec.encodeMessage(meta);
  if (!encoded.ok) {
    throw badRequest(
      `the message's metadata is too large to store (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
    );
  }
  const blob: Record<string, JsonValue> = {
    ...encoded.value,
    [`${store.codec.namespace}.seq`]: seq,
  };
  await store.run(
    ["update", id, `--metadata=${JSON.stringify(blob)}`, "--json"],
    actor,
  );
}

/** Add one bd label, backend-owned or caller's. */
async function addBdLabel(
  store: BoardStore,
  id: string,
  label: string,
  actor: string,
): Promise<void> {
  await store.run(["label", "add", id, label], actor);
}

/** The labels map a message shows callers, from its bd labels (ours filtered). */
function entryLabels(
  store: BoardStore,
  entry: MessageEntry,
): Record<string, string> {
  const api = createLabels({ namespace: store.codec.namespace });
  return api.fromBdLabels(entry.row.labels);
}

/** A thread's activity boundary: the latest message's row, as the model orders them. */
function boundaryOf(entry: MessageEntry): ThreadBoundary {
  return {
    updated_at: entry.row.issue.updated_at ?? entry.row.issue.created_at ?? "",
    id: entry.row.issue.id,
  };
}

/** The composite cursor for an empty page: a boundary before every message. */
const EMPTY_CURSOR = encodeOlderCursor({
  updated_at: "1970-01-01T00:00:00.000Z",
  id: "0",
});

/**
 * Resolve a threads `after` cursor: a page's composite pair, or a message id
 * (one of this channel's — anything else is an unreadable cursor).
 */
async function resolveThreadBoundary(
  store: BoardStore,
  raw: string,
  channel: string,
): Promise<ThreadBoundary> {
  const asOlder = decodeOlderCursor(raw);
  if (asOlder.ok) return asOlder.value;
  const asMessage = decodeMessageCursor(raw);
  if (!asMessage.ok) {
    throw badRequest(
      `${JSON.stringify(raw)} isn't a cursor on this board`,
      "invalid_cursor",
    );
  }
  const entry = await store.entryById(asMessage.value);
  if (entry === null || entry.meta.channel !== channel) {
    throw badRequest(
      `${JSON.stringify(raw)} isn't a cursor on this board`,
      "invalid_cursor",
    );
  }
  return boundaryOf(entry);
}

/**
 * Resolve a channel-messages cursor: the composite pair for an empty page, or
 * a message id of this channel, whose sequence the read continues from.
 */
async function resolveFeedSeq(
  store: BoardStore,
  raw: string,
  channel: string,
): Promise<number> {
  if (raw === EMPTY_CURSOR) return 0;
  const asMessage = decodeMessageCursor(raw);
  if (!asMessage.ok) {
    throw badRequest(
      `${JSON.stringify(raw)} isn't a cursor on this board`,
      "invalid_cursor",
    );
  }
  const entry = await store.entryById(asMessage.value);
  if (entry === null || entry.meta.channel !== channel) {
    throw badRequest(
      `${JSON.stringify(raw)} isn't a cursor on this board`,
      "invalid_cursor",
    );
  }
  return entry.row.seq;
}

/**
 * The threads and messages routes, as one table the backend registry spreads
 * in. Sibling groups (the event feed, tasks, watchers, sync records) land as
 * their own tables beside this one.
 */
export function threadsRoutes(store: BoardStore): Partial<ProtocolMethods> {
  /** The message entry an id names, held to the caller's readability. */
  const readableEntry = async (
    identity: RouteIdentity,
    id: string,
  ): Promise<MessageEntry> => {
    const entry = await store.entryById(id);
    if (entry === null)
      throw new HttpError(404, "message_not_found", `message not found: ${id}`);
    ensureReadable(identity.access, entry.meta.channel);
    return entry;
  };

  /** The author record a message carries, from its persisted card. */
  const authorOf = (entry: MessageEntry): AuthorRecord | null =>
    store.authorForSlug(entry.row.issue.created_by ?? null)?.by ?? null;

  /** The caller's own post with a client id, as a retry gets it back. */
  const findOwnPost = async (
    identity: RouteIdentity,
    clientId: string,
    place: { channel: string; thread: string | null; replyTo: string | null },
  ): Promise<MessageView | null> => {
    const found = await store.rows([
      "list",
      "--has-metadata-key",
      `${store.codec.namespace}.client`,
    ]);
    for (const row of found) {
      const entry = await store.entryById(row.issue.id);
      if (entry === null || entry.meta.client !== clientId) continue;
      const author = authorOf(entry);
      const samePlace =
        entry.meta.channel === place.channel &&
        entry.meta.thread === (place.thread ?? entry.row.issue.id) &&
        entry.meta.parent === place.replyTo;
      if (author === null || !wroteAs(author, identity) || !samePlace) {
        throw conflict(
          "duplicate_id",
          "that id was already used for a different write",
        );
      }
      const view = store.view(entry);
      if (!view.ok) {
        throw conflict(
          "duplicate_id",
          "that id was already used for a different write",
        );
      }
      return view.value;
    }
    return null;
  };

  /** Create one message issue (root or reply), once the fences have held. */
  const createMessage = async (
    input:
      | {
          kind: "root";
          actor: string;
          channel: string;
          labels: [string, string][];
          client: string | null;
          noSync: boolean;
          text: string;
        }
      | {
          kind: "reply";
          actor: string;
          channel: string;
          labels: [string, string][];
          thread: string;
          parent: string;
          after: string | null;
          client: string | null;
          noSync: boolean;
          text: string;
        },
  ): Promise<MessageEntry> => {
    const seq = await store.nextSeq();
    const issueId = await createIssue(store, {
      title: deriveTitle(input.text),
      description: input.text,
      actor: input.actor,
      dep:
        input.kind === "reply" && store.state().repliesTo ? input.parent : null,
    });
    const meta =
      input.kind === "root"
        ? initialMessageMeta({
            channel: input.channel,
            thread: issueId,
            client: input.client,
            noSync: input.noSync,
          })
        : initialMessageMeta({
            channel: input.channel,
            thread: input.thread,
            parent: input.parent,
            after: input.after,
            client: input.client,
            noSync: input.noSync,
          });
    await addBdLabel(store, issueId, channelLabel(input.channel), input.actor);
    if (input.kind === "root") {
      await addBdLabel(store, issueId, rootLabel(), input.actor);
    }
    for (const [name, value] of input.labels) {
      await addBdLabel(store, issueId, bdLabelOf(name, value), input.actor);
    }
    await writeMeta(store, issueId, meta, seq, input.actor);
    const entry = await store.entryById(issueId);
    if (entry === null) {
      throw new HttpError(
        500,
        "internal",
        "the message just written doesn't read back",
      );
    }
    return entry;
  };

  const table: Partial<ProtocolMethods> = {
    /** Where the board is: its URL, and what it syncs (none, until sync lands). */
    async discovery(): Promise<Discovery> {
      await store.ensureReady();
      const board = store.binding();
      const url = board?.url() ?? IN_PROCESS_URL;
      const project =
        board !== null ? await board.project() : { id: null, teamId: null };
      return {
        version: BACKEND_VERSION,
        url,
        audience: url,
        team_id: project.teamId,
        project_id: project.id,
        sync: board !== null ? board.sync.map((entry) => ({ ...entry })) : [],
      };
    },

    /** Who this caller writes as, and what it may do. */
    async me(caller): Promise<Me> {
      const identity = identityOf(caller);
      return {
        actor: identity.actorId,
        principal: identity.principalId,
        kind: identity.card.kind as Protocol["me"]["output"]["kind"],
        handle: identity.card.handle,
        name: identity.card.name,
        avatar: identity.card.avatar,
        profile: identity.profile,
        expiresAt: identity.expiresAt,
        can: identity.access.summary(),
      };
    },

    /** A page of the board's channels: the ones this caller may read. */
    async channels(caller, query): Promise<ChannelsPage> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const answer = await store.run(["label", "list-all", "--json"]);
      const data = answer.data;
      const raws = Array.isArray(data) ? data : [];
      const prefix = `${store.codec.namespace}.channel=`;
      const paths: string[] = [];
      for (const raw of raws) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw))
          continue;
        const label = (raw as Record<string, unknown>).label;
        if (typeof label !== "string" || !label.startsWith(prefix)) continue;
        paths.push(label.slice(prefix.length));
      }
      const visible = paths
        .filter((path) => identity.access.readable(path))
        .filter(
          (path) => query.prefix === undefined || path.startsWith(query.prefix),
        )
        .filter((path) => query.after === undefined || path > query.after)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const limit = clampLimit(
        query.limit,
        CHANNELS_LIMIT_DEFAULT,
        CHANNELS_LIMIT_MAX,
      );
      const page = visible.slice(0, limit);
      const last = page.at(-1);
      return {
        channels: page.map((path) => ({ path })),
        cursor: "0",
        next: visible.length > limit && last !== undefined ? last : null,
      };
    },

    /** Makes a channel before anything posts to it, or finds the one that's there. */
    async createChannel(
      caller,
      body,
    ): Promise<Protocol["createChannel"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const channel = ensureChannel(body.path);
      ensurePermission(identity.access, "read", channel);
      ensurePermission(identity.access, "post", channel);
      const actor = await store.mapIdentity(identity);
      const created = await store.gate.run(`channel:${channel}`, async () => {
        const existing = await store.rows([
          "list",
          "--label",
          channelLabel(channel),
        ]);
        if (existing.length > 0) return false;
        // The marker is never a message: its bare create stays off the feed.
        const issueId = await createIssue(store, {
          title: `board-beads channel ${channel}`,
          description: "",
          actor,
          withoutJournal: true,
        });
        await addBdLabel(store, issueId, channelLabel(channel), actor);
        return true;
      });
      return { channel: { path: channel }, created };
    },

    /** Who has written here, held to what the caller can read. */
    async actors(caller): Promise<Protocol["actors"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const cards: ActorCard[] = [];
      if (identity.access.readsAll) {
        for (const [key, value] of Object.entries(
          store.state().assignments.principals,
        )) {
          if (!key.startsWith("card:")) continue;
          const card = store.parseCard(value);
          if (card !== null) cards.push(card);
        }
      } else {
        const seen = new Set<string>([identity.actorId]);
        const found = await store.rows([
          "list",
          "--has-metadata-key",
          `${store.codec.namespace}.role`,
        ]);
        for (const row of found) {
          const entry = await store.entryById(row.issue.id);
          if (entry === null) continue;
          if (identity.access.readable(entry.meta.channel)) {
            seen.add(entry.row.issue.created_by ?? "");
          }
        }
        for (const [key, value] of Object.entries(
          store.state().assignments.principals,
        )) {
          if (!key.startsWith("card:")) continue;
          const card = store.parseCard(value);
          if (card !== null && seen.has(card.actor)) cards.push(card);
        }
        if (!cards.some((card) => card.actor === identity.actorId)) {
          cards.push(identity.card);
        }
      }
      const actors = cards
        .map((card) => ({
          id: card.actor,
          kind: card.kind as Protocol["actors"]["output"]["actors"][number]["kind"],
          handle: card.handle,
          name: card.name,
          avatar: card.avatar,
        }))
        .sort((a, b) => a.handle.localeCompare(b.handle));
      return { actors, cursor: "0" };
    },

    /** One channel's messages across its threads, oldest first. */
    async channelMessages(
      caller,
      query,
    ): Promise<Protocol["channelMessages"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      if (query.channel.endsWith("/")) {
        throw badRequest(
          `${JSON.stringify(query.channel)} is a pattern: name one channel`,
        );
      }
      const channel = ensureChannel(query.channel);
      if (!identity.access.readable(channel)) {
        return { messages: [], cursor: EMPTY_CURSOR };
      }
      const entries = await store.channelEntries(channel);
      const limit = clampLimit(
        query.limit,
        THREADS_LIMIT_DEFAULT,
        THREADS_LIMIT_MAX,
      );
      let page: MessageEntry[];
      if (query.after !== undefined) {
        const since = await resolveFeedSeq(store, query.after, channel);
        page = entries.filter((entry) => entry.row.seq > since).slice(0, limit);
      } else {
        page = entries.slice(-limit);
      }
      const messages: MessageView[] = [];
      for (const entry of page) {
        const view = store.view(entry);
        if (view.ok) messages.push(view.value);
      }
      const last = page.at(-1);
      return {
        messages,
        cursor:
          last === undefined
            ? EMPTY_CURSOR
            : encodeMessageCursor(last.row.issue.id),
      };
    },

    /** Threads with a matching message, one summary each, by latest activity. */
    async threads(caller, query): Promise<ThreadsPage> {
      await store.ensureReady();
      const identity = identityOf(caller);
      if (
        query.by !== undefined ||
        query.mentions !== undefined ||
        query.text !== undefined ||
        query.from !== undefined
      ) {
        throw notSupportedHere("threads by by, mentions, text, or from");
      }
      if (query.channel === undefined && query.re === undefined) {
        throw notSupportedHere("threads across every channel at once");
      }
      if (query.channel !== undefined && query.channel.endsWith("/")) {
        throw notSupportedHere("threads across a channel pattern");
      }
      if (query.after !== undefined && query.before !== undefined) {
        throw badRequest(
          "before pages backward: a read takes no after with it",
        );
      }
      const limit = clampLimit(
        query.limit,
        THREADS_LIMIT_DEFAULT,
        THREADS_LIMIT_MAX,
      );

      // The channel the read answers, and the one thread a `re` read is held to.
      let channel: string;
      let onlyThread: string | null = null;
      if (query.re !== undefined) {
        const target = await readableEntry(identity, query.re);
        channel = target.meta.channel;
        onlyThread = target.meta.thread;
        if (query.channel !== undefined && query.channel !== channel) {
          return { threads: [], cursor: EMPTY_CURSOR, older: null };
        }
      } else {
        channel = ensureChannel(query.channel ?? "");
      }
      if (!identity.access.readable(channel)) {
        return { threads: [], cursor: EMPTY_CURSOR, older: null };
      }

      const entries = await store.channelEntries(channel);
      const threads = new Map<string, MessageEntry[]>();
      for (const entry of entries) {
        const members = threads.get(entry.meta.thread);
        if (members === undefined) threads.set(entry.meta.thread, [entry]);
        else members.push(entry);
      }

      const wanted = query.label ?? [];
      const summaries: {
        boundary: ThreadBoundary;
        summary: {
          root: MessageEntry;
          replies: number;
          last: MessageEntry | null;
        };
      }[] = [];
      for (const [rootId, members] of threads) {
        if (onlyThread !== null && rootId !== onlyThread) continue;
        const root = members.find((entry) => entry.row.issue.id === rootId);
        if (root === undefined) continue;
        const replies = members
          .filter((entry) => entry.row.issue.id !== rootId)
          .sort((a, b) => bySeq(a.row, b.row));
        const alive = replies.filter((entry) => !entry.meta.deleted);
        // A thread is in when any of its messages matches every label condition.
        if (wanted.length > 0) {
          const matched = [root, ...replies].some((entry) =>
            wanted.every(([name, want]) => {
              const have = entryLabels(store, entry)[name];
              return want === null ? have === undefined : want.includes(have);
            }),
          );
          if (!matched) continue;
        }
        const last = alive.at(-1) ?? null;
        summaries.push({
          boundary: boundaryOf(last ?? root),
          summary: { root, replies: alive.length, last },
        });
      }
      summaries.sort((a, b) => compareThreadBoundary(a.boundary, b.boundary));

      let windowed = summaries;
      if (query.after !== undefined) {
        const since = await resolveThreadBoundary(store, query.after, channel);
        windowed = summaries
          .filter((one) => compareThreadBoundary(one.boundary, since) > 0)
          .slice(0, limit);
      } else if (query.before !== undefined) {
        const boundary = decodeOlderCursor(query.before);
        if (!boundary.ok) {
          throw badRequest(
            `${JSON.stringify(query.before)} isn't a page of threads on this board`,
            "invalid_cursor",
          );
        }
        const older = summaries.filter(
          (one) => compareThreadBoundary(one.boundary, boundary.value) < 0,
        );
        windowed = older.slice(-limit);
      } else {
        windowed = summaries.slice(-limit);
      }

      const views: ThreadSummaryView[] = [];
      for (const one of windowed) {
        const root = store.view(one.summary.root);
        if (!root.ok) continue;
        const last =
          one.summary.last === null ? null : store.view(one.summary.last);
        views.push({
          message: root.value,
          replies: one.summary.replies,
          last: last !== null && last.ok ? last.value : null,
        });
      }
      const newest = windowed.at(-1);
      const cursor =
        newest === undefined
          ? EMPTY_CURSOR
          : encodeMessageCursor(
              (newest.summary.last ?? newest.summary.root).row.issue.id,
            );
      if (query.after !== undefined) {
        return { threads: views, cursor };
      }
      const oldest = windowed[0];
      const hasOlder =
        oldest !== undefined &&
        summaries.some(
          (one) => compareThreadBoundary(one.boundary, oldest.boundary) < 0,
        );
      return {
        threads: views,
        cursor,
        older:
          oldest !== undefined && hasOlder
            ? encodeOlderCursor(oldest.boundary)
            : null,
      };
    },

    /** The thread around any message: its root, and its replies in order. */
    async message(caller, query): Promise<ThreadView> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const entry = await readableEntry(identity, query.id);
      const rootId = entry.meta.thread;
      const root = rootId === query.id ? entry : await store.entryById(rootId);
      if (root === null)
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${query.id}`,
        );
      ensureReadable(identity.access, root.meta.channel);
      const replies = (await store.channelEntries(root.meta.channel))
        .filter(
          (one) => one.meta.thread === rootId && one.row.issue.id !== rootId,
        )
        .sort((a, b) => bySeq(a.row, b.row));
      const limit = clampLimit(
        query.limit,
        THREADS_LIMIT_DEFAULT,
        THREADS_LIMIT_MAX,
      );
      let page: MessageEntry[];
      if (query.after === undefined) {
        page = replies.slice(-limit);
      } else {
        const at = replies.findIndex((one) => one.row.issue.id === query.after);
        const atRoot = root.row.issue.id === query.after;
        if (at === -1 && !atRoot) {
          throw badRequest(
            `after: ${query.after} isn't a message of this thread`,
          );
        }
        const from = atRoot ? 0 : at + 1;
        page = replies.slice(from, from + limit);
      }
      const rootView = store.view(root);
      if (!rootView.ok)
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${query.id}`,
        );
      const replyViews: MessageView[] = [];
      for (const one of page) {
        const view = store.view(one);
        if (view.ok) replyViews.push(view.value);
      }
      const last = page.at(-1) ?? root;
      return {
        message: rootView.value,
        replies: replyViews,
        cursor: encodeMessageCursor(last.row.issue.id),
      };
    },

    /** The caller's own post with a client id, as it landed. */
    async posted(caller, body): Promise<Protocol["posted"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const found = await store.rows([
        "list",
        "--has-metadata-key",
        `${store.codec.namespace}.client`,
      ]);
      for (const row of found) {
        const entry = await store.entryById(row.issue.id);
        if (entry === null || entry.meta.client !== body.id) continue;
        const author = authorOf(entry);
        if (author === null || !wroteAs(author, identity)) continue;
        ensureReadable(identity.access, entry.meta.channel);
        const view = store.view(entry);
        if (!view.ok) break;
        return { message: view.value };
      }
      throw new HttpError(
        404,
        "post_not_found",
        `no post of yours has id ${body.id}`,
      );
    },

    /** Post or reply: the fences hold while the write lands. */
    async post(caller, input): Promise<Protocol["post"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureTextFits(input.text);
      ensureTextPresent(input.text);
      if ((input.attachments?.length ?? 0) > 0) {
        throw noFilesHere("posts carry no files here");
      }
      if (input.sync !== undefined && input.sync.length > 0) {
        throw notSupportedHere("a post's sync targets");
      }
      const labelGuard = createLabels({
        namespace: store.codec.namespace,
      }).guardCallerLabels(input.labels ?? {});
      if (!labelGuard.ok) throw labelRefusal(labelGuard.error);
      for (const [name, value] of Object.entries(input.labels ?? {})) {
        ensureLabelCarryable(name, value);
      }
      const actor = await store.mapIdentity(identity);

      // A reply lands in its root's thread, never where a request says.
      if (input.re !== undefined) {
        if (input.channel !== undefined) {
          throw badRequest("a post takes channel or re, never both");
        }
        const re = input.re;
        const target = await replyTarget(store, identity, re);
        ensurePermission(identity.access, "post", target.meta.channel);
        if (Object.keys(input.labels ?? {}).length > 0) {
          ensurePermission(identity.access, "label", target.meta.channel);
        }
        const rootId = target.meta.thread;
        const root = await store.entryById(rootId);
        if (root === null)
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${rootId}`,
          );
        const place = {
          channel: target.meta.channel,
          thread: rootId,
          replyTo: re,
        };
        const run = async (): Promise<MessageView> => {
          if (input.id !== undefined) {
            const replay = await findOwnPost(identity, input.id, place);
            if (replay !== null) return replay;
          }
          const landed = await store.gate.run(`thread:${rootId}`, async () => {
            if (input.id !== undefined) {
              const again = await findOwnPost(identity, input.id, place);
              if (again !== null) return again;
            }
            const members = (await store.channelEntries(place.channel)).filter(
              (one) => one.meta.thread === rootId,
            );
            const replies = members
              .filter((one) => one.row.issue.id !== rootId)
              .sort((a, b) => bySeq(a.row, b.row));
            const newest = replies.at(-1) ?? root;
            let after: string;
            if (input.after !== undefined) {
              const named = members.find(
                (one) => one.row.issue.id === input.after,
              );
              if (named === undefined) {
                throw badRequest(
                  `after: ${input.after} isn't a message of this thread`,
                  "invalid_after",
                );
              }
              if (newest.row.issue.id !== input.after) {
                throw conflict(
                  "newer_message",
                  `${newest.row.issue.id} came after it`,
                );
              }
              after = input.after;
            } else {
              after = newest.row.issue.id;
            }
            const raced = checkReplyAfter(
              replies.map((one) => ({
                id: one.row.issue.id,
                after: one.meta.after,
              })),
              after,
            );
            if (raced !== null) {
              throw raced.code === "newer_message"
                ? conflict("newer_message", `${raced.newer} came after it`)
                : conflict(raced.code, "the reply raced another write");
            }
            const entry = await createMessage({
              kind: "reply",
              actor,
              channel: place.channel,
              labels: Object.entries(input.labels ?? {}),
              thread: rootId,
              parent: re,
              after,
              client: input.id ?? null,
              noSync: input.noSync ?? false,
              text: input.text,
            });
            const view = store.view(entry);
            if (!view.ok) {
              throw new HttpError(
                500,
                "internal",
                "the reply just written doesn't read back",
              );
            }
            return view.value;
          });
          return landed;
        };
        const message =
          input.id !== undefined
            ? await store.gate.run(`client:${input.id}`, run)
            : await run();
        return { message };
      }

      // A root starts a thread in the channel it names, which the caller needn't read.
      if (input.channel === undefined)
        throw badRequest("a post needs a channel");
      if (input.after !== undefined) {
        throw badRequest("after is for replies", "invalid_after");
      }
      const channel = ensureChannel(input.channel);
      ensurePermission(identity.access, "post", channel);
      if (Object.keys(input.labels ?? {}).length > 0) {
        ensurePermission(identity.access, "label", channel);
      }
      const place = { channel, thread: null, replyTo: null };
      const run = async (): Promise<MessageView> => {
        if (input.id !== undefined) {
          const replay = await findOwnPost(identity, input.id, place);
          if (replay !== null) return replay;
        }
        const entry = await createMessage({
          kind: "root",
          actor,
          channel,
          labels: Object.entries(input.labels ?? {}),
          client: input.id ?? null,
          noSync: input.noSync ?? false,
          text: input.text,
        });
        const view = store.view(entry);
        if (!view.ok) {
          throw new HttpError(
            500,
            "internal",
            "the post just written doesn't read back",
          );
        }
        return view.value;
      };
      const message =
        input.id !== undefined
          ? await store.gate.run(`client:${input.id}`, run)
          : await run();
      return { message };
    },

    /** Edit: the author's own text, fenced at its revision. */
    async edit(caller, input): Promise<Protocol["edit"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      ensureTextFits(input.text);
      ensureTextPresent(input.text);
      const actor = await store.mapIdentity(identity);
      await store.gate.run(`issue:${input.id}`, async () => {
        const entry = await store.entryById(input.id);
        if (entry === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${input.id}`,
          );
        }
        ensureReadable(identity.access, entry.meta.channel);
        const author = authorOf(entry);
        if (author === null || !wroteAs(author, identity)) {
          throw forbidden("only the author can edit a message");
        }
        if (entry.meta.deleted) {
          if (
            input.revision !== undefined &&
            input.revision !== entry.meta.revision
          ) {
            throw revisionConflictAt(entry.meta.revision);
          }
          throw badRequest("message was deleted", "message_deleted");
        }
        const fence = checkRevisionFence(entry.meta, input.revision);
        if (fence !== null) throw revisionConflictAt(fence.revision);
        const next = applyEdit(entry.meta, new Date().toISOString());
        const encoded = store.codec.encodeMessage(next);
        if (!encoded.ok) {
          throw badRequest(
            `the message's metadata is too large to store (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
          );
        }
        const blob: Record<string, JsonValue> = {
          ...encoded.value,
          [`${store.codec.namespace}.seq`]: entry.row.seq,
        };
        await store.run(
          [
            "update",
            input.id,
            `--title=${deriveTitle(input.text)}`,
            `--description=${input.text}`,
            `--metadata=${JSON.stringify(blob)}`,
            "--json",
          ],
          actor,
        );
      });
      return { ok: true };
    },

    /** Delete: a tombstone, never a removal. Deleting again is nothing. */
    async delete(caller, input): Promise<Protocol["delete"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const actor = await store.mapIdentity(identity);
      await store.gate.run(`issue:${input.id}`, async () => {
        const entry = await store.entryById(input.id);
        if (entry === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${input.id}`,
          );
        }
        ensureReadable(identity.access, entry.meta.channel);
        const author = authorOf(entry);
        if (author === null || !wroteAs(author, identity)) {
          throw forbidden("only the author can delete a message");
        }
        if (entry.meta.deleted) {
          if (
            input.revision !== undefined &&
            input.revision !== entry.meta.revision
          ) {
            throw revisionConflictAt(entry.meta.revision);
          }
          return;
        }
        const fence = checkRevisionFence(entry.meta, input.revision);
        if (fence !== null) throw revisionConflictAt(fence.revision);
        // The tombstone: flagged, blank, unlabeled — but still readable, so
        // its thread keeps its place and its id keeps answering.
        await store.run(
          ["update", input.id, "--description=", "--json"],
          actor,
        );
        for (const label of entry.row.labels) {
          const at = label.indexOf("=");
          const name = at === -1 ? label : label.slice(0, at);
          if (!store.labels.isOwnLabel(name)) {
            await store.run(["label", "remove", input.id, label], actor);
          }
        }
        await writeMeta(
          store,
          input.id,
          applyDelete(entry.meta),
          entry.row.seq,
          actor,
        );
      });
      return { ok: true };
    },

    /** React: a version bump on the message, revision untouched. */
    async react(caller, input): Promise<Protocol["react"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const actor = await store.mapIdentity(identity);
      await store.gate.run(`issue:${input.id}`, async () => {
        const entry = await store.entryById(input.id);
        if (entry === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${input.id}`,
          );
        }
        ensureReadable(identity.access, entry.meta.channel);
        ensurePermission(identity.access, "react", entry.meta.channel);
        if (entry.meta.deleted)
          throw badRequest("message was deleted", "message_deleted");
        await writeMeta(
          store,
          input.id,
          applyReaction(
            entry.meta,
            input.emoji,
            identity.actorId,
            input.remove ?? false,
          ),
          entry.row.seq,
          actor,
        );
      });
      return { ok: true };
    },

    /** Label: bd labels under the caller's namespaces, fenced by `if`. */
    async label(caller, input): Promise<Protocol["label"]["output"]> {
      await store.ensureReady();
      const identity = identityOf(caller);
      const actor = await store.mapIdentity(identity);
      const api = createLabels({ namespace: store.codec.namespace });
      const setEntries = Object.entries(input.set ?? {});
      const unset = input.unset ?? [];
      for (const [name, value] of setEntries) {
        const refusal = api.guardCallerLabel(name);
        if (refusal !== null) throw labelRefusal(refusal);
        ensureLabelCarryable(name, value);
      }
      for (const name of unset) {
        const refusal = api.guardCallerLabel(name);
        if (refusal !== null) throw labelRefusal(refusal);
        ensureLabelCarryable(name, undefined);
      }
      const conditions = Object.entries(input.if ?? {});
      if (conditions.length > LABEL_CONDITIONS_MAX) {
        throw badRequest(
          `a label write checks ${LABEL_CONDITIONS_MAX} labels at most`,
        );
      }
      await store.gate.run(`issue:${input.id}`, async () => {
        const entry = await store.entryById(input.id);
        if (entry === null) {
          throw new HttpError(
            404,
            "message_not_found",
            `message not found: ${input.id}`,
          );
        }
        ensureReadable(identity.access, entry.meta.channel);
        ensurePermission(identity.access, "label", entry.meta.channel);
        if (entry.meta.deleted)
          throw badRequest("message was deleted", "message_deleted");
        const current = entryLabels(store, entry);
        for (const [name, want] of conditions) {
          const have = current[name];
          const holds = want === null ? have === undefined : have === want;
          if (holds) continue;
          throw conflict(
            "label_conflict",
            want === null
              ? `${name} is set`
              : have === undefined
                ? `${name} isn't set`
                : `${name} isn't ${want}`,
          );
        }
        await applyBdLabels(
          store,
          input.id,
          actor,
          setEntries,
          unset,
          entry.row.labels,
        );
        await writeMeta(
          store,
          input.id,
          applyLabelsChanged(entry.meta),
          entry.row.seq,
          actor,
        );
      });
      return { ok: true };
    },
  };
  // The sweep bar's contract lives here: every route bd failures break out
  // of answers typed 503 `unavailable` naming the fix, never a raw
  // transport error the serving layer would report as 500 `internal`.
  return guardBdRoutes(table);
}

/** The message a reply answers, held to the caller's readability. */
async function replyTarget(
  store: BoardStore,
  identity: RouteIdentity,
  re: string,
): Promise<MessageEntry> {
  const target = await store.entryById(re);
  if (target === null) {
    throw new HttpError(404, "message_not_found", `message not found: ${re}`);
  }
  ensureReadable(identity.access, target.meta.channel);
  return target;
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function revisionConflictAt(revision: number): HttpError {
  return conflict(
    "revision_conflict",
    `the message moved past revision ${revision}`,
  );
}

function notSupportedHere(what: string): HttpError {
  return new HttpError(501, "not_supported", `${what} isn't kept here`);
}

function noFilesHere(what: string): HttpError {
  return new HttpError(501, "no_files", `this board keeps no files: ${what}`);
}

/** Set and unset caller labels on an issue, as bd carries them. */
async function applyBdLabels(
  store: BoardStore,
  id: string,
  actor: string,
  set: [string, string][],
  unset: string[],
  stored: readonly string[],
): Promise<void> {
  for (const [name, value] of set) {
    await store.run(["label", "add", id, bdLabelOf(name, value)], actor);
  }
  // bd removes a label only by its exact stored string (`name=value`, or a
  // bare `name`): removing by the caller's bare name is a silent no-op.
  for (const name of unset) {
    for (const label of stored) {
      if (label === name || label.startsWith(`${name}=`)) {
        await store.run(["label", "remove", id, label], actor);
      }
    }
  }
}
