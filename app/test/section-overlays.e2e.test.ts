/**
 * The section overlays (STC-606): each shows only while its inspector section
 * is active. This file covers the plumbing they all share; each overlay adds
 * its own describe block as it lands.
 *
 * The plumbing runs on `fixtures/basic` (no camera, no audio), so the Camera
 * and Audio tabs are not offered there and choosing them falls back to Frame.
 * Each overlay's block names its own fixture.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchWithTakeInEditor, waitForTakeLoaded, inkiness } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openEditor(): Promise<Page> {
  const { app: a, editorWin } = await launchWithTakeInEditor();
  app = a;
  await waitForTakeLoaded(editorWin);
  return editorWin;
}

const section = (win: Page) => win.evaluate(() => document.body.dataset.section);

describe("the shared overlay plumbing", () => {
  test("body[data-section] follows the section switch, by click and by keyboard", async () => {
    const win = await openEditor();
    expect(await section(win)).toBe("frame");
    await win.click("#tab-zoom");
    expect(await section(win)).toBe("zoom");
    await win.click("#tab-export");
    expect(await section(win)).toBe("export");
    // Arrow keys move along the offered tabs, so the attribute must follow
    // the keyboard path too, not only clicks.
    await win.focus("#tab-export");
    await win.keyboard.press("Home");
    expect(await section(win)).toBe("frame");
  }, 60_000);

  test("a tab that is not offered falls back to Frame, and so does the attribute", async () => {
    const win = await openEditor();
    // No camera in this fixture: #pipbtn is hidden, so asking for Camera
    // lands on Frame. The attribute must not claim a section that is not shown.
    expect(await win.isHidden("#pipbtn")).toBe(true);
    await win.click("#tab-zoom");
    await win.evaluate(() => (document.getElementById("pipbtn") as HTMLElement).click());
    expect(await section(win)).toBe(await win.evaluate(() =>
      document.querySelector<HTMLElement>('#sectionswitch [aria-selected="true"]')!.dataset.section));
  }, 60_000);

  test("the overlay layer fills the strip, passes presses through, and is not under the pan/zoom transform", async () => {
    const win = await openEditor();
    const geo = await win.evaluate(() => {
      const strip = document.getElementById("overlay-strip")!.getBoundingClientRect();
      const layer = document.getElementById("strip-overlays")!;
      const r = layer.getBoundingClientRect();
      const cs = getComputedStyle(layer);
      return {
        strip: { h: Math.round(strip.height) },
        layer: { h: Math.round(r.height), top: Math.round(r.top - strip.top) },
        pointerEvents: cs.pointerEvents,
        transform: cs.transform,
        rowHeight: Math.round(document.querySelector(".striprow")!.getBoundingClientRect().height),
      };
    });
    // 36px from the --strip-h token, which the chip (32px) must fit inside.
    expect(geo.rowHeight).toBe(36);
    expect(geo.pointerEvents).toBe("none");
    expect(geo.transform).toBe("none");
    // Inside the strip's 1px border on both edges.
    expect(geo.layer.top).toBeLessThanOrEqual(1);
    expect(geo.layer.h).toBeGreaterThanOrEqual(geo.strip.h - 2);
  }, 60_000);
});

/**
 * Camera (Figma 171:1066). The behaviour (drag, snap, resize, the readout's
 * text) landed in STC-604 and is covered by pip-editor.e2e.test.ts; this is
 * the overlay's placement and the section gating. `fixtures/pip` has a camera.
 */
describe("the Camera overlay", () => {
  async function openPip() {
    const { app: a, editorWin, takeDir } = await launchWithTakeInEditor({ pip: true });
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    return { win: editorWin, takeDir };
  }
  const geometry = (win: Page) => win.evaluate(() => {
    const rect = (id: string) => {
      const r = document.querySelector(id)!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    return {
      stage: rect("#stage"), box: rect("#pipoverlay .pipbox"), label: rect("#piplabel"), handle: rect("#piphandle"),
      handleRadius: getComputedStyle(document.getElementById("piphandle")!).borderRadius,
      labelFont: getComputedStyle(document.getElementById("piplabel")!).fontFamily,
    };
  });

  test("shows only while Camera is the active section", async () => {
    const { win } = await openPip();
    expect(await win.isHidden("#pipoverlay")).toBe(true);
    await win.click("#pipbtn");
    await win.locator("#pipoverlay .pipbox").waitFor({ state: "visible", timeout: 10_000 });
    await win.click("#tab-zoom");
    await expect.poll(() => win.isHidden("#pipoverlay"), { timeout: 5_000 }).toBe(true);
  }, 120_000);

  test("a square handle, and a readout in the readout face on the box's outer side", async () => {
    const { win, takeDir } = await openPip();
    await win.click("#pipbtn");
    await win.locator("#pipoverlay .pipbox").waitFor({ state: "visible", timeout: 10_000 });
    let g = await geometry(win);
    expect(g.handleRadius).toBe("2px");
    expect(g.labelFont).toMatch(/JetBrains Mono/);
    // The handle sits on the box's bottom-right corner.
    expect(Math.abs((g.handle.left + g.handle.right) / 2 - g.box.right)).toBeLessThanOrEqual(1);
    expect(Math.abs((g.handle.top + g.handle.bottom) / 2 - g.box.bottom)).toBeLessThanOrEqual(1);

    // Drag the box to the far top-left: the readout must move to the box's
    // left edge and drop BELOW it, since there is no room above.
    const stageMid = { x: (g.stage.left + g.stage.right) / 2, y: (g.stage.top + g.stage.bottom) / 2 };
    const boxMid = { x: (g.box.left + g.box.right) / 2, y: (g.box.top + g.box.bottom) / 2 };
    const startRight = boxMid.x > stageMid.x;
    if (startRight) expect(Math.abs(g.label.right - g.box.right)).toBeLessThanOrEqual(1);
    else expect(Math.abs(g.label.left - g.box.left)).toBeLessThanOrEqual(1);

    await win.mouse.move(boxMid.x, boxMid.y);
    await win.mouse.down();
    await win.mouse.move(g.stage.left + g.box.width / 2 + 2, g.stage.top + (g.box.bottom - g.box.top) / 2 + 2, { steps: 8 });
    await win.mouse.up();
    await expect.poll(async () => (await geometry(win)).box.left - (await geometry(win)).stage.left,
      { timeout: 5_000 }).toBeLessThan(stageMid.x - g.stage.left);
    g = await geometry(win);
    expect(Math.abs(g.label.left - g.box.left)).toBeLessThanOrEqual(1);
    expect(g.label.top).toBeGreaterThanOrEqual(g.box.bottom);
    // The readout stays inside the stage, which is the point of both rules.
    expect(g.label.left).toBeGreaterThanOrEqual(g.stage.left - 1);
    expect(g.label.bottom).toBeLessThanOrEqual(g.stage.bottom + 1);

    // And it still says what the saved PiP is.
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8")).pip?.style?.width; }
      catch { return undefined; }
    }, { timeout: 10_000 }).toBeDefined();
    expect(await win.textContent("#piplabel")).toMatch(/ · Top left$/);
  }, 120_000);
});
