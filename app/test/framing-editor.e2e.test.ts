import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness, openExportDialog } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-396: the export dialog's Frame control. Asserts: #framepreset exists and
 * defaults to "none"; choosing "clean" writes project.json with
 * framing {preset:"clean"} at version 15 and the legibility line gains "inside
 * the frame"; choosing "solid" reveals #framecolor; choosing "none" removes
 * framing from project.json again.
 *
 * Written, typechecked, NOT run in the session that authored it (Electron e2e
 * is disruptive on that machine) — run it in the VM or by hand.
 */
let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const readProject = (takeDir: string): any => {
  try { return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")); } catch { return undefined; }
};

describe("the export dialog's Frame control (STC-396)", () => {
  test("defaults to none, frames on choice, reveals the colour for solid, and clears again", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    await openExportDialog(editorWin);

    expect(await editorWin.inputValue("#framepreset")).toBe("none");
    expect(await editorWin.textContent("#legibility")).not.toMatch(/inside the frame/);

    await editorWin.selectOption("#framepreset", "clean");
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 }).toEqual({ preset: "clean" });
    expect(readProject(takeDir).version).toBe(15);
    await expect.poll(() => editorWin.textContent("#legibility"), { timeout: 10_000 }).toMatch(/inside the frame/);
    expect(await editorWin.isHidden("#framecolor")).toBe(true);

    await editorWin.selectOption("#framepreset", "solid");
    await expect.poll(() => readProject(takeDir)?.framing?.preset, { timeout: 10_000 }).toBe("solid");
    expect(await editorWin.isVisible("#framecolor")).toBe(true);

    await editorWin.selectOption("#framepreset", "none");
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 }).toBeUndefined();
    expect(await editorWin.isHidden("#framecolor")).toBe(true);
  }, 120_000);
});
