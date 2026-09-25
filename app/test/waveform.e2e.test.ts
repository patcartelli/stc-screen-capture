import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The ruler's audio waveform (STC-454 part 4), wired. What it LOOKS like over
 * real narration needs a Mac (docs/STC-454-RUNBOOK.md §7): the fixtures'
 * placeholder AAC decodes to silence and this sandbox has no AAC encoder,
 * so every waveform here is flat. The arithmetic (the peaks ARE the export's
 * mix) is pinned in Node by transform/test/waveform.test.ts against
 * `mixBlock` itself. What is checked here is what that test cannot see: the
 * toggle only for a take with audio, off by default, the peaks computed once
 * the audio decodes, recomputed when a mute changes what would be exported,
 * and Space on the focused toggle flipping it rather than starting playback.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir);
  app = launched.app;
  const editorWin = await openEditorFromLibrary(app, launched.win);
  await editorWin.waitForSelector("#stage", { timeout: 20_000 });
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/\d/);
  return editorWin;
}

const shown = (win: Page) => win.evaluate(() => document.getElementById("ruler")!.hasAttribute("data-waveform"));
const state = (win: Page) => win.getAttribute("#ruler-waveform", "data-state");
const run = (win: Page) => win.getAttribute("#ruler-waveform", "data-run");

describe("the ruler's waveform", () => {
  test("no audio, no toggle", async () => {
    const win = await openEditor(makeTakeFolder().dir);
    expect(await win.getAttribute("#rulerwaveformtoggle", "hidden")).not.toBeNull();
    expect(await win.isVisible("#rulerwaveformtoggle")).toBe(false);
  }, 120_000);

  test("a mic take: the toggle shows, starts off, and the peaks are computed once the audio decodes", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.isVisible("#rulerwaveformtoggle"), { timeout: 20_000 }).toBe(true);
    expect(await win.getAttribute("#rulerwaveformtoggle", "aria-pressed")).toBe("false");
    expect(await shown(win)).toBe(false);
    await expect.poll(() => state(win), { timeout: 20_000 }).toBe("ready");

    await win.click("#rulerwaveformtoggle");
    expect(await win.getAttribute("#rulerwaveformtoggle", "aria-pressed")).toBe("true");
    expect(await shown(win)).toBe(true);
    // Shown means visible: the wrap's opacity is what the attribute drives.
    await expect.poll(() => win.evaluate(() =>
      Number(getComputedStyle(document.getElementById("ruler-waveform-wrap")!).opacity))).toBeGreaterThan(0);

    await win.click("#rulerwaveformtoggle");
    expect(await shown(win)).toBe(false);
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

  test("Space on the focused toggle flips it and does not start playback", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.isVisible("#rulerwaveformtoggle"), { timeout: 20_000 }).toBe(true);
    const clockBefore = await win.textContent("#clock-cur");
    await win.focus("#rulerwaveformtoggle");
    await win.keyboard.press(" ");
    await expect.poll(() => shown(win)).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(await win.textContent("#clock-cur")).toBe(clockBefore);
  }, 120_000);
});
