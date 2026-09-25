import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeTakeFolder, makeSystemAudioTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { levelFromSliderPct, formatLevelDb } from "../../transform/src/audio-mix.js";

/**
 * The editor's system-audio level (STC-418 PR 3): a compact slider in the
 * timeline's timecode row, NOT a lane (the 2026-09-24 hardware pass found
 * three stacked lanes cluttered). What is checked here is the wiring the pure
 * tests cannot see: it appears only for a take that HAS system audio, it
 * writes `systemAudioLevel` into project.json (project-9, through main's
 * own version gate), and a reopened take shows what was saved. What it
 * sounds like in an export needs a Mac — docs/STC-418-RUNBOOK.md.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(dir: string): Promise<Page> {
  const launched = await launchApp(dir);
  app = launched.app;
  const editorWin = await openEditorFromLibrary(app, launched.win);
  await editorWin.waitForSelector("#stage", { timeout: 20_000 });
  return editorWin;
}

/** Sets the range the way a release does: `input` (live) then `change` (persist). */
async function setLevel(win: Page, pct: number): Promise<void> {
  await win.evaluate((v) => {
    const el = document.getElementById("sysaudiolevel") as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, pct);
}

/** The controls live in the Audio popover (STC-454 part 2): open it before clicking or focusing one. */
async function openAudio(win: Page): Promise<void> {
  const open = () => win.evaluate(() => document.getElementById("audiopanel")!.matches(":popover-open"));
  if (await open()) return;
  await win.click("#audiobtn");
  await expect.poll(open).toBe(true);
}

const projectOf = (takeDir: string) => {
  const p = join(takeDir, "project.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

describe("the system-audio level", () => {
  test("is not shown for a take with no system audio", async () => {
    const { dir } = makeTakeFolder();
    const win = await openEditor(dir);
    // Wait for the take to have actually opened before asserting an absence,
    // or "hidden" would pass on a page that had not loaded anything yet.
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).toMatch(/\d/);
    await expect.poll(() => win.getAttribute("#sysaudio", "hidden"), { timeout: 20_000 }).not.toBeNull();
  }, 120_000);

  test("is shown at 100% for a take with system audio, and a change is saved to the project", async () => {
    const { dir, takeDir } = makeSystemAudioTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#sysaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    expect(await win.inputValue("#sysaudiolevel")).toBe("100");
    // The Audio panel speaks dB (STC-454 part 2): full level is "0 dB".
    expect(await win.textContent("#sysaudiovalue")).toBe("0 dB");

    await setLevel(win, 40);
    expect(await win.textContent("#sysaudiovalue")).toBe(formatLevelDb(levelFromSliderPct(40)));
    // The slider is a decibel fader: 40% saves -24 dB of gain, not a linear 0.4.
    await expect.poll(() => projectOf(takeDir)?.systemAudioLevel, { timeout: 20_000 })
      .toBe(levelFromSliderPct(40));
    expect(projectOf(takeDir).systemAudioLevel).toBeLessThan(0.1);
    expect(projectOf(takeDir).version).toBe(9);

    // Back to full level: the key is dropped and the document returns to the
    // version its other edits earned (projectForWrite's minimum-version rule).
    await setLevel(win, 100);
    await expect.poll(() => projectOf(takeDir)?.systemAudioLevel, { timeout: 20_000 }).toBeUndefined();
    expect(projectOf(takeDir).version).toBeLessThan(9);
  }, 120_000);

  test("a reopened take shows the level it was saved with", async () => {
    const { dir } = makeSystemAudioTakeFolder();
    let win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#sysaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await setLevel(win, 25);
    await expect.poll(() => win.textContent("#sysaudiovalue")).toBe(formatLevelDb(levelFromSliderPct(25)));
    // Let the write land before the app goes away.
    await new Promise((r) => setTimeout(r, 500));
    const a = app; app = undefined; await closeApp(a);

    win = await openEditor(dir);
    await expect.poll(() => win.inputValue("#sysaudiolevel"), { timeout: 20_000 }).toBe("25");
    expect(await win.textContent("#sysaudiovalue")).toBe(formatLevelDb(levelFromSliderPct(25)));
  }, 180_000);

  test("arrow keys on the focused slider change the level, not the playhead", async () => {
    const { dir } = makeSystemAudioTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#sysaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    const clockBefore = await win.textContent("#clock-cur");
    await openAudio(win);
    await win.focus("#sysaudiolevel");
    await win.keyboard.press("ArrowLeft");
    await win.keyboard.press("ArrowLeft");
    await expect.poll(() => win.inputValue("#sysaudiolevel")).toBe("98");
    expect(await win.textContent("#clock-cur")).toBe(clockBefore);
  }, 120_000);
});
