import { describe, expect, test } from "bun:test";
import {
  METADATA_BYTE_LIMIT,
  applyDelete,
  applyEdit,
  applyLabelsChanged,
  applyReaction,
  checkRevisionFence,
  createMetadataCodec,
  createWriteGate,
  initialBackendMeta,
  initialMessageMeta,
} from "./metadata.ts";
import type { MessageMeta } from "./metadata.ts";

describe("message metadata counters", () => {
  const base = (): MessageMeta =>
    initialMessageMeta({ channel: "dev", thread: "root-1" });

  test("create starts at version 1 / revision 1", () => {
    const meta = base();
    expect(meta.version).toBe(1);
    expect(meta.revision).toBe(1);
    expect(meta.deleted).toBeFalse();
    expect(meta.reactions).toEqual({});
    expect(meta.parent).toBeNull();
    expect(meta.after).toBeNull();
  });

  test("edit bumps version and revision, stamps editedAt", () => {
    const edited = applyEdit(base(), "2026-01-01T00:00:00Z");
    expect(edited.version).toBe(2);
    expect(edited.revision).toBe(2);
    expect(edited.editedAt).toBe("2026-01-01T00:00:00Z");
  });

  test("react bumps version only", () => {
    const edited = applyEdit(base(), "2026-01-01T00:00:00Z");
    const reacted = applyReaction(edited, "👍", "alice");
    expect(reacted.version).toBe(3);
    expect(reacted.revision).toBe(2);
    expect(reacted.reactions["👍"]).toEqual(["alice"]);
  });

  test("react remove drops the actor, still revision only", () => {
    const withReaction = applyReaction(base(), "👍", "alice");
    const removed = applyReaction(withReaction, "👍", "alice", true);
    expect(removed.version).toBe(3);
    expect(removed.revision).toBe(1);
    expect(removed.reactions["👍"]).toEqual([]);
  });

  test("label change bumps version only", () => {
    const labeled = applyLabelsChanged(base());
    expect(labeled.version).toBe(2);
    expect(labeled.revision).toBe(1);
  });

  test("delete sets the tombstone and bumps both counters", () => {
    const deleted = applyDelete(base());
    expect(deleted.deleted).toBeTrue();
    expect(deleted.version).toBe(2);
    expect(deleted.revision).toBe(2);
  });

  test("stale revision write yields a revision_conflict result", () => {
    const edited = applyEdit(base(), "2026-01-01T00:00:00Z");
    // A writer that read revision 1 now writes against the current 2.
    expect(checkRevisionFence(edited, 1)).toEqual({
      code: "revision_conflict",
      revision: 2,
    });
    expect(checkRevisionFence(edited, 2)).toBeNull();
    // An unfenced write (no revision given) is never refused here.
    expect(checkRevisionFence(edited)).toBeNull();
  });
});

describe("metadata codec", () => {
  test("bb.v:1 encode/decode round-trips a full message meta", () => {
    const codec = createMetadataCodec();
    const meta: MessageMeta = {
      ...initialMessageMeta({ channel: "dev", thread: "root-1" }),
      parent: "root-1",
      after: "mid-1",
      client: "client-7",
      noSync: true,
      from: "slack",
      reactions: { "👍": ["alice", "bob"] },
      external: { "slack:C1": { thread: "C1", message: "m1" } },
      claim: { epoch: 2, token: "tok", until: "2026-01-01T01:00:00Z" },
      epoch: 2,
    };
    const encoded = codec.encodeMessage(meta);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value["bb.v"]).toBe(1);
    expect(encoded.value["bb.channel"]).toBe("dev");
    const decoded = codec.decode(encoded.value);
    expect(decoded).toEqual({ ok: true, value: meta });
  });

  test("namespace is a parameter: acme keys encode and decode under acme", () => {
    const codec = createMetadataCodec({ namespace: "acme" });
    const meta = initialMessageMeta({ channel: "dev", thread: "r" });
    const encoded = codec.encodeMessage(meta);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value["acme.v"]).toBe(1);
    expect(encoded.value["acme.channel"]).toBe("dev");
    expect(codec.decode(encoded.value)).toEqual({ ok: true, value: meta });
  });

  test("another namespace's metadata reads as foreign, never as ours", () => {
    const acme = createMetadataCodec({ namespace: "acme" });
    const bb = createMetadataCodec();
    const encoded = acme.encodeMessage(
      initialMessageMeta({ channel: "d", thread: "r" }),
    );
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(bb.decode(encoded.value)).toEqual({ ok: false, reason: "foreign" });
  });

  test("corrupt and absent metadata decode to typed reasons, not throws", () => {
    const codec = createMetadataCodec();
    expect(codec.decode(undefined)).toEqual({ ok: false, reason: "absent" });
    expect(codec.decode(null)).toEqual({ ok: false, reason: "absent" });
    expect(codec.decode("{{not json")).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(codec.decode(42)).toEqual({ ok: false, reason: "corrupt" });
    expect(codec.decode({ "bb.v": "one" })).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(codec.decode({})).toEqual({ ok: false, reason: "foreign" });
    expect(codec.decode({ "bb.v": 2 })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
    expect(codec.decode({ "bb.v": 1 })).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(codec.decode({ "bb.v": 1, "bb.role": "message" })).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(codec.decode({ "bb.v": 1, "bb.role": "martians" })).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  test("one corrupt issue does not poison a healthy neighbor", () => {
    const codec = createMetadataCodec();
    const healthy = codec.encodeMessage(
      initialMessageMeta({ channel: "d", thread: "r" }),
    );
    expect(healthy.ok).toBeTrue();
    if (!healthy.ok) return;
    expect(codec.decode({ garbage: true }).ok).toBeFalse();
    expect(codec.decode(healthy.value).ok).toBeTrue();
  });

  test("oversized metadata answers a typed limit error before any write", () => {
    const codec = createMetadataCodec();
    const bloated: MessageMeta = {
      ...initialMessageMeta({ channel: "d", thread: "r" }),
      reactions: { x: Array.from({ length: METADATA_BYTE_LIMIT }, () => "a") },
    };
    const encoded = codec.encodeMessage(bloated);
    expect(encoded).toEqual({
      ok: false,
      error: {
        code: "metadata_too_large",
        bytes: expect.any(Number),
        limit: METADATA_BYTE_LIMIT,
      },
    });
    const fatBackend = initialBackendMeta();
    const big: Record<string, string> = {};
    for (let i = 0; i < METADATA_BYTE_LIMIT; i++) big[`p${i}`] = "s";
    fatBackend.actors = big;
    expect(codec.encodeBackend(fatBackend).ok).toBeFalse();
  });

  test("backend meta (actor map) round-trips", () => {
    const codec = createMetadataCodec();
    const meta = initialBackendMeta();
    meta.actors = { "user:acme/alice": "alice-1a2b3c4d" };
    const encoded = codec.encodeBackend(meta);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(encoded.value["bb.role"]).toBe("backend");
    expect(codec.decode(encoded.value)).toEqual({ ok: true, value: meta });
  });

  test("unicode, emoji, CJK, and control chars survive encode/decode unchanged", () => {
    const codec = createMetadataCodec();
    const meta: MessageMeta = {
      ...initialMessageMeta({
        channel: "频道-🚀",
        thread: "root-\u0001id",
      }),
      reactions: { " 🙂‍↔️ ": ["爱丽丝\u0000"] },
    };
    const encoded = codec.encodeMessage(meta);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    expect(codec.decode(encoded.value)).toEqual({ ok: true, value: meta });
  });
});

describe("per-issue write gate", () => {
  test("two concurrent gated mutations on one id serialize", async () => {
    const gate = createWriteGate();
    const state: string[] = [];
    const order: string[] = [];
    const first = gate.run("issue-1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      state.push("first");
      order.push("first");
      return state.join(",");
    });
    const second = gate.run("issue-1", async () => {
      order.push("second");
      // Sees the first write's effect: the gate serialized them.
      return state.join(",");
    });
    expect(await first).toBe("first");
    expect(await second).toBe("first");
    expect(order).toEqual(["first", "second"]);
  });

  test("the gate releases when a gated op throws", async () => {
    const gate = createWriteGate();
    const boom = gate.run("issue-2", async () => {
      throw new Error("bd update failed");
    });
    expect(boom).rejects.toThrow("bd update failed");
    const after = await gate.run("issue-2", async () => "recovered");
    expect(after).toBe("recovered");
  });

  test("different ids do not serialize behind each other", async () => {
    const gate = createWriteGate();
    const order: string[] = [];
    const slow = gate.run("slow", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
    });
    const quick = gate.run("quick", async () => {
      order.push("quick");
    });
    await Promise.all([slow, quick]);
    expect(order).toEqual(["quick", "slow"]);
  });
});
