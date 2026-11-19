import { describe, expect, test } from "bun:test";
import {
  compareThreadBoundary,
  decodeEventCursor,
  decodeMessageCursor,
  decodeOlderCursor,
  encodeEventCursor,
  encodeMessageCursor,
  encodeOlderCursor,
} from "./cursors.ts";

describe("message cursor (bd issue id)", () => {
  test("round-trips an id", () => {
    const raw = encodeMessageCursor("bb-tracker-x1y2-abc");
    expect(decodeMessageCursor(raw)).toEqual({ ok: true, value: raw });
  });

  test("garbage decodes to invalid-cursor", () => {
    expect(decodeMessageCursor("")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeMessageCursor("has space")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeMessageCursor("!!")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeMessageCursor(`${"a".repeat(129)}`)).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
  });

  test("charset bounds hold: base64url underscores are not an id", () => {
    // Older cursors ride base64url, whose alphabet includes `_`; bd issue ids don't.
    expect(decodeMessageCursor("a_b")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
  });
});

describe("threads older cursor (composite, opaque)", () => {
  test("round-trips updated_at and id", () => {
    const boundary = { updated_at: "2026-01-02T03:04:05Z", id: "bd-9" };
    expect(decodeOlderCursor(encodeOlderCursor(boundary))).toEqual({
      ok: true,
      value: boundary,
    });
  });

  test("garbage of every shape decodes to invalid-cursor", () => {
    expect(decodeOlderCursor("")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeOlderCursor("!!!not base64!!!")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(decodeOlderCursor(b64("[]"))).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeOlderCursor(b64(JSON.stringify(["only-one"])))).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(
      decodeOlderCursor(b64(JSON.stringify(["not-a-date", "id"]))),
    ).toEqual({ ok: false, code: "invalid_cursor" });
    expect(
      decodeOlderCursor(
        b64(JSON.stringify(["2026-01-01T00:00:00Z", "bad id!"])),
      ),
    ).toEqual({ ok: false, code: "invalid_cursor" });
  });

  test("composite ordering is deterministic: time first, then id breaks ties", () => {
    const a = { updated_at: "2026-01-01T00:00:00Z", id: "x" };
    const b = { updated_at: "2026-01-02T00:00:00Z", id: "a" };
    const c = { updated_at: "2026-01-02T00:00:00Z", id: "z" };
    const sameMs = { updated_at: "2026-01-01T00:00:00.500Z", id: "y" };
    const sorted = [c, a, sameMs, b].sort(compareThreadBoundary);
    expect(sorted.map((t) => t.id)).toEqual(["x", "y", "a", "z"]);
    // Stability: comparing either direction twice gives the same answer.
    expect(compareThreadBoundary(b, c)).toBeLessThan(0);
    expect(compareThreadBoundary(c, b)).toBeGreaterThan(0);
  });
});

describe("event cursor (journal seq string)", () => {
  test("round-trips", () => {
    expect(decodeEventCursor(encodeEventCursor(1))).toEqual({
      ok: true,
      value: 1,
    });
    expect(decodeEventCursor(encodeEventCursor(987654))).toEqual({
      ok: true,
      value: 987654,
    });
    expect(decodeEventCursor("0")).toEqual({ ok: true, value: 0 });
  });

  test("garbage decodes to invalid-cursor", () => {
    expect(decodeEventCursor("")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor("abc")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor("1.5")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor("-1")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor("01")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor(" 1")).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor(String(Number.MAX_SAFE_INTEGER + 1))).toEqual({
      ok: false,
      code: "invalid_cursor",
    });
    expect(decodeEventCursor(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
  });
});
