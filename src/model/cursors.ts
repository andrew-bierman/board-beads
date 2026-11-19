import type { CursorResult, InvalidCursor } from "./types.ts";

/** A bd issue id, as the message cursor: opaque, equality-only. */
export interface MessageCursor {
  readonly id: string;
}

/**
 * A thread's activity boundary, as the composite `older` cursor's value. Deterministic
 * order = `updated_at` first (parsed to epoch ms), then the issue id breaking ties.
 */
export interface ThreadBoundary {
  updated_at: string;
  id: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,127}$/;

const invalid: InvalidCursor = { ok: false, code: "invalid_cursor" };

/** The message cursor is the bd issue id itself — opaque, never ordered by. */
export function encodeMessageCursor(id: string): string {
  return id;
}

export function decodeMessageCursor(raw: string): CursorResult<string> {
  return ID_PATTERN.test(raw) ? { ok: true, value: raw } : invalid;
}

/**
 * The threads `older` cursor: the boundary's `{updated_at, id}` pair, base64url-encoded
 * JSON. Opaque to callers; decodes only what this exact shape produced.
 */
export function encodeOlderCursor(boundary: ThreadBoundary): string {
  return Buffer.from(
    JSON.stringify([boundary.updated_at, boundary.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeOlderCursor(raw: string): CursorResult<ThreadBoundary> {
  let decoded: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    decoded = JSON.parse(json) as unknown;
  } catch {
    return invalid;
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return invalid;
  const [updatedAt, id] = decoded as unknown[];
  if (
    typeof updatedAt !== "string" ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return invalid;
  }
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return invalid;
  return { ok: true, value: { updated_at: updatedAt, id } };
}

/**
 * Deterministic boundary order, ascending: activity time first, id second. Pages build
 * on this so equal timestamps never reorder between reads.
 */
export function compareThreadBoundary(
  a: ThreadBoundary,
  b: ThreadBoundary,
): number {
  const at = Date.parse(a.updated_at);
  const bt = Date.parse(b.updated_at);
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The event cursor is the journal sequence, carried as its decimal string. */
export function encodeEventCursor(seq: number): string {
  return String(seq);
}

export function decodeEventCursor(raw: string): CursorResult<number> {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return invalid;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) ? { ok: true, value: seq } : invalid;
}
