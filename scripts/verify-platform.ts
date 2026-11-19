/**
 * U1 platform verification: Bun must resolve @vercel/board's "node" export condition
 * in-process (the plan's fallback decision point — vitest-on-Node if this fails).
 *
 * Proves: the package's ESM exports (board, HttpError, Backend type, conformance entry)
 * import cleanly under Bun and a backend-backed handle constructs. Full protocol behavior
 * is U2+; this is the import-path decision only.
 */
import { type Backend, board, HttpError } from "@vercel/board";

// Import the conformance entry to prove the subpath resolves under Bun's conditions.
const conformanceUrl = import.meta.resolve("@vercel/board/conformance");
if (typeof conformanceUrl !== "string") {
	throw new Error("board-beads: @vercel/board/conformance did not resolve");
}

// Construct a handle over a stub backend (construction only — board() calls bind() once at creation).
const stub = { bind() {} } as unknown as Backend;
const handle = board({ backend: stub });
if (typeof handle.fetch !== "function") {
	throw new Error("board-beads: board() did not return a fetch handle");
}

if (typeof HttpError !== "function") {
	throw new Error("board-beads: HttpError did not resolve");
}

console.log(
	"board-beads platform check: @vercel/board imports, subpaths resolve, handle constructs — OK under Bun",
);
