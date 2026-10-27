import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { withoutCountdown } from "./_countdown-fixture.js";
import { openSettings } from "./_settings-window.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The Settings sheet's Camera subsection (STC-461): the shared PiP inspector
 * over a mock 16:9 frame, saving Settings.pipStyle as the default for new
 * camera takes. No Reframe and no Show camera here — framing is per take.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const FILE = "settings.json"; // settings.ts's FILE

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: { userData: string; recordings: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}

function readStoredSettings(dir: string): { pipStyle?: { shape?: string } } {
  return JSON.parse(readFileSync(join(dir, FILE), "utf8"));
}

describe("the Settings window's Camera pane (STC-581)", () => {
  test("Circle in Shape becomes the stored default, and the preview follows", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    await settings.click('#pipshape [data-pip-shape="circle"]');
    await expect.poll(() => readStoredSettings(userData).pipStyle?.shape, { timeout: 10_000 }).toBe("circle");
    await expect.poll(() => settings.evaluate(() => document.getElementById("pipbox")!.style.borderRadius)).toBe("50%");
    // A circle has no corners to round.
    expect(await settings.isDisabled("#pipradius")).toBe(true);
  });

  test("a switch writes its field, and the preview shows it", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    await settings.check("#pipmirror");
    await expect.poll(() => (readStoredSettings(userData).pipStyle as { mirror?: boolean } | undefined)?.mirror,
      { timeout: 10_000 }).toBe(true);
    expect(await settings.evaluate(() =>
      (document.querySelector("#pipbox .silhouette") as HTMLElement).style.transform)).toBe("scaleX(-1)");
  });

  test("Settings has no Reframe, no Show camera and no presets", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    for (const sel of ["#pipreframe", "#pipenabled", "[data-pip-preset]"]) {
      expect(await settings.locator(sel).count(), sel).toBe(0);
    }
    expect(await settings.locator("#pipstage #pipbox").count()).toBe(1);
  });

  // The preview is a 1080p screen, so where the PiP is dropped on it is where
  // it is stored. It once had the stage's own ~3.8:1 shape, and a PiP snapped
  // to its bottom landed well above the bottom of a real 16:9 take.
  test("a PiP dropped on the 16:9 preview is stored where it was drawn", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    const screen = (await settings.locator("#pipscreen").boundingBox())!;
    expect(screen.width / screen.height).toBeCloseTo(16 / 9, 1);

    const box = (await settings.locator("#pipbox").boundingBox())!;
    await settings.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await settings.mouse.down();
    await settings.mouse.move(screen.x + screen.width * 0.3, screen.y + screen.height * 0.4, { steps: 8 });
    await settings.mouse.up();

    await expect.poll(() =>
      (readStoredSettings(userData).pipStyle as { center?: { x: number; y: number } } | undefined)?.center?.x,
      { timeout: 10_000 }).toBeLessThan(0.5);
    const center = (readStoredSettings(userData).pipStyle as { center: { x: number; y: number } }).center;
    const drawn = (await settings.locator("#pipbox").boundingBox())!;
    expect(center.x).toBeCloseTo((drawn.x + drawn.width / 2 - screen.x) / screen.width, 2);
    expect(center.y).toBeCloseTo((drawn.y + drawn.height / 2 - screen.y) / screen.height, 2);
  });
});
