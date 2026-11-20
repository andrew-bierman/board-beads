/**
 * The load reproduction for the tasks-group conformance defect: the three
 * feed-reading checks (task.ready on make/unblock, the changes-of-task
 * sequence, the board.task=ready filtered feed) — the checks CI failed with
 * `got []`, 3/3 attempts, while the same run passed locally.
 *
 * The rig holds their exact sequences against the real mounted backend
 * (beads() over a real bd fixture, the conformance path) while a load
 * generator contends with it: `--churn N` subprocess loops each hammering
 * bd spawns on their own real trackers, `--burners N` CPU burner processes.
 * It is the CI runner in miniature: few cores, every bd spawn slow, the
 * backend's own poller + routes + writes all racing.
 *
 * (For the record: the CI [] was not load at all — it was the feed's
 * nonce-pairing guard filtering every stamped move out, because main's
 * tasks routes never wrote the consumed nonce the guard requires. This
 * branch's routes write it, and the rig is how the delivery stays proven
 * under contention: the checks must stay green here, every run.)
 *
 * Usage:
 *   bun run scripts/repro-feed-load.ts [--churn 4] [--burners 2] [--rounds 1]
 *       [--keep]  (keep the fixture's tracker dir for journal autopsies)
 *   bun run scripts/repro-feed-load.ts --suite --churn 4 --burners 2 --rounds 2
 *       (the REAL conformance is the workload: each round runs
 *       `conformance --backend beads` as a subprocess under the load
 *       generator and reports its receipt summary)
 *
 * For a CI-runner-in-miniature, pin the whole rig to a couple of cores:
 *   taskset -c 0,1 bun run scripts/repro-feed-load.ts --suite --churn 3 --burners 1 --rounds 2
 *
 * Exit 0 when every check passed every round; exit 1 names the failures.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { board, type Board } from "@vercel/board";
import { beads } from "../src/index.ts";
import { createBdFixture } from "../test/helpers/bd-fixture.ts";

// ---------------------------------------------------------------------------
// Args.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  const value = at >= 0 ? Number(args[at + 1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const CHURN = flag("churn", 4);
const BURNERS = flag("burners", 2);
const ROUNDS = flag("rounds", 1);
const KEEP = args.includes("--keep");

// ---------------------------------------------------------------------------
// The load generator: subprocesses, so their CPU cost is real contention.
// ---------------------------------------------------------------------------

/** One bd-heavy churn loop, on its own real tracker, in its own process. */
const CHURNER_SOURCE = `
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const root = mkdtempSync(join(tmpdir(), "bb-churn-"));
const home = join(root, "home");
const dir = join(root, "tracker");
require("node:fs").mkdirSync(home);
require("node:fs").mkdirSync(dir);
const env = { PATH: process.env.PATH, HOME: home, BD_EVENTS_JOURNAL: "1" };
const run = (args) => new Promise((resolve) => {
  const child = spawn("bd", args, { cwd: dir, env });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.on("close", () => resolve(out));
  child.on("error", () => resolve(""));
});
(async () => {
  await run(["init", "--quiet"]);
  let n = 0;
  const ids = [];
  while (true) {
    n += 1;
    const made = await run(["create", "--title=churn item " + n, "--type=task", "--json"]);
    try {
      const parsed = JSON.parse(made);
      const row = Array.isArray(parsed) ? parsed[0] : parsed;
      if (row && row.id) ids.push(row.id);
    } catch {}
    if (ids.length > 12) {
      const victim = ids.shift();
      await run(["update", victim, "--metadata", '{"churn.n":' + n + '}', "--add-label", "churn=hot", "--json"]);
      await run(["update", victim, "--metadata", '{"churn.move":{"n":"m' + n + '","events":[]}}', "--json"]);
    }
    await run(["list", "--all", "--json"]);
    await run(["events", "tail", "--since", "0", "--json"]);
  }
})();
`;

function startChurner(): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), "bb-repro-churn-"));
  const path = join(dir, "churner.cjs");
  writeFileSync(path, CHURNER_SOURCE, { mode: 0o755 });
  chmodSync(path, 0o755);
  const child = spawn(process.execPath, [path], { stdio: "ignore" });
  child.unref?.();
  return child;
}

/** One CPU burner: a busy loop process, no I/O. */
function startBurner(): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const t = Date.now() + 1e9; let x = 0; while (Date.now() < t) x = (x + 1) % 7;",
    ],
    { stdio: "ignore" },
  );
  child.unref?.();
  return child;
}

const churners: ChildProcess[] = [];
const burners: ChildProcess[] = [];
function startLoad(): void {
  for (let i = 0; i < CHURN; i += 1) churners.push(startChurner());
  for (let i = 0; i < BURNERS; i += 1) burners.push(startBurner());
}
function stopLoad(): void {
  for (const child of [...churners, ...burners]) child.kill("SIGKILL");
  churners.length = 0;
  burners.length = 0;
}

// ---------------------------------------------------------------------------
// The three checks, ported from @vercel/board/conformance (tasks group).
// ---------------------------------------------------------------------------

interface Ctx {
  board: Board;
  channel: string;
  labels: { conformance: string };
}

/** A task of this run's, as the suite's `task` helper makes one. */
async function task(
  ctx: Ctx,
  text: string,
  options: Record<string, unknown> = {},
): Promise<{
  task: { id: string; task?: { state?: string } | null };
  claim?: { epoch: number; token: string };
}> {
  const { labels, ...rest } = options;
  const made = await ctx.board.tasks.create(ctx.channel, {
    text,
    labels: { ...ctx.labels, ...(labels as Record<string, string>) },
    noSync: true,
    ...rest,
  });
  return made as unknown as {
    task: { id: string; task?: { state?: string } | null };
    claim?: { epoch: number; token: string };
  };
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** `Mismatch`, as the suite raises on a timed-out until(). */
class Mismatch extends Error {}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface SeenEvent {
  type: string;
  message?: { id?: string; task?: { state?: string } };
  payload?: Record<string, unknown>;
}

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Check 1: "says task.ready each time a task that needs others becomes
 * ready: right after it is made or unblocked, once they have completed".
 */
async function checkReadyOnMakeAndUnblock(ctx: Ctx): Promise<CheckResult> {
  const name = "task.ready on make and unblock (changes-of-task)";
  try {
    const { task: first } = await task(
      ctx,
      "repro: a prerequisite that completes first",
    );
    await (await ctx.board.tasks.claim(first.id, { lease: 60 })).complete();
    const label = [`conformance=${ctx.labels.conformance}`];
    const anchor = await ctx.board.poll({ channel: ctx.channel, label });
    let cursor = anchor.cursor;
    const made = await task(
      ctx,
      "repro: a task made once what it needs completed",
      {
        needs: [first.id],
        claim: true,
        lease: 60,
      },
    );
    const { id } = made.task;
    if (made.task.task?.state !== "claimed") {
      return {
        name,
        ok: false,
        detail: `made with a claim answered ${made.task.task?.state}`,
      };
    }
    await ctx.board.tasks.held(id, made.claim!).block("repro: approve?");
    const { task: alone } = await task(ctx, "repro: a task that needs none");
    await ctx.board.tasks.block(alone.id, "repro: approve?");
    if ((await ctx.board.tasks.unblock(alone.id)).task?.state !== "ready") {
      return { name, ok: false, detail: "a task that needs none, unblocked" };
    }
    if ((await ctx.board.tasks.unblock(id)).task?.state !== "ready") {
      return {
        name,
        ok: false,
        detail: "the task, unblocked once what it needs completed",
      };
    }
    const seen: SeenEvent[] = [];
    const changes = (of: string) =>
      seen
        .filter(
          (event) => event.type.startsWith("task.") && event.message?.id === of,
        )
        .map((event) => [event.type, event.message?.task?.state]);
    for (
      const deadline = Date.now() + 10_000;
      changes(id).filter(([type]) => type === "task.ready").length < 2 &&
      Date.now() < deadline;
    ) {
      const page = await ctx.board.poll({
        channel: ctx.channel,
        label,
        after: cursor,
        wait: 2,
      });
      seen.push(...(page.events as unknown as SeenEvent[]));
      cursor = page.cursor;
    }
    const wanted = [
      ["task.created", "waiting"],
      ["task.ready", "ready"],
      ["task.claimed", "claimed"],
      ["task.blocked", "blocked"],
      ["task.unblocked", "waiting"],
      ["task.ready", "ready"],
    ];
    const wantedAlone = [
      ["task.created", "ready"],
      ["task.blocked", "blocked"],
      ["task.unblocked", "ready"],
    ];
    const got = changes(id);
    const gotAlone = changes(alone.id);
    if (!sameJson(got, wanted) || !sameJson(gotAlone, wantedAlone)) {
      return {
        name,
        ok: false,
        detail: `changes(id)=${JSON.stringify(got)} changes(alone)=${JSON.stringify(gotAlone)}`,
      };
    }
    return { name, ok: true, detail: "" };
  } catch (error) {
    return { name, ok: false, detail: String(error) };
  }
}

/**
 * Check 2: "changes what a task needs: it waits for the new ones, is ready
 * once they have completed, and at once with none" (the needs_changed feed).
 */
async function checkChangesOfNeeds(ctx: Ctx): Promise<CheckResult> {
  const name = "changes-of-task (needs_changed)";
  const same = sameJson;
  try {
    const { task: done } = await task(
      ctx,
      "repro: a prerequisite that has completed",
    );
    await (await ctx.board.tasks.claim(done.id, { lease: 60 })).complete();
    const { task: open } = await task(
      ctx,
      "repro: a prerequisite that has not",
    );
    const { task: root } = await task(ctx, "repro: a task whose needs change");
    const label = [`conformance=${ctx.labels.conformance}`];
    const anchor = await ctx.board.poll({ channel: ctx.channel, label });
    let cursor = anchor.cursor;
    await ctx.board.tasks.needs(root.id, [open.id]);
    await ctx.board.tasks.needs(root.id, [done.id]);
    await ctx.board.tasks.needs(root.id, [done.id, done.id]);
    await ctx.board.tasks.needs(root.id, [open.id]);
    await ctx.board.tasks.needs(root.id, []);
    await ctx.board.tasks.block(root.id, "repro: approve?");
    await ctx.board.tasks.needs(root.id, [done.id]);
    await ctx.board.tasks.unblock(root.id);
    const seen: SeenEvent[] = [];
    const changes = () =>
      seen
        .filter(
          (event) =>
            event.type.startsWith("task.") && event.message?.id === root.id,
        )
        .map((event) => [event.type, event.message?.task?.state]);
    for (
      const deadline = Date.now() + 10_000;
      changes().filter(([type]) => type === "task.ready").length < 2 &&
      Date.now() < deadline;
    ) {
      const page = await ctx.board.poll({
        channel: ctx.channel,
        label,
        after: cursor,
        wait: 2,
      });
      seen.push(...(page.events as unknown as SeenEvent[]));
      cursor = page.cursor;
    }
    const wanted = [
      ["task.needs_changed", "waiting"],
      ["task.needs_changed", "waiting"],
      ["task.ready", "ready"],
      ["task.needs_changed", "waiting"],
      ["task.needs_changed", "ready"],
      ["task.blocked", "blocked"],
      ["task.needs_changed", "blocked"],
      ["task.unblocked", "waiting"],
      ["task.ready", "ready"],
    ];
    const got = changes();
    if (!same(got, wanted)) {
      return { name, ok: false, detail: `changes()=${JSON.stringify(got)}` };
    }
    return { name, ok: true, detail: "" };
  } catch (error) {
    return { name, ok: false, detail: String(error) };
  }
}

/**
 * Check 3: "shows a feed that filters on board.task=ready a task becoming
 * ready and being claimed, and never a token".
 */
async function checkFilteredFeed(ctx: Ctx): Promise<CheckResult> {
  const name = "filtered feed (board.task=ready)";
  try {
    const { task: first } = await task(ctx, "repro: a prerequisite to watch");
    const { task: second } = await task(
      ctx,
      "repro: a task to watch become ready",
      {
        needs: [first.id],
      },
    );
    const label = [`conformance=${ctx.labels.conformance}`, "board.task=ready"];
    const anchor = await ctx.board.poll({ channel: ctx.channel, label });
    let cursor = anchor.cursor;
    const seen: SeenEvent[] = [];
    const until = async (found: () => boolean, what: string): Promise<void> => {
      for (const deadline = Date.now() + 10_000; !found();) {
        if (Date.now() >= deadline)
          throw new Mismatch(`${what}, within a few seconds`);
        const page = await ctx.board.poll({
          channel: ctx.channel,
          label,
          after: cursor,
          wait: 2,
        });
        seen.push(...(page.events as unknown as SeenEvent[]));
        cursor = page.cursor;
      }
    };
    await (await ctx.board.tasks.claim(first.id, { lease: 60 })).complete();
    await until(
      () =>
        seen.some(
          (event) =>
            event.type === "task.ready" && event.message?.id === second.id,
        ),
      "the feed should show the task become ready",
    );
    const claim = await ctx.board.tasks.claim(second.id, { lease: 60 });
    await until(
      () =>
        seen.some(
          (event) =>
            event.type === "task.claimed" && event.message?.id === second.id,
        ),
      "the feed should show the task being claimed",
    );
    const claimed = seen.find(
      (event) =>
        event.type === "task.claimed" && event.message?.id === second.id,
    );
    if (claimed?.message?.task?.state !== "claimed") {
      return { name, ok: false, detail: "the task in its claim's event" };
    }
    await claim.release();
    return { name, ok: true, detail: "" };
  } catch (error) {
    return { name, ok: false, detail: String(error) };
  }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const fixture = await createBdFixture();
  const backend = beads({ dir: fixture.dir });
  const app = board({ backend });
  const ctx: Ctx = {
    board: app,
    channel: "repro",
    labels: { conformance: Math.random().toString(16).slice(2, 10) },
  };
  const checks = [
    checkReadyOnMakeAndUnblock,
    checkChangesOfNeeds,
    checkFilteredFeed,
  ];
  const failures: string[] = [];
  console.log(
    `repro-feed-load: churn=${CHURN} burners=${BURNERS} rounds=${ROUNDS} bd=${fixture.version.major}.${fixture.version.minor}.${fixture.version.patch}`,
  );
  try {
    for (let round = 1; round <= ROUNDS; round += 1) {
      startLoad();
      try {
        for (const check of checks) {
          const result = await check(ctx);
          const tag = `${round}/${result.name}`;
          if (result.ok) console.log(`  PASS ${tag}`);
          else {
            console.log(`  FAIL ${tag}: ${result.detail}`);
            failures.push(`${tag}: ${result.detail}`);
          }
        }
      } finally {
        stopLoad();
      }
      // A breath between rounds, as the suite's own checks are spaced by the
      // writes between them.
      await wait(500);
    }
  } finally {
    stopLoad();
    if (KEEP) {
      console.log(`  fixture kept: ${fixture.dir}`);
    } else {
      fixture.close();
    }
  }
  if (failures.length > 0) {
    console.log(`repro-feed-load: ${failures.length} failing check run(s)`);
    process.exitCode = 1;
  } else {
    console.log("repro-feed-load: all checks passed under load");
  }
};

/**
 * `--suite`: the real conformance is the workload. The suite runs against
 * its own fresh fixture as a subprocess while the load generator churns;
 * the rig reports its summary and answers its exit.
 */
const SUITE = args.includes("--suite");
const suiteOut = (round: number): string =>
  `/tmp/opencode/conformance-under-load-${round}.json`;

async function runSuiteRound(round: number): Promise<boolean> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/conformance.ts",
      "--backend",
      "beads",
      "--json",
      `out=${suiteOut(round)}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  const summary = [
    ...stdout.matchAll(/(\w+)\s+\d+ checks: (\d+) passed, (\d+) failed/g),
  ].map(([, group, passed, failed]) => `${group}:${passed}/${failed}`);
  console.log(`  suite round ${round}: exit=${exit} (${summary.join(" ")})`);
  return exit === 0;
}

async function mainSuite(): Promise<void> {
  const failures: string[] = [];
  console.log(
    `repro-feed-load(suite): churn=${CHURN} burners=${BURNERS} rounds=${ROUNDS}`,
  );
  for (let round = 1; round <= ROUNDS; round += 1) {
    startLoad();
    let ok: boolean;
    try {
      ok = await runSuiteRound(round);
    } finally {
      stopLoad();
    }
    if (ok) console.log(`  PASS suite round ${round}`);
    else {
      console.log(`  FAIL suite round ${round}`);
      failures.push(`suite round ${round}`);
    }
  }
  if (failures.length > 0) {
    console.log(`repro-feed-load(suite): ${failures.length} failing round(s)`);
    process.exitCode = 1;
  } else {
    console.log("repro-feed-load(suite): conformance green under load");
  }
}

void (args.includes("--suite") ? mainSuite() : main());
