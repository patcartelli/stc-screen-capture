import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * STC-396: the Frame section's Style control. Asserts: #framepreset exists and
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

describe("the Frame section's Style control (STC-396)", () => {
  test("defaults to none, frames on choice, reveals the colour for solid, and clears again", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    expect(await editorWin.getAttribute("#framepreset [aria-checked=\"true\"]", "data-frame-preset")).toBe("none");
    expect(await editorWin.textContent("#legibility")).not.toMatch(/inside the frame/);

    await editorWin.click(`#framepreset [data-frame-preset="clean"]`);
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 }).toEqual({ preset: "clean" });
    expect(readProject(takeDir).version).toBe(15);
    await expect.poll(() => editorWin.textContent("#legibility"), { timeout: 10_000 }).toMatch(/inside the frame/);
    expect(await editorWin.isHidden("#framecolor")).toBe(true);

    await editorWin.click(`#framepreset [data-frame-preset="solid"]`);
    await expect.poll(() => readProject(takeDir)?.framing?.preset, { timeout: 10_000 }).toBe("solid");
    // STC-514: setFraming writes project.json BEFORE updateFramingUI() shows or
    // hides #framecolor, so the disk poll above can return while the DOM is
    // still one step behind. Poll the DOM itself; a one-shot read races it.
    await expect.poll(() => editorWin.isVisible("#framecolor"), { timeout: 10_000 }).toBe(true);

    await editorWin.click(`#framepreset [data-frame-preset="none"]`);
    await expect.poll(() => readProject(takeDir)?.framing, { timeout: 10_000 }).toBeUndefined();
    await expect.poll(() => editorWin.isHidden("#framecolor"), { timeout: 10_000 }).toBe(true);
  }, 120_000);

  test("padding, corners and shadow wait for a frame, then write the explicit fields over the preset's (STC-604)", async () => {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    for (const id of ["#framepadding", "#frameradius", "#frameshadow"]) expect(await editorWin.isDisabled(id)).toBe(true);

    await editorWin.click(`#framepreset [data-frame-preset="clean"]`);
    await expect.poll(() => editorWin.isEnabled("#framepadding"), { timeout: 10_000 }).toBe(true);
    const setRange = (id: string, v: number) => editorWin.evaluate(([i, val]) => {
      const el = document.getElementById(i as string) as HTMLInputElement;
      el.value = String(val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, [id, v]);
    await setRange("framepadding", 10);
    await expect.poll(() => readProject(takeDir)?.framing?.paddingPct, { timeout: 10_000 }).toBeCloseTo(0.1, 5);
    expect(await editorWin.textContent("#framepadding-out")).toBe("10%");
    await setRange("frameradius", 3);
    await expect.poll(() => readProject(takeDir)?.framing?.radiusPct, { timeout: 10_000 }).toBeCloseTo(0.03, 5);

    await editorWin.uncheck("#frameshadow");
    await expect.poll(() => readProject(takeDir)?.framing?.shadow?.opacity, { timeout: 10_000 }).toBe(0);
    await editorWin.check("#frameshadow");
    await expect.poll(() => readProject(takeDir)?.framing?.shadow, { timeout: 10_000 }).toBeUndefined();
    // The numbers are the user's; a preset change keeps them.
    await editorWin.click(`#framepreset [data-frame-preset="dark"]`);
    await expect.poll(() => readProject(takeDir)?.framing?.preset, { timeout: 10_000 }).toBe("dark");
    expect(readProject(takeDir).framing.paddingPct).toBeCloseTo(0.1, 5);
  }, 120_000);
});
