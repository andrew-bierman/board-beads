import { describe, expect, test } from "bun:test";
import {
  deriveActorSlug,
  emptyActorAssignments,
  mapPrincipal,
  principalForSlug,
  slugForPrincipal,
} from "./actors.ts";

describe("principal to slug mapping", () => {
  test("stable across remap", () => {
    const first = mapPrincipal(emptyActorAssignments, "user:acme/alice");
    expect(first.ok).toBeTrue();
    if (!first.ok) return;
    const again = mapPrincipal(first.value.assignments, "user:acme/alice");
    expect(again.ok).toBeTrue();
    if (!again.ok) return;
    expect(again.value.slug).toBe(first.value.slug);
    expect(again.value.assignments).toEqual(first.value.assignments);
    expect(deriveActorSlug("user:acme/alice")).toBe(first.value.slug);
  });

  test("distinct principals map to distinct slugs", () => {
    const a = deriveActorSlug("user:acme/alice");
    const b = deriveActorSlug("user:acme/bob");
    expect(a).not.toBe(b);
    const assignments = emptyActorAssignments;
    const mappedA = mapPrincipal(assignments, "user:acme/alice");
    const mappedB = mapPrincipal(
      mappedA.ok ? mappedA.value.assignments : assignments,
      "user:acme/bob",
    );
    expect(mappedA.ok).toBeTrue();
    expect(mappedB.ok).toBeTrue();
  });

  test("a slug already held by another principal answers a typed collision", () => {
    // Bob holds the slug alice would derive (what a hash collision would look like).
    const aliceSlug = deriveActorSlug("user:acme/alice");
    const result = mapPrincipal(
      { principals: { "user:acme/bob": aliceSlug } },
      "user:acme/alice",
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "actor_collision",
        principal: "user:acme/alice",
        slug: aliceSlug,
        heldBy: "user:acme/bob",
      },
    });
  });

  test("a reserved slug (the system actor) answers a typed collision", () => {
    const result = mapPrincipal(emptyActorAssignments, "user:acme/alice", {
      reserved: [deriveActorSlug("user:acme/alice")],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "actor_collision",
        principal: "user:acme/alice",
        slug: deriveActorSlug("user:acme/alice"),
        heldBy: null,
      },
    });
  });

  test("reverse lookup resolves principal from slug", () => {
    const mapped = mapPrincipal(emptyActorAssignments, "user:acme/alice");
    expect(mapped.ok).toBeTrue();
    if (!mapped.ok) return;
    expect(principalForSlug(mapped.value.assignments, mapped.value.slug)).toBe(
      "user:acme/alice",
    );
    expect(principalForSlug(mapped.value.assignments, "nobody-000")).toBeNull();
    expect(slugForPrincipal(mapped.value.assignments, "user:acme/alice")).toBe(
      mapped.value.slug,
    );
    expect(
      slugForPrincipal(mapped.value.assignments, "user:acme/bob"),
    ).toBeNull();
  });

  test("hostile principals sanitize deterministically into valid slugs", () => {
    const hostile = [
      "alice smith",
      "  Alice@ACME  ",
      "爱丽丝🚀",
      "ali\u0000ce\u0007",
      `${"x".repeat(500)}`,
    ];
    const slugs = hostile.map(deriveActorSlug);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug.length).toBeLessThanOrEqual(64);
    }
    // Deterministic and bijective even under hostility.
    expect(hostile.map(deriveActorSlug)).toEqual(slugs);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("an empty principal is a typed rejection", () => {
    expect(mapPrincipal(emptyActorAssignments, "")).toEqual({
      ok: false,
      error: { code: "invalid_principal", principal: "" },
    });
    expect(mapPrincipal(emptyActorAssignments, "   ")).toEqual({
      ok: false,
      error: { code: "invalid_principal", principal: "   " },
    });
  });
});
