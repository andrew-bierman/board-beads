import { afterAll, describe, expect, test } from "bun:test";
import { type BdFixture, createBdFixture } from "./bd-fixture.ts";

describe("bd-fixture", () => {
  let fixture: BdFixture;

  afterAll(() => {
    fixture?.close();
  });

  // bd init (Dolt-backed) cold start routinely exceeds bun's 5s default timeout.
  test("boots a real tracker inside the supported bd range", async () => {
    fixture = await createBdFixture();
    expect(fixture.version.major).toBe(1);
    expect(fixture.run).toBeFunction();
  }, 120_000);

  test("real create + list round-trip through the bd CLI", async () => {
    const created = await fixture.run(["create", "fixture smoke", "--json"]);
    expect(created.code).toBe(0);
    const listed = await fixture.run(["list", "--json"]);
    expect(listed.code).toBe(0);
    const issues = JSON.parse(listed.stdout) as Array<{ title: string }>;
    expect(issues.some((issue) => issue.title === "fixture smoke")).toBeTrue();
  }, 120_000);
});
