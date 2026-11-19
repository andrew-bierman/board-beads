/**
 * bd's version banner and the comparison the model layer uses to
 * capability-probe at bind. There are no hardcoded capability tables here:
 * callers parse the live probe and compare against the versions they care
 * about.
 */

/** A parsed bd version, e.g. from "bd version 1.3.4 (7ef2fd05e: ...)". */
export interface BdVersion {
  major: number;
  minor: number;
  patch: number;
  /** The full output line the version was parsed from. */
  raw: string;
}

/**
 * Parse a bd version banner, tolerating the shapes bd prints across
 * invocations ("bd version 1.3.4 (7ef2fd05e: ...)", a bare "1.3.4").
 * Returns null when the output carries no X.Y.Z version at all.
 */
export function parseBdVersion(output: string): BdVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return { major, minor, patch, raw: output };
}

/**
 * Compare two parsed versions: negative when a is older, positive when
 * newer, zero when equal.
 */
export function compareBdVersions(a: BdVersion, b: BdVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
