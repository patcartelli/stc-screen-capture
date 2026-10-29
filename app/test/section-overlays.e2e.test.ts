/**
 * The section overlays (STC-606): each shows only while its inspector section
 * is active. This file covers the plumbing they all share; each overlay adds
 * its own describe block as it lands.
 *
 * The fixture is `fixtures/basic` (no camera, no audio), so the Camera and
 * Audio tabs are not offered and choosing them falls back to Frame.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { launchWithTakeInEditor, waitForTakeLoaded } from "./_editor-fixture.js";
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
