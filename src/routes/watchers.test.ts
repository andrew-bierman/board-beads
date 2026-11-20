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
 * The watchers routes, against the real entry path: a fixture tracker, a
 * board() mount over the same registry the backend assembles (threads +
 * events + watchers + sync), driven through the handle the way `vb` drives
 * a board. No mocks anywhere.
 *
 * A mount is one backend process: its own store, its own journal consumer,
 * its own route tables. Mounting twice over one fixture dir is a restart —
 * persisted state (registrations, matches, leases) lives in bd issues, so
 * the second mount reads it back.
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

describe("watchers routes (real bd, mounted through board())", () => {
  let fixture: BdFixture;
  let app: Mount;
  let team: Board;

  afterAll(() => {
    app?.stop();
    fixture?.close();
  });

  test("boots the fixture and mounts the watcher routes", async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
    team = app.board;
    const me = await team.me();
    expect(me.principal).toBe("board:client");
  }, 60_000);

  test("register stores a compiled registration and watchers() finds it", async () => {
    const view = await team.register({
      watch: { conformance: { tail: "dev --label watch=yes" } },
    });
    expect(view.owner).toBe("board:client");
    expect(view.url).toBeNull();
    expect(view.sync).toEqual([]);
    expect(Object.keys(view.watch)).toEqual(["conformance"]);
    expect(view.hash).not.toBe("");
    const listed = await team.watchers();
    const own = listed.find((one) => one.owner === "board:client");
    expect(own?.watch.conformance?.tail).toBe("dev --label watch=yes");
  }, 60_000);

  test("register replaces the principal's registration in place", async () => {
    await team.register({
      watch: { second: { tail: "dev2" } },
      sync: [{ key: "k", platform: "p" }],
    });
    const listed = await team.watchers();
    const own = listed.filter((one) => one.owner === "board:client");
    expect(own).toHaveLength(1);
    expect(Object.keys(own[0]?.watch ?? {})).toEqual(["second"]);
    expect(own[0]?.sync).toEqual([{ key: "k", platform: "p" }]);
    // back to a plain watch tail for the rest of the file
    await team.register({
      watch: { conformance: { tail: "dev --label watch=yes" } },
    });
  }, 60_000);

  test("a matching post is handed out leased, and ack clears it; double ack is 404 no_match", async () => {
    const posted = await team.post("dev", {
      text: "watcher bait",
      labels: { watch: "yes" },
    });
    let match: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const deadline = Date.now() + 25_000;
    while (!match && Date.now() < deadline) {
      match = (await team.matches({ wait: 2 })).find(
        (one) => one.event.message?.id === posted.id,
      );
    }
    expect(match).toBeTruthy();
    expect(match?.watcher).toBe("conformance");
    expect(match?.thread).toBe(posted.thread);
    expect(match?.event.type).toBe("message.posted");
    expect(match?.lease).not.toBe("");
    await team.ack(match?.id ?? "", { lease: match?.lease ?? "" });
    const second = await errorOf(
      team.ack(match?.id ?? "", { lease: match?.lease ?? "" }),
    );
    expect(second.status).toBe(404);
    expect(second.code).toBe("no_match");
  }, 90_000);

  test("a non-matching post produces no match", async () => {
    await team.post("dev", {
      text: "nothing watching this",
      labels: { watch: "no" },
    });
    const matches = await team.matches({ wait: 1 });
    expect(matches).toEqual([]);
  }, 30_000);

  test("a hostile tail is refused with the watcher named", async () => {
    const error = await errorOf(
      team.register({ watch: { bad: { tail: "dev --bogus x" } } }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain("bad");
    // restore the registration the refusal replaced nothing of
    await team.register({
      watch: { conformance: { tail: "dev --label watch=yes" } },
    });
  }, 60_000);

  test("a registration over the watcher cap is a protocol error", async () => {
    const watch: Record<string, { tail: string }> = {};
    for (let i = 0; i < 33; i++) watch[`w${i}`] = { tail: "dev" };
    const error = await errorOf(team.register({ watch }));
    expect(error.status).toBe(400);
    expect(error.code).toBe("too_many_watchers");
  }, 60_000);

  test("wake by path answers 501 no_wake_by_path (discovery omits wake_by_path), a url 501 no_wake_by_url", async () => {
    const response = await team.fetch(
      new Request("http://in-process.board/", { method: "GET" }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect("wake_by_path" in body).toBeFalse();
    const pathError = await errorOf(
      team.register({ path: "/conformance", watch: {} }),
    );
    expect(pathError.status).toBe(501);
    expect(pathError.code).toBe("no_wake_by_path");
    const urlError = await errorOf(
      team.register({ url: "https://example.com", watch: {} }),
    );
    expect(urlError.status).toBe(501);
    expect(urlError.code).toBe("no_wake_by_url");
  }, 60_000);

  test("matches without a registration answers 404 no_registration", async () => {
    const nobody = team.as("nobody");
    const error = await errorOf(nobody.matches());
    expect(error.status).toBe(404);
    expect(error.code).toBe("no_registration");
  }, 30_000);

  test("a caller narrowed with x-board-can is refused register, matches, and ack", async () => {
    const narrowed = team.as("nobody", { can: "dev/=all" });
    for (const [what, attempt] of [
      ["registering", narrowed.register({ watch: {} })],
      ["pulling", narrowed.matches()],
      ["acking", narrowed.ack("some-match", { lease: "some-lease" })],
    ] as const) {
      const error = await errorOf(attempt);
      expect(error.status).toBe(403);
      expect(error.code).toBe("forbidden");
      expect(what).toBeTruthy();
    }
  }, 30_000);

  test("a restart mid-lease: registration and lease survive, the match is not handed twice, ack works", async () => {
    const posted = await team.post("dev", {
      text: "lease must survive",
      labels: { watch: "yes" },
    });
    let match: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const deadline = Date.now() + 25_000;
    while (!match && Date.now() < deadline) {
      match = (await team.matches({ wait: 2 })).find(
        (one) => one.event.message?.id === posted.id,
      );
    }
    expect(match).toBeTruthy();

    // Restart: a second mount over the same tracker, the first stopped.
    app.stop();
    const second = mount(fixture.dir);
    try {
      const listed = await second.board.watchers();
      const own = listed.find((one) => one.owner === "board:client");
      expect(own?.watch.conformance?.tail).toBe("dev --label watch=yes");

      // The lease is still held: a fresh pull hands out nothing.
      const again = await second.board.matches({ wait: 1 });
      expect(again).toEqual([]);

      // The original lease still acks, from the new process.
      await second.board.ack(match?.id ?? "", { lease: match?.lease ?? "" });
    } finally {
      second.stop();
    }
    app = mount(fixture.dir);
    team = app.board;
  }, 90_000);

  test("a lease that ran out answers 409 stale_lease", async () => {
    const posted = await team.post("dev", {
      text: "stale lease bait",
      labels: { watch: "yes" },
    });
    let match: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const deadline = Date.now() + 25_000;
    while (!match && Date.now() < deadline) {
      match = (await team.matches({ wait: 2 })).find(
        (one) => one.event.message?.id === posted.id,
      );
    }
    expect(match).toBeTruthy();
    // Expire the lease the way five minutes would: through the persisted
    // state, as time itself would.
    const store = createBoardStore({ dir: fixture.dir });
    const state = createPersistedStore(store);
    await state.patch("match", match?.id ?? "", (data) => ({
      ...data,
      until: Date.now() - 1_000,
    }));
    const error = await errorOf(
      team.ack(match?.id ?? "", { lease: match?.lease ?? "" }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe("stale_lease");
  }, 90_000);

  test("an error ack requeues the match; a skip ack drops it", async () => {
    const posted = await team.post("dev", {
      text: "retry bait",
      labels: { watch: "yes" },
    });
    let match: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const deadline = Date.now() + 25_000;
    while (!match && Date.now() < deadline) {
      match = (await team.matches({ wait: 2 })).find(
        (one) => one.event.message?.id === posted.id,
      );
    }
    expect(match).toBeTruthy();
    await team.ack(match?.id ?? "", {
      lease: match?.lease ?? "",
      error: "flaky",
    });

    // The same match comes back, one try later.
    let retried: Awaited<ReturnType<Board["matches"]>>[number] | undefined;
    const retryDeadline = Date.now() + 25_000;
    while (!retried && Date.now() < retryDeadline) {
      retried = (await team.matches({ wait: 2 })).find(
        (one) => one.id === match?.id,
      );
    }
    expect(retried?.attempt).toBe(1);
    await team.ack(retried?.id ?? "", {
      lease: retried?.lease ?? "",
      skip: true,
    });
    const after = await team.matches({ wait: 1 });
    expect(after).toEqual([]);
  }, 120_000);

  test("corrupt persisted state is skipped and poisons nothing", async () => {
    const store = createBoardStore({ dir: fixture.dir });
    const state = createPersistedStore(store);
    // A match record whose metadata is garbage, and a registration record likewise.
    const garbage = JSON.stringify({ "bb.v": "not-a-number" });
    const created = await fixture.run([
      "create",
      "--title=planted corrupt state",
      "--type=task",
      `--metadata=${garbage}`,
      "--json",
    ]);
    expect(created.code).toBe(0);
    const parsed: unknown = JSON.parse(created.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const id =
      row !== null && typeof row === "object" && "id" in row
        ? String((row as Record<string, unknown>).id)
        : "";
    expect(id).not.toBe("");
    await fixture.run(["label", "add", id, "bb.state=match"]);
    await fixture.run(["label", "add", id, "bb.state=registration"]);

    const listed = await team.watchers();
    expect(listed.find((one) => one.owner === "board:client")).toBeTruthy();
    const matches = await team.matches();
    expect(Array.isArray(matches)).toBeTrue();
    await team.register({
      watch: { conformance: { tail: "dev --label watch=yes" } },
    });
    expect(listed.length).toBeGreaterThan(0);
  }, 90_000);
});
