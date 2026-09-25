import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder, makeSystemAudioTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { MIC_LEVEL_MAX, micLevelFromSliderPct, formatLevelDb } from "../../transform/src/audio-mix.js";

/**
 * The Audio popover and the mic level (STC-454 part 2), wired. What a boost
 * SOUNDS like — whether +12 dB clips on a loud take — needs a Mac:
 * docs/STC-454-RUNBOOK.md. What is checked here is what the pure tests
 * cannot see: the button only for a take with audio, each row only for the
 * track it acts on, the popover opening and closing, `micLevel` written to
 * project.json at project-11 through main's own version gate, and a reopened
 * take showing what was saved.
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

const panelOpen = (win: Page) => win.evaluate(() => document.getElementById("audiopanel")!.matches(":popover-open"));

async function setMic(win: Page, pct: number): Promise<void> {
  await win.evaluate((v) => {
    const el = document.getElementById("miclevel") as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, pct);
}

const projectOf = (takeDir: string) => {
  const p = join(takeDir, "project.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

describe("the Audio popover", () => {
  test("no audio, no Audio button", async () => {
    const win = await openEditor(makeTakeFolder().dir);
    expect(await win.getAttribute("#audiobtn", "hidden")).not.toBeNull();
  }, 120_000);

  test("a mic take: the button opens the panel with Mic and Clean up voice, not System audio; Escape closes it", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.getAttribute("#audiobtn", "hidden"), { timeout: 20_000 }).toBeNull();
    expect(await panelOpen(win)).toBe(false);
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    expect(await win.isVisible("#miclevel")).toBe(true);
    expect(await win.isVisible("#voicecleanon")).toBe(true);
    expect(await win.getAttribute("#sysaudio", "hidden")).not.toBeNull();
    await win.keyboard.press("Escape");
    await expect.poll(() => panelOpen(win)).toBe(false);
  }, 120_000);

  test("a system-audio take with no mic: System audio only", async () => {
    const win = await openEditor(makeSystemAudioTakeFolder().dir);
    await expect.poll(() => win.getAttribute("#audiobtn", "hidden"), { timeout: 20_000 }).toBeNull();
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    expect(await win.isVisible("#sysaudiolevel")).toBe(true);
    expect(await win.getAttribute("#micaudio", "hidden")).not.toBeNull();
    expect(await win.getAttribute("#voiceclean", "hidden")).not.toBeNull();
  }, 120_000);
});

describe("the mic level", () => {
  test("opens as recorded; a boost is saved at project-11; back to as-recorded drops the key", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    expect(await win.inputValue("#miclevel")).toBe("75");
    expect(await win.textContent("#miclevelvalue")).toBe("0 dB");

    await setMic(win, 100);
    expect(await win.textContent("#miclevelvalue")).toBe("+12 dB");
    await expect.poll(() => projectOf(takeDir)?.micLevel, { timeout: 20_000 }).toBeCloseTo(MIC_LEVEL_MAX, 6);
    expect(projectOf(takeDir).version).toBe(11);

    await setMic(win, 30);
    expect(await win.textContent("#miclevelvalue")).toBe(formatLevelDb(micLevelFromSliderPct(30)));
    await expect.poll(() => projectOf(takeDir)?.micLevel, { timeout: 20_000 }).toBeCloseTo(micLevelFromSliderPct(30), 9);

    await setMic(win, 75);
    await expect.poll(() => projectOf(takeDir)?.micLevel, { timeout: 20_000 }).toBeUndefined();
    expect(projectOf(takeDir).version).toBeLessThan(11);
  }, 120_000);

  test("a reopened take shows the level it was saved with", async () => {
    const { dir } = makeMicTakeFolder();
    let win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await setMic(win, 90);
    await expect.poll(() => win.textContent("#miclevelvalue")).toBe(formatLevelDb(micLevelFromSliderPct(90)));
    await new Promise((r) => setTimeout(r, 500));
    const a = app; app = undefined; await closeApp(a);

    win = await openEditor(dir);
    await expect.poll(() => win.inputValue("#miclevel"), { timeout: 20_000 }).toBe("90");
  }, 180_000);

  test("arrow keys on the focused mic slider change the level, not the playhead", async () => {
    const win = await openEditor(makeMicTakeFolder().dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    const clockBefore = await win.textContent("#clock-cur");
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.focus("#miclevel");
    await win.keyboard.press("ArrowRight");
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => win.inputValue("#miclevel")).toBe("77");
    expect(await win.textContent("#clock-cur")).toBe(clockBefore);
  }, 120_000);
});
