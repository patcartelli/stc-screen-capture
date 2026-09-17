import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withCountdown, withoutCountdown } from "./_countdown-fixture.js";
import { startRecordFlow } from "./_record-flow.js";
import { HIDE_SETTLE_MS } from "../src/overlay-session.js";

/**
 * The whole Record flow, in a real app (STC-388).
 *
 * What this settles: that the four steps happen in order, from a door that has
 * no renderer; that Escape at each step writes nothing; and that the hotkey's
 * second press stops a take. What it CANNOT settle, and the runbook owns: that
 * the bar READS well, and that the flow feels like one gesture.
 *
 * `_record-flow.ts` is used where its own contract fits (task 9 extended it
 * with `expandAfterWindow` for the one case nothing drove through the real
 * overlay before). The rest of this file drives the overlay directly, the way
 * `still-overlay.e2e.test.ts` already does, because several tests here need to
 * inspect the bar's own state BETWEEN steps that helper deliberately does not
 * expose (it stops the instant the bar's Record control has been sent).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched { win: Page; startLog: string; tempTakes: string }

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
  const startLog = join(mkdtempSync(join(tmpdir(), "stc-logs-")), "start.jsonl");
  const tempTakes = mkdtempSync(join(tmpdir(), "stc-temp-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: tempTakes,
           STC_HELPER_BIN: FAKE_HELPER, STC_FAKE_START_LOG: startLog,
           STC_OVERLAY_SYNTHETIC_INPUT: "1", ...extraEnv },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#record");
  return { win, startLog, tempTakes };
}

const readLines = (file: string): any[] =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** The overlay window, once it is up — same identification every other file
 * driving it uses: by URL, since the main window is also in `app.windows()`. */
async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) {
      if (p.url().includes("overlay.html")) return p;
    }
    if (Date.now() - start > ms) {
      throw new Error(`no overlay window appeared within ${ms}ms; windows: ` +
                      JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** Push one event through the overlay's own bridge, as the DOM handlers would
 * under real input — disabled here by `STC_OVERLAY_SYNTHETIC_INPUT`. */
async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

/**
 * Wait until a drag has produced a selection Enter would actually confirm.
 * See `still-overlay.e2e.test.ts` for the failure this exists to avoid: a
 * Return sent before this is a no-op (`reduce`), and the overlay hangs open.
 */
async function awaitConfirmable(overlay: Page, ms = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((await overlay.textContent("#size"))?.trim()) return;
    if (Date.now() - start > ms) {
      const seen = await overlay.evaluate(() => JSON.stringify((window as any).__overlayState ?? null));
      throw new Error(
        `the drag never produced a confirmable selection within ${ms}ms — ` +
        `Return would be a no-op and the overlay would hang. Overlay state: ${seen}`);
    }
    await sleep(50);
  }
}

function hasCountdownWindow(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("countdown.html")));
}

const status = (win: Page): Promise<{ state: string }> =>
  win.evaluate(() => (window as any).recorder.status());

/** A 200x100 region, comfortably inside the primary display — the same shape
 * every other file driving this overlay uses. */
async function dragARegion(overlay: Page): Promise<void> {
  const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  const from = { x: b.x + 100, y: b.y + 80 };
  const to = { x: from.x + 200, y: from.y + 100 };
  await send(overlay, { t: "pointerdown", at: from });
  await send(overlay, { t: "pointermove", at: to });
  await send(overlay, { t: "pointerup", at: to });
  await awaitConfirmable(overlay);
}

describe("the bar's appearance", () => {
  test("the bar appears only after a selection, not while still dragging", async () => {
    const { win } = await launch();
    await win.click("#record");
    const overlay = await overlayWindow();

    // Nothing has been dragged yet.
    expect(await overlay.getAttribute("#bar", "hidden")).not.toBeNull();

    const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const from = { x: b.x + 100, y: b.y + 80 };
    const mid = { x: from.x + 100, y: from.y + 50 };
    const to = { x: from.x + 200, y: from.y + 100 };

    // Mid-drag: a marquee is being drawn, but nothing has been confirmed.
    // `onEvent`'s reduce path runs regardless of phase, so a settle wait
    // (rather than a positive poll for a change that must NOT happen) is what
    // proves this — there is nothing to wait FOR.
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: mid });
    await sleep(300);
    expect(await overlay.getAttribute("#bar", "hidden")).not.toBeNull();

    // The drag has ended (pointerup), but region mode only confirms on
    // Enter (selection.ts) — still nothing to show a bar for.
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await sleep(300);
    expect(await overlay.getAttribute("#bar", "hidden")).not.toBeNull();
    // `#ctl-record` has never been rendered with real geometry either — its
    // `data-enabled` attribute is only ever set inside the options-phase
    // branch of `renderBar` (overlay.ts).
    expect(await overlay.getAttribute("#ctl-record", "data-enabled")).toBeNull();

    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();
    expect(await overlay.getAttribute("#ctl-record", "data-enabled")).toBe("1");
  }, 120_000);
});

describe("Record reaches the countdown, then the helper", () => {
  test("the countdown appears, fires, and a take directory exists under the temp root", async () => {
    const { win, startLog, tempTakes } = await launch();
    const before = readdirSync(tempTakes).length;

    // Composed from named parts, not a round number with slack (bc9faaf) —
    // every wait this test can actually hit before its last poll settles:
    //   - the countdown itself: 900ms (SHORT_MS, same value
    //     countdown.e2e.test.ts uses for "elapses inside the test")
    //   - `_record-flow.ts`'s own per-step wait, 15s each, for up to three
    //     steps (the overlay appearing, a confirmable drag, the options bar
    //     appearing) before `#ctl-record` is ever pressed
    //   - the overlay's own teardown, HIDE_SETTLE_MS, imported rather than
    //     restated — it hides its windows before destroying them, and
    //     `countdown-window.ts` reuses the same constant for its own panel
    //   - the five literal `{ timeout: N }` polls below
    // Asserted, not just narrated: the outer bound below must actually clear
    // this sum, or a fix to any of the parts above could silently reopen the
    // exact gap bc9faaf closed.
    const SHORT_MS = 900;
    const RECORD_FLOW_STEPS_MS = 3 * 15_000;
    const POLLS_MS = 15_000 + 15_000 + 5_000 + 15_000 + 15_000;
    const composedFloorMs = SHORT_MS + RECORD_FLOW_STEPS_MS + HIDE_SETTLE_MS + POLLS_MS;
    const OUTER_MS = 120_000; // the literal on this test's own `}, N)` below
    expect(OUTER_MS).toBeGreaterThan(composedFloorMs);

    await withCountdown(win, SHORT_MS);
    await startRecordFlow(app!, win);

    await expect.poll(hasCountdownWindow, { timeout: 15_000 }).toBe(true);
    // Nothing has reached the helper yet — the countdown has not elapsed.
    expect(readLines(startLog)).toHaveLength(0);

    // …and then, with no further input, it does.
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(hasCountdownWindow, { timeout: 5_000 }).toBe(false);
    await expect.poll(async () => (await status(win)).state, { timeout: 15_000 }).toBe("recording");
    await expect.poll(() => readdirSync(tempTakes).length, { timeout: 15_000 }).toBe(before + 1);
  }, 120_000);
});

describe("Escape writes nothing, at either phase", () => {
  test("Escape in the select phase", async () => {
    const { win, startLog, tempTakes } = await launch();
    const before = readdirSync(tempTakes).length;
    await win.click("#record");
    const overlay = await overlayWindow();
    // A drawn, confirmable marquee — the case where something COULD have
    // been written, the same choice still-overlay.e2e.test.ts makes for its
    // own cancelled-shot test.
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Escape" });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 10_000 }).toBe(0);
    expect(readdirSync(tempTakes).length).toBe(before);
    expect(readLines(startLog)).toEqual([]);
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    expect(await win.textContent("#alert")).toBeFalsy();
  }, 120_000);

  test("Escape in the options phase — the newly reachable state", async () => {
    const { win, startLog, tempTakes } = await launch();
    const before = readdirSync(tempTakes).length;
    await win.click("#record");
    const overlay = await overlayWindow();
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    // Before this ticket there was no state between a selection and a take —
    // Escape here is reachable for the first time.
    await send(overlay, { t: "key", key: "Escape" });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 10_000 }).toBe(0);
    expect(readdirSync(tempTakes).length).toBe(before);
    expect(readLines(startLog)).toEqual([]);
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    expect(await win.textContent("#alert")).toBeFalsy();
  }, 120_000);
});

describe("the marquee stays adjustable with the bar up", () => {
  test("dragging a handle changes #ctl-size", async () => {
    const { win } = await launch();
    await win.click("#record");
    const overlay = await overlayWindow();
    const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    const before = (await overlay.textContent("#ctl-size"))?.trim();
    expect(before).toBeTruthy();

    // `reduce` (selection.ts) trusts the `handle` field on the event
    // directly — the same field the real view computes via hit-testing
    // before sending it (overlay.ts's `installRealInput`). No pixel-accurate
    // handle geometry is needed here, only a valid `Handle` id at a point
    // that still resolves through `state.rect`, which Enter left untouched.
    await send(overlay, { t: "pointerdown", at: to, handle: "se" });
    await send(overlay, { t: "pointermove", at: { x: to.x + 80, y: to.y + 80 } });
    await send(overlay, { t: "pointerup", at: { x: to.x + 80, y: to.y + 80 } });

    await expect.poll(() => overlay.textContent("#ctl-size"), { timeout: 10_000 }).not.toBe(before);
    // And the bar itself never left — this is the property that justifies it
    // living in the overlay window at all, not a side effect of the resize.
    expect(await overlay.getAttribute("#bar", "hidden")).toBeNull();
  }, 120_000);
});

describe("expand", () => {
  test("selects the whole display, and #ctl-expand reads as on", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await win.click("#record");
    const overlay = await overlayWindow();
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    expect(await overlay.getAttribute("#ctl-expand", "data-on")).toBe("0");
    await send(overlay, { t: "control", id: "expand" });
    await expect.poll(() => overlay.getAttribute("#ctl-expand", "data-on"), { timeout: 10_000 }).toBe("1");

    // Followed through to the take that actually starts: the whole display,
    // no crop — `record-options.ts`'s own contract for `fullDisplay`.
    await send(overlay, { t: "control", id: "record" });
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    expect(typeof cmd.displayId).toBe("number");
    expect(cmd.region).toBeUndefined();
    expect(cmd.windowId).toBeUndefined();
  }, 120_000);

  test("pressed while a WINDOW is picked settles as a full-display take, not a window one", async () => {
    // This combination was, until this test, proven only at the mechanism
    // level (a hand-built state passed straight to `confirm()` in
    // overlay-options.test.ts) — `_record-flow.ts` deliberately skipped
    // sending `expand` when a window was picked, so nothing exercised it
    // through the real flow. Task 9 extended the flow helper with
    // `expandAfterWindow` for exactly this.
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await startRecordFlow(app!, win, {
      // The stand-in's Finder window, same point `still-overlay.e2e.test.ts`
      // uses for its own window-mode test.
      windowAt: { x: 200, y: 200 },
      expandAfterWindow: true,
    });

    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    // The coherent answer, and the one `overlay-session.ts`'s `onControl`
    // comments say expand always produces: a window pick converted whole
    // into a full-display REGION, never a window outcome still carrying
    // `fullDisplay: true` — which would send the helper down its
    // full-display path for what claims to be a window take.
    expect(cmd.windowId).toBeUndefined();
    expect(typeof cmd.displayId).toBe("number");
    expect(cmd.region).toBeUndefined();
  }, 120_000);
});

describe("the hotkey toggles", () => {
  test("with a take running, firing the Record action stops it", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await startRecordFlow(app!, win);

    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await status(win)).state, { timeout: 15_000 }).toBe("recording");

    // `onRecordHotkey` (main.ts) — bound to the global shortcut and the
    // menu-bar item, neither of which this process can press (Playwright can
    // drive a page's keyboard; it cannot press a key at the window server,
    // hotkeys.e2e.test.ts's own header) — calls `sup.stopRecording()` when a
    // take is running. `recorder:stop`'s IPC handler calls exactly that same
    // function. This is the seam hotkeys.e2e.test.ts's own "full-display
    // capture" test already relies on: an IPC channel reaching the identical
    // main-process function a hotkey press would, rather than a synthesised
    // keypress.
    await win.evaluate(() => (window as any).recorder.stop());

    await expect.poll(async () => (await status(win)).state, { timeout: 15_000 }).not.toBe("recording");
  }, 120_000);
});
