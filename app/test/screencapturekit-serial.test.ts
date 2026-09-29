import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCREENCAPTUREKIT_FILES } from "../../vitest.screencapturekit-files.js";

/**
 * STC-470: every unit test that makes the REAL helper call ScreenCaptureKit is
 * in `SCREENCAPTUREKIT_FILES`, so `vitest.config.ts` never runs two of them at
 * once. A new one left out of the list runs in the parallel unit group and
 * brings back a `start-timeout` flake that only shows under load — the kind
 * that takes a day to trace, which is why this is a test and not a comment.
 *
 * Detection, as a grep: the file names the real binary's path AND sends one
 * of the three helper commands that reach ScreenCaptureKit (`start`,
 * `capture-still`, `windows`), in either the raw-protocol or the client form.
 */
const root = join(__dirname, "..", "..");
const REAL_BINARY = /"helper",\s*"build",\s*"stc-helper"/;
const SCK_COMMAND = new RegExp([
  String.raw`cmd:\s*"(start|windows|capture-still)"`,
  String.raw`request\(\s*"(start|windows|capture-still)"`,
  String.raw`\.(startRecording|listWindows|captureStill)\(`,
].join("|"));

const reachesScreenCaptureKit = (src: string) => REAL_BINARY.test(src) && SCK_COMMAND.test(src);

function unitTestFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["app/test", "helper/test", "transform/test"]) {
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith(".test.ts") || /\.(e2e|grant|slow)\.test\.ts$/.test(f)) continue;
      out.push(`${dir}/${f}`);
    }
  }
  return out;
}

describe("the real helper's ScreenCaptureKit calls never run in parallel (STC-470)", () => {
  test("every unit file that reaches ScreenCaptureKit through the real helper is listed", () => {
    const found = unitTestFiles().filter((f) => reachesScreenCaptureKit(readFileSync(join(root, f), "utf8")));
    expect(found.filter((f) => !SCREENCAPTUREKIT_FILES.includes(f)),
      "these call start/windows/capture-still on the real helper but run in the parallel unit group; "
      + "add them to vitest.screencapturekit-files.ts").toEqual([]);
  });

  // Controls: the detector fires on every file already listed. If a listed
  // file stops matching, either it no longer needs to be serial (take it
  // out) or the pattern has drifted and the test above is passing vacuously.
  test.each(SCREENCAPTUREKIT_FILES)("control: the detector fires on %s", (f) => {
    expect(reachesScreenCaptureKit(readFileSync(join(root, f), "utf8"))).toBe(true);
  });

  test("control: the fake helper alone does not count", () => {
    expect(reachesScreenCaptureKit(`const FAKE = join(root, "app", "test", "_fake-helper.mjs"); h.send({ cmd: "start" });`))
      .toBe(false);
  });
});
