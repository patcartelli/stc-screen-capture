import { describe, test, expect, afterEach } from "vitest";
import type { ElectronApplication, Page } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeTakeFolder, makeMicTakeFolder } from "./_take-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * The editor's narration cleanup (STC-455): one switch and one strength in
 * the timeline's timecode row, beside the system-audio level. What is checked
 * here is the wiring the pure tests cannot see: it appears only for a take
 * that HAS a mic, it writes `narrationCleanup` into project.json (project-10,
 * through main's own version gate), the strength survives the switch going
 * off, and a reopened take shows what was saved. What it SOUNDS like needs a
 * Mac — docs/STC-455-RUNBOOK.md.
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

/** Sets the strength the way a release does: `input` (live) then `change` (persist). */
async function setStrength(win: Page, pct: number): Promise<void> {
  await win.evaluate((v) => {
    const el = document.getElementById("voicecleanstrength") as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, pct);
}

const projectOf = (takeDir: string) => {
  const p = join(takeDir, "project.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};

describe("narration cleanup", () => {
  test("is not shown for a take with no mic", async () => {
    const { dir } = makeTakeFolder();
    const win = await openEditor(dir);
    // Wait for the take to have actually opened before asserting an absence.
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).toMatch(/\d/);
    await expect.poll(() => win.getAttribute("#voiceclean", "hidden"), { timeout: 20_000 }).not.toBeNull();
  }, 120_000);

  test("is shown OFF at 50% for a mic take; switching on and moving the strength is saved", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#voiceclean", "hidden"), { timeout: 20_000 }).toBeNull();
    expect(await win.isChecked("#voicecleanon")).toBe(false);
    expect(await win.inputValue("#voicecleanstrength")).toBe("50");
    expect(await win.isDisabled("#voicecleanstrength")).toBe(true);
    expect(await win.textContent("#voicecleanvalue")).toBe("50%");
    // Nothing touched: nothing written that needs project-10.
    expect(projectOf(takeDir)?.narrationCleanup).toBeUndefined();

    await win.click("#voicecleanon");
    await expect.poll(() => projectOf(takeDir)?.narrationCleanup, { timeout: 20_000 })
      .toEqual({ enabled: true, strength: 0.5 });
    expect(projectOf(takeDir).version).toBe(10);
    expect(await win.isDisabled("#voicecleanstrength")).toBe(false);

    await setStrength(win, 30);
    expect(await win.textContent("#voicecleanvalue")).toBe("30%");
    await expect.poll(() => projectOf(takeDir)?.narrationCleanup, { timeout: 20_000 })
      .toEqual({ enabled: true, strength: 0.3 });

    // Off KEEPS the strength — the switch is not a reset.
    await win.click("#voicecleanon");
    await expect.poll(() => projectOf(takeDir)?.narrationCleanup, { timeout: 20_000 })
      .toEqual({ enabled: false, strength: 0.3 });
    expect(await win.isDisabled("#voicecleanstrength")).toBe(true);
    expect(await win.inputValue("#voicecleanstrength")).toBe("30");

    // Back to the default (off at 50%): the key is dropped and the document
    // returns to the version its other edits earned.
    await win.click("#voicecleanon");
    await setStrength(win, 50);
    await win.click("#voicecleanon");
    await expect.poll(() => projectOf(takeDir)?.narrationCleanup, { timeout: 20_000 }).toBeUndefined();
    expect(projectOf(takeDir).version).toBeLessThan(10);
  }, 120_000);

  test("a reopened take shows the setting it was saved with", async () => {
    const { dir } = makeMicTakeFolder();
    let win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#voiceclean", "hidden"), { timeout: 20_000 }).toBeNull();
    await win.click("#voicecleanon");
    await setStrength(win, 70);
    await expect.poll(() => win.textContent("#voicecleanvalue")).toBe("70%");
    // Let the write land before the app goes away.
    await new Promise((r) => setTimeout(r, 500));
    const a = app; app = undefined; await closeApp(a);

    win = await openEditor(dir);
    await expect.poll(() => win.inputValue("#voicecleanstrength"), { timeout: 20_000 }).toBe("70");
    expect(await win.isChecked("#voicecleanon")).toBe(true);
    expect(await win.isDisabled("#voicecleanstrength")).toBe(false);
  }, 180_000);

  test("keys on the focused controls change the setting, not the playhead", async () => {
    const { dir, takeDir } = makeMicTakeFolder();
    const win = await openEditor(dir);
    await expect.poll(() => win.getAttribute("#voiceclean", "hidden"), { timeout: 20_000 }).toBeNull();
    const clockBefore = await win.textContent("#clock-cur");

    // Space toggles the switch and must not also start playback.
    await win.focus("#voicecleanon");
    await win.keyboard.press(" ");
    await expect.poll(() => win.isChecked("#voicecleanon")).toBe(true);
    await expect.poll(() => projectOf(takeDir)?.narrationCleanup?.enabled, { timeout: 20_000 }).toBe(true);

    await win.focus("#voicecleanstrength");
    await win.keyboard.press("ArrowRight");
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => win.inputValue("#voicecleanstrength")).toBe("52");

    // Long enough that playback, had Space started it, would have moved the clock.
    await new Promise((r) => setTimeout(r, 600));
    expect(await win.textContent("#clock-cur")).toBe(clockBefore);
  }, 120_000);
});
