import type { Backend } from "@vercel/board";

export interface BeadsBackendOptions {
	/** Path to the beads tracker workspace (the directory `bd` resolves, typically containing `.beads/`). */
	dir: string;
	/** Explicit bd binary path. Defaults to `bd` on PATH. */
	bdPath?: string;
	/**
	 * Actor slug for writes made outside a Board caller's identity (startup checks, lease timers).
	 * Defaults to "board-beads". Must not collide with a mapped principal slug (KTD11).
	 */
	systemActor?: string;
}

/**
 * A Vercel Board {@link Backend} whose storage is a beads tracker.
 *
 * Mount it as `board({ backend: beads({ dir }) })` and the whole Board surface —
 * `vb` CLI, tasks with leases, threads, event fan-out, watchers — runs against beads.
 *
 * Implemented across plan units U2–U7
 * (docs/plans/2026-11-19-1356-feat-board-beads-backend-plan.md). This scaffold throws.
 */
export function beads(_options: BeadsBackendOptions): Backend {
	throw new Error(
		"board-beads: backend not implemented yet (scaffold — see plan units U2-U7)",
	);
}
