import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { MAX_STACKED } from "../src/thumbnail.js";
import { UNDO_WINDOW_MS } from "../src/panel-actions.js";
import { stubQuitDialog } from "./_quit-fixture.js";

/**
 * The contract STC-392 reverses, end to end.
 *
 * `thumbnail.e2e.test.ts` used to assert that ignoring the panel WROTE the
 * shot — "there is no path where a capture is silently lost" was STC-296's
 * acceptance criterion and a timeout was how it was kept. STC-392 keeps the
 * same promise a different way: ignoring the panel writes nothing, because
 * the panel is still there and the take is still in temp storage where
 * STC-393's crash recovery will find it.
 *
 * This is a NEW file rather than an edit, because it is a different claim
 * about the same pixels and the two should be readable side by side.
 *
 * It has also become the home for the two other properties that only show up
 * with a real window and a real clock: Copy no longer promotes (D5) and the
 * ⌘⌫ trash key is gated behind the same settle window every other keyboard
 * accelerator is (focus rule 4).
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
// `app.close()` now waits on `runQuitTeardown()`'s chain (STC-392 Task 6):
// commit any pending trash (`shell.trashItem`), then closeThumbnail,
// closeOverlay, sup.shutdown. Comfortably under 2s locally, every time — but
// CI hit vitest's 10s hookTimeout default on this exact chain (run
// 35391437745), which is `nothing-lost.e2e.test.ts`'s own reason for a
// declared afterEach timeout (`TEARDOWN_MS`, `SETTLE_READY_MS + 20_000`).
// Same shape, same fix, since there is no equivalent settle constant this
// chain is bounded by to derive a tighter number from.
const TEARDOWN_MS = 30_000;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; }, TEARDOWN_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long enough that a timeout would certainly have fired.
 *
 * The old floor was 3 s and the old default 6 s; waiting 8 s means a
 * re-introduced clock at either value is caught rather than raced. The test's
 * own vitest timeout must exceed this — see the rule this repo learned in
 * `bc9faaf`.
 */
const LONGER_THAN_ANY_OLD_TIMEOUT_MS = 8_000;

/**
 * Playwright's own defaults sit OUTSIDE every bound a test writes.
 * `electron.launch()` and `page.waitForSelector()` (both inside `launch`,
 * below) are never given an override, so both run at Playwright's 30s
 * default — 60s of overhead every test in this file pays before its own
 * `expect.poll`s even start (STC-392 review, I3; `bc9faaf`'s rule). File-
 * scoped rather than declared once per `describe` — two copies of the same
 * overhead is the "one value, two copies" defect this codebase keeps naming.
 */
const PLAYWRIGHT_LAUNCH_OVERHEAD_MS = 60_000;

/** One `expect.poll`'s own bound, used to size a declared timeout from how many of these a test makes. */
const POLL_MS = 15_000;

interface PanelLaunch {
  win: Page;
  app: ElectronApplication;
  temp: string;
  recordings: string;
  destDir: string;
}

interface LaunchOpts {
  /** How many "display" captures to fire before returning. Default 1 — the single-panel case most of this file wants. */
  captures?: number;
  /** Extra env vars for the launched process — e.g. `STC_OVERLAY_SYNTHETIC_INPUT` for the one test that also drives the overlay. */
  extraEnv?: Record<string, string>;
}

/**
 * Launch the app and produce `captures` "display" shots (default 1), so that
 * many panels are up before the test body starts.
 *
 * The ONE fixture every test in this file uses (STC-392 review: three copies
 * of the same launch dance is the defect this repo names five ways) — Copy,
 * Save, the keyboard settle-window tests and the overflow-cap tests all need
 * the identical `electron.launch`/settings/env dance; where they differ is
 * how many captures they fire and, for one test, an extra env var — both
 * PARAMETERS here, which is what keeps this the only copy rather than a
 * second one with a different name (STC-392 review, I2: `launchBare` used to
 * be exactly that second copy).
 */
async function launch(opts: LaunchOpts = {}): Promise<PanelLaunch> {
  const { captures = 1, extraEnv = {} } = opts;
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"),
                JSON.stringify({ still: { destination: destDir } }));

  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp,
      STC_HELPER_BIN: FAKE_HELPER, STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  // NOT a click on the button: `#capturestill` opens the SELECTION overlay
  // (region mode) and needs a driven drag to ever produce a capture — see
  // `still-overlay.e2e.test.ts`'s `STC_OVERLAY_SYNTHETIC_INPUT` dance. This
  // file is about the panel, not the overlay, so it reaches the same
  // `display` capture every other thumbnail/nothing-lost e2e test uses.
  for (let i = 0; i < captures; i++) {
    const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
    if (!r.ok) throw new Error(`captureStill failed: ${JSON.stringify(r)}`);
  }

  if (captures > 0) {
    await expect.poll(() => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: POLL_MS }).toBe(captures);
  }
  return { win, app, temp, recordings, destDir };
}

/** The panel window for the take `launch` just captured (single-panel callers only). */
function panelWindow(app: ElectronApplication): Page {
  return app.windows().find((p) => p.url().includes("thumbnail.html"))!;
}

describe("the panel waits (STC-392)", () => {
  test("left alone, the panel is still there and the take is still in temp", async () => {
    const { app: electronApp, temp, recordings, destDir } = await launch();

    // The panel is up (`launch` already waited for it).
    let panels = electronApp.windows().filter((p) => p.url().includes("thumbnail.html"));
    expect(panels.length).toBe(1);

    await sleep(LONGER_THAN_ANY_OLD_TIMEOUT_MS);

    // Still up — this is the assertion the whole ticket is about.
    panels = electronApp.windows().filter((p) => p.url().includes("thumbnail.html"));
    expect(panels.length).toBe(1);
    // And nothing was written anywhere, because nothing was decided.
    expect(readdirSync(destDir)).toEqual([]);
    // The take is exactly where STC-393 put it.
    expect(readdirSync(temp).length).toBe(1);
    // `makeTakeFolder()` seeds `recordings` with its own fixture take so the
    // app has something to show at boot (the same reasoning every other file
    // using it states); filtered out here so this only names what THIS
    // capture would have promoted, which is nothing.
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toEqual([]);
  }, 40_000);

  test("Copy does not promote — the take is still in temp afterwards", async () => {
    // STC-393's runbook flagged exactly this: every `still:export` used to
    // promote, which was right when Copy was terminal. Under "Copy stays
    // open; you may still Save — or Trash", a Copy that promoted would leave
    // a Trash pressed afterwards deleting something already in the library.
    const { app: electronApp, temp, recordings } = await launch();
    const panel = panelWindow(electronApp);
    await panel.click("#copy");
    await panel.waitForFunction(() => document.getElementById("status")!.textContent === "Copied");

    expect(readdirSync(temp).length).toBe(1);
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toEqual([]);
    // And the panel is still up — the other half of the same rule.
    expect(electronApp.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);
  }, 40_000);

  test("the Style picker and Redact are disabled while Copy is in flight (STC-392 review, M6)", async () => {
    // `setActionsEnabled` used to cover `#actions button` only. A mode change
    // re-runs `draw()`, which REASSIGNS `composite`, and `run("copy")` reads
    // `composite` after two `await`s (`awaitComposite`, then `getImageData`)
    // — a Style pick or a Redact toggle landing in that window exports a
    // picture the status line's claimed mode does not match. Disabling is
    // synchronous, the very first thing `perform()` does before its own
    // first `await`, so it has already happened by the time `panel.click`'s
    // promise (which waits out the real DOM click dispatch) resolves.
    const { app: electronApp } = await launch();
    const panel = panelWindow(electronApp);
    await panel.click("#copy");
    expect(await panel.evaluate(() => (document.getElementById("mode") as HTMLSelectElement).disabled))
      .toBe(true);
    expect(await panel.evaluate(() => (document.getElementById("redact") as HTMLButtonElement).disabled))
      .toBe(true);

    await panel.waitForFunction(() => document.getElementById("status")!.textContent === "Copied");
    // Re-enabled once the action settles — Copy does not close the panel, so
    // there is a "back to normal" state to check, unlike Save/Edit/Trash.
    expect(await panel.evaluate(() => (document.getElementById("mode") as HTMLSelectElement).disabled))
      .toBe(false);
    expect(await panel.evaluate(() => (document.getElementById("redact") as HTMLButtonElement).disabled))
      .toBe(false);
  }, 40_000);

  test("Save promotes, and closes the panel", async () => {
    const { app: electronApp, temp, recordings } = await launch();
    const panel = panelWindow(electronApp);
    await panel.click("#save");
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: POLL_MS }).toBe(0);

    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(recordings).filter((n) => !n.startsWith(".") && n !== "2026-08-24_10-00-00"))
      .toHaveLength(1);
  }, 40_000);

  /**
   * The ⌘⌫ settle window (STC-392 focus rule 4), watched actually fire.
   *
   * "A guard nobody has watched fire is indistinguishable from one that
   * cannot fire" (CLAUDE.md) — `SETTLE_KEYS_MS` (`thumbnail-renderer.ts`) is
   * asserted against in no other test, so this is the one place a real
   * keystroke, dispatched at a real time, is checked against a real outcome
   * on both sides of the window.
   */
  test("⌘⌫ within the first 100ms of paint is ignored; the same key after 500ms deletes", async () => {
    const { app: electronApp, temp } = await launch();
    const panel = panelWindow(electronApp);
    await panel.waitForFunction(() => document.getElementById("card")!.className.includes("in"));
    const paintedAt = Date.now();

    const pressTrashKey = () => panel.evaluate(() => document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true })));

    // Well inside the settle window — dispatched immediately on detecting
    // paint, so this lands within `SETTLE_KEYS_MS`'s first 100ms in practice.
    // The elapsed check has to happen right here, at press time: it is
    // asserting the PRESS landed inside the window, and `SETTLE_KEYS_MS`
    // itself is 300ms, so a bound measured after an added sleep(100) has no
    // margin left over CI's own jitter (measured failing at 322ms on a real
    // CI run — the sleep, not the press, was what blew the budget).
    await pressTrashKey();
    expect(Date.now() - paintedAt).toBeLessThan(300);
    await sleep(100);
    expect(readdirSync(temp).length).toBe(1);
    expect(electronApp.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);

    // Past it: the same key now reaches `perform("trash")`.
    const elapsed = Date.now() - paintedAt;
    if (elapsed < 500) await sleep(500 - elapsed);
    await pressTrashKey();
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: POLL_MS }).toBe(0);
    // STC-392 Task 6 changed what "deletes" means: the panel closes on the
    // spot (it just did, above), but the take itself is only PROMISED —
    // still sitting in temp storage until the undo window elapses. The old
    // contract asserted `0` here; the new one is the whole point of this
    // ticket, exercised end to end by "pressing Trash promises a deletion..."
    // below.
    expect(readdirSync(temp).length).toBe(1);
  }, 40_000);
});

/**
 * The timed undo (STC-392 Task 6). `shell.trashItem` has no inverse, so
 * Trash does not trash anything on the spot: it PROMISES to
 * (`pending-trash.ts`), closes the panel, and puts up a toast. These three
 * tests are the whole promise, watched end to end — pressing Trash, taking
 * it back, and letting it stand.
 */
describe("Trash is a promise you can take back (STC-392 Task 6)", () => {
  /** The toast window for whichever take was just trashed, once one is up. */
  function toastWindow(electronApp: ElectronApplication): Page | undefined {
    return electronApp.windows().find((p) => p.url().includes("toast.html"));
  }

  test("pressing Trash closes the panel, puts up an undo toast, and leaves the take in temp", async () => {
    const { app: electronApp, temp } = await launch();
    await panelWindow(electronApp).click("#trash");

    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: POLL_MS }).toBe(0);
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("toast.html")).length,
                       { timeout: POLL_MS }).toBe(1);
    // Promised, not committed: `panel:trash`'s whole point for a fresh take.
    expect(readdirSync(temp).length).toBe(1);
    // Declared timeout: PLAYWRIGHT_LAUNCH_OVERHEAD_MS (60s, electron.launch +
    // waitForSelector, both inside `launch`) + `launch`'s own capture-count
    // poll (15s) + two polls here (15s each) = 105s summed; declared above
    // that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 3 * POLL_MS + 30_000);

  test("pressing Undo brings the panel back, and the take is still in temp", async () => {
    const { app: electronApp, temp } = await launch();
    await panelWindow(electronApp).click("#trash");
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("toast.html")).length,
                       { timeout: POLL_MS }).toBe(1);

    await toastWindow(electronApp)!.click("#undo");

    // The toast goes...
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("toast.html")).length,
                       { timeout: POLL_MS }).toBe(0);
    // ...and the panel comes back — ruling 4: an undo re-presents it.
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("thumbnail.html")).length,
                       { timeout: POLL_MS }).toBe(1);
    // Nothing was ever moved.
    expect(readdirSync(temp).length).toBe(1);
    // The re-presented panel still has a working Trash — undo did not spend
    // the take's only chance at one.
    expect(await panelWindow(electronApp).isVisible("#trash")).toBe(true);
    // Declared timeout: PLAYWRIGHT_LAUNCH_OVERHEAD_MS (60s) + `launch`'s own
    // capture-count poll (15s) + three polls here (15s each) = 120s summed;
    // declared above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 4 * POLL_MS + 30_000);

  test("letting the toast expire commits the deletion — temp ends up empty", async () => {
    const { app: electronApp, temp } = await launch();
    await panelWindow(electronApp).click("#trash");
    await expect.poll(() => electronApp.windows().filter((p) => p.url().includes("toast.html")).length,
                       { timeout: POLL_MS }).toBe(1);
    // Still there right after the promise, before any window has elapsed.
    expect(readdirSync(temp).length).toBe(1);

    // Bounded at UNDO_WINDOW_MS plus a margin comfortably past
    // `TRASH_SWEEP_INTERVAL_MS` (main.ts) so the sweep has certainly run
    // again after the window elapses — the note this task's brief itself
    // calls out: waiting OUT the real undo window, not racing it.
    await expect.poll(() => readdirSync(temp).length,
                       { timeout: UNDO_WINDOW_MS + 4_000 }).toBe(0);
    // The toast took itself down on the same schedule.
    expect(electronApp.windows().some((p) => p.url().includes("toast.html"))).toBe(false);
    // Declared timeout: PLAYWRIGHT_LAUNCH_OVERHEAD_MS (60s) + `launch`'s own
    // capture-count poll (15s) + the toast-appear poll (15s) + the undo-
    // window poll (UNDO_WINDOW_MS + 4s) = 94s + UNDO_WINDOW_MS summed;
    // declared above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + UNDO_WINDOW_MS + 4_000 + 30_000);
});

/**
 * The stack caps at three, and drops nothing (Task 5b / STC-392 D7).
 *
 * `thumbnail.test.ts` proves `hiddenCount`'s arithmetic with no window at
 * all; this is the wiring that arithmetic cannot see — that a burst of real
 * captures really leaves every `BrowserWindow` alive, that only `MAX_STACKED`
 * of them are actually `isVisible()`, and that the two independent hide
 * reasons (`hiddenForCapture`/`hiddenForOverflow`, `thumbnail-window.ts`)
 * really do compose rather than one clobbering the other.
 */
describe("the stack caps at three, and drops nothing (STC-392 D7)", () => {
  /** Every thumbnail window's url and real on-screen visibility, read from the main process. */
  async function thumbnailPanels(electronApp: ElectronApplication):
      Promise<{ url: string; visible: boolean }[]> {
    return electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().includes("thumbnail.html"))
        .map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })));
  }

  test("five captures in a burst leave FIVE alive panel windows, only MAX_STACKED visible", async () => {
    // THIS IS THE LOAD-BEARING HALF. `presentThumbnail` used to call
    // `settleAndDestroy()` (later `dismissNow()`) on whatever a burst pushed
    // past the cap — safe only because a panel had a default outcome (the
    // timeout's export), which STC-392 removed. The old behaviour here would
    // leave FOUR windows, the fifth already destroyed with its take exported
    // to nobody's request. "Nothing is dropped, only hidden" means the count
    // below is 5, not `MAX_STACKED`.
    const { win } = await launch({ captures: 5 });

    // A window's `isVisible()` only settles once its OWN page has painted
    // (`ThumbnailSession`'s `hasPainted` gate) — `presentThumbnail` returns
    // as soon as the `BrowserWindow` exists, well before `loadFile` has run
    // far enough to send `"painted"`. Poll the visible count itself rather
    // than reading it once right after `launch`'s own length poll settles.
    await expect.poll(() => thumbnailPanels(app!).then((p) => p.filter((x) => x.visible).length),
                       { timeout: POLL_MS }).toBe(MAX_STACKED);
    const panels = await thumbnailPanels(app!);
    expect(panels.length).toBe(5);
    expect(panels.filter((p) => !p.visible).length).toBe(5 - MAX_STACKED);
    // Declared timeout: PLAYWRIGHT_LAUNCH_OVERHEAD_MS (60s) + `launch`'s own
    // length poll (15s) + this test's visible-count poll (15s) = 90s summed;
    // declared well above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 2 * POLL_MS + 60_000);

  test("the newest panel's badge counts exactly the hidden ones", async () => {
    // Ruling 2: the badge's count has ONE owner (`hiddenCount`), and the
    // renderer is handed the answer rather than deriving it. This is the
    // closest an E2E can get to proving that without reaching into the
    // renderer's own module graph — it reads what the DOM actually shows.
    const { win } = await launch({ captures: 4 });
    await expect.poll(() => thumbnailPanels(app!).then((p) => p.filter((x) => x.visible).length),
                       { timeout: POLL_MS }).toBe(MAX_STACKED);

    // The newest panel is the one most recently presented — `thumbnailPanels`
    // has no ordering guarantee, so ask Electron for the frontmost by y
    // (bottom-right default corner: newest has the LARGEST y — the same
    // reasoning `crash-recovery.e2e.test.ts` already uses for this).
    const withY = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().includes("thumbnail.html"))
        .map((w) => ({ url: w.webContents.getURL(), y: w.getBounds().y })));
    const newestUrl = [...withY].sort((a, b) => b.y - a.y)[0]!.url;
    const newest = app!.windows().find((p) => p.url() === newestUrl)!;

    await expect.poll(() => newest.textContent("#overflow"), { timeout: POLL_MS }).toBe("+1");
    expect(await newest.isHidden("#overflow")).toBe(false);
    // Declared timeout: 60s overhead + `launch`'s poll (15s) + visible-count
    // poll (15s) + badge-text poll (15s) = 105s summed; declared above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 3 * POLL_MS + 60_000);

  test("clicking the badge expands the stack — the hidden panel IS the list", async () => {
    // Ruling 3: no second list UI. The spec's "clicking expands a list of
    // waiting takes with the same actions" is satisfied by un-hiding the
    // existing panel — there is no separate window or list view to open.
    // The assertion that actually CARRIES that claim is the visible-count
    // poll just below the click (STC-392 review, I5): a second list window
    // would leave the newest panel's own `#overflow` unaffected and the
    // hidden panel still invisible, so it is that visible-count moving to 4
    // that proves the click un-hid the EXISTING panel rather than opening
    // something new. The plain length check further below (still 4 windows,
    // the same four urls) is corroboration — on its own it is too weak a
    // claim, since it is scoped to `thumbnail.html` and would not notice a
    // second list surface opened at some OTHER url.
    const { win } = await launch({ captures: 4 });
    await expect.poll(() => thumbnailPanels(app!).then((p) => p.filter((x) => x.visible).length),
                       { timeout: POLL_MS }).toBe(MAX_STACKED);

    const withY = await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().includes("thumbnail.html"))
        .map((w) => ({ url: w.webContents.getURL(), y: w.getBounds().y })));
    const newestUrl = [...withY].sort((a, b) => b.y - a.y)[0]!.url;
    const newest = app!.windows().find((p) => p.url() === newestUrl)!;
    await expect.poll(() => newest.textContent("#overflow"), { timeout: POLL_MS }).toBe("+1");

    // Every REAL `BrowserWindow` that exists right now, of ANY url — read
    // from the MAIN process (`BrowserWindow.getAllWindows()`), not from
    // `app!.windows()`. Playwright's own window list only grows once it has
    // attached a driveable Page to a window's webContents, which can lag a
    // freshly-created window by a beat; a count taken that way was tried
    // first and, mutation-tested, missed a decoy window created alongside
    // the un-hide (STC-392 review, I5 follow-up) — it is not scoped to
    // `thumbnail.html` either, so a second list surface opened at some
    // other url would be caught here even though it would slip past
    // `thumbnailPanels`.
    const windowCountBefore = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await newest.click("#overflow");

    // THIS is the assertion that proves "no second list UI" — see the block
    // comment above. A second surface showing the same four takes would not
    // move this number.
    await expect.poll(() => thumbnailPanels(app!).then((p) => p.filter((x) => x.visible).length),
                       { timeout: POLL_MS }).toBe(4);
    const after = await thumbnailPanels(app!);
    expect(after.length).toBe(4);
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(windowCountBefore);
    // The badge itself has nothing left to announce.
    await expect.poll(() => newest.textContent("#overflow"), { timeout: POLL_MS }).toBe("+0");
    // Declared timeout: 60s overhead + `launch`'s poll (15s) + visible-count
    // poll before the click (15s) + badge +1 poll (15s) + visible-count poll
    // after the click (15s) + badge +0 poll (15s) = 135s summed; declared
    // above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 5 * POLL_MS + 60_000);

  test("a cancelled capture's hide/reshow cycle does not un-hide an overflow-hidden panel", async () => {
    // Ruling 1: two independent hide reasons. `beforeCapture` hides EVERY
    // panel (even ones already hidden by the cap) so it cannot appear in its
    // own screenshot; `afterCapture` lifts only that one reason. If the two
    // reasons shared one flag, `afterCapture`'s `reshow()` would incorrectly
    // un-hide the overflow panel here — and nothing else runs afterwards to
    // mask it, because a CANCELLED capture never reaches `presentThumbnail`
    // (no `restack()` to re-apply the cap). This is deliberately the
    // discriminating case a completed capture cannot be: a completed one
    // always ends in `restack()`, which would re-hide an incorrectly-shown
    // overflow panel and hide the bug along with it.
    const { win } = await launch({ captures: 4, extraEnv: { STC_OVERLAY_SYNTHETIC_INPUT: "1" } });
    // Same paint-settle reasoning as the burst test above.
    await expect.poll(() => thumbnailPanels(app!).then((p) => p.filter((x) => x.visible).length),
                       { timeout: POLL_MS }).toBe(MAX_STACKED);

    const before = await thumbnailPanels(app!);
    expect(before.filter((p) => p.visible).length).toBe(MAX_STACKED);
    const hiddenUrl = before.find((p) => !p.visible)!.url;

    // A region capture, cancelled: `hideThumbnailForCapture` hides every
    // panel, the overlay opens, Escape cancels it, and `showThumbnailsAfterCapture`
    // runs in `captureStill`'s `finally` with NO new panel ever presented.
    const captured = win.evaluate(() => (window as any).recorder.captureStill("region"));
    let overlay: Page | undefined;
    const overlayDeadline = Date.now() + POLL_MS;
    while (!overlay && Date.now() < overlayDeadline) {
      overlay = app!.windows().find((p) => p.url().includes("overlay.html"));
      if (!overlay) await sleep(50);
    }
    if (!overlay) throw new Error("no overlay window appeared");
    await overlay.evaluate(() => (window as any).overlay.send({ t: "key", key: "Escape" }));
    const r = await captured;
    expect(r.cancelled).toBe(true);

    // Give `afterCapture`'s `showInactive()` calls a moment to actually land.
    await sleep(300);
    const after = await thumbnailPanels(app!);
    expect(after.length).toBe(4);
    const stillHidden = after.find((p) => p.url === hiddenUrl);
    expect(stillHidden?.visible).toBe(false);
    // Every OTHER panel came back — the capture-hide reason was lifted.
    expect(after.filter((p) => p.url !== hiddenUrl && p.visible).length).toBe(MAX_STACKED);
    // Declared timeout: 60s overhead + `launch`'s poll (15s) + visible-count
    // poll (15s) + the manual overlay-wait loop's own bound (15s) = 105s
    // summed (the 300ms sleep is negligible); declared above that.
  }, PLAYWRIGHT_LAUNCH_OVERHEAD_MS + 3 * POLL_MS + 60_000);
});
