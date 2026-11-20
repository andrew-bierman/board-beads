import { afterAll, describe, expect, test } from "bun:test";
import {
  board,
  BoardError,
  type Backend,
  type Board,
  type BoardBinding,
} from "@vercel/board";
import {
  type BdFixture,
  createBdFixture,
} from "../../test/helpers/bd-fixture.ts";
import { createEventRoutes } from "./events.ts";
import { createBoardStore, threadsRoutes } from "./threads.ts";
import { createWatcherRoutes } from "./watchers.ts";
import { createSyncRoutes } from "./sync.ts";
import { createLabels } from "../model/labels.ts";
import { createPersistedStore } from "../state/persisted.ts";

/**
 * The sync-record routes, against the real entry path: a fixture tracker, a
 * board() mount over the same registry the backend assembles, driven through
 * the handle the way the conformance kit drives a board. No mocks anywhere.
 *
 * Every scenario below is concretized from the conformance inventory's sync
 * checks: the import shape, the author mapping, the lookups, receipts,
 * copies, targets, the linked refusal, the inbox queue, the event-ID bound,
 * the @sync match, and the narrowed-caller refusals.
 */

/** Collect a call's protocol error instead of failing the test on it. */
async function errorOf(promise: Promise<unknown>): Promise<BoardError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error("expected the call to fail with a protocol error");
}

interface Mount {
  board: Board;
  stop: () => void;
}

/** One backend process over the fixture: threads + events + watchers + sync. */
function mount(dir: string): Mount {
  const store = createBoardStore({ dir });
  const events = createEventRoutes({
    transport: store.transport,
    codec: store.codec,
    labels: createLabels({ namespace: store.codec.namespace }),
    authorFor: (slug) => store.authorForSlug(slug),
  });
  events.poller.start();
  const watchers = createWatcherRoutes({ store });
  const sync = createSyncRoutes({ store });
  const backend = {
    keeps: true,
    routes: [],
    ...threadsRoutes(store),
    events: events.events,
    ...watchers.routes,
    ...sync.routes,
    trust: {
      grants: async () => [
        {
          id: "bb-open",
          principals: [{ kind: "everyone" }],
          can: { "*": "all" },
        },
      ],
    },
    bind(binding: BoardBinding) {
      store.bind(binding);
    },
  } as unknown as Backend;
  return {
    board: board({ backend }),
    stop: () => {
      watchers.stop();
      void events.poller.stop();
    },
  };
}

/** The platform author the conformance kit's sync checks use. */
const author = {
  id: "conformance:user:syncrun",
  handle: "conformance",
  name: "Conformance",
  avatar: null,
  isBot: false,
};

/** A platform user the text mentions, who has written nothing here. */
const cc = {
  id: "conformance:user:syncrun-cc",
  handle: "conformance-cc",
  name: "Conformance Cc",
  avatar: null,
  isBot: false,
};

describe("sync record routes (real bd, mounted through board())", () => {
  let fixture: BdFixture;
  let app: Mount;
  let team: Board;
  const principal = "board:client";

  /** Register the conformance sync entry the way registerSync does. */
  async function registerSync(): Promise<void> {
    await team.register({
      watch: {},
      sync: [{ key: "conformance", platform: "conformance" }],
    });
  }

  /** Import the conformance check's post, origin and idempotency id included. */
  function importPost() {
    return team.syncImport({
      op: "post",
      author,
      from: "conformance",
      channel: "dev",
      text: "conformance: from a platform",
      labels: { conformance: "syncrun" },
      noSync: true,
      origin: {
        channel: "conformance:syncrun",
        thread: "conformance:syncrun:1",
        subthread: null,
        message: "1",
        context: null,
      },
      id: "conformance-sync-syncrun",
    });
  }

  afterAll(() => {
    app?.stop();
    fixture?.close();
  });

  test("boots the fixture, mounts the sync routes, registers the sync entry", async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
    team = app.board;
    await registerSync();
    const listed = await team.watchers();
    const own = listed.find((one) => one.owner === principal);
    expect(own?.sync).toEqual([
      { key: "conformance", platform: "conformance" },
    ]);
  }, 60_000);

  test("syncImport post lands as a profile of its importer: by, author, from, origin", async () => {
    const imported = await importPost();
    expect(imported.message).not.toBeNull();
    const id = imported.message ?? "";
    const thread = await team.thread(id);
    const message = thread.message;
    expect(message.by.actor).toBe(`${principal}+${author.id}`);
    expect(message.by.principal).toBe(principal);
    expect(message.by.profile).toBe(author.id);
    expect(message.author?.name).toBe(author.name);
    expect(message.from).toBe("conformance");
    expect(message.origin?.thread).toBe("conformance:syncrun:1");
    expect(message.noSync).toBeTrue();
    expect(message.labels.conformance).toBe("syncrun");

    // The persisted card carries the via record: the importer's word for
    // the platform user. (The view-level author.via surfaces when the
    // store's author lookup passes card fields through; this unit owns
    // the persisted card.)
    const store = createBoardStore({ dir: fixture.dir });
    await store.ensureReady();
    const card = store.state().assignments.principals;
    const slug = card[`${principal}+${author.id}`] ?? "";
    const raw = card[`card:${slug}`] ?? "";
    const parsed = JSON.parse(raw) as {
      via?: { name: string };
      platform?: string;
    };
    expect(parsed.via?.name).toBe("client");
    expect(parsed.platform).toBe("conformance");
  }, 60_000);

  test("the same import sent again answers the same message (idempotent id)", async () => {
    const again = await team.syncImport({
      op: "post",
      author,
      from: "conformance",
      channel: "dev",
      text: "conformance: from a platform",
      noSync: true,
      id: "conformance-sync-syncrun",
    });
    const first = await importPost();
    expect(again.message).toBe(first.message);
  }, 60_000);

  test("a second root from the same platform thread is 409 already_synced", async () => {
    const error = await errorOf(
      team.syncImport({
        op: "post",
        author,
        from: "conformance",
        channel: "dev",
        text: "conformance: a second root",
        noSync: true,
        origin: {
          thread: "conformance:syncrun:1",
          subthread: null,
          message: "3",
          context: null,
        },
      }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe("already_synced");
  }, 60_000);

  test("syncFind by platform thread+message and by post id; syncThread answers the root", async () => {
    const imported = await importPost();
    const id = imported.message ?? "";
    const found = await team.syncFind({
      thread: "conformance:syncrun:1",
      message: "1",
    });
    expect(found.message).toBe(id);
    expect(found.thread).not.toBeNull();
    const syncedThread = await team.syncThread(found.thread ?? "");
    expect(syncedThread.root).toBe(id);
    const byPost = await team.syncFind({ post: "conformance-sync-syncrun" });
    expect(byPost.message).toBe(id);
  }, 60_000);

  test("syncReceipt records a thread target and a message copy; syncCopies and sync() read them back", async () => {
    const imported = await importPost();
    const id = imported.message ?? "";
    const external = { thread: "conformance:syncrun:2", message: "2" };
    const threadReceipt = await team.syncReceipt({
      kind: "thread",
      message: id,
      target: external.thread,
      targetKind: "thread",
      cause: "request",
    });
    expect(threadReceipt.ok).toBeTrue();
    expect(threadReceipt.attached).toBeTrue();
    // Attaching the same target again is not a new one.
    const again = await team.syncReceipt({
      kind: "thread",
      message: id,
      target: external.thread,
      targetKind: "thread",
      cause: "request",
    });
    expect(again.attached).toBeFalse();
    await team.syncReceipt({
      kind: "message",
      message: id,
      target: external.thread,
      external,
    });
    const copies = await team.syncCopies([id]);
    expect(JSON.stringify(copies[id]?.[external.thread])).toBe(
      JSON.stringify(external),
    );
    const where = await team.sync(id);
    expect(
      where.targets.some(
        (row) =>
          row.target === external.thread && row.message === external.message,
      ),
    ).toBeTrue();
  }, 60_000);

  test("a link no sync here knows answers 404 message_not_found", async () => {
    const error = await errorOf(
      team.linked("https://conformance.invalid/syncrun"),
    );
    expect(error.status).toBe(404);
    expect(error.code).toBe("message_not_found");
  }, 30_000);

  test("an import edit rewrites the message and an import delete takes it down", async () => {
    const imported = await importPost();
    const id = imported.message ?? "";
    const edited = await team.syncImport({
      op: "edit",
      author,
      from: "conformance",
      origin: { thread: "conformance:syncrun:1", message: "1" },
      text: "conformance: from a platform, edited",
    });
    expect(edited.message).toBe(id);
    const read = await team.thread(id);
    expect(read.message.text).toBe("conformance: from a platform, edited");
    expect(read.message.revision).toBe(2);

    await team.syncImport({
      op: "delete",
      author,
      from: "conformance",
      origin: { thread: "conformance:syncrun:1", message: "1" },
    });
    const tombstone = await team.thread(id);
    expect(tombstone.message.deleted).toBeTrue();
    // The platform IDs name nothing anymore.
    const found = await team.syncFind({
      thread: "conformance:syncrun:1",
      message: "1",
    });
    expect(found.message).toBeNull();

    // A delete of what no import here brought is refused.
    const plain = await team.post("dev", "not an import");
    const refused = await errorOf(
      team.syncImport({
        op: "delete",
        author,
        from: "conformance",
        origin: { thread: "conformance:syncrun:9", message: "1" },
      }),
    );
    expect(refused.status).toBe(404);
    const own = await errorOf(
      team.syncImport({
        op: "delete",
        message: plain.id,
        author,
        from: "conformance",
      }),
    );
    expect(own.status).toBe(404);
  }, 60_000);

  test("a mentioned platform user is met: the text names its actor ID, actors() knows it", async () => {
    const imported = await team.syncImport({
      op: "post",
      author,
      from: "conformance",
      channel: "dev",
      text: `conformance: cc @[${cc.id}]`,
      mentioned: [cc],
      labels: { conformance: "syncrun" },
      noSync: true,
      origin: {
        channel: "conformance:syncrun",
        thread: "conformance:syncrun:mentioned",
        subthread: null,
        message: "1",
        context: null,
      },
      id: "conformance-mentioned-syncrun",
    });
    const id = imported.message ?? "";
    const actor = `${principal}+${cc.id}`;
    const message = await team.thread(id);
    expect(message.message.text).toBe(`conformance: cc @[${actor}]`);
    const actors = await team.actors();
    const met = actors.find((known) => known.id === actor);
    expect(met?.name).toBe(cc.name);
  }, 60_000);

  test("while a sync is registered, a post hands the sync a match of its @sync watcher", async () => {
    await registerSync();
    const posted = await team.post("dev", {
      text: "conformance: for a sync",
      labels: { conformance: "syncrun" },
      noSync: true,
    });
    let match: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const deadline = Date.now() + 15_000;
    while (!match && Date.now() < deadline) {
      match = (await team.matches({ wait: 2 })).find(
        (one) => one.watcher === "@sync" && one.event.message?.id === posted.id,
      );
    }
    expect(match).toBeTruthy();
    expect(match?.event.type).toBe("message.posted");
    await team.ack(match?.id ?? "", { lease: match?.lease ?? "" });
  }, 90_000);

  test("the inbox queues a platform thread's events once and leases them one at a time, in order", async () => {
    await registerSync();
    const thread = "conformance:syncrun:inbox";
    const eventOf = (message: string) => ({
      id: `conformance-inbox-syncrun-${message}`,
      event: {
        kind: "message" as const,
        channel: "conformance:syncrun",
        thread,
        subthread: null,
        message,
        isRoot: message === "1",
        text: `conformance: inbox event ${message}`,
        context: null,
        author,
      },
      raw: { conformance: "syncrun", message },
    });
    const pushed = [eventOf("1"), eventOf("2")];
    await team.inboxPush("conformance", pushed);
    // A platform's retry of an event lands once.
    await team.inboxPush("conformance", [pushed[0] ?? ""]);
    const lease = async () =>
      (await team.inboxNext("conformance", { limit: 50 })).filter(
        (item) => item.thread === thread,
      );
    for (const wanted of pushed) {
      const leased = await lease();
      expect(leased).toHaveLength(1);
      const item = leased[0];
      expect(item?.event.kind === "message" ? item.event.message : null).toBe(
        wanted.event.kind === "message" ? wanted.event.message : null,
      );
      expect(JSON.stringify(item?.raw)).toBe(JSON.stringify(wanted.raw));
      expect(item?.key).toBe("conformance");
      await team.inboxAck("conformance", item?.id ?? "", {
        lease: item?.lease ?? "",
      });
    }
    expect(await lease()).toHaveLength(0);
  }, 60_000);

  test("events of different platform threads lease side by side, one each", async () => {
    await registerSync();
    const eventOf = (thread: string, message: string) => ({
      id: `conformance-inbox-syncrun-${thread}-${message}`,
      event: {
        kind: "message" as const,
        channel: "conformance:syncrun",
        thread,
        subthread: null,
        message,
        isRoot: true,
        text: `conformance: inbox ${thread} ${message}`,
        context: null,
        author,
      },
      raw: null,
    });
    await team.inboxPush("conformance", [
      eventOf("conformance:syncrun:t1", "1"),
      eventOf("conformance:syncrun:t1", "2"),
      eventOf("conformance:syncrun:t2", "1"),
    ]);
    const first = await team.inboxNext("conformance", { limit: 50 });
    const t1 = first.filter((item) => item.thread === "conformance:syncrun:t1");
    const t2 = first.filter((item) => item.thread === "conformance:syncrun:t2");
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    await team.inboxAck("conformance", t1[0]?.id ?? "", {
      lease: t1[0]?.lease ?? "",
    });
    const second = await team.inboxNext("conformance", { limit: 50 });
    const t1Second = second.filter(
      (item) => item.thread === "conformance:syncrun:t1",
    );
    expect(t1Second).toHaveLength(1);
    expect(
      t1Second[0]?.event.kind === "message" ? t1Second[0]?.event.message : null,
    ).toBe("2");
    for (const item of [...second, ...(t1[0] ? [] : [])]) {
      await team.inboxAck("conformance", item.id, { lease: item.lease });
    }
  }, 60_000);

  test("an inbox event ID at the protocol bound lands; one over it is refused", async () => {
    await registerSync();
    const location = {
      channel: "conformance:syncrun",
      thread: "conformance:syncrun:long",
      subthread: null,
    };
    const idOf = (kind: string) =>
      `conformance-inbox-syncrun-long-${kind}-`.padEnd(300, "x");
    await team.inboxPush("conformance", [
      {
        id: idOf("ok"),
        event: {
          kind: "edited" as const,
          ...location,
          message: "1",
          text: "conformance: long id lands",
          author,
        },
        raw: null,
      },
    ]);
    const error = await errorOf(
      team.inboxPush("conformance", [
        {
          id: `${idOf("over")}x`,
          event: {
            kind: "edited" as const,
            ...location,
            message: "1",
            text: "conformance: too long",
            author,
          },
          raw: null,
        },
      ]),
    );
    expect(error.status).toBe(400);
    // Drain the queue for later tests.
    const items = await team.inboxNext("conformance", { limit: 50 });
    for (const item of items.filter((one) => one.thread === location.thread)) {
      await team.inboxAck("conformance", item.id, { lease: item.lease });
    }
  }, 60_000);

  test("a caller narrowed with x-board-can is refused sync's records: imports, receipts, the inbox", async () => {
    const narrowed = team.as("nobody", { can: "dev/=all" });
    for (const attempt of [
      narrowed.syncImport({
        op: "post",
        author,
        from: "conformance",
        channel: "dev",
        text: "conformance: a narrowed import",
        origin: {
          thread: "conformance:syncrun:narrowed",
          subthread: null,
          message: "1",
          context: null,
        },
      }),
      narrowed.syncReceipt({
        kind: "failed",
        message: "whatever",
        target: "conformance:syncrun:narrowed",
        error: "conformance",
      }),
      narrowed.inboxPush("conformance", [
        {
          id: "conformance-narrowed-syncrun",
          event: {
            kind: "message" as const,
            channel: "conformance:syncrun",
            thread: "conformance:syncrun:narrowed",
            subthread: null,
            message: "1",
            isRoot: true,
            text: "conformance: a narrowed push",
            context: null,
            author,
          },
          raw: null,
        },
      ]),
      narrowed.inboxNext("conformance", { limit: 1 }),
      narrowed.inboxAck("conformance", "conformance-narrowed-syncrun", {
        lease: "conformance",
      }),
    ]) {
      const error = await errorOf(attempt);
      expect(error.status).toBe(403);
      expect(error.code).toBe("forbidden");
    }
  }, 60_000);

  test("typing answers the threads that took it (none: no platform adapters); sources answer not_synced_here", async () => {
    const posted = await team.post("dev", "typing probe");
    const targets = await team.typing(posted.id);
    expect(targets).toEqual([]);
    const read = await errorOf(team.readSource("conformance", "#dev"));
    expect(read.status).toBe(404);
    expect(read.code).toBe("not_synced_here");
    const join = await errorOf(team.joinSource("conformance", "#dev"));
    expect(join.status).toBe(404);
    expect(join.code).toBe("not_synced_here");
  }, 60_000);

  test("the inbox survives a restart: pushed events are leased from the next process", async () => {
    await registerSync();
    const thread = "conformance:syncrun:restart";
    await team.inboxPush("conformance", [
      {
        id: "conformance-inbox-syncrun-restart",
        event: {
          kind: "message" as const,
          channel: "conformance:syncrun",
          thread,
          subthread: null,
          message: "1",
          isRoot: true,
          text: "conformance: survives a restart",
          context: null,
          author,
        },
        raw: { survived: true },
      },
    ]);
    app.stop();
    const second = mount(fixture.dir);
    try {
      const items = (
        await second.board.inboxNext("conformance", { limit: 50 })
      ).filter((item) => item.thread === thread);
      expect(items).toHaveLength(1);
      expect(items[0]?.raw).toEqual({ survived: true });
      await second.board.inboxAck("conformance", items[0]?.id ?? "", {
        lease: items[0]?.lease ?? "",
      });
    } finally {
      second.stop();
    }
    app = mount(fixture.dir);
    team = app.board;
  }, 60_000);

  test("a corrupt inbox record is skipped and the queue keeps serving", async () => {
    const store = createBoardStore({ dir: fixture.dir });
    const state = createPersistedStore(store);
    // Plant garbage where an inbox record would be, then push a real one.
    const garbage = JSON.stringify({
      "bb.v": 1,
      "bb.role": "state",
      "bb.kind": "inbox",
      "bb.data": "not-an-object",
    });
    const created = await fixture.run([
      "create",
      "--title=planted corrupt inbox",
      "--type=task",
      `--metadata=${garbage}`,
      "--json",
    ]);
    const parsed: unknown = JSON.parse(created.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const id =
      row !== null && typeof row === "object" && "id" in row
        ? String((row as Record<string, unknown>).id)
        : "";
    await fixture.run(["label", "add", id, "bb.state=inbox"]);
    expect(await state.list("inbox")).toBeDefined();
    const thread = "conformance:syncrun:corrupt";
    await team.inboxPush("conformance", [
      {
        id: "conformance-inbox-syncrun-corrupt",
        event: {
          kind: "message" as const,
          channel: "conformance:syncrun",
          thread,
          subthread: null,
          message: "1",
          isRoot: true,
          text: "conformance: after corruption",
          context: null,
          author,
        },
        raw: null,
      },
    ]);
    const items = (await team.inboxNext("conformance", { limit: 50 })).filter(
      (item) => item.thread === thread,
    );
    expect(items).toHaveLength(1);
  }, 60_000);
});
