import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";
import { stubQuitDialog } from "./_quit-fixture.js";
import { windowCount, hasWindow } from "./_windows.js";
import { toastText } from "./_toast.js";

/**
 * The selection overlay, end to end (STC-290).
 *
 * The interaction itself is decided by a pure function and tested without a
 * screen in `selection.test.ts`; what this file exists for is the WIRING, which
 * that one cannot see: that a real transparent window opens on the display, that
 * its events reach the reducer in the main process, that a confirmed selection
 * becomes a `capture-still` request carrying the right crop and display, and
 * that a cancelled one writes nothing at all.
 *
 * Events are injected through the overlay's own bridge rather than as synthetic
 * mouse input. Real input would be testing the window server's hit-testing —
 * which belongs on the Mac, in the runbook — and would make this the kind of
 * flaky gate the project has already paid for twice.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched {
  win: Page;
  recordings: string;
  tempTakes: string;
  stillLog: string;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const tempTakes = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    // The overlay must not take input from the window server while this suite
    // is injecting its own: a real pointermove landing mid-gesture rewrites the
    // marquee, which is what made this file flaky on master. See overlay.ts.
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: tempTakes, STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_STILL_LOG: stillLog, STC_OVERLAY_SYNTHETIC_INPUT: "1", ...extraEnv },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, tempTakes, stillLog };
}

/** The primary display's bounds, read from the main process rather than assumed. */
async function primaryBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
}

/**
 * The overlay window, once it is up.
 *
 * Identified by its URL rather than by being "the second window": the main
 * window is also in the list, and on a machine with two displays so are two
 * overlays. Bounded, with a message that says what was actually on screen — a
 * transparent screen-saver-level window is exactly the thing that might not
 * open on a CI runner, and "timeout" alone would not say so.
 */
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

/** Push one event through the overlay's own bridge, as the DOM handlers would. */
async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

/**
 * Wait until the drag has produced a selection the overlay would actually
 * confirm, and say what it saw if it never does.
 *
 * Not a sleep, and not politeness: `#size` is drawn from `confirm()`'s own
 * result (overlay.ts), so text in that chip IS the precondition Return needs.
 * Without this the tests pressed Return on a hope — and when the hope failed
 * they said nothing useful, because `reduce` treats an unconfirmable Return as
 * a NO-OP: the overlay stays open, the promise never settles, and the caller
 * waits out its own timeout with an empty string to show for it. That is how
 * this file went red on two master runs (#209, #213) with
 * `expected '' to contain 'macOS 14'` and no clue as to why.
 *
 * The failure message carries the overlay's state, so the next one names which
 * of `confirm()`'s five refusals fired instead of leaving it to be guessed.
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

const readRequests = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

describe("the selection overlay", () => {
  test("a region drag becomes a capture-still request and a shot on disk", async () => {
    const { win, tempTakes, stillLog } = await launch();

    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();

    // A 200x100 region, in GLOBAL points, well inside the display.
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });

    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 15_000 })
      .toMatch(/^Shot area/);

    // The overlay is gone, not merely hidden behind the main window.
    await expect.poll(() => windowCount(app!, "overlay.html"),
                      { timeout: 10_000 }).toBe(0);

    // Exactly one new directory, holding a shot the real loader accepts. The
    // shot lands in TEMP storage (STC-393) and STAYS there — nothing promotes
    // it to the library any more (STC-392: the panel never decides on its
    // own), so this reads temp storage directly rather than polling the
    // library for a promotion that will not happen.
    await expect.poll(() => readdirSync(tempTakes).length, { timeout: 15_000 }).toBe(1);
    const dirs = readdirSync(tempTakes);
    const shotDir = join(tempTakes, dirs[0]!);
    expect(existsSync(join(shotDir, "frame.png"))).toBe(true);
    const shot = parseShot(JSON.parse(readFileSync(join(shotDir, "shot.json"), "utf8")));
    expect(shot.kind).toBe("display-crop");

    // The request itself: display-local points, the display the drag was on,
    // and the overlay's own windows named for exclusion.
    const [req] = readRequests(stillLog);
    expect(req.kind).toBe("display-crop");
    expect(req.crop).toEqual({ x: 100, y: 80, width: 200, height: 100 });
    expect(req.displayId).toBe(await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id));
    expect(Array.isArray(req.excludeWindowIds)).toBe(true);
  }, 120_000);

  test("Escape leaves no window on screen and nothing on disk", async () => {
    const { win, recordings, stillLog } = await launch();
    const before = readdirSync(recordings);

    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    // Draw a marquee first: cancelling from a state with a selection is the
    // case where something COULD have been written.
    await send(overlay, { t: "pointerdown", at: { x: b.x + 50, y: b.y + 50 } });
    await send(overlay, { t: "pointermove", at: { x: b.x + 250, y: b.y + 250 } });
    await send(overlay, { t: "pointerup", at: { x: b.x + 250, y: b.y + 250 } });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Escape" });

    await expect.poll(() => windowCount(app!, "overlay.html"),
                      { timeout: 10_000 }).toBe(0);
    // Nothing captured, nothing written, and no status claimed.
    expect(readdirSync(recordings)).toEqual(before);
    expect(readRequests(stillLog)).toEqual([]);
    expect(await win.getAttribute("#stillstatus", "hidden")).not.toBeNull();
  }, 120_000);

  test("window mode hands over a window id, not a crop", async () => {
    const { win, tempTakes, stillLog } = await launch();
    await win.click("#capturestill");
    const overlay = await overlayWindow();

    // The stand-in's Finder window sits at (100,100) 400x300 in global points.
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });

    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 15_000 })
      .toMatch(/^Shot window/);

    const [req] = readRequests(stillLog);
    expect(req.kind).toBe("window");
    expect(req.windowId).toBe(4711);
    expect(req.crop).toBeUndefined();

    // Lands in TEMP storage (STC-393) and stays there — nothing promotes it
    // to the library any more (STC-392).
    await expect.poll(
      () => readdirSync(tempTakes).length,
      { timeout: 15_000 },
    ).toBe(1);
    const dirs = readdirSync(tempTakes);
    const shot = parseShot(JSON.parse(readFileSync(join(tempTakes, dirs[0]!, "shot.json"), "utf8")));
    expect(shot.kind).toBe("window");
    expect(shot.window?.id).toBe(4711);
  }, 120_000);

  test("a not-fully-visible window highlights on hover but a click does not capture it (STC-380)", async () => {
    const { win, recordings, stillLog } = await launch({ STC_FAKE_HIDDEN_WINDOW: "1" });
    const before = readdirSync(recordings).length;
    await win.click("#capturestill");
    const overlay = await overlayWindow();

    await send(overlay, { t: "key", key: " " });
    // The stand-in's third window (STC_FAKE_HIDDEN_WINDOW) sits at (1800,100)
    // 400x300, mostly off the 1920x1080 display — hover well inside its bounds.
    await send(overlay, { t: "pointermove", at: { x: 1900, y: 200 } });
    await expect.poll(async () => {
      const s = await overlay.evaluate(() => (window as any).__overlayState);
      return s?.hoveredWindowId;
    }, { timeout: 10_000 }).toBe(4713);

    await send(overlay, { t: "pointerdown", at: { x: 1900, y: 200 } });
    // Give a real capture-still request time to have gone out if this were a
    // selection, then check none did: the overlay refused the click rather
    // than merely being slow to answer it.
    await sleep(300);
    expect(readRequests(stillLog)).toEqual([]);
    expect(readdirSync(recordings).length).toBe(before);
    expect(await hasWindow(app!, "overlay.html")).toBe(true);

    // The overlay stays usable: a fully-visible window still captures normally.
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });
    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 15_000 })
      .toMatch(/^Shot window/);
    const [req] = readRequests(stillLog);
    expect(req.windowId).toBe(4711);
  }, 120_000);

  test("a helper that refuses the capture is reported, and no status is claimed", async () => {
    const { win } = await launch({ STC_FAKE_STILL_ERROR: "still-unsupported" });
    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    await send(overlay, { t: "pointerdown", at: { x: b.x + 10, y: b.y + 10 } });
    await send(overlay, { t: "pointermove", at: { x: b.x + 210, y: b.y + 110 } });
    await send(overlay, { t: "pointerup", at: { x: b.x + 210, y: b.y + 110 } });
    await awaitConfirmable(overlay);
    await send(overlay, { t: "key", key: "Enter" });

    await expect.poll(() => toastText(app!), { timeout: 15_000 })
      .toContain("macOS 14");
    expect(await win.getAttribute("#stillstatus", "hidden")).not.toBeNull();
  }, 120_000);

  test("the overlay still opens when the helper cannot list windows", async () => {
    // No grant: `windows` fails. Region mode needs no window list, so refusing
    // to open would deny the user the one mode that could still have worked —
    // and the capture below is where the real reason belongs.
    const { win } = await launch({ STC_FAKE_NO_DISPLAYS: "1" });
    await win.click("#capturestill");
    const overlay = await overlayWindow();
    await send(overlay, { t: "key", key: "Escape" });
    await expect.poll(() => windowCount(app!, "overlay.html"),
                      { timeout: 10_000 }).toBe(0);
  }, 120_000);
});
