import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A disposable, real beads tracker for tests. No mocks: every test exercises the actual
 * `bd` CLI against its own Dolt-backed tracker in an isolated temp HOME (KTD10).
 */
export interface BdFixture {
	/** Tracker workspace directory (bd's cwd for every call). */
	dir: string;
	/** Run bd in the fixture. Rejects on spawn failure; exit codes are returned, not thrown. */
	run: (args: string[], options?: { journal?: boolean }) => Promise<BdRun>;
	/** The parsed bd version this fixture booted with. */
	version: { major: number; minor: number; patch: number };
	/** Remove the temp workspace and HOME. Call in afterAll. */
	close: () => void;
}

export interface BdRun {
	code: number;
	stdout: string;
	stderr: string;
}

export const BD_MIN_VERSION = { major: 1, minor: 3, patch: 4 } as const;
const BD_MAX_MAJOR = 2;

function parseBdVersion(output: string): {
	major: number;
	minor: number;
	patch: number;
} {
	const match = /bd version (\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match)
		throw new Error(
			`board-beads fixture: cannot parse bd version from: ${output.trim()}`,
		);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function assertSupported(version: {
	major: number;
	minor: number;
	patch: number;
}): void {
	const atLeast =
		version.major > BD_MIN_VERSION.major ||
		(version.major === BD_MIN_VERSION.major &&
			(version.minor > BD_MIN_VERSION.minor ||
				(version.minor === BD_MIN_VERSION.minor &&
					version.patch >= BD_MIN_VERSION.patch)));
	if (!atLeast || version.major >= BD_MAX_MAJOR) {
		throw new Error(
			`board-beads fixture: bd ${version.major}.${version.minor}.${version.patch} is outside the supported range >=1.3.4 <2`,
		);
	}
}

/** Boot a real beads tracker in a temp dir with an isolated HOME (bd init installs hook files into HOME). */
export async function createBdFixture(bdPath = "bd"): Promise<BdFixture> {
	const home = mkdtempSync(join(tmpdir(), "board-beads-home-"));
	const dir = mkdtempSync(join(tmpdir(), "board-beads-tracker-"));
	const baseEnv = { ...process.env, HOME: home };

	const run = (
		args: string[],
		options?: { journal?: boolean },
	): Promise<BdRun> =>
		new Promise((resolve, reject) => {
			const child = spawn(bdPath, args, {
				cwd: dir,
				env:
					options?.journal === false
						? baseEnv
						: { ...baseEnv, BD_EVENTS_JOURNAL: "1" },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) =>
				resolve({ code: code ?? -1, stdout, stderr }),
			);
		});

	const versionRun = await run(["--version"]);
	const version = parseBdVersion(versionRun.stdout);
	assertSupported(version);

	const initRun = await run(["init", "--quiet"]);
	if (initRun.code !== 0) {
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		throw new Error(
			`board-beads fixture: bd init failed (${initRun.code}): ${initRun.stderr.trim()}`,
		);
	}

	return {
		dir,
		run,
		version,
		close: () => {
			rmSync(dir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		},
	};
}
