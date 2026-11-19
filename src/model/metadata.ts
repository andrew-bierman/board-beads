import type {
  BackendMeta,
  EncodeResult,
  JsonValue,
  MessageMeta,
  MetadataCodec,
  MetadataDecodeResult,
  MetadataTooLarge,
} from "./types.ts";

/**
 * The backend's metadata schema version. Every blob the backend writes carries it as
 * `<namespace>.v`; a different number means a schema this build can't read.
 */
export const METADATA_SCHEMA_VERSION = 1;

/**
 * Conservative ceiling for one metadata blob, in serialized UTF-8 bytes.
 *
 * Why 64 KiB: bd metadata travels as a single `--metadata` argv element, and Linux caps a
 * single argument at MAX_ARG_STRLEN (32 pages, 128 KiB). Half of that leaves room for the
 * rest of the command line and keeps the guard off the edge.
 */
export const METADATA_BYTE_LIMIT: number = 64 * 1024;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

const isFiniteInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const isReactions = (value: unknown): value is Record<string, string[]> => {
  if (!isPlainObject(value)) return false;
  for (const actors of Object.values(value)) {
    if (!Array.isArray(actors)) return false;
    for (const actor of actors) if (typeof actor !== "string") return false;
  }
  return true;
};

const isExternal = (
  value: unknown,
): value is Record<string, { thread: string; message: string | null }> => {
  if (!isPlainObject(value)) return false;
  for (const ref of Object.values(value)) {
    if (!isPlainObject(ref)) return false;
    const fields = ref as Record<string, unknown>;
    if (typeof fields.thread !== "string") return false;
    if (!isStringOrNull(fields.message)) return false;
  }
  return true;
};

const isClaim = (
  value: unknown,
): value is { epoch: number; token: string; until: string } | null => {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  const claim = value as Record<string, unknown>;
  return (
    isFiniteInt(claim.epoch) &&
    typeof claim.token === "string" &&
    typeof claim.until === "string"
  );
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
};

/** Build a message's first metadata state: version 1, revision 1, nothing deleted. */
export function initialMessageMeta(input: {
  channel: string;
  /** The thread key: the root issue's id; a root carries its own id here. */
  thread: string;
  /** Conversational parent (mirrors the replies-to dep); null on a root. */
  parent?: string | null;
  /** Positional predecessor in the thread's reply order; null on a root. */
  after?: string | null;
  /** The post's client id, for `posted` idempotency. */
  client?: string | null;
  /** The sync key it came from, when a sync wrote it. */
  from?: string | null;
  /** Platform origin, stored as Board shows it. */
  origin?: unknown;
  noSync?: boolean;
}): MessageMeta {
  return {
    role: "message",
    channel: input.channel,
    thread: input.thread,
    parent: input.parent ?? null,
    after: input.after ?? null,
    client: input.client ?? null,
    from: input.from ?? null,
    origin: isJsonValue(input.origin) ? (input.origin ?? null) : null,
    noSync: input.noSync ?? false,
    version: 1,
    revision: 1,
    editedAt: null,
    deleted: false,
    reactions: {},
    external: {},
    epoch: 0,
    claim: null,
  };
}

/** Build the backend-metadata issue's first state (the actor map's home). */
export function initialBackendMeta(): BackendMeta {
  return { role: "backend", kind: "actors", actors: {} };
}

/** An edit: version and revision both grow, and the edit time is stamped. */
export function applyEdit(meta: MessageMeta, editedAt: string): MessageMeta {
  return {
    ...meta,
    version: meta.version + 1,
    revision: meta.revision + 1,
    editedAt,
  };
}

/** A delete: the tombstone goes up and both counters grow; the text stays as stored. */
export function applyDelete(meta: MessageMeta): MessageMeta {
  return {
    ...meta,
    deleted: true,
    version: meta.version + 1,
    revision: meta.revision + 1,
  };
}

/**
 * A reaction: version grows, revision doesn't. Board folds every reaction event, so the
 * bump is unconditional — the fold dedupes the actor list, the version tracks the event.
 */
export function applyReaction(
  meta: MessageMeta,
  emoji: string,
  actor: string,
  remove?: boolean,
): MessageMeta {
  const current = meta.reactions[emoji] ?? [];
  const actors = remove
    ? current.filter((a) => a !== actor)
    : current.includes(actor)
      ? current
      : [...current, actor];
  return {
    ...meta,
    version: meta.version + 1,
    reactions: { ...meta.reactions, [emoji]: actors },
  };
}

/** A label add/remove rides bd labels, but it is a change to the message: version grows. */
export function applyLabelsChanged(meta: MessageMeta): MessageMeta {
  return { ...meta, version: meta.version + 1 };
}

/**
 * The edit/delete fence: a write that names a `revision` lands only if nothing has come
 * after it. A stale one answers the current revision for the 409.
 */
export function checkRevisionFence(
  meta: MessageMeta,
  expected?: number,
): { code: "revision_conflict"; revision: number } | null {
  if (expected === undefined) return null;
  return expected === meta.revision
    ? null
    : { code: "revision_conflict", revision: meta.revision };
}

/** The serialized size of a metadata blob, in UTF-8 bytes. */
function blobBytes(record: Record<string, JsonValue>): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function tooLarge(record: Record<string, JsonValue>): MetadataTooLarge | null {
  const bytes = blobBytes(record);
  return bytes > METADATA_BYTE_LIMIT
    ? { code: "metadata_too_large", bytes, limit: METADATA_BYTE_LIMIT }
    : null;
}

export function createMetadataCodec(options?: {
  namespace?: string;
}): MetadataCodec {
  const ns = options?.namespace ?? "bb";
  const key = (field: string): string => `${ns}.${field}`;

  const encodeMessage = (
    meta: MessageMeta,
  ): EncodeResult<Record<string, JsonValue>> => {
    const record: Record<string, JsonValue> = {
      [key("v")]: METADATA_SCHEMA_VERSION,
      [key("role")]: "message",
      [key("channel")]: meta.channel,
      [key("thread")]: meta.thread,
      [key("parent")]: meta.parent,
      [key("after")]: meta.after,
      [key("client")]: meta.client,
      [key("from")]: meta.from,
      [key("origin")]: meta.origin,
      [key("noSync")]: meta.noSync,
      [key("version")]: meta.version,
      [key("revision")]: meta.revision,
      [key("editedAt")]: meta.editedAt,
      [key("deleted")]: meta.deleted,
      [key("reactions")]: meta.reactions,
      [key("external")]: meta.external,
      [key("epoch")]: meta.epoch,
      [key("claim")]: meta.claim,
    };
    const limit = tooLarge(record);
    return limit ? { ok: false, error: limit } : { ok: true, value: record };
  };

  const encodeBackend = (
    meta: BackendMeta,
  ): EncodeResult<Record<string, JsonValue>> => {
    const record: Record<string, JsonValue> = {
      [key("v")]: METADATA_SCHEMA_VERSION,
      [key("role")]: "backend",
      [key("kind")]: meta.kind,
      [key("actors")]: meta.actors,
    };
    const limit = tooLarge(record);
    return limit ? { ok: false, error: limit } : { ok: true, value: record };
  };

  const decode = (
    raw: unknown,
  ): MetadataDecodeResult<MessageMeta | BackendMeta> => {
    let blob: unknown = raw;
    if (blob === undefined || blob === null)
      return { ok: false, reason: "absent" };
    if (typeof blob === "string") {
      try {
        blob = JSON.parse(blob) as unknown;
      } catch {
        return { ok: false, reason: "corrupt" };
      }
    }
    if (!isPlainObject(blob)) return { ok: false, reason: "corrupt" };

    const version = blob[key("v")];
    if (version === undefined) return { ok: false, reason: "foreign" };
    if (typeof version !== "number") return { ok: false, reason: "corrupt" };
    if (version !== METADATA_SCHEMA_VERSION) {
      return { ok: false, reason: "unsupported_version" };
    }

    const role = blob[key("role")];
    if (role === "message") {
      const m = blob as Record<string, unknown>;
      if (
        typeof m[key("channel")] !== "string" ||
        typeof m[key("thread")] !== "string" ||
        !isStringOrNull(m[key("parent")]) ||
        !isStringOrNull(m[key("after")]) ||
        !isStringOrNull(m[key("client")]) ||
        !isStringOrNull(m[key("from")]) ||
        !isJsonValue(m[key("origin")]) ||
        !isBoolean(m[key("noSync")]) ||
        !isFiniteInt(m[key("version")]) ||
        !isFiniteInt(m[key("revision")]) ||
        !isStringOrNull(m[key("editedAt")]) ||
        !isBoolean(m[key("deleted")]) ||
        !isReactions(m[key("reactions")]) ||
        !isExternal(m[key("external")]) ||
        !isFiniteInt(m[key("epoch")]) ||
        !isClaim(m[key("claim")])
      ) {
        return { ok: false, reason: "corrupt" };
      }
      return {
        ok: true,
        value: {
          role: "message",
          channel: m[key("channel")] as string,
          thread: m[key("thread")] as string,
          parent: m[key("parent")] as string | null,
          after: m[key("after")] as string | null,
          client: m[key("client")] as string | null,
          from: m[key("from")] as string | null,
          origin: m[key("origin")] as JsonValue,
          noSync: m[key("noSync")] as boolean,
          version: m[key("version")] as number,
          revision: m[key("revision")] as number,
          editedAt: m[key("editedAt")] as string | null,
          deleted: m[key("deleted")] as boolean,
          reactions: m[key("reactions")] as Record<string, string[]>,
          external: m[key("external")] as Record<
            string,
            { thread: string; message: string | null }
          >,
          epoch: m[key("epoch")] as number,
          claim: m[key("claim")] as {
            epoch: number;
            token: string;
            until: string;
          } | null,
        },
      };
    }
    if (role === "backend") {
      const kind = blob[key("kind")];
      const actors = blob[key("actors")];
      if (kind !== "actors" || !isPlainObject(actors)) {
        return { ok: false, reason: "corrupt" };
      }
      for (const [principal, slug] of Object.entries(actors)) {
        if (typeof slug !== "string") return { ok: false, reason: "corrupt" };
        if (principal.length === 0) return { ok: false, reason: "corrupt" };
      }
      return {
        ok: true,
        value: {
          role: "backend",
          kind: "actors",
          actors: actors as Record<string, string>,
        },
      };
    }
    return { ok: false, reason: "corrupt" };
  };

  return { namespace: ns, encodeMessage, encodeBackend, decode };
}

export type { MessageMeta, BackendMeta } from "./types.ts";

/**
 * The per-issue write gate: an in-process mutex keyed by issue id, serializing every
 * metadata read-modify-write. A gated op that throws releases the gate; the next op runs.
 */
export interface WriteGate {
  run<T>(issueId: string, op: () => Promise<T>): Promise<T>;
}

export function createWriteGate(): WriteGate {
  const chains = new Map<string, Promise<unknown>>();
  const run = <T>(issueId: string, op: () => Promise<T>): Promise<T> => {
    const tail = chains.get(issueId) ?? Promise.resolve();
    const next = tail.then(op, op);
    // The chain itself never rejects: a thrown op releases the gate for the next one.
    chains.set(
      issueId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
  return { run };
}
