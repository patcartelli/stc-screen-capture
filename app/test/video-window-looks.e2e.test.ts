import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { stubQuitDialog, closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { pageWithUrl } from "./_windows.js";
import { startRecordFlow } from "./_record-flow.js";
import { pressStop, recorderState } from "./_library-window.js";
import { wallpaperFraming } from "../../transform/src/framing.js";
import { WALLPAPER_TAKE_NOTICE } from "../src/window-look.js";

/**
 * A new window take wears the Settings look (STC-626), wired end to end through
 * the real overlay and record flow: the read reaches the take's folder, the seed
 * says so, and a read that fails is Clean and said on the panel. The decisions are
 * `window-look.test.ts`'s and `take-project.test.ts`'s; this is the wiring.
 *
 * The stand-in helper's `wallpaper` verb writes a real `wallpaper.jpg`, or fails
 * under STC_FAKE_WALLPAPER=fail.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(settings: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}) {
  const { dir: recordings } = makeTakeFolder();
  const temp = mkdtempSync(join(tmpdir(), "stc-temp-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null, countdownMs: 0, ...settings }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: temp, STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1", STC_OVERLAY_SYNTHETIC_INPUT: "1", ...extraEnv,
    },
  });
  await stubQuitDialog(app);
  const win = await app.firstWindow();
  await win.waitForSelector("#titlebar");
  return { win, temp };
}

/** The stand-in's Finder window is at (100,100) 400x300 global points. */
async function recordWindow(win: Page, temp: string): Promise<string> {
  await startRecordFlow(app!, win, { windowAt: { x: 200, y: 200 } });
  await expect.poll(() => recorderState(win), { timeout: 15_000 }).toBe("recording");
  await expect.poll(() => readdirSync(temp).length, { timeout: 15_000 }).toBeGreaterThan(0);
  return join(temp, readdirSync(temp)[0]!);
}

/** The seed once it is whole, or undefined. Main creates the file and then writes it, so an empty file is "not yet". */
function readSeed(dir: string) {
  try { return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")); }
  catch { return undefined; }
}

async function seedOf(dir: string) {
  await expect.poll(() => readSeed(dir) !== undefined, { timeout: 15_000 }).toBe(true);
  return readSeed(dir);
}

describe("a new take's look (STC-626)", () => {
  test("a window take under the default look keeps its wallpaper and is seeded with it", async () => {
    const { win, temp } = await launch();
    const dir = await recordWindow(win, temp);
    const seed = await seedOf(dir);
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(true);
    expect(seed.version).toBe(22);
    expect(seed.framing.background).toEqual(wallpaperFraming());
  }, 90_000);

  test("Window with shadow is seeded white, and reads no wallpaper", async () => {
    const { win, temp } = await launch({ windowShotLook: "window-shadow" });
    const dir = await recordWindow(win, temp);
    const seed = await seedOf(dir);
    expect(seed.framing.background).toEqual({ kind: "solid", color: "#ffffff" });
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(false);
  }, 90_000);

  test("a wallpaper that cannot be read is Clean, and the panel says so", async () => {
    const { win, temp } = await launch({}, { STC_FAKE_WALLPAPER: "fail" });
    const dir = await recordWindow(win, temp);
    const seed = await seedOf(dir);
    expect(seed.framing.background.kind).toBe("linear");
    await pressStop(win);
    const panel = await pageWithUrl(app!, "thumbnail.html");
    await expect.poll(() => panel.textContent("#takereason"), { timeout: 15_000 }).toContain(WALLPAPER_TAKE_NOTICE);
  }, 90_000);

  test("CONTROL: a region take gets no framing at all", async () => {
    const { win, temp } = await launch();
    await startRecordFlow(app!, win);
    await expect.poll(() => recorderState(win), { timeout: 15_000 }).toBe("recording");
    const dir = join(temp, readdirSync(temp)[0]!);
    expect(existsSync(join(dir, "wallpaper.jpg"))).toBe(false);
    if (existsSync(join(dir, "project.json"))) expect((await seedOf(dir)).framing).toBeUndefined();
  }, 90_000);
});
