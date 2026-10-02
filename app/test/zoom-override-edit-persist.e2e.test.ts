/**
 * An open zoom-override edit is never lost and never left out (STC-500).
 *
 * Selecting a zoom block strips that window's own entry from the LIVE
 * project so the stage shows the unzoomed picture to draw on (STC-330). Before
 * STC-500 that made the edit invisible to everything else that reads the
 * project: a save made meanwhile (a trim, say) wrote project.json WITHOUT the
 * window's EXISTING override, closing/reloading dropped the draft, and the
 * export dialog opened over an uncommitted edit. Patrick's call (2026-10-02):
 * treat it exactly like STC-461's reframe — saves write the edit as it would
 * commit, outputs commit it first, leaving the page commits it.
 *
 * `override-edit.test.ts` pins the commit rule itself with no screen; this
 * drives the real editor and reads project.json back off disk. Same fixture
 * and helpers as `zoom-override.e2e.test.ts`: `fixtures/basic` has one
 * derived window, id "1705000000", at [1705ms, 4505ms].
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchWithTakeInEditor, dragOnStage, pressOverrideDone, openExportDialog } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const WINDOW_ID = "1705000000";

async function openPreview() {
  const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  await expect.poll(() => editorWin.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(1);
  return { win: editorWin, takeDir };
}

function readProject(takeDir: string): any {
  return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
}

const geometryFor = (takeDir: string, id: string): any =>
  (readProject(takeDir).overrides ?? []).find((o: any) => o.kind === "geometry" && o.windowId === id);

describe("a save made while a block is selected", () => {
  test("keeps the window's existing override on disk, and so does reloading the page mid-edit", async () => {
    const { win, takeDir } = await openPreview();

    // An existing geometry override on disk, committed the ordinary way.
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.6 });
    await pressOverrideDone(win);
    await expect.poll(() => geometryFor(takeDir, WINDOW_ID) !== undefined, { timeout: 10_000 }).toBe(true);
    const before = geometryFor(takeDir, WINDOW_ID);

    // Select the block again — the live project now has it stripped — and
    // make an UNRELATED save: the trim's in point, at the playhead the
    // selection seeked to (inside the window).
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridebar"), { timeout: 10_000 }).toBe(true);
    await win.keyboard.press("i");
    await expect.poll(() => readProject(takeDir).trim?.startNs ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    // The bug: this write used to drop the window's override.
    expect(geometryFor(takeDir, WINDOW_ID)).toEqual(before);
    expect(await win.isVisible("#overridebar")).toBe(true); // still editing

    // Leave the page with the edit still open — no Done, no Escape.
    await win.reload();
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
    expect(geometryFor(takeDir, WINDOW_ID)).toEqual(before);
    expect(readProject(takeDir).trim?.startNs ?? 0).toBeGreaterThan(0);
  }, 120_000);
});

describe("opening the export dialog mid-edit", () => {
  test("commits the drawn rect and closes the override editor first", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.6 });
    // No Done: the export dialog is the way out.
    await openExportDialog(win);

    await expect.poll(() => win.isHidden("#overridebar"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => geometryFor(takeDir, WINDOW_ID) !== undefined, { timeout: 10_000 }).toBe(true);
    const o = geometryFor(takeDir, WINDOW_ID);
    expect(o.rect.x).toBeCloseTo(0.2, 1);
    expect(o.rect.y).toBeCloseTo(0.2, 1);
    expect(o.rect.width).toBeCloseTo(0.5, 1);
    expect(o.rect.height).toBeCloseTo(0.4, 1);
  }, 60_000);
});
