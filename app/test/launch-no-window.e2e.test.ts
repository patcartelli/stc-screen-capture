import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeApp, APP_CLOSE_MS, stubQuitDialog } from "./_quit-fixture.js";
import { windowCount } from "./_windows.js";
import { startRecordFlow } from "./_record-flow.js";
import { pillPage, pillShowing, pillWindowState } from "./_pill.js";

/**
 * Launch to the menu bar (STC-502), through the real app.
 *
 * Every other e2e file opts back into the library window at launch
 * (`STC_OPEN_LIBRARY_ON_LAUNCH`, `_e2e-setup.ts`); this one switches that off
 * to see the real launch. The Dock half only means something on macOS, where
 * `app.dock` exists, so it is asserted there and the rest everywhere.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const darwin = process.platform === "darwin";
/**
 * `app.dock.hide()` takes about a second to show in `isVisible()` after the
 * last window closes (measured: repeated hide calls change nothing; it flips
 * ~1.1 s in), so a dock read that expects a CHANGE gets more than vitest's 1 s
 * poll default.
 */
const DOCK_POLL = { timeout: 5_000 };

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(settings?: Record<string, unknown>): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // A preference in place before launch, for a test that must not open the
  // library to set one (it would no longer be a take with no window).
  if (settings) writeFileSync(join(userData, "settings.json"), JSON.stringify(settings));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_OPEN_LIBRARY_ON_LAUNCH: "",
      STC_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), "stc-rec-")),
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
    },
  });
  return app;
}

const trayUp = (a: ElectronApplication) => a.evaluate(() => {
  const t = (globalThis as Record<string, unknown>).__stcTray as { isDestroyed(): boolean } | undefined;
  return !!t && !t.isDestroyed();
});

const dockUp = (a: ElectronApplication) => a.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible() ?? null);

/** What the Dock click does: Electron's own `activate`. */
const activate = (a: ElectronApplication) => a.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });

async function openLibraryPage(a: ElectronApplication): Promise<Page> {
  // `activate` is only listened for once startup has finished, and the tray is
  // the last thing it puts up; emitted any earlier the event is simply lost.
  await expect.poll(() => trayUp(a)).toBe(true);
  await activate(a);
  const page = await a.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function choose(page: Page, iconPlacement: string): Promise<void> {
  await page.evaluate(
    (v) => (window as unknown as { recorder: { setSettings(p: object): Promise<unknown> } })
      .recorder.setSettings({ iconPlacement: v }),
    iconPlacement,
  );
}

describe("launch to the menu bar", () => {
  test("a cold launch shows no window, only the menu-bar item (and the Dock icon)", async () => {
    const a = await launch();
    await expect.poll(() => trayUp(a)).toBe(true);
    // Exact, taken after the tray is up: startup is done by then.
    expect(await windowCount(a)).toBe(0);
    if (darwin) expect(await dockUp(a)).toBe(true);
  });

  test("the Dock icon opens the library, once, and closing it does not quit", async () => {
    const a = await launch();
    await expect.poll(() => trayUp(a)).toBe(true);
    const page = await openLibraryPage(a);
    await expect.poll(() => windowCount(a, "index.html")).toBe(1);
    // A second click raises the one that exists.
    await activate(a);
    await activate(a);
    expect(await windowCount(a, "index.html")).toBe(1);

    await page.close();
    await expect.poll(() => windowCount(a)).toBe(0);
    // Still running: the main process answers, and the menu-bar item is there.
    expect(await trayUp(a)).toBe(true);
    if (darwin) expect(await dockUp(a)).toBe(true);
  });

  test("Dock only: the menu-bar item goes at once, and the Dock icon stays through a window closing", async () => {
    const a = await launch();
    const page = await openLibraryPage(a);
    await choose(page, "dock");
    await expect.poll(() => trayUp(a)).toBe(false);
    if (darwin) expect(await dockUp(a)).toBe(true);
    await page.close();
    await expect.poll(() => windowCount(a)).toBe(0);
    if (darwin) expect(await dockUp(a)).toBe(true);
  });

  test("Menu bar only: the Dock icon is there while the library is open and leaves with it", async () => {
    const a = await launch();
    const page = await openLibraryPage(a);
    await choose(page, "menubar");
    await expect.poll(() => trayUp(a)).toBe(true);
    if (darwin) await expect.poll(() => dockUp(a), DOCK_POLL).toBe(true);
    await page.close();
    await expect.poll(() => windowCount(a)).toBe(0);
    if (darwin) await expect.poll(() => dockUp(a), DOCK_POLL).toBe(false);
    // And the Dock click is not how you come back from here — the menu bar is.
    expect(await trayUp(a)).toBe(true);
  });

  test("switching back brings the menu-bar item back", async () => {
    const a = await launch();
    const page = await openLibraryPage(a);
    await choose(page, "dock");
    await expect.poll(() => trayUp(a)).toBe(false);
    await choose(page, "both");
    await expect.poll(() => trayUp(a)).toBe(true);
  });

  test("a take started with no window open gets its pill, and no library appears, during or after", async () => {
    const a = await launch();
    // A stopped take leaves a panel, and quitting over one raises a modal.
    await stubQuitDialog(a);
    await expect.poll(() => trayUp(a)).toBe(true);
    expect(await windowCount(a, "index.html")).toBe(0);

    // The menu-bar door: the same `onSelect` a click on the item calls, with
    // no library window anywhere. `win` is only used by the window door.
    await startRecordFlow(a, undefined as unknown as Page, { door: "menu-bar" });

    // STC-524 made a library here and collapsed it into the pill. Since
    // STC-550 the pill is its own window and no library is made at all.
    await expect.poll(() => pillShowing(a), { timeout: 45_000 }).toBe(true);
    expect(await pillWindowState(a)).toMatchObject({ resizable: false, alwaysOnTop: true, focused: false });
    expect(await windowCount(a, "index.html")).toBe(0);
    const pill = await pillPage(a);
    await expect.poll(() => pill.textContent("#pill-timer"), { timeout: 20_000 }).toMatch(/^\d{2}:\d{2}$/);

    // And it stops the take it belongs to.
    await pill.click("#pill-stop");
    await expect.poll(() => pillWindowState(a).then((s) => s.exists), { timeout: 20_000 }).toBe(false);
    // The library was not on screen when the take began, so it stays away (decision 4).
    expect(await windowCount(a, "index.html")).toBe(0);
  }, 180_000);

  test("Menu bar only: a take started with no window puts no Dock icon up (STC-550 requirement 8)", async () => {
    if (!darwin) {
      process.stderr.write("SKIP: the Dock icon exists only on macOS\n");
      return;
    }
    const a = await launch({ iconPlacement: "menubar" });
    await stubQuitDialog(a);
    await expect.poll(() => trayUp(a)).toBe(true);
    await expect.poll(() => dockUp(a), DOCK_POLL).toBe(false);

    await startRecordFlow(a, undefined as unknown as Page, { door: "menu-bar" });
    await expect.poll(() => pillShowing(a), { timeout: 45_000 }).toBe(true);
    // Sampled across the take, not once. STC-524 made a library window here,
    // a document window, which is what put the icon up under this setting.
    for (let i = 0; i < 8; i++) {
      expect(await dockUp(a), `sample ${i}`).toBe(false);
      await new Promise((r) => setTimeout(r, 250));
    }
    await (await pillPage(a)).click("#pill-stop");
    await expect.poll(() => pillWindowState(a).then((s) => s.exists), { timeout: 20_000 }).toBe(false);
  }, 180_000);
});
