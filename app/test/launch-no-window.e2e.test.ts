import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { windowCount } from "./_windows.js";

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

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(): Promise<ElectronApplication> {
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
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
    if (darwin) await expect.poll(() => dockUp(a)).toBe(true);
    await page.close();
    await expect.poll(() => windowCount(a)).toBe(0);
    if (darwin) await expect.poll(() => dockUp(a)).toBe(false);
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
});
