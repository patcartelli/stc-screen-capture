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
    // `barLayout` returns coordinates local to the overlay panel. Fixed
    // positioning treated them as viewport coordinates on macOS, visibly
    // pinning the bar at the bottom regardless of the selection; both the bar
    // and its menu therefore have to use the panel's absolute coordinate
    // system.
    expect(await overlay.evaluate(() => ({
      bar: getComputedStyle(document.querySelector("#bar")!).position,
      micMenu: getComputedStyle(document.querySelector("#micmenu")!).position,
    }))).toEqual({ bar: "absolute", micMenu: "absolute" });
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

  test("Record commits the ADJUSTED rect, not the one Enter confirmed (Finding 1, STC-388 review)", async () => {
    // Before the fix, `case "record"` in overlay-session.ts committed
    // `this.pending` — set only on Enter — so a handle drag AFTER Enter
    // changed the bar's own `#ctl-size` readout while Record still sent the
    // helper the pre-drag rect. This drives drag -> Enter -> adjust -> Record
    // end to end and asserts the HELPER's own start request, not just the
    // readout, so both symptoms named in the finding are checked directly.
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await win.click("#record");
    const overlay = await overlayWindow();
    const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const scaleFactor: number = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" }); // pending = R1 (200x100 pts)
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();
    const beforeReadout = (await overlay.textContent("#ctl-size"))?.trim();
    expect(beforeReadout).toBe(`${Math.round(200 * scaleFactor)} × ${Math.round(100 * scaleFactor)}`);

    // Adjust the marquee AFTER Enter — no new outcome, so pre-fix `pending`
    // stayed R1 while the readout moved on.
    const adjustedTo = { x: to.x + 80, y: to.y + 80 };
    await send(overlay, { t: "pointerdown", at: to, handle: "se" });
    await send(overlay, { t: "pointermove", at: adjustedTo });
    await send(overlay, { t: "pointerup", at: adjustedTo });
    await expect.poll(() => overlay.textContent("#ctl-size"), { timeout: 10_000 }).not.toBe(beforeReadout);
    const afterReadout = (await overlay.textContent("#ctl-size"))?.trim();
    expect(afterReadout).toBe(`${Math.round(280 * scaleFactor)} × ${Math.round(180 * scaleFactor)}`);

    await send(overlay, { t: "control", id: "record" });
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    expect(cmd.windowId).toBeUndefined();
    expect(cmd.region).toBeDefined();
    const committed = `${Math.round(cmd.region.width * scaleFactor)} × ${Math.round(cmd.region.height * scaleFactor)}`;
    // The real assertion: what got committed is what the readout showed —
    // the ADJUSTED rect (280x180 pts) — not the stale R1 (200x100 pts).
    expect(committed).toBe(afterReadout);
    expect(committed).not.toBe(beforeReadout);
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

/**
 * Fires the REAL tray callback (main.ts's `installTray(...)`'s `onSelect`),
 * not `sup.stopRecording()`/`runRecordFlow` one layer below it. `tray.ts`
 * exposes it on `globalThis` for exactly this — the same reason `__stcTray`
 * already exists — because Electron has no synthetic click for a `Tray`'s
 * menu and Playwright cannot press a global hotkey at the window server
 * (hotkeys.e2e.test.ts's own header). "action:record" is the SAME id the
 * menu-bar Record item and ⌃⌥⇧⌘4 both resolve to.
 */
async function fireTrayRecord(): Promise<void> {
  await app!.evaluate(() => (globalThis as any).__stcTrayOnSelect("action:record"));
}

const pickersLocked = (win: Page): Promise<boolean> =>
  win.evaluate(() => {
    const camera = document.getElementById("camera") as HTMLInputElement;
    const display = document.getElementById("display") as HTMLSelectElement;
    const mic = document.getElementById("mic") as HTMLSelectElement;
    return camera.disabled && display.disabled && mic.disabled;
  });

describe("the hotkey/tray toggles reach the main window (Finding 2, STC-388 review)", () => {
  test("a tray-initiated STOP clears the window's Stop/recording/locked state", async () => {
    // Started from the WINDOW's own button — this test is about the STOP
    // direction, so how the take began does not matter. The finding's bug is
    // that a stop from a DIFFERENT door than the one that started it left the
    // window believing a recording was still live.
    //
    // `app/test/timeout-budget.test.ts` caught this test with ZERO clearance
    // (8 x 15s inner bounds under a 120s outer one — exactly equal, the case
    // that guard exists for). Fixed by REDUCING what the test waits on, not
    // by picking a bigger round number: the pre- and post-stop checks were
    // each three or four separate polls for facts that only matter TOGETHER
    // (the button's text, `#state`, and the pickers' locked-ness are one
    // claim about "what the window shows right now", not three), so each
    // group is now ONE predicate. Composed here, not asserted as a round
    // number, the same way the countdown test above does:
    //   - `startRecordFlow` (`_record-flow.ts`) itself hides up to THREE
    //     internal 15s bounds (the overlay appearing, a confirmable drag, the
    //     options bar appearing) that this file's guard cannot see, the same
    //     hidden cost the countdown test already accounts for by name.
    //   - the three bounds still visible to the guard, below.
    const RECORD_FLOW_STEPS_MS = 3 * 15_000;
    const START_LOG_MS = 15_000;
    const PRE_STOP_MS = 15_000;
    const POST_STOP_MS = 15_000;
    const composedFloorMs = RECORD_FLOW_STEPS_MS + START_LOG_MS + PRE_STOP_MS + POST_STOP_MS;
    const OUTER_MS = 120_000; // the literal on this test's own `}, N)` below
    expect(OUTER_MS).toBeGreaterThan(composedFloorMs);

    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await startRecordFlow(app!, win);

    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);

    // The starting condition this test needs — recording, showing "Stop",
    // pickers locked — as ONE predicate rather than three independent polls.
    const uiNow = async () => {
      const [state, label, locked] = await Promise.all([
        status(win).then((s) => s.state), win.textContent("#record"), pickersLocked(win),
      ]);
      return { state, label, locked };
    };
    await expect.poll(uiNow, { timeout: 15_000 })
      .toEqual({ state: "recording", label: "Stop", locked: true });

    // The tray's own callback, exactly as the menu bar or ⌃⌥⇧⌘4 would reach
    // it — `onRecordHotkey` — not `recorder.stop()`/`sup.stopRecording()` one
    // layer below it, which is what this test asserted before this fix and
    // is exactly the gap Finding 2 named: the window has NOTHING wired to a
    // stop that did not come through its own click handler.
    await fireTrayRecord();

    // The actual subject, as one predicate: before Finding 2's fix NONE of
    // this ever changed — the button kept reading "Stop", `#state` stayed
    // "recording", and the pickers stayed locked for the rest of the session
    // — pressing "Stop" then requested `stop` on an already-idle helper and
    // wedged the window.
    const uiAfter = async () => {
      const [state, label, stateText, locked] = await Promise.all([
        status(win).then((s) => s.state), win.textContent("#record"),
        win.textContent("#state"), pickersLocked(win),
      ]);
      return { state, label, stateText, locked };
    };
    await expect.poll(uiAfter, { timeout: 15_000 })
      .toEqual({ state: "idle", label: "Record", stateText: "idle", locked: false });
  }, 120_000);

  test("a tray-initiated START locks the window and shows Stop", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    expect(await win.textContent("#record")).toBe("Record");
    expect(await pickersLocked(win)).toBe(false);

    // The tray's own callback with nothing recording opens the SAME overlay
    // `runRecordFlow("menu-bar")` always has — the window never clicked
    // anything. Driven the same way `_record-flow.ts` drives the window
    // door, just starting from the tray instead of `win.click("#record")`.
    await fireTrayRecord();
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
    await send(overlay, { t: "control", id: "record" });

    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await status(win)).state, { timeout: 15_000 }).toBe("recording");
    // Before Finding 2's fix: the window never learned any of this happened.
    // The button kept reading "Record" and the pickers stayed editable
    // mid-take — the comment above `lockSettings(true)` says that must never
    // happen — and pressing Record then asked the helper to start a SECOND
    // take, answered `already-recording`, a code with no `START_FAULTS`
    // entry, surfacing a raw error string.
    await expect.poll(() => win.textContent("#record"), { timeout: 15_000 }).toBe("Stop");
    await expect.poll(() => win.textContent("#state"), { timeout: 15_000 }).toBe("recording");
    await expect.poll(() => pickersLocked(win), { timeout: 15_000 }).toBe(true);
  }, 120_000);
});

describe("recordFlowActive guards its own gap (Finding 6, STC-388 review)", () => {
  test("a second call in the SAME synchronous tick is refused, not a second flow", async () => {
    const { win, startLog, tempTakes } = await launch();
    await withoutCountdown(win);

    // Two calls in one synchronous tick, exploiting exactly the gap Finding 6
    // names: `runRecordFlow`'s guard and its `recordFlowActive = true` now
    // both run BEFORE its first `await` (`sup.listWindows()`), so calling it
    // twice with nothing awaited in between means the first call's sync
    // prefix — guard included — completes before the second call's guard
    // ever runs. Before the fix, the flag was set only AFTER two awaited
    // helper round trips, so this exact pattern passed the guard twice.
    await app!.evaluate(() => {
      const onSelect = (globalThis as any).__stcTrayOnSelect;
      onSelect("action:record");
      onSelect("action:record");
    });

    // Only ONE overlay ever opens — the second call never reached
    // `recordFlowBody`/`openOverlay` at all.
    await sleep(300);
    expect(app!.windows().filter((p) => p.url().includes("overlay.html")).length).toBe(1);

    // Drive the one real flow through to a take, and confirm exactly ONE
    // `start` reached the helper — not two racing for the same temp dir.
    const overlay = await overlayWindow();
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();
    await send(overlay, { t: "control", id: "record" });

    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await status(win)).state, { timeout: 15_000 }).toBe("recording");
    // No alert from a second flow's `bad-state` reaching the window.
    expect(await win.textContent("#alert")).toBeFalsy();
    expect(readdirSync(tempTakes).length).toBe(1);
    // Settled: no further start ever lands, even after giving a stray second
    // flow time to have reached the helper.
    await sleep(500);
    expect(readLines(startLog).length).toBe(1);
  }, 120_000);
});

describe("Space after Enter must not let Record commit a mere hover (re-review regression)", () => {
  // Regression found in the scoped re-review of ee79b93: `case "record"`
  // keyed its guard on `this.pending?.kind === "window"`, but the hazard it
  // exists to prevent — committing a HOVER instead of a click — is keyed on
  // `this.state.mode`, not on what was last committed. Sequence: drag a
  // region, Enter (`pending` = region, `state.mode` = "region"). Press Space
  // — reachable from the options phase, since `overlay.ts` forwards it in
  // any phase — which flips `state.mode` to "window" and sets
  // `hoveredWindowId` from the current pointer, with NO new outcome
  // (selection.ts's Space handler). `pending.kind` is still `"region"`, so
  // the old guard took the `confirm(this.state, this.ctx)` branch — with
  // `state.mode === "window"` — either committing whatever was merely
  // hovered, or (nothing hoverable under the pointer) silently doing
  // nothing at all.
  test("hovering a real window after Space does not commit it — the region is committed instead", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await win.click("#record");
    const overlay = await overlayWindow();
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    // Toggle to window mode and HOVER a real window — the stand-in's Finder
    // window, the same point `still-overlay.e2e.test.ts` and this file's own
    // "expand" tests use for a window pick — but never click it.
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });

    await send(overlay, { t: "control", id: "record" });
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    // The real assertion: NOT the hovered window. Before the fix this was
    // `windowId: 4711` (or whichever stand-in window sits under the point).
    expect(cmd.windowId).toBeUndefined();
    expect(cmd.region).toBeDefined();
  }, 120_000);

  test("hovering NOTHING after Space still commits the pending region, rather than a silent no-op", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await win.click("#record");
    const overlay = await overlayWindow();
    await dragARegion(overlay);
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    // Toggle to window mode, but hover empty desktop — well clear of the
    // stand-in's two windows (bounds up to x:1000,y:750 — see _fake-helper.mjs).
    const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: { x: b.x + b.width - 20, y: b.y + b.height - 20 } });

    await send(overlay, { t: "control", id: "record" });
    // The decided answer (not a silent no-op): falls back to the pending
    // region, the last thing actually committed.
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    expect(cmd.windowId).toBeUndefined();
    expect(cmd.region).toBeDefined();
  }, 120_000);
});

describe("switching a picked window back to an area keeps the bar honest", () => {
  test("the bar readout and Record both follow the new marquee", async () => {
    const { win, startLog } = await launch();
    await withoutCountdown(win);
    await win.click("#record");
    const overlay = await overlayWindow();
    const b = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const scaleFactor: number = await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);

    // Pick the stand-in's Finder window first, which opens the options bar
    // with a window outcome and no marquee rect.
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: { x: b.x + 200, y: b.y + 200 } });
    await send(overlay, { t: "pointerdown", at: { x: b.x + 200, y: b.y + 200 } });
    await expect.poll(() => overlay.getAttribute("#bar", "hidden"), { timeout: 15_000 }).toBeNull();

    // Space is still live in the options phase. Switch back to region mode
    // and draw a distinctly sized marquee. Before this regression fix the
    // bar stayed anchored to the pending window, while Record correctly sent
    // this region — visible target and committed target diverged.
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);

    const expectedReadout = `${Math.round(200 * scaleFactor)} × ${Math.round(100 * scaleFactor)}`;
    await expect.poll(() => overlay.textContent("#ctl-size"), { timeout: 10_000 }).toBe(expectedReadout);

    await send(overlay, { t: "control", id: "record" });
    await expect.poll(() => readLines(startLog).length, { timeout: 15_000 }).toBe(1);
    const [cmd] = readLines(startLog);
    expect(cmd.windowId).toBeUndefined();
    expect(cmd.region).toBeDefined();
    expect(`${Math.round(cmd.region.width * scaleFactor)} × ${Math.round(cmd.region.height * scaleFactor)}`)
      .toBe(expectedReadout);
  }, 120_000);
});
