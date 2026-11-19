import { afterAll, describe, expect, test } from "bun:test";
import {
  type BdFixture,
  createBdFixture,
} from "../../test/helpers/bd-fixture.ts";
import {
  applyDelete,
  applyReaction,
  createMetadataCodec,
  initialMessageMeta,
} from "./metadata.ts";
import { createLabels } from "./labels.ts";
import {
  checkReplyAfter,
  deriveTitle,
  issueToMessage,
  postToIssueSpec,
  probeRepliesTo,
  repliesToDepArgs,
} from "./message.ts";
import type { BdIssue, MessageAuthorIdentity, MessageMeta } from "./types.ts";

describe("title derivation", () => {
  test("collapses to one line, deterministic", () => {
    expect(deriveTitle("  fix the\n\nbug   now\nsecond line")).toBe(
      "fix the bug now second line",
    );
    expect(deriveTitle("same text")).toBe(deriveTitle("same text"));
  });

  test("truncates by code points — emoji and CJK never split", () => {
    const long = "🚀".repeat(100);
    const title = deriveTitle(long);
    expect(Array.from(title).length).toBeLessThanOrEqual(73);
    expect(title.endsWith("…")).toBeTrue();
    const cjk = deriveTitle("爱".repeat(100));
    expect(Array.from(cjk).length).toBeLessThanOrEqual(73);
  });

  test("blank text falls back to a stable placeholder", () => {
    expect(deriveTitle("")).toBe(deriveTitle("   \n  "));
  });
});

describe("post spec", () => {
  const codec = createMetadataCodec();

  test("carries title, text, bd labels, and encoded metadata", () => {
    const meta = initialMessageMeta({ channel: "dev", thread: "root-1" });
    const spec = postToIssueSpec(
      { meta, text: "hello board", bdLabels: ["bb.channel=dev", "triage"] },
      codec,
    );
    expect(spec.ok).toBeTrue();
    if (!spec.ok) return;
    expect(spec.value.title).toBe("hello board");
    expect(spec.value.description).toBe("hello board");
    expect(spec.value.labels).toEqual(["bb.channel=dev", "triage"]);
    expect(spec.value.metadata["bb.v"]).toBe(1);
  });

  test("hostile text round-trips through the spec unchanged", () => {
    const meta = initialMessageMeta({ channel: "dev", thread: "root-1" });
    const text = "爱 🚀 line1\nline2\ttab \u0000end";
    const spec = postToIssueSpec({ meta, text, bdLabels: [] }, codec);
    expect(spec.ok).toBeTrue();
    if (!spec.ok) return;
    expect(spec.value.description).toBe(text);
  });

  test("oversized metadata is refused before a write", () => {
    const meta = initialMessageMeta({ channel: "dev", thread: "r" });
    meta.reactions = { x: Array.from({ length: 100_000 }, () => "a") };
    const spec = postToIssueSpec({ meta, text: "t", bdLabels: [] }, codec);
    expect(spec).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "metadata_too_large" }),
    });
  });
});

describe("issue to message view", () => {
  const codec = createMetadataCodec();
  const labels = createLabels();
  const authorFor = (slug: string | null): MessageAuthorIdentity | null =>
    slug === "alice-aaaa"
      ? {
          by: {
            actor: "alice-aaaa",
            principal: "user:acme/alice",
            profile: null,
          },
          view: { kind: "agent", handle: "alice", name: "Alice", avatar: null },
        }
      : null;
  const deps = { codec, labels, authorFor };

  const issue = (over: Partial<BdIssue>): BdIssue => ({
    id: "root-1",
    title: "hello",
    description: "hello body",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    created_by: "alice-aaaa",
    ...over,
  });

  const withMeta = (row: BdIssue, meta: MessageMeta): BdIssue => {
    const encoded = codec.encodeMessage(meta);
    if (!encoded.ok) throw new Error("test meta failed to encode");
    return { ...row, metadata: encoded.value };
  };

  test("a root maps with re and replyTo null", () => {
    const meta = initialMessageMeta({ channel: "dev", thread: "root-1" });
    const view = issueToMessage(withMeta(issue({}), meta), {
      ...deps,
      bdLabels: ["triage", "board.task=ready", "bb.secret=1"],
    });
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.value.id).toBe("root-1");
    expect(view.value.channel).toBe("dev");
    expect(view.value.text).toBe("hello body");
    expect(view.value.thread).toBe("root-1");
    expect(view.value.re).toBeNull();
    expect(view.value.replyTo).toBeNull();
    expect(view.value.version).toBe(1);
    expect(view.value.revision).toBe(1);
    expect(view.value.deleted).toBeFalse();
    expect(view.value.labels).toEqual({ triage: "", "board.task": "ready" });
    expect(view.value.author?.handle).toBe("alice");
    expect(view.value.by).toEqual({
      actor: "alice-aaaa",
      principal: "user:acme/alice",
      profile: null,
    });
    expect(view.value.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(view.value.reactions).toEqual({});
    expect(view.value.blocks).toEqual([]);
    expect(view.value.attachments).toEqual([]);
    expect(view.value.links).toEqual([]);
  });

  test("a reply to the root maps re to the thread and replyTo null", () => {
    const meta = initialMessageMeta({
      channel: "dev",
      thread: "root-1",
      parent: "root-1",
      after: "root-1",
    });
    const view = issueToMessage(
      withMeta(issue({ id: "reply-1", description: "reply" }), meta),
      deps,
    );
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.value.re).toBe("root-1");
    expect(view.value.replyTo).toBeNull();
    expect(view.value.thread).toBe("root-1");
  });

  test("a reply to a reply maps replyTo to the direct parent", () => {
    const meta = initialMessageMeta({
      channel: "dev",
      thread: "root-1",
      parent: "reply-1",
      after: "reply-1",
    });
    const view = issueToMessage(
      withMeta(issue({ id: "reply-2", description: "nested" }), meta),
      deps,
    );
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.value.re).toBe("root-1");
    expect(view.value.replyTo).toBe("reply-1");
  });

  test("a tombstone stays readable with deleted set", () => {
    const meta = applyDelete(
      initialMessageMeta({ channel: "dev", thread: "root-1" }),
    );
    const view = issueToMessage(withMeta(issue({}), meta), deps);
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.value.deleted).toBeTrue();
    expect(view.value.text).toBe("hello body");
  });

  test("absent issue and corrupt metadata answer not-found, typed", () => {
    expect(issueToMessage(null, deps)).toEqual({
      ok: false,
      code: "not_found",
    });
    const corrupt = issue({ metadata: "{{nope" });
    expect(issueToMessage(corrupt, deps)).toEqual({
      ok: false,
      code: "not_found",
    });
    const foreign = issue({ metadata: { someOtherBoard: true } });
    expect(issueToMessage(foreign, deps)).toEqual({
      ok: false,
      code: "not_found",
    });
    // The corrupt issue didn't poison the healthy one.
    const meta = initialMessageMeta({ channel: "dev", thread: "root-1" });
    expect(issueToMessage(withMeta(issue({}), meta), deps).ok).toBeTrue();
  });

  test("reactions and emoji keys round-trip into the view", () => {
    const meta = applyReaction(
      applyReaction(
        initialMessageMeta({ channel: "d", thread: "r" }),
        "🙂‍↔️",
        "alice-aaaa",
      ),
      "👍",
      "alice-aaaa",
    );
    const view = issueToMessage(withMeta(issue({}), meta), deps);
    expect(view.ok).toBeTrue();
    if (!view.ok) return;
    expect(view.value.reactions).toEqual({
      "🙂‍↔️": ["alice-aaaa"],
      "👍": ["alice-aaaa"],
    });
    expect(view.value.version).toBe(3);
    expect(view.value.revision).toBe(1);
  });
});

describe("reply-after fence", () => {
  test("a slot with nothing after it is free; a taken slot names the newer reply", () => {
    const replies = [
      { id: "r1", after: "root" },
      { id: "r2", after: "r1" },
      { id: "r3", after: null },
    ];
    expect(checkReplyAfter(replies, "r2")).toBeNull();
    expect(checkReplyAfter(replies, "root")).toEqual({
      code: "newer_message",
      newer: "r1",
    });
  });

  test("a tombstoned reply keeps its after in metadata, so its slot stays taken", () => {
    // r4 is deleted; its metadata bb.after persists, so the fence still fires.
    const replies = [
      { id: "r1", after: "root" },
      { id: "r4", after: "r1" },
    ];
    expect(checkReplyAfter(replies, "r1")).toEqual({
      code: "newer_message",
      newer: "r4",
    });
  });
});

describe("native replies-to threading", () => {
  test("dep args build the replies-to link", () => {
    expect(repliesToDepArgs("reply-1", "root-1")).toEqual([
      "dep",
      "add",
      "reply-1",
      "root-1",
      "--type",
      "replies-to",
    ]);
  });
});

describe("probe against real bd", () => {
  let fixture: BdFixture | undefined;

  afterAll(() => {
    fixture?.close();
  });

  test("the live probe reports repliesTo support and cleans up", async () => {
    fixture = await createBdFixture();
    const capability = await probeRepliesTo(fixture.run);
    expect(capability.repliesTo).toBeTrue();

    // The probe's temp issues are gone.
    const listed = await fixture.run(["list", "--json"]);
    expect(listed.code).toBe(0);
    const issues = JSON.parse(listed.stdout) as Array<{ id: string }>;
    expect(issues).toEqual([]);
  }, 120_000);

  test("bb.v:1 metadata round-trips through real bd storage", async () => {
    fixture ??= await createBdFixture();
    const codec = createMetadataCodec();
    const meta = initialMessageMeta({ channel: "频道", thread: "root-x" });
    meta.reactions = { "👍": ["alice", "bob"] };
    const encoded = codec.encodeMessage(meta);
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) return;
    const created = await fixture.run([
      "create",
      "meta probe",
      "--metadata",
      JSON.stringify(encoded.value),
      "--json",
    ]);
    expect(created.code).toBe(0);
    const row = JSON.parse(created.stdout) as { id: string };
    const shown = await fixture.run(["show", row.id, "--json"]);
    expect(shown.code).toBe(0);
    const rows = JSON.parse(shown.stdout) as Array<{ metadata: unknown }>;
    const decoded = codec.decode(rows[0]?.metadata);
    expect(decoded).toEqual({ ok: true, value: meta });
  }, 120_000);
});
