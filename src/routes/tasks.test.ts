import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  board,
  BoardError,
  HttpError,
  type Backend,
  type Board,
  type Caller,
  type ProtocolMethods,
} from "@vercel/board";
import {
  type BdFixture,
  createBdFixture,
} from "../../test/helpers/bd-fixture.ts";
import { createEventRoutes } from "./events.ts";
import { createBoardStore, threadsRoutes } from "./threads.ts";
import { createTaskRoutes } from "./tasks.ts";
import { createLabels } from "../model/labels.ts";
import { createLeaseTimers } from "../tasks/leases.ts";

/**
 * The tasks routes, against the real entry point: a fixture tracker, the
 * store under `board()`, driven through the handle the way `vb` drives a
 * board — claim races, long-polls, leases, fences, and batches, all on real
 * bd. No mocks anywhere.
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

/** The families this test rig keeps none of; the orchestrator owns the real table. */
function refused(
  except: ReadonlySet<string>,
): Record<string, (...args: never[]) => Promise<unknown>> {
  const families: readonly {
    code: string;
    message: string;
    methods: readonly string[];
  }[] = [
    {
      code: "no_scheduler",
      message: "this board keeps no schedules",
      methods: ["schedule", "schedules", "cancelSchedule"],
    },
    {
      code: "no_grants",
      message: "this board keeps no grants",
      methods: [
        "grants",
        "createGrant",
        "createGrants",
        "updateGrant",
        "explain",
        "revokeGrant",
      ],
    },
    {
      code: "no_schemas",
      message: "this board keeps no schemas",
      methods: ["schemas", "schema", "createSchema"],
    },
    {
      code: "no_files",
      message: "this board keeps no files",
      methods: ["upload", "attachment", "uploadStart", "uploadFinish"],
    },
    {
      code: "not_supported",
      message: "this board doesn't keep that here",
      methods: [
        "watchers",
        "register",
        "matches",
        "ack",
        "syncImport",
        "syncReceipt",
        "syncThread",
        "syncFind",
        "syncCopies",
        "inboxPush",
        "inboxNext",
        "inboxAck",
        "inbox",
        "typing",
        "readSource",
        "joinSource",
        "synced",
        "linked",
      ],
    },
  ];
  const out: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const family of families) {
    for (const name of family.methods) {
      if (except.has(name)) continue;
      out[name] = async () => {
        throw new HttpError(501, family.code, family.message);
      };
    }
  }
  return out;
}

interface Rig {
  fixture: BdFixture;
  team: Board;
  /** The backend's own route table, for reading routes as an HTTP client would. */
  routes: Partial<ProtocolMethods>;
}

/** The plain self caller, as board()'s own requests arrive. */
const CALLER: Caller = { self: null, origin: {} };

let rig: Rig | null = null;
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const done of cleanups) done();
});

async function boot(): Promise<Rig> {
  if (rig !== null) return rig;
  const fixture = await createBdFixture();
  cleanups.push(() => fixture.close());
  const store = createBoardStore({ dir: fixture.dir });
  const events = createEventRoutes({
    transport: store.transport,
    codec: store.codec,
    labels: createLabels(),
    authorFor: (slug) => store.authorForSlug(slug),
    cadenceMs: 100,
    // A short hold: the probe rows' bare creates must not stall the polls.
    holdMs: 800,
  });
  events.poller.start();
  cleanups.push(() => {
    void events.poller.stop();
  });
  const tasks = createTaskRoutes({ store, poller: events.poller });
  const routes = { ...threadsRoutes(store), ...tasks, events: events.events };
  const backend = {
    keeps: true,
    routes: [],
    ...refused(new Set(Object.keys(routes))),
    ...routes,
    trust: {
      grants: async () => [
        {
          id: "bb-open",
          principals: [{ kind: "everyone" }],
          can: { "*": "all" },
        },
      ],
    },
    bind(binding: Parameters<Backend["bind"]>[0]) {
      store.bind(binding);
    },
  } as unknown as Backend;
  rig = { fixture, team: board({ backend }), routes };
  return rig;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a read until it holds, the conformance suite's own cadence. */
async function soon(
  what: () => Promise<boolean>,
  what_ = "the state",
): Promise<void> {
  for (const deadline = Date.now() + 15_000; !(await what());) {
    if (Date.now() >= deadline) throw new Error(`${what_}: never settled`);
    await sleep(250);
  }
}

async function stateOf(team: Board, id: string): Promise<string | undefined> {
  // Through the tasks list (this unit's own routes): the threads routes'
  // views carry no `task` until the orchestrator wires that seam.
  const all = await team.tasks.list({ state: "all", limit: 500 });
  return all.tasks.find((summary) => summary.message.id === id)?.message.task
    ?.state;
}

/** One issue row out of the fixture's own `bd show --json` (no envelope). */
async function showRow(
  fixture: BdFixture,
  id: string,
): Promise<Record<string, unknown>> {
  const raw = await fixture.run(["show", id, "--json"]);
  expect(raw.code).toBe(0);
  const parsed = JSON.parse(raw.stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return (rows[0] ?? {}) as Record<string, unknown>;
}

describe("tasks routes (real bd, mounted through board())", () => {
  test("boots the fixture and mounts the task surface", async () => {
    const { team } = await boot();
    const me = await team.me();
    expect(me.principal).toBe("board:client");
    const list = await team.tasks.list({ channel: "boot" });
    expect(list.tasks).toEqual([]);
  }, 120_000);

  test("create with needs answers waiting; completing the need readies the waiter and lands both on the feed", async () => {
    const { team } = await boot();
    // The feed's anchor, taken before anything writes to this channel.
    const anchor = (await team.poll({ channel: "t-needs" })).cursor;
    const fix = await team.tasks.create("t-needs", {
      text: "fix the thing",
      labels: { step: "fix" },
    });
    expect(fix.task.task?.state).toBe("ready");
    expect(fix.task.labels["board.task"]).toBe("ready");
    expect(fix.task.task?.owner).toBe("board:client");

    const review = await team.tasks.create("t-needs", {
      text: "review the fix",
      labels: { step: "review" },
      needs: [fix.task.id],
    });
    expect(review.task.task?.state).toBe("waiting");
    expect(review.task.labels["board.task"]).toBe("waiting");
    expect(review.task.task?.needs).toEqual([fix.task.id]);

    const waiting = await errorOf(
      team.tasks.claim(review.task.id, { lease: 60 }),
    );
    expect(waiting.status).toBe(409);
    expect(waiting.code).toBe("task_waiting");

    const claim = await team.tasks.claim(fix.task.id, { lease: 60 });
    await claim.complete("fixed");
    await soon(
      async () => (await stateOf(team, review.task.id)) === "ready",
      "the waiter should be ready once its need completed",
    );
    const thread = await team.thread(review.task.id);
    expect(thread.message.labels["board.task"]).toBe("ready");
    // The same write landed the completion and the readying on the feed.
    const page2 = await team.poll({
      channel: "t-needs",
      after: anchor,
      wait: 5,
    });
    const waiterEvent = page2.events.find(
      (event) => event.message?.id === review.task.id,
    );
    if (waiterEvent === undefined) {
      console.log("DEBUG page2:", JSON.stringify(page2).slice(0, 4000));
    }
    expect(waiterEvent).toBeTruthy();
    expect(waiterEvent?.message?.labels["board.task"]).toBe("ready");
    // A failed prerequisite readies nothing.
    const stuck = await team.tasks.create("t-needs", {
      text: "waits on a failure",
      needs: [review.task.id],
    });
    const c2 = await team.tasks.claim(review.task.id, { lease: 60 });
    await c2.fail("not this time");
    expect(await stateOf(team, stuck.task.id)).toBe("waiting");
    await team.tasks.reopen(review.task.id);
    expect(await stateOf(team, review.task.id)).toBe("ready");
  }, 180_000);

  test("claim, renew, complete: the happy path carries {epoch, token, until}", async () => {
    const { team } = await boot();
    const made = await team.tasks.create("t-lease", { text: "a task to work" });
    const asked = Date.now();
    const claim = await team.tasks.claim(made.task.id, { lease: 300 });
    const lease = Date.parse(claim.until) - asked;
    expect(claim.epoch).toBe(1);
    expect(claim.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lease).toBeGreaterThanOrEqual(295_000);
    expect(lease).toBeLessThan(310_000);
    expect(claim.task.task?.claim?.until).toBe(claim.until);
    expect(claim.task.task?.state).toBe("claimed");
    expect(claim.task.labels["board.task"]).toBe("claimed");

    const again = Date.now();
    const renewed = await claim.renew(60);
    const left = Date.parse(renewed.until) - again;
    expect(left).toBeGreaterThanOrEqual(55_000);
    expect(left).toBeLessThan(65_000);
    expect(renewed.task.task?.state).toBe("claimed");

    // Release hands it back; the epoch grows across claims of one task.
    const released = await claim.release();
    expect(released.task?.state).toBe("ready");
    const fallback = Date.now();
    const unasked = await team.tasks.claim(made.task.id);
    expect(unasked.epoch).toBe(2);
    // The default lease gives at least 5 minutes.
    expect(Date.parse(unasked.until) - fallback).toBeGreaterThanOrEqual(
      295_000,
    );

    const done = await unasked.complete("shipped");
    expect(done.task?.state).toBe("completed");
    expect(done.task?.result).toBe("shipped");
    expect(done.labels["board.task"]).toBe("completed");
    expect(done.task?.claim).toBeNull();

    // A completed task takes no claim: it's finished for good.
    const reclaim = await errorOf(
      team.tasks.claim(made.task.id, { lease: 60 }),
    );
    expect(reclaim.code).toBe("task_finished");

    // A failed task reopens ready, and works end to end again.
    await team.tasks.create("t-lease", { text: "a task to fail" });
    const second = await team.tasks.list({ channel: "t-lease", limit: 500 });
    const victim = second.tasks.find(
      (summary) => summary.message.text === "a task to fail",
    )?.message.id;
    expect(victim).toBeTruthy();
    const failed = await team.tasks
      .claim(victim ?? "", { lease: 60 })
      .then((held) => held.fail("gave up"));
    expect(failed.task?.state).toBe("failed");
    expect(failed.task?.reason).toBe("gave up");
    const reopened = await team.tasks.reopen(victim ?? "");
    expect(reopened.task?.state).toBe("ready");
  }, 180_000);

  test("a fenced write with the wrong token or a stale epoch is claim_lost and changes nothing", async () => {
    const { team } = await boot();
    const made = await team.tasks.create("t-fence", {
      text: "a task to fence",
    });
    const first = await team.tasks.claim(made.task.id, { lease: 60 });

    const badToken = await errorOf(
      team.tasks
        .held(made.task.id, { epoch: first.epoch, token: `${first.token}x` })
        .complete("not mine"),
    );
    expect(badToken.status).toBe(409);
    expect(badToken.code).toBe("claim_lost");
    const badEpoch = await errorOf(
      team.tasks
        .held(made.task.id, { epoch: first.epoch + 5, token: first.token })
        .complete("not mine"),
    );
    expect(badEpoch.code).toBe("claim_lost");
    expect(await stateOf(team, made.task.id)).toBe("claimed");

    // Released, the task takes a new claim at the next epoch; the old
    // claim's writes are lost from then on.
    await first.release();
    const second = await team.tasks.claim(made.task.id, { lease: 60 });
    expect(second.epoch).toBe(first.epoch + 1);
    const stale = await errorOf(first.complete("too late"));
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("claim_lost");
    const staleRenew = await errorOf(first.renew(60));
    expect(staleRenew.code).toBe("claim_lost");
    const failed = await second.fail("conformance: could not");
    expect(failed.task?.state).toBe("failed");
    expect(await stateOf(team, made.task.id)).toBe("failed");
  }, 180_000);

  test("of two agents claiming one issue, one lands and the loser hears task_claimed", async () => {
    const { team, fixture } = await boot();
    const made = await team.tasks.create("t-race", {
      text: "one task, two hands",
    });
    const a = team.as("racer-a");
    const b = team.as("racer-b");
    const settled = await Promise.allSettled([
      a.tasks.claim(made.task.id, { lease: 60 }),
      b.tasks.claim(made.task.id, { lease: 60 }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const loss = (lost[0] as PromiseRejectedResult).reason as BoardError;
    expect(loss.status).toBe(409);
    expect(loss.code).toBe("task_claimed");
    const winner = (
      won[0] as PromiseFulfilledResult<{
        task: {
          by: { actor: string };
          task?: { state: string; claim?: { actor: string | null } };
        };
      }>
    ).value;
    expect(winner.task.task?.state).toBe("claimed");
    // The claim names the actor that holds it — one of the two racers, and
    // never the task's maker (which `by` still is, and neither racer is).
    expect(winner.task.task?.claim?.actor).not.toBe(winner.task.by.actor);
    expect(["board:client:racer-a", "board:client:racer-b"]).toContain(
      winner.task.task?.claim?.actor,
    );
    // bd itself holds exactly one assignee (the winner's mapped slug): a
    // single non-empty holder at the tracker, whatever the actor id shows.
    const row = await showRow(fixture, made.task.id);
    expect(
      typeof row.assignee === "string" && (row.assignee as string).length > 0,
    ).toBeTrue();
  }, 180_000);

  test("a waiting claim takes the task that becomes ready mid-poll; a quiet wait answers {task: null}", async () => {
    const { team } = await boot();
    const worker = team.as("pool-worker");
    // The gate carries no queue label, so the worker's own scan (which
    // filters on queue=q1) can't take it; it gates the waiter only.
    const gate = await worker.tasks.create("t-pool", {
      text: "the gate",
    });
    const waits = await worker.tasks.create("t-pool", {
      text: "the work behind the gate",
      labels: { queue: "q1" },
      needs: [gate.task.id],
    });
    expect(waits.task.task?.state).toBe("waiting");

    // Someone else works the gate while the worker long-polls for its own task.
    const pending = worker.tasks.claim({
      channel: "t-pool",
      label: { queue: "q1" },
      wait: 20,
      lease: 60,
    });
    await sleep(400);
    const helper = await team.tasks.claim(gate.task.id, { lease: 60 });
    await helper.complete("gate cleared");

    const got = await pending;
    expect(got).not.toBeNull();
    expect(got?.task.id).toBe(waits.task.id);
    expect(got?.task.task?.state).toBe("claimed");
    await got?.release();

    // A quiet wait lapses to null.
    const started = Date.now();
    const quiet = await worker.tasks.claim({
      channel: "t-pool",
      label: { queue: "q-none" },
      wait: 2,
    });
    const elapsed = Date.now() - started;
    expect(quiet).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(15_000);
  }, 180_000);

  test("release hands the task back and really clears the holder", async () => {
    const { team, fixture } = await boot();
    const made = await team.tasks.create("t-release", {
      text: "give this back",
    });
    const holder = team.as("holder-x");
    const claim = await holder.tasks.claim(made.task.id, { lease: 60 });
    expect(claim.task.task?.claim?.actor).toBe("board:client:holder-x");

    // bd's side carries the holder's mapped slug while the claim is live.
    const shown = await showRow(fixture, made.task.id);
    expect(
      typeof shown.assignee === "string" && shown.assignee.length > 0,
    ).toBeTrue();

    const released = await claim.release();
    expect(released.task?.state).toBe("ready");
    expect(released.task?.claim).toBeNull();
    expect(released.labels["board.task"]).toBe("ready");

    // The assignee is actually cleared on bd's side: `--status open` alone
    // would leave it, and a new claim by anyone would refuse.
    const after = await showRow(fixture, made.task.id);
    expect(after.status).toBe("open");
    expect((after.assignee as string | undefined) ?? "").toBe("");
    const other = team.as("holder-y");
    const reClaimed = await other.tasks.claim(made.task.id, { lease: 60 });
    expect(reClaimed.task.task?.claim?.actor).toBe("board:client:holder-y");
    await reClaimed.release();
  }, 180_000);

  test("a claim past its lease is claimable at once, flips the label to ready, and is on the feed", async () => {
    const { team, fixture } = await boot();
    // The feed's anchor, taken before anything writes to this channel.
    const anchor = (await team.poll({ channel: "t-expired" })).cursor;
    const made = await team.tasks.create("t-expired", { text: "outlive me" });
    const first = await team.tasks.claim(made.task.id, { lease: 60 });
    expect(await stateOf(team, made.task.id)).toBe("claimed");

    // Out-of-band tamper: the lease's end is now past. Reads still say what
    // the label says; the claim is over all the same.
    const shown = await showRow(fixture, made.task.id);
    const stored = (shown.metadata as Record<string, unknown>)["bb.claim"] as {
      epoch: number;
      token: string;
      until: string;
    };
    await fixture.run([
      "update",
      made.task.id,
      "--metadata",
      JSON.stringify({
        "bb.claim": {
          ...stored,
          until: new Date(Date.now() - 2_000).toISOString(),
        },
      }),
      "--json",
    ]);

    // The next claim takes it: expiry is appended in the same breath.
    const second = await team.tasks.claim(made.task.id, { lease: 60 });
    expect(second.epoch).toBe(first.epoch + 1);
    expect(second.task.task?.state).toBe("claimed");

    // The feed carries the flip: the task said ready before it was claimed again.
    const page = await team.poll({
      channel: "t-expired",
      after: anchor,
      wait: 5,
    });
    const flips = page.events.filter(
      (event) => event.message?.id === made.task.id,
    );
    expect(
      flips.some((event) => event.message?.labels["board.task"] === "ready"),
    ).toBeTrue();
    await second.release();
  }, 180_000);

  test("the lease timer fires a claim's expiry at its end", async () => {
    const fired: { id: string; epoch: number }[] = [];
    const timers = createLeaseTimers((id, epoch) => {
      fired.push({ id, epoch });
    });
    timers.arm("task-1", 3, Date.now() + 150);
    timers.arm("task-2", 1, Date.now() + 60_000);
    timers.cancel("task-2", 1);
    await sleep(600);
    expect(fired).toEqual([{ id: "task-1", epoch: 3 }]);
    timers.stop();
    // An arm for the same task and epoch replaces the earlier timer.
    const twice: string[] = [];
    const timers2 = createLeaseTimers((id) => {
      twice.push(id);
    });
    timers2.arm("task-9", 1, Date.now() + 10_000);
    timers2.arm("task-9", 1, Date.now() + 80);
    await sleep(400);
    expect(twice).toEqual(["task-9"]);
    timers2.stop();
  }, 30_000);

  test("a batch makes all its tasks or none: a duplicate or cycling key writes nothing", async () => {
    const { team, routes } = await boot();
    const done = await team.tasks.create("t-batch", {
      text: "already finished",
    });
    await (await team.tasks.claim(done.task.id, { lease: 60 })).complete();

    const batchId = "batch-once-1";
    const made = await team.tasks.createMany(
      "t-batch",
      [
        { key: "fix", text: "batched fix", labels: { step: "fix" } },
        { key: "review", text: "batched review", needs: [{ key: "fix" }] },
        { text: "batched after done", needs: [done.task.id] },
      ],
      { id: batchId },
    );
    expect(made.map((task) => task.text)).toEqual([
      "batched fix",
      "batched review",
      "batched after done",
    ]);
    expect(made[0]?.task?.state).toBe("ready");
    expect(made[1]?.task?.state).toBe("waiting");
    expect(made[1]?.task?.needs).toEqual([made[0]?.id]);
    expect(made[2]?.task?.state).toBe("ready");
    expect(made[2]?.labels["board.task"]).toBe("ready");

    // The batch read-back answers the same tasks, as they are now: a create
    // whose id names a batch IS the read — the board serves it from the
    // batch record before making anything. (A handle derives its own ids,
    // so the batch lives under the derived one; the raw
    // `GET /tasks/batch/:id` route names a batch by the id its caller gave.)

    // The same id and the same plan again makes none and answers the first.
    const retry = await team.tasks.createMany(
      "t-batch",
      [
        { key: "fix", text: "batched fix", labels: { step: "fix" } },
        { key: "review", text: "batched review", needs: [{ key: "fix" }] },
        { text: "batched after done", needs: [done.task.id] },
      ],
      { id: batchId },
    );
    expect(retry.map((task) => task.id)).toEqual(made.map((task) => task.id));
    expect((retry[1] as { task?: { state?: string } }).task?.state).toBe(
      "waiting",
    );
    // Another plan under the same id is refused.
    const other = await errorOf(
      team.tasks.createMany(
        "t-batch",
        [{ text: "another plan under the same id" }],
        { id: batchId },
      ),
    );
    expect(other.status).toBe(409);
    expect(other.code).toBe("duplicate_id");
    // An id that made no batch is not found.
    const missing = await routes
      .createdTasks(CALLER, { id: "batch-never-made" })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(HttpError);
    expect((missing as HttpError).status).toBe(404);
    expect((missing as HttpError).code).toBe("batch_not_found");

    // Refused batches: a duplicate key, a cycle, an unknown key. None of them makes a task.
    const listed = async (): Promise<string[]> =>
      (
        await team.tasks.list({ channel: "t-batch", state: "all", limit: 500 })
      ).tasks
        .map((summary) => summary.message.text)
        .filter((text) => text.startsWith("never made"));
    expect(await listed()).toEqual([]);

    const duplicate = await errorOf(
      team.tasks.createMany("t-batch", [
        { key: "a", text: "never made, first a" },
        { key: "a", text: "never made, second a" },
      ]),
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.code).toBe("invalid_needs");

    const cycle = await errorOf(
      team.tasks.createMany("t-batch", [
        { key: "x", text: "never made, waits for y", needs: [{ key: "y" }] },
        { key: "y", text: "never made, waits for x", needs: [{ key: "x" }] },
      ]),
    );
    expect(cycle.code).toBe("invalid_needs");

    const unknownKey = await errorOf(
      team.tasks.createMany("t-batch", [
        { text: "never made, waits for nobody", needs: [{ key: "nobody" }] },
      ]),
    );
    expect(unknownKey.code).toBe("invalid_needs");

    await sleep(500);
    expect(await listed()).toEqual([]);
  }, 180_000);

  test("a narrowed or unrelated caller is held out: task_not_owned for owner verbs, forbidden to claim", async () => {
    const { team } = await boot();
    const made = await team.tasks.create("t-own", { text: "not yours" });
    const stranger = team.as("stranger-z");
    for (const attempt of [
      () => stranger.tasks.block(made.task.id, "not yours"),
      () => stranger.tasks.unblock(made.task.id),
      () => stranger.tasks.assign(made.task.id, null),
      () => stranger.tasks.needs(made.task.id, []),
      () => stranger.tasks.cancel(made.task.id, "not yours"),
      () => stranger.tasks.reopen(made.task.id),
    ]) {
      const error = await errorOf(attempt());
      expect(error.status).toBe(403);
      expect(error.code).toBe("task_not_owned");
    }
    // A caller narrowed out of `label` claims none, by id or from the queue.
    const narrowed = team.as("narrowed-y", {
      can: { "t-own": ["read", "post"] },
    });
    const claim = await errorOf(
      narrowed.tasks.claim(made.task.id, { lease: 60 }),
    );
    expect(claim.status).toBe(403);
    expect(claim.code).toBe("forbidden");
    const ready = await errorOf(
      narrowed.tasks.claim({ channel: "t-own", lease: 60 }),
    );
    expect(ready.status).toBe(403);
    // The task is untouched by every refusal.
    expect(await stateOf(team, made.task.id)).toBe("ready");
  }, 180_000);

  test("what a task needs changes only unclaimed and unfinished, and never into a cycle", async () => {
    const { team } = await boot();
    const first = await team.tasks.create("t-needs-change", {
      text: "the first of a line",
    });
    const second = await team.tasks.create("t-needs-change", {
      text: "waits for the first",
      needs: [first.task.id],
    });
    const third = await team.tasks.create("t-needs-change", {
      text: "waits for the second",
      needs: [second.task.id],
    });

    const self = await errorOf(
      team.tasks.needs(first.task.id, [first.task.id]),
    );
    expect(self.code).toBe("invalid_needs");
    const back = await errorOf(
      team.tasks.needs(first.task.id, [second.task.id]),
    );
    expect(back.code).toBe("invalid_needs");
    const through = await errorOf(
      team.tasks.needs(first.task.id, [third.task.id]),
    );
    expect(through.code).toBe("invalid_needs");
    expect(await stateOf(team, first.task.id)).toBe("ready");

    // A claimed task's needs stay; released, the change lands. The change
    // is `fourth`, which waits for nothing: pointing `first` at `third`
    // would close first→third→second→first, a cycle, refused above.
    const fourth = await team.tasks.create("t-needs-change", {
      text: "waits for nobody",
    });
    const claim = await team.tasks.claim(first.task.id, { lease: 60 });
    const heldRefuse = await errorOf(
      team.tasks.needs(first.task.id, [fourth.task.id]),
    );
    expect(heldRefuse.code).toBe("task_claimed");
    await claim.release();
    const moved = await team.tasks.needs(first.task.id, [fourth.task.id]);
    expect(moved.task?.state).toBe("waiting");
    expect(moved.task?.needs).toEqual([fourth.task.id]);
    await team.tasks.needs(first.task.id, []);

    // A canceled prerequisite can never complete: refused.
    const dropped = await team.tasks.create("t-needs-change", {
      text: "will be canceled",
    });
    await team.tasks.cancel(dropped.task.id, "not wanted");
    const canceledNeed = await errorOf(
      team.tasks.needs(first.task.id, [dropped.task.id]),
    );
    expect(canceledNeed.code).toBe("invalid_needs");

    // A finished task's needs stay as they were.
    const done = await team.tasks.create("t-needs-change", {
      text: "will be done",
    });
    await (await team.tasks.claim(done.task.id, { lease: 60 })).complete();
    const finishedRefuse = await errorOf(
      team.tasks.needs(done.task.id, [second.task.id]),
    );
    expect(finishedRefuse.code).toBe("task_finished");
  }, 180_000);

  test("states hold their gates: blocked, assigned, finished, canceled", async () => {
    const { team } = await boot();
    const made = await team.tasks.create("t-states", { text: "state gates" });

    const blocked = await team.tasks.block(made.task.id, "approve?", {
      kind: "awaiting_approval",
    });
    expect(blocked.task?.state).toBe("blocked");
    expect(blocked.task?.blocked).toEqual({
      kind: "awaiting_approval",
      reason: "approve?",
    });
    const heldRefuse = await errorOf(
      team.tasks.claim(made.task.id, { lease: 60 }),
    );
    expect(heldRefuse.code).toBe("task_blocked");
    const unblocked = await team.tasks.unblock(made.task.id);
    expect(unblocked.task?.state).toBe("ready");

    // Holding a claimed task takes its claim; without it, task_claimed.
    const claim = await team.tasks.claim(made.task.id, { lease: 60 });
    const withoutClaim = await errorOf(
      team.tasks.block(made.task.id, "no claim of mine"),
    );
    expect(withoutClaim.code).toBe("task_claimed");
    const byClaim = await claim.block("which one?", { kind: "needs_input" });
    expect(byClaim.task?.state).toBe("blocked");
    const lostAfterBlock = await errorOf(claim.complete("too late"));
    expect(lostAfterBlock.code).toBe("claim_lost");
    await team.tasks.unblock(made.task.id);

    // Assignment keeps the task for one actor: anyone else hears task_assigned.
    const assigned = await team.tasks.assign(
      made.task.id,
      "board:client+worker",
    );
    expect(assigned.task?.for).toBe("board:client+worker");
    const wrongHands = await errorOf(
      team.as("other-hands").tasks.claim(made.task.id, { lease: 60 }),
    );
    expect(wrongHands.code).toBe("task_assigned");
    await team.tasks.assign(made.task.id, null);

    const canceled = await team.tasks.cancel(made.task.id, "done checking");
    expect(canceled.task?.state).toBe("canceled");
    expect(canceled.task?.reason).toBe("done checking");
    const claimCanceled = await errorOf(
      team.tasks.claim(made.task.id, { lease: 60 }),
    );
    expect(claimCanceled.code).toBe("task_finished");
    const cancelAgain = await errorOf(team.tasks.cancel(made.task.id, "again"));
    expect(cancelAgain.code).toBe("task_finished");
  }, 180_000);

  test("the board.task label stays the board's own, and reads like any label", async () => {
    const { team } = await boot();
    const made = await team.tasks.create("t-label", {
      text: "labels under board.",
    });
    const reserved = await errorOf(
      team.label(made.task.id, { set: { "board.task": "completed" } }),
    );
    expect(reserved.status).toBe(400);
    expect(reserved.code).toBe("reserved_label");
    // A conditional write may hold on it.
    const landed = await team.label(made.task.id, {
      set: { seen: "yes" },
      if: { "board.task": "ready" },
    });
    expect(landed.ok).toBeTrue();
    const conflict = await errorOf(
      team.label(made.task.id, {
        set: { seen: "no" },
        if: { "board.task": "claimed" },
      }),
    );
    expect(conflict.code).toBe("label_conflict");
    const thread = await team.thread(made.task.id);
    expect(thread.message.labels.seen).toBe("yes");
    expect(thread.message.labels["board.task"]).toBe("ready");
  }, 120_000);

  test("making a thread that's there a task: adopt, refuse replies and doubles", async () => {
    const { team } = await boot();
    const posted = await team.post("t-adopt", "a thread worth doing");
    const made = await team.tasks.create({ re: posted.id }, {});
    expect(made.task.task?.state).toBe("ready");
    expect(made.task.task?.owner).toBe("board:client");
    const again = await errorOf(team.tasks.create({ re: posted.id }, {}));
    expect(again.status).toBe(409);
    expect(again.code).toBe("already_a_task");
    const reply = await team.reply(posted.id, "a reply, not a thread");
    const replyTask = await errorOf(team.tasks.create({ re: reply.id }, {}));
    expect(replyTask.status).toBe(400);
    // Plain threads stay plain.
    const plain = await team.post("t-adopt", "never a task");
    const thread = await team.thread(plain.id);
    expect(thread.message.task).toBeUndefined();
  }, 120_000);

  test("tasks list: channel and subtree, labels, owner, needs, and pages", async () => {
    const { team } = await boot();
    const one = await team.tasks.create("t-list", {
      text: "listed one",
      labels: { queue: "qa" },
    });
    const two = await team.tasks.create("t-list/nested", {
      text: "listed two",
      labels: { queue: "qb" },
    });
    const wait = await team.tasks.create("t-list", {
      text: "listed waiting",
      needs: [one.task.id],
    });

    const channel = await team.tasks.list({ channel: "t-list" });
    expect(channel.tasks.map((summary) => summary.message.id)).toEqual([
      one.task.id,
      wait.task.id,
    ]);
    const subtree = await team.tasks.list({ channel: "t-list/" });
    // Oldest first, in one flat order: made one, then two, then wait.
    expect(subtree.tasks.map((summary) => summary.message.id)).toEqual([
      one.task.id,
      two.task.id,
      wait.task.id,
    ]);
    const labeled = await team.tasks.list({
      channel: "t-list/",
      label: { queue: "qb" },
    });
    expect(labeled.tasks.map((summary) => summary.message.id)).toEqual([
      two.task.id,
    ]);
    const waitingOn = await team.tasks.list({ needs: one.task.id });
    expect(waitingOn.tasks.map((summary) => summary.message.id)).toEqual([
      wait.task.id,
    ]);
    const mine = await team.tasks.list({
      channel: "t-list",
      owner: "board:client",
    });
    // Both open t-list tasks are the caller's own (two is in the nested
    // channel, and the finished one is made below).
    expect(mine.tasks.length).toBe(2);
    const paged = await team.tasks.list({ channel: "t-list/", limit: 2 });
    expect(paged.tasks).toHaveLength(2);
    const next = await team.tasks.list({
      channel: "t-list/",
      limit: 2,
      after: paged.cursor,
    });
    expect(next.tasks.length).toBeGreaterThanOrEqual(1);
    for (const seen of [...paged.tasks, ...next.tasks].map(
      (summary) => summary.message.id,
    )) {
      expect([one.task.id, wait.task.id, two.task.id]).toContain(seen);
    }
    // Completed tasks answer only state=all (or completed).
    const finished = await team.tasks.create("t-list", {
      text: "listed finished",
    });
    await (await team.tasks.claim(finished.task.id, { lease: 60 })).complete();
    const open = await team.tasks.list({ channel: "t-list" });
    expect(open.tasks.map((summary) => summary.message.id)).not.toContain(
      finished.task.id,
    );
    const all = await team.tasks.list({ channel: "t-list", state: "all" });
    expect(all.tasks.map((summary) => summary.message.id)).toContain(
      finished.task.id,
    );
  }, 180_000);
});
