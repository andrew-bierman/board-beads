import { createHash } from "node:crypto";
import type { ActorAssignments, MapPrincipalResult } from "./types.ts";

export const emptyActorAssignments: ActorAssignments = { principals: {} };

/**
 * The slug a principal maps to, deterministically: a sanitized readable base plus a
 * short digest of the exact principal. The digest makes it bijective in practice while
 * sanitizing keeps hostile principals (spaces, unicode, control chars, any length)
 * inside a valid BEADS_ACTOR slug, reproducibly.
 */
export function deriveActorSlug(principal: string): string {
  const digest = createHash("sha256")
    .update(principal, "utf8")
    .digest("hex")
    .slice(0, 8);
  const base = principal
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base.length > 0 ? `${base}-${digest}` : digest;
}

/**
 * Map a principal to its slug, recording the assignment. Remapping a principal already
 * present returns its existing slug unchanged — restart-stable fencing. A slug held by
 * someone else (or reserved, e.g. the system actor's) answers a typed collision, never
 * a silent reuse.
 */
export function mapPrincipal(
  assignments: ActorAssignments,
  principal: string,
  options?: { reserved?: readonly string[] },
): MapPrincipalResult {
  if (principal.trim().length === 0) {
    return {
      ok: false,
      error: { code: "invalid_principal", principal },
    };
  }
  const existing = assignments.principals[principal];
  if (existing !== undefined) {
    return { ok: true, value: { assignments, slug: existing } };
  }
  const slug = deriveActorSlug(principal);
  for (const [other, taken] of Object.entries(assignments.principals)) {
    if (taken === slug) {
      return {
        ok: false,
        error: { code: "actor_collision", principal, slug, heldBy: other },
      };
    }
  }
  if (options?.reserved?.includes(slug)) {
    return {
      ok: false,
      error: { code: "actor_collision", principal, slug, heldBy: null },
    };
  }
  return {
    ok: true,
    value: {
      assignments: {
        principals: { ...assignments.principals, [principal]: slug },
      },
      slug,
    },
  };
}

/** Reverse resolution for author views: the principal a bd actor slug belongs to. */
export function principalForSlug(
  assignments: ActorAssignments,
  slug: string,
): string | null {
  for (const [principal, mapped] of Object.entries(assignments.principals)) {
    if (mapped === slug) return principal;
  }
  return null;
}

/** The slug a principal is mapped to, or null when it has never been mapped. */
export function slugForPrincipal(
  assignments: ActorAssignments,
  principal: string,
): string | null {
  return assignments.principals[principal] ?? null;
}
