import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, openExportDialog, inkiness } from "./_editor-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launchWithTake() {
  const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
  return { win: editorWin, takeDir };
}

/**
 * Waits for the export to REACH A CONCLUSION — done, failed or cancelled — and
 * returns the status plus any alert text. Polling only for success meant a
 * failure burned the full 10-minute timeout and then reported nothing about
 * the cause; the reason was sitting in the alert the whole time.
 */
async function settledStatus(win: Page): Promise<{ text: string; alert: string }> {
  await expect.poll(async () => {
    const t = (await win.textContent("#exportstatus")) ?? "";
    return /^Done —/.test(t) || t === "Failed." || t === "Cancelled.";
  }, { timeout: 600_000 }).toBe(true);
  return {
    text: (await win.textContent("#exportstatus")) ?? "",
    alert: (await win.locator("#alert").isVisible())
      ? ((await win.textContent("#alert")) ?? "(no alert)")
      : "(no alert shown)",
  };
}

describe("export from the app, through the editor's export dialog (STC-373)", () => {
  test("exports a playable file and a manifest, with progress", async () => {
    const { win, takeDir } = await launchWithTake();
    await openExportDialog(win);
    await win.click("#export");
    const status = await settledStatus(win);
    expect(status.text, `export did not finish: ${status.alert}`).toMatch(/^Done —/);

    const mp4 = join(takeDir, "export-2026-08-24_10-00-00.mp4");
    const manifest = join(takeDir, "export-2026-08-24_10-00-00.json");
    expect(existsSync(mp4), "exported mp4 missing").toBe(true);
    expect(existsSync(manifest), "manifest missing").toBe(true);
    expect(statSync(mp4).size).toBeGreaterThan(100_000);

    const m = JSON.parse(readFileSync(manifest, "utf8"));
    expect(m.frames).toBeGreaterThan(0);
    expect(m.preEncodeHash).toMatch(/^[0-9a-f]{64}$/);
  }, 900_000);

  test("export honours the trim window", async () => {
    const { win, takeDir } = await launchWithTake();
    // The trim controls are the transport bar's, outside the (modal) export
    // dialog — set them first.
    await win.fill("#scrub", "0");
    await win.dispatchEvent("#scrub", "input");
    await win.click("#markin");
    await win.fill("#scrub", "24");
    await win.dispatchEvent("#scrub", "input");
    await win.click("#markout");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);

    await openExportDialog(win);
    await win.click("#export");
    const status = await settledStatus(win);
    expect(status.text, `export did not finish: ${status.alert}`).toMatch(/^Done —/);

    const m = JSON.parse(readFileSync(join(takeDir, "export-2026-08-24_10-00-00.json"), "utf8"));
    expect(m.trim).toBeTruthy();
    expect(m.trim.endNs).toBeGreaterThan(m.trim.startNs);
    // Full fixture export is ~300 frames; 8% of ~5 s is a few dozen.
    expect(m.frames).toBeGreaterThan(0);
    expect(m.frames).toBeLessThan(80);
  }, 300_000);

  test("cancel stops the export instead of running to completion", async () => {
    const { win } = await launchWithTake();
    await openExportDialog(win);
    await win.click("#export");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 60_000 })
      .toMatch(/frames/);                       // it started
    await win.click("#cancelexport");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 60_000 })
      .toBe("Cancelled.");
    // And the window is still usable — a cancel that wedges the app is no cancel.
    expect(await win.locator("#export").isDisabled()).toBe(false);
  }, 300_000);
});
