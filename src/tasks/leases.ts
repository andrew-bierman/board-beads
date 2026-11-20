/**
 * Lease timing for tasks: the Board-side expiry timer (one per live claim,
 * firing when the claim's lease ends) and bd's lease TTL, measured live
 * instead of hardcoded.
 *
 * Two clocks run for one claim:
 *   - the Board lease (`{epoch, token, until}` in the task's metadata) is
 *     what fencing answers on; when it ends, the task is claimable at once
 *     and the board appends the expiry — its label says `ready` again;
 *   - bd's own lease (measured ≈300s on bd 1.3.4, from the claim response's
 *     `lease_expires_at − heartbeat_at`) is kept alive by heartbeats at a
 *     third of the observed TTL while a Board lease outruns it.
 *
 * Neither timer is load-bearing for correctness — every claim is checked
 * against the clock where it's read, and every expiry flip re-checks the
 * task's metadata under the write gate before it lands — so a timer that
 * never fires (a process restart, an unref'd loop) costs latency, never
 * state. Every timer is unref'd so a backend close never hangs on them.
 */
import { randomUUID } from "node:crypto";
import type { BdResult } from "../bd/transport.ts";

/** What fires when a claim's lease ends: the task, and the claim's epoch. */
export type LeaseExpired = (id: string, epoch: number) => void;

export interface LeaseTimers {
  /** Arm (or re-arm) the expiry timer for one claim. */
  arm(id: string, epoch: number, untilMs: number): void;
  /** Disarm one claim's timer — the claim ended some other way. */
  cancel(id: string, epoch: number): void;
  /** Disarm every timer. */
  stop(): void;
  /** How many timers are armed. */
  readonly size: number;
}

/**
 * One timer per live claim, keyed by task and epoch: a renewed or
 * re-claimed task re-arms over the old timer, so at most one fires per
 * claim. Fires at `untilMs`; a claim that has moved on by then finds its
 * epoch stale and the expiry's own re-check dismisses the fire.
 */
export function createLeaseTimers(onExpire: LeaseExpired): LeaseTimers {
  const armed = new Map<string, NodeJS.Timeout>();

  function key(id: string, epoch: number): string {
    return `${id}:${epoch}`;
  }

  function disarm(token: string): void {
    const timer = armed.get(token);
    if (timer !== undefined) {
      clearTimeout(timer);
      armed.delete(token);
    }
  }

  return {
    arm(id: string, epoch: number, untilMs: number): void {
      const token = key(id, epoch);
      disarm(token);
      const delay = Math.max(0, untilMs - Date.now());
      const timer = setTimeout(() => {
        armed.delete(token);
        onExpire(id, epoch);
      }, delay);
      // A backend that closes without stop() must not hold the loop open.
      timer.unref?.();
      armed.set(token, timer);
    },
    cancel(id: string, epoch: number): void {
      disarm(key(id, epoch));
    },
    stop(): void {
      for (const [token, timer] of [...armed]) {
        clearTimeout(timer);
        armed.delete(token);
      }
    },
    get size(): number {
      return armed.size;
    },
  };
}

/** One live TTL measurement of bd's lease, in milliseconds. */
export interface LeaseTtlObservation {
  ttlMs: number;
  /** When the measurement was taken. */
  measuredAt: string;
}

/** The TTL probe's outcome: a measurement, or why none could be taken. */
export type LeaseTtlResult =
  { ok: true; value: LeaseTtlObservation } | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Read `lease_expires_at` and `heartbeat_at` off a claim's issue payload —
 * bd answers them on the claim itself (object, or one-element array), and
 * their difference is the lease bd grants a claim. Never throws.
 */
export function ttlFromIssuePayload(data: unknown): LeaseTtlResult {
  const row = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
  if (row === null)
    return { ok: false, reason: "claim response carried no issue" };
  const expires =
    typeof row.lease_expires_at === "string"
      ? Date.parse(row.lease_expires_at)
      : NaN;
  const heartbeat =
    typeof row.heartbeat_at === "string" ? Date.parse(row.heartbeat_at) : NaN;
  if (Number.isNaN(expires) || Number.isNaN(heartbeat)) {
    return { ok: false, reason: "claim response carried no lease timestamps" };
  }
  const ttlMs = expires - heartbeat;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return {
      ok: false,
      reason: `lease timestamps imply no lease (${ttlMs}ms)`,
    };
  }
  return { ok: true, value: { ttlMs, measuredAt: new Date().toISOString() } };
}

/**
 * Measure bd's lease TTL the way the plan derives it — claim a throwaway
 * fixture issue and read the lease's span off the claim's own answer. No
 * hardcoded constant: the installed bd's contract is the answer, and the
 * probe cleans its fixture up (best effort) behind a typed result either
 * way, so bind-time degradation is reported, never thrown.
 */
export async function probeLeaseTtl(deps: {
  /** The system-actor runner: the transport's own run. */
  run: (args: string[]) => Promise<BdResult>;
}): Promise<LeaseTtlResult> {
  const marker = randomUUID().slice(0, 8);
  let created: BdResult | null = null;
  try {
    created = await deps.run([
      "create",
      "--title",
      `board-beads lease probe ${marker}`,
      "--json",
    ]);
    const row = Array.isArray(created.data)
      ? asRecord(created.data[0])
      : asRecord(created.data);
    const id = typeof row?.id === "string" ? row.id : null;
    if (id === null) {
      return { ok: false, reason: "probe issue create returned no id" };
    }
    const claimed = await deps.run(["update", id, "--claim", "--json"]);
    const measured = ttlFromIssuePayload(claimed.data);
    return measured;
  } catch (error) {
    return {
      ok: false,
      reason: `lease probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // Cleanup is best effort: the probe never leaves its fixture claim live when it can help it.
    const row =
      created === null
        ? null
        : Array.isArray(created.data)
          ? asRecord(created.data[0])
          : asRecord(created.data);
    const id = typeof row?.id === "string" ? row.id : null;
    if (id !== null) {
      await deps.run(["unclaim", id, "--json"]).catch(() => undefined);
      await deps.run(["delete", id, "--force"]).catch(() => undefined);
    }
  }
}
