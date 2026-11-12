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
 * camera takes. No Show camera and no presets here. STC-642 added Reframe: a
 * default framing set against the live camera (the fake helper's
 * STC_FAKE_CAMERA_PREVIEW), which waits for a live picture.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");
const FILE = "settings.json"; // settings.ts's FILE

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function launch(opts: { userData: string; recordings: string; env?: Record<string, string> }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await withoutCountdown(win);
  return win;
}

type StoredFraming = { x: number; y: number; zoom: number };
function readStoredSettings(dir: string): { pipStyle?: { shape?: string; framing?: StoredFraming } } {
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

  test("Settings has no Show camera and no presets", async () => {
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    for (const sel of ["#pipenabled", "[data-pip-preset]"]) {
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

describe("the default PiP framing (STC-642)", () => {
  const LIVE = { STC_FAKE_CAMERA_PREVIEW: "1" };
  const setZoom = (settings: import("playwright").Page, zoom: number) => settings.evaluate((z) => {
    const input = document.getElementById("pipzoom") as HTMLInputElement;
    input.value = String(z);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, zoom);

  test("with no live camera, Reframe and Zoom wait for one, and nothing is stored", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir });
    const settings = await openSettings(app!, win, "camera");
    expect(await settings.isDisabled("#pipreframe")).toBe(true);
    expect(await settings.isDisabled("#pipzoom")).toBe(true);
    expect(await settings.isDisabled("#pipframereset")).toBe(true);
    // The fake helper has no camera: the row says so in STC-638's words.
    await expect.poll(() => settings.textContent("#pipreframe-help"), { timeout: 10_000 }).toBe("No camera available.");
  }, 60_000);

  test("Zoom stores a framing, and Reset stores none", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir, env: LIVE });
    const settings = await openSettings(app!, win, "camera");
    await expect.poll(() => settings.isEnabled("#pipzoom"), { timeout: 10_000 }).toBe(true);
    await setZoom(settings, 2);
    await expect.poll(() => readStoredSettings(userData).pipStyle?.framing?.zoom, { timeout: 10_000 }).toBe(2);
    expect(await settings.textContent("#pipzoom-out")).toBe("2.0×");
    await settings.click("#pipframereset");
    await expect.poll(() => readStoredSettings(userData).pipStyle !== undefined
      && !("framing" in readStoredSettings(userData).pipStyle!), { timeout: 10_000 }).toBe(true);
  }, 60_000);

  test("while reframing, a drag pans the picture and leaves the PiP where it was", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const win = await launch({ userData, recordings: makeTakeFolder().dir, env: LIVE });
    const settings = await openSettings(app!, win, "camera");
    await expect.poll(() => settings.isEnabled("#pipreframe"), { timeout: 10_000 }).toBe(true);
    await setZoom(settings, 2);
    await expect.poll(() => readStoredSettings(userData).pipStyle?.framing?.zoom, { timeout: 10_000 }).toBe(2);

    await settings.click("#pipreframe");
    expect(await settings.textContent("#pipreframe")).toBe("Done");
    const before = (await settings.locator("#pipbox").boundingBox())!;
    // Drag the picture LEFT: the crop moves right, so the framing's x grows.
    await settings.mouse.move(before.x + before.width * 0.75, before.y + before.height / 2);
    await settings.mouse.down();
    await settings.mouse.move(before.x + before.width * 0.25, before.y + before.height / 2, { steps: 6 });
    await settings.mouse.up();
    await expect.poll(() => readStoredSettings(userData).pipStyle?.framing?.x ?? 0.5, { timeout: 10_000 })
      .toBeGreaterThan(0.5);
    const after = (await settings.locator("#pipbox").boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);

    // The guides show only while reframing, and only when they are on.
    expect(await settings.isHidden("#pipguides")).toBe(true);
    await settings.check("#pipguidesswitch");
    expect(await settings.isVisible("#pipguides")).toBe(true);
    await settings.keyboard.press("Escape");
    expect(await settings.textContent("#pipreframe")).toBe("Reframe");
    expect(await settings.isHidden("#pipguides")).toBe(true);
  }, 60_000);
});
