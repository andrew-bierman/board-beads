/**
 * The task record: the logical shape every task-carrying surface reads and
 * writes, shared by the tasks routes (which own its writes) and the view
 * sections of the threads routes and the event translator (which only read).
 *
 * A task is a thread whose root issue carries this record in its metadata
 * blob under `<ns>.task`, beside the message metadata — bd merges metadata
 * keys, so the two live side by side on one issue. The record mirrors what
 * Board's protocol calls a task, minus the claim: the claim's fencing state
 * (`epoch`, `token`, `until`) rides the message metadata's own `claim` field,
 * so the view assembles `TaskView.claim` from the two halves.
 */

import type { MessageView, TaskView } from "@vercel/board";
import type { JsonValue, MessageMeta, MetadataCodec } from "../model/types.ts";

/** Board's reserved task-state label: the record's `state`, as callers see it. */
export const TASK_LABEL = "board.task";

/** Leases: what a claim may ask for, in seconds. Outside the band is 400. */
export const LEASE_MIN_S = 30;
export const LEASE_CAP_S = 3600;

/** A task's state, exactly as the protocol's `board.task` label carries it. */
export type TaskState =
  | "waiting"
  | "ready"
  | "claimed"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled";

const TASK_STATES: readonly TaskState[] = [
  "waiting",
  "ready",
  "claimed",
  "blocked",
  "completed",
  "failed",
  "canceled",
];

/** The open states an edit of the root can hold, and a delete can cancel. */
const HOLDABLE_STATES: readonly TaskState[] = ["waiting", "ready", "claimed"];

/**
 * The task record, in its logical shape, as `<ns>.task` in the metadata blob.
 * `seq` is the backend sequence the root was created at, for stable ordering.
 */
export interface TaskRecord {
  state: TaskState;
  /** The principal that made the thread a task. */
  owner: string;
  /** The actor it did that as. */
  by: string;
  /** The one actor that claims it, or null. */
  for: string | null;
  /** The tasks it waits for, by their root ids. */
  needs: string[];
  blocked: { kind: string | null; reason: string } | null;
  result: string | null;
  reason: string | null;
  seq: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function isState(value: unknown): value is TaskState {
  return (
    typeof value === "string" &&
    (TASK_STATES as readonly string[]).includes(value)
  );
}

function isBlocked(value: unknown): value is TaskRecord["blocked"] {
  if (value === null) return true;
  const record = asRecord(value);
  if (record === null) return false;
  if (record.reason !== undefined && typeof record.reason !== "string")
    return false;
  if (
    record.kind !== undefined &&
    record.kind !== null &&
    typeof record.kind !== "string"
  ) {
    return false;
  }
  return true;
}

/** Decode the `<ns>.task` record, tolerantly: every failure is a reason. */
export function decodeTaskRecord(
  raw: unknown,
): { ok: true; value: TaskRecord } | { ok: false } {
  const record = asRecord(raw);
  if (record === null) return { ok: false };
  const state = record.state;
  if (!isState(state)) return { ok: false };
  if (typeof record.owner !== "string" || typeof record.by !== "string")
    return { ok: false };
  if (
    record.for !== undefined &&
    record.for !== null &&
    typeof record.for !== "string"
  ) {
    return { ok: false };
  }
  if (
    !Array.isArray(record.needs) ||
    record.needs.some((need) => typeof need !== "string")
  ) {
    return { ok: false };
  }
  if (!isBlocked(record.blocked)) return { ok: false };
  if (
    record.result !== undefined &&
    record.result !== null &&
    typeof record.result !== "string"
  ) {
    return { ok: false };
  }
  if (
    record.reason !== undefined &&
    record.reason !== null &&
    typeof record.reason !== "string"
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      state,
      owner: record.owner,
      by: record.by,
      for: (record.for ?? null) as string | null,
      needs: (record.needs as string[]).slice(),
      blocked: (record.blocked ?? null) as TaskRecord["blocked"],
      result: (record.result ?? null) as string | null,
      reason: (record.reason ?? null) as string | null,
      seq:
        typeof record.seq === "number" && Number.isSafeInteger(record.seq)
          ? record.seq
          : 0,
    },
  };
}

export function encodeTaskRecord(record: TaskRecord): JsonValue {
  return {
    v: 1,
    state: record.state,
    owner: record.owner,
    by: record.by,
    for: record.for,
    needs: [...record.needs],
    blocked: record.blocked,
    result: record.result,
    reason: record.reason,
    seq: record.seq,
  };
}

/** The `<ns>.task` record an issue's metadata blob carries, or null. */
export function taskRecordOf(
  codec: MetadataCodec,
  metadata: unknown,
): TaskRecord | null {
  const blob = asRecord(metadata);
  if (blob === null) return null;
  const decoded = decodeTaskRecord(blob[`${codec.namespace}.task`]);
  return decoded.ok ? decoded.value : null;
}

/**
 * The protocol's `TaskView` for a task root, from its record and its message
 * metadata. `claim` assembles from the metadata's fencing state: the holder's
 * actor id comes from whoever resolved the row (`claimActor` — the assignee
 * slug mapped through the actor cards), the `until` from the claim itself. A
 * claim whose `until` has passed still shows: the board's next look at the
 * task expires it, and the view says so by its `until`.
 */
export function projectTaskView(
  meta: MessageMeta,
  record: TaskRecord | null,
  claimActor: string | null,
): TaskView | null {
  if (record === null) return null;
  const claim = meta.claim;
  return {
    state: record.state,
    owner: record.owner,
    by: record.by,
    for: record.for,
    needs: [...record.needs],
    epoch: claim?.epoch ?? meta.epoch,
    claim:
      claim === null ? null : { actor: claimActor ?? "", until: claim.until },
    blocked: record.blocked === null ? null : { ...record.blocked },
    result: record.result,
    reason: record.reason,
  };
}

/**
 * Whether a lease ask is inside the band, as the protocol answers it: outside
 * is a misshapen request (400 `invalid_request`), and `undefined` takes the
 * board's own default, which is inside the band by construction.
 */
export function leaseOutsideBand(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < LEASE_MIN_S ||
    seconds > LEASE_CAP_S
  ) {
    return `lease: a lease is ${LEASE_MIN_S} to ${LEASE_CAP_S} seconds`;
  }
  return null;
}

/** Whether a task's record is in a state an edit of its root can hold. */
export function holdableByEdit(state: TaskState): boolean {
  return (HOLDABLE_STATES as readonly string[]).includes(state);
}

// ---------------------------------------------------------------------------
// The move: what a task write itself says came of it. Board's own engine
// appends the task's events beside the write; here the write stamps the same
// plan into its metadata (`<ns>.move`), and the feed's translator reads it —
// so the events a row carries are the write's own word, exact however late
// the reader arrives, with no diff guessed from a state the reader never saw.
// ---------------------------------------------------------------------------

/** The task state events a feed carries. */
export type TaskEventType =
  | "task.created"
  | "task.ready"
  | "task.claimed"
  | "task.renewed"
  | "task.released"
  | "task.expired"
  | "task.completed"
  | "task.failed"
  | "task.blocked"
  | "task.unblocked"
  | "task.canceled"
  | "task.reopened"
  | "task.assigned"
  | "task.needs_changed";

/** One event of a move: its type, the state the task wears as the event leaves it, and the state it wrote from. */
export interface TaskMoveEntry {
  type: TaskEventType;
  state: TaskState;
  /** The state the task wore before the write, when it moved. */
  from?: TaskState;
}

/** A write's stamped move: a fresh nonce, and the events it carried. */
export interface TaskMove {
  n: string;
  events: TaskMoveEntry[];
}

/** The metadata key the move rides (outside the record, which views decode). */
export function moveKeyOf(namespace: string): string {
  return `${namespace}.move`;
}

/** Decode a metadata blob's stamped move, tolerantly, or null. */
export function readMove(
  codec: MetadataCodec,
  metadata: unknown,
): TaskMove | null {
  const blob = asRecord(metadata);
  if (blob === null) return null;
  const raw = blob[moveKeyOf(codec.namespace)];
  const record = asRecord(raw);
  if (record === null || typeof record.n !== "string" || record.n === "") {
    return null;
  }
  if (!Array.isArray(record.events)) return null;
  const events: TaskMoveEntry[] = [];
  for (const entry of record.events) {
    const one = asRecord(entry);
    if (one === null || typeof one.type !== "string" || !isState(one.state)) {
      return null;
    }
    events.push({
      type: one.type as TaskEventType,
      state: one.state,
      ...(isState(one.from) ? { from: one.from } : {}),
    });
  }
  if (events.length === 0) return null;
  return { n: record.n, events };
}

/** A fresh move nonce: two writes of one task never share one. */
export function newMoveNonce(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/** The metadata patch entry a move rides under. */
export function movePatch(
  codec: MetadataCodec,
  move: TaskMove,
): Record<string, JsonValue> {
  const events: JsonValue[] = move.events.map((entry) => ({
    type: entry.type,
    state: entry.state,
    ...(entry.from !== undefined ? { from: entry.from } : {}),
  }));
  return { [moveKeyOf(codec.namespace)]: { n: move.n, events } };
}
