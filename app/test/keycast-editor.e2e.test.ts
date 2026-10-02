import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-419: the editor's Keys switch. Hidden for a take with no keys; for one
 * with keys it toggles project.keycast.show, saves it, and never touches
 * events.json.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

describe("the editor's Keys switch (STC-419)", () => {
  test("hidden for a take with no keys", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.isHidden("#keycastbtn")).toBe(true);
  }, 120_000);

  test("for a take with keys: shown, and a click hides it and saves show:false", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ source: "fixtures/keycast" });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.getAttribute("#keycastbtn", "aria-pressed")).toBe("true");
    await editorWin.click("#keycastbtn");
    expect(await editorWin.getAttribute("#keycastbtn", "aria-pressed")).toBe("false");
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).keycast; } catch { return undefined; }
    }, { timeout: 10_000 }).toEqual({ show: false });
  }, 120_000);
});
