/**
 * The typed answer a broken bd environment takes. The hardening sweep's
 * contract: hostile state answers typed protocol errors, never a raw 500
 * `internal` — and an environment failure names the fix, so the caller can
 * act on it. A bd that is missing, wedged past its timeout, too old, or
 * facing an uninitialized tracker is a 503 `unavailable`, at the route
 * boundary where it becomes the caller's answer.
 *
 * The protocol boundary is deliberate: the transport and the poller keep
 * typed `BdError`s (callers branch on them — truncation, frozen, claim
 * races), and routes are the only place a bd failure turns into an HTTP
 * answer. Routes that classify specific bd failures themselves (the events
 * route maps journal truncation to 400 `invalid_cursor`) do so before this
 * guard runs; it answers only what they decline.
 */
import { HttpError } from "@vercel/board";
import { BdCorruptOutputError, BdError } from "../bd/errors.ts";
import type { BdVersion } from "../bd/version.ts";

/** The documented bd this backend binds (README: `bd >= 1.3.4, < 2`). */
export const BD_MIN_VERSION: BdVersion = {
  major: 1,
  minor: 3,
  patch: 4,
  raw: "",
};
export const BD_RANGE = "bd >= 1.3.4, < 2";

/** The typed 503 the protocol answers a bd environment failure with. */
export function unavailable(message: string): HttpError {
  return new HttpError(503, "unavailable", message);
}

/**
 * Translate one bd failure into its typed 503, naming the fix each failure
 * takes. Anything that is not a bd error is a bug in the backend, not the
 * environment: it propagates unchanged (board() answers it 500 `internal`,
 * and the sweep bar counts that as the defect it is).
 */
export function bdUnavailable(error: unknown): HttpError | unknown {
  if (!(error instanceof BdError)) return error;
  const detail = error.message;
  // A spawn failure (ENOENT, bad path, no exec bit): bd itself is absent.
  if (error.exitCode === null && /ENOENT|posix_spawn|spawn /i.test(detail)) {
    return unavailable(
      `${detail} — bd isn't usable here: install bd (${BD_RANGE}) or point beads({ bdPath }) at the binary`,
    );
  }
  // A --version banner that parses to nothing: the install is broken.
  if (
    error instanceof BdCorruptOutputError &&
    error.command === "bd --version"
  ) {
    return unavailable(
      `${detail} — install a bd in the documented range (${BD_RANGE})`,
    );
  }
  // Our own bound killed it: the tracker or the box is wedged.
  if (/timed out/i.test(detail)) {
    return unavailable(
      `${detail} — bd is wedged or the tracker is too slow: retry, and inspect the bd process if it recurs`,
    );
  }
  // bd refused the workspace: the directory was never initialized.
  if (
    /not a beads workspace|no beads (workspace|database)|\.beads/i.test(detail)
  ) {
    return unavailable(
      `${detail} — run \`bd init\` in the tracker directory to create the tracker`,
    );
  }
  return unavailable(
    `${detail} — verify the tracker serves with \`bd list\` (create it with \`bd init\` if it is missing)`,
  );
}

/**
 * One route method, guarded: what it throws as a bd failure answers typed
 * 503 `unavailable`; every other answer — including the typed 4xx/5xx
 * routes raise themselves — propagates as it is.
 */
export function guardBdRoute<Args extends unknown[], Out>(
  method: (...args: Args) => Promise<Out>,
): (...args: Args) => Promise<Out> {
  return async (...args: Args): Promise<Out> => {
    try {
      return await method(...args);
    } catch (error) {
      throw bdUnavailable(error);
    }
  };
}

/**
 * A route table, guarded: every method bd failures answer typed 503 for.
 * Non-method values pass through untouched.
 */
export function guardBdRoutes<R extends Record<string, unknown>>(routes: R): R {
  const guarded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(routes)) {
    guarded[name] =
      typeof value === "function"
        ? guardBdRoute(value as (...args: never[]) => Promise<unknown>)
        : value;
  }
  return guarded as R;
}
