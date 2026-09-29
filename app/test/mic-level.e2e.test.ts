import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, openEditorFromLibrary, openExportDialog } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder, makeSystemAudioTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";
import { MIC_LEVEL_MAX, micLevelFromSliderPct, formatLevelDb } from "../../transform/src/audio-mix.js";
import { exportMediaName } from "../src/share.js";

/**
 * The Audio popover and the mic level (STC-454 part 2), wired. What a boost
 * SOUNDS like — whether +12 dB clips on a loud take — needs a Mac:
 * docs/STC-454-RUNBOOK.md. What is checked here is what the pure tests
 * cannot see: the button only for a take with audio, each row only for the
 * track it acts on, the popover opening and closing, `micLevel` written to
 * project.json at project-11 through main's own version gate, and a reopened
 * take showing what was saved. Part 3 adds the per-track mute: its own
 * project-12 field that keeps the level, and an export with every track
 * muted that has no audio track at all.
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

describe("per-track mute (STC-454 part 3)", () => {
  const pressed = (win: Page, id: string) => win.getAttribute(`#${id}`, "aria-pressed");

  test("muting the mic keeps its level: saved at project-12, slider unmoved; unmuting drops the key", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await setMic(win, 90);
    await expect.poll(() => projectOf(takeDir)?.micLevel, { timeout: 20_000 }).toBeCloseTo(micLevelFromSliderPct(90), 9);
    expect(await pressed(win, "micmute")).toBe("false");

    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.click("#micmute");
    expect(await pressed(win, "micmute")).toBe("true");
    expect(await win.getAttribute("#micmute", "aria-label")).toBe("Unmute mic");
    expect(await win.getAttribute("#micaudio", "data-muted")).not.toBeNull();
    expect(await win.inputValue("#miclevel")).toBe("90");
    await expect.poll(() => projectOf(takeDir)?.micMuted, { timeout: 20_000 }).toBe(true);
    expect(projectOf(takeDir).version).toBe(12);
    expect(projectOf(takeDir).micLevel).toBeCloseTo(micLevelFromSliderPct(90), 9);
    // The popover stays open for a second toggle.
    expect(await panelOpen(win)).toBe(true);

    await win.click("#micmute");
    expect(await pressed(win, "micmute")).toBe("false");
    expect(await win.getAttribute("#micaudio", "data-muted")).toBeNull();
    await expect.poll(() => projectOf(takeDir)?.micMuted, { timeout: 20_000 }).toBeUndefined();
    expect(projectOf(takeDir).version).toBe(11);
    expect(await win.inputValue("#miclevel")).toBe("90");
  }, 120_000);

  test("system audio has its own mute, saved as systemAudioMuted", async () => {
    const { dir, takeDir } = makeSystemAudioTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#sysaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.click("#sysmute");
    expect(await pressed(win, "sysmute")).toBe("true");
    await expect.poll(() => projectOf(takeDir)?.systemAudioMuted, { timeout: 20_000 }).toBe(true);
    expect(projectOf(takeDir).micMuted).toBe(false);
  }, 120_000);

  test("a reopened take shows the mute it was saved with", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    let win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.click("#micmute");
    await expect.poll(() => projectOf(takeDir)?.micMuted, { timeout: 20_000 }).toBe(true);
    const a = app; app = undefined; await closeApp(a);

    win = await openEditor(dir);
    await expect.poll(() => pressed(win, "micmute"), { timeout: 20_000 }).toBe("true");
    expect(await win.getAttribute("#micaudio", "data-muted")).not.toBeNull();
  }, 180_000);

  test("Space on the focused mute toggles it and does not start playback", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    const clockBefore = await win.textContent("#clock-cur");
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.focus("#micmute");
    await win.keyboard.press(" ");
    await expect.poll(() => pressed(win, "micmute")).toBe("true");
    await expect.poll(() => projectOf(takeDir)?.micMuted, { timeout: 20_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    expect(await win.textContent("#clock-cur")).toBe(clockBefore);
  }, 120_000);

  test("every track muted: the export has NO audio track (Patrick, 2026-09-25)", async () => {
    // The placeholder mic cannot be exported (its samples are not audio), so
    // this also shows the muted track is never DECODED: were it, the export
    // would fail or carry an mp4a track.
    const { dir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#micaudio", "hidden"), { timeout: 20_000 }).toBeNull();
    await win.click("#audiobtn");
    await expect.poll(() => panelOpen(win)).toBe(true);
    await win.click("#micmute");
    await expect.poll(() => pressed(win, "micmute")).toBe("true");
    await win.keyboard.press("Escape");
    await expect.poll(() => panelOpen(win)).toBe(false);

    await openExportDialog(win);
    await win.click("#export");
    await expect.poll(async () => {
      const t = (await win.textContent("#exportstatus")) ?? "";
      return /^Done —/.test(t) || t === "Failed." || t === "Cancelled.";
    }, { timeout: 600_000 }).toBe(true);
    const alert = (await win.locator("#alert").isVisible()) ? await win.textContent("#alert") : "";
    expect(await win.textContent("#exportstatus"), `export did not finish: ${alert}`).toMatch(/^Done —/);

    const mp4 = readFileSync(join(dir, exportMediaName("2026-09-25_11-00-00-mic")));
    expect(mp4.includes("avc1"), "the video track is there").toBe(true);
    expect(mp4.includes("mp4a"), "no AAC sample entry").toBe(false);
    expect(mp4.includes("soun"), "no sound handler").toBe(false);
  }, 900_000);
});
