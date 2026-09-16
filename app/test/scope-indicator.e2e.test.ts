import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { FLASH_HOLD_MS, FLASH_FADE_MS } from "../src/scope-indicator-window.js";
import { withoutCountdown } from "./_countdown-fixture.js";

/** Total time the flash's window can exist, hold plus fade, before it
 * destroys itself with no further input. Any test proving an EARLY cancel
 * asserts well inside this, or a natural expiry could pass the same test. */
const NATURAL_LIFETIME_MS = FLASH_HOLD_MS + FLASH_FADE_MS;

/**
 * The scope indicator's confirmation flash, wired through the real app
 * (STC-381).
 *
 * `scope-indicator.test.ts` proves the pure decision (`resolveIndicatorTarget`)
 * with no window; this drives the real `flashScopeIndicator` `main.ts` calls
 * from `pickCaptureTarget`, against the control-plane stand-in
 * `_fake-helper.mjs` — same arrangement `scope-picker.e2e.test.ts` already
 * uses for picking a window/area.
 *
 * ## The design this replaces — twice
 *
 * The first cut showed the outline on every main-window focus, for as long
 * as Scope stayed Window/Area. CONFIRMED ON HARDWARE to read as naggy rather
 * than helpful, once actually lived with — the ticket's own "Open" question,
 * answered by using the thing. Redesigned to a brief flash right after a
 * pick; tried at a 2000ms hold and STILL read as lingering, then tried with
 * a hard cut at the end of a much shorter hold and read as buggy — an
 * outline gone between one frame and the next looks like a glitch, not a
 * choice. What survives: hold briefly, then FADE out (`FLASH_FADE_MS`),
 * rather than either lingering or cutting.
 *
 * ## What this CANNOT check here, and why
 *
 * Same limit `pill.e2e.test.ts` already documents for this sandbox: Xvfb has
 * no window manager, so this does not assert the indicator's exact
 * on-screen geometry OR judge whether the fade looks smooth — that is
 * `docs/STC-381-RUNBOOK.md`'s. What IS verified: a window backed by
 * `scope-indicator.html` appears the instant a window or area is picked,
 * exists no longer than `FLASH_HOLD_MS + FLASH_FADE_MS` with no further
 * input, and is cancelled well before that natural lifetime by a scope
 * change, a Clear, or Record — all driven through the real
 * `pickCaptureTarget`/`recorder:setSettings`/`recorder:start` handlers, not
 * stubbed.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(): Promise<Page> {
  const { dir: recordings } = makeTakeFolder();
  const ud = mkdtempSync(join(tmpdir(), "stc-ud-"));
  app = await electron.launch({
    args: [root, `--user-data-dir=${ud}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
           STC_OVERLAY_SYNTHETIC_INPUT: "1" },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#scope");
  // STC-391: Record counts down now. The subject here is the flash, which
  // `recorder:start` cancels on its very first line either way — the countdown
  // would only add three seconds and a second window to every Record test.
  await withoutCountdown(win);
  return win;
}

async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("overlay.html")) return p;
    if (Date.now() - start > ms) throw new Error(`no overlay window appeared within ${ms}ms`);
    await sleep(50);
  }
}

async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

function hasIndicatorWindow(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().includes("scope-indicator.html")));
}

async function primaryBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
}

/** Picks the stand-in's Finder window (id 4711, 100,100,400x300 on display 1). */
async function pickWindowScope(win: Page): Promise<void> {
  await win.selectOption("#scope", "window");
  await win.click("#pickwindow");
  const overlay = await overlayWindow();
  await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
  await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });
  await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                    { timeout: 15_000 }).toBe(0);
  await expect.poll(() => win.textContent("#window-source-label"), { timeout: 10_000 })
    .toBe("Finder — Downloads");
}

describe("the scope indicator's confirmation flash", () => {
  test("never appears for Screen scope — there is nothing to pick", async () => {
    const win = await launch();
    expect(await win.inputValue("#scope")).toBe("display");
    await sleep(300);
    expect(await hasIndicatorWindow()).toBe(false);
  }, 120_000);

  test("picking a window flashes the outline, and it clears itself with no further input", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(true);
    await expect.poll(hasIndicatorWindow, { timeout: NATURAL_LIFETIME_MS + 5_000 }).toBe(false);
  }, 120_000);

  test("picking an area flashes the outline too", async () => {
    const win = await launch();
    await win.selectOption("#scope", "region");
    await win.click("#pickregion");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await expect.poll(() => overlay.textContent("#size"), { timeout: 15_000 }).toBeTruthy();
    await send(overlay, { t: "key", key: "Enter" });
    await expect.poll(() => win.textContent("#region-source-label"), { timeout: 10_000 })
      .toBe("200 × 100");
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(true);
  }, 120_000);

  // The three tests below assert well INSIDE `NATURAL_LIFETIME_MS`, not just
  // eventually — a timeout at or beyond it would pass just as well for a
  // flash that was never cancelled at all and simply ran out its own clock,
  // proving nothing about the cancel path each one exists to check.
  const WELL_BEFORE_NATURAL_EXPIRY_MS = NATURAL_LIFETIME_MS - 150;

  test("a scope change right after a pick cancels the flash early", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(true);

    // Switching to Area (nothing picked yet) — the flash must go at once,
    // not run out its own hold-then-fade.
    await win.selectOption("#scope", "region");
    await expect.poll(hasIndicatorWindow, { timeout: WELL_BEFORE_NATURAL_EXPIRY_MS }).toBe(false);
  }, 120_000);

  test("Clear right after a pick cancels the flash early", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(true);

    await win.click("#clearwindow");
    await expect.poll(hasIndicatorWindow, { timeout: WELL_BEFORE_NATURAL_EXPIRY_MS }).toBe(false);
  }, 120_000);

  test("Record right after a pick cancels the flash before a take can start", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(true);

    await win.click("#record");
    // Bounded by IPC dispatch latency, not by the hold/fade or anything the
    // fake helper does — `hideScopeIndicator` runs synchronously as the very
    // first line inside `recorder:start`.
    await expect.poll(hasIndicatorWindow, { timeout: WELL_BEFORE_NATURAL_EXPIRY_MS }).toBe(false);
  }, 120_000);
});
