import { describe, expect, test } from "bun:test";
import { compareBdVersions, parseBdVersion } from "./version.ts";

describe("parseBdVersion", () => {
  test("parses bd's version banner with a commit suffix", () => {
    const parsed = parseBdVersion("bd version 1.3.4 (7ef2fd05e: 2026-01-01)");
    expect(parsed).not.toBeNull();
    expect(parsed?.major).toBe(1);
    expect(parsed?.minor).toBe(3);
    expect(parsed?.patch).toBe(4);
    expect(parsed?.raw).toBe("bd version 1.3.4 (7ef2fd05e: 2026-01-01)");
  });

  test("parses a bare semver string", () => {
    expect(parseBdVersion("1.3.4")?.minor).toBe(3);
  });

  test("returns null for output without a version", () => {
    expect(parseBdVersion("--version")).toBeNull();
    expect(parseBdVersion("")).toBeNull();
    expect(parseBdVersion("bd version (unknown)")).toBeNull();
  });
});

describe("compareBdVersions", () => {
  test("orders by major, then minor, then patch", () => {
    const v134 = parseBdVersion("bd version 1.3.4 (x)")!;
    const v140 = parseBdVersion("bd version 1.4.0 (x)")!;
    const v200 = parseBdVersion("bd version 2.0.0 (x)")!;
    expect(compareBdVersions(v134, v140)).toBeLessThan(0);
    expect(compareBdVersions(v140, v200)).toBeLessThan(0);
    expect(compareBdVersions(v200, v134)).toBeGreaterThan(0);
    expect(compareBdVersions(v134, v134)).toBe(0);
  });
});
