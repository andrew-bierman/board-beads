/**
 * A Board Backend that keeps nothing, so the conformance kit can be driven end to end before the
 * real beads backend exists, and the run's exact shape — which checks skip, which fail, and what
 * the suite calls before it starts — is learned from the receipt it leaves.
 *
 * Every protocol method answers 501 with the code the protocol's docs assign to the family it
 * belongs to (`no_scheduler`, `no_tasks`, `no_grants`, `no_schemas`, `no_files`,
 * `no_direct_uploads`); families the docs assign no kept-feature code to (core reads and writes,
 * search reads, watchers, sync) answer 501 `not_supported`. The conformance kit reports a 501 in
 * its OPTIONAL groups (search, schedules, tasks, grants, schemas, attachments) as skipped, "not
 * kept here"; in every other group a 501 is a failure, which this run proves empirically.
 *
 * Three methods answer for real, because the suite cannot even start without them:
 * - `discovery`: board() assembles discovery itself (its `url`, `audience`, `team_id`,
 *   `project_id` are board()'s to say) and reads only `.sync` off the backend's answer;
 * - `me`: the run's identity — the deployment's own client, `board:client`, as `local()` says it;
 * - `channelMessages`: the run reads the channel's cursor before it writes anything, and this
 *   call is made outside the suite's try/catch — a throw here kills the whole run, no report.
 */
import {
  type Backend,
  type BoardBinding,
  type Discovery,
  type Me,
  type MessagesPage,
  type Method,
  HttpError,
} from "@vercel/board";

/** Every protocol method, by name, as Board's own routing lists them (65). */
const METHODS: readonly Method[] = [
  "discovery",
  "me",
  "channels",
  "createChannel",
  "actors",
  "channelMessages",
  "threads",
  "message",
  "post",
  "posted",
  "edit",
  "delete",
  "react",
  "label",
  "schedule",
  "schedules",
  "cancelSchedule",
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
  "grants",
  "createGrant",
  "createGrants",
  "updateGrant",
  "explain",
  "revokeGrant",
  "schemas",
  "schema",
  "createSchema",
  "upload",
  "attachment",
  "uploadStart",
  "uploadFinish",
  "watchers",
  "register",
  "matches",
  "ack",
  "events",
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
];

/** The methods that answer for real; the rest are refused. */
const REAL: ReadonlySet<Method> = new Set<Method>([
  "discovery",
  "me",
  "channelMessages",
]);

/** What a board that keeps none of a family says, per family, as the protocol's docs assign. */
const FAMILIES: readonly {
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
    methods: ["upload", "attachment"],
  },
  {
    code: "no_direct_uploads",
    message: "this board can't sign a direct upload",
    methods: ["uploadStart", "uploadFinish"],
  },
];

/** The 501 a refused method answers: its family's code, or `not_supported` for what no doc assigns. */
const refusalOf = (method: Method): HttpError => {
  const family = FAMILIES.find((own) => own.methods.includes(method));
  if (family) return new HttpError(501, family.code, family.message);
  return new HttpError(
    501,
    "not_supported",
    `this stub keeps nothing, so ${method} is refused`,
  );
};

/** The deployment's own code, as `local()` names it — who this run's `me` says it is. */
const CLIENT_ACTOR = "board:client";

const stubDiscovery = async (): Promise<Discovery> => ({
  version: "0.0.0-stub",
  url: "http://in-process.board",
  audience: "http://in-process.board",
  team_id: null,
  project_id: null,
  // Only `.sync` is read off this by board(); the rest of discovery is board()'s own answer.
  sync: [],
});

const stubMe = async (): Promise<Me> => ({
  actor: CLIENT_ACTOR,
  principal: CLIENT_ACTOR,
  kind: "deployment",
  handle: "client",
  name: "client",
  avatar: null,
  profile: null,
  expiresAt: null,
  // Full access, as the board's own code has: every permission, everywhere.
  can: { "*": ["read", "post", "react", "label", "sync", "manage"] },
});

const stubChannelMessages = async (): Promise<MessagesPage> => ({
  // An empty channel, as the run's is before it writes: the cursor is what the suite reads.
  messages: [],
  cursor: "stub-start",
});

/**
 * The stub backend: `keeps` the board (it answers requests, as the beads backend will), keeps no
 * routes of its own, and refuses every protocol method but the three above. The `satisfies
 * Backend` at the end is the contract check: if Board's Protocol grows a method this file doesn't
 * list, the type error names it, and the suite fails to build rather than silently dodging a check.
 */
export function createStubBackend(): Backend {
  const refused = Object.fromEntries(
    METHODS.filter((method) => !REAL.has(method)).map((method) => [
      method,
      () => {
        throw refusalOf(method);
      },
    ]),
  ) as {
    [M in Exclude<Method, "discovery" | "me" | "channelMessages">]: () => never;
  };

  return {
    routes: [],
    keeps: true,
    bind(_binding: BoardBinding) {
      // Nothing to learn: the stub keeps no subscriptions, sync entries, or policy of its own.
    },
    discovery: stubDiscovery,
    me: stubMe,
    channelMessages: stubChannelMessages,
    ...refused,
  } satisfies Backend;
}
