/**
 * Persisted route state, kept in bd the way every other board fact is: one
 * issue per state kind — registrations, matches, inbox, platform mappings,
 * delivery targets — its records keyed inside the issue's metadata blob
 * under this backend's namespace. Nothing here is memory-only: a
 * registration, a match lease, an inbox queue, a sync mapping all survive a
 * restart because they live in the tracker.
 *
 * Why one issue per kind, rather than one per record: the journal consumer
 * pins its feed for a moment on every bare `create` row (a post's metadata
 * may follow it), so state that rarely creates and mostly updates keeps the
 * feed live; and every read or write is one bd call against a known issue
 * instead of a scan.
 *
 * Corruption never poisons: a state issue whose metadata doesn't decode is
 * skipped by scans and answered as a typed error by direct gets, and every
 * write is gated per kind so concurrent writers serialize.
 */
import { HttpError, type Caller } from "@vercel/board";
import { FULL_ACCESS, parseCan, type Access } from "@vercel/board/access";
import type { BoardStore } from "../routes/threads.ts";
import type { JsonValue } from "../model/types.ts";

export type StateKind = "registration" | "match" | "inbox" | "map" | "target";

/** The bd label carrying a state document's kind: `<namespace>.state=<kind>`. */
function stateLabel(namespace: string, kind: StateKind): string {
  return `${namespace}.state=${kind}`;
}

/** One persisted record: its kind, its key, and its payload. */
export interface StateRecord {
  kind: StateKind;
  key: string;
  data: Record<string, JsonValue>;
}

export interface PersistedStore {
  /** Every live record of one kind, by key order. Corrupt documents are skipped. */
  list(kind: StateKind): Promise<StateRecord[]>;
  /** One record by kind and key, or null. A corrupt document is a typed error. */
  get(kind: StateKind, key: string): Promise<StateRecord | null>;
  /** Create or replace the record of one kind and key, gated per kind. */
  put(
    kind: StateKind,
    key: string,
    data: Record<string, JsonValue>,
  ): Promise<StateRecord>;
  /** Read-modify-write one record, gated per kind. Missing is a typed 404; corrupt a typed 500. */
  patch(
    kind: StateKind,
    key: string,
    mutate: (data: Record<string, JsonValue>) => Record<string, JsonValue>,
  ): Promise<StateRecord>;
  /** Read-modify-write many records of one kind in one document write. A missing key is typed 404. */
  patchAll(
    kind: StateKind,
    updates: readonly {
      key: string;
      mutate: (data: Record<string, JsonValue>) => Record<string, JsonValue>;
    }[],
  ): Promise<StateRecord[]>;
  /** Retire a record: kept as a tombstone, gone from every read. */
  drop(kind: StateKind, key: string): Promise<void>;
}

/** What a state document's metadata blob carries, at what version. */
const STATE_VERSION = 1;
/** bd carries metadata as one argv element; past this a document can't be stored. */
const STATE_BYTES_MAX = 56_000;

interface StateDocument {
  issueId: string;
  records: Record<string, Record<string, JsonValue>>;
}

export function createPersistedStore(store: BoardStore): PersistedStore {
  const ns = store.codec.namespace;

  /** Decode one state issue's blob, or say why it isn't one of ours. */
  const decodeDocument = (
    kind: StateKind,
    issueId: string,
    metadata: unknown,
  ): StateDocument | null | "corrupt" => {
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata)
    ) {
      return null; // no metadata at all: nothing of ours
    }
    const blob = metadata as Record<string, unknown>;
    if (blob[`${ns}.v`] !== STATE_VERSION) return null;
    if (blob[`${ns}.role`] !== "state") return null;
    if (blob[`${ns}.kind`] !== kind) return "corrupt";
    const records = blob[`${ns}.records`];
    if (
      records === null ||
      typeof records !== "object" ||
      Array.isArray(records)
    ) {
      return "corrupt";
    }
    const decoded: Record<string, Record<string, JsonValue>> = {};
    for (const [key, entry] of Object.entries(
      records as Record<string, unknown>,
    )) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return "corrupt";
      const row = entry as Record<string, JsonValue>;
      if (row.key !== key) return "corrupt";
      decoded[key] = row;
    }
    return { issueId, records: decoded };
  };

  /** The live state document of one kind: its issue and records. */
  const loadDocument = async (
    kind: StateKind,
    onCorrupt: "skip" | "throw",
  ): Promise<StateDocument | null> => {
    const found = await store.rows(["list", "--label", stateLabel(ns, kind)]);
    let corrupt = false;
    for (const row of found) {
      const decoded = decodeDocument(kind, row.issue.id, row.issue.metadata);
      if (decoded === null) continue;
      if (decoded === "corrupt") {
        corrupt = true;
        continue;
      }
      return decoded;
    }
    // Nothing healthy serves this kind, and something of ours is unreadable:
    // a typed corrupt, never a silent empty.
    if (corrupt && onCorrupt === "throw") {
      throw new HttpError(
        500,
        "state_corrupt",
        `the ${kind} state issue doesn't decode; it needs an operator's eye`,
      );
    }
    return null;
  };

  /** Encode a document's blob, size-guarded. */
  const encodeDocument = (
    kind: StateKind,
    records: Record<string, Record<string, JsonValue>>,
  ): Record<string, JsonValue> => ({
    [`${ns}.v`]: STATE_VERSION,
    [`${ns}.role`]: "state",
    [`${ns}.kind`]: kind,
    [`${ns}.records`]: records,
  });

  const writeDocument = async (
    kind: StateKind,
    issueId: string,
    records: Record<string, Record<string, JsonValue>>,
  ): Promise<void> => {
    const json = JSON.stringify(encodeDocument(kind, records));
    if (json.length > STATE_BYTES_MAX) {
      throw new HttpError(
        400,
        "metadata_too_large",
        `the ${kind} state has grown too large to keep (${json.length} bytes of metadata)`,
      );
    }
    await store.run(
      ["update", issueId, `--metadata=${json}`, "--json"],
      store.systemActor,
    );
  };

  const asRecord = (
    kind: StateKind,
    row: Record<string, JsonValue>,
  ): StateRecord => ({
    kind,
    key: row.key as string,
    data: row,
  });

  /** Mutate one kind's document under its gate; creates the issue when absent. */
  const mutateDocument = async (
    kind: StateKind,
    mutate: (
      records: Record<string, Record<string, JsonValue>>,
    ) => Record<string, Record<string, JsonValue>>,
  ): Promise<void> => {
    await store.gate.run(`state:${kind}`, async () => {
      const existing = await loadDocument(kind, "skip");
      if (existing !== null) {
        await writeDocument(kind, existing.issueId, mutate(existing.records));
        return;
      }
      const created = await store.run(
        [
          "create",
          `--title=board-beads ${kind} state`,
          "--type=task",
          `--metadata=${JSON.stringify(encodeDocument(kind, mutate({})))}`,
          "--json",
        ],
        store.systemActor,
      );
      const row = Array.isArray(created.data) ? created.data[0] : created.data;
      const issueId =
        row !== null && typeof row === "object" && !Array.isArray(row)
          ? (row as Record<string, unknown>).id
          : undefined;
      if (typeof issueId !== "string" || issueId === "") {
        throw new HttpError(
          500,
          "internal",
          "bd create returned no issue id for state",
        );
      }
      await store.run(
        ["label", "add", issueId, stateLabel(ns, kind)],
        store.systemActor,
      );
    });
  };

  const persisted: PersistedStore = {
    list: async (kind) => {
      const document = await loadDocument(kind, "skip");
      if (document === null) return [];
      return Object.values(document.records)
        .filter((row) => row.gone !== true)
        .map((row) => asRecord(kind, row))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    get: async (kind, key) => {
      const document = await loadDocument(kind, "throw");
      if (document === null) return null;
      const row = document.records[key];
      if (row === undefined || row.gone === true) return null;
      return asRecord(kind, row);
    },

    put: async (kind, key, data) => {
      const saved: { record: StateRecord | null } = { record: null };
      await mutateDocument(kind, (records) => {
        const row: Record<string, JsonValue> = { ...data, key, gone: null };
        saved.record = asRecord(kind, row);
        return { ...records, [key]: row };
      });
      return saved.record ?? { kind, key, data: { ...data, key } };
    },

    patch: async (kind, key, mutate) => {
      const saved: { record: StateRecord | null } = { record: null };
      await store.gate.run(`state:${kind}`, async () => {
        const document = await loadDocument(kind, "throw");
        const row = document?.records[key];
        if (document === null || row === undefined || row.gone === true) {
          throw new HttpError(
            404,
            "not_found",
            `no ${kind} record ${JSON.stringify(key)}`,
          );
        }
        const next: Record<string, JsonValue> = {
          ...mutate(row),
          key,
          gone: null,
        };
        await writeDocument(kind, document.issueId, {
          ...document.records,
          [key]: next,
        });
        saved.record = asRecord(kind, next);
      });
      return saved.record ?? { kind, key, data: { key } };
    },

    patchAll: async (kind, updates) => {
      const saved: { records: StateRecord[] } = { records: [] };
      await store.gate.run(`state:${kind}`, async () => {
        const document = await loadDocument(kind, "throw");
        if (document === null) {
          throw new HttpError(404, "not_found", `no ${kind} records to patch`);
        }
        const records = { ...document.records };
        const out: StateRecord[] = [];
        for (const one of updates) {
          const row = records[one.key];
          if (row === undefined || row.gone === true) {
            throw new HttpError(
              404,
              "not_found",
              `no ${kind} record ${JSON.stringify(one.key)}`,
            );
          }
          const next: Record<string, JsonValue> = {
            ...one.mutate(row),
            key: one.key,
            gone: null,
          };
          records[one.key] = next;
          out.push(asRecord(kind, next));
        }
        await writeDocument(kind, document.issueId, records);
        saved.records = out;
      });
      return saved.records;
    },

    drop: async (kind, key) => {
      await mutateDocument(kind, (records) => {
        const row = records[key];
        if (row === undefined) return records;
        return { ...records, [key]: { ...row, gone: true } };
      });
    },
  };
  return persisted;
}

/**
 * The route-identity every route group shares: who the caller is, what it may
 * do now, and whether board() narrowed it with `x-board-can` (watchers and
 * sync's records refuse a narrowed caller — its principal registers and runs
 * those). Structurally the shape `createBoardStore().mapIdentity` takes.
 */
export interface RouteCaller {
  actorId: string;
  principalId: string;
  profile: string | null;
  access: Access;
  card: {
    actor: string;
    principal: string;
    profile: string | null;
    kind: string;
    handle: string;
    name: string;
    avatar: string | null;
  };
  /** A caller narrowed with `x-board-can`: its principal's watchers and sync's records are not its to touch. */
  narrowed: boolean;
}

export function routeCallerOf(caller: Caller): RouteCaller {
  if ("identity" in caller) {
    const { principal, author, actor } = caller.identity;
    return {
      actorId: author.actor,
      principalId: author.principal,
      profile: author.profile,
      access: principal.access,
      narrowed: (principal.scope ?? null) !== null,
      card: {
        actor: author.actor,
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
  const access: Access =
    caller.can === undefined
      ? FULL_ACCESS
      : FULL_ACCESS.narrow(parseCan(caller.can));
  return {
    actorId,
    principalId: actorId,
    profile: null,
    access,
    narrowed: caller.can !== undefined,
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
