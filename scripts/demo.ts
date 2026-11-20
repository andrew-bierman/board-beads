/**
 * The S2 demo (docs/plans/2026-11-19-1356-feat-board-beads-backend-plan.md, "S2"):
 * the product story, end to end, on a real disposable beads tracker. No mocks —
 * the fixture boots an actual `bd` CLI over its own Dolt-backed tracker in an
 * isolated HOME (test/helpers/bd-fixture.ts).
 *
 * The story:
 *   a dispatcher files two tasks on one tracker; agents A and B race to claim
 *   through the tasks surface — the claim fence lands each a different task,
 *   never one task twice; A posts a progress reply, then its completion reply,
 *   and settles the task with a result (nothing external is opened — every
 *   write lands in the tracker); agent C, which registered a watcher on the
 *   channel beforehand, has its match land leased when the completion reply
 *   posts, and it acks.
 *
 * How it runs:
 *   1. boots the fixture, mounts `board({ backend: beads({ dir }) })`, serves
 *      the handle in-process with Bun.serve on 127.0.0.1 — the way `vb serve`
 *      serves a board — and points `vb`'s BOARD_URL at it, so the agents drive
 *      the board through the real CLI exactly as they would a served board;
 *   2. walks the story step by step, printing each as it happens;
 *   3. prints a summary table (who claimed what, events seen, watcher wake
 *      latency) and exits 0 only when every step held.
 *
 * One mount note: a served board must say who each request's caller is —
 * `board()` answers 401 without an `authenticate` verifier. The demo vouches
 * for a single local principal (the socket is 127.0.0.1 and no token rides);
 * the agents are its profiles (`--as` / BOARD_PROFILE), which is how Board
 * scopes a person's agents.
 *
 * Readiness: the tasks surface (create/claim/complete — the plan's U6 unit)
 * and the watchers surface (register/matches/ack — U7) land with their units.
 * Until they merge, those routes answer 501 (`no_tasks`, `not_supported`);
 * this script prints the readiness line naming what isn't here yet and exits
 * nonzero cleanly. Everything before them — the fixture, the mount, serving,
 * discovery, the event feed, identity over the wire, the threads surface the
 * replies ride — is proven on every run.
 *
 * Run: bun run scripts/demo.ts
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { board, HttpError, type CallerRequest } from "@vercel/board";
import { beads } from "../src/index.ts";
import { createBdFixture, type BdFixture } from "../test/helpers/bd-fixture.ts";

// --- the story's stage ----------------------------------------------------------------------

/** The channel the whole story runs in. */
const CHANNEL = "garden";

/** The one principal the demo's verifier vouches for; the agents are its profiles. */
const PRINCIPAL_ID = "local:demo:operator";

/** The agents, as the story names them: two workers and a watcher. */
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const AGENT_C = "agent-c";

/** The `vb` entry the demo drives — the same CLI a person runs. */
const VB_BIN = fileURLToPath(
  new URL("../node_modules/.bin/vb", import.meta.url),
);

/** How long one `vb` call may take before the demo calls it lost. */
const VB_TIMEOUT_MS = 120_000;

/** How long the watcher pull may chase the completion reply before the demo calls it missed. */
const WATCH_BUDGET_MS = 90_000;

/** One long-poll of the watcher's matches, in seconds (the route holds at most 25). */
const MATCH_WAIT_S = 10;

/** What an in-flight tasks surface says, and when it lands. */
const TASKS_GATE_LINE =
  "tasks land in U6 — rerun after merge (the tasks surface: create, claim, complete, list)";

/** What an in-flight watchers surface says, and when it lands. */
const WATCHERS_GATE_LINE =
  "watchers land in U7 — rerun after merge (register, matches, ack)";

/** The claim long-poll one racing agent may hold, in CLI duration words. */
const CLAIM_WAIT = "45s";

// --- failures and readiness -----------------------------------------------------------------

/** A readiness gate: a surface the plan reserves for a unit that hasn't landed. */
class Gate extends Error {
  constructor(readonly line: string) {
    super(line);
  }
}

/** A step that didn't hold — a real failure, not a readiness gate. */
class Failure extends Error {}

// --- small honest helpers -------------------------------------------------------------------

/** Print a step header, so the story reads as it happens. */
let stepNo = 0;
const step = (title: string): void => {
  stepNo += 1;
  console.log(`\n── step ${stepNo} · ${title}`);
};

/** Print a step detail line. */
const say = (line: string): void => {
  console.log(`   ${line}`);
};

/** One finished `vb` call: what it answered and how it left. */
interface VbRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `vb` as one agent: its own HOME and config (its own claims store), the board's URL. */
const runVb = (
  args: readonly string[],
  home: string,
  profile: string | null,
  boardUrl: string,
): Promise<VbRun> =>
  new Promise<VbRun>((resolve, reject) => {
    // Only a clean environment goes out: no operator tokens, no operator board config.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      BOARD_URL: boardUrl,
      NO_COLOR: "1",
      TERM: "dumb",
      ...(profile === null ? {} : { BOARD_PROFILE: profile }),
    };
    const child = spawn(VB_BIN, [...args], { cwd: home, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const watchdog = setTimeout(() => child.kill("SIGTERM"), VB_TIMEOUT_MS);
    child.on("error", (error: Error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(watchdog);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Parse the one JSON object a `vb --json` call prints, tolerating any lines around it. */
const parseJson = (text: string, what: string): Record<string, unknown> => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Failure(
      `${what}: no JSON object in its answer: ${text.slice(0, 200).trim() || "(empty)"}`,
    );
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Failure(
      `${what}: expected a JSON object, got: ${text.slice(0, 200).trim()}`,
    );
  }
  return parsed as Record<string, unknown>;
};

/** Parse what a surface answered, or say it said nothing parseable. */
const parseJsonSafely = (text: string): Record<string, unknown> => {
  try {
    return parseJson(text, "answer");
  } catch {
    return { raw: text.slice(0, 200) };
  }
};

/** Narrow an unknown to a record, with a name for the failure line. */
const objOf = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Failure(
      `${what}: expected an object, got ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  }
  return value as Record<string, unknown>;
};

/** Narrow an unknown to a non-empty string, with a name for the failure line. */
const strOf = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Failure(
      `${what}: expected a non-empty string, got ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  }
  return value;
};

/** Narrow an unknown to an array, with a name for the failure line. */
const listOf = (value: unknown, what: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Failure(
      `${what}: expected an array, got ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  }
  return value;
};

/** The error code a board answer carries, when it carries one (`{error: {code}}`). */
const errorCodeOf = (body: Record<string, unknown>): string | null => {
  const error = body.error;
  if (typeof error !== "object" || error === null) return null;
  const code = objOf(error, "error").code;
  return typeof code === "string" ? code : null;
};

/** The readiness gate a 501 answer names, by its code. */
const gateOfAnswer = (
  status: number,
  body: Record<string, unknown>,
): Gate | null => {
  if (status !== 501) return null;
  const code = errorCodeOf(body);
  if (code === "no_tasks") return new Gate(TASKS_GATE_LINE);
  if (code === "not_supported" || code === "no_registration")
    return new Gate(WATCHERS_GATE_LINE);
  return new Gate(
    `this surface answers 501 ${code ?? "without a code"} — not landed yet`,
  );
};

/** The readiness gate a failed `vb` call's own words name (the CLI prints the board's refusal). */
const gateOfRun = (run: VbRun): Gate | null => {
  if (run.code === 0) return null;
  const said = `${run.stdout}\n${run.stderr}`;
  if (/no_tasks|keeps no tasks/.test(said)) return new Gate(TASKS_GATE_LINE);
  if (/not_supported|doesn't keep that here|no_registration/.test(said))
    return new Gate(WATCHERS_GATE_LINE);
  return null;
};

/** Run `vb` and turn a readiness refusal into its Gate, keeping other failures loud. */
const expectVb = async (
  args: readonly string[],
  home: string,
  profile: string | null,
  boardUrl: string,
  what: string,
): Promise<Record<string, unknown>> => {
  const run = await runVb(args, home, profile, boardUrl);
  const gate = gateOfRun(run);
  if (gate !== null) throw gate;
  if (run.code !== 0) {
    throw new Failure(
      `${what} failed (exit ${run.code}):\n     stdout: ${run.stdout.trim().slice(0, 400) || "(empty)"}\n     stderr: ${run.stderr.trim().slice(0, 400) || "(empty)"}`,
    );
  }
  return parseJson(run.stdout, what);
};

/** The URL a serving Bun instance answers on. */
const boardUrlOf = (server: ReturnType<typeof Bun.serve>): string =>
  `http://127.0.0.1:${server.port}`;

// --- the mount ------------------------------------------------------------------------------

/**
 * A served board must say who each request's caller is. The demo vouches for
 * one local principal — the socket is 127.0.0.1 and no token rides — and the
 * agents are that principal's profiles (`--as`), which is how Board scopes a
 * person's agents. A credential is refused: none is expected here.
 */
const authenticate = (
  request: CallerRequest,
): { id: string; kind: "person"; handle: string } => {
  if (request.credential !== null) {
    throw new HttpError(
      401,
      "unauthorized",
      "the demo board takes no tokens: it serves 127.0.0.1 and vouches for whoever arrives",
    );
  }
  return { id: PRINCIPAL_ID, kind: "person", handle: "demo" };
};

// --- the story ------------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "board-beads-demo-"));
  /** Each agent's own HOME: its own claims store, its own board config. */
  const agentHome = (name: string): string => {
    const home = join(root, name);
    mkdirSync(join(home, ".config"), { recursive: true });
    return home;
  };
  let fixture: BdFixture | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  const wire = new AbortController();
  const gates: Gate[] = [];
  let crash: unknown = null;

  /** What the watcher saw, for the summary. */
  const wakes = { seen: 0, acked: 0, latencyMs: null as number | null };
  /** Set as agent A's completion reply goes out; the watcher pull is chasing it. */
  const wake = {
    replyId: null as string | null,
    postedAtMs: null as number | null,
  };
  /** The summary's story lines, filled as steps hold: a label and what held. */
  const held: [string, string][] = [];

  try {
    // --- the fixture: a real tracker --------------------------------------------------------
    step(
      "boot a real disposable beads tracker (bd init, isolated HOME — no mocks)",
    );
    fixture = await createBdFixture();
    const v = fixture.version;
    say(`bd ${v.major}.${v.minor}.${v.patch} ready in ${fixture.dir}`);
    held.push([
      "fixture",
      `real bd ${v.major}.${v.minor}.${v.patch} tracker booted (no mocks)`,
    ]);

    // --- the mount: beads() under board(), served in-process --------------------------------
    step(
      "mount board({ backend: beads({ dir }) }) and serve the handle on 127.0.0.1",
    );
    const team = board({ backend: beads({ dir: fixture.dir }), authenticate });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255, // long-polls outlive the runtime's short default
      fetch: (request: Request) => team.fetch(request),
    });
    const boardUrl = boardUrlOf(server);
    const discovery = await fetch(`${boardUrl}/`);
    if (!discovery.ok)
      throw new Failure(`discovery answered ${discovery.status}`);
    const found = parseJson(await discovery.text(), "discovery");
    const feed = await fetch(`${boardUrl}/events?after=0&wait=0`, {
      headers: { "x-board-profile": AGENT_C },
      signal: wire.signal,
    });
    if (!feed.ok) throw new Failure(`the event feed answered ${feed.status}`);
    say(
      `serving ${strOf(found.version, "discovery.version")} at ${boardUrl}; the event feed answers`,
    );
    held.push(["mount", `beads({ dir }) under board(), served at ${boardUrl}`]);

    /** A board call as one of the agents, over the wire the CLI uses. */
    const callBoard = async (
      method: string,
      path: string,
      profile: string,
      body?: unknown,
    ): Promise<{
      status: number;
      ok: boolean;
      body: Record<string, unknown>;
    }> => {
      const response = await fetch(`${boardUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-board-profile": profile,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: wire.signal,
      });
      const text = await response.text();
      const parsed = parseJsonSafely(text);
      if (response.ok && parsed.raw !== undefined) {
        throw new Failure(
          `${method} ${path}: answered ${response.status} with unparseable body: ${String(parsed.raw)}`,
        );
      }
      return { status: response.status, ok: response.ok, body: parsed };
    };

    // --- identity: the CLI meets the board --------------------------------------------------
    step(
      "the agents introduce themselves to the board (vb whoami over the wire)",
    );
    const who = async (
      home: string,
      profile: string | null,
    ): Promise<Record<string, unknown>> =>
      expectVb(
        ["whoami", "--json"],
        home,
        profile,
        boardUrl,
        `vb whoami as ${profile ?? "the dispatcher"}`,
      );
    const dispatcherHome = agentHome("dispatcher");
    const dispatcher = await who(dispatcherHome, null);
    const principal = strOf(dispatcher.principal, "whoami.principal");
    if (principal !== PRINCIPAL_ID) {
      throw new Failure(
        `the board verified ${principal} where the demo vouched for ${PRINCIPAL_ID}`,
      );
    }
    const agentAHome = agentHome(AGENT_A);
    const meA = await who(agentAHome, AGENT_A);
    say(
      `dispatcher is ${principal}; agent ${AGENT_A} is ${strOf(meA.actor, "whoami.actor")}`,
    );
    held.push([
      "identity",
      `vb verified over the wire: ${principal}, agents as its profiles`,
    ]);

    const homeOf: Record<string, string> = {
      [AGENT_A]: agentAHome,
      [AGENT_B]: agentHome(AGENT_B),
      [AGENT_C]: agentHome(AGENT_C),
    };

    // --- the channel and the tasks: the dispatcher files two --------------------------------
    step(`the dispatcher opens ${CHANNEL} and files two tasks`);
    await expectVb(
      ["channels", "create", CHANNEL, "--json"],
      dispatcherHome,
      null,
      boardUrl,
      `vb channels create ${CHANNEL}`,
    );
    const made1 = await expectVb(
      [
        "tasks",
        "create",
        CHANNEL,
        "pick the ripe tomatoes before the rain",
        "--label",
        "step=harvest",
        "--json",
      ],
      dispatcherHome,
      null,
      boardUrl,
      "vb tasks create (first)",
    );
    const made2 = await expectVb(
      [
        "tasks",
        "create",
        CHANNEL,
        "turn the compost heap",
        "--label",
        "step=compost",
        "--json",
      ],
      dispatcherHome,
      null,
      boardUrl,
      "vb tasks create (second)",
    );
    const id1 = strOf(objOf(made1.task, "task 1").id, "task 1 id");
    const id2 = strOf(objOf(made2.task, "task 2").id, "task 2 id");
    say(
      `#${id1} "pick the ripe tomatoes before the rain" and #${id2} "turn the compost heap" are open`,
    );
    held.push(["tasks", `dispatcher filed #${id1} and #${id2} in ${CHANNEL}`]);

    // --- the watcher: agent C registers before anything moves -------------------------------
    step(
      `agent ${AGENT_C} registers a watcher on ${CHANNEL} (register → leased matches → ack)`,
    );
    const registration = await callBoard("POST", "/watchers", AGENT_C, {
      watch: { garden_tail: { tail: CHANNEL } },
    });
    const registrationGate = gateOfAnswer(
      registration.status,
      registration.body,
    );
    if (registrationGate !== null) throw registrationGate;
    if (!registration.ok) {
      throw new Failure(
        `watcher registration answered ${registration.status}: ${JSON.stringify(registration.body).slice(0, 200)}`,
      );
    }
    say(
      `watcher ${AGENT_C} registered on tail "${CHANNEL}"; its pull is running`,
    );
    held.push([
      "watcher",
      `${AGENT_C} registered on ${CHANNEL} (tail: ${CHANNEL})`,
    ]);

    /** The pull: chase matches, ack each, until the completion reply's match lands. */
    const watch = async (): Promise<void> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < WATCH_BUDGET_MS) {
        const answer = await callBoard(
          "GET",
          `/watchers/matches?wait=${MATCH_WAIT_S}&limit=10`,
          AGENT_C,
        );
        const gate = gateOfAnswer(answer.status, answer.body);
        if (gate !== null) throw gate;
        if (!answer.ok) {
          throw new Failure(
            `watcher matches answered ${answer.status}: ${JSON.stringify(answer.body).slice(0, 200)}`,
          );
        }
        for (const match of listOf(answer.body.matches, "matches")) {
          const m = objOf(match, "match");
          const id = strOf(m.id, "match.id");
          const lease = strOf(m.lease, "match.lease");
          const event =
            m.event === undefined ? {} : objOf(m.event, "match.event");
          const what = typeof event.type === "string" ? event.type : "event";
          const message =
            typeof event.message === "object" && event.message !== null
              ? objOf(event.message, "event.message")
              : null;
          const onId =
            message !== null && typeof message.id === "string"
              ? message.id
              : null;
          wakes.seen += 1;
          const isTheReply = wake.replyId !== null && onId === wake.replyId;
          say(
            `watcher woke on ${what}${onId === null ? "" : ` #${onId}`}${isTheReply ? " — the completion reply" : ""}`,
          );
          const ack = await callBoard(
            "POST",
            `/watchers/matches/${encodeURIComponent(id)}/ack`,
            AGENT_C,
            { lease },
          );
          if (!ack.ok) {
            throw new Failure(
              `watcher ack answered ${ack.status}: ${JSON.stringify(ack.body).slice(0, 200)}`,
            );
          }
          wakes.acked += 1;
          if (isTheReply && wake.postedAtMs !== null) {
            wakes.latencyMs = performance.now() - wake.postedAtMs;
            return;
          }
        }
      }
      throw new Failure(
        `the watcher never saw the completion reply within ${WATCH_BUDGET_MS / 1000}s`,
      );
    };
    const watching = watch();
    watching.catch(() => {}); // an early gate elsewhere must not orphan this pull

    // --- the fence: A and B claim concurrently ----------------------------------------------
    step("the fence: agents A and B claim --ready concurrently");
    /** One agent's claim, with the CLI's own words so a race's evidence isn't lost. */
    const claimRun = async (
      profile: string,
    ): Promise<{ parsed: Record<string, unknown>; said: string }> => {
      const run = await runVb(
        [
          "tasks",
          "claim",
          "--ready",
          CHANNEL,
          "--from",
          principal,
          "--wait",
          CLAIM_WAIT,
          "--json",
        ],
        homeOf[profile],
        profile,
        boardUrl,
      );
      const gate = gateOfRun(run);
      if (gate !== null) throw gate;
      if (run.code !== 0) {
        throw new Failure(
          `vb tasks claim as ${profile} failed (exit ${run.code}):\n     stdout: ${run.stdout.trim().slice(0, 300) || "(empty)"}\n     stderr: ${run.stderr.trim().slice(0, 300) || "(empty)"}`,
        );
      }
      return {
        parsed: parseJson(run.stdout, `vb tasks claim as ${profile}`),
        said: `${run.stdout}\n${run.stderr}`,
      };
    };
    const claimStart = performance.now();
    const [raceA, raceB] = await Promise.all([
      claimRun(AGENT_A),
      claimRun(AGENT_B),
    ]);
    const claimA = raceA.parsed;
    const claimB = raceB.parsed;
    const held1 = strOf(
      objOf(claimA.task, "agent A's claim").id,
      "agent A's task id",
    );
    const held2 = strOf(
      objOf(claimB.task, "agent B's claim").id,
      "agent B's task id",
    );
    const untilA = strOf(
      objOf(claimA.claim, "agent A's lease").until,
      "agent A's lease until",
    );
    if (held1 === held2) {
      throw new Failure(`the fence let both agents hold #${held1}`);
    }
    say(
      `agent ${AGENT_A} holds #${held1} (lease until ${untilA}); agent ${AGENT_B} holds #${held2}`,
    );
    say(
      `two concurrent claims, two distinct holds, no double-claim — resolved in ${Math.round(performance.now() - claimStart)} ms`,
    );
    if (/task_claimed/.test(raceA.said) || /task_claimed/.test(raceB.said)) {
      say(
        "a claim race answered task_claimed; the loser took the next candidate — the fence held",
      );
    }
    held.push([
      "fence",
      `${AGENT_A} holds #${held1}, ${AGENT_B} holds #${held2} — distinct holds, one race`,
    ]);

    // --- A works: a progress reply, the completion reply, then the result --------------------
    step(
      `agent ${AGENT_A} works #${held1}: progress, completion reply, result`,
    );
    const progress = await expectVb(
      [
        "reply",
        held1,
        "on it — storm's close; two crates picked, finishing the last row",
        "--json",
      ],
      homeOf[AGENT_A],
      AGENT_A,
      boardUrl,
      "vb reply (progress)",
    );
    const progressId = strOf(
      objOf(progress.message ?? progress, "progress reply").id,
      "progress reply id",
    );
    say(`progress reply #${progressId} posted`);
    const completionAt = performance.now();
    const completion = await expectVb(
      [
        "reply",
        held1,
        "done: picked all four rows before the rain hit",
        "--json",
      ],
      homeOf[AGENT_A],
      AGENT_A,
      boardUrl,
      "vb reply (completion)",
    );
    const completionId = strOf(
      objOf(completion.message ?? completion, "completion reply").id,
      "completion reply id",
    );
    wake.replyId = completionId;
    wake.postedAtMs = completionAt;
    say(
      `completion reply #${completionId} posted — the watcher's pull is waiting for exactly this`,
    );
    const complete = await expectVb(
      [
        "tasks",
        "complete",
        held1,
        "picked all four rows before the rain",
        "--json",
      ],
      homeOf[AGENT_A],
      AGENT_A,
      boardUrl,
      "vb tasks complete",
    );
    const completed = objOf(complete.task ?? complete, "completed task");
    say(
      `#${strOf(completed.id, "completed task id")} completed — "picked all four rows before the rain"`,
    );
    held.push([
      "work",
      `${AGENT_A} replied #${progressId}, completed #${held1} with a result (nothing external opened)`,
    ]);

    // --- the wake: C's match lands on the completion reply ----------------------------------
    step(
      `agent ${AGENT_C}'s watcher: the completion reply's match lands, and it acks`,
    );
    await watching;
    if (wakes.latencyMs === null)
      throw new Failure("the watcher stopped without a wake latency to report");
    say(
      `match acked; wake latency ${Math.round(wakes.latencyMs)} ms from the reply going out`,
    );
    held.push([
      "wake",
      `${AGENT_C} pulled ${wakes.seen} match(es), acked ${wakes.acked}, woke ${Math.round(wakes.latencyMs)} ms after the reply`,
    ]);

    // --- B stands down: release gives the lease back ----------------------------------------
    step(`agent ${AGENT_B} releases #${held2} (the lease fence, given back)`);
    const release = await expectVb(
      ["tasks", "release", held2, "--json"],
      homeOf[AGENT_B],
      AGENT_B,
      boardUrl,
      `vb tasks release as ${AGENT_B}`,
    );
    const released = objOf(release.task ?? release, "released task");
    say(`#${strOf(released.id, "released task id")} released — ready again`);
    held.push(["release", `${AGENT_B} released #${held2} back to ready`]);

    // --- the proof in the board's own words -------------------------------------------------
    step("the board's own records: the tasks list and the event feed");
    const states = await expectVb(
      ["tasks", CHANNEL, "--state", "all", "--json"],
      dispatcherHome,
      null,
      boardUrl,
      "vb tasks --state all",
    );
    const kept = listOf(states.tasks, "tasks list");
    for (const row of kept) {
      const summary = objOf(row, "task row");
      const message = objOf(summary.message, "task row message");
      const state =
        message.task === undefined
          ? "?"
          : String(objOf(message.task, "task view").state ?? "?");
      say(
        `#${strOf(message.id, "task row id")}  ${state.padEnd(9)}  ${typeof message.text === "string" ? message.text : ""}`,
      );
    }
    // The feed's head: the journal records the consumer has walked. The
    // watcher's matches above are the events themselves; the head is the
    // feed's own account of the story's writes.
    const feedPage = await callBoard("GET", "/events?limit=200", AGENT_C);
    if (!feedPage.ok)
      throw new Failure(`the event feed answered ${feedPage.status}`);
    const head = String(feedPage.body.cursor ?? "?");
    say(
      `the event feed's head sits at seq ${head}; the watcher matched ${wakes.seen} event(s) of this story`,
    );
    held.push([
      "records",
      `tasks list: ${kept.length} task(s) in every state; feed head at seq ${head}; watcher matched ${wakes.seen}`,
    ]);

    // --- the same bytes, one place: a read-only peek through bd -----------------------------
    if (fixture !== null) {
      try {
        const peek = await fixture.run(["list"]);
        if (peek.code === 0) {
          const lines = peek.stdout
            .trim()
            .split("\n")
            .filter((line) => line.trim() !== "")
            .slice(0, 6);
          say(
            `bd list (read-only peek): ${lines.length === 0 ? "(no issues listed)" : `\n     ${lines.join("\n     ")}`}`,
          );
        }
      } catch {
        say(
          "bd list peek skipped (the board's own records above already show the state)",
        );
      }
    }
  } catch (error) {
    if (error instanceof Gate) {
      gates.push(error);
      // Whatever gated first, report the other in-flight surface too, so one run says it all.
      if (server !== null) {
        try {
          const probe = await fetch(`${boardUrlOf(server)}/watchers`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-board-profile": AGENT_C,
            },
            body: JSON.stringify({ watch: { garden_tail: { tail: CHANNEL } } }),
            signal: wire.signal,
          });
          const probeGate = gateOfAnswer(
            probe.status,
            parseJsonSafely(await probe.text()),
          );
          if (
            probeGate !== null &&
            !gates.some((known) => known.line === probeGate.line)
          )
            gates.push(probeGate);
        } catch {
          // The probe is a courtesy; the first gate is the run's answer.
        }
      }
    } else {
      crash = error;
    }
  } finally {
    wire.abort();
    server?.stop(true);
    fixture?.close();
    rmSync(root, { recursive: true, force: true });
  }

  // --- the summary ---------------------------------------------------------------------------
  console.log(
    "\n═══ demo summary ══════════════════════════════════════════════",
  );
  for (const [label, line] of held)
    console.log(`  ${label.padEnd(12)} ${line}`);
  if (gates.length > 0) {
    console.log("\n  readiness — what isn't here yet:");
    for (const gate of gates) console.log(`    • ${gate.line}`);
  }
  if (crash !== null) {
    console.error("\n  the story broke:");
    console.error(
      `    ${crash instanceof Error ? crash.message : String(crash)}`,
    );
    console.log("\nverdict: failed");
    process.exitCode = 1;
    return;
  }
  if (gates.length > 0) {
    console.log(
      "\nverdict: gated — rerun after the in-flight units merge; this script runs green as-is then",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nverdict: held — the story ran end to end on a real tracker");
  process.exitCode = 0;
};

main().catch((error: unknown) => {
  console.error(
    "board-beads demo crashed before it could tell its story:",
    error,
  );
  process.exit(1);
});
