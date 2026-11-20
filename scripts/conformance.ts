/**
 * The conformance harness: runs Board's real conformance suite against an injectable backend —
 * `conformance(board({ backend: createBackend() }))`, from `@vercel/board/conformance` — and
 * writes the machine receipt to evidence/conformance-inventory.json.
 *
 * The backend today is the stub (scripts/conformance-stub-backend.ts), which refuses every
 * protocol method with a 501, so this run maps the suite's exact contract: which checks skip,
 * which fail, and what the suite needs answered before it starts. When the real beads backend is
 * ready, swap the one line marked INJECTION POINT; nothing else here changes.
 *
 * Flags:
 * - `--backend beads` runs the real beads backend (`beads({ dir })` from src/) over a fresh,
 *   real bd tracker per run (test/helpers/bd-fixture.ts — no mocks); `--backend stub` (the
 *   default) runs the stub, unchanged.
 * - `--json out=<path>` writes the machine receipt to `path` instead of the evidence default.
 * - `--json` alone also prints the receipt JSON to stdout, as `vb conformance --json` does.
 *
 * Exit codes are honest: 0 only when every check passed or skipped ("not kept here" and friends);
 * any failure — as in this all-refusing stub run — exits nonzero.
 */
import { board } from "@vercel/board";
import { conformance, type ConformanceReport } from "@vercel/board/conformance";
import { mkdirSync, writeFileSync } from "node:fs";
import { createStubBackend } from "./conformance-stub-backend.ts";
import { beads } from "../src/index.ts";
import { createBdFixture } from "../test/helpers/bd-fixture.ts";

// --- INJECTION POINT: replace with the real beads backend's factory -------------------------
const createBackend = createStubBackend;
/**
 * The real backend, for `--backend beads`: a fresh, real bd tracker per run (the fixture boots
 * the actual `bd` CLI — no mocks) and `beads({ dir })` over it. Returns the fixture's closer so
 * the run's temp workspace and HOME go when the report is written.
 */
const createBeads = async (): Promise<{
  backend: ReturnType<typeof beads>;
  bdVersion: string;
  close: () => void;
}> => {
  const fixture = await createBdFixture();
  return {
    backend: beads({ dir: fixture.dir }),
    bdVersion: `${fixture.version.major}.${fixture.version.minor}.${fixture.version.patch}`,
    close: fixture.close,
  };
};
// --------------------------------------------------------------------------------------------

/** Which backend a run answers with: `--backend beads`, or the stub by default. */
type BackendMode = "stub" | "beads";

const evidenceDir = new URL("../evidence/", import.meta.url);
const defaultReceiptPath = new URL("conformance-inventory.json", evidenceDir);

const usage = (arg: string): never => {
  console.error(
    `board-beads conformance: unknown argument ${JSON.stringify(arg)}; use --backend beads|stub, --json, or --json out=<path>`,
  );
  process.exit(2);
};

/** `--json` (print the receipt to stdout too), `--json out=<path>` (write it there instead), and `--backend beads|stub`. */
const parseArgs = (
  argv: readonly string[],
): { backend: BackendMode; printJson: boolean; receiptPath: URL } => {
  let backend: BackendMode = "stub";
  let printJson = false;
  let receiptPath = defaultReceiptPath;
  /** The `--json` that an `out=<path>` that follows belongs to. */
  let jsonPending = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--backend" || arg.startsWith("--backend=")) {
      const value =
        arg === "--backend" ? argv[i + 1] : arg.slice("--backend=".length);
      if (value === "stub" || value === "beads") backend = value;
      else usage(value ?? "(no value)");
      if (arg === "--backend") i++;
      continue;
    }
    if (arg === "--json") {
      printJson = true;
      jsonPending = true;
      continue;
    }
    if (arg.startsWith("--json")) {
      // One token: `--json out=<path>`.
      const rest = arg.slice("--json".length).trim();
      if (!rest.startsWith("out=")) usage(arg);
      printJson = true;
      receiptPath = receiptOf(rest.slice("out=".length).trim());
      jsonPending = false;
      continue;
    }
    if (arg.startsWith("out=") && jsonPending) {
      receiptPath = receiptOf(arg.slice("out=".length).trim());
      jsonPending = false;
      continue;
    }
    usage(arg);
  }
  return { backend, printJson, receiptPath };
};

/** Where `out=<path>` writes: relative paths land in evidence/, beside the default receipt. */
const receiptOf = (out: string): URL => {
  if (out === "") {
    console.error(
      "board-beads conformance: --json needs a path: --json out=<path>",
    );
    process.exit(2);
  }
  return out.startsWith("/")
    ? new URL(`file://${out}`)
    : new URL(out, evidenceDir);
};

const summaryOf = (report: ConformanceReport) => {
  const groups = [...new Set(report.checks.map((check) => check.group))];
  return Object.fromEntries(
    groups.map((group) => {
      const own = report.checks.filter((check) => check.group === group);
      return [
        group,
        {
          passed: own.filter((check) => check.status === "passed").length,
          failed: own.filter((check) => check.status === "failed").length,
          skipped: own.filter((check) => check.status === "skipped").length,
          total: own.length,
        },
      ];
    }),
  );
};

const run = async (): Promise<void> => {
  const { backend, printJson, receiptPath } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  // conformance() never throws for what the board answers; a throw here is the harness's own
  // (a backend factory that fails — the beads fixture's bd boot included — or the suite's
  // pre-check setup — discovery, me, the run's channel cursor — being refused outright).
  let report: ConformanceReport;
  /** The receipt's `backend` label: the stub's keeps its old value for comparability. */
  let backendName: string;
  let bdVersion: string | null = null;
  let closeFixture: (() => void) | null = null;
  try {
    if (backend === "beads") {
      const made = await createBeads();
      bdVersion = made.bdVersion;
      closeFixture = made.close;
      backendName = "beads";
      report = await conformance(board({ backend: made.backend }));
    } else {
      backendName = "conformance-stub-backend";
      report = await conformance(board({ backend: createBackend() }));
    }
  } finally {
    closeFixture?.();
  }
  const finishedAt = new Date().toISOString();

  const receipt = {
    backend: backendName,
    ...(bdVersion !== null ? { bdVersion } : {}),
    suite: "@vercel/board/conformance",
    startedAt,
    finishedAt,
    url: report.url,
    ok: report.ok,
    summary: summaryOf(report),
    checks: report.checks,
  };

  const directory = new URL(".", receiptPath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  console.log(`board-beads conformance run against ${receipt.backend}`);
  console.log(`  board url: ${report.url}`);
  for (const [group, counts] of Object.entries(receipt.summary)) {
    console.log(
      `  ${group.padEnd(12)} ${String(counts.total).padStart(2)} checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`,
    );
  }
  const failed = report.checks.filter((check) => check.status === "failed");
  if (failed.length > 0) {
    console.log(`  failures (${failed.length}):`);
    for (const check of failed)
      console.log(`    [${check.group}] ${check.name}\n      ${check.detail}`);
  }
  console.log(`  receipt: ${receiptPath.pathname}`);
  if (printJson) console.log(JSON.stringify(receipt, null, 2));
  console.log(`  ok: ${report.ok}`);

  // Honest exit: nonzero while any check failed beyond its declared skips. The stub run expects
  // nonzero — core cannot pass on a board that refuses every write.
  process.exitCode = report.ok ? 0 : 1;
};

run().catch((error: unknown) => {
  console.error(
    "board-beads conformance run failed before a report could be written:",
    error,
  );
  process.exit(1);
});
