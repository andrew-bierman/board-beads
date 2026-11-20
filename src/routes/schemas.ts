/**
 * The schema registry routes: `schemas`, `schema`, `createSchema` — the data
 * schemas a board's blocks are checked against.
 *
 * What the protocol holds here:
 *   - every board has the built-in versions (`git-commit@1`,
 *     `vercel-deployment@1`), listed before any of the board's own, and their
 *     names are reserved: no one registers a version under one.
 *   - a version is registered once and never changes: the same definition
 *     again (key order irrelevant — definitions compare canonically) answers
 *     `created: false`; another definition or description for the same
 *     name@version is 409 `schema_immutable`. Nothing removes a version.
 *   - a definition is kept only if it describes an object and uses the
 *     structural keywords only — no `$ref`, no `pattern`, no `uniqueItems` —
 *     so checking a block's value against one stays bounded. The refusal is
 *     400 `invalid_schema`.
 *   - reads take no permission: anyone the board let in — a caller narrowed
 *     with `x-board-can` included — reads the registry; registering takes
 *     `manage` at `*`, since a schema is the whole board's.
 *
 * The definitions stored here are what board() itself holds posts and edits
 * against: its serving layer reads each block fence's schema back through
 * `schema()` and refuses a message whose block doesn't match — 400
 * `invalid_block` for a value that doesn't, 400 `schema_not_found` for a
 * fence naming a schema no one registered. The routes never see those
 * writes' texts; keeping the definitions answerable is this group's whole
 * share of block validation.
 *
 * Storage: one `schema` state document in `src/state/persisted.ts`, records
 * keyed `name@version`, so the registry survives a restart (and a corrupt
 * document is skipped by reads and answered typed by direct gets, like every
 * state kind).
 *
 * Export shape: `createSchemaRoutes({ store })` builds the route table; the
 * orchestrator spreads `routes` into the backend's method table.
 */
import {
  HttpError,
  type Caller,
  type Protocol,
  type ProtocolMethods,
  type SchemaView,
} from "@vercel/board";
import {
  BUILT_IN_SCHEMAS,
  checkDefinition,
  parseSchemaId,
} from "@vercel/board/schemas";
import {
  createSchemaRegistry,
  routeCallerOf,
  type RouteCaller,
  type SchemaRegistry,
  type SchemaVersionRow,
} from "../state/persisted.ts";
import type { BoardStore } from "./threads.ts";
import type { JsonValue } from "../model/types.ts";
import { guardBdRoutes } from "./unavailable.ts";

/** A schema name: lowercase letters, numbers, and `._-`, starting with a letter, 80 at most. */
const SCHEMA_NAME = /^[a-z][a-z0-9._-]{0,79}$/;
/** A schema version is 1 to 99,999. */
const SCHEMA_VERSION_MAX = 99_999;
/** How long a description gets. */
const SCHEMA_DESCRIPTION_MAX = 2000;
/** How many versions a board registers, the built-ins aside. */
const SCHEMAS_MAX = 500;

export type SchemaRouteTable = Pick<
  ProtocolMethods,
  "schemas" | "schema" | "createSchema"
>;

export interface SchemaRouteDeps {
  store: BoardStore;
}

export interface SchemaRoutes {
  routes: SchemaRouteTable;
}

/** The built-ins, as every board answers them: never registered, never changed. */
const builtIns: SchemaView[] = BUILT_IN_SCHEMAS.map((one) => ({
  id: `${one.name}@${one.version}`,
  name: one.name,
  version: one.version,
  description: one.description,
  schema: one.schema,
  builtIn: true,
  by: null,
  at: null,
}));

const viewOf = (row: SchemaVersionRow): SchemaView => ({
  id: `${row.name}@${row.version}`,
  name: row.name,
  version: row.version,
  description: row.description,
  schema: row.schema,
  builtIn: false,
  by: row.by,
  at: row.at,
});

function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

function badRequest(message: string, code = "invalid_request"): HttpError {
  return new HttpError(400, code, message);
}

export function createSchemaRoutes(deps: SchemaRouteDeps): SchemaRoutes {
  const store = deps.store;
  const registry: SchemaRegistry = createSchemaRegistry(store);

  const routes: SchemaRouteTable = {
    /** Every schema: the built-ins first, then the board's own, by name and version. */
    async schemas(_caller: Caller): Promise<Protocol["schemas"]["output"]> {
      await store.ensureReady();
      return { schemas: [...builtIns, ...(await registry.list()).map(viewOf)] };
    },

    /** One schema version, by its `name@version` id. */
    async schema(
      _caller: Caller,
      input: Protocol["schema"]["input"],
    ): Promise<Protocol["schema"]["output"]> {
      await store.ensureReady();
      const parsed = parseSchemaId(input.id);
      if (parsed === null) {
        throw badRequest(
          `${input.id} doesn't name a schema: one is name@version, like sandbox@1`,
          "invalid_schema_id",
        );
      }
      const builtIn = builtIns.find((one) => one.id === input.id);
      if (builtIn !== undefined) return { schema: builtIn };
      const row = await registry.get(parsed.name, parsed.version);
      if (row === null) {
        throw new HttpError(
          404,
          "schema_not_found",
          `schema not found: ${input.id}`,
        );
      }
      return { schema: viewOf(row) };
    },

    /**
     * Registers one version, for good: needs `manage` at `*`, refuses a
     * built-in's name and a definition the board won't keep, and answers the
     * version that is already there — `created: false` for the same
     * definition, 409 `schema_immutable` for any other.
     */
    async createSchema(
      caller: Caller,
      body: Protocol["createSchema"]["input"],
    ): Promise<Protocol["createSchema"]["output"]> {
      await store.ensureReady();
      const who: RouteCaller = routeCallerOf(caller);
      if (who.narrowed || !who.access.at("manage", "*")) {
        throw forbidden(
          "this token can't register schemas: it needs manage at *",
        );
      }
      if (!SCHEMA_NAME.test(body.name)) {
        throw badRequest(
          "name: a schema name is up to 80 lowercase letters, numbers, and ._-, starting with a letter",
        );
      }
      if (body.version > SCHEMA_VERSION_MAX) {
        throw badRequest(
          `version: a schema version is at most ${SCHEMA_VERSION_MAX.toLocaleString("en-US")}`,
        );
      }
      if (
        body.description !== undefined &&
        body.description.length > SCHEMA_DESCRIPTION_MAX
      ) {
        throw badRequest(
          `description: a schema description is at most ${SCHEMA_DESCRIPTION_MAX.toLocaleString("en-US")} characters`,
        );
      }
      if (BUILT_IN_SCHEMAS.some((one) => one.name === body.name)) {
        throw new HttpError(
          409,
          "reserved_schema",
          `${body.name} is a built-in schema: register yours under another name`,
        );
      }
      const problem = checkDefinition(body.schema);
      if (problem !== null) throw badRequest(problem, "invalid_schema");
      const { created, row } = await registry.register({
        name: body.name,
        version: body.version,
        description: body.description ?? null,
        // The body arrived as JSON, so its unknowns are JSON values (the
        // definition was walked by checkDefinition above).
        schema: body.schema as Record<string, JsonValue>,
        by: who.card.actor,
        max: SCHEMAS_MAX,
      });
      return { schema: viewOf(row), created };
    },
  };

  return { routes: guardBdRoutes(routes) };
}
