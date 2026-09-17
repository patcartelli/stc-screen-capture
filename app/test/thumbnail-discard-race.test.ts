import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The discard-vs-timeout race, source-level (STC-343).
 *
 * A discard (swipe release, or the right-click Delete) asks main to trash the
 * capture — an async round trip. Before STC-392, the panel's own timeout was
 * a SEPARATE timer in the main process with no idea a discard was in flight,
 * so the timer could fire in the gap before `deleteShot` resolves:
 * `settleAndDestroy` would hide the window, and if the delete then FAILED,
 * the renderer's recovery (it restores the panel and reports the error)
 * happened inside a window main had already hidden — invisible, and still
 * headed for a silent destroy at the old `SETTLE_BACKSTOP_MS` regardless of
 * the failure. The fix was a `discarding` event sent as the FIRST thing
 * `discard()` does, before anything async.
 *
 * STC-392 removed the panel's own timeout entirely, so THIS SPECIFIC race
 * cannot recur — there is no timer left to land in the gap. What survived the
 * removal is the ORDERING property (the renderer still sends `discarding`
 * before it settles or deletes), because the event still exists for the next
 * thing that can hide or destroy this window asynchronously — Task 4's
 * export-then-close — and that thing will need the same head start. What did
 * NOT survive is `thumbnail-window.ts`'s handler actually doing anything with
 * it: `onEvent`'s `"discarding"` branch is a no-op today (see its own doc),
 * so the assertion this file used to make about it — "clears the timer" —
 * would be asserting a false thing about the current code. Deleted rather
 * than loosened (STC-392 review finding 2): there is nothing this layer can
 * assert about a branch that does nothing without asserting something
 * meaningless just to keep a green tick.
 *
 * What is left pins the ordering only: reproducing the ORIGINAL live race
 * needed a real `BrowserWindow`, a real timer landing inside a real IPC round
 * trip, AND an injected delete failure, all at once — the kind of multi-way
 * timing coincidence this repo has already paid for chasing as a live test
 * (see CLAUDE.md's overlay flake and STC-292's Dock trap) — so this pins the
 * source property BY CONSTRUCTION instead of trying to reproduce it live.
 */
const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const RENDERER = src("src", "thumbnail-renderer.ts");
const WINDOW = src("src", "thumbnail-window.ts");

describe("the renderer sends \"discarding\" before anything async, still", () => {
  test("\"discarding\" is the FIRST statement in discard(), before settling or the delete", () => {
    const fn = RENDERER.match(/async function discard\(\): Promise<void> \{([\s\S]*?)\n\}/);
    expect(fn, "discard() not found").toBeTruthy();
    const body = fn![1]!;
    const sentAt = body.indexOf('kind: "discarding"');
    const settlingAt = body.indexOf("settling = true");
    const deleteAt = body.indexOf("window.thumb.deleteShot");
    expect(sentAt).toBeGreaterThan(-1);
    expect(settlingAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    // Order matters: sending it AFTER the delete had already started would
    // leave exactly the gap this used to close, and would leave nothing for
    // the next thing that hooks into this event (Task 4) to rely on either.
    expect(sentAt).toBeLessThan(settlingAt);
    expect(sentAt).toBeLessThan(deleteAt);
  });

  test("the event name agrees on both sides of the process boundary", () => {
    expect(RENDERER).toContain('kind: "discarding"');
    expect(WINDOW).toMatch(/kind:\s*"discarding"/);
  });

  /**
   * The control: this guard must be able to fire. Planting the old,
   * unordered shape (send after the delete starts) proves the position
   * assertion is not vacuously true.
   */
  test("control: a discard() that sends \"discarding\" AFTER the delete starts fails the ordering assertion", () => {
    const planted = `async function discard(): Promise<void> {
  settling = true;
  await window.thumb.deleteShot(dir);
  window.thumb.event({ kind: "discarding" });
}`;
    const fn = planted.match(/async function discard\(\): Promise<void> \{([\s\S]*?)\n\}/)!;
    const body = fn[1]!;
    const sentAt = body.indexOf('kind: "discarding"');
    const deleteAt = body.indexOf("window.thumb.deleteShot");
    expect(sentAt).toBeGreaterThan(deleteAt);
  });
});
