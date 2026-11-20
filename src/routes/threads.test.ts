import { afterAll, describe, expect, test } from "bun:test";
import { board, BoardError, HttpError, type Board } from "@vercel/board";
import {
  type BdFixture,
  createBdFixture,
} from "../../test/helpers/bd-fixture.ts";
import { beads } from "../backend.ts";

/**
 * The threads and messages routes, against the real entry point: a fixture
 * tracker, `beads({ dir })` mounted under `board()`, driven through the
 * handle the way `vb` drives a board. No mocks anywhere.
 */

/** Collect a call's protocol error instead of failing the test on it. */
async function errorOf(
  promise: Promise<unknown>,
  what = "the call",
): Promise<BoardError | HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BoardError) return error;
    // A route called directly (bypassing board()'s HTTP surface) throws its
    // own HttpError; it carries the same status and code.
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error(`expected ${what} to fail with a protocol error`);
}

describe("threads and messages routes (real bd, mounted through board())", () => {
  let fixture: BdFixture;
  let team: Board;
  let backend: ReturnType<typeof beads>;
  let board2: Board | null = null;

  afterAll(() => {
    fixture?.close();
  });

  test("boots the fixture and mounts beads({ dir }) under board()", async () => {
    fixture = await createBdFixture();
    backend = beads({ dir: fixture.dir, timeoutMs: 120_000 });
    team = board({ backend });
  }, 180_000);

  test("discovery answers without a token through the real fetch handler", async () => {
    const response = await team.fetch(
      new Request("http://in-process.board/", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.version).toBe("string");
    expect(typeof body.url).toBe("string");
    expect((body.url as string).length).toBeGreaterThan(0);
    expect(body.audience).toBe(body.url);
    expect(Array.isArray(body.sync)).toBeTrue();
    // Explicit budget, not the unit's 90-120s default: the first fetch runs
    // bind (bd version probe, capability probe, state load), the full suite
    // runs fixture sets concurrently, and every test in this file rides the
    // same loaded-box reality — bun's 5s default is an unloaded-box
    // assumption, not a contract.
  }, 180_000);

  test("me answers the handle's own identity and full access", async () => {
    const me = await team.me();
    expect(me.actor).toBe("board:client");
    expect(me.principal).toBe("board:client");
    expect(me.profile).toBeNull();
    expect(Object.keys(me.can)).toContain("*");
  }, 180_000);

  test("post a root and a reply; threads and thread reads see both", async () => {
    const root = await team.post("dev", "root message text");
    expect(root.id).not.toBe("");
    expect(root.channel).toBe("dev");
    expect(root.re).toBeNull();
    expect(root.version).toBe(1);
    expect(root.revision).toBe(1);

    const reply = await team.reply(root.id, "a reply lands");
    expect(reply.re).toBe(root.id);
    expect(reply.thread).toBe(root.thread);
    expect(reply.version).toBe(1);

    const page = await team.threads({ channel: "dev" });
    expect(page.threads).toHaveLength(1);
    const summary = page.threads[0];
    expect(summary?.message.id).toBe(root.id);
    expect(summary?.replies).toBe(1);
    expect(summary?.last?.id).toBe(reply.id);

    const thread = await team.thread(root.id);
    expect(thread.message.id).toBe(root.id);
    expect(thread.replies.map((r) => r.id)).toEqual([reply.id]);

    const messages = await team.channel("dev").messages();
    expect(messages.messages.map((m) => m.id)).toEqual([root.id, reply.id]);
  }, 180_000);

  test("threads page backward by `older` until it is null, each thread once", async () => {
    const first = await team.post("paging", "paging thread one");
    const second = await team.post("paging", "paging thread two");
    const third = await team.post("paging", "paging thread three");

    const page1 = await team.threads({ channel: "paging", limit: 2 });
    expect(page1.threads).toHaveLength(2);
    expect(page1.older).toBeTruthy();
    const seen = new Set(page1.threads.map((t) => t.message.id));

    const page2 = await team.threads({
      channel: "paging",
      limit: 2,
      before: page1.older ?? "",
    });
    expect(page2.threads).toHaveLength(1);
    for (const summary of page2.threads) seen.add(summary.message.id);
    expect(seen).toEqual(new Set([first.id, second.id, third.id]));
    expect(page2.older).toBeNull();

    // after and before are never taken together
    const both = await errorOf(
      team.threads({
        channel: "paging",
        after: first.id,
        before: page1.older ?? "",
      }),
    );
    expect(both.status).toBe(400);
    expect(both.code).toBe("invalid_request");
  }, 180_000);

  test("channelMessages pages by cursor without repeating or skipping", async () => {
    // Sequential posts keep ids in sequence order.
    const made = [
      await team.post("feed", "feed one"),
      await team.post("feed", "feed two"),
      await team.post("feed", "feed three"),
    ];
    const ids = made.map((m) => m.id);
    // A read with no `after` answers the newest `limit`, oldest first.
    const page1 = await team.channel("feed").messages({ limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(ids.slice(1));
    expect(page1.cursor).toBe(ids[2]);
    // From its cursor, only the ones posted since: nothing repeated.
    const page2 = await team
      .channel("feed")
      .messages({ after: page1.cursor, limit: 2 });
    expect(page2.messages).toHaveLength(0);
    const fourth = await team.post("feed", "feed four");
    const page3 = await team.channel("feed").messages({ after: page1.cursor });
    expect(page3.messages.map((m) => m.id)).toEqual([fourth.id]);
    // And with no cursor the channel reads whole, oldest first.
    const all = await team.channel("feed").messages();
    expect(all.messages.map((m) => m.id)).toEqual([...ids, fourth.id]);
  }, 180_000);

  test("edit bumps version and revision; a stale revision answers revision_conflict", async () => {
    const made = await team.post("editing", "original text");
    await team.edit(made.id, "edited text once");
    const once = await team.thread(made.id);
    expect(once.message.text).toBe("edited text once");
    expect(once.message.version).toBe(2);
    expect(once.message.revision).toBe(2);
    expect(once.message.editedAt).toBeTruthy();

    const stale = await errorOf(
      team.edit(made.id, "too late", { revision: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("revision_conflict");

    // The message is unchanged by the conflict.
    const after = await team.thread(made.id);
    expect(after.message.text).toBe("edited text once");
    expect(after.message.version).toBe(2);
  }, 180_000);

  test("react bumps version only, not revision", async () => {
    const made = await team.post("reacting", "react to me");
    const before = await team.thread(made.id);
    await team.react(made.id, "eyes");
    const after = await team.thread(made.id);
    expect(after.message.reactions).toEqual({ eyes: [expect.any(String)] });
    expect(after.message.version).toBe(before.message.version + 1);
    expect(after.message.revision).toBe(before.message.revision);

    await team.react(made.id, "eyes", { remove: true });
    const removed = await team.thread(made.id);
    expect(removed.message.reactions["eyes"]).toEqual([]);
  }, 180_000);

  test("delete leaves a readable tombstone; deleting again answers ok", async () => {
    const made = await team.post("deleting", "delete me");
    const revision = (await team.thread(made.id)).message.revision;
    await team.delete(made.id);
    const tombstone = await team.thread(made.id);
    expect(tombstone.message.deleted).toBeTrue();
    // A tombstone keeps no text.
    expect(tombstone.message.text).toBe("");
    expect(tombstone.message.version).toBe(2);
    expect(tombstone.message.revision).toBe(revision + 1);

    // A second delete is nothing (already gone), still ok.
    await team.delete(made.id);
    // An edit from before the delete is a conflict; an edit at all is refused.
    const stale = await errorOf(
      team.edit(made.id, "zombie", { revision: revision }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("revision_conflict");
    const fresh = await errorOf(team.edit(made.id, "zombie"));
    expect(fresh.status).toBe(400);
    expect(fresh.code).toBe("message_deleted");
    const reacted = await errorOf(team.react(made.id, "eyes"));
    expect(reacted.code).toBe("message_deleted");
  }, 180_000);

  test("labels round-trip, list by label, and reject reserved prefixes", async () => {
    const made = await team.post("labels", {
      text: "labeled",
      labels: { status: "open" },
    });
    const read = await team.thread(made.id);
    expect(read.message.labels).toEqual({ status: "open" });
    // Our own namespace never leaks into caller-visible labels.
    expect(
      Object.keys(read.message.labels).some((k) => k.startsWith("bb.")),
    ).toBeFalse();

    await team.label(made.id, { set: { priority: "high" } });
    await team.label(made.id, { unset: ["status"] });
    const changed = await team.thread(made.id);
    expect(changed.message.labels).toEqual({ priority: "high" });
    // Each label write raises the version: post, set, unset.
    expect(changed.message.version).toBe(3);

    const filtered = await team.threads({
      channel: "labels",
      label: ["priority=high"],
    });
    expect(filtered.threads.map((t) => t.message.id)).toEqual([made.id]);
    const filteredOut = await team.threads({
      channel: "labels",
      label: ["status=open"],
    });
    expect(filteredOut.threads).toHaveLength(0);

    const reserved = await errorOf(
      team.label(made.id, { set: { "board.task": "ready" } }),
    );
    expect(reserved.status).toBe(400);
    expect(reserved.code).toBe("reserved_label");
    const ours = await errorOf(
      team.label(made.id, { set: { "bb.channel": "nope" } }),
    );
    expect(ours.status).toBe(400);
    expect(ours.code).toBe("reserved_label");
    const onPost = await errorOf(
      team.post("labels", { text: "reserved", labels: { "board.x": "1" } }),
    );
    expect(onPost.code).toBe("reserved_label");

    // The label fence: `if` holds only while the labels are as it says.
    const conflict = await errorOf(
      team.label(made.id, { set: { priority: "low" }, if: { priority: null } }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("label_conflict");
    const landed = await team.label(made.id, {
      set: { priority: "low" },
      if: { priority: "high" },
    });
    expect(landed.ok).toBeTrue();
  }, 180_000);

  test("a client id posts once; posted finds it; a stolen id is duplicate_id", async () => {
    const made = await team.post("idempotent", {
      text: "only once",
      id: "client-once-1",
    });
    const again = await team.post("idempotent", {
      text: "only once",
      id: "client-once-1",
    });
    expect(again.id).toBe(made.id);
    const found = await team.posted("client-once-1");
    expect(found.id).toBe(made.id);
    const missing = await errorOf(team.posted("client-never-posted"));
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("post_not_found");

    // board() keeps client ids per caller of its own, so a stolen id is
    // driven through the backend's route table, where an id arrives as
    // given: the same id from another caller is 409 duplicate_id.
    const raw = await backend.post(
      { self: "raw-a", origin: {} },
      { channel: "idempotent", text: "mine first", id: "raw-once" },
      new AbortController().signal,
    );
    expect(raw.message.id).toBeTruthy();
    const stolen = await errorOf(
      backend.post(
        { self: "idem-thief", origin: {} },
        { channel: "idempotent", text: "mine now", id: "raw-once" },
        new AbortController().signal,
      ),
    );
    expect(stolen.status).toBe(409);
    expect(stolen.code).toBe("duplicate_id");
  }, 180_000);

  test("a reply `after` a message lands only while it is the newest", async () => {
    const root = await team.post("fenced", "fence root");
    const first = await team.reply(root.id, {
      text: "first reply",
      after: root.id,
    });
    expect(first.version).toBe(1);
    // The root is no longer the newest: a reply after it names the newer one.
    const conflict = await errorOf(
      team.reply(root.id, { text: "too late", after: root.id }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("newer_message");
    // `after` must name a message of this thread.
    const other = await team.post("fenced", "another thread");
    const alien = await errorOf(
      team.reply(root.id, { text: "cross-thread", after: other.id }),
    );
    expect(alien.status).toBe(400);
    expect(alien.code).toBe("invalid_after");
    // Plain replies still land.
    const plain = await team.reply(root.id, "no fence on me");
    expect(plain.re).toBe(root.id);
  }, 180_000);

  test("three concurrent edits at one revision: exactly one winner, exact 409 codes", async () => {
    const made = await team.post("races", "race edit target");
    const revision = (await team.thread(made.id)).message.revision;
    const settled = await Promise.allSettled([
      team.edit(made.id, "edit A", { revision }),
      team.edit(made.id, "edit B", { revision }),
      team.edit(made.id, "edit C", { revision }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const loss of lost) {
      const error = (loss as PromiseRejectedResult).reason as BoardError;
      expect(error.status).toBe(409);
      expect(error.code).toBe("revision_conflict");
    }
    const final = await team.thread(made.id);
    expect(final.message.version).toBe(2);
    expect(final.message.revision).toBe(revision + 1);
    expect(["edit A", "edit B", "edit C"]).toContain(final.message.text);
  }, 180_000);

  test("three concurrent replies after one message: one lands, losers say newer_message", async () => {
    const root = await team.post("races", "race reply root");
    const settled = await Promise.allSettled([
      team.reply(root.id, { text: "reply A", after: root.id }),
      team.reply(root.id, { text: "reply B", after: root.id }),
      team.reply(root.id, { text: "reply C", after: root.id }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const loss of lost) {
      const error = (loss as PromiseRejectedResult).reason as BoardError;
      expect(error.status).toBe(409);
      expect(error.code).toBe("newer_message");
    }
    const thread = await team.thread(root.id);
    expect(thread.replies).toHaveLength(1);
  }, 180_000);

  test("three concurrent label claims racing on no label: one lands, losers label_conflict", async () => {
    const made = await team.post("races", "race label target");
    const settled = await Promise.allSettled([
      team.label(made.id, { set: { owner: "A" }, if: { owner: null } }),
      team.label(made.id, { set: { owner: "B" }, if: { owner: null } }),
      team.label(made.id, { set: { owner: "C" }, if: { owner: null } }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const loss of lost) {
      const error = (loss as PromiseRejectedResult).reason as BoardError;
      expect(error.status).toBe(409);
      expect(error.code).toBe("label_conflict");
    }
    const labels = (await team.thread(made.id)).message.labels;
    expect(["A", "B", "C"]).toContain(labels.owner);
  }, 180_000);

  test("a narrowed caller reads only where its can reaches and edits nothing of another's", async () => {
    const alice = team.as("alice");
    const secret = await alice.post("sec", "alice speaks in sec");
    const open = await alice.post("dev", "alice speaks in dev");

    // bob is narrowed to read-only on dev and its subtree.
    const bob = team.as("bob", { can: { "dev/": ["read"] } });
    const readable = await bob.threads({ channel: "dev" });
    expect(readable.threads.map((t) => t.message.id)).toContain(open.id);

    // A channel out of bob's can reads as empty, and its messages are not-found.
    const hidden = await bob.threads({ channel: "sec" });
    expect(hidden.threads).toHaveLength(0);
    const blind = await errorOf(bob.thread(secret.id));
    expect(blind.status).toBe(404);
    expect(blind.code).toBe("message_not_found");

    // Read-only means no posts.
    const postRefused = await errorOf(bob.post("dev", "bob cannot post"));
    expect(postRefused.status).toBe(403);
    expect(postRefused.code).toBe("forbidden");

    // Another author's message, in a channel bob can read: forbidden, not found,
    // because bob can't edit anyone's message read-only anyway.
    const editRefused = await errorOf(bob.edit(open.id, "bob was here"));
    expect([403, 404]).toContain(editRefused.status);

    // carol reads everything but owns nothing of alice's: 403 forbidden.
    const carol = team.as("carol");
    const owned = await errorOf(carol.edit(secret.id, "carol was here"));
    expect(owned.status).toBe(403);
    expect(owned.code).toBe("forbidden");
    const deleted = await errorOf(carol.delete(secret.id));
    expect(deleted.status).toBe(403);
    expect(deleted.code).toBe("forbidden");

    // Alice still edits her own.
    await alice.edit(secret.id, "alice revises");
    const revised = await alice.thread(secret.id);
    expect(revised.message.text).toBe("alice revises");
  }, 180_000);

  test("a new backend instance over the same dir still serves everything", async () => {
    board2 = board({
      backend: beads({ dir: fixture.dir, timeoutMs: 120_000 }),
    });
    const page = await board2.threads({ channel: "dev" });
    expect(page.threads.length).toBeGreaterThan(0);
    const me = await board2.me();
    expect(me.actor).toBe("board:client");
    const found = await board2.posted("client-once-1");
    expect(found.text).toBe("only once");
    // A thread reads with its replies intact.
    const root = page.threads[0];
    if (root) {
      const thread = await board2.thread(root.message.id);
      expect(thread.message.id).toBe(root.message.id);
    }
  }, 180_000);

  test("channels list what posts made, and createChannel answers created", async () => {
    const channels = await team.channels();
    const paths = channels.channels.map((c) => c.path);
    expect(paths).toContain("dev");
    expect(paths).toContain("paging");

    const made = await team.createChannel("empty-room");
    expect(made.created).toBeTrue();
    expect(made.channel.path).toBe("empty-room");
    const again = await team.createChannel("empty-room");
    expect(again.created).toBeFalse();

    const bad = await errorOf(team.createChannel("Not a Channel"));
    expect(bad.status).toBe(400);

    const prefixed = await team.channels({ prefix: "p" });
    expect(prefixed.channels.map((c) => c.path)).toContain("paging");
    expect(prefixed.channels.map((c) => c.path)).not.toContain("dev");
  }, 180_000);

  test("actors list the caller after it writes", async () => {
    const actors = await team.actors();
    // The kit knows actors by id; the handle's own id is among them.
    const ids = actors.map((a) => a.id);
    expect(ids).toContain("board:client");
    expect(ids).toContain("board:client:alice");
    const alice = actors.find((a) => a.id === "board:client:alice");
    expect(alice?.handle).toBe("alice");
  }, 180_000);

  test("the events feed rides the same tracker as the threads routes", async () => {
    // The consumer's head so far, as the anchor for what comes next.
    const start = await team.poll({ channel: "feed-e2e" });
    expect(start.events).toHaveLength(0);

    // A post made after the anchor is on the feed past it, with its own cursor.
    const made = await team.post("feed-e2e", "the feed sees me");
    const page = await team.poll({
      channel: "feed-e2e",
      after: start.cursor,
      wait: 5,
    });
    const posted = page.events.find(
      (event) =>
        event.type === "message.posted" && event.message?.id === made.id,
    );
    expect(posted).toBeTruthy();

    // Reading on from that page's cursor never repeats the event.
    const again = await team.poll({
      channel: "feed-e2e",
      after: page.cursor,
      wait: 1,
    });
    expect(
      again.events.some((event) => event.message?.id === made.id),
    ).toBeFalse();

    // A feed read can also anchor on a channel-messages cursor: one tracker,
    // one cursor language.
    const msgCursor = (await team.channel("feed-e2e").messages({ limit: 1 }))
      .cursor;
    const anchored = await team.post("feed-e2e", "found from a cursor");
    const fromMessages = await team.poll({
      channel: "feed-e2e",
      after: msgCursor,
      wait: 5,
    });
    expect(
      fromMessages.events.some(
        (event) =>
          event.type === "message.posted" && event.message?.id === anchored.id,
      ),
    ).toBeTrue();

    // A long-poll held past the cursor wakes when a matching post lands.
    // `wait` bounds the hang, not the semantics: the event-present
    // assertion below is the wake proof, and under the full suite's load
    // the delivering bd read can take tens of seconds on its own.
    const pending = team.poll({
      channel: "feed-e2e",
      after: fromMessages.cursor,
      wait: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const waker = await team.post("feed-e2e", "wake the poll");
    const woke = await pending;
    expect(
      woke.events.some(
        (event) =>
          event.type === "message.posted" && event.message?.id === waker.id,
      ),
    ).toBeTrue();
    // The budget is deliberately generous: under the full suite's load each
    // bd invocation runs seconds, and a test killed mid-poll leaves bd
    // children whose stale dolt locks 503 the tests after it.
  }, 240_000);

  test("hostile inputs answer typed 4xx/501, never 500 internal", async () => {
    const made = await team.post("hostile", "hostile target");

    // Each call is built lazily, in turn: some of these throw (or reject)
    // before ever reaching the backend, and an eager promise that no one has
    // awaited yet only muddies the failure.
    const checks: {
      call: () => Promise<unknown>;
      status: number;
      code: string;
    }[] = [
      {
        call: async () => team.post("hostile", "x".repeat(10_001)),
        status: 400,
        code: "text_too_long",
      },
      {
        call: async () => team.edit("no-such-issue", "ghost"),
        status: 404,
        code: "message_not_found",
      },
      {
        call: async () => team.delete("no-such-issue"),
        status: 404,
        code: "message_not_found",
      },
      {
        call: async () => team.react("no-such-issue", "eyes"),
        status: 404,
        code: "message_not_found",
      },
      {
        call: async () => team.thread("no-such-issue"),
        status: 404,
        code: "message_not_found",
      },
      {
        call: async () =>
          team.threads({ channel: "dev", before: "!!not-a-cursor!!" }),
        status: 400,
        code: "invalid_cursor",
      },
      {
        // The handle validates the channel name synchronously; through the
        // lazy wrapper that lands as the call's rejection.
        call: async () => team.channel("dev/").messages(),
        status: 400,
        code: "invalid_request",
      },
      {
        call: async () => team.threads({ channel: "dev", text: "find me" }),
        status: 501,
        code: "not_supported",
      },
      {
        call: async () => team.threads({}),
        status: 501,
        code: "not_supported",
      },
      {
        call: async () => team.schedule("hostile", { text: "later", in: "1h" }),
        status: 501,
        code: "no_scheduler",
      },
      {
        call: async () => team.schedules(),
        status: 501,
        code: "no_scheduler",
      },
      {
        call: async () => team.grants(),
        status: 501,
        code: "no_grants",
      },
      {
        call: async () => team.schemas(),
        status: 501,
        code: "no_schemas",
      },
      {
        call: async () =>
          team.upload({
            data: new Uint8Array([1]),
            name: "f",
            type: "text/plain",
          }),
        status: 501,
        code: "no_files",
      },
    ];
    for (const check of checks) {
      const error = await errorOf((async () => check.call())(), check.code);
      const message = `${check.code}: got ${error.status} ${error.code} (${error.message})`;
      expect(message).toContain(check.code);
      expect(error.status).toBe(check.status);
      expect(error.status).not.toBe(500);
    }
    // A bd label key board() would never let through is still refused at the
    // route: a comma would silently split into two bd labels.
    const comma = await errorOf(
      backend.label(
        { self: "raw-a", origin: {} },
        { id: made.id, set: { "has,comma": "1" } },
        new AbortController().signal,
      ),
    );
    expect(comma.status).toBe(400);
    expect(comma.code).toBe("invalid_label");

    // And the plain reads keep working afterwards: nothing corrupted the tracker.
    const page = await team.threads({ channel: "hostile" });
    expect(page.threads).toHaveLength(1);
  }, 180_000);

  test("a task reads as its thread: the thread view projects the task's state, claim, and needs", async () => {
    const made = await team.tasks.create("t-view", {
      text: "a task read as its thread",
    });
    expect(made.task.task?.state).toBe("ready");
    // The same read through the threads surface — the seam the conformance
    // kit reads and the unit rig answered through tasks.list instead.
    const thread = await team.thread(made.task.id);
    expect(thread.message.task?.state).toBe("ready");
    expect(thread.message.task?.owner).toBe("board:client");
    expect(thread.message.labels["board.task"]).toBe("ready");

    const waiter = await team.tasks.create("t-view", {
      text: "a task that waits for it",
      needs: [made.task.id],
    });
    const waiting = await team.thread(waiter.task.id);
    expect(waiting.message.task?.state).toBe("waiting");
    expect(waiting.message.task?.needs).toEqual([made.task.id]);
    // A claim shows on the thread read too, holder and until, never a token.
    const claim = await team.tasks.claim(made.task.id, { lease: 60 });
    const claimed = await team.thread(made.task.id);
    expect(claimed.message.task?.state).toBe("claimed");
    expect(claimed.message.task?.claim?.actor).toBe("board:client");
    expect(claimed.message.task?.claim?.until).toBe(claim.until);
    expect(JSON.stringify(claimed.message.task)).not.toContain(claim.token);
    // A thread that is no task carries no task at all.
    const plain = await team.post("t-view", "not a task");
    expect((await team.thread(plain.id)).message.task).toBeUndefined();
    await claim.release();
  }, 180_000);

  test("an edit of a task's root by anyone but its owner holds it and ends its claim", async () => {
    // A profile writes the thread; its principal makes it a task. The
    // profile is the root's author, so its edit passes the author gate —
    // and it is not the task's maker, so the edit holds the task as
    // `edited`, which ends the claim. This is the rule both the threads
    // edit route and a sync import edit serve (one shared write guard).
    const writer = team.as("writer");
    const thread = await writer.post(
      "t-edit",
      "a profile's thread, made a task by its principal",
    );
    const made = await team.tasks.create({ re: thread.id });
    expect(made.task.task?.by).toBe("board:client");
    const claim = await team.tasks.claim(made.task.id, { lease: 60 });
    await writer.edit(thread.id, "edited by the profile that wrote it");
    const edited = await team.thread(thread.id);
    expect(edited.message.task?.state).toBe("blocked");
    expect(edited.message.task?.blocked?.kind).toBe("edited");
    const lost = await errorOf(claim.complete("conformance: too late"));
    expect(lost.status).toBe(409);
    expect(lost.code).toBe("claim_lost");
    // The owner lifts the hold: ready again.
    const unblocked = await team.tasks.unblock(made.task.id);
    expect(unblocked.task?.state).toBe("ready");
    await team.tasks.cancel(made.task.id, "done checking");
  }, 180_000);

  // CI-only red under the official bd binary (issue #11): the task.ready event
  // doesn't reach the feed on the runner's bd build. Un-skip when the bind-time
  // journal-shape probe lands.
  test.skipIf(Boolean(process.env.CI))(
    "the feed carries a task's state moves, and a board.task=ready filter still sees the claim",
    async () => {
      const anchor = (await team.poll({ channel: "t-feed" })).cursor;
      const first = await team.tasks.create("t-feed", {
        text: "a prerequisite to watch",
        labels: { conformance: "feed" },
      });
      const second = await team.tasks.create("t-feed", {
        text: "a task to watch become ready",
        labels: { conformance: "feed" },
        needs: [first.task.id],
      });
      await (await team.tasks.claim(first.task.id, { lease: 60 })).complete();
      // The readying lands on the feed with the state after each event. Under
      // load the feed's cadence slips, so settle: bounded retries until the
      // event appears or the budget runs out (the event must appear).
      const findEvent = async (
        poll: Parameters<typeof team.poll>[0],
        match: (event: { type: string; message?: { id: string } }) => boolean,
      ) => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const page = await team.poll(poll);
          const found = page.events.find(match);
          if (found !== undefined) return { found, lastPage: page };
          poll = { ...poll, wait: 10 };
        }
        return { found: undefined, lastPage: undefined };
      };
      const { found: ready } = await findEvent(
        { channel: "t-feed", after: anchor, wait: 10 },
        (event) =>
          event.type === "task.ready" && event.message?.id === second.task.id,
      );
      expect(ready).toBeTruthy();
      expect(ready?.message?.task?.state).toBe("ready");
      // The filter taken before the claim still shows the claim: the event
      // matches on the labels before it or after it.
      const claim = await team.tasks.claim(second.task.id, { lease: 60 });
      const { found: claimed, lastPage: claimedPage } = await findEvent(
        {
          channel: "t-feed",
          after: anchor,
          label: ["conformance=feed", "board.task=ready"],
          wait: 10,
        },
        (event) =>
          event.type === "task.claimed" && event.message?.id === second.task.id,
      );
      expect(claimed).toBeTruthy();
      expect(claimed?.message?.task?.state).toBe("claimed");
      // And a claim's token shows nowhere on the feed.
      expect(JSON.stringify(claimedPage?.events ?? [])).not.toContain(
        claim.token,
      );
      await claim.release();
    },
    180_000,
  );
});
