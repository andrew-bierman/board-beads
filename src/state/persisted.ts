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
import { canonical } from "@vercel/board/schemas";
import { FULL_ACCESS, parseCan, type Access } from "@vercel/board/access";
import type { BoardStore } from "../routes/threads.ts";
import type { JsonValue } from "../model/types.ts";

export type StateKind =
  "registration" | "match" | "inbox" | "map" | "target" | "schema";

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

// The document primitives, at module scope so a second state API (the schema
// registry below) shares the exact decode, gate, and corruption handling the
// store's kinds get. `ns` and `store` ride as parameters; behavior is the
// closure's, unchanged.

/** Decode one state issue's blob, or say why it isn't one of ours. */
function decodeStateDocument(
  ns: string,
  kind: StateKind,
  issueId: string,
  metadata: unknown,
): StateDocument | null | "corrupt" {
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
}

/** The live state document of one kind: its issue and records. */
async function loadStateDocument(
  store: BoardStore,
  ns: string,
  kind: StateKind,
  onCorrupt: "skip" | "throw",
): Promise<StateDocument | null> {
  const found = await store.rows(["list", "--label", stateLabel(ns, kind)]);
  let corrupt = false;
  for (const row of found) {
    const decoded = decodeStateDocument(
      ns,
      kind,
      row.issue.id,
      row.issue.metadata,
    );
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
}

/** Encode a document's blob, size-guarded. */
function encodeStateDocument(
  ns: string,
  kind: StateKind,
  records: Record<string, Record<string, JsonValue>>,
): Record<string, JsonValue> {
  return {
    [`${ns}.v`]: STATE_VERSION,
    [`${ns}.role`]: "state",
    [`${ns}.kind`]: kind,
    [`${ns}.records`]: records,
  };
}

/** Write one kind's document blob, size-guarded. */
async function writeStateDocument(
  store: BoardStore,
  ns: string,
  kind: StateKind,
  issueId: string,
  records: Record<string, Record<string, JsonValue>>,
): Promise<void> {
  const json = JSON.stringify(encodeStateDocument(ns, kind, records));
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
}

/**
 * Mutate one kind's document under its gate; creates the issue when absent. A
 * mutate that throws lands nothing, so a compare-and-refuse reads and writes
 * in the one gated section.
 */
async function mutateStateDocument(
  store: BoardStore,
  ns: string,
  kind: StateKind,
  mutate: (
    records: Record<string, Record<string, JsonValue>>,
  ) => Record<string, Record<string, JsonValue>>,
): Promise<void> {
  await store.gate.run(`state:${kind}`, async () => {
    const existing = await loadStateDocument(store, ns, kind, "skip");
    if (existing !== null) {
      await writeStateDocument(
        store,
        ns,
        kind,
        existing.issueId,
        mutate(existing.records),
      );
      return;
    }
    const created = await store.run(
      [
        "create",
        `--title=board-beads ${kind} state`,
        "--type=task",
        `--metadata=${JSON.stringify(encodeStateDocument(ns, kind, mutate({})))}`,
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
}

export function createPersistedStore(store: BoardStore): PersistedStore {
  const ns = store.codec.namespace;

  /** Decode one state issue's blob, or say why it isn't one of ours. */
  const decodeDocument = (
    kind: StateKind,
    issueId: string,
    metadata: unknown,
  ): StateDocument | null | "corrupt" =>
    decodeStateDocument(ns, kind, issueId, metadata);

  /** The live state document of one kind: its issue and records. */
  const loadDocument = async (
    kind: StateKind,
    onCorrupt: "skip" | "throw",
  ): Promise<StateDocument | null> =>
    loadStateDocument(store, ns, kind, onCorrupt);

  /** Encode a document's blob, size-guarded. */
  const encodeDocument = (
    kind: StateKind,
    records: Record<string, Record<string, JsonValue>>,
  ): Record<string, JsonValue> => encodeStateDocument(ns, kind, records);

  const writeDocument = async (
    kind: StateKind,
    issueId: string,
    records: Record<string, Record<string, JsonValue>>,
  ): Promise<void> => writeStateDocument(store, ns, kind, issueId, records);

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
  ): Promise<void> => mutateStateDocument(store, ns, kind, mutate);

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

// ---------------------------------------------------------------------------
// The schema registry: one `schema` state document holding every registered
// version, keyed `name@version`. A version is written once and never changes —
// register compares inside the kind's gate and refuses any other definition —
// so nothing here removes or edits a row once it has landed.
// ---------------------------------------------------------------------------

/** One registered schema version, as the registry keeps it: immutable once written. */
export interface SchemaVersionRow {
  name: string;
  version: number;
  description: string | null;
  schema: Record<string, JsonValue>;
  /** The actor that registered it. */
  by: string;
  /** When it was registered, as ISO. */
  at: string;
}

/** What a registration carries, before the registry stamps `at` on it. */
export interface SchemaRegistration {
  name: string;
  version: number;
  description: string | null;
  schema: Record<string, JsonValue>;
  by: string;
  /** How many versions a board may hold, the built-ins aside; insert past it is a typed 400. */
  max?: number;
}

export interface SchemaRegistry {
  /** Every registered version, by name then version. Corrupt documents are skipped. */
  list(): Promise<SchemaVersionRow[]>;
  /** One version by name and version, or null. A corrupt document is a typed error. */
  get(name: string, version: number): Promise<SchemaVersionRow | null>;
  /**
   * Register one version under the kind's gate: the same definition and description again answers
   * `created: false` with the row as kept; any other difference is 409 `schema_immutable`, and
   * nothing lands — a version never changes.
   */
  register(
    row: SchemaRegistration,
  ): Promise<{ created: boolean; row: SchemaVersionRow }>;
}

/** Decode one schema record of a state document, or null when it isn't one. */
function decodeSchemaRow(value: unknown): SchemaVersionRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const row = value as Record<string, unknown>;
  if (row.gone === true) return null;
  const { name, version, description, schema, by, at } = row;
  if (typeof name !== "string" || name === "") return null;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return null;
  }
  if (description !== null && typeof description !== "string") return null;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    return null;
  if (typeof by !== "string" || by === "") return null;
  if (typeof at !== "string" || at === "") return null;
  return {
    name,
    version,
    description,
    schema: schema as Record<string, JsonValue>,
    by,
    at,
  };
}

/** The versioned-schema store: registration, reads, immutability, over one state document. */
export function createSchemaRegistry(store: BoardStore): SchemaRegistry {
  const ns = store.codec.namespace;
  const state = createPersistedStore(store);

  const registry: SchemaRegistry = {
    list: async () => {
      const rows: SchemaVersionRow[] = [];
      for (const record of await state.list("schema")) {
        const row = decodeSchemaRow(record.data);
        if (row !== null) rows.push(row);
      }
      return rows.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version,
      );
    },

    get: async (name, version) => {
      const record = await state.get("schema", `${name}@${version}`);
      return record === null ? null : decodeSchemaRow(record.data);
    },

    register: async (row) => {
      const key = `${row.name}@${row.version}`;
      const made: { created: boolean; row: SchemaVersionRow | null } = {
        created: false,
        row: null,
      };
      await mutateStateDocument(store, ns, "schema", (records) => {
        const kept = decodeSchemaRow(records[key]);
        if (kept !== null) {
          const definitionDiffers =
            canonical(kept.schema) !== canonical(row.schema);
          const descriptionDiffers = kept.description !== row.description;
          if (definitionDiffers || descriptionDiffers) {
            throw new HttpError(
              409,
              "schema_immutable",
              `${key} is registered with another ${definitionDiffers ? "definition" : "description"}, and a version never changes: register a new version`,
            );
          }
          made.row = kept;
          return records;
        }
        if (row.max !== undefined && Object.keys(records).length >= row.max) {
          throw new HttpError(
            400,
            "too_many_schemas",
            `a board registers at most ${row.max.toLocaleString("en-US")} schema versions`,
          );
        }
        const fresh: SchemaVersionRow = {
          name: row.name,
          version: row.version,
          description: row.description,
          schema: row.schema,
          by: row.by,
          at: new Date().toISOString(),
        };
        made.created = true;
        made.row = fresh;
        return { ...records, [key]: { ...fresh, key, gone: null } };
      });
      if (made.row === null) {
        throw new HttpError(
          500,
          "internal",
          "the schema registry wrote nothing and refused nothing",
        );
      }
      return { created: made.created, row: made.row };
    },
  };
  return registry;
}
