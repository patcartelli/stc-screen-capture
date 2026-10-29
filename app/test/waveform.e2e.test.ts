import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openEditorFromLibrary, waitForTakeLoaded } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The editor's audio lane (STC-454 part 4, moved off the ruler by STC-483),
 * wired. What it LOOKS like over real narration needs a Mac (docs/STC-454-
 * RUNBOOK.md §7): the fixtures' placeholder AAC decodes to silence and this
 * sandbox has no AAC encoder, so every waveform here is flat. The arithmetic
 * (the peaks ARE the export's mix; what counts as clipped) is pinned in Node by
 * transform/test/waveform.test.ts. What is checked here is what that test
 * cannot see: the lane only for a take with audio, the peaks computed once the
 * audio decodes, recomputed when a mute changes what would be exported, and
 * the lane resizable by its bottom edge within its bounds.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir);
  app = launched.app;
  const editorWin = await openEditorFromLibrary(app, launched.win);
  await editorWin.waitForSelector("#stage", { timeout: 20_000 });
  await waitForTakeLoaded(editorWin);
  return editorWin;
}

const state = (win: Page) => win.getAttribute("#audio-waveform", "data-state");
const run = (win: Page) => win.getAttribute("#audio-waveform", "data-run");
const laneHeight = (win: Page) =>
  win.evaluate(() => document.getElementById("audio-lane")!.getBoundingClientRect().height);

describe("the audio lane", () => {
  test("no audio, no lane", async () => {
    const win = await openEditor(makeTakeFolder().dir);
    expect(await win.isVisible("#audio-lane")).toBe(false);
  }, 120_000);

  test("a mic take: the lane shows and the peaks are computed once the audio decodes", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.isVisible("#audio-lane"), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => state(win), { timeout: 20_000 }).toBe("ready");
    // The ruler is time only: no lane draws onto it. Since STC-605 Clip
    // activity is back on its own lane.
    expect(await win.locator("#ruler canvas").count()).toBe(0);
    expect(await win.locator(".laneviewport.clip #clip-activity").count()).toBe(1);
  }, 120_000);

  test("muting the mic recomputes the peaks from what the export would now contain", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => state(win), { timeout: 20_000 }).toBe("ready");
    const before = Number(await run(win));
    await win.click("#audiobtn");
    await win.click("#micmute");
    await expect.poll(async () => Number(await run(win)), { timeout: 20_000 }).toBeGreaterThan(before);
    expect(await state(win)).toBe("ready");
  }, 120_000);

  test("dragging the bottom edge resizes the lane, held between its minimum and maximum", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.isVisible("#audio-lane"), { timeout: 20_000 }).toBe(true);
    const before = await laneHeight(win);
    // The grip can sit below the fold of a small window; the mouse needs it on screen.
    await win.locator("#audio-resize").scrollIntoViewIfNeeded();
    const grip = (await win.locator("#audio-resize").boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await win.mouse.move(x, y);
    await win.mouse.down();
    await win.mouse.move(x, y + 40, { steps: 5 });
    await win.mouse.up();
    expect(await laneHeight(win)).toBeGreaterThan(before + 20);
    // Far past the maximum and far past the minimum: clamped, never lost.
    await win.focus("#audio-resize");
    for (let i = 0; i < 40; i++) await win.keyboard.press("ArrowDown");
    expect(await laneHeight(win)).toBe(160);
    for (let i = 0; i < 40; i++) await win.keyboard.press("ArrowUp");
    expect(await laneHeight(win)).toBe(32);
  }, 120_000);
});
