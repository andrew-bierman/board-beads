import { afterAll, describe, expect, test } from "bun:test";
import {
  board,
  BoardError,
  type Backend,
  type Board,
  type BoardBinding,
} from "@vercel/board";
import { block } from "@vercel/board/schemas";
import {
  type BdFixture,
  createBdFixture,
} from "../../test/helpers/bd-fixture.ts";
import { createBoardStore, threadsRoutes } from "./threads.ts";
import { createSchemaRoutes } from "./schemas.ts";
import { createPersistedStore } from "../state/persisted.ts";

/**
 * The schema registry routes, against the real entry path: a fixture tracker,
 * a board() mount over the same registry the backend assembles (threads +
 * schemas), driven through the handle the way the conformance kit drives a
 * board — register once, re-register, refuse the rest. No mocks anywhere.
 *
 * A mount is one backend process: its own store, its own registry document.
 * Mounting twice over one fixture dir is a restart — registered versions
 * live in bd issues, so the second mount reads them back.
 */

/** Collect a call's protocol error instead of failing the test on it. */
async function errorOf(promise: Promise<unknown>): Promise<BoardError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error("expected the call to fail with a protocol error");
}

interface Mount {
  board: Board;
  stop: () => void;
}

/** One backend process over the fixture: threads + the schema registry. */
function mount(dir: string): Mount {
  const store = createBoardStore({ dir });
  const schemas = createSchemaRoutes({ store });
  const backend = {
    keeps: true,
    routes: [],
    ...threadsRoutes(store),
    ...schemas.routes,
    trust: {
      grants: async () => [
        {
          id: "bb-open",
          principals: [{ kind: "everyone" }],
          can: { "*": "all" },
        },
      ],
    },
    bind(binding: BoardBinding) {
      store.bind(binding);
    },
  } as unknown as Backend;
  return {
    board: board({ backend }),
    stop: () => undefined,
  };
}

/** The definition the conformance kit registers, once on every board it checks. */
const SCHEMA = {
  name: "conformance",
  version: 1,
  description:
    "What the conformance kit registers, once on every board it checks.",
  schema: {
    type: "object",
    required: ["run", "outcome"],
    additionalProperties: false,
    properties: {
      run: { type: "string", minLength: 1, maxLength: 64 },
      outcome: { enum: ["passed", "failed"] },
      checks: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            skipped: { type: "boolean" },
          },
        },
      },
    },
  },
} as const;

/** `SCHEMA.schema` with every object's keys reversed: the same definition, as sent again. */
const reversed = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversed)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, child]) => [key, reversed(child)]),
        )
      : value;

describe("schema routes (real bd, mounted through board())", () => {
  let fixture: BdFixture;
  let app: Mount;
  let team: Board;

  afterAll(() => {
    app?.stop();
    fixture?.close();
  });

  test("boots the fixture and mounts the schema routes", async () => {
    fixture = await createBdFixture();
    app = mount(fixture.dir);
    team = app.board;
    const me = await team.me();
    expect(me.principal).toBe("board:client");
  }, 60_000);

  test("a corrupt registry document is skipped by reads and typed by direct gets", async () => {
    const store = createBoardStore({ dir: fixture.dir });
    // Plant garbage where a registry document would be, before any real one exists.
    const garbage = JSON.stringify({
      "bb.v": 1,
      "bb.role": "state",
      "bb.kind": "schema",
      "bb.data": "not-an-object",
    });
    const created = await fixture.run([
      "create",
      "--title=planted corrupt schema",
      "--type=task",
      `--metadata=${garbage}`,
      "--json",
    ]);
    const parsed: unknown = JSON.parse(created.stdout);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const id =
      row !== null && typeof row === "object" && "id" in row
        ? String((row as Record<string, unknown>).id)
        : "";
    await fixture.run(["label", "add", id, "bb.state=schema"]);
    // The list skips it: the built-ins still answer, and no garbage shows.
    const listed = await team.schemas();
    expect(listed.length).toBe(2);
    expect(listed[0]?.id).toBe("git-commit@1");
    // A direct read answers typed, not raw.
    const corrupt = await errorOf(team.schema("nobody@1"));
    expect(corrupt.status).toBe(500);
    expect(corrupt.code).toBe("state_corrupt");
    // The built-in itself is served before the registry is touched.
    const commit = await team.schema("git-commit@1");
    expect(commit.builtIn).toBe(true);
    // And a sibling state kind is untouched by the rotten document.
    const state = createPersistedStore(store);
    await state.put("map", "sibling:one", { sub: "thread", note: "here" });
    const sibling = await state.get("map", "sibling:one");
    expect(sibling?.data.note).toBe("here");
  }, 60_000);

  test("lists the built-ins first, and reads a schema by its id", async () => {
    const listed = await team.schemas();
    const own = listed.findIndex((one) => !one.builtIn);
    expect(own).toBe(-1); // nothing registered yet: the built-ins alone
    const commit = listed.find((one) => one.id === "git-commit@1");
    if (commit === undefined)
      throw new Error("schemas should list git-commit@1");
    expect(commit.name).toBe("git-commit");
    expect(commit.version).toBe(1);
    expect(commit.builtIn).toBe(true);
    expect(commit.by).toBeNull();
    expect(commit.at).toBeNull();
    expect(commit.schema.type).toBe("object");
    const byId = await team.schema("git-commit@1");
    expect(byId).toEqual(commit);
  }, 60_000);

  test("registers a version once: the same definition again changes nothing, another is refused", async () => {
    const made = await team.createSchema({ ...SCHEMA });
    expect(made.created).toBe(true);
    expect(made.schema.id).toBe("conformance@1");
    expect(made.schema.name).toBe("conformance");
    expect(made.schema.version).toBe(1);
    expect(made.schema.description).toBe(SCHEMA.description);
    expect(made.schema.builtIn).toBe(false);
    expect(typeof made.schema.by).toBe("string");
    expect((made.schema.by ?? "").length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(made.schema.at ?? ""))).toBe(false);
    expect(made.schema.schema).toEqual(SCHEMA.schema);

    // The same definition, keys reversed, is the same version.
    const again = await team.createSchema({
      ...SCHEMA,
      schema: reversed(SCHEMA.schema) as Record<string, unknown>,
    });
    expect(again.created).toBe(false);
    expect(again.schema).toEqual(made.schema);

    const otherDefinition = await errorOf(
      team.createSchema({
        ...SCHEMA,
        schema: {
          type: "object",
          required: ["run"],
          properties: { run: { type: "string" } },
        },
      }),
    );
    expect(otherDefinition.status).toBe(409);
    expect(otherDefinition.code).toBe("schema_immutable");

    const otherDescription = await errorOf(
      team.createSchema({ ...SCHEMA, description: "Something else." }),
    );
    expect(otherDescription.status).toBe(409);
    expect(otherDescription.code).toBe("schema_immutable");

    // The refusal changed nothing: the version reads as it was first kept.
    const read = await team.schema("conformance@1");
    expect(read).toEqual(made.schema);
    expect(
      (await team.schemas()).filter((one) => one.id === "conformance@1"),
    ).toHaveLength(1);
  }, 60_000);

  test("an id that names nothing or nobody is 400 invalid_schema_id, 404 schema_not_found", async () => {
    const missing = await errorOf(team.schema("conformance-none@1"));
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("schema_not_found");
    const malformed = await errorOf(team.schema("Not A Schema"));
    expect(malformed.status).toBe(400);
    expect(malformed.code).toBe("invalid_schema_id");
  }, 60_000);

  test("a built-in's name is refused before anything is kept", async () => {
    const error = await errorOf(
      team.createSchema({
        name: "git-commit",
        version: 2,
        schema: { type: "object" },
      }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe("reserved_schema");
    const listed = await team.schemas();
    expect(listed.filter((one) => one.name === "git-commit")).toHaveLength(1);
  }, 60_000);

  test("a definition the board couldn't check a value against is refused", async () => {
    const attempts: Record<string, unknown>[] = [
      { type: "string" },
      { type: "object", properties: { next: { $ref: "#" } } },
      {
        type: "object",
        properties: { id: { type: "string", pattern: "^(a+)+$" } },
      },
      {
        type: "object",
        properties: { ids: { type: "array", uniqueItems: true } },
      },
    ];
    for (const schema of attempts) {
      const error = await errorOf(
        team.createSchema({
          name: `conformance-refused-${attempts.indexOf(schema)}`,
          version: 1,
          schema,
        }),
      );
      expect(error.status).toBe(400);
      expect(error.code).toBe("invalid_schema");
    }
    const listed = await team.schemas();
    expect(
      listed.some((one) => one.name.startsWith("conformance-refused")),
    ).toBe(false);
  }, 60_000);

  test("a caller narrowed with x-board-can reads the schemas and is refused a registration", async () => {
    const narrowed = team.as("nobody", { can: "dev=read,post" });
    const listed = await narrowed.schemas();
    expect(listed.some((one) => one.id === "git-commit@1")).toBe(true);
    const error = await errorOf(narrowed.createSchema({ ...SCHEMA }));
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
  }, 60_000);

  test("a post's blocks are checked against the schema their fence names", async () => {
    const data = { run: "bbtest", outcome: "passed" };
    // A block the schema matches lands; board() reads the definition back
    // through this backend's schema() to check it. (The message view's own
    // `blocks` derivation lives in the message model, outside this unit.)
    const posted = await team.post("dev", {
      text: `bb: a block among prose\n\n${block("conformance@1", data)}\n\nand after it`,
    });
    expect(posted.text).toContain("json#conformance@1");
    // One that doesn't match, and one naming a schema nobody registered, are refused.
    const wrong = await errorOf(
      team.post("dev", {
        text: `bb: a block that doesn't match\n\n${block("conformance@1", { outcome: "maybe" })}`,
      }),
    );
    expect(wrong.status).toBe(400);
    expect(wrong.code).toBe("invalid_block");
    const unknown = await errorOf(
      team.post("dev", {
        text: `bb: a block naming nobody\n\n${block("conformance-none@1", data)}`,
      }),
    );
    expect(unknown.status).toBe(400);
    expect(unknown.code).toBe("schema_not_found");
    // An edit that would break the fence's promise is refused too.
    const edited = await errorOf(
      team.edit(posted.id, block("conformance@1", { outcome: "failed" })),
    );
    expect(edited.status).toBe(400);
    expect(edited.code).toBe("invalid_block");
  }, 60_000);

  test("registered versions survive a restart", async () => {
    app.stop();
    const second = mount(fixture.dir);
    try {
      const listed = await second.board.schemas();
      const own = listed.filter((one) => !one.builtIn);
      expect(own).toHaveLength(1);
      expect(own[0]?.id).toBe("conformance@1");
      // And it is still the same version: the same definition answers created: false.
      const again = await second.board.createSchema({ ...SCHEMA });
      expect(again.created).toBe(false);
      expect(again.schema.id).toBe("conformance@1");
    } finally {
      second.stop();
    }
    app = mount(fixture.dir);
    team = app.board;
  }, 60_000);
});
