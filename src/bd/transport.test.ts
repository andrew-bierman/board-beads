import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBdFixture,
  type BdFixture,
  type BdRun,
} from "../../test/helpers/bd-fixture.ts";
import {
  BdClaimRaceError,
  BdCorruptOutputError,
  BdCrashError,
  BdFrozenError,
  BdLostGuardError,
  BdLostRaceError,
  BdNotHolderError,
  BdTransportError,
} from "./errors.ts";
import { BdTransport, truncationFromGap } from "./transport.ts";

/** Collect a rejection instead of crashing the test on expected failures. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

async function listTitles(fixture: BdFixture): Promise<string[]> {
  const listed: BdRun = await fixture.run(["list", "--json"]);
  expect(listed.code).toBe(0);
  const parsed: unknown = JSON.parse(listed.stdout);
  const rows = Array.isArray(parsed) ? parsed : [];
  return rows.map((row) => {
    const record = row as { title?: unknown };
    return typeof record.title === "string" ? record.title : "";
  });
}

describe("bd transport (real bd)", () => {
  let fixture: BdFixture;
  let alice: BdTransport;
  let bob: BdTransport;

  afterAll(() => {
    fixture?.close();
  });

  test("boots the fixture and probes the live version", async () => {
    fixture = await createBdFixture();
    alice = new BdTransport({ dir: fixture.dir, actor: "alice" });
    bob = new BdTransport({ dir: fixture.dir, actor: "bob" });
    const version = await alice.version();
    expect(version.major).toBe(fixture.version.major);
    expect(version.minor).toBe(fixture.version.minor);
    expect(version.patch).toBe(fixture.version.patch);
    expect(version.major).toBe(1);
    expect(version.minor).toBe(3);
    expect(version.patch).toBeGreaterThanOrEqual(4);
  }, 60_000);

  test("create/show/claim/comment/close round-trip with the envelope unwrapped", async () => {
    const created = await alice.create({
      title: "round trip",
      type: "task",
      priority: 1,
      description: "first body",
    });
    expect(created.id).not.toBe("");
    expect(created.title).toBe("round trip");
    expect(created.status).toBe("open");
    expect(created.priority).toBe(1);

    // A second actor reads the same issue; the envelope is unwrapped so the
    // decoded result is the issue itself, not bd's {"data": ...} wrapper.
    const shown = await bob.show(created.id);
    expect(shown.title).toBe("round trip");
    const rawRun = await bob.run(["show", created.id, "--json"]);
    expect(rawRun.raw).toContain("schema_version");
    expect(Array.isArray(rawRun.data)).toBeTrue();

    const claimed = await alice.claim(created.id);
    expect(claimed.status).toBe("in_progress");
    expect(claimed.assignee).toBe("alice");

    const commented = await bob.comment(created.id, "note from bob");
    expect(commented.issueId).toBe(created.id);
    expect(commented.text).toBe("note from bob");

    const closed = await alice.close(created.id, "wrapped up");
    expect(closed.status).toBe("closed");
  }, 30_000);

  test("two actors claim one issue concurrently: exactly one wins, the loser sees a claim race", async () => {
    const created = await alice.create({ title: "contested" });
    const settled = await Promise.allSettled([
      alice.claim(created.id),
      bob.claim(created.id),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const lost = settled.filter((s) => s.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const error = lost[0]?.reason;
    expect(error).toBeInstanceOf(BdClaimRaceError);
    expect(error).toBeInstanceOf(BdLostRaceError);
    expect((error as BdClaimRaceError).exitCode).toBe(1);
  }, 30_000);

  test("a guarded compare-and-set whose guard fails exits 13 as a lost guard", async () => {
    const created = await alice.create({ title: "guarded" });
    await alice.claim(created.id);
    // The guarded claim: an atomic compare-and-set on the assignee. Bob's
    // guard no longer holds because alice claimed first.
    const error = await rejectionOf(
      bob.update(created.id, { ifAssignee: "bob", status: "in_progress" }),
    );
    expect(error).toBeInstanceOf(BdLostGuardError);
    expect(error).toBeInstanceOf(BdLostRaceError);
    expect((error as BdLostGuardError).exitCode).toBe(13);

    // The holder's own guard still holds.
    const ok = await alice.update(created.id, {
      ifAssignee: "alice",
      status: "open",
    });
    expect(ok.status).toBe("open");
  }, 30_000);

  test("heartbeat loss is message-only (plain exit 1) and classifies as not-holder", async () => {
    const created = await alice.create({ title: "lease" });
    await alice.claim(created.id);
    const error = await rejectionOf(bob.heartbeat(created.id));
    expect(error).toBeInstanceOf(BdNotHolderError);
    expect((error as BdNotHolderError).exitCode).toBe(1);
    await alice.heartbeat(created.id); // the holder's heartbeat succeeds
  }, 30_000);

  test("a frozen workspace exits 14 as retry-later, and unfreezes cleanly", async () => {
    const marker = join(fixture.dir, ".beads", "MIGRATION-FREEZE");
    writeFileSync(marker, "freeze for test\n");
    try {
      const error = await rejectionOf(alice.create({ title: "frozen" }));
      expect(error).toBeInstanceOf(BdFrozenError);
      expect((error as BdFrozenError).exitCode).toBe(14);
      // Retry-later is a typed, retryable outcome; the backoff cadence is
      // the caller's decision.
      expect((error as BdFrozenError).retryable).toBeTrue();
    } finally {
      rmSync(marker);
    }
    const thawed = await alice.create({ title: "thawed" });
    expect(thawed.status).toBe("open");
  }, 30_000);

  test("arguments travel as argv: shell metacharacters in titles and reasons stay literal", async () => {
    const nasty = `'; rm -rf /$(echo pwned) | cat "quoted" \\ back`;
    const created = await alice.create({ title: nasty });
    const shown = await alice.show(created.id);
    expect(shown.title).toBe(nasty);
    await alice.batch([{ op: "close", id: created.id, reason: nasty }]);
    const closed = await alice.show(created.id);
    expect(closed.status).toBe("closed");
  }, 30_000);

  test("batch applies create+update+dep lines atomically", async () => {
    const parent = await alice.create({ title: "batch parent" });
    const child = await alice.create({ title: "batch child" });
    const result = await alice.batch([
      { op: "create", type: "task", priority: 3, title: "batch kid" },
      { op: "update", id: child.id, fields: { priority: 1 } },
      { op: "dep-add", from: child.id, to: parent.id },
    ]);
    expect(result.operations).toBe(3);
    expect(result.results[0]?.op).toBe("create");
    const kidId = result.results[0]?.target ?? "";
    expect(kidId).not.toBe("");
    const kid = await alice.show(kidId);
    expect(kid.title).toBe("batch kid");
    const shownChild = await alice.show(child.id);
    expect(shownChild.priority).toBe(1);
    expect(shownChild.dependencyCount).toBe(1);
  }, 30_000);

  test("a bad batch line rolls the whole batch back", async () => {
    const parent = await alice.create({ title: "rollback parent" });
    const child = await alice.create({ title: "rollback child" });
    await alice.batch([{ op: "dep-add", from: child.id, to: parent.id }]);
    const error = await rejectionOf(
      alice.batch([
        { op: "create", type: "task", priority: 2, title: "rollback canary" },
        { op: "dep-add", from: "no-such-issue-id", to: parent.id },
      ]),
    );
    expect(error).toBeInstanceOf(BdTransportError);
    const titles = await listTitles(fixture);
    expect(titles).not.toContain("rollback canary");
    // The earlier dep add survived: only the failed batch was rolled back.
    const shownChild = await alice.show(child.id);
    expect(shownChild.dependencyCount).toBe(1);
    // The batch temp file is gone even though the batch failed.
    const leftovers = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("board-beads-batch-"),
    );
    expect(leftovers).toEqual([]);
  }, 30_000);

  test("corrupt and absent bd output become typed errors, never crashes", async () => {
    // Deterministic stand-in binaries (shell scripts in a temp dir): one whose
    // "output" is unparseable as bd output (the bd version drift guard), one
    // that exits nonzero with no output. Real processes, no mocks.
    const binDir = mkdtempSync(join(tmpdir(), "bb-fake-bins-"));
    const garbageBin = join(binDir, "garbage-bd");
    const failingBin = join(binDir, "failing-bd");
    await Bun.write(garbageBin, "#!/bin/sh\necho not-bd-output-at-all\n");
    await Bun.write(failingBin, "#!/bin/sh\nexit 1\n");
    chmodSync(garbageBin, 0o700);
    chmodSync(failingBin, 0o700);

    const echo = new BdTransport({
      dir: tmpdir(),
      actor: "x",
      bin: garbageBin,
    });
    const versionError = await rejectionOf(echo.version());
    expect(versionError).toBeInstanceOf(BdCorruptOutputError);
    const createError = await rejectionOf(
      echo.create({ title: "never happens" }),
    );
    expect(createError).toBeInstanceOf(BdCorruptOutputError);

    // A real process that exits nonzero with no output.
    const fail = new BdTransport({
      dir: tmpdir(),
      actor: "x",
      bin: failingBin,
    });
    expect(await rejectionOf(fail.version())).toBeInstanceOf(BdTransportError);

    // A binary that does not exist at all.
    const missing = new BdTransport({
      dir: tmpdir(),
      actor: "x",
      bin: "board-beads-no-such-bd",
    });
    expect(await rejectionOf(missing.version())).toBeInstanceOf(
      BdTransportError,
    );
  }, 30_000);

  test("a subprocess killed by a signal classifies as a crash", async () => {
    // A real process that dies by SIGKILL: the classifier must distinguish
    // signal death from both exits and our own timeout bound.
    const crash = new BdTransport({ dir: tmpdir(), actor: "x", bin: "bun" });
    const error = await rejectionOf(
      crash.run(["-e", `process.kill(process.pid, "SIGKILL")`]),
    );
    expect(error).toBeInstanceOf(BdCrashError);
    const crashed = error as BdCrashError;
    expect(crashed.exitCode).toBeNull();
    expect(crashed.signal).toBe("SIGKILL");
  }, 30_000);

  test("a per-call timeout surfaces as a typed transport error and leaves the tracker healthy", async () => {
    const slow = new BdTransport({
      dir: fixture.dir,
      actor: "slow",
      timeoutMs: 1,
    });
    const error = await rejectionOf(slow.version());
    expect(error).toBeInstanceOf(BdTransportError);
    const timeout = error as BdTransportError;
    expect(timeout.exitCode).toBeNull();
    expect(timeout.message).toMatch(/timed out/);
    const created = await alice.create({ title: "after timeout" });
    const healthy = await alice.show(created.id);
    expect(healthy.title).toBe("after timeout");
  }, 30_000);

  test("a newline in a batch token refuses up front instead of corrupting the batch", async () => {
    // bd's batch grammar is line-oriented: a token carrying a newline would
    // split its line, and bd would answer by rolling the whole transaction
    // back with an opaque parse error. The renderer refuses before bd runs.
    const newline = await rejectionOf(
      alice.batch([
        { op: "update", id: "x", fields: { title: "line1\nline2" } },
      ]),
    );
    expect(newline).toBeInstanceOf(TypeError);
    expect((newline as TypeError).message).toContain("line-oriented");
    // bd splits on \n only: other control characters travel byte-exact
    // inside quotes (verified against bd 1.3.4), so a carriage return and a
    // tab must round-trip through the same batch path rather than be refused.
    const seeded = await alice.create({
      title: "batch token seed",
      type: "task",
      priority: 2,
    });
    const applied = await alice.batch([
      { op: "update", id: seeded.id, fields: { title: "has\ttab" } },
    ]);
    expect(applied.operations).toBe(1);
    expect((await alice.show(seeded.id)).title).toBe("has\ttab");
    const carriage = await alice.batch([
      {
        op: "update",
        id: seeded.id,
        fields: { title: "carriage\rreturn" },
      },
    ]);
    expect(carriage.operations).toBe(1);
    expect((await alice.show(seeded.id)).title).toBe("carriage\rreturn");
  }, 60_000);
});

describe("bd events journal (real bd)", () => {
  let fixture: BdFixture;
  let journaled: BdTransport;
  let quiet: BdTransport;

  afterAll(() => {
    fixture?.close();
  });

  test("boot the journal fixture", async () => {
    fixture = await createBdFixture();
    journaled = new BdTransport({
      dir: fixture.dir,
      actor: "journaled",
      journal: true,
    });
    quiet = new BdTransport({ dir: fixture.dir, actor: "quiet" });
  }, 60_000);

  test("a never-enabled journal reads as a distinct disabled result", async () => {
    // A write without the journal env, then a read with the env: bd returns
    // an empty tail, and config confirms the journal is off.
    await quiet.create({ title: "quiet canary" });
    const page = await journaled.tailEvents("0");
    expect(page.kind).toBe("disabled");
  }, 30_000);

  test("one journaled create yields one event at the expected seq; cursors are opaque strings", async () => {
    const enabled = await fixture.run([
      "config",
      "set",
      "events-journal",
      "true",
    ]);
    expect(enabled.code).toBe(0);

    const created = await journaled.create({ title: "journal canary" });
    const page = await journaled.tailEvents("0");
    expect(page.kind).toBe("records");
    if (page.kind !== "records") return;
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event?.seq).toBe(1);
    expect(event?.op).toBe("create");
    expect(event?.issueId).toBe(created.id);
    expect(event?.actor).toBe("journaled");
    expect(event?.issue).toBeDefined();
    expect(event?.ts).not.toBe("");
    expect(page.cursor).toBe("1");

    // A second write (a claim) yields the next seq for the same actor.
    await journaled.claim(created.id);
    const next = await journaled.tailEvents(page.cursor);
    expect(next.kind).toBe("records");
    if (next.kind !== "records") return;
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.seq).toBe(2);
    expect(next.events[0]?.op).toBe("update");
    expect(next.events[0]?.issueId).toBe(created.id);
    expect(next.cursor).toBe("2");
  }, 30_000);

  test("reading from the head of an enabled journal is a normal empty page", async () => {
    const page = await journaled.tailEvents("2");
    expect(page.kind).toBe("records");
    if (page.kind !== "records") return;
    expect(page.events).toHaveLength(0);
    expect(page.cursor).toBe("2");
  }, 30_000);

  test("a checkpoint below the retained floor reports truncation with floor and head", async () => {
    const days = await fixture.run([
      "config",
      "set",
      "events-journal-retain-days",
      "0",
    ]);
    const rows = await fixture.run([
      "config",
      "set",
      "events-journal-retain-rows",
      "0",
    ]);
    const autoPrune = await fixture.run([
      "config",
      "set",
      "events-journal-auto-prune",
      "false",
    ]);
    expect(days.code).toBe(0);
    expect(rows.code).toBe(0);
    expect(autoPrune.code).toBe(0);
    const pruned = await fixture.run(["events", "prune", "--before", "2"]);
    expect(pruned.code).toBe(0);
    const page = await journaled.tailEvents("0");
    expect(page.kind).toBe("truncated");
    if (page.kind !== "truncated") return;
    expect(page.floor).toBe(2);
    expect(page.head).toBe(2);
  }, 30_000);

  test("the gapless-sequence contract flags a hole below the window", () => {
    const hole = truncationFromGap(5, [{ seq: 7 }, { seq: 8 }]);
    expect(hole).toEqual({ floor: 6, head: 8 });
    const contiguous = truncationFromGap(5, [{ seq: 6 }, { seq: 7 }]);
    expect(contiguous).toBeNull();
    const empty = truncationFromGap(5, []);
    expect(empty).toBeNull();
  });
});

describe("bd transport tracker isolation (real bd)", () => {
  let bound: BdFixture | undefined;
  let ambient: BdFixture | undefined;
  let savedBeadsDir: string | undefined;

  afterAll(() => {
    if (savedBeadsDir === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = savedBeadsDir;
    bound?.close();
    ambient?.close();
  });

  test("an ambient BEADS_DIR cannot redirect a write to another tracker", async () => {
    bound = await createBdFixture();
    ambient = await createBdFixture();
    savedBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = `${ambient.dir}/.beads`;

    const transport = new BdTransport({
      dir: bound.dir,
      actor: "isolation",
    });
    const created = await transport.create({
      title: "stays-in-bound-tracker",
      type: "task",
      priority: 2,
    });
    expect(created.id).not.toBe("");
    expect(await listTitles(bound)).toContain("stays-in-bound-tracker");
    expect(await listTitles(ambient)).not.toContain("stays-in-bound-tracker");
  }, 60_000);
});
