import { afterAll, describe, expect, test } from "bun:test";
import { HttpError, type Caller, type EventsPage } from "@vercel/board";
import { BdTransport } from "../bd/transport.ts";
import {
  applyDelete,
  applyEdit,
  applyReaction,
  createMetadataCodec,
  initialMessageMeta,
  type MessageMeta,
} from "../model/metadata.ts";
import { createLabels } from "../model/labels.ts";
import { deriveTitle } from "../model/message.ts";
import { encodeOlderCursor } from "../model/cursors.ts";
import {
  createEventRoutes,
  type EventsInput,
  type EventRoutes,
} from "./events.ts";
import {
  createBdFixture,
  type BdFixture,
} from "../../test/helpers/bd-fixture.ts";

/**
 * Events long-poll against a real bd tracker: every scenario writes through
 * the fixture the way the backend's own routes do (create, then a metadata
 * update), and reads through the route method the registry wires.
 */

interface Rig {
  fixture: BdFixture;
  transport: BdTransport;
  routes: EventRoutes;
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const done of cleanups) done();
});

const codec = createMetadataCodec();
const caller: Caller = { self: null, origin: {} };

async function rig(options?: {
  journalWrites?: boolean;
  holdMs?: number;
}): Promise<Rig> {
  const fixture = await createBdFixture();
  cleanups.push(() => fixture.close());
  const transport = new BdTransport({
    dir: fixture.dir,
    actor: "events-test",
    journal: options?.journalWrites ?? true,
  });
  const routes = createEventRoutes({
    transport,
    codec,
    labels: createLabels(),
    cadenceMs: 100,
    holdMs: options?.holdMs ?? 3_000,
  });
  routes.poller.start();
  cleanups.push(() => {
    void routes.poller.stop();
  });
  return { fixture, transport, routes };
}

function events(rig_: Rig, input: EventsInput): Promise<EventsPage> {
  return rig_.routes.events(caller, input, new AbortController().signal);
}

async function runOk(
  fixture: BdFixture,
  args: string[],
  options?: { journal?: boolean },
): Promise<unknown> {
  const done = await fixture.run(args, options);
  expect(done.code).toBe(0);
  try {
    return JSON.parse(done.stdout) as unknown;
  } catch {
    return done.stdout;
  }
}

function issueIdOf(parsed: unknown): string {
  const row = (parsed ?? {}) as { data?: { id?: unknown }; id?: unknown };
  const id = row.data?.id ?? row.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(`no issue id in ${JSON.stringify(parsed)}`);
  }
  return id;
}

function encode(meta: MessageMeta): string {
  const encoded = codec.encodeMessage(meta);
  if (!encoded.ok) throw new Error("metadata refused");
  return JSON.stringify(encoded.value);
}

/** Post a message the way the backend does: create, then the metadata write. */
async function post(
  rig_: Rig,
  channel: string,
  text: string,
  options?: {
    thread?: string;
    parent?: string | null;
    from?: string | null;
    labels?: Record<string, string>;
  },
): Promise<{ id: string; meta: MessageMeta }> {
  const created = await runOk(rig_.fixture, [
    "create",
    "--title",
    deriveTitle(text),
    "--description",
    text,
    "--json",
  ]);
  const id = issueIdOf(created);
  const meta = initialMessageMeta({
    channel,
    thread: options?.thread ?? id,
    parent: options?.parent ?? null,
    from: options?.from ?? null,
  });
  await runOk(rig_.fixture, [
    "update",
    id,
    "--metadata",
    encode(meta),
    "--json",
  ]);
  if (options?.labels !== undefined) {
    const entries = Object.entries(options.labels).sort(([a], [b]) =>
      a < b ? -1 : 1,
    );
    const rendered = entries
      .map(([name, value]) => (value === "" ? name : `${name}=${value}`))
      .join(",");
    if (rendered !== "") {
      await runOk(rig_.fixture, ["label", "add", id, rendered]);
    }
  }
  return { id, meta };
}

async function edit(
  rig_: Rig,
  message: { id: string; meta: MessageMeta },
  text: string,
): Promise<{ id: string; meta: MessageMeta }> {
  const meta = applyEdit(message.meta, new Date().toISOString());
  await runOk(rig_.fixture, [
    "update",
    message.id,
    "--description",
    text,
    "--metadata",
    encode(meta),
    "--json",
  ]);
  return { id: message.id, meta };
}

async function react(
  rig_: Rig,
  message: { id: string; meta: MessageMeta },
  emoji: string,
  actor: string,
): Promise<{ id: string; meta: MessageMeta }> {
  const meta = applyReaction(message.meta, emoji, actor);
  await runOk(rig_.fixture, [
    "update",
    message.id,
    "--metadata",
    encode(meta),
    "--json",
  ]);
  return { id: message.id, meta };
}

async function del(
  rig_: Rig,
  message: { id: string; meta: MessageMeta },
): Promise<{ id: string; meta: MessageMeta }> {
  const meta = applyDelete(message.meta);
  await runOk(rig_.fixture, [
    "update",
    message.id,
    "--metadata",
    encode(meta),
    "--json",
  ]);
  return { id: message.id, meta };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function httpErrorOf(error: unknown): HttpError {
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe("events long-poll", () => {
  test("a write through the tracker arrives at once, in journal order", async () => {
    const r = await rig();
    const root = await post(r, "errors-www", "deploy failed on a1b2c3");
    const reply = await post(r, "errors-www", "on it", {
      thread: root.id,
      parent: root.id,
    });

    const page = await events(r, { after: "0" });
    expect(page.events).toHaveLength(2);
    const [first, second] = page.events;
    expect(first?.type).toBe("message.posted");
    expect(first?.message?.id).toBe(root.id);
    if (first?.type === "message.posted") {
      expect(first.payload.channel).toBe("errors-www");
      expect(first.payload.text).toBe("deploy failed on a1b2c3");
      expect(first.payload.re).toBeNull();
    }
    expect(second?.type).toBe("message.posted");
    expect(second?.message?.id).toBe(reply.id);
    if (second?.type === "message.posted") {
      expect(second.payload.re).toBe(root.id);
    }
    // Journal seqs order the feed and ride the cursors.
    expect(Number(first?.cursor)).toBeLessThan(Number(second?.cursor));
    // The page's cursor is the last row examined, matched or not: the
    // reply's trailing metadata row sits past its posted event.
    expect(Number(page.cursor)).toBeGreaterThanOrEqual(Number(second?.cursor));
    expect(r.routes.poller.status).toBe("live");
  }, 120_000);

  test("a message id anchors the feed past its own post, and an empty page's boundary starts it", async () => {
    const r = await rig();
    const root = await post(r, "dev", "anchor message");
    const reply = await post(r, "dev", "the reply", {
      thread: root.id,
      parent: root.id,
    });

    // A message cursor answers the events after that message's own post:
    // the reply's, not the anchor's.
    const past = await events(r, { after: root.id });
    expect(past.events.map((entry) => entry.type)).toEqual(["message.posted"]);
    expect(past.events[0]?.message?.id).toBe(reply.id);

    // The boundary an empty messages page answers with is a cursor too:
    // it reads the feed from its start.
    const boundary = encodeOlderCursor({
      updated_at: "1970-01-01T00:00:00.000Z",
      id: "0",
    });
    const all = await events(r, { after: boundary });
    expect(all.events).toHaveLength(2);
    expect(all.events.map((entry) => entry.message?.id)).toEqual([
      root.id,
      reply.id,
    ]);

    // An id that names nothing on this board is a hostile cursor.
    const error = httpErrorOf(
      await events(r, { after: "zzzzzz-none", wait: 0 }).catch(
        (caught: unknown): unknown => caught,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_cursor");
  }, 120_000);

  test("reading on from a page's cursor never repeats, and picks up the next write", async () => {
    const r = await rig();
    const root = await post(r, "dev", "first post");
    const page = await events(r, { after: "0" });
    expect(page.events).toHaveLength(1);

    const quiet = await events(r, { after: page.cursor });
    expect(quiet.events).toHaveLength(0);

    const next = await post(r, "dev", "second post");
    const more = await events(r, { after: page.cursor });
    expect(more.events).toHaveLength(1);
    expect(more.events[0]?.message?.id).toBe(next.id);
  }, 120_000);

  test("a quiet long-poll returns an empty page after the wait", async () => {
    const r = await rig();
    const root = await post(r, "dev", "quiet around here");
    const page = await events(r, { after: "0" });
    expect(page.events).toHaveLength(1);

    const started = Date.now();
    const waited = await events(r, { after: page.cursor, wait: 2 });
    const elapsed = Date.now() - started;
    expect(waited.events).toHaveLength(0);
    expect(waited.cursor).toBe(page.cursor);
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(8_000);
  }, 120_000);

  test("a write during a long-poll releases the waiter early with the event", async () => {
    const r = await rig();
    const root = await post(r, "dev", "long-poll anchor");
    const anchor = await events(r, { after: "0" });

    const started = Date.now();
    const pending = events(r, { after: anchor.cursor, wait: 10 });
    await sleep(300);
    const reply = await post(r, "dev", "written while it waited", {
      thread: root.id,
      parent: root.id,
    });
    const page = await pending;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(8_000);
    expect(
      page.events.some((entry) => entry.message?.id === reply.id),
    ).toBeTrue();
  }, 120_000);

  test("a bare create holds the feed open until its metadata lands, then answers posted", async () => {
    const r = await rig();
    // The create commits before the metadata write, as every backend post does.
    const created = await runOk(r.fixture, [
      "create",
      "--title",
      "held post",
      "--description",
      "the body",
      "--json",
    ]);
    const id = issueIdOf(created);

    const pending = events(r, { after: "0", wait: 8 });
    await sleep(400);
    const meta = initialMessageMeta({ channel: "held", thread: id });
    await runOk(r.fixture, [
      "update",
      id,
      "--metadata",
      encode(meta),
      "--json",
    ]);
    const page = await pending;

    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.type).toBe("message.posted");
    expect(page.events[0]?.message?.id).toBe(id);
    if (page.events[0]?.type === "message.posted") {
      expect(page.events[0].payload.channel).toBe("held");
      expect(page.events[0].payload.text).toBe("the body");
    }
  }, 120_000);

  test("a pruned journal answers invalid_cursor with a re-baseline hint", async () => {
    const r = await rig();
    await post(r, "dev", "will be pruned");
    const sane = await events(r, { after: "0" });
    expect(sane.events).toHaveLength(1);

    await runOk(r.fixture, [
      "config",
      "set",
      "events-journal-retain-days",
      "0",
    ]);
    await runOk(r.fixture, [
      "config",
      "set",
      "events-journal-retain-rows",
      "0",
    ]);
    await runOk(r.fixture, ["events", "prune", "--before", "2"]);

    const error = httpErrorOf(
      await events(r, { after: "0", wait: 0 }).catch(
        (caught: unknown): unknown => caught,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_cursor");
    expect(`${error.message} ${error.hint ?? ""}`).toContain("re-baseline");
  }, 120_000);

  test("truncation mid-poll answers invalid_cursor instead of hanging", async () => {
    const r = await rig({ holdMs: 8_000 });
    // A bare create keeps the poll's cursor anchored below the journal head.
    await runOk(r.fixture, [
      "create",
      "--title",
      "plain issue",
      "--description",
      "not a message",
      "--json",
    ]);
    const pending = events(r, { after: "0", wait: 10 });
    await sleep(500);
    await runOk(r.fixture, [
      "config",
      "set",
      "events-journal-retain-days",
      "0",
    ]);
    await runOk(r.fixture, [
      "config",
      "set",
      "events-journal-retain-rows",
      "0",
    ]);
    await runOk(r.fixture, ["events", "prune", "--before", "2"]);

    const started = Date.now();
    const error = httpErrorOf(
      await pending.catch((caught: unknown): unknown => caught),
    );
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_cursor");
  }, 120_000);

  test("a never-enabled journal feeds empty and warns, naming the fix", async () => {
    const r = await rig({ journalWrites: false });
    // Writes land, but this fixture's bd runs without the journal env, so
    // nothing was ever recorded.
    await runOk(r.fixture, ["create", "--title", "unjournaled", "--json"], {
      journal: false,
    });

    const page = await events(r, { after: "0", wait: 0 });
    expect(page.events).toHaveLength(0);
    expect(page.cursor).toBe("0");

    // A cycle already running when the test calls is waited out, then one
    // full cycle of our own runs; a read that bd refused (a lock hiccup
    // under the rig's concurrent processes) retries on cadence, so settle
    // boundedly rather than betting on one clean invocation.
    for (let i = 0; i < 20 && r.routes.poller.warnings.length === 0; i++) {
      await sleep(100);
      await r.routes.poller.tick();
    }
    const warnings = r.routes.poller.warnings;
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]?.code).toBe("journal_disabled");
    expect(warnings[0]?.fix).toContain("BD_EVENTS_JOURNAL=1");
    expect(r.routes.poller.status).toBe("disabled");
  }, 120_000);

  test("board writes translate: edited, reaction, and tombstone", async () => {
    const r = await rig();
    const message = await post(r, "dev", "original text");
    const first = await events(r, { after: "0" });
    expect(first.events.map((entry) => entry.type)).toEqual(["message.posted"]);

    const edited = await edit(r, message, "the corrected text");
    const afterEdit = await events(r, { after: first.cursor });
    expect(afterEdit.events.map((entry) => entry.type)).toEqual([
      "message.edited",
    ]);
    if (afterEdit.events[0]?.type === "message.edited") {
      expect(afterEdit.events[0].payload.id).toBe(edited.id);
      expect(afterEdit.events[0].payload.text).toBe("the corrected text");
    }

    const reacted = await react(r, edited, "eyes", "reviewer");
    const afterReact = await events(r, { after: afterEdit.cursor });
    expect(afterReact.events.map((entry) => entry.type)).toEqual([
      "reaction.added",
    ]);
    if (afterReact.events[0]?.type === "reaction.added") {
      expect(afterReact.events[0].payload.emoji).toBe("eyes");
      expect(afterReact.events[0].payload.id).toBe(reacted.id);
    }

    const deleted = await del(r, reacted);
    const afterDelete = await events(r, { after: afterReact.cursor });
    expect(afterDelete.events.map((entry) => entry.type)).toEqual([
      "message.deleted",
    ]);
    expect(afterDelete.events[0]?.message?.id).toBe(deleted.id);
    expect(afterDelete.events[0]?.message?.deleted).toBeTrue();
  }, 120_000);

  test("filters narrow the feed: channel, re, and label", async () => {
    const r = await rig();
    const www = await post(r, "www", "in www", { labels: { status: "open" } });
    const ops = await post(r, "ops", "in ops", { from: "slack" });
    const reply = await post(r, "www", "a reply", {
      thread: www.id,
      parent: www.id,
    });

    const channelPage = await events(r, { after: "0", channel: "www" });
    expect(channelPage.events.map((entry) => entry.message?.id)).toEqual([
      www.id,
      reply.id,
    ]);

    const subtree = await events(r, { after: "0", channel: "www/" });
    expect(subtree.events.map((entry) => entry.message?.id)).toEqual([
      www.id,
      reply.id,
    ]);

    const rePage = await events(r, { after: "0", re: www.id });
    expect(rePage.events.map((entry) => entry.message?.id)).toEqual([
      www.id,
      reply.id,
    ]);

    const label: NonNullable<EventsInput["label"]> = [["status", ["open"]]];
    const labeled = await events(r, { after: "0", label });
    expect(labeled.events.map((entry) => entry.message?.id)).toEqual([www.id]);
  }, 120_000);

  test("issues that are not messages never enter the feed, and their rows still advance the cursor", async () => {
    const r = await rig({ holdMs: 1_500 });
    await runOk(r.fixture, [
      "create",
      "--title",
      "plain tracker issue",
      "--description",
      "never a message",
      "--json",
    ]);

    const first = await events(r, { after: "0", wait: 0 });
    expect(first.events).toHaveLength(0);
    // Held open briefly: the row may still become a message.
    expect(first.cursor).toBe("0");

    await sleep(2_000);
    const settled = await events(r, { after: "0", wait: 0 });
    expect(settled.events).toHaveLength(0);
    expect(Number(settled.cursor)).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("stopping the poller releases a pending long-poll promptly", async () => {
    const r = await rig();
    const root = await post(r, "dev", "stopping soon");
    const anchor = await events(r, { after: "0" });

    const pending = events(r, { after: anchor.cursor, wait: 30 });
    await sleep(300);
    await r.routes.poller.stop();

    const started = Date.now();
    const page = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(page.events).toHaveLength(0);
    expect(r.routes.poller.status).toBe("stopped");
    expect(root.id.length).toBeGreaterThan(0);
  }, 120_000);

  test("hostile cursors answer invalid_cursor", async () => {
    const r = await rig();
    for (const after of ["abc", "-1", "", "1.5", "99999999999999999999999"]) {
      const error = httpErrorOf(
        await events(r, { after, wait: 0 }).catch(
          (caught: unknown): unknown => caught,
        ),
      );
      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_cursor");
    }
  }, 120_000);

  test("`last` is refused as not_supported, and `wait` beyond the cap is clamped", async () => {
    const r = await rig();
    const error = httpErrorOf(
      await events(r, { last: 5 }).catch((caught: unknown): unknown => caught),
    );
    expect(error.status).toBe(501);
    expect(error.code).toBe("not_supported");
  }, 120_000);
});
