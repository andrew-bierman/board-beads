/**
 * The bd subprocess transport: the one module that owns every bd
 * invocation. Nothing else in the codebase spawns a process.
 *
 * Design (mirroring lambe's ShellTransport):
 *   - one subprocess per call, cwd'd at the tracker, bounded by a per-call
 *     timeout that kills the whole process group (bd spawns children);
 *   - every call carries BD_JSON_ENVELOPE=1 and BEADS_ACTOR;
 *   - every failure path becomes a typed error from ./errors.ts, never a
 *     raw crash; signal deaths are their own typed crash;
 *   - issue ids and event cursors flow as opaque strings;
 *   - the events journal contract (tail, truncation, disabled) lives here;
 *   - this module is the single writer: batch writes go through
 *     `bd batch -f` with a grammar restricted to close|update|create|
 *     dep add|dep remove — claims, heartbeats, and guarded updates are
 *     single-op by construction.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BdCorruptOutputError,
  BdCrashError,
  BdError,
  BdJournalTruncatedError,
  BdTransportError,
  classifyBdExit,
  unwrapEnvelope,
} from "./errors.ts";
import { parseBdVersion, type BdVersion } from "./version.ts";

/** Default per-invocation bound. bd pays engine startup on every call. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** How long a timed-out bd gets to exit gracefully (SIGTERM) before SIGKILL. */
const KILL_GRACE_MS = 1_000;
/**
 * How hard one invocation fights a Dolt lock refusal. Dolt serializes a
 * tracker behind a lock file and bd refuses outright rather than waiting,
 * so under several concurrent invocations on one tracker (the full suite
 * runs many fixture trackers at once) a call can lose that race several
 * times in a row. Each retry re-pays the engine start, which spaces the
 * attempts on its own; the backoff adds only the refusal path's short
 * hops. Six attempts rides out multi-second contention windows before the
 * failure classifies.
 */
const LOCK_ATTEMPTS = 6;
const LOCK_BACKOFF_MS = 250;
const LOCK_BACKOFF_MAX_MS = 2_000;
/**
 * How long a "never recorded" probe answer stands before the next empty
 * tail asks again — long enough to keep a quiet journal's cadence reads
 * from paying a config spawn each, short enough that journaling switched
 * on under a running process is noticed on its next idle cycle.
 */
const JOURNAL_PROBE_TTL_MS = 10_000;

/** Options for constructing a transport. */
export interface BdTransportOptions {
  /** Tracker workspace directory (bd's cwd for every call). */
  dir: string;
  /** Stable identity stamped on every write via BEADS_ACTOR. */
  actor: string;
  /** The bd binary; defaults to "bd" on PATH. */
  bin?: string;
  /** Per-invocation bound in ms; defaults to 30s. */
  timeoutMs?: number;
  /**
   * Carry BD_EVENTS_JOURNAL=1 on every invocation so mutations are
   * journaled even when the workspace default is off. The events reader
   * always sets it on its own reads regardless.
   */
  journal?: boolean;
}

/** One successful bd invocation: the unwrapped envelope data plus raw bytes. */
export interface BdResult {
  /**
   * The envelope's "data" payload when bd sent one; the parsed JSON when
   * the output was non-envelope JSON; undefined for non-JSON output.
   */
  data: unknown;
  /** The untouched stdout. */
  raw: string;
}

/** The subset of a bd issue the transport decodes. */
export interface BdIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType?: string;
  assignee?: string | null;
  description?: string;
  dependencyCount?: number | null;
}

/** The subset of a bd comment the transport decodes. */
export interface BdComment {
  id: string;
  issueId: string;
  author: string;
  text: string;
}

/** Fields for a single-op update. `claim` and `ifAssignee` are single-op only. */
export interface BdUpdateFields {
  status?: string;
  priority?: number;
  title?: string;
  assignee?: string;
  /** Atomic claim (compare-and-set by holder). */
  claim?: boolean;
  /**
   * Guard the update on the current assignee: a mismatch exits 13 and
   * surfaces as a lost guard. With `status: "in_progress"` this is the
   * guarded form of a claim.
   */
  ifAssignee?: string;
}

/**
 * Field updates expressible through the batch grammar (close|update|create|
 * dep add|dep remove). The shape cannot carry claims, guards, or metadata,
 * so callers cannot queue an op bd's batch would refuse.
 */
export interface BdBatchFields {
  status?: string;
  priority?: number;
  title?: string;
  assignee?: string;
  /** Override the closed-children refusal on a status move to closed. */
  force?: boolean;
}

/**
 * One batch operation. The union only admits bd's batch grammar; anything
 * that must go single-op (claims, heartbeats, guarded updates) is not
 * expressible here.
 */
export type BdBatchOp =
  | { op: "close"; id: string; reason?: string }
  | { op: "update"; id: string; fields: BdBatchFields }
  | { op: "create"; type: string; priority: number; title: string }
  | { op: "dep-add"; from: string; to: string; type?: string }
  | { op: "dep-remove"; from: string; to: string };

/** One applied batch line, as bd reports it. */
export interface BdBatchOpResult {
  line: number | null;
  op: string;
  target: string;
}

/** The applied-batch summary bd reports. */
export interface BdBatchResult {
  operations: number;
  results: BdBatchOpResult[];
}

/** One bare events-journal record (bd emits NDJSON, no envelope). */
export interface BdJournalRecord {
  seq: number;
  ts: string;
  /** create|update|close|delete|dep_add|dep_remove|comment in practice. */
  op: string;
  issueId: string;
  actor: string;
  /** The full issue snapshot bd attaches; left opaque here. */
  issue: unknown;
}

/**
 * One events read. "records" carries the gapless page after the cursor;
 * "truncated" means the checkpoint fell below the retention floor and the
 * consumer must re-baseline; "disabled" means the journal has never been
 * recording on this workspace.
 */
export type BdEventsPage =
  | { kind: "records"; cursor: string; events: BdJournalRecord[] }
  | { kind: "truncated"; floor: number; head: number | null }
  | { kind: "disabled" };

/** Outcome of one child process, before classification. */
type ExecOutcome =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "signal"; signal: string; stdout: string; stderr: string }
  | { kind: "timeout"; stdout: string; stderr: string }
  | { kind: "spawn-error"; error: Error; stdout: string; stderr: string };

/** Build the typed corrupt-output error for a given command. */
function corrupt(command: string, detail: string): BdCorruptOutputError {
  return new BdCorruptOutputError({
    command,
    exitCode: 0,
    message: `${command}: corrupt bd output: ${detail}`,
  });
}

/** Narrow an unknown value to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Decode bd's issue payload, tolerating both shapes bd uses across
 * create/update/show/claim: a single object or a one-element array.
 */
function decodeIssue(command: string, result: BdResult): BdIssue {
  const data = result.data;
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) {
    throw corrupt(command, `expected one issue, got ${rows.length}`);
  }
  const row = asRecord(rows[0]);
  if (!row) throw corrupt(command, "issue payload is not an object");
  const id = row.id;
  if (typeof id !== "string" || id === "") {
    throw corrupt(command, "issue payload has no id");
  }
  return {
    id,
    title: typeof row.title === "string" ? row.title : "",
    status: typeof row.status === "string" ? row.status : "",
    priority: typeof row.priority === "number" ? row.priority : 0,
    issueType: typeof row.issue_type === "string" ? row.issue_type : undefined,
    assignee: typeof row.assignee === "string" ? row.assignee : null,
    description:
      typeof row.description === "string" ? row.description : undefined,
    dependencyCount:
      typeof row.dependency_count === "number" ? row.dependency_count : null,
  };
}

/** Decode bd's comment payload (object, or one-element array). */
function decodeComment(command: string, result: BdResult): BdComment {
  const data = result.data;
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length !== 1) {
    throw corrupt(command, `expected one comment, got ${rows.length}`);
  }
  const row = asRecord(rows[0]);
  if (!row) throw corrupt(command, "comment payload is not an object");
  const id = typeof row.id === "string" ? row.id : "";
  const issueId = typeof row.issue_id === "string" ? row.issue_id : "";
  const text = typeof row.text === "string" ? row.text : "";
  if (id === "" || issueId === "") {
    throw corrupt(command, "comment payload has no id or issue_id");
  }
  return {
    id,
    issueId,
    author: typeof row.author === "string" ? row.author : "",
    text,
  };
}

/** Decode bd's batch summary. */
function decodeBatchResult(command: string, result: BdResult): BdBatchResult {
  const row = asRecord(result.data);
  if (!row) throw corrupt(command, "batch result is not an object");
  const rows = Array.isArray(row.results) ? row.results : [];
  const results: BdBatchOpResult[] = rows.map((entry) => {
    const record = asRecord(entry);
    return {
      line: record && typeof record.line === "number" ? record.line : null,
      op: record && typeof record.op === "string" ? record.op : "",
      target: record && typeof record.target === "string" ? record.target : "",
    };
  });
  return {
    operations:
      typeof row.operations === "number" ? row.operations : results.length,
    results,
  };
}

/**
 * Render one token for the batch grammar, quoting when needed.
 *
 * bd's batch grammar is line-oriented: only a newline splits the line
 * mid-operation, and bd's parser answers with an opaque parse error that
 * rolls the whole transaction back. Refuse it up front, naming the problem,
 * so the batch never reaches bd. Other control characters travel byte-exact
 * inside quotes — verified against bd 1.3.4, including a carriage return and
 * a tab — and are deliberately allowed through.
 */
function renderToken(value: string): string {
  if (/\n/.test(value)) {
    throw new TypeError(
      "batch tokens cannot carry newline characters: bd's batch grammar is line-oriented, and a token with one would split its line and roll back the batch",
    );
  }
  if (/^[A-Za-z0-9@:._/+=<>-]+$/.test(value)) return value;
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}

function requireId(value: string, what: string): string {
  if (value === "") {
    throw new TypeError(`batch ${what} requires a non-empty id`);
  }
  return value;
}

/**
 * Render one batch operation into a grammar line. Caller-shape errors
 * (empty ids, a fieldless update) throw TypeError before bd runs.
 */
export function renderBatchLine(op: BdBatchOp): string {
  switch (op.op) {
    case "close": {
      const id = requireId(op.id, "close");
      const reason =
        op.reason === undefined ? "" : ` ${renderToken(op.reason)}`;
      return `close ${renderToken(id)}${reason}`;
    }
    case "update": {
      const id = requireId(op.id, "update");
      const parts: string[] = [];
      if (op.fields.status !== undefined) {
        parts.push(`status=${renderToken(op.fields.status)}`);
      }
      if (op.fields.priority !== undefined) {
        parts.push(`priority=${op.fields.priority}`);
      }
      if (op.fields.title !== undefined) {
        parts.push(`title=${renderToken(op.fields.title)}`);
      }
      if (op.fields.assignee !== undefined) {
        parts.push(`assignee=${renderToken(op.fields.assignee)}`);
      }
      if (op.fields.force !== undefined) {
        parts.push(`force=${op.fields.force}`);
      }
      if (parts.length === 0) {
        throw new TypeError("batch update requires at least one field");
      }
      return `update ${renderToken(id)} ${parts.join(" ")}`;
    }
    case "create":
      return `create ${renderToken(op.type)} ${op.priority} ${renderToken(op.title)}`;
    case "dep-add": {
      const from = requireId(op.from, "dep-add");
      const to = requireId(op.to, "dep-add");
      const type = op.type === undefined ? "" : ` ${renderToken(op.type)}`;
      return `dep add ${renderToken(from)} ${renderToken(to)}${type}`;
    }
    case "dep-remove": {
      const from = requireId(op.from, "dep-remove");
      const to = requireId(op.to, "dep-remove");
      return `dep remove ${renderToken(from)} ${renderToken(to)}`;
    }
  }
}

/**
 * Detect journal truncation from the gapless-sequence contract: bd's
 * journal seqs are gapless, so a first returned seq greater than
 * `since + 1` means records below the retention floor were dropped.
 * Returns the floor (the highest dropped seq) and head (the newest seq
 * present), or null when the page is contiguous.
 */
export function truncationFromGap(
  since: number,
  records: ReadonlyArray<{ seq: number }>,
): { floor: number; head: number } | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return null;
  if (first.seq > since + 1) return { floor: first.seq - 1, head: last.seq };
  return null;
}

/** Parse an opaque event cursor string into bd's numeric --since. */
function parseEventCursor(cursor: string, command: string): number {
  const value = Number(cursor);
  if (cursor.trim() === "" || !Number.isSafeInteger(value) || value < 0) {
    throw new BdTransportError({
      command,
      message: `invalid events cursor ${JSON.stringify(cursor)}: expected a non-negative integer string`,
    });
  }
  return value;
}

/** Parse the journal's bare NDJSON records, skipping human note lines. */
function parseJournalRecords(command: string, raw: string): BdJournalRecord[] {
  const records: BdJournalRecord[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw corrupt(
        command,
        `unparseable journal record: ${text.slice(0, 200)}`,
      );
    }
    const row = asRecord(parsed);
    if (!row) {
      throw corrupt(
        command,
        `unparseable journal record: ${text.slice(0, 200)}`,
      );
    }
    const seq = typeof row.seq === "number" ? row.seq : null;
    const ts = typeof row.ts === "string" ? row.ts : null;
    const op = typeof row.op === "string" ? row.op : null;
    const issueId = typeof row.issue_id === "string" ? row.issue_id : null;
    const actor = typeof row.actor === "string" ? row.actor : "";
    if (seq === null || ts === null || op === null || issueId === null) {
      throw corrupt(
        command,
        `journal record missing seq/ts/op/issue_id: ${text.slice(0, 200)}`,
      );
    }
    records.push({
      seq,
      ts,
      op,
      issueId,
      actor,
      // The issue snapshot bd attaches, kept as it came (an object today, a
      // JSON string tolerated): rows carry their own label state, which is
      // what replayed event walks classify from.
      issue: row.issue ?? null,
    });
  }
  records.sort((a, b) => a.seq - b.seq);
  return records;
}

/**
 * The transport. Construct one per actor identity; the single-writer
 * contract means callers construct exactly one writing transport.
 */
export class BdTransport {
  readonly #dir: string;
  readonly #actor: string;
  readonly #bin: string;
  readonly #timeoutMs: number;
  readonly #journal: boolean;
  /**
   * The journalEnabled probe answers, cached: once the journal has
   * recorded (a records page came through, or the probe said true) it can
   * never be "never enabled" again, so true is remembered for good; the
   * false answer rides a short TTL so the workspace can turn journaling on
   * under a running process and still be noticed. The cache exists because
   * every empty tail read would otherwise pay a second bd spawn — the
   * config read — and a quiet journal's tail is exactly what the poller
   * reads on its cadence, so an uncached probe doubles a live backend's
   * idle spawn pressure on the tracker's lock.
   */
  #journalEnabledTrue = false;
  #journalProbeNotBefore = 0;

  constructor(options: BdTransportOptions) {
    if (options.dir === "") {
      throw new TypeError("BdTransport requires a tracker directory");
    }
    if (options.actor === "") {
      throw new TypeError("BdTransport requires an actor identity");
    }
    this.#dir = options.dir;
    this.#actor = options.actor;
    this.#bin = options.bin ?? "bd";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#journal = options.journal ?? false;
  }

  /**
   * Run one bd invocation through the envelope, timeout, and classification
   * machinery. This is the only place a bd process is ever spawned: escape
   * hatches (config reads, queries) route through here so they inherit the
   * typed error contract.
   *
   * Dolt serializes a tracker behind a lock file, and bd refuses outright
   * ("database is locked by another dolt process") rather than waiting its
   * turn — under several concurrent invocations on one tracker (the journal
   * consumer's tail beside a route's own write, say) an invocation can lose
   * that race. The refusal is bd failing to load the database at all, so no
   * op has run: a short bounded retry is safe for reads and writes alike.
   * Every other classification keeps its one-shot semantics.
   */
  async run(
    args: readonly string[],
    options: {
      extraEnv?: Readonly<Record<string, string>>;
      /** Environment keys to drop from the transport's own additions (e.g. BD_EVENTS_JOURNAL) so bd reads the workspace's own config. */
      omitEnv?: readonly string[];
    } = {},
  ): Promise<BdResult> {
    const command = ["bd", ...args].join(" ");
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#attempt(args, command, options);
      } catch (error) {
        const locked =
          error instanceof BdError &&
          /database is locked by another dolt process/i.test(error.message);
        if (!locked || attempt >= LOCK_ATTEMPTS - 1) throw error;
        // Exponential hops with jitter, capped: the attempts also space
        // themselves by the engine start each one pays, so the jitter only
        // keeps a burst of concurrent callers from retrying in lockstep.
        const hop = Math.min(
          LOCK_BACKOFF_MAX_MS,
          LOCK_BACKOFF_MS * 2 ** attempt,
        );
        const jitter = Math.round(hop * (0.7 + 0.6 * Math.random()));
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }
  }

  /** One spawn-and-classify attempt, shared by the lock-retry loop. */
  async #attempt(
    args: readonly string[],
    command: string,
    options: {
      extraEnv?: Readonly<Record<string, string>>;
      omitEnv?: readonly string[];
    },
  ): Promise<BdResult> {
    const outcome = await this.#exec(
      args,
      options.extraEnv ?? {},
      options.omitEnv ?? [],
    );
    switch (outcome.kind) {
      case "spawn-error":
        throw new BdTransportError({
          command,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          message: `${command}: ${outcome.error.message}`,
        });
      case "timeout":
        throw new BdTransportError({
          command,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          message: `${command} timed out after ${this.#timeoutMs}ms (sent SIGTERM, then SIGKILL to the process group)`,
        });
      case "signal":
        throw new BdCrashError({
          command,
          exitCode: null,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          signal: outcome.signal,
          message: `${command} was killed by signal ${outcome.signal}`,
        });
      case "exit":
        if (outcome.code !== 0) {
          throw classifyBdExit(
            args,
            outcome.code,
            outcome.stdout,
            outcome.stderr,
          );
        }
    }
    const unwrapped = unwrapEnvelope(outcome.stdout);
    return { data: unwrapped.data, raw: outcome.stdout };
  }

  /**
   * Live-probe bd's version: runs the cheap `bd --version`, parses the
   * banner, and classifies every failure path. Capability decisions at
   * bind compare the result with `compareBdVersions` — no hardcoded
   * capability tables live here.
   */
  async version(): Promise<BdVersion> {
    const command = "bd --version";
    const result = await this.run(["--version"]);
    const parsed = parseBdVersion(result.raw);
    if (!parsed) {
      throw corrupt(
        command,
        `unrecognizable version output: ${JSON.stringify(result.raw.trim().slice(0, 200))}`,
      );
    }
    return parsed;
  }

  /** Create an issue. */
  async create(input: {
    title: string;
    type?: string;
    priority?: number;
    description?: string;
  }): Promise<BdIssue> {
    const args: string[] = ["create", "--title", input.title, "--json"];
    if (input.type !== undefined) args.push("--type", input.type);
    if (input.priority !== undefined) {
      args.push("--priority", String(input.priority));
    }
    if (input.description !== undefined) {
      args.push("--description", input.description);
    }
    const command = ["bd", ...args].join(" ");
    return decodeIssue(command, await this.run(args));
  }

  /** Read one issue (accepts bd's object or one-element array shapes). */
  async show(id: string): Promise<BdIssue> {
    const args = ["show", id, "--json"];
    const command = ["bd", ...args].join(" ");
    return decodeIssue(command, await this.run(args));
  }

  /** Update one issue; see {@link BdUpdateFields} for the guarded forms. */
  async update(id: string, fields: BdUpdateFields): Promise<BdIssue> {
    if (id === "") throw new TypeError("update requires a non-empty issue id");
    const args = ["update", id, "--json"];
    if (fields.claim) args.push("--claim");
    if (fields.ifAssignee !== undefined) {
      args.push("--if-assignee", fields.ifAssignee);
    }
    if (fields.status !== undefined) args.push("--status", fields.status);
    if (fields.priority !== undefined) {
      args.push("--priority", String(fields.priority));
    }
    if (fields.title !== undefined) args.push("--title", fields.title);
    if (fields.assignee !== undefined) {
      args.push("--assignee", fields.assignee);
    }
    const command = ["bd", ...args].join(" ");
    return decodeIssue(command, await this.run(args));
  }

  /** Claim an issue for this transport's actor. Losers get a claim race. */
  async claim(id: string): Promise<BdIssue> {
    return this.update(id, { claim: true });
  }

  /** Close an issue; the reason rides as bd's close reason. */
  async close(id: string, reason?: string): Promise<BdIssue> {
    if (id === "") throw new TypeError("close requires a non-empty issue id");
    const args = ["close", id, "--json"];
    if (reason !== undefined) args.push("--reason", reason);
    const command = ["bd", ...args].join(" ");
    return decodeIssue(command, await this.run(args));
  }

  /** Add a comment to an issue. */
  async comment(id: string, text: string): Promise<BdComment> {
    if (id === "") throw new TypeError("comment requires a non-empty issue id");
    const args = ["comment", id, text, "--json"];
    const command = ["bd", ...args].join(" ");
    return decodeComment(command, await this.run(args));
  }

  /** Refresh the lease on a held issue. Loss classifies as not-holder. */
  async heartbeat(id: string): Promise<void> {
    if (id === "") {
      throw new TypeError("heartbeat requires a non-empty issue id");
    }
    await this.run(["heartbeat", id, "--json"]);
  }

  /**
   * Apply batch operations in one `bd batch -f` transaction: one engine
   * start, one commit, rolled back entirely on any failing line. The op
   * union only admits bd's batch grammar. An empty list contacts nothing.
   * The temp file is written 0600 and removed even when bd fails.
   */
  async batch(ops: readonly BdBatchOp[]): Promise<BdBatchResult> {
    const command = "bd batch -f <file> --json";
    if (ops.length === 0) return { operations: 0, results: [] };
    const lines = ops.map((op) => renderBatchLine(op));
    const path = join(
      tmpdir(),
      `board-beads-batch-${process.pid}-${randomUUID()}.bd`,
    );
    writeFileSync(path, `${lines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      return decodeBatchResult(
        command,
        await this.run(["batch", "-f", path, "--json"]),
      );
    } finally {
      rmSync(path, { force: true });
    }
  }

  /**
   * Read the events journal after an opaque string cursor (the last seen
   * seq; "0" to start). The read always runs under BD_EVENTS_JOURNAL=1.
   * Truncation arrives either as bd's structured envelope or from the
   * gapless-sequence contract; a never-enabled journal is a distinct
   * result, not an error.
   */
  async tailEvents(cursor: string): Promise<BdEventsPage> {
    const command = "bd events tail --since <seq> --json";
    const since = parseEventCursor(cursor, command);
    let result: BdResult;
    try {
      result = await this.run(
        ["events", "tail", "--since", String(since), "--json"],
        { extraEnv: { BD_EVENTS_JOURNAL: "1" } },
      );
    } catch (error) {
      if (error instanceof BdJournalTruncatedError) {
        return { kind: "truncated", floor: error.floor, head: error.head };
      }
      throw error;
    }
    const events = parseJournalRecords(command, result.raw);
    if (events.length === 0) {
      // An empty tail is ambiguous: caught up on an enabled journal, or
      // a journal that has never recorded. Ask bd which — unless the
      // answer is already known (see the field notes above).
      if (!this.#journalEnabledTrue) {
        if (Date.now() < this.#journalProbeNotBefore) {
          return { kind: "disabled" };
        }
        const enabled = await this.journalEnabled();
        if (!enabled) {
          this.#journalProbeNotBefore = Date.now() + JOURNAL_PROBE_TTL_MS;
          return { kind: "disabled" };
        }
        this.#journalEnabledTrue = true;
      }
      return { kind: "records", cursor, events };
    }
    // Rows exist, so the journal has recorded: the never-enabled answer is
    // off the table for the rest of this transport's life.
    this.#journalEnabledTrue = true;
    const gap = truncationFromGap(since, events);
    if (gap) return { kind: "truncated", floor: gap.floor, head: gap.head };
    const last = events.at(-1);
    return { kind: "records", cursor: String(last?.seq ?? since), events };
  }

  /** Whether bd reports the events journal enabled for this workspace. */
  async journalEnabled(): Promise<boolean> {
    // Read without the journal env override: bd echoes the override ("1")
    // instead of the config value when the env is set.
    const result = await this.run(["config", "get", "events-journal"], {
      omitEnv: ["BD_EVENTS_JOURNAL"],
    });
    return result.raw.trim() === "true";
  }

  /** Spawn one bd child, bounded and group-killed; never throws. */
  #exec(
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>>,
    omitEnv: readonly string[],
  ): Promise<ExecOutcome> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      BD_JSON_ENVELOPE: "1",
      BEADS_ACTOR: this.#actor,
      ...(this.#journal ? { BD_EVENTS_JOURNAL: "1" } : {}),
      ...extraEnv,
    };
    // BEADS_DIR overrides the cwd pinned below: an ambient value would
    // silently redirect reads and writes to a different tracker. This
    // transport's `dir` is the sole source of tracker identity.
    delete env.BEADS_DIR;
    for (const key of omitEnv) delete env[key];
    return new Promise((resolve) => {
      // Args always travel as argv — spawn never sees a shell, so no
      // argument's text is ever interpolated.
      // detached puts the child in its own process group so the timeout
      // kills bd's descendants (embedded dolt) too, not just bd's pid.
      const child = spawn(this.#bin, [...args], {
        cwd: this.#dir,
        env,
        stdio: ["ignore", "pipe", "pipe"] as const,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const finish = (outcome: ExecOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(outcome);
      };
      child.on("error", (error: Error) => {
        finish({ kind: "spawn-error", error, stdout, stderr });
      });
      child.on("close", (code, signal) => {
        if (timedOut) {
          finish({ kind: "timeout", stdout, stderr });
        } else if (code === null && signal !== null) {
          finish({ kind: "signal", signal, stdout, stderr });
        } else {
          finish({
            kind: "exit",
            code: code ?? -1,
            stdout,
            stderr,
          });
        }
      });
      timer = setTimeout(() => {
        timedOut = true;
        this.#killTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          this.#killTree(child, "SIGKILL");
        }, KILL_GRACE_MS);
      }, this.#timeoutMs);
    });
  }

  /** Signal the child's whole process group, falling back to the child. */
  #killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // The group is already gone; the child is exiting.
      }
    }
    child.kill(signal);
  }
}
