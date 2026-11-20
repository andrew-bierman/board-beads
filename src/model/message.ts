import type {
  BdIssue,
  BdRunFn,
  BoardAuthor,
  Conflict,
  EncodeResult,
  JsonValue,
  LabelsApi,
  MessageAuthorIdentity,
  MessageOrigin,
  MessageMeta,
  MetadataCodec,
  NotFound,
  ReadResult,
  ThreadCapability,
} from "./types.ts";
import type { MessageView } from "@vercel/board";
import { findBlocks } from "@vercel/board/schemas";
import { randomUUID } from "node:crypto";

/** A fence that names a schema and holds a JSON object, as clients see it. */
function blocksOf(text: string): MessageView["blocks"] {
  return findBlocks(text)
    .filter((block) => block.data !== undefined)
    .map((block) => ({
      schema: block.name ?? block.id,
      version: block.version ?? 1,
      data: block.data as Record<string, unknown>,
    }));
}

/** Longest derived title, in code points, plus the ellipsis when cut. */
const TITLE_MAX = 72;
const TITLE_FALLBACK = "board message";

/**
 * A deterministic issue title for a message's text: the whole text whitespace-collapsed
 * to one line, cut on code points so emoji and CJK never split.
 */
export function deriveTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return TITLE_FALLBACK;
  const chars = Array.from(collapsed);
  if (chars.length <= TITLE_MAX) return collapsed;
  return `${chars.slice(0, TITLE_MAX).join("")}…`;
}

/** A message's bd create spec: title, text, bd labels, and the encoded metadata blob. */
export interface PostSpec {
  title: string;
  description: string;
  labels: string[];
  metadata: Record<string, JsonValue>;
}

/** Everything a post needs to become a bd issue, before any bd call happens. */
export function postToIssueSpec(
  input: { meta: MessageMeta; text: string; bdLabels?: readonly string[] },
  codec: MetadataCodec,
): EncodeResult<PostSpec> {
  const encoded = codec.encodeMessage(input.meta);
  if (!encoded.ok) return encoded;
  return {
    ok: true,
    value: {
      title: deriveTitle(input.text),
      description: input.text,
      labels: [...(input.bdLabels ?? [])],
      metadata: encoded.value,
    },
  };
}

/** Everything the message view needs besides the issue row itself. */
export interface ViewDeps {
  codec: MetadataCodec;
  labels: LabelsApi;
  /** The author identity for a bd actor slug, or null when it maps to no one. */
  authorFor: (slug: string | null) => MessageAuthorIdentity | null;
  /** The issue's bd label strings (`bd label list`), when already fetched. */
  bdLabels?: readonly string[];
}

/**
 * One bd issue → one Board message view. A null issue answers not-found; an issue whose
 * metadata is absent, corrupt, foreign, or of another schema version also answers
 * not-found — it is not a readable message — and none of that throws, so one bad issue
 * never poisons its neighbors.
 */
export function issueToMessage(
  issue: BdIssue | null,
  deps: ViewDeps,
): ReadResult<MessageView> {
  if (issue === null) return NOT_FOUND;
  const decoded = deps.codec.decode(issue.metadata);
  if (!decoded.ok || decoded.value.role !== "message") return NOT_FOUND;
  const meta: MessageMeta = decoded.value;

  const isRoot = meta.thread === issue.id;
  const identity = deps.authorFor(issue.created_by ?? null);
  const by: BoardAuthor = identity?.by ?? {
    actor: issue.created_by ?? "",
    principal: "",
    profile: null,
  };

  return {
    ok: true,
    value: {
      id: issue.id,
      channel: meta.channel,
      text: issue.description ?? "",
      re: isRoot ? null : meta.thread,
      replyTo:
        meta.parent === null || meta.parent === meta.thread
          ? null
          : meta.parent,
      thread: meta.thread,
      labels: deps.labels.fromBdLabels(deps.bdLabels ?? []),
      reactions: meta.reactions,
      by,
      noSync: meta.noSync,
      origin: (meta.origin ?? null) as MessageOrigin,
      from: meta.from,
      createdAt: issue.created_at ?? "",
      editedAt: meta.editedAt,
      deleted: meta.deleted,
      undelivered: {},
      attachments: [],
      links: [],
      blocks: blocksOf(issue.description ?? ""),
      version: meta.version,
      revision: meta.revision,
      author: identity?.view ?? null,
    },
  };
}

const NOT_FOUND: NotFound = { ok: false, code: "not_found" };

/**
 * The reply-after fence: `after` names the message this reply follows in its thread's
 * order. When another reply already recorded that slot — tombstones included, since its
 * metadata persists — the fence answers `newer_message` naming it.
 */
export function checkReplyAfter(
  replies: readonly { id: string; after: string | null }[],
  afterId: string,
): Conflict | null {
  for (const reply of replies) {
    if (reply.after === afterId)
      return { code: "newer_message", newer: reply.id };
  }
  return null;
}

/**
 * The native thread link: the reply's issue depends on the one it replies to with a
 * `replies-to` dep. Built when the bind-time probe said the installed bd supports it;
 * `bb.parent` metadata carries the same reference regardless, as the fallback.
 */
export function repliesToDepArgs(childId: string, parentId: string): string[] {
  return ["dep", "add", childId, parentId, "--type", "replies-to"];
}

/**
 * The bind-time capability probe: can this bd write native `replies-to` deps? Answers
 * from a live write against the runner's own tracker — two throwaway issues, one dep,
 * both issues deleted after — never from a hardcoded version guess.
 */
export async function probeRepliesTo(run: BdRunFn): Promise<ThreadCapability> {
  const marker = randomUUID().slice(0, 8);
  const created = await run([
    "create",
    `board-beads probe ${marker}`,
    "--silent",
  ]);
  if (created.code !== 0) return { repliesTo: false };
  const parentId = created.stdout.trim();
  const replied = await run([
    "create",
    `board-beads probe reply ${marker}`,
    "--silent",
  ]);
  if (replied.code !== 0) {
    await run(["delete", parentId, "--force"]).catch(() => undefined);
    return { repliesTo: false };
  }
  const childId = replied.stdout.trim();
  const dep = await run(repliesToDepArgs(childId, parentId));
  // Cleanup is best-effort: the probe must never leave its temp issues behind when it can help it.
  await run(["delete", childId, "--force"]).catch(() => undefined);
  await run(["delete", parentId, "--force"]).catch(() => undefined);
  return { repliesTo: dep.code === 0 };
}
