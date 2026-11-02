import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { pageWithUrl, clickThatCloses } from "./_windows.js";
import { readRequests, exportRequests } from "./_still-log.js";
import { parseShot } from "../../transform/src/shot.js";
import { WALLPAPER_NOTICE } from "../src/window-look.js";
import { LOOKS, lookWrite, wallpaperLookWrite } from "../../transform/src/backgrounds.js";

/**
 * A fresh window shot wears the Settings look (STC-628), wired end to end: the
 * request asks the helper for the wallpaper, main rewrites `shot.json` with
 * the look, and a wallpaper that could not be read falls back to Clean and
 * SAYS so in the panel, even for a "copy to clipboard" capture, which then
 * still copies. The decisions are `window-look.test.ts`'s; this is the wiring.
 *
 * The stand-in helper answers `wallpaper: true` with a real `wallpaper.jpg`,
 * or with `wallpaperError` under STC_FAKE_WALLPAPER=fail.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(settings: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on disk: `thumbnail.skip` could go through `recorder:setSettings`,
  // but one seed keeps every test's starting state in one place.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null, ...settings }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp, STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog, STC_NO_SHUTTER: "1", STC_OVERLAY_SYNTHETIC_INPUT: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#titlebar");
  return { win, temp, stillLog, userData };
}

async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("overlay.html")) return p;
    if (Date.now() - start > ms) throw new Error(`no overlay window appeared within ${ms}ms`);
    await sleep(50);
  }
}

/** A window shot of the stand-in's Finder window, at (100,100) 400x300 global points. */
async function shootWindow(win: Page): Promise<void> {
  await win.evaluate(() => { void (window as any).recorder.captureStill("window"); });
  const overlay = await overlayWindow();
  await overlay.evaluate((e) => (window as any).overlay.send(e), { t: "pointermove", at: { x: 200, y: 200 } });
  await overlay.evaluate((e) => (window as any).overlay.send(e), { t: "pointerdown", at: { x: 200, y: 200 } });
}

const captures = (log: string) => readRequests(log).filter((x) => x.rgba === undefined);

function onlyShot(temp: string) {
  const dirs = readdirSync(temp);
  expect(dirs.length).toBe(1);
  const dir = join(temp, dirs[0]!);
  return { dir, shot: parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))) };
}

/** Whether a thumbnail panel is actually on screen, read from main. */
function panelVisible(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some((w) => w.webContents.getURL().includes("thumbnail.html") && w.isVisible()));
}

/** A window shot's panel, Edit pressed, and the still editor it opens on the promoted shot. */
async function editorOnWindowShot(win: Page): Promise<{ editor: Page; dir: string }> {
  await shootWindow(win);
  const panel = await pageWithUrl(app!, "thumbnail.html");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className),
                    { timeout: 15_000 }).toContain("in");
  await clickThatCloses(panel, "#edit");
  const editor = await pageWithUrl(app!, "still-editor.html");
  await editor.waitForSelector("#stagecanvas");
  const dir = await editor.evaluate(() => new URLSearchParams(location.search).get("dir")!);
  return { editor, dir };
}

const storedSettings = (userData: string) => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));

describe("window shot looks (STC-628)", () => {
  test("the default look asks for the wallpaper and writes it into the shot", async () => {
    const { win, temp, stillLog } = await launch({});
    await shootWindow(win);
    await expect.poll(() => captures(stillLog).length, { timeout: 15_000 }).toBe(1);
    expect(captures(stillLog)[0].wallpaper).toBe(true);

    const panel = await pageWithUrl(app!, "thumbnail.html");
    await expect.poll(() => panelVisible(), { timeout: 15_000 }).toBe(true);
    const { dir, shot } = onlyShot(temp);
    expect(shot.decoration.mode).toBe("window-shadow-custom-background");
    expect(shot.decoration.background).toMatchObject({ kind: "wallpaper", file: "wallpaper.jpg" });
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(true);
    // A wallpaper that was read has nothing to say.
    expect(await panel.textContent("#status")).not.toContain(WALLPAPER_NOTICE);
  }, 120_000);

  test("an unreadable wallpaper uses Clean and shows the panel even in clipboard mode, which still copies", async () => {
    const { win, temp, stillLog } = await launch({ thumbnail: { skip: true } }, { STC_FAKE_WALLPAPER: "fail" });
    await shootWindow(win);

    const panel = await pageWithUrl(app!, "thumbnail.html");
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toBe(WALLPAPER_NOTICE);
    await expect.poll(() => panelVisible(), { timeout: 15_000 }).toBe(true);
    // The copy the clipboard preference asked for still happened.
    await expect.poll(() => exportRequests(stillLog).some((x) => x.clipboard === true),
                      { timeout: 15_000 }).toBe(true);

    const { shot } = onlyShot(temp);
    expect(shot.decoration.mode).toBe("window-shadow-background");
    expect(shot.decoration.background?.kind).not.toBe("wallpaper");
  }, 120_000);

  test("a region shot is never asked for a wallpaper and keeps its own mode", async () => {
    const { win, temp, stillLog } = await launch({});
    const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
    expect(r.ok).toBe(true);
    expect(captures(stillLog)[0].wallpaper).toBeUndefined();
    expect(onlyShot(temp).shot.decoration.mode).toBe("selected-area");
  }, 120_000);

  test("the editor's Capture-backgrounds pick is remembered; a wallpaper pick is not", async () => {
    const { win, userData } = await launch({ windowShotLook: "window-only" });
    const { editor, dir } = await editorOnWindowShot(win);
    const dark = lookWrite(LOOKS.find((l) => l.id === "dark")!);

    await editor.evaluate(([d, w]) => (window as any).stillEditor.writeShot(d, [], w), [dir, dark] as const);
    await expect.poll(() => storedSettings(userData).lastBackgroundLook, { timeout: 10_000 }).toEqual(dark);

    // Wallpaper is not a Capture background: the remembered one stays Dark.
    await editor.evaluate(([d, w]) => (window as any).stillEditor.writeShot(d, [], w),
                          [dir, wallpaperLookWrite("wallpaper.jpg")] as const);
    expect(parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.background?.kind)
      .toBe("wallpaper");
    expect(storedSettings(userData).lastBackgroundLook).toEqual(dark);
  }, 120_000);

  test("the editor can fetch the wallpaper now, or is told why not", async () => {
    const { win } = await launch({ windowShotLook: "window-only" });
    const { editor, dir } = await editorOnWindowShot(win);
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(false);
    const r = await editor.evaluate((d) => (window as any).stillEditor.fetchWallpaper(d), dir);
    expect(r).toEqual({ ok: true, file: "wallpaper.jpg" });
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(true);
  }, 120_000);

  test("a wallpaper the editor cannot fetch answers the fallback line", async () => {
    const { win } = await launch({ windowShotLook: "window-only" }, { STC_FAKE_WALLPAPER: "fail" });
    const { editor, dir } = await editorOnWindowShot(win);
    const r = await editor.evaluate((d) => (window as any).stillEditor.fetchWallpaper(d), dir);
    expect(r).toEqual({ ok: false, notice: WALLPAPER_NOTICE });
  }, 120_000);
});
