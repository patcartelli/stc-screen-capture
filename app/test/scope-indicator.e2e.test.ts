import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The persistent scope indicator, wired through the real app (STC-381).
 *
 * `scope-indicator.test.ts` proves the pure decision (`resolveIndicatorTarget`)
 * with no window; this drives the real `attachScopeIndicator` main.ts wires
 * up, against the control-plane stand-in `_fake-helper.mjs` — same arrangement
 * `scope-picker.e2e.test.ts` already uses for picking a window/area.
 *
 * ## What this CANNOT check here, and why
 *
 * Same limit `pill.e2e.test.ts` already documents for this sandbox: Xvfb has
 * no window manager, so real OS-mediated focus changes and `setBounds` do not
 * reliably round-trip (`getBounds()` can read back unchanged). So this file
 * does not click through the desktop to focus/blur the window, and it does
 * not assert the indicator's exact on-screen geometry — that is
 * `docs/STC-381-RUNBOOK.md`'s, once someone writes it, not this file's.
 * Instead it emits `focus`/`blur` on the real `BrowserWindow` directly
 * (`win.emit("focus")`), which is not a simulation of the DOM event but the
 * exact call Electron's own native layer makes when it fires one for real —
 * the listeners `attachScopeIndicator` installs cannot tell the difference.
 * What IS verified: a second window backed by `scope-indicator.html` appears
 * on focus (and only when there is a resolved window/area target — never for
 * Screen scope), disappears on blur, disappears on a scope/clear change even
 * while still focused, and disappears immediately on Record — all driven
 * through the real `recorder:setSettings`/`pickCaptureTarget`/`recorder:start`
 * handlers, not stubbed.
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
  // The indicator refuses to draw while `sup.state` is "starting" — wait past
  // the fake helper's own `ready`/first heartbeat the same way the scope
  // picker tests wait for #record to become enabled.
  await win.waitForFunction(() => (window as any).recorder !== undefined);
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

function focusMainWindow(): Promise<void> {
  return app!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("index.html"));
    w?.emit("focus");
  });
}

function blurMainWindow(): Promise<void> {
  return app!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes("index.html"));
    w?.emit("blur");
  });
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

describe("the persistent scope indicator", () => {
  test("never appears for Screen scope, even focused", async () => {
    const win = await launch();
    expect(await win.inputValue("#scope")).toBe("display");
    await focusMainWindow();
    await sleep(300);
    expect(await hasIndicatorWindow()).toBe(false);
  }, 120_000);

  test("appears on focus once a window is chosen, and disappears on blur", async () => {
    const win = await launch();
    await pickWindowScope(win);

    await focusMainWindow();
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(true);

    await blurMainWindow();
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(false);
  }, 120_000);

  test("disappears immediately on a scope change, even while still focused", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await focusMainWindow();
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(true);

    // Switching to Area (region, nothing picked yet) is a scope change with
    // no resolved target — the outline must go at once, not wait for a blur.
    await win.selectOption("#scope", "region");
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(false);
  }, 120_000);

  test("disappears immediately on Clear, even while still focused", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await focusMainWindow();
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(true);

    await win.click("#clearwindow");
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(false);
  }, 120_000);

  test("is gone the moment Record is pressed — never present once a take starts", async () => {
    const win = await launch();
    await pickWindowScope(win);
    await focusMainWindow();
    await expect.poll(hasIndicatorWindow, { timeout: 10_000 }).toBe(true);

    await win.click("#record");
    // A short poll rather than an immediate check: the click still has to
    // cross the IPC round trip to reach `recorder:start`. Once it does,
    // `hideScopeIndicatorForRecording` runs synchronously as the very first
    // thing inside the handler, before the helper is ever touched — so this
    // is bounded by IPC dispatch latency, not by anything the fake helper
    // does, and should clear in well under a second.
    await expect.poll(hasIndicatorWindow, { timeout: 5_000 }).toBe(false);
  }, 120_000);
});
