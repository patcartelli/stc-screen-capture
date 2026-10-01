import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeMicAndSystemTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-469: the export reuses the tracks the preview already decoded. Reuse is
 * only allowed when the track is what the export would have made itself
 * (audio-mix.ts `reusableTracks`, decode-audio.ts `decodeMicForMix`), so the
 * MIXED SAMPLES must be identical with and without it — checked here by the
 * export's own audio hash. What carries the weight is NOT the hash alone (the
 * placeholder AAC decodes to near-silence, so it could agree vacuously):
 * (1) `audioReused` proves reuse really happened, (2) the raw-vs-cleaned
 * CONTROL below proves the hash can tell the two tracks apart on this fixture,
 * and (3) `decodeMicForMix` is the single producer of the mic track, with
 * `reusableTracks` unit-tested in audio-mix.test.ts.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir, {});
  app = launched.app;
  const win = await openEditorFromLibrary(app, launched.win);
  await win.waitForSelector("#stage", { timeout: 20_000 });
  await expect.poll(() => win.getAttribute("#previewaudio", "data-state"), { timeout: 30_000 }).toBe("ready");
  return win;
}

const settled = (win: Page) => win.evaluate(() => (window as any).__stcPreviewAudio().cleaning === false);
const exportWith = (win: Page, reuse: boolean) =>
  win.evaluate((reuse) => (window as any).__stcExportForTest({ reuse }), reuse);

describe("export reuses the preview's decoded audio", () => {
  test("cleanup on: same mixed samples, mic and system both reused", async () => {
    const { dir } = makeMicAndSystemTakeFolder();
    const win = await openEditor(dir);
    await win.click("#audiobtn");
    await win.locator("#voicecleanon").check();
    await win.keyboard.press("Escape");
    await expect.poll(() => win.evaluate(() => (window as any).__stcPreviewAudio().playing), { timeout: 30_000 }).toBe("cleaned");
    await expect.poll(() => settled(win), { timeout: 30_000 }).toBe(true);

    const reused = await exportWith(win, true);
    const fresh = await exportWith(win, false);
    expect(reused.audioReused).toEqual({ mic: true, system: true });
    expect(fresh.audioReused).toEqual({ mic: false, system: false });
    expect(reused.audioHash).not.toBe("");
    expect(reused.audioHash).toBe(fresh.audioHash);

    // CONTROL: the hash can tell raw from cleaned on this fixture. If this
    // ever fails, the fixture is too silent for the identity check above to
    // mean anything, and sample identity rests on audio-mix.test.ts's
    // reusableTracks tests plus decodeMicForMix being the single producer.
    await win.click("#audiobtn");
    await win.locator("#voicecleanon").uncheck();
    await win.keyboard.press("Escape");
    await expect.poll(() => win.evaluate(() => (window as any).__stcPreviewAudio().playing), { timeout: 30_000 }).toBe("raw");
    const raw = await exportWith(win, false);
    expect(raw.audioHash).not.toBe(fresh.audioHash);
  }, 180_000);

  test("cleanup off: the raw mic is reused, same mixed samples", async () => {
    const { dir } = makeMicAndSystemTakeFolder();
    const win = await openEditor(dir);
    const reused = await exportWith(win, true);
    const fresh = await exportWith(win, false);
    expect(reused.audioReused).toEqual({ mic: true, system: true });
    expect(fresh.audioReused).toEqual({ mic: false, system: false });
    expect(reused.audioHash).toBe(fresh.audioHash);
  }, 180_000);
});
