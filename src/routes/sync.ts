/**
 * The sync-record routes: `syncImport`, `syncReceipt`, `syncThread`,
 * `syncFind`, `syncCopies`, `inboxPush`, `inboxNext`, `inboxAck`, `inbox`,
 * `typing`, `readSource`, `joinSource`, `synced`, `linked` — the records a
 * board's sync keeps through its backend, platform-less: no platform
 * adapters exist here, by design, so every platform-facing surface answers
 * the protocol-correct minimal body.
 *
 * What lives where:
 *   - an import is a real message issue, written through the store like any
 *     post: its platform user is a profile of the importer
 *     (`by.actor = '<principal>+<author id>'`, a persisted actor card with
 *     the author's name and the importer as its via), its `from` and
 *     `origin` ride the message's metadata slots, its idempotency id rides
 *     the client slot, and `mentioned` users become actors with the text
 *     rewritten to their actor IDs.
 *   - platform→board IDs (syncFind, the one-platform-thread claim), a
 *     thread's targets (syncThread, synced), and message copies (syncCopies)
 *     are persisted records in `src/state/persisted.ts`; a copy also rides
 *     the message's `external` metadata slot.
 *   - the inbox is one persisted queue per caller per sync key: pushes
 *     dedupe by the platform's event ID, pulls lease one platform thread at
 *     a time and in order, acks hand the next one over. Event IDs past the
 *     protocol's 300 characters are refused; the platform's retry lands once.
 *   - `linked` answers 404 `message_not_found` for every link: with no
 *     platform adapters, no link is one this board synced.
 *   - `typing` answers the threads that took it (none here); `readSource`
 *     and `joinSource` answer 404 `not_synced_here` unless the board itself
 *     runs the sync entry, which it never does alone.
 *   - every records write needs `sync` somewhere and a caller board() has
 *     not narrowed: 403 `forbidden` otherwise — a narrowed caller's sync is
 *     its project's job.
 *
 * Export shape: `createSyncRoutes({ store })` builds the route table; the
 * orchestrator spreads `routes` into the backend's method table.
 */
import { randomUUID } from "node:crypto";
import {
  HttpError,
  type Caller,
  type InboxEntry,
  type Protocol,
  type ProtocolMethods,
} from "@vercel/board";
import {
  createPersistedStore,
  routeCallerOf,
  type PersistedStore,
  type RouteCaller,
  type StateRecord,
} from "../state/persisted.ts";
import type { BoardStore } from "./threads.ts";
import { deriveTitle } from "../model/message.ts";
import { createLabels } from "../model/labels.ts";
import {
  applyDelete,
  applyEdit,
  applyLabelsChanged,
  applyReaction,
  checkRevisionFence,
  initialMessageMeta,
} from "../model/metadata.ts";
import type { JsonValue, MessageMeta } from "../model/types.ts";

/** The longest inbox event ID a board takes (the protocol's own bound). */
export const INBOX_EVENT_ID_MAX: number = 300;
/** Inbox page size and queue batch, as the protocol bounds them. */
const INBOX_LIMIT_DEFAULT = 10;
const INBOX_LIMIT_MAX = 50;
const INBOX_BATCH_MAX = 50;
/** An inbox lease, like a match lease: five minutes. */
const INBOX_LEASE_MS = 5 * 60_000;
/** Tries an inbox event gets before it is given up on. */
const INBOX_TRIES_MAX = 5;
/** The message text bound, as the threads routes hold it. */
const MESSAGE_TEXT_MAX = 10_000;

export type SyncRouteTable = Pick<
  ProtocolMethods,
  | "syncImport"
  | "syncReceipt"
  | "syncThread"
  | "syncFind"
  | "syncCopies"
  | "inboxPush"
  | "inboxNext"
  | "inboxAck"
  | "inbox"
  | "typing"
  | "readSource"
  | "joinSource"
  | "synced"
  | "linked"
>;

export interface SyncRouteDeps {
  store: BoardStore;
}

export interface SyncRoutes {
  routes: SyncRouteTable;
}

interface PlatformUser {
  id: string;
  handle: string;
  name: string;
  avatar: string | null;
  isBot: boolean;
}

// ---------------------------------------------------------------------------
// Error shorthands, matching the threads routes' shapes.
// ---------------------------------------------------------------------------

function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

function textTooLong(): HttpError {
  return badRequest(
    `A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString("en-US")} characters.`,
    "text_too_long",
  );
}

function revisionConflict(revision: number): HttpError {
  return new HttpError(
    409,
    "revision_conflict",
    `the message is at revision ${revision}`,
  );
}

/** The typed answer a corrupt state document gives a direct read or write. */
function isStateCorrupt(error: unknown): boolean {
  return error instanceof HttpError && error.code === "state_corrupt";
}

/** The records gate: sync somewhere, and never a caller board() narrowed. */
function needSyncRecords(who: RouteCaller, what: string): void {
  if (who.narrowed) {
    throw forbidden(
      `this token is narrowed with x-board-can, so it can't ${what}: that's its project's sync's job`,
    );
  }
  if (!who.access.anywhere("sync")) {
    throw forbidden(`this token can't ${what}: it needs sync`);
  }
}

/** Platform author IDs this board authenticates are never import authors. */
const RESERVED_AUTHOR_PREFIXES = [
  "vercel:",
  "github:",
  "oidc:",
  "local:",
  "board:",
];

/**
 * The actor id a platform user of one import writes as: a profile of the
 * importer's principal, `<principal>+<author id>`. An ID that doesn't start
 * with its sync key, or one this board authenticates, is refused.
 */
function authorActorId(author: { id: string }, from: string | null): string {
  if (from !== null && !author.id.startsWith(`${from}:`)) {
    throw forbidden(
      `a platform user of ${from} has an ID that starts with ${from}:, got ${JSON.stringify(author.id)}`,
    );
  }
  for (const prefix of RESERVED_AUTHOR_PREFIXES) {
    if (author.id.startsWith(prefix)) {
      throw forbidden(
        `${JSON.stringify(author.id)} is an ID this board authenticates`,
      );
    }
  }
  if (author.id.length === 0 || author.id.length > 300) {
    throw forbidden("a platform user's ID is 1 to 300 characters");
  }
  return `+${author.id}`; // the principal is prefixed by the caller below
}

/** Rewrite `@[<platform id>]` mentions to the users' actor IDs. */
function rewriteMentions(
  text: string,
  users: PlatformUser[],
  principalId: string,
): string {
  let out = text;
  for (const user of users) {
    out = out.split(`@[${user.id}]`).join(`@[${principalId}+${user.id}]`);
  }
  return out;
}

export function createSyncRoutes(deps: SyncRouteDeps): SyncRoutes {
  const store = deps.store;
  const state: PersistedStore = createPersistedStore(store);
  const labels = createLabels({ namespace: store.codec.namespace });

  // --- shared reads ---

  /** The message entry an id names, or null. */
  const entryOf = async (id: string) => store.entryById(id);

  /** The readable message an id names, at the caller's sight. */
  const readableEntry = async (who: RouteCaller, id: string) => {
    const entry = await entryOf(id);
    if (entry === null || !who.access.readable(entry.meta.channel)) {
      throw new HttpError(404, "message_not_found", `message not found: ${id}`);
    }
    return entry;
  };

  const addLabel = async (
    id: string,
    label: string,
    actor: string,
  ): Promise<void> => {
    await store.run(["label", "add", id, label], actor);
  };

  const removeLabel = async (
    id: string,
    label: string,
    actor: string,
  ): Promise<void> => {
    await store.run(["label", "remove", id, label], actor);
  };

  /** Encode a metadata blob through the codec (size-guarded). */
  const encodeFor = async (
    meta: MessageMeta,
  ): Promise<Record<string, JsonValue>> => {
    const encoded = store.codec.encodeMessage(meta);
    if (!encoded.ok) {
      throw badRequest(
        `the message's metadata is too large to store (${encoded.error.bytes} > ${encoded.error.limit} bytes)`,
        "metadata_too_large",
      );
    }
    return encoded.value;
  };

  /**
   * The inbox's dedupe read, corruption-hardened (R24): a corrupt inbox
   * state document reads as absent — what it holds is unreadable, so the
   * pushed event lands in a healthy document, and every later scan serves
   * that while the corrupt one stays skipped. The queue never lets one
   * rotten record stop it.
   */
  const inboxGetOrSkip = async (key: string): Promise<StateRecord | null> => {
    try {
      return await state.get("inbox", key);
    } catch (error) {
      if (!isStateCorrupt(error)) throw error;
      return null;
    }
  };

  /** One metadata (+ optional text) update on a message issue. */
  const writeIssue = async (
    id: string,
    meta: MessageMeta,
    actor: string,
    text?: string,
  ): Promise<void> => {
    const blob = await encodeFor(meta);
    const args = ["update", id, `--metadata=${JSON.stringify(blob)}`, "--json"];
    if (text !== undefined) args.splice(2, 0, `--description=${text}`);
    await store.run(args, actor);
  };

  /** Create one message issue, as the threads routes do. */
  const createIssue = async (input: {
    title: string;
    text: string;
    dep?: string | null;
    actor: string;
  }): Promise<string> => {
    const args = [
      "create",
      `--title=${input.title}`,
      `--description=${input.text}`,
      "--type=task",
      "--json",
    ];
    if (input.dep !== undefined && input.dep !== null) {
      args.push(`--deps=replies-to:${input.dep}`);
    }
    const created = await store.run(args, input.actor);
    const row = Array.isArray(created.data) ? created.data[0] : created.data;
    const id =
      row !== null && typeof row === "object" && !Array.isArray(row)
        ? (row as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "string" || id === "") {
      throw new HttpError(500, "internal", "bd create returned no issue id");
    }
    return id;
  };

  /** The message an import's client id landed as, or null. */
  const findByClientId = async (clientId: string): Promise<string | null> => {
    const found = await store.rows([
      "list",
      "--has-metadata-key",
      `${store.codec.namespace}.client`,
    ]);
    for (const row of found) {
      const entry = await entryOf(row.issue.id);
      if (entry !== null && entry.meta.client === clientId) return row.issue.id;
    }
    return null;
  };

  // --- the platform→board mapping records ---

  const threadOfExternal = async (
    externalThread: string,
  ): Promise<string | null> => {
    const found = await state.get("map", `thread:${externalThread}`);
    return typeof found?.data.boardThread === "string"
      ? found.data.boardThread
      : null;
  };

  const messageOfExternal = async (
    externalThread: string,
    externalMessage: string,
  ): Promise<string | null> => {
    const found = await state.get(
      "map",
      `message:${externalThread}|${externalMessage}`,
    );
    return typeof found?.data.boardMessage === "string"
      ? found.data.boardMessage
      : null;
  };

  /** A board thread's delivery targets, in the order they were attached. */
  const targetsOf = async (
    boardThread: string,
  ): Promise<Record<string, JsonValue>[]> => {
    const rows = await state.list("target");
    return rows
      .filter((row) => row.data.boardThread === boardThread)
      .map((row) => row.data);
  };

  /** Map a platform user to its persisted actor card; answers its bd slug. */
  const mapPlatformUser = async (
    who: RouteCaller,
    user: PlatformUser,
    from: string | null,
  ): Promise<string> => {
    const actorId = `${who.principalId}${authorActorId(user, from)}`;
    const card = {
      actor: actorId,
      principal: who.principalId,
      profile: user.id,
      kind: "external",
      handle: user.handle,
      name: user.name,
      avatar: user.avatar,
    };
    // The card persists whole, via record included: the importer's word for
    // this platform user, and the platform it speaks for.
    const withVia = {
      ...card,
      via: { name: who.card.handle, environment: null },
      platform: from,
    };
    return store.mapIdentity({
      actorId,
      principalId: who.principalId,
      profile: user.id,
      access: who.access,
      expiresAt: null,
      card: withVia as typeof card,
    });
  };

  /** Find the message an edit/delete/react/labels op names. */
  const resolveChanged = async (
    who: RouteCaller,
    body: {
      origin?: { thread: string; message?: string } | null;
      message?: string;
    },
    from: string | null,
  ): Promise<string> => {
    if (body.origin !== undefined && body.origin !== null) {
      const origin = body.origin;
      if (from === null) {
        throw badRequest(
          "an import with an origin names the sync key it came through: pass `from`",
        );
      }
      if (!origin.thread.startsWith(`${from}:`)) {
        throw badRequest(
          `an import's platform locations belong to its sync key: ${origin.thread} isn't ${from}'s`,
        );
      }
      if (origin.message !== undefined) {
        const found = await messageOfExternal(origin.thread, origin.message);
        if (found === null) {
          throw new HttpError(
            404,
            "message_not_found",
            "message not found: the platform message isn't on the board",
          );
        }
        return found;
      }
      const threadOwner = await threadOfExternal(origin.thread);
      if (threadOwner === null) {
        throw new HttpError(
          404,
          "message_not_found",
          "message not found: the platform thread isn't on the board",
        );
      }
      return threadOwner;
    }
    if (body.message !== undefined) {
      const entry = await entryOf(body.message);
      if (entry === null || !who.access.readable(entry.meta.channel)) {
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${body.message}`,
        );
      }
      if (from !== null && entry.meta.from !== from) {
        // Only an import can take an import down: another's is out of sight.
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${body.message}`,
        );
      }
      return body.message;
    }
    throw badRequest(
      "a change names the message it changes: pass origin or message",
    );
  };

  const routes: SyncRouteTable = {
    /**
     * A platform's write as its platform author. Posts are idempotent by
     * their platform event id; every other op finds its message from its
     * platform origin (or its board id, its own only).
     */
    async syncImport(
      caller,
      body,
    ): Promise<{ message: string | null; dropped?: string[] }> {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "import");
      const author: PlatformUser = {
        id: body.author.id,
        handle: body.author.handle,
        name: body.author.name,
        avatar: body.author.avatar ?? null,
        isBot: body.author.isBot,
      };
      const from = body.from ?? null;

      if (body.op === "post") {
        const mentioned = body.mentioned ?? [];
        const text = rewriteMentions(
          body.text ?? "",
          [...mentioned, author],
          who.principalId,
        );
        if (text.length > MESSAGE_TEXT_MAX) throw textTooLong();
        const labelGuard = labels.guardCallerLabels(body.labels ?? {});
        if (!labelGuard.ok) {
          throw badRequest(
            labelGuard.error.code === "reserved_label"
              ? `${labelGuard.error.label} is a reserved prefix`
              : `${JSON.stringify(labelGuard.error.label)} isn't a label this board can store`,
            labelGuard.error.code,
          );
        }

        // Idempotency first: the same platform event answers the same message.
        if (body.id !== undefined) {
          const replay = await findByClientId(body.id);
          if (replay !== null) return { message: replay };
        }

        const origin = body.origin ?? null;
        if (origin === null) {
          throw badRequest(
            "an import's post names where it came from: pass origin",
          );
        }
        if (from === null) {
          throw badRequest(
            "an import with an origin names the sync key it came through: pass `from`",
          );
        }
        for (const location of [
          origin.channel,
          origin.thread,
          origin.subthread,
        ]) {
          if (
            location !== undefined &&
            location !== null &&
            !location.startsWith(`${from}:`)
          ) {
            throw badRequest(
              `an import's platform locations belong to its sync key: ${location} isn't ${from}'s`,
            );
          }
        }
        if (
          origin.subthread !== null &&
          !origin.subthread.startsWith(`${origin.thread}:`)
        ) {
          throw badRequest(
            `an import's subthread is in its thread: ${origin.subthread} isn't in ${origin.thread}`,
          );
        }
        if (body.re !== undefined) {
          // A reply: its platform thread must already be this thread's.
          const target = await readableEntry(who, body.re);
          if (!who.access.can("post", target.meta.channel)) {
            throw forbidden(`this token can't post in ${target.meta.channel}`);
          }
          const rootId = target.meta.thread;
          const owner = await threadOfExternal(origin.thread);
          if (owner !== rootId) {
            throw new HttpError(
              409,
              "not_synced",
              `${origin.thread} isn't synced with this thread`,
            );
          }
          if (
            origin.message !== null &&
            (await messageOfExternal(origin.thread, origin.message)) !== null
          ) {
            throw new HttpError(
              409,
              "already_synced",
              `${origin.message} in ${origin.thread} is already on the board`,
            );
          }
          const authorSlug = await mapPlatformUser(who, author, from);
          for (const user of mentioned) await mapPlatformUser(who, user, from);
          const id = await store.gate.run(
            `sync:${from}:${origin.thread}`,
            async () => {
              await store.nextSeq();
              const issueId = await createIssue({
                title: deriveTitle(text),
                text,
                dep: body.re,
                actor: authorSlug,
              });
              const meta = initialMessageMeta({
                channel: target.meta.channel,
                thread: rootId,
                parent: body.re,
                after: null,
                client: body.id ?? null,
                from,
                origin: origin as unknown as JsonValue,
                noSync: body.noSync ?? false,
              });
              await addLabel(
                issueId,
                `${store.codec.namespace}.channel=${target.meta.channel}`,
                authorSlug,
              );
              for (const [name, value] of Object.entries(body.labels ?? {})) {
                await addLabel(
                  issueId,
                  value === "" ? name : `${name}=${value}`,
                  authorSlug,
                );
              }
              await writeIssue(issueId, meta, authorSlug);
              if (origin.message !== null) {
                await state.put(
                  "map",
                  `message:${origin.thread}|${origin.message}`,
                  {
                    sub: "message",
                    externalThread: origin.thread,
                    externalMessage: origin.message,
                    boardThread: rootId,
                    boardMessage: issueId,
                    owner: who.principalId,
                  },
                );
              }
              return issueId;
            },
          );
          return { message: id };
        }

        // A root: its platform thread must be no board thread's yet.
        const channel = body.channel;
        if (channel === undefined) throw badRequest("a post needs a channel");
        if (!who.access.can("post", channel)) {
          throw forbidden(`this token can't post in ${channel}`);
        }
        const earlyOwner = await threadOfExternal(origin.thread);
        if (earlyOwner !== null) {
          throw new HttpError(
            409,
            "already_synced",
            `${origin.thread} is already synced with another thread`,
          );
        }
        const authorSlug = await mapPlatformUser(who, author, from);
        for (const user of mentioned) await mapPlatformUser(who, user, from);
        const id = await store.gate.run(
          `sync:${from}:${origin.thread}`,
          async () => {
            const again = await threadOfExternal(origin.thread);
            if (again !== null) {
              throw new HttpError(
                409,
                "already_synced",
                `${origin.thread} is already synced with another thread`,
              );
            }
            await store.nextSeq();
            const issueId = await createIssue({
              title: deriveTitle(text),
              text,
              actor: authorSlug,
            });
            const meta = initialMessageMeta({
              channel,
              thread: issueId,
              client: body.id ?? null,
              from,
              origin: origin as unknown as JsonValue,
              noSync: body.noSync ?? false,
            });
            await addLabel(
              issueId,
              `${store.codec.namespace}.channel=${channel}`,
              authorSlug,
            );
            await addLabel(
              issueId,
              `${store.codec.namespace}.root`,
              authorSlug,
            );
            for (const [name, value] of Object.entries(body.labels ?? {})) {
              await addLabel(
                issueId,
                value === "" ? name : `${name}=${value}`,
                authorSlug,
              );
            }
            await writeIssue(issueId, meta, authorSlug);
            await state.put("map", `thread:${origin.thread}`, {
              sub: "thread",
              externalThread: origin.thread,
              boardThread: issueId,
              owner: who.principalId,
            });
            if (origin.message !== null) {
              await state.put(
                "map",
                `message:${origin.thread}|${origin.message}`,
                {
                  sub: "message",
                  externalThread: origin.thread,
                  externalMessage: origin.message,
                  boardThread: issueId,
                  boardMessage: issueId,
                  owner: who.principalId,
                },
              );
            }
            return issueId;
          },
        );
        return { message: id };
      }

      // edit / delete / react / labels / links: find the message from its origin.
      if (body.op === "links") {
        throw new HttpError(
          501,
          "not_supported",
          "this board keeps no link snapshots",
        );
      }
      const targetId = await resolveChanged(who, body, from);
      const entry = await entryOf(targetId);
      if (entry === null) {
        throw new HttpError(
          404,
          "message_not_found",
          `message not found: ${targetId}`,
        );
      }
      if (!who.access.can("post", entry.meta.channel)) {
        throw forbidden(`this token can't post in ${entry.meta.channel}`);
      }
      // The change is the import author's own write, so it lands as theirs.
      const authorSlug = entry.row.issue.created_by ?? store.systemActor;

      if (body.op === "edit") {
        const fence = checkRevisionFence(entry.meta, body.revision);
        if (fence !== null) throw revisionConflict(fence.revision);
        const text = rewriteMentions(
          body.text,
          [...(body.mentioned ?? []), author],
          who.principalId,
        );
        if (text.length > MESSAGE_TEXT_MAX) throw textTooLong();
        for (const user of body.mentioned ?? [])
          await mapPlatformUser(who, user, from);
        await store.gate.run(`issue:${targetId}`, async () => {
          await writeIssue(
            targetId,
            applyEdit(entry.meta, new Date().toISOString()),
            authorSlug,
            text,
          );
        });
        return { message: targetId };
      }

      if (body.op === "delete") {
        const fence = checkRevisionFence(entry.meta, body.revision);
        if (fence !== null) throw revisionConflict(fence.revision);
        await store.gate.run(`issue:${targetId}`, async () => {
          await writeIssue(targetId, applyDelete(entry.meta), authorSlug);
        });
        // Cleanup: the platform IDs name nothing anymore.
        const origin = body.origin ?? null;
        if (origin !== null) {
          if (origin.message !== undefined) {
            await state.drop(
              "map",
              `message:${origin.thread}|${origin.message}`,
            );
          } else {
            await state.drop("map", `thread:${origin.thread}`);
          }
        }
        return { message: targetId };
      }

      if (body.op === "react") {
        const actorId = `${who.principalId}${authorActorId(author, from)}`;
        const reacted = applyReaction(
          entry.meta,
          body.emoji,
          actorId,
          body.remove,
        );
        await store.gate.run(`issue:${targetId}`, async () => {
          await writeIssue(targetId, reacted, authorSlug);
        });
        return { message: targetId };
      }

      // labels
      await store.gate.run(`issue:${targetId}`, async () => {
        for (const [name, value] of Object.entries(body.set ?? {})) {
          const guard = labels.guardCallerLabel(name);
          if (guard !== null) {
            throw badRequest(
              `${JSON.stringify(name)} isn't a label this board can store`,
              guard.code,
            );
          }
          await addLabel(
            targetId,
            value === "" ? name : `${name}=${value}`,
            authorSlug,
          );
        }
        for (const name of body.unset ?? [])
          await removeLabel(targetId, name, authorSlug);
        await writeIssue(targetId, applyLabelsChanged(entry.meta), authorSlug);
      });
      return { message: targetId };
    },

    /** What sync did on a platform: a thread target, a copy, files, a failure. */
    async syncReceipt(caller, body) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "record a receipt");
      const entry = await readableEntry(who, body.message);
      const boardThread = entry.meta.thread;

      if (body.kind === "thread") {
        const attached = await store.gate.run(
          `target:${boardThread}|${body.target}`,
          async () => {
            const existing = (await targetsOf(boardThread)).some(
              (row) => row.target === body.target,
            );
            if (existing) return false;
            await state.put("target", `${boardThread}|${body.target}`, {
              boardThread,
              target: body.target,
              targetKind: body.targetKind,
              cause: body.cause,
              owner: who.principalId,
            });
            return true;
          },
        );
        return { ok: true, attached };
      }

      // message / files / failed: the target must already be the thread's.
      if (
        !(await targetsOf(boardThread)).some(
          (row) => row.target === body.target,
        )
      ) {
        throw badRequest(
          `${body.target} isn't one of this thread's targets`,
          "not_a_target",
        );
      }

      if (body.kind === "message") {
        // Its platform IDs must be no other message's.
        const clash = await messageOfExternal(
          body.external.thread,
          body.external.message,
        );
        if (clash !== null && clash !== body.message) {
          throw new HttpError(
            409,
            "already_synced",
            `${body.external.message} in ${body.external.thread} is already on the board`,
          );
        }
        await store.gate.run(`issue:${body.message}`, async () => {
          const current = await entryOf(body.message);
          if (current === null) {
            throw new HttpError(
              404,
              "message_not_found",
              `message not found: ${body.message}`,
            );
          }
          const external: Record<
            string,
            { thread: string; message: string | null }
          > = {
            ...current.meta.external,
            [body.target]: {
              thread: body.external.thread,
              message: body.external.message,
            },
          };
          await writeIssue(
            body.message,
            { ...current.meta, external },
            store.systemActor,
          );
        });
        await state.put(
          "map",
          `message:${body.external.thread}|${body.external.message}`,
          {
            sub: "message",
            externalThread: body.external.thread,
            externalMessage: body.external.message,
            boardThread,
            boardMessage: body.message,
            owner: who.principalId,
          },
        );
        await state.put("map", `copy:${body.message}|${body.target}`, {
          sub: "copy",
          boardMessage: body.message,
          target: body.target,
          thread: body.external.thread,
          message: body.external.message,
          owner: who.principalId,
        });
        return { ok: true };
      }

      if (body.kind === "files") {
        await state.put("map", `files:${body.message}|${body.target}`, {
          boardMessage: body.message,
          target: body.target,
          files: body.files === null ? null : [...body.files],
          owner: who.principalId,
        });
        return { ok: true };
      }

      await state.put("map", `failed:${body.message}|${body.target}`, {
        boardMessage: body.message,
        target: body.target,
        error: body.error,
        owner: who.principalId,
      });
      return { ok: true };
    },

    /** A board thread's sync, by its key. */
    async syncThread(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      const entry = await readableEntry(who, input.thread);
      const boardThread = entry.meta.thread;
      const external: Record<string, string> = {};
      const names: string[] = [];
      for (const row of await targetsOf(boardThread)) {
        const target = typeof row.target === "string" ? row.target : "";
        if (target === "") continue;
        names.push(target);
        if (row.targetKind === "thread") external[target] = target;
      }
      return {
        thread: boardThread,
        root: boardThread,
        channel: entry.meta.channel,
        targets: names,
        external,
      };
    },

    /** What platform IDs are on the board. */
    async syncFind(
      caller,
      input,
    ): Promise<{ thread: string | null; message: string | null }> {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      let thread: string | null = null;
      let message: string | null = null;
      if (input.post !== undefined) {
        message = await findByClientId(input.post);
      }
      if (input.thread !== undefined) {
        thread = await threadOfExternal(input.thread);
        if (input.message !== undefined && thread !== null) {
          message = await messageOfExternal(input.thread, input.message);
        }
      }
      if (message !== null) {
        const entry = await entryOf(message);
        if (entry === null || !who.access.readable(entry.meta.channel))
          message = null;
      }
      if (thread !== null) {
        const entry = await entryOf(thread);
        if (entry === null || !who.access.readable(entry.meta.channel))
          thread = null;
      }
      return { thread, message };
    },

    /** Messages' copies on platforms the caller's sync recorded. */
    async syncCopies(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      const copies: Record<
        string,
        Record<string, { thread: string; message: string }>
      > = {};
      for (const record of await state.list("map")) {
        if (record.data.sub !== "copy" || record.data.owner !== who.principalId)
          continue;
        const { boardMessage, target, thread, message } = record.data;
        if (
          typeof boardMessage !== "string" ||
          typeof target !== "string" ||
          typeof thread !== "string" ||
          typeof message !== "string" ||
          !input.message.includes(boardMessage)
        ) {
          continue;
        }
        const slot = copies[boardMessage] ?? {};
        slot[target] = { thread, message };
        copies[boardMessage] = slot;
      }
      return { copies };
    },

    /** Platform events into the caller's inbox, deduplicated by their platform IDs. */
    async inboxPush(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "push to an inbox");
      const events = input.events;
      if (events.length > INBOX_BATCH_MAX) {
        throw badRequest(
          `an inbox push carries at most ${INBOX_BATCH_MAX} events`,
          "too_many_events",
        );
      }
      for (const one of events) {
        if (one.id.length === 0 || one.id.length > INBOX_EVENT_ID_MAX) {
          throw badRequest(
            `an inbox event ID is ${INBOX_EVENT_ID_MAX} characters at most, got ${one.id.length}`,
          );
        }
        for (const location of [
          one.event.channel,
          one.event.thread,
          "subthread" in one.event ? one.event.subthread : null,
        ]) {
          if (location !== null && !location.startsWith(`${input.key}:`)) {
            throw badRequest(
              `an inbox's platform locations belong to its sync key: ${location} isn't ${input.key}'s`,
            );
          }
        }
      }
      for (const one of events) {
        await store.gate.run(`inbox:${who.principalId}:${one.id}`, async () => {
          const existing = await inboxGetOrSkip(`${who.principalId}|${one.id}`);
          if (existing !== null) return; // the platform's retry: lands once
          const seq = await store.nextSeq();
          await state.put("inbox", `${who.principalId}|${one.id}`, {
            owner: who.principalId,
            inbox: input.key,
            thread: one.event.thread,
            seq,
            lease: "",
            until: null,
            attempt: 0,
            done: false,
            event: one.event as unknown as JsonValue,
            // The raw payload rides as its exact JSON text: bd's metadata
            // round-trip reorders object keys, and a platform's raw payload
            // must come back the way it was pushed.
            rawText: JSON.stringify(one.raw ?? null),
          });
        });
      }
      return { ok: true };
    },

    /** The caller's next inbox events, leased, one platform thread at a time and in order. */
    async inboxNext(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "pull from an inbox");
      const limit = clampLimit(
        input.limit,
        INBOX_LIMIT_DEFAULT,
        INBOX_LIMIT_MAX,
      );
      const pending: { record: StateRecord; seq: number }[] = [];
      for (const record of await state.list("inbox")) {
        if (record.data.owner !== who.principalId) continue;
        if (record.data.done === true) continue;
        const until =
          typeof record.data.until === "number" ? record.data.until : 0;
        if (
          typeof record.data.lease === "string" &&
          record.data.lease !== "" &&
          until > Date.now()
        ) {
          continue; // leased to the current pull, until it runs out
        }
        pending.push({
          record,
          seq: typeof record.data.seq === "number" ? record.data.seq : 0,
        });
      }
      pending.sort((a, b) => a.seq - b.seq);
      const picked: string[] = [];
      const threads = new Set<string>();
      for (const { record } of pending) {
        if (picked.length >= limit) break;
        const thread =
          typeof record.data.thread === "string" ? record.data.thread : "";
        if (thread === "" || threads.has(thread)) continue; // one at a time, per thread
        threads.add(thread);
        picked.push(record.key);
      }
      if (picked.length === 0) return { items: [] };
      // One document write leases the whole pull. A corrupt sibling state
      // document never stops the lease (R24): its direct write answers
      // `state_corrupt`, and the lease falls back to per-record writes,
      // which scan past corrupt documents however they sort.
      const token = randomUUID().replace(/-/g, "").slice(0, 32);
      const until = Date.now() + INBOX_LEASE_MS;
      let leased: StateRecord[];
      try {
        leased = await state.patchAll(
          "inbox",
          picked.map((key) => ({
            key,
            mutate: (data) => ({ ...data, lease: token, until }),
          })),
        );
      } catch (error) {
        if (!isStateCorrupt(error)) throw error;
        leased = [];
        const fresh = await state.list("inbox");
        for (const key of picked) {
          const record = fresh.find((one) => one.key === key);
          if (record === undefined) continue; // acked away mid-pull
          leased.push(
            await state.put("inbox", key, {
              ...record.data,
              lease: token,
              until,
            }),
          );
        }
      }
      const items: Protocol["inboxNext"]["output"]["items"] = [];
      for (const record of leased) {
        const event = record.data.event;
        if (event === null || typeof event !== "object" || Array.isArray(event))
          continue;
        const rawText = record.data.rawText;
        items.push({
          id: eventKeyToId(record.key),
          key: typeof record.data.inbox === "string" ? record.data.inbox : "",
          thread:
            typeof record.data.thread === "string" ? record.data.thread : "",
          lease: typeof record.data.lease === "string" ? record.data.lease : "",
          attempt:
            typeof record.data.attempt === "number" ? record.data.attempt : 0,
          event:
            event as Protocol["inboxNext"]["output"]["items"][number]["event"],
          raw:
            typeof rawText === "string"
              ? (JSON.parse(rawText) as JsonValue)
              : null,
        });
      }
      return { items };
    },

    /** How an inbox event went: done, or an error to try again. */
    async inboxAck(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "ack an inbox event");
      /** The ack's checks and mutation, shared by both write paths. */
      const ack = (data: Record<string, JsonValue>): Record<string, JsonValue> => {
        if (data.owner !== who.principalId || data.done === true) throw NO_ITEM();
        const until = typeof data.until === "number" ? data.until : 0;
        if (data.lease !== input.lease || until <= Date.now()) {
          throw new HttpError(
            409,
            "stale_lease",
            "that lease ran out, and the event was pulled again",
          );
        }
        if (input.error !== undefined) {
          const attempt = typeof data.attempt === "number" ? data.attempt : 0;
          if (attempt + 1 >= INBOX_TRIES_MAX) return { ...data, done: true, lease: "" };
          return { ...data, lease: "", until: null, attempt: attempt + 1 };
        }
        return { ...data, done: true, lease: "" };
      };
      await store.gate.run(`inbox:${who.principalId}:${input.id}`, async () => {
        try {
          await state.patch("inbox", `${who.principalId}|${input.id}`, ack);
        } catch (error) {
          if (!isStateCorrupt(error)) throw error;
          // A corrupt sibling state document never stops an ack (R24): the
          // same checks replay against the scan, and the record is written
          // whole past the corrupt document.
          const key = `${who.principalId}|${input.id}`;
          const found = (await state.list("inbox")).find((one) => one.key === key);
          if (found === undefined) throw NO_ITEM();
          await state.put("inbox", key, ack(found.data));
        }
      });
      return { ok: true };
    },

    /** Raw platform events, newest first, for debugging sync. */
    async inbox(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      needSyncRecords(who, "read an inbox");
      const rows = await state.list("inbox");
      const events = rows
        .filter((row) => row.data.owner === who.principalId)
        .filter(
          (row) =>
            input.channel === undefined || row.data.thread === input.channel,
        )
        .sort((a, b) => {
          const at = typeof a.data.seq === "number" ? a.data.seq : 0;
          const bt = typeof b.data.seq === "number" ? b.data.seq : 0;
          return bt - at;
        })
        .slice(0, clampLimit(input.limit, 50, 500))
        .map((row) => ({
          id: eventKeyToId(row.key),
          channel: typeof row.data.thread === "string" ? row.data.thread : "",
          createdAt: "",
          sync: typeof row.data.inbox === "string" ? row.data.inbox : "",
          event: row.data.event as InboxEntry["event"],
          raw:
            typeof row.data.rawText === "string"
              ? (JSON.parse(row.data.rawText) as JsonValue)
              : null,
        }));
      return { events };
    },

    /** Typing in the platform threads the message's thread is synced to. */
    async typing(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      const entry = await readableEntry(who, input.id);
      if (!who.access.can("post", entry.meta.channel)) {
        throw forbidden(`this token can't post in ${entry.meta.channel}`);
      }
      // No platform adapters: nothing took it.
      return { targets: [] };
    },

    /** Read a platform channel on demand — only where the board runs the entry. */
    async readSource(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      if (
        !(store.binding()?.sync ?? []).some((entry) => entry.key === input.key)
      ) {
        throw new HttpError(
          404,
          "not_synced_here",
          `this board doesn't run sync entry ${input.key}: read it where its sync runs`,
        );
      }
      if (!who.access.everywhere("manage")) {
        throw forbidden(
          "this token can't read a source: it needs manage in every channel",
        );
      }
      needSyncRecords(who, "read a source");
      throw new HttpError(
        501,
        "not_supported",
        "this board keeps no platform adapters",
      );
    },

    /** Add the board's app to a public channel — only where the board runs the entry. */
    async joinSource(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      if (
        !(store.binding()?.sync ?? []).some((entry) => entry.key === input.key)
      ) {
        throw new HttpError(
          404,
          "not_synced_here",
          `this board doesn't run sync entry ${input.key}: join it where its sync runs`,
        );
      }
      if (!who.access.everywhere("manage")) {
        throw forbidden(
          "this token can't join a source: it needs manage in every channel",
        );
      }
      needSyncRecords(who, "join a source");
      throw new HttpError(
        501,
        "not_supported",
        "this board keeps no platform adapters",
      );
    },

    /** Where a message's thread is synced, and its copy on each target. */
    async synced(caller, input) {
      await store.ensureReady();
      const who = routeCallerOf(caller);
      const entry = await readableEntry(who, input.id);
      const rows: Protocol["synced"]["output"]["targets"] = [];
      for (const row of await targetsOf(entry.meta.thread)) {
        const target = typeof row.target === "string" ? row.target : "";
        if (target === "") continue;
        const copy = entry.meta.external[target];
        const threadTarget = row.targetKind === "thread" ? target : null;
        rows.push({
          target,
          key: target.slice(0, Math.max(target.indexOf(":"), 0)),
          thread: copy?.thread ?? threadTarget,
          message: copy?.message ?? null,
          url: null,
          undelivered: null,
        });
      }
      return { targets: rows };
    },

    /**
     * The thread of the board message a platform link names. No platform
     * adapters exist here, so no link is one this board synced — every
     * answer is the same 404, and none says what's out of sight.
     */
    async linked() {
      await store.ensureReady();
      throw new HttpError(
        404,
        "message_not_found",
        "no message on this board for that link",
      );
    },
  };

  /** The queue key back into the platform's own event id. */
  function eventKeyToId(key: string): string {
    const at = key.indexOf("|");
    return at === -1 ? key : key.slice(at + 1);
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

  function NO_ITEM(): HttpError {
    return new HttpError(
      404,
      "no_item",
      "no inbox event by that id is waiting for this token",
    );
  }

  return { routes };
}
