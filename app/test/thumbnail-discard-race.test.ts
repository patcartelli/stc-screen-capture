import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The discard-vs-timeout race, source-level (STC-343, restated for STC-392).
 *
 * A discard (swipe release, the right-click Delete, the ⌘⌫ key, or the ✕
 * button) asks main to trash the capture — an async round trip. Before
 * STC-392, the panel's own timeout was a SEPARATE timer in the main process
 * with no idea a discard was in flight, so the timer could fire in the gap
 * before the delete resolves: `settleAndDestroy` would hide the window, and
 * if the delete then FAILED, the renderer's recovery (it restores the panel
 * and reports the error) happened inside a window main had already hidden —
 * invisible, and still headed for a silent destroy at the old
 * `SETTLE_BACKSTOP_MS` regardless of the failure. The fix was a `discarding`
 * event sent as the FIRST thing the trash path does, before anything async.
 *
 * STC-392 removed the panel's own timeout entirely, so THIS SPECIFIC race
 * cannot recur — there is no timer left to land in the gap. What survived the
 * removal is the ORDERING property, because the event still exists for the
 * next thing that can hide or destroy this window asynchronously — the
 * overflow eviction above `MAX_STACKED` today — and that thing needs the same
 * head start.
 *
 * ## Where the property lives now
 *
 * `discard()` (the swipe's own handler) no longer sends `"discarding"`
 * itself — STC-392 collapsed the four ways to trash a take (button, ⌘⌫, the
 * context menu, and the swipe's `discard()`) onto ONE function,
 * `thumbnail-renderer.ts`'s `run()`. The event now lives in `run`'s trash
 * branch, which is why all four gestures get the same head-start rather than
 * only the swipe having one — pinning it against `discard()` specifically
 * would miss that it moved, and would stop being true about the source the
 * moment it did.
 *
 * `thumbnail-window.ts`'s `onEvent`'s `"discarding"` branch is a no-op today
 * (see its own doc), so this file does not assert anything about what main
 * does with the event — only that the renderer still sends it first, on
 * every path that can reach a trash.
 */
const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const RENDERER = src("src", "thumbnail-renderer.ts");
const WINDOW = src("src", "thumbnail-window.ts");

/** `run()`'s own body, where the trash branch — and its `"discarding"` send — now lives. */
function runBody(): string {
  const fn = RENDERER.match(/async function run\(action: PanelAction\): Promise<boolean> \{([\s\S]*?)\n\}/);
  expect(fn, "run() not found").toBeTruthy();
  return fn![1]!;
}

describe("\"discarding\" is sent before the trash round trip, still", () => {
  test("\"discarding\" precedes window.thumb.trash in run()'s body", () => {
    const body = runBody();
    const sentAt = body.indexOf('kind: "discarding"');
    const trashAt = body.indexOf("window.thumb.trash");
    expect(sentAt).toBeGreaterThan(-1);
    expect(trashAt).toBeGreaterThan(-1);
    // Order matters: sending it AFTER the trash call had already started
    // would leave exactly the gap this used to close, and would leave
    // nothing for the next thing that hooks into this event to rely on.
    expect(sentAt).toBeLessThan(trashAt);
  });

  test("discard() no longer sends the event itself — it delegates to perform(\"trash\")", () => {
    // Restating the old contract rather than loosening it (CLAUDE.md):
    // `discard()` used to be where "discarding" lived; now the swipe, the ⌘⌫
    // key, the context menu and the ✕ button all reach `run`'s trash branch
    // through `perform`, so there is exactly one place left that sends it.
    const fn = RENDERER.match(/async function discard\(\): Promise<void> \{([\s\S]*?)\n\}/);
    expect(fn, "discard() not found").toBeTruthy();
    expect(fn![1]).not.toContain('kind: "discarding"');
    expect(fn![1]).toContain('perform("trash")');
  });

  test("the event name agrees on both sides of the process boundary", () => {
    expect(RENDERER).toContain('kind: "discarding"');
    expect(WINDOW).toMatch(/kind:\s*"discarding"/);
  });

  /**
   * The control: this guard must be able to fire. Planting the old,
   * unordered shape (send after the trash call starts) proves the position
   * assertion is not vacuously true.
   */
  test("control: a run() that sends \"discarding\" AFTER window.thumb.trash fails the ordering assertion", () => {
    const planted = `async function run(action: PanelAction): Promise<boolean> {
  const r = await window.thumb.trash(dir);
  window.thumb.event({ kind: "discarding" });
  return r.ok;
}`;
    const fn = planted.match(/async function run\(action: PanelAction\): Promise<boolean> \{([\s\S]*?)\n\}/)!;
    const body = fn[1]!;
    const sentAt = body.indexOf('kind: "discarding"');
    const trashAt = body.indexOf("window.thumb.trash");
    expect(sentAt).toBeGreaterThan(trashAt);
  });
});
