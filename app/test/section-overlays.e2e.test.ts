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
import { launchWithTakeInEditor, waitForTakeLoaded, inkiness, launchApp, openEditorFromLibrary } from "./_editor-fixture.js";
import { makeMicTakeFolder } from "./_take-fixture.js";
import { trimRangeParts } from "../src/timeline-activity.js";
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

/**
 * Export (Figma 171:2050). Brass in/out bars through every lane and a range
 * chip in the strip, Export only (Patrick, 2026-10-29); the Clip lane's own
 * brackets elsewhere. Dimming outside the range now reaches the Audio lane.
 * `fixtures/basic` for the bars and chip; a mic take for the Audio dimming.
 */
describe("the Export overlay", () => {
  const savedTrim = (dir: string) => {
    try { return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).trim as { startNs: number; endNs: number } | undefined; }
    catch { return undefined; }
  };
  const box = (win: Page, sel: string) => win.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s)!;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: (r.left + r.right) / 2,
             shown: getComputedStyle(el).display !== "none" && r.width > 0 };
  }, sel);

  test("bars and chip show only in Export; the Clip brackets stay elsewhere", async () => {
    const win = await openEditor();
    expect((await box(win, "#exportbar-in")).shown).toBe(false);
    expect((await box(win, "#rangechip")).shown).toBe(false);
    expect(await win.evaluate(() => getComputedStyle(document.getElementById("trim-in")!).opacity)).toBe("1");
    await win.click("#tab-export");
    for (const sel of ["#exportbar-in", "#exportbar-out", "#rangechip"]) expect((await box(win, sel)).shown).toBe(true);
    // The brackets keep their ids and hit area (the e2e suite and rule 4 rely
    // on them) but give way to the bars visually.
    expect(await win.evaluate(() => getComputedStyle(document.getElementById("trim-in")!).opacity)).toBe("0");
    await win.click("#tab-frame");
    expect((await box(win, "#exportbar-in")).shown).toBe(false);
  }, 60_000);

  test("each bar sits on its trim point and runs from the Clip lane's top to the last lane's bottom", async () => {
    const win = await openEditor();
    await win.click("#tab-export");
    const [bin, bout, hin, hout, clip, zoom] = await Promise.all([
      box(win, "#exportbar-in"), box(win, "#exportbar-out"), box(win, "#trim-in"), box(win, "#trim-out"),
      box(win, ".laneviewport.clip"), box(win, ".laneviewport.zoom"),
    ]);
    expect(Math.abs(bin.x - hin.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bout.x - hout.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bin.top - clip.top)).toBeLessThanOrEqual(1);
    // No audio in this fixture, so the Zoom lane is the last.
    expect(Math.abs(bin.bottom - zoom.bottom)).toBeLessThanOrEqual(1);
  }, 60_000);

  test("dragging the in bar trims, the chip reads the range, and a press on a bar never grabs the playhead", async () => {
    const { app: a, editorWin: win, takeDir } = await launchWithTakeInEditor();
    app = a;
    await waitForTakeLoaded(win);
    await win.click("#tab-export");
    const track = await box(win, "#timeline");
    const bin = await box(win, "#exportbar-in");
    const clockBefore = await win.textContent("#clock");
    await win.mouse.move(bin.x, (bin.top + bin.bottom) / 2);
    await win.mouse.down();
    await win.mouse.move(track.left + (track.right - track.left) * 0.25, (bin.top + bin.bottom) / 2, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => savedTrim(takeDir)?.startNs ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
    const t = savedTrim(takeDir)!;
    // The bar followed, and so did the bracket it stands in for.
    const [bin2, hin2] = await Promise.all([box(win, "#exportbar-in"), box(win, "#trim-in")]);
    expect(Math.abs(bin2.x - hin2.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bin2.x - (track.left + (track.right - track.left) * 0.25))).toBeLessThanOrEqual(4);
    // The chip: the export window's ends (the trim, here past the first frame)
    // and the same length as the Export section's Length row.
    const parts = trimRangeParts(t.startNs, t.endNs);
    const chip = await win.textContent("#rangechip");
    expect(chip).toContain(`In${parts.in}`);
    expect(chip).toContain(`Out${parts.out}`);
    expect(chip!.endsWith(await win.textContent("#exportlength") ?? "?")).toBe(true);
    // The chip sits just right of the in bar, inside the strip.
    const [chipBox, strip] = await Promise.all([box(win, "#rangechip"), box(win, "#overlay-strip")]);
    expect(chipBox.left).toBeGreaterThan(bin2.x);
    expect(chipBox.right).toBeLessThanOrEqual(strip.right);
    // The press was the bar's, not the playhead's (it started at frame 0,
    // where the playhead sits on the in-point).
    expect(await win.textContent("#clock")).toBe(clockBefore);
  }, 60_000);

  test("the Audio lane dims outside the range like Clip and Zoom", async () => {
    const launched = await launchApp(makeMicTakeFolder().dir);
    app = launched.app;
    const win = await openEditorFromLibrary(app, launched.win);
    await waitForTakeLoaded(win);
    await win.waitForSelector("#audio-lane:not([hidden])", { timeout: 20_000 });
    await win.click("#tab-export");
    const track = await box(win, "#timeline");
    // The in bar first, then the out bar straight after with no wait: that
    // pair once lost the first release, so the in-point chased the pointer
    // across to the out bar and both ended at the end of the take.
    const bin = await box(win, "#exportbar-in");
    await win.mouse.move(bin.x, (bin.top + bin.bottom) / 2);
    await win.mouse.down();
    await win.mouse.move(track.left + (track.right - track.left) * 0.2, (bin.top + bin.bottom) / 2, { steps: 8 });
    await win.mouse.up();
    const bout = await box(win, "#exportbar-out");
    await win.mouse.move(bout.x, (bout.top + bout.bottom) / 2);
    await win.mouse.down();
    await win.mouse.move(track.left + (track.right - track.left) * 0.6, (bout.top + bout.bottom) / 2, { steps: 8 });
    await win.mouse.up();
    const [clipTail, audioTail, audio, bout2, bin2] = await Promise.all([
      box(win, "#cut-tail"), box(win, "#audio-cut-tail"), box(win, ".laneviewport.audio"), box(win, "#exportbar-out"),
      box(win, "#exportbar-in"),
    ]);
    const w = track.right - track.left;
    expect(Math.abs(bin2.x - (track.left + w * 0.2))).toBeLessThanOrEqual(4);
    expect(Math.abs(bout2.x - (track.left + w * 0.6))).toBeLessThanOrEqual(4);
    expect(Math.abs(audioTail.left - clipTail.left)).toBeLessThanOrEqual(1);
    expect(audioTail.right - audioTail.left).toBeGreaterThan(0);
    // With audio, the bars reach the Audio lane's bottom.
    expect(Math.abs(bout2.bottom - audio.bottom)).toBeLessThanOrEqual(1);
  }, 90_000);
});
