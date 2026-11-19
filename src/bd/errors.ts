/**
 * Typed errors for bd's exit contract. Every failed bd invocation — and
 * every unparseable success — classifies into one of these classes, so
 * callers branch on types instead of parsing bd's text.
 *
 * bd 1.3.4's contract, as observed:
 *   - exit 13: a guarded compare-and-set whose guard no longer holds. This
 *     is the guarded arm of a claim race; {@link BdLostGuardError} and
 *     {@link BdClaimRaceError} share the {@link BdLostRaceError} base so
 *     callers treat both arms uniformly.
 *   - exit 14: the workspace is frozen for migration; writes must retry
 *     later. The backoff cadence is the caller's decision.
 *   - exit 1 with "already claimed by" in the body: a plain claim race.
 *   - exit 1 on a heartbeat: bd distinguishes heartbeat loss ONLY by
 *     message text (the exit code is a plain 1), so the loss texts are
 *     matched here.
 *   - exit 1 with an {"events_journal_truncated"} envelope: the events
 *     checkpoint is below the retained window.
 *   - anything else: a transport error.
 */

/** Shared fields every bd error carries about the invocation that failed. */
export interface BdErrorFields {
  /** The command line that was attempted, e.g. "bd update bd-1 --claim". */
  command: string;
  /** bd's exit code; null when bd never exited cleanly (signal, timeout, spawn failure). */
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  message: string;
}

/** Base class for every typed bd failure. */
export class BdError extends Error {
  /** The command line that was attempted. */
  readonly command: string;
  /** bd's exit code; null when bd never exited on its own. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(fields: BdErrorFields) {
    super(fields.message);
    this.name = new.target.name;
    this.command = fields.command;
    this.exitCode = fields.exitCode ?? null;
    this.stdout = fields.stdout ?? "";
    this.stderr = fields.stderr ?? "";
  }
}

/**
 * Base class for both arms of a lost claim: the guarded compare-and-set
 * (exit 13) and the plain race (exit 1, "already claimed by"). Catch this
 * to treat the two uniformly.
 */
export class BdLostRaceError extends BdError {}

/** The guarded arm of a claim race: exit 13, the guard precondition no longer holds. */
export class BdLostGuardError extends BdLostRaceError {}

/** The plain arm of a claim race: exit 1 with bd's "already claimed by" body. */
export class BdClaimRaceError extends BdLostRaceError {}

/**
 * The workspace is frozen for migration: exit 14. Writes must retry later;
 * the backoff cadence is the caller's decision.
 */
export class BdFrozenError extends BdError {
  /** Always true; present so callers can branch without instanceof chains. */
  readonly retryable = true as const;
}

/**
 * Heartbeat loss: the caller no longer holds the claim. bd reports this as
 * a plain exit 1 and distinguishes it only by message text.
 */
export class BdNotHolderError extends BdError {}

/**
 * bd died by signal (crash, external kill). Distinct from a timeout: our
 * own bound kills bd deliberately and surfaces a transport error instead.
 */
export class BdCrashError extends BdError {
  /** The signal that killed the process, when known. */
  readonly signal: string | null;

  constructor(fields: BdErrorFields & { signal: string | null }) {
    super(fields);
    this.signal = fields.signal;
  }
}

/**
 * bd exited successfully but its output is unparseable as the shape the
 * call requires. Guards against bd version drift ahead of any decode.
 */
export class BdCorruptOutputError extends BdError {}

/**
 * The events journal checkpoint is below the retained window: records
 * under the floor were pruned. The consumer must re-baseline.
 */
export class BdJournalTruncatedError extends BdError {
  /** The lowest retained sequence; records below it are gone. */
  readonly floor: number;
  /** The highest sequence bd knows of, when it reported one. */
  readonly head: number | null;

  constructor(fields: BdErrorFields & { floor: number; head: number | null }) {
    super(fields);
    this.floor = fields.floor;
    this.head = fields.head;
  }
}

/** Everything else bd can fail with: unknown exits, spawn failures, timeouts. */
export class BdTransportError extends BdError {}

/** Narrow an unknown value to a plain object record, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Extract the payload from bd's {"data": ..., "schema_version": ...} JSON
 * envelope, tolerating non-envelope bytes: non-JSON output and JSON without
 * a "data" key pass through untouched as `data: undefined` / the parsed
 * value itself.
 */
export function unwrapEnvelope(raw: string): {
  data: unknown;
  raw: string;
  envelope: boolean;
} {
  const text = raw.trim();
  const unparseable = { data: undefined, raw, envelope: false };
  if (!text.startsWith("{")) return unparseable;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unparseable;
  }
  const record = asRecord(parsed);
  if (record && record.data !== undefined) {
    return { data: record.data, raw, envelope: true };
  }
  return { data: parsed, raw, envelope: false };
}

/** First nonempty line of a body, for error messages. */
function firstLine(body: string): string {
  const line = body
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line ?? "";
}

/**
 * Detect the structured truncation reply bd sends on a failed events read:
 * exit 1 whose stdout envelope carries code "events_journal_truncated" and
 * the retained window.
 */
function truncationEnvelope(stdout: string): {
  floor: number;
  head: number | null;
} | null {
  const record = asRecord(unwrapEnvelope(stdout).data);
  if (!record || record.code !== "events_journal_truncated") return null;
  if (typeof record.floor !== "number") return null;
  return {
    floor: record.floor,
    head: typeof record.head === "number" ? record.head : null,
  };
}

/** The heartbeat-loss message texts bd uses (it has no exit code for them). */
const HEARTBEAT_LOSS_PATTERN = /(claim|lease|not owner|no longer held)/i;

/**
 * Classify one failed bd invocation into a typed error. `args` is the argv
 * bd was invoked with (the verb drives the heartbeat-loss arm); `code`,
 * `stdout`, and `stderr` are the child's outcome. Never throws.
 */
export function classifyBdExit(
  args: readonly string[],
  code: number,
  stdout: string,
  stderr: string,
): BdError {
  const verb = args[0] ?? "";
  const command = ["bd", ...args].join(" ");
  const body = `${stdout}\n${stderr}`;
  if (code === 13) {
    return new BdLostGuardError({
      command,
      exitCode: code,
      stdout,
      stderr,
      message: `${command}: guard precondition no longer held (exit 13)`,
    });
  }
  if (code === 14) {
    return new BdFrozenError({
      command,
      exitCode: code,
      stdout,
      stderr,
      message: `${command}: workspace is frozen for migration; retry later (exit 14): ${firstLine(body)}`,
    });
  }
  if (code === 1) {
    const truncated = truncationEnvelope(stdout);
    if (truncated) {
      return new BdJournalTruncatedError({
        command,
        exitCode: code,
        stdout,
        stderr,
        floor: truncated.floor,
        head: truncated.head,
        message: `${command}: events journal truncated: checkpoint is below the retained window (floor ${truncated.floor})`,
      });
    }
    if (body.includes("already claimed by")) {
      // bd distinguishes heartbeat loss only by message text.
      if (verb === "heartbeat") {
        return new BdNotHolderError({
          command,
          exitCode: code,
          stdout,
          stderr,
          message: `${command}: the claim is no longer ours: ${firstLine(body)}`,
        });
      }
      return new BdClaimRaceError({
        command,
        exitCode: code,
        stdout,
        stderr,
        message: `${command}: claim lost to another actor: ${firstLine(body)}`,
      });
    }
    if (verb === "heartbeat" && HEARTBEAT_LOSS_PATTERN.test(body)) {
      return new BdNotHolderError({
        command,
        exitCode: code,
        stdout,
        stderr,
        message: `${command}: the claim is no longer ours: ${firstLine(body)}`,
      });
    }
  }
  return new BdTransportError({
    command,
    exitCode: code,
    stdout,
    stderr,
    message: `${command} failed with exit code ${code}: ${firstLine(body)}`,
  });
}
