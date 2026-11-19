import type { MessageView, PostInput } from "@vercel/board";

/** Board label map exactly as the protocol carries it: name → value (`""` for a bare label). */
export type BoardLabels = NonNullable<PostInput["labels"]>;

/** The author of a message, as Board's views show it. */
export type MessageAuthor = NonNullable<MessageView["author"]>;

/** The message's writing identity, as views carry it (`by`). */
export type BoardAuthor = MessageView["by"];

/** What the model's author lookup yields: the identity and the display card. */
export interface MessageAuthorIdentity {
  by: BoardAuthor;
  view: MessageAuthor;
}

/** Where a message came from on a platform, as views carry it. */
export type MessageOrigin = MessageView["origin"];

/** Any JSON value — the only shapes a metadata blob may contain. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A message's metadata, in its logical (namespace-free) shape. The codec maps these
 * fields onto `<namespace>.<field>` keys of the issue's one metadata blob, versioned
 * `<namespace>.v: 1`, owned entirely by the backend.
 */
export interface MessageMeta {
  role: "message";
  /** The board channel the message lives in. */
  channel: string;
  /** The thread key: the root issue's id; a root carries its own id here. */
  thread: string;
  /** Conversational parent issue id (mirrors the native replies-to dep); null on a root. */
  parent: string | null;
  /** Positional predecessor in the thread's reply order; null on a root. */
  after: string | null;
  /** The post's client id, so `posted` finds the caller's own write again. */
  client: string | null;
  /** The sync key the message came from, or null when written on the board. */
  from: string | null;
  /** Platform origin, stored exactly as Board views carry it. */
  origin: JsonValue;
  /** The post's noSync flag. */
  noSync: boolean;
  /** Grows with every change to the message. */
  version: number;
  /** Grows only on an edit or a delete — the fence those writes carry. */
  revision: number;
  /** When the last edit landed, or null. */
  editedAt: string | null;
  /** The tombstone: a deleted message stays readable with this set. */
  deleted: boolean;
  /** Emoji → the actors that reacted. */
  reactions: Record<string, string[]>;
  /** Sync external refs: per target, where the message's copy lives on the platform. */
  external: Record<string, { thread: string; message: string | null }>;
  /** The issue's claim counter (tasks); 0 while it has never been claimed. */
  epoch: number;
  /** The live claim's fencing state, or null. */
  claim: { epoch: number; token: string; until: string } | null;
}

/**
 * The backend's own bookkeeping issue (e.g. the actor map), so state survives restarts.
 * One issue per kind, recognizable by its `role`.
 */
export interface BackendMeta {
  role: "backend";
  kind: "actors";
  /** Principal → BEADS_ACTOR slug, bijective. */
  actors: Record<string, string>;
}

/**
 * A bd issue, as `bd list --json` / `bd show --json` emit it. Only the fields the model
 * reads are named; the transport (not this layer) owns tolerant parsing of bd's raw output.
 */
export interface BdIssue {
  id: string;
  title?: string;
  description?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
  /** The issue's metadata blob, exactly as bd returned it: never trusted, always decoded. */
  metadata?: unknown;
  dependency_count?: number;
  dependent_count?: number;
}

/** What one bd invocation returned: exit code with its streams. */
export interface BdRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A bd runner, structurally — the test fixture's `run` and the transport's both fit.
 * The model layer never spawns processes itself; it hands args to one of these.
 */
export type BdRunFn = (
  args: string[],
  options?: { journal?: boolean },
) => Promise<BdRunResult>;

/** Whether the installed bd writes native `replies-to` dep links, as a live probe found. */
export interface ThreadCapability {
  repliesTo: boolean;
}

/** The only failure a cursor decode ever reports. */
export type InvalidCursor = { ok: false; code: "invalid_cursor" };

export type CursorResult<T> = { ok: true; value: T } | InvalidCursor;

/** A read that can miss: the issue behind a message id isn't there. */
export type NotFound = { ok: false; code: "not_found" };

export type ReadResult<T> = { ok: true; value: T } | NotFound;

/** A caller label the backend refuses: Board's reserved prefix, ours, or unencodable. */
export type LabelRefusal =
  | { code: "reserved_label"; label: string }
  | { code: "invalid_label"; label: string };

export type LabelGuardResult =
  { ok: true } | { ok: false; error: LabelRefusal };

/**
 * A principal's mapping refused: the slug it would take is already held by someone
 * else (`heldBy` names them; null when it is a reserved slug, e.g. the system actor's),
 * or the principal itself is unusable.
 */
export type ActorMapError =
  | {
      code: "actor_collision";
      principal: string;
      slug: string;
      heldBy: string | null;
    }
  | { code: "invalid_principal"; principal: string };

export type MapPrincipalResult =
  | { ok: true; value: { assignments: ActorAssignments; slug: string } }
  | { ok: false; error: ActorMapError };

/** The assignment map, as the backend-metadata issue stores it. */
export interface ActorAssignments {
  readonly principals: Readonly<Record<string, string>>;
}

/**
 * A fenced write that lost its race: which protocol 409 the loser answers.
 * - `newer_message`: another reply already took the `after` slot this reply wanted.
 * - `label_conflict`: a label write's `if` no longer matches the message.
 * - `revision_conflict`: an edit or delete at a revision something came after.
 */
export type Conflict =
  | { code: "newer_message"; newer: string }
  | { code: "label_conflict"; label: string }
  | { code: "revision_conflict"; revision: number };

/** A metadata blob the size guard refused before a write was attempted. */
export type MetadataTooLarge = {
  code: "metadata_too_large";
  bytes: number;
  limit: number;
};

export type EncodeResult<T> =
  { ok: true; value: T } | { ok: false; error: MetadataTooLarge };

/** Why a metadata blob isn't usable: each reason is typed, none throws. */
export type MetadataReason =
  "absent" | "corrupt" | "foreign" | "unsupported_version";

export type MetadataDecodeResult<T> =
  { ok: true; value: T } | { ok: false; reason: MetadataReason };

/**
 * One codec bound to a namespace: the prefix every metadata key wears (`bb` by default,
 * parameterized so one tracker can host boards with separate namespaces).
 */
export interface MetadataCodec {
  readonly namespace: string;
  /** Encode message metadata into bd's metadata object, size-guarded. */
  encodeMessage(meta: MessageMeta): EncodeResult<Record<string, JsonValue>>;
  /** Encode the backend-metadata issue (e.g. the actor map), size-guarded. */
  encodeBackend(meta: BackendMeta): EncodeResult<Record<string, JsonValue>>;
  /** Decode a raw metadata blob into typed metadata; every failure is a reason, none throws. */
  decode(raw: unknown): MetadataDecodeResult<MessageMeta | BackendMeta>;
}

/**
 * A label set bound to one backend namespace. Ours is `bb` by default and takes a
 * parameter so one tracker can host boards with separate namespaces. Our bd labels
 * (`<namespace>.*`) are backend-owned: callers may not set them, and they never leak
 * into caller-visible label maps.
 */
export interface LabelsApi {
  readonly namespace: string;
  /** Whether a bd label name belongs to this backend's namespace. */
  isOwnLabel(name: string): boolean;
  /** One caller label name, as `set`, `unset`, and `if` carries them. */
  guardCallerLabel(name: string): LabelRefusal | null;
  /** Every caller label name in a label write's `set`. */
  guardCallerLabels(labels: BoardLabels): LabelGuardResult;
  /** Board labels → bd label strings: `name=value` with a value, bare without. */
  toBdLabels(labels: BoardLabels): string[];
  /** bd label strings → caller-visible labels: ours filtered, everything else mapped. */
  fromBdLabels(bdLabels: readonly string[]): BoardLabels;
}
