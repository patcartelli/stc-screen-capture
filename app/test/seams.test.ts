import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PACKAGED_KEEP, scrubPackagedEnv } from "../src/seams.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("scrubPackagedEnv (STC-657)", () => {
  const seams = () => ({
    STC_HELPER_BIN: "/tmp/evil",
    STC_ASSUME_PERMISSIONS: "granted",
    STC_CAPTURE_FAULT: "no-event-tap",
    STC_KEY_INJECT: "/tmp/keys.json",
    HOME: "/Users/someone",
    PATH: "/usr/bin",
  });

  test("packaged: every STC_* is removed, everything else is left alone", () => {
    const env = seams();
    const removed = scrubPackagedEnv(env, true, []);
    expect(removed).toEqual([
      "STC_ASSUME_PERMISSIONS", "STC_CAPTURE_FAULT", "STC_HELPER_BIN", "STC_KEY_INJECT",
    ]);
    expect(env).toEqual({ HOME: "/Users/someone", PATH: "/usr/bin" });
  });

  test("packaged: the result names the variables, never their values", () => {
    const removed = scrubPackagedEnv(seams(), true, []);
    expect(removed.join(" ")).not.toContain("/tmp");
  });

  test("unpackaged: nothing is touched (the e2e suite and the grant tests need them)", () => {
    const env = seams();
    expect(scrubPackagedEnv(env, false, [])).toEqual([]);
    expect(env).toEqual(seams());
  });

  test("a name on the keep list survives, and only that one", () => {
    const env = seams();
    scrubPackagedEnv(env, true, ["STC_CAPTURE_FAULT"]);
    expect(Object.keys(env).filter((k) => k.startsWith("STC_"))).toEqual(["STC_CAPTURE_FAULT"]);
  });

  test("only the STC_ prefix counts: a lookalike is not a seam", () => {
    const env = { STCX: "1", MY_STC_FLAG: "1", STC_: "1" };
    expect(scrubPackagedEnv(env, true, [])).toEqual(["STC_"]);
    expect(env).toEqual({ STCX: "1", MY_STC_FLAG: "1" });
  });

  // The list is deliberate. Adding to it should be a decision someone sees in
  // review, with a reason in seams.ts, not a side effect.
  test("the packaged keep list is empty", () => {
    expect(PACKAGED_KEEP).toEqual([]);
  });
});

describe("the wiring (STC-657)", () => {
  test("main.ts imports seams-boot FIRST, before electron or any module that reads the env", () => {
    const main = read("../src/main.ts");
    const firstImport = main.match(/^import\s[^\n]*$/m)?.[0] ?? "";
    expect(firstImport).toMatch(/^import "\.\/seams-boot\.js";/);
  });

  test("seams-boot runs the scrub against process.env with app.isPackaged", () => {
    const boot = read("../src/seams-boot.ts");
    expect(boot).toMatch(/scrubPackagedEnv\(process\.env,\s*app\.isPackaged\)/);
  });

  // Control for the order test above: the pattern must be able to fail.
  test("control: a file whose first import is something else does not match", () => {
    const fake = `import { app } from "electron";\nimport "./seams-boot.js";\n`;
    const firstImport = fake.match(/^import\s[^\n]*$/m)?.[0] ?? "";
    expect(firstImport).not.toMatch(/^import "\.\/seams-boot\.js";/);
  });

  test("electron-builder.yml turns the three fuses off", () => {
    const yml = read("../../electron-builder.yml");
    for (const fuse of ["runAsNode", "enableNodeOptionsEnvironmentVariable", "enableNodeCliInspectArguments"]) {
      expect(yml, fuse).toMatch(new RegExp(`^  ${fuse}: false$`, "m"));
    }
  });

  test("control: the fuse pattern fails on a fuse left on", () => {
    expect("  runAsNode: true\n").not.toMatch(/^  runAsNode: false$/m);
  });
});
