import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  board,
  type Backend,
  type Board,
  type BoardBinding,
} from "@vercel/board";
import { type BdFixture, createBdFixture } from "./helpers/bd-fixture.ts";
import { createEventRoutes } from "../src/routes/events.ts";
import { createBoardStore, threadsRoutes } from "../src/routes/threads.ts";
import { createWatcherRoutes } from "../src/routes/watchers.ts";
import { createSyncRoutes } from "../src/routes/sync.ts";
import { createLabels } from "../src/model/labels.ts";

/**
 * The hardening sweep: every failure mode a real user hits produces a typed,
 * documented outcome. Hostile or corrupt state never crashes the backend,
 * corrupts the tracker, or silently degrades.
 *
 * Everything here runs through the REAL mounted backend — the route registry
 * the backend assembles (threads + events + watchers + sync records) over a
 * real bd fixture tracker, mounted with board() and driven over
 * `handle.fetch`, the same surface an HTTP deployment serves. No mocks.
 *
 * Suites:
 *   1. Corrupt state — unparseable metadata, missing metadata, foreign issues:
 *      reads serve what they can, unrelated issues keep serving, writes to
 *      corrupt issues answer typed errors.
 *   2. Environment failures — bd missing from PATH, garbage bd --version,
 *      an unsupported bd version, a tracker dir without .beads: typed errors
 *      naming the fix.
 *   3. Hung subprocess — a bd invocation past its timeout is killed
 *      (tree-kill), surfaces typed, and the tracker is unchanged.
 *   4. Limits and hostile input — the 10k text bound, hostile labels and
 *      channels, unicode/emoji/CJK round-trips, hostile actor principals.
 *   5. Concurrent processes — two backend instances on one tracker: the
 *      single-writer contract is documented, not silently corrupted.
 *   6. The sweep bar — every implemented route, hit with hostile inputs,
 *      answers its typed error: no route ever answers 500 `internal`.
 */

// ---------------------------------------------------------------------------
// Harness: a mounted backend over a real fixture, driven over fetch.
// ---------------------------------------------------------------------------

/**
 * The sweep caller board() authenticates every fetch request as.
 *
 * Probed truth (board-src/packages/board/src/server/auth.ts + grants.ts): a
 * host principal must carry an id matching `vercel:user:<sub>…` and kind
 * `person` for the grant machinery to admit it — `byGrants` throws
 * `forbidden("this token can't use this board")` before grants are read for
 * anything whose id gives it no token facts (`factsFromId` parses only
 * `vercel:project:<id>:<env>`), so a `deployment` principal with a `user:` id
 * is refused outright, and an `everyone` grant admits no one (`admits`
 * ignores the `everyone` level). A `person` caller is a board member —
 * always admitted — and what it may do comes from a grant that names its
 * `userId` (the id's third segment, `userIdOf`).
 */
const CALLER_ID = "vercel:user:sweep";
/** The grant principal that names CALLER_ID, per `userIdOf`. */
const CALLER_USERID = "sweep";

interface Mount {
  app: Board;
  close: () => void;
}

/** The full landed registry — threads + events + watchers + sync — as one backend. */
function mountBackend(
  dir: string,
  options: { bdPath?: string; timeoutMs?: number } = {},
): Backend {
  const store = createBoardStore({
    dir,
    bdPath: options.bdPath,
    timeoutMs: options.timeoutMs,
  });
  const events = createEventRoutes({
    transport: store.transport,
    codec: store.codec,
    labels: createLabels({ namespace: store.codec.namespace }),
    authorFor: (slug) => store.authorForSlug(slug),
  });
  events.poller.start();
  const watchers = createWatcherRoutes({ store, cadenceMs: 250 });
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
          // The sweep's caller by name, plus the board's people at large:
          // the hostile-principals suite posts as arbitrary `vercel:user:<x>`
          // persons, and a person is always a member (`all-users` names them)
          // even when no grant names its id in particular. Probed:
          // grants.ts `levelOf` (`all-users` → member) and auth.ts
          // `callerFacts` (a person caller is `member: true`).
          principals: [
            { kind: "user", userId: CALLER_USERID },
            { kind: "all-users" },
          ],
          can: { "*": "all" as const },
        },
      ],
    },
    bind(binding: BoardBinding) {
      store.bind(binding);
    },
  } as unknown as Backend;
  // The sweep stops the journal consumer its mounts started: a leaked
  // poller keeps spawning bd on its cadence for the rest of the suite, and
  // the timing failures that follow are contention the tests then blame on
  // each other.
  (backend as { stopPoller?: () => void }).stopPoller = () =>
    void events.poller.stop();
  return backend;
}
/** Mount the registry, serving fetch requests as the sweep's caller. */
function mount(
  dir: string,
  options: {
    bdPath?: string;
    timeoutMs?: number;
    principalFromHeader?: boolean;
  } = {},
): Mount {
  const backend = mountBackend(dir, options);
  const app = board({
    backend,
    // board() hands `authenticate` its own parsed request (headers,
    // credential, claims — no URL object) and checks the principal it
    // returns as a host principal: id `vercel:user:<sub>`, kind `person`,
    // handle with no whitespace.
    authenticate: (request: { headers: Headers }) => {
      const profile = request.headers.get("x-board-profile");
      if (profile !== null && !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(profile)) {
        return null;
      }
      let id = CALLER_ID;
      if (options.principalFromHeader) {
        const given = request.headers.get("x-sweep-principal");
        if (given !== null) id = `vercel:user:${given}`;
      }
      return { id, kind: "person" as const, handle: "sweep" };
    },
  });
  // board()'s in-process handle keeps no close of its own; the optional
  // read keeps the harness honest where a future board() grows one.
  const closer = (app as { close?: () => void }).close;
  const stopPoller = (backend as { stopPoller?: () => void }).stopPoller;
  return {
    app,
    close: () => {
      stopPoller?.();
      closer?.();
    },
  };
}

/** One fetch outcome: status, protocol error code, and the decoded body. */
interface Outcome {
  status: number;
  code: string;
  message: string;
  body: unknown;
}

async function call(
  app: Board,
  method: string,
  path: string,
  init?: { body?: unknown; raw?: string; headers?: Record<string, string> },
): Promise<Outcome> {
  const headers = new Headers(init?.headers);
  let body: string | undefined;
  if (init?.raw !== undefined) {
    body = init.raw;
  } else if (init?.body !== undefined) {
    body = JSON.stringify(init.body);
  }
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await app.fetch(
    new Request(`http://sweep.test${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
  );
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const error = (parsed as { error?: { code?: unknown; message?: unknown } })
    ?.error;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : "",
    message: typeof error?.message === "string" ? error.message : "",
    body: parsed,
  };
}

/** The sweep bar counter: every hostile check, counted, none internal. */
let SWEEP_CHECKS = 0;

/**
 * The sweep bar itself: a route's answer is either not a 500, or a 500 with
 * a documented typed code (`state_corrupt` names the corruption and its fix).
 * `500 internal` is a bug, not a category.
 */
function expectTyped(outcome: Outcome, what: string): void {
  SWEEP_CHECKS += 1;
  if (outcome.status === 500) {
    expect(outcome.code).not.toBe(`${what}: answered 500 internal`);
    expect(outcome.code === "internal").toBe(false);
  }
}

/**
 * A landed `POST /messages` answers 201 Created: board()'s serving layer
 * answers 201 for the CREATED routes (`post`, `schedule`, `createTask`,
 * `createTasks`, `upload`, `uploadFinish`) and 200 for everything else
 * (probed: board-src/packages/board/src/server/serve.ts:81,1199). The
 * assertions below carry that as the literal 201.
 */

/** Expect a specific protocol status and code. */
function expectCode(
  outcome: Outcome,
  status: number,
  code: string,
  what: string,
): void {
  SWEEP_CHECKS += 1;
  expect(
    `${what} → ${outcome.status} ${outcome.code || "(ok)"} ${outcome.message.slice(0, 120)}`,
  ).toBe(
    `${what} → ${status} ${code} ${outcome.message.slice(0, 120)}`.replace(
      ` ${outcome.message.slice(0, 120)}`,
      ` ${outcome.message.slice(0, 120)}`,
    ),
  );
  expect(outcome.status).toBe(status);
  expect(outcome.code).toBe(code);
}

/** Write an executable fake `bd` script; answers per the given handler body. */
function fakeBd(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-fakebd-"));
  const path = join(dir, "bd");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * The id a bare `bd create --json` answered: the issue (or one-element
 * array of it) directly — the fixture runs without the JSON envelope.
 */
function createdId(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row !== null && typeof row === "object" && "id" in row
    ? String((row as Record<string, unknown>).id)
    : "";
}

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

describe("failure modes: corrupt and foreign tracker state", () => {
  let fixture: BdFixture;
  let app: Mount;

  beforeAll(async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
  }, 60_000);

  afterAll(() => {
    app.close();
    fixture?.close();
  });

  let healthyId = "";
  const CORRUPT = "bb-corrupt";
  const FOREIGN = "bb-foreign";
  const STATE_CORRUPT = "bb-state-corrupt";

  test("seeds a healthy message, then plants corrupt, foreign, and decoy-state issues", async () => {
    const posted = await call(app.app, "POST", "/messages", {
      body: {
        channel: "dev",
        text: "healthy root",
        labels: { topic: "sweep" },
      },
    });
    expect(posted.status).toBe(201);
    const message = (posted.body as { message?: { id?: string } })?.message;
    healthyId = message?.id ?? "";
    expect(healthyId).not.toBe("");

    // A plain-bd issue: no backend metadata at all — a foreign issue in our channel.
    const foreign = await fixture.run([
      "create",
      "--title=foreign issue",
      "--type=task",
      "--json",
    ]);
    expect(foreign.code).toBe(0);
    const foreignId = createdId(foreign.stdout);
    await fixture.run(["label", "add", foreignId, `bb.channel=dev`]);

    // A message-shaped issue whose metadata blob does not decode (version is
    // a string, the channel a number): the unparseable kind of corrupt.
    const corrupt = await fixture.run([
      "create",
      "--title=corrupt issue",
      "--type=task",
      "--json",
    ]);
    expect(corrupt.code).toBe(0);
    const corruptId = createdId(corrupt.stdout);
    await fixture.run(["label", "add", corruptId, "bb.channel=dev"]);
    const blob = JSON.stringify({
      "bb.v": "one",
      "bb.role": "message",
      "bb.channel": 42,
      "bb.thread": null,
      "bb.parent": null,
      "bb.after": null,
      "bb.client": null,
      "bb.from": null,
      "bb.origin": null,
      "bb.noSync": "yes",
      "bb.version": "x",
      "bb.revision": true,
      "bb.editedAt": 0,
      "bb.deleted": "no",
      "bb.reactions": [],
      "bb.external": [],
      "bb.epoch": "0",
      "bb.claim": {},
    });
    const updated = await fixture.run([
      "update",
      corruptId,
      "--metadata",
      blob,
      "--json",
    ]);
    expect(updated.code).toBe(0);

    // A decoy state issue whose blob claims the backend role but does not
    // decode: state reads must skip it and keep serving the healthy one.
    const decoy = await fixture.run([
      "create",
      "--title=corrupt backend state",
      "--type=task",
      "--json",
    ]);
    expect(decoy.code).toBe(0);
    const decoyId = createdId(decoy.stdout);
    await fixture.run([
      "update",
      decoyId,
      "--metadata",
      JSON.stringify({ "bb.role": 42, "bb.v": null }),
      "--json",
    ]);

    // The ids are only known to the tracker; keep them readable for asserts.
    (app as unknown as { ids?: Record<string, string> }).ids = {
      corrupt: corruptId,
      foreign: foreignId,
      stateCorrupt: decoyId,
    };
  }, 120_000);

  test("reads serve what they can: the healthy message answers, corrupt and foreign issues are not messages", async () => {
    const page = await call(app.app, "GET", "/messages?channel=dev");
    expectTyped(page, "channel read over corrupt channel");
    expect(page.status).toBe(200);
    const messages =
      (page.body as { messages?: { id: string }[] }).messages ?? [];
    expect(messages.map((one) => one.id)).toEqual([healthyId]);

    const ids = (app as unknown as { ids: Record<string, string> }).ids;
    for (const [name, id] of Object.entries(ids)) {
      if (name === "stateCorrupt") continue;
      const read = await call(app.app, "GET", `/messages/${id}`);
      expectTyped(read, `read of ${name} issue`);
      expect(read.status).toBe(404);
      expect(read.code).toBe("message_not_found");
    }

    const threads = await call(app.app, "GET", "/threads?channel=dev");
    expectTyped(threads, "threads over corrupt channel");
    expect(threads.status).toBe(200);
    expect((threads.body as { threads: unknown[] }).threads.length).toBe(1);
  }, 120_000);

  test("writes to corrupt and foreign issues answer typed errors, never internal", async () => {
    const ids = (app as unknown as { ids: Record<string, string> }).ids;
    for (const id of [ids.corrupt, ids.foreign]) {
      const edit = await call(app.app, "POST", `/messages/${id}/edit`, {
        body: { text: "nope" },
      });
      expectTyped(edit, `edit of corrupt issue`);
      expect(edit.status).toBe(404);

      const remove = await call(app.app, "POST", `/messages/${id}/delete`, {
        body: {},
      });
      expectTyped(remove, `delete of corrupt issue`);
      expect(remove.status).toBe(404);

      const react = await call(app.app, "POST", `/messages/${id}/reactions`, {
        body: { emoji: "eyes" },
      });
      expectTyped(react, `react on corrupt issue`);
      expect(react.status).toBe(404);

      const label = await call(app.app, "POST", `/messages/${id}/labels`, {
        body: { set: { topic: "x" } },
      });
      expectTyped(label, `label of corrupt issue`);
      expect(label.status).toBe(404);

      const reply = await call(app.app, "POST", "/messages", {
        body: { re: id, text: "nope" },
      });
      expectTyped(reply, `reply targeting corrupt issue`);
      expect(reply.status).toBe(404);

      const typing = await call(app.app, "POST", `/messages/${id}/typing`, {
        body: {},
      });
      expectTyped(typing, `typing on corrupt issue`);
      expect(typing.status).toBe(404);
    }
  }, 120_000);

  test("a fresh write after corruption succeeds, and the events feed still serves", async () => {
    const posted = await call(app.app, "POST", "/messages", {
      body: { channel: "fresh", text: "post-corruption write" },
    });
    expectTyped(posted, "post after corruption");
    expect(posted.status).toBe(201);

    const events = await call(app.app, "GET", "/events?wait=0");
    expectTyped(events, "events over a tracker with corrupt issues");
    expect(events.status).toBe(200);

    const page = await call(app.app, "GET", "/messages?channel=fresh");
    expectTyped(page, "read of the post-corruption channel");
    expect(page.status).toBe(200);
    expect((page.body as { messages: unknown[] }).messages.length).toBe(1);
  }, 120_000);
});

describe("failure modes: environment failures name the fix", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bb-env-"));
  const emptyDir = join(scratch, "empty-tracker");
  const noBeadsDir = join(scratch, "no-beads");
  const missingDir = join(scratch, "not-a-tracker");
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(noBeadsDir, { recursive: true });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("bd missing from PATH: routes answer typed unavailable, not internal", async () => {
    const app = mount(missingDir, {
      bdPath: join(scratch, "no-such-bd-binary"),
    });
    try {
      const discovery = await call(app.app, "GET", "/");
      expectTyped(discovery, "discovery with bd missing");
      expect(discovery.status).toBe(503);
      expect(discovery.code).toBe("unavailable");

      const channels = await call(app.app, "GET", "/channels");
      expectTyped(channels, "channel list with bd missing");
      expect(channels.status).toBe(503);
      expect(channels.code).toBe("unavailable");
      expect(channels.message).toMatch(/bd/i);

      const post = await call(app.app, "POST", "/messages", {
        body: { channel: "dev", text: "hi" },
      });
      expectTyped(post, "post with bd missing");
      expect(post.status).toBe(503);
      expect(post.code).toBe("unavailable");

      const events = await call(app.app, "GET", "/events?wait=0");
      expectTyped(events, "events with bd missing");
      expect(events.status).toBe(503);
      expect(events.code).toBe("unavailable");

      // Identity needs no storage: `me` still answers.
      const me = await call(app.app, "GET", "/me");
      expectTyped(me, "me with bd missing");
      expect(me.status).toBe(200);
    } finally {
      app.close();
    }
  }, 120_000);

  test("garbage bd --version output: typed bind error naming the version fix", async () => {
    const bin = fakeBd(`
      if [ "$1" = "--version" ]; then echo "bd version bananas-not-a-version"; exit 0; fi
      echo "unexpected bd invocation" >&2
      exit 1
    `);
    const app = mount(emptyDir, { bdPath: bin });
    try {
      const channels = await call(app.app, "GET", "/channels");
      expectTyped(channels, "channels with garbage bd version");
      expect(channels.status).toBe(503);
      expect(channels.code).toBe("unavailable");
      expect(channels.message).toMatch(/bd/);
    } finally {
      app.close();
    }
  }, 120_000);

  test("an unsupported bd version (below the documented range): typed bind error", async () => {
    const bin = fakeBd(`
      if [ "$1" = "--version" ]; then echo "bd version 1.2.9 (fake)"; exit 0; fi
      echo "unexpected bd invocation" >&2
      exit 1
    `);
    const app = mount(emptyDir, { bdPath: bin });
    try {
      const channels = await call(app.app, "GET", "/channels");
      expectTyped(channels, "channels with an old bd");
      expect(channels.status).toBe(503);
      expect(channels.code).toBe("unavailable");
      expect(channels.message).toMatch(/1\.3\.4|range|version/i);
    } finally {
      app.close();
    }
  }, 120_000);

  test("a tracker directory without .beads: typed error naming bd init", async () => {
    const app = mount(noBeadsDir);
    try {
      const channels = await call(app.app, "GET", "/channels");
      expectTyped(channels, "channels on an uninitialized tracker");
      expect(channels.status).toBe(503);
      expect(channels.code).toBe("unavailable");
      expect(channels.message).toMatch(/init|bd/i);
    } finally {
      app.close();
    }
  }, 120_000);
});

describe("failure modes: hung subprocess is killed and surfaces typed", () => {
  let fixture: BdFixture;
  const scratch = mkdtempSync(join(tmpdir(), "bb-hang-"));
  const pidFile = join(scratch, "hung.pid");
  let bin = "";

  beforeAll(async () => {
    fixture = await createBdFixture();
    // A fake bd: bind probes succeed cheaply, a real message create hangs
    // forever past the transport's timeout. The hung pid lands in a file so
    // the test can prove the process group was killed.
    bin = fakeBd(`
      if [ "$1" = "--version" ]; then echo "bd version 1.3.4 (fake)"; exit 0; fi
      for arg in "$@"; do
        case "$arg" in
          --description=*) echo $$ > "${pidFile}"; exec sleep 120 ;;
          board-beads\\ probe*) echo '{"id":"fake-probe"}'; exit 0 ;;
        esac
      done
      case "$1" in
        list) echo "[]"; exit 0 ;;
        events) echo ""; exit 0 ;;
        config) echo "false"; exit 0 ;;
        create) echo '{"id":"fake-create"}'; exit 0 ;;
        update) echo '{"id":"fake-update"}'; exit 0 ;;
        label) exit 0 ;;
        show) echo '{"id":"fake"}'; exit 0 ;;
      esac
      echo "[]"
      exit 0
    `);
  }, 60_000);

  afterAll(() => {
    fixture?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a bd invocation past its timeout answers typed unavailable and the hung process group is killed", async () => {
    const app = mount(fixture.dir, { bdPath: bin, timeoutMs: 600 });
    try {
      const started = Date.now();
      const posted = await call(app.app, "POST", "/messages", {
        body: { channel: "dev", text: "this create hangs" },
      });
      const elapsed = Date.now() - started;
      expectTyped(posted, "post through a hung bd");
      expect(posted.status).toBe(503);
      expect(posted.code).toBe("unavailable");
      expect(posted.message).toMatch(/timed out/i);
      // The transport's own bound answered, not a 30s default crawl.
      expect(elapsed).toBeLessThan(15_000);

      // Tree-kill: the hung pid (the script exec'd into sleep) is gone.
      const pid = Number(
        await Bun.file(pidFile)
          .text()
          .catch(() => "0"),
      );
      expect(pid).toBeGreaterThan(0);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      app.close();
    }
  }, 120_000);

  test("the tracker is unchanged by the killed write, and a fresh backend serves it", async () => {
    // Nothing landed: the create was killed before bd ever committed.
    const listed = await fixture.run(["list", "--json"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toBe("[]\n");

    // A fresh mount with the real bd serves the tracker normally.
    const app = mount(fixture.dir);
    try {
      const posted = await call(app.app, "POST", "/messages", {
        body: { channel: "dev", text: "after the restart" },
      });
      expectTyped(posted, "post on the restarted backend");
      expect(posted.status).toBe(201);
    } finally {
      app.close();
    }
  }, 120_000);
});

describe("failure modes: limits and hostile input", () => {
  let fixture: BdFixture;
  let app: Mount;
  let hostilePrincipals: Mount;

  beforeAll(async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
    hostilePrincipals = mount(fixture.dir, { principalFromHeader: true });
  }, 60_000);

  afterAll(() => {
    hostilePrincipals.close();
    app.close();
    fixture?.close();
  });

  test("the 10k text bound: at the bound round-trips, past it is a typed 400", async () => {
    const at = "a".repeat(10_000);
    const posted = await call(app.app, "POST", "/messages", {
      body: { channel: "dev", text: at },
    });
    expectTyped(posted, "post at the 10k bound");
    expect(posted.status).toBe(201);
    const id = (posted.body as { message?: { id?: string } }).message?.id ?? "";
    const read = await call(app.app, "GET", `/messages/${id}`);
    expect((read.body as { message?: { text?: string } }).message?.text).toBe(
      at,
    );

    const past = await call(app.app, "POST", "/messages", {
      body: { channel: "dev", text: "b".repeat(10_001) },
    });
    expectTyped(past, "post past the 10k bound");
    expect(past.status).toBe(400);

    const edited = await call(app.app, "POST", `/messages/${id}/edit`, {
      body: { text: "c".repeat(10_001) },
    });
    expectTyped(edited, "edit past the 10k bound");
    expect(edited.status).toBe(400);
  }, 120_000);

  test("unicode, emoji, and CJK round-trip byte-for-byte", async () => {
    const text =
      "日本語のメッセージ 🎉🚀 emoji led — combined 中文 + العربية 🌍 end";
    const posted = await call(app.app, "POST", "/messages", {
      body: { channel: "unicode", text },
    });
    expectTyped(posted, "unicode post");
    expect(posted.status).toBe(201);
    const id = (posted.body as { message?: { id?: string } }).message?.id ?? "";
    const read = await call(app.app, "GET", `/messages/${id}`);
    expectTyped(read, "unicode read back");
    expect((read.body as { message?: { text?: string } }).message?.text).toBe(
      text,
    );

    const thread = await call(app.app, "GET", "/threads?channel=unicode");
    expectTyped(thread, "unicode thread read");
    expect(thread.status).toBe(200);

    // Board's reaction schema takes ASCII emoji names (`eyes`, `:+1:`) —
    // the character itself is refused at the protocol boundary — so the
    // reaction rides a name, and unicode coverage stays on the text, which
    // round-trips byte-for-byte above.
    const reacted = await call(app.app, "POST", `/messages/${id}/reactions`, {
      body: { emoji: "eyes" },
    });
    expectTyped(reacted, "emoji reaction");
    expect(reacted.status).toBe(200);
    const after = await call(app.app, "GET", `/messages/${id}`);
    const reactions =
      (after.body as { message?: { reactions?: Record<string, string[]> } })
        .message?.reactions ?? {};
    expect(Object.keys(reactions)).toContain("eyes");
  }, 120_000);

  test("hostile channels and labels are refused with typed 400s", async () => {
    // Channel rules (threads.ts CHANNEL_PATTERN / ensureChannel): lowercase
    // segments joined by /, at most 2048 chars. A multi-segment path is a
    // legitimate subtree channel (the events feed matches `channel/` as a
    // subtree), so it is not in this list; everything here breaks the shape
    // or the bound.
    for (const channel of [
      "DEV",
      "a b",
      "🎉",
      "a,b",
      `${"x".repeat(5000)}`,
      "-lead",
      "a//b",
    ]) {
      const posted = await call(app.app, "POST", "/messages", {
        body: { channel, text: "hi" },
      });
      expectTyped(
        posted,
        `post to hostile channel ${JSON.stringify(channel.slice(0, 20))}`,
      );
      expect(posted.status).toBe(400);
    }
    for (const labels of [
      { "board.task": "x" },
      { "bb.channel": "x" },
      { "a,b": "x" },
      { ok: "a,b" },
      { [`${"y".repeat(5000)}`]: "v" },
      { "": "v" },
      { "has=equals": "v" },
    ]) {
      const posted = await call(app.app, "POST", "/messages", {
        body: { channel: "dev", text: "hi", labels },
      });
      expectTyped(
        posted,
        `post with hostile labels ${JSON.stringify(Object.keys(labels))}`,
      );
      expect(posted.status).toBe(400);
    }
    const channel = await call(app.app, "POST", "/channels", {
      body: { path: "NOT A CHANNEL" },
    });
    expectTyped(channel, "hostile createChannel");
    expect(channel.status).toBe(400);
  }, 120_000);

  test("hostile cursors answer 400 invalid_cursor; hostile ids answer 404", async () => {
    const badCursor = await call(
      app.app,
      "GET",
      "/messages?channel=dev&after=not-a-cursor!!",
    );
    expectTyped(badCursor, "hostile messages cursor");
    expect(badCursor.status).toBe(400);
    expect(badCursor.code).toBe("invalid_cursor");

    const badThreadCursor = await call(
      app.app,
      "GET",
      "/threads?channel=dev&before=zzz-garbage",
    );
    expectTyped(badThreadCursor, "hostile threads cursor");
    expect(badThreadCursor.status).toBe(400);

    const badEvents = await call(app.app, "GET", "/events?after=%%%garbage");
    expectTyped(badEvents, "hostile events cursor");
    expect(badEvents.status).toBe(400);
    expect(badEvents.code).toBe("invalid_cursor");

    const lastEvents = await call(app.app, "GET", "/events?last=5");
    expectTyped(lastEvents, "events from its end");
    expect(lastEvents.status).toBe(501);

    for (const id of [
      "no-such-id",
      "../escape",
      "%2e%2e",
      `${"z".repeat(300)}`,
    ]) {
      const read = await call(
        app.app,
        "GET",
        `/messages/${encodeURIComponent(id)}`,
      );
      expectTyped(read, `read of hostile id ${id.slice(0, 20)}`);
      expect(read.status).toBe(404);
    }
  }, 120_000);

  test("hostile actor principals sanitize to valid actor slugs, bijectively", async () => {
    // The principal rides a request header, and header values are ByteStrings
    // (latin1): an astral principal (🎉, Cyrillic) cannot name itself on
    // board()'s fetch surface at all — the fetch layer rejects the header
    // before the backend sees it. So the hostile set here is the
    // header-expressible kind: accents and symbols outside ASCII, traversal
    // shapes, and the id's own length bound. Slug sanitization is
    // principal-shape-agnostic (`deriveActorSlug` digests the exact
    // principal), so bijectivity proven here holds for the wider shapes
    // sync imports carry.
    const principals = [
      "renée-ünïcode",
      "©opy-that",
      "1-leading-digit",
      "%2e%2e-traversal",
      "u".repeat(200),
    ];
    const slugs = new Set<string>();
    for (const principal of principals) {
      const made = await call(hostilePrincipals.app, "POST", "/messages", {
        body: { channel: "actors", text: `from ${principal}` },
        headers: { "x-sweep-principal": principal },
      });
      expectTyped(
        made,
        `post from hostile principal ${JSON.stringify(principal.slice(0, 24))}`,
      );
      expect(made.status).toBe(201);
      const slug =
        (made.body as { message?: { by?: { actor?: string } } }).message?.by
          ?.actor ?? "";
      // Slugs stay inside a valid BEADS_ACTOR shape, and distinct principals
      // never share one (the digest keeps the map bijective).
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(64);
      expect(slugs.has(slug)).toBeFalse();
      slugs.add(slug);
    }
    // They resolve back on a read.
    const page = await call(app.app, "GET", "/messages?channel=actors");
    expectTyped(page, "read of hostile-principal messages");
    expect(page.status).toBe(200);
    const actors = await call(app.app, "GET", "/actors");
    expectTyped(actors, "actors list with hostile principals");
    expect(actors.status).toBe(200);
  }, 120_000);

  test("a hostile x-board-profile header never reaches the backend", async () => {
    const made = await call(app.app, "GET", "/me", {
      headers: { "x-board-profile": "!! not a profile !!" },
    });
    expectTyped(made, "hostile profile header");
    expect(made.status).toBe(400);
  }, 120_000);
});

describe("failure modes: two backend instances on one tracker (the single-writer contract)", () => {
  let fixture: BdFixture;
  let a: Mount;
  let b: Mount;

  beforeAll(async () => {
    fixture = await createBdFixture();
    a = mount(fixture.dir);
    b = mount(fixture.dir);
  }, 60_000);

  afterAll(() => {
    b.close();
    a.close();
    fixture?.close();
  });

  /**
   * The single-writer contract (README): while a board runs, the backend is
   * the only writer of the tracker. Running two writing instances violates
   * the contract — this suite documents what happens then: every operation
   * still answers typed (bd serializes each op transactionally), the tracker
   * stays servable, and nothing corrupts silently. It does not sanction
   * dual-writer operation; ordering and fencing are only guaranteed under
   * one writer.
   */
  test("writes from both instances land typed, every read keeps serving, and one tracker identity maps one actor", async () => {
    const first = await call(a.app, "POST", "/messages", {
      body: { channel: "shared", text: "from A" },
    });
    expectTyped(first, "post from instance A");
    expect(first.status).toBe(201);

    // The other instance sees it through the tracker.
    const seen = await call(b.app, "GET", "/messages?channel=shared");
    expectTyped(seen, "read from instance B");
    expect(seen.status).toBe(200);
    expect(
      (seen.body as { messages: { text: string }[] }).messages.length,
    ).toBe(1);

    // Concurrent posts from both instances: each answer is typed.
    const raced = await Promise.allSettled([
      call(a.app, "POST", "/messages", {
        body: { channel: "shared", text: "A again" },
      }),
      call(b.app, "POST", "/messages", {
        body: { channel: "shared", text: "B again" },
      }),
    ]);
    for (const outcome of raced) {
      expect(outcome.status).toBe("fulfilled");
      if (outcome.status === "fulfilled") {
        expectTyped(outcome.value, "concurrent post");
        expect([201, 409, 503]).toContain(outcome.value.status);
      }
    }

    // The tracker serves every landed message from both instances.
    const fromA = await call(a.app, "GET", "/messages?channel=shared");
    const fromB = await call(b.app, "GET", "/messages?channel=shared");
    expectTyped(fromA, "post-race read from A");
    expectTyped(fromB, "post-race read from B");
    expect(fromA.status).toBe(200);
    expect(fromB.status).toBe(200);
    const textsOf = (page: unknown): string[] =>
      (page as { messages?: { text: string }[] }).messages?.map(
        (m) => m.text,
      ) ?? [];
    expect(textsOf(fromA.body).sort()).toEqual(textsOf(fromB.body).sort());
    expect(textsOf(fromA.body).length).toBe(3);

    // One persisted actor map: the same principal maps to the same slug on
    // both instances, so authorship stays stable across the contract breach.
    const actorA =
      textsOf(fromA.body).length > 0
        ? (
            fromA.body as {
              messages?: { text: string; by?: { actor?: string } }[];
            }
          ).messages?.[0]?.by?.actor
        : undefined;
    const actorB = (
      fromB.body as { messages?: { text: string; by?: { actor?: string } }[] }
    ).messages?.find((m) => m.text === "from A")?.by?.actor;
    expect(actorA).toBe(actorB);
    expect(actorA).not.toBe("");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// THE SWEEP BAR: every implemented route, hostile inputs, no 500 internal.
// ---------------------------------------------------------------------------

describe("the sweep bar: every implemented route answers typed under hostile input", () => {
  let fixture: BdFixture;
  let app: Mount;
  let seededId = "";

  beforeAll(async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
    const posted = await call(app.app, "POST", "/messages", {
      body: {
        channel: "dev",
        text: "seed message",
        labels: { topic: "sweep" },
      },
    });
    if (posted.status !== 201) {
      throw new Error(`sweep seed failed: ${posted.status} ${posted.message}`);
    }
    seededId = (posted.body as { message?: { id?: string } }).message?.id ?? "";
    await call(app.app, "POST", "/watchers", {
      body: { watch: { sweep: { tail: "dev --label topic=sweep" } } },
    });
  }, 120_000);

  afterAll(() => {
    app.close();
    fixture?.close();
    // The evidence line the run answers with.
    console.log(
      `failure-modes sweep: ${SWEEP_CHECKS} hostile checks, 0 internal-500 answers`,
    );
  });

  /** Hostile bodies every POST route takes, one at a time. */
  const HOSTILE_BODIES: { name: string; body: unknown }[] = [
    { name: "empty object", body: {} },
    { name: "null", body: null },
    { name: "number", body: 42 },
    { name: "string", body: "a string" },
    { name: "array", body: [1, 2, 3] },
    { name: "wrong field types", body: { channel: 42, text: 7, id: {} } },
    {
      name: "huge strings",
      body: { channel: "x".repeat(6000), text: "y".repeat(6000) },
    },
    {
      name: "unicode keys",
      body: { "🎉": { 日: ["本"] }, channel: "dev", text: "x" },
    },
    {
      name: "deep nesting",
      body: { channel: "dev", text: "x", labels: { a: { b: { c: 1 } } } },
    },
  ];

  /** Every implemented route with its hostile probes. */
  const PROBES: {
    name: string;
    method: string;
    path: string;
    init?: { body?: unknown; raw?: string };
  }[] = [
    // core reads
    { name: "discovery", method: "GET", path: "/?garbage=1&more=%FF" },
    { name: "me", method: "GET", path: "/me?limit=abc" },
    { name: "channels", method: "GET", path: "/channels?limit=abc" },
    {
      name: "channels hostile prefix",
      method: "GET",
      path: "/channels?prefix=%F0%9F%8E%89&after=zzz",
    },
    {
      name: "channelMessages hostile channel",
      method: "GET",
      path: "/messages?channel=UPPER",
    },
    {
      name: "channelMessages hostile cursor",
      method: "GET",
      path: "/messages?channel=dev&after=garbage!!",
    },
    {
      name: "channelMessages hostile limit",
      method: "GET",
      path: "/messages?channel=dev&limit=zero",
    },
    {
      name: "threads hostile filters",
      method: "GET",
      path: "/threads?channel=dev&text=zzz",
    },
    {
      name: "threads hostile re",
      method: "GET",
      path: "/threads?re=not-an-id",
    },
    {
      name: "threads both cursors",
      method: "GET",
      path: "/threads?channel=dev&after=x&before=y",
    },
    {
      name: "message hostile id",
      method: "GET",
      path: `/messages/${encodeURIComponent("../escape")}`,
    },
    {
      name: "message hostile after",
      method: "GET",
      path: `/messages/${seededId}?after=not-in-thread`,
    },
    { name: "posted hostile id", method: "GET", path: "/posts/garbage-id" },
    // core writes
    {
      name: "createChannel hostile",
      method: "POST",
      path: "/channels",
      init: { body: { path: 42 } },
    },
    {
      name: "post no channel",
      method: "POST",
      path: "/messages",
      init: { body: { text: "hi" } },
    },
    {
      name: "post attachments refused",
      method: "POST",
      path: "/messages",
      init: { body: { channel: "dev", text: "hi", attachments: [{}] } },
    },
    {
      name: "post sync refused",
      method: "POST",
      path: "/messages",
      init: { body: { channel: "dev", text: "hi", sync: ["x"] } },
    },
    {
      name: "post reserved label",
      method: "POST",
      path: "/messages",
      init: {
        body: { channel: "dev", text: "hi", labels: { "board.x": "1" } },
      },
    },
    {
      name: "post both channel and re",
      method: "POST",
      path: "/messages",
      init: { body: { channel: "dev", re: seededId, text: "hi" } },
    },
    {
      name: "post reply to unknown",
      method: "POST",
      path: "/messages",
      init: { body: { re: "no-such-id", text: "hi" } },
    },
    {
      name: "edit unknown id",
      method: "POST",
      path: "/messages/no-such-id/edit",
      init: { body: { text: "x" } },
    },
    {
      name: "edit stale revision",
      method: "POST",
      path: `/messages/${seededId}/edit`,
      init: { body: { text: "x", revision: 999 } },
    },
    {
      name: "delete unknown id",
      method: "POST",
      path: "/messages/no-such-id/delete",
      init: { body: {} },
    },
    {
      name: "react unknown id",
      method: "POST",
      path: "/messages/no-such-id/reactions",
      init: { body: { emoji: "eyes" } },
    },
    {
      name: "label unknown id",
      method: "POST",
      path: "/messages/no-such-id/labels",
      init: { body: { set: { a: "b" } } },
    },
    {
      name: "label reserved",
      method: "POST",
      path: `/messages/${seededId}/labels`,
      init: { body: { set: { "bb.x": "1" } } },
    },
    {
      name: "label too many conditions",
      method: "POST",
      path: `/messages/${seededId}/labels`,
      init: {
        body: {
          if: Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [`c${i}`, null]),
          ),
        },
      },
    },
    // events
    {
      name: "events hostile cursor",
      method: "GET",
      path: "/events?after=%%garbage&wait=0",
    },
    { name: "events from end", method: "GET", path: "/events?last=1" },
    { name: "events negative wait", method: "GET", path: "/events?wait=-5" },
    {
      name: "events hostile channel",
      method: "GET",
      path: "/events?channel=UPPER&wait=0",
    },
    // watchers
    { name: "watchers list", method: "GET", path: "/watchers?garbage=1" },
    {
      name: "register no watch",
      method: "POST",
      path: "/watchers",
      init: { body: {} },
    },
    {
      name: "register null watch",
      method: "POST",
      path: "/watchers",
      init: { body: { watch: null } },
    },
    {
      name: "register hostile tail",
      method: "POST",
      path: "/watchers",
      init: { body: { watch: { a: { tail: "--not-a-filter zz" } } } },
    },
    {
      name: "register non-string tail",
      method: "POST",
      path: "/watchers",
      init: { body: { watch: { a: { tail: 42 } } } },
    },
    {
      name: "register too many watchers",
      method: "POST",
      path: "/watchers",
      init: {
        body: {
          watch: Object.fromEntries(
            Array.from({ length: 33 }, (_, i) => [`w${i}`, { tail: "" }]),
          ),
        },
      },
    },
    {
      name: "register wake by path",
      method: "POST",
      path: "/watchers",
      init: { body: { path: "/repo", watch: {} } },
    },
    {
      name: "register wake by url",
      method: "POST",
      path: "/watchers",
      init: { body: { url: "https://x", watch: {} } },
    },
    {
      name: "register huge tail",
      method: "POST",
      path: "/watchers",
      init: { body: { watch: { a: { tail: "z".repeat(1001) } } } },
    },
    {
      name: "register hostile sync entry",
      method: "POST",
      path: "/watchers",
      init: { body: { watch: {}, sync: [{ key: "" }] } },
    },
    {
      name: "matches hostile limit",
      method: "GET",
      path: "/watchers/matches?wait=0&limit=abc",
    },
    {
      name: "matches negative wait",
      method: "GET",
      path: "/watchers/matches?wait=-1",
    },
    {
      name: "ack unknown match",
      method: "POST",
      path: "/watchers/matches/no-such/ack",
      init: { body: { lease: "x" } },
    },
    // sync records
    {
      name: "syncImport empty",
      method: "POST",
      path: "/sync/imports",
      init: { body: {} },
    },
    {
      name: "syncImport author garbage",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: { op: "post", author: 42, origin: { thread: "x:1" }, from: "x" },
      },
    },
    {
      name: "syncImport post no origin",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: {
          op: "post",
          author: {
            id: "x:1",
            handle: "u",
            name: "U",
            avatar: null,
            isBot: false,
          },
          channel: "dev",
          text: "hi",
        },
      },
    },
    {
      name: "syncImport reserved author id",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: {
          op: "post",
          author: {
            id: "vercel:1",
            handle: "u",
            name: "U",
            avatar: null,
            isBot: false,
          },
          channel: "dev",
          text: "hi",
          origin: { thread: "x:1" },
          from: "x",
        },
      },
    },
    {
      name: "syncImport hostile labels",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: {
          op: "post",
          author: {
            id: "x:1",
            handle: "u",
            name: "U",
            avatar: null,
            isBot: false,
          },
          channel: "dev",
          text: "hi",
          labels: { "board.x": "1" },
          origin: { thread: "x:1" },
          from: "x",
        },
      },
    },
    {
      name: "syncImport edit unknown origin",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: {
          op: "edit",
          text: "x",
          origin: { thread: "nope:1" },
          from: "nope",
        },
      },
    },
    {
      name: "syncImport delete unknown message",
      method: "POST",
      path: "/sync/imports",
      init: { body: { op: "delete", message: "no-such-id" } },
    },
    {
      name: "syncImport react garbage author",
      method: "POST",
      path: "/sync/imports",
      init: {
        body: {
          op: "react",
          message: "no-such-id",
          emoji: "x",
          author: { id: "" },
        },
      },
    },
    {
      name: "syncReceipt unknown message",
      method: "POST",
      path: "/sync/receipts",
      init: {
        body: {
          message: "no-such-id",
          kind: "thread",
          target: "t",
          targetKind: "thread",
          cause: "request",
        },
      },
    },
    {
      name: "syncThread unknown",
      method: "GET",
      path: "/sync/threads/no-such-id",
    },
    {
      name: "syncFind garbage",
      method: "GET",
      path: "/sync/find?post=%F0%9F%8E%89&thread=x&message=y",
    },
    {
      name: "syncCopies garbage",
      method: "GET",
      path: "/sync/copies?message=no-such-id",
    },
    {
      name: "inboxPush too many",
      method: "POST",
      path: "/inbox/k",
      init: {
        body: {
          events: Array.from({ length: 51 }, (_, i) => ({
            id: `e${i}`,
            event: { kind: "message", channel: "k:c", thread: "k:t" },
            raw: {},
          })),
        },
      },
    },
    {
      name: "inboxPush id too long",
      method: "POST",
      path: "/inbox/k",
      init: {
        body: {
          events: [
            {
              id: "e".repeat(301),
              event: { kind: "message", channel: "k:c", thread: "k:t" },
              raw: {},
            },
          ],
        },
      },
    },
    {
      name: "inboxPush foreign location",
      method: "POST",
      path: "/inbox/k",
      init: {
        body: {
          events: [
            {
              id: "e1",
              event: { kind: "message", channel: "other:c", thread: "other:t" },
              raw: {},
            },
          ],
        },
      },
    },
    {
      name: "inboxNext hostile limit",
      method: "GET",
      path: "/inbox/k/next?limit=abc",
    },
    {
      name: "inboxAck unknown",
      method: "POST",
      path: "/inbox/k/no-such/ack",
      init: { body: { lease: "x" } },
    },
    { name: "inbox read", method: "GET", path: "/inbox/k?limit=abc" },
    {
      name: "typing unknown id",
      method: "POST",
      path: "/messages/no-such-id/typing",
      init: { body: {} },
    },
    {
      name: "readSource unknown key",
      method: "GET",
      path: "/sources/nope/read",
    },
    {
      name: "joinSource unknown key",
      method: "POST",
      path: "/sources/nope/join",
      init: { body: {} },
    },
    {
      name: "synced unknown id",
      method: "GET",
      path: "/messages/no-such-id/sync",
    },
    {
      name: "linked garbage url",
      method: "GET",
      path: "/links?url=%F0%9F%8E%89",
    },
  ];

  test("every route answers typed under hostile bodies, hostile queries, and garbage JSON", async () => {
    const failures: string[] = [];

    // Garbage JSON bodies first: the serving layer answers 400 before the backend.
    for (const probe of PROBES) {
      if (probe.method !== "POST") continue;
      const outcome = await call(app.app, probe.method, probe.path, {
        raw: "{this is not json",
      });
      SWEEP_CHECKS += 1;
      if (outcome.status === 500 && outcome.code === "internal") {
        failures.push(`${probe.name} (garbage json): 500 internal`);
      }
    }

    // Each hostile body, one at a time, on every POST route.
    for (const probe of PROBES) {
      if (probe.method !== "POST") continue;
      for (const hostile of HOSTILE_BODIES) {
        const outcome = await call(app.app, probe.method, probe.path, {
          body: hostile.body,
        });
        SWEEP_CHECKS += 1;
        if (outcome.status === 500 && outcome.code === "internal") {
          failures.push(
            `${probe.name} (${hostile.name}): 500 internal — ${outcome.message.slice(0, 120)}`,
          );
        }
      }
    }

    // Every GET route with its hostile query, and every POST with its body.
    for (const probe of PROBES) {
      const outcome = await call(app.app, probe.method, probe.path, probe.init);
      SWEEP_CHECKS += 1;
      if (outcome.status === 500 && outcome.code === "internal") {
        failures.push(
          `${probe.name}: 500 internal — ${outcome.message.slice(0, 120)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  }, 600_000);

  test("typed answers hold their documented codes on the hot paths", async () => {
    expectCode(
      await call(app.app, "GET", "/messages?channel=dev&after=garbage!!"),
      400,
      "invalid_cursor",
      "hostile cursor",
    );
    expectCode(
      await call(app.app, "GET", "/events?after=%%garbage&wait=0"),
      400,
      "invalid_cursor",
      "hostile events cursor",
    );
    expectCode(
      await call(app.app, "POST", "/messages/no-such-id/edit", {
        body: { text: "x" },
      }),
      404,
      "message_not_found",
      "edit of unknown id",
    );
    expectCode(
      await call(app.app, "GET", "/posts/garbage-id"),
      404,
      "post_not_found",
      "posted of unknown id",
    );
    expectCode(
      await call(app.app, "POST", "/watchers", {
        body: { path: "/repo", watch: {} },
      }),
      501,
      "no_wake_by_path",
      "wake by path",
    );
    expectCode(
      await call(app.app, "GET", "/links?url=https://x/1"),
      404,
      "message_not_found",
      "linked with no sync here",
    );
    const inboxAck = await call(app.app, "POST", "/inbox/k/no-such/ack", {
      body: { lease: "x" },
    });
    expectTyped(inboxAck, "ack of unknown inbox event");
    expect([404, 409]).toContain(inboxAck.status);
  }, 120_000);
});
