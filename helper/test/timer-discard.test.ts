import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

const root = join(__dirname, "..", "..");
const sources = ["helper/src/TimerDiscard.swift", "helper/test/timer-discard/main.swift"];

/**
 * A timer source cancelled before it was ever resumed kills the helper when it
 * is released (STC-305 follow-up, `TimerDiscard.swift`). Six `start*` timers
 * took that branch whenever a stop had already begun, and a stop landing during
 * a start reached the first of them: the helper died by SIGTRAP before it
 * answered the start. Nothing on CI can make that race happen, so this checks
 * the two halves it is made of. The real libdispatch is run with and without
 * the fix, and the sources are checked for any bare cancel.
 */
describe("discarding an unresumed timer (STC-305 follow-up)", () => {
  test("cancel + resume lets the timer go without firing it", async () => {
    const out = await runSwiftHarness({ label: "timer-discard", sources });
    expect(out, out).toContain("ALL PASS");
  }, 60_000);

  test("CONTROL: a bare cancel still dies by SIGTRAP", async () => {
    await expect(runSwiftHarness({ label: "timer-discard", sources, args: ["bare"] }))
      .rejects.toThrow(/signal SIGTRAP/);
  }, 60_000);

  // Every timer in helper/src is a local `t` that is either resumed or handed
  // to `discardUnresumedTimer`. A stored timer is cancelled through its own
  // name (`holdWatch?.cancel()`) after it has been resumed, which is legal.
  const bareCancel = /\bt\.cancel\(\)/;

  test("no Swift source cancels a local timer without resuming it", () => {
    const dir = join(root, "helper", "src");
    // TimerDiscard.swift is the one place a bare cancel belongs: the resume is the next line.
    const files = readdirSync(dir).filter((f) => f.endsWith(".swift") && f !== "TimerDiscard.swift");
    expect(files).toContain("Capture.swift");
    const hits = files.flatMap((f) =>
      readFileSync(join(dir, f), "utf8").split("\n")
        .map((line, i) => ({ where: `${f}:${i + 1}`, line }))
        .filter(({ line }) => bareCancel.test(line) && !line.trim().startsWith("//")));
    expect(hits.map((h) => `${h.where}: ${h.line.trim()}`)).toEqual([]);
  });

  test("CONTROL: the pattern fires on the code that crashed", () => {
    // `startDiskWatcher` before this fix, verbatim.
    expect(bareCancel.test("            t.cancel()")).toBe(true);
    expect(bareCancel.test("        if stopped { lock.unlock(); t.cancel(); return }")).toBe(true);
    expect(bareCancel.test("            discardUnresumedTimer(t)")).toBe(false);
  });
});
