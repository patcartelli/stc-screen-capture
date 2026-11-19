import { describe, test, expect } from "vitest";
// @ts-expect-error — plain .mjs script module, no declaration file
import * as plan from "../../scripts/release-plan.mjs";

/** Each test is a way the release could start (or read as a pass) when it should not. */
const ok = {
  branch: "master",
  dirty: false,
  headSha: "a".repeat(40),
  originSha: "a".repeat(40),
  tags: ["v1.0.0", "v1.1.0-beta.1"],
  tag: "v1.1.0-beta.2",
  currentVersion: "1.1.0-beta.1",
  version: "1.1.0-beta.2",
};

describe("parseVersion", () => {
  test("accepts a prerelease and a leading v", () => {
    expect(plan.parseVersion("v1.1.0-beta.2")).toEqual({ version: "1.1.0-beta.2", tag: "v1.1.0-beta.2" });
  });
  test.each(["", undefined, "1.1", "1.1.0+build5", "latest", "1.1.0-"])("refuses %s", (v) => {
    expect(() => plan.parseVersion(v)).toThrow();
  });
});

describe("compareVersions", () => {
  test("a prerelease sorts below its release, and beta.10 above beta.2", () => {
    expect(plan.compareVersions("1.1.0-beta.1", "1.1.0")).toBe(-1);
    expect(plan.compareVersions("1.1.0-beta.10", "1.1.0-beta.2")).toBe(1);
    expect(plan.compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(plan.compareVersions("1.2.0", "1.10.0")).toBe(-1);
  });
});

describe("preflightProblems", () => {
  test("a clean master at origin, free tag, higher version has none", () => {
    expect(plan.preflightProblems(ok)).toEqual([]);
  });
  test("refuses a feature branch, a dirty tree, a stale head, a taken tag, a lower version", () => {
    expect(plan.preflightProblems({ ...ok, branch: "accounts/x" })).toHaveLength(1);
    expect(plan.preflightProblems({ ...ok, dirty: true })).toHaveLength(1);
    expect(plan.preflightProblems({ ...ok, headSha: "b".repeat(40) })).toHaveLength(1);
    expect(plan.preflightProblems({ ...ok, tags: [...ok.tags, ok.tag] })).toHaveLength(1);
    expect(plan.preflightProblems({ ...ok, version: "1.0.9", tag: "v1.0.9" })).toHaveLength(1);
  });
  test("an unreadable origin is a refusal, not a pass", () => {
    expect(plan.preflightProblems({ ...ok, originSha: "" })).toHaveLength(1);
  });
});

describe("ciVerdict", () => {
  const sha = "a".repeat(40);
  const run = (o: object) => ({ headSha: sha, workflowName: "CI", status: "completed", conclusion: "success", ...o });
  test("green only for the named workflow on this commit", () => {
    expect(plan.ciVerdict([run({})], sha, "CI").state).toBe("green");
  });
  test("another workflow's green run is not CI", () => {
    expect(plan.ciVerdict([run({ workflowName: "Chrome canary" })], sha, "CI").state).toBe("missing");
  });
  test("a green run for another commit is not this commit's", () => {
    expect(plan.ciVerdict([run({ headSha: "c".repeat(40) })], sha, "CI").state).toBe("missing");
  });
  test("red, cancelled and in-progress are never green", () => {
    expect(plan.ciVerdict([run({ conclusion: "failure" })], sha, "CI").state).toBe("red");
    expect(plan.ciVerdict([run({ conclusion: "cancelled" })], sha, "CI").state).toBe("red");
    expect(plan.ciVerdict([run({ status: "in_progress", conclusion: "" })], sha, "CI").state).toBe("pending");
  });
});

describe("uploadProblems", () => {
  const expected = [{ name: "a.dmg", size: 10 }, { name: "a.dmg.sha256", size: 5 }];
  test("clean when both are on the release at their sizes", () => {
    expect(plan.uploadProblems([{ name: "a.dmg", size: 10 }, { name: "a.dmg.sha256", size: 5 }], expected)).toEqual([]);
  });
  test("a missing file and a truncated one are both named", () => {
    const p = plan.uploadProblems([{ name: "a.dmg", size: 3 }], expected);
    expect(p).toHaveLength(2);
  });
});

test("artifactNames matches electron-builder's artifactName", () => {
  expect(plan.artifactNames("1.1.0-beta.2").dmg).toBe("Capture-1.1.0-beta.2-arm64.dmg");
});
