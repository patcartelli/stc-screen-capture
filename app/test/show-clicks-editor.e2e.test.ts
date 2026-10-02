import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-492: the editor's Clicks switch toggles project.showClicks both ways
 * and saves it.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("the editor's Clicks switch (STC-492)", () => {
  test("on by default; a click turns it off and saves showClicks:false, another turns it back on", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const saved = () => {
      try { return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).showClicks; } catch { return undefined; }
    };
    expect(await editorWin.getAttribute("#clicksbtn", "aria-pressed")).toBe("true");
    await editorWin.click("#clicksbtn");
    expect(await editorWin.getAttribute("#clicksbtn", "aria-pressed")).toBe("false");
    await expect.poll(saved, { timeout: 10_000 }).toBe(false);
    await editorWin.click("#clicksbtn");
    expect(await editorWin.getAttribute("#clicksbtn", "aria-pressed")).toBe("true");
    await expect.poll(saved, { timeout: 10_000 }).not.toBe(false);
  }, 120_000);
});
