/**
 * The backend registry: wires the landed route groups onto one `Backend`,
 * and answers every group that hasn't landed with its family's 501 code
 * from the declared table below — the single place "not kept here" is
 * written down. Route groups land by assignment: when a group's unit
 * completes, its factory spreads into the registry and its family leaves
 * the table.
 *
 * Access: a self-hosted, single-operator board is open to whoever board()
 * authenticates — one grant, everyone, everything (the grants group itself
 * is 501 until a grants store lands). Per-channel narrowing still applies:
 * the routes honor each caller's access, and `as(profile, { can })` narrows
 * agents on top of this grant.
 */
import {
  HttpError,
  type Backend,
  type BoardBinding,
  type Method,
  type ProtocolMethods,
} from "@vercel/board";
import { createEventRoutes } from "./routes/events.ts";
import {
  createBoardStore,
  threadsRoutes,
  type BoardStoreOptions,
} from "./routes/threads.ts";

export interface BeadsBackendOptions extends BoardStoreOptions {
  /** Label and metadata namespace override, for several boards over one tracker. */
  labels?: { namespace?: string };
}

/**
 * The protocol families this build keeps none of, per the plan's declared
 * 501 set. Route groups leave this table as their units land: `events` is
 * wired (it is a core method, so refusing it fails conformance); watchers
 * and sync land with theirs.
 */
const REFUSED: readonly {
  code: string;
  message: string;
  methods: readonly Method[];
}[] = [
  {
    code: "no_scheduler",
    message: "this board keeps no schedules",
    methods: ["schedule", "schedules", "cancelSchedule"],
  },
  {
    code: "no_tasks",
    message: "this board keeps no tasks",
    methods: [
      "tasks",
      "createTask",
      "createTasks",
      "createdTasks",
      "claimReadyTask",
      "claimTask",
      "renewTask",
      "releaseTask",
      "completeTask",
      "failTask",
      "blockTask",
      "unblockTask",
      "reopenTask",
      "assignTask",
      "setTaskNeeds",
      "cancelTask",
    ],
  },
  {
    code: "no_grants",
    message: "this board keeps no grants",
    methods: [
      "grants",
      "createGrant",
      "createGrants",
      "updateGrant",
      "explain",
      "revokeGrant",
    ],
  },
  {
    code: "no_schemas",
    message: "this board keeps no schemas",
    methods: ["schemas", "schema", "createSchema"],
  },
  {
    code: "no_files",
    message: "this board keeps no files",
    methods: ["upload", "attachment", "uploadStart", "uploadFinish"],
  },
  {
    code: "not_supported",
    message: "this board doesn't keep that here",
    methods: [
      // INTEGRATION: watchers and sync land with their units.
      "watchers",
      "register",
      "matches",
      "ack",
      "syncImport",
      "syncReceipt",
      "syncThread",
      "syncFind",
      "syncCopies",
      "inboxPush",
      "inboxNext",
      "inboxAck",
      "inbox",
      "typing",
      "readSource",
      "joinSource",
      "synced",
      "linked",
    ],
  },
];

/** 501 refusers for every method in the declared families, minus landed ones. */
function notKept(except: ReadonlySet<string>): ProtocolMethods {
  const out: Record<string, (...args: never[]) => Promise<unknown>> = {};
  for (const family of REFUSED) {
    for (const name of family.methods) {
      if (except.has(name)) continue;
      out[name] = async () => {
        throw new HttpError(501, family.code, family.message);
      };
    }
  }
  // The table is written against Board's own routing list; conformance is the
  // completeness check, so a single construction point with a cast is honest here.
  return out as ProtocolMethods;
}

export function beads(options: BeadsBackendOptions): Backend {
  const store = createBoardStore({
    dir: options.dir,
    bdPath: options.bdPath,
    systemActor: options.systemActor,
    namespace: options.labels?.namespace,
  });
  // The event feed: the long-poll over the journal, with the consumer that
  // keeps the backend's own seq checkpoint (its `head` is what a read with
  // no `after` continues from).
  const events = createEventRoutes({
    transport: store.transport,
    codec: store.codec,
    labels: store.labels,
    authorFor: (slug) => store.authorForSlug(slug),
  });
  const routes = {
    ...threadsRoutes(store),
    events: events.events,
  };
  const landed = new Set(Object.keys(routes));
  const backend: Backend = {
    keeps: true,
    routes: [],
    ...notKept(landed),
    ...routes,
    // A self-hosted, single-operator board: open to whoever board() authenticates.
    // The routes still honor per-caller, per-channel narrowing on top of this.
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
      // No I/O here per the Backend contract — the first route call initializes.
      store.bind(binding);
      // The backend's lifecycle begins at bind: start the journal consumer.
      // Its timer is unref'd, so it never holds the process open; the
      // long-poll answers `poller.status === "stopped"` as an empty feed.
      events.poller.start();
    },
  };
  return backend;
}
