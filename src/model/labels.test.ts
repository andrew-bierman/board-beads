import { describe, expect, test } from "bun:test";
import { createLabels } from "./labels.ts";

describe("label namespaces", () => {
  test("board.* caller labels are rejected", () => {
    const labels = createLabels();
    expect(labels.guardCallerLabels({ "board.task": "claimed" })).toEqual({
      ok: false,
      error: { code: "reserved_label", label: "board.task" },
    });
    expect(labels.guardCallerLabel("board.x")).toEqual({
      code: "reserved_label",
      label: "board.x",
    });
  });

  test("our namespace is rejected from callers under the default namespace", () => {
    const labels = createLabels();
    expect(labels.guardCallerLabels({ "bb.channel": "dev" })).toEqual({
      ok: false,
      error: { code: "reserved_label", label: "bb.channel" },
    });
    expect(labels.isOwnLabel("bb.channel")).toBeTrue();
    expect(labels.isOwnLabel("bb")).toBeFalse();
    expect(labels.isOwnLabel("bbb.x")).toBeFalse();
  });

  test("namespace is a parameter", () => {
    const labels = createLabels({ namespace: "acme" });
    expect(labels.isOwnLabel("acme.thread")).toBeTrue();
    expect(labels.guardCallerLabels({ "acme.thread": "t" })).toEqual({
      ok: false,
      error: { code: "reserved_label", label: "acme.thread" },
    });
    // bb.* is no longer ours under acme, and plain labels pass.
    expect(labels.isOwnLabel("bb.thread")).toBeFalse();
    expect(labels.guardCallerLabels({ "bb.thread": "t", plain: "" })).toEqual({
      ok: true,
    });
  });

  test("plain caller labels pass", () => {
    const labels = createLabels();
    expect(
      labels.guardCallerLabels({ triage: "", "release-blocker": "rc1" }),
    ).toEqual({ ok: true });
  });

  test("a label name carrying the = separator is a typed rejection", () => {
    const labels = createLabels();
    expect(labels.guardCallerLabel("a=b")).toEqual({
      code: "invalid_label",
      label: "a=b",
    });
    expect(labels.guardCallerLabel("")).toEqual({
      code: "invalid_label",
      label: "",
    });
    expect(labels.guardCallerLabels({ "a=b": "v" }).ok).toBeFalse();
  });
});

describe("board labels to bd labels", () => {
  const labels = createLabels();

  test("encodes values with = and bare names without, sorted", () => {
    expect(labels.toBdLabels({ b: "2", a: "1", bare: "" })).toEqual([
      "a=1",
      "b=2",
      "bare",
    ]);
    expect(labels.toBdLabels({})).toEqual([]);
  });

  test("round-trips, including values that themselves contain =", () => {
    const source = { triage: "", "release-blocker": "rc=1", 爱: "🚀" };
    const roundTripped = labels.fromBdLabels(labels.toBdLabels(source));
    expect(roundTripped).toEqual(source);
  });

  test("hostile values (unicode, emoji, CJK, newlines) round-trip unchanged", () => {
    const source = {
      note: "line1\nline2\ttab \u0000ctrl",
      emoji: "🙂‍↔️",
    };
    expect(labels.fromBdLabels(labels.toBdLabels(source))).toEqual(source);
  });
});

describe("bd labels to board labels", () => {
  const labels = createLabels();

  test("our bb.* labels never leak to callers", () => {
    expect(
      labels.fromBdLabels(["bb.channel=dev", "bb.ch:general", "plain", "a=1"]),
    ).toEqual({ plain: "", a: "1" });
  });

  test("board.* labels are Board's own and stay visible", () => {
    expect(labels.fromBdLabels(["board.task=ready", "x"])).toEqual({
      "board.task": "ready",
      x: "",
    });
  });

  test("our namespace follows the parameter", () => {
    const acme = createLabels({ namespace: "acme" });
    expect(acme.fromBdLabels(["acme.ch=dev", "bb.ch=dev", "keep"])).toEqual({
      "bb.ch": "dev",
      keep: "",
    });
  });
});
