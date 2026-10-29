/**
 * The timeline's zoom bar and the override box's hover rule, wired (STC-484).
 *
 * `timeline-zoom.test.ts` proves the pure decisions; this drives the real
 * editor: the buttons, the keys the page still receives, a synthetic
 * ⌘-wheel, panning the ruler, the hidden readout, and the override box that
 * is drawn only on hover. STC-605 took the overview strip out; the ruler
 * carries the visible span's left/width percentages as data attributes. (⌘= in the packaged app is claimed by main's
 * before-input-event; that half needs a Mac and is in the runbook.)
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { launchWithTakeInEditor, waitForTakeLoaded } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function open() {
  const { app: a, editorWin } = await launchWithTakeInEditor();
  app = a;
  await waitForTakeLoaded(editorWin);
  // The zoom bar is drawn once the opening span is set, a beat after #scrub.
  await expect.poll(() => windowWidthPct(editorWin), { timeout: 10_000 }).toBeCloseTo(100, 3);
  return editorWin;
}

const windowWidthPct = (win: any): Promise<number> =>
  win.evaluate(() => parseFloat((document.getElementById("ruler") as HTMLElement).dataset.spanWidth ?? "NaN"));
const windowLeftPct = (win: any): Promise<number> =>
  win.evaluate(() => parseFloat((document.getElementById("ruler") as HTMLElement).dataset.spanLeft ?? "NaN"));

describe("zoom bar", () => {
  test("starts at Fit with the readout hidden", async () => {
    const win = await open();
    expect(await windowWidthPct(win)).toBeCloseTo(100, 3);
    expect(await win.isDisabled("#zoomfit")).toBe(true);
    expect(await win.isDisabled("#zoomout")).toBe(true);
    expect(await win.evaluate(() => document.getElementById("zoomreadout")!.hasAttribute("data-live"))).toBe(false);
  }, 60_000);

  test("+ narrows the visible span and shows the readout; Fit restores", async () => {
    const win = await open();
    await win.click("#zoomin");
    expect(await windowWidthPct(win)).toBeLessThan(100);
    expect(await win.evaluate(() => document.getElementById("zoomreadout")!.hasAttribute("data-live"))).toBe(true);
    expect(await win.isDisabled("#zoomfit")).toBe(false);
    await win.click("#zoomfit");
    expect(await windowWidthPct(win)).toBeCloseTo(100, 3);
  }, 60_000);

  test("⌘= and ⌘0 reach the page as keys", async () => {
    const win = await open();
    // In the app main claims these chords (before-input-event) and answers
    // over IPC, so the result lands a moment after the key — poll, don't read.
    await win.keyboard.press("Meta+=");
    await expect.poll(() => windowWidthPct(win), { timeout: 10_000 }).toBeLessThan(100);
    await win.keyboard.press("Meta+0");
    await expect.poll(() => windowWidthPct(win), { timeout: 10_000 }).toBeCloseTo(100, 3);
  }, 60_000);

  test("⌘-scroll zooms; plain scroll pans", async () => {
    const win: any = await open();
    const sent = (init: WheelEventInit) => win.evaluate((i: WheelEventInit) => {
      document.getElementById("ruler")!.dispatchEvent(new WheelEvent("wheel", { ...i, bubbles: true, cancelable: true }));
    }, init);
    await sent({ metaKey: true, deltaY: -100, clientX: 200 });
    const zoomed = await windowWidthPct(win);
    expect(zoomed).toBeLessThan(100);
    const before = await windowLeftPct(win);
    await sent({ deltaY: 40 });
    expect(await windowWidthPct(win)).toBeCloseTo(zoomed, 3);
    expect(await windowLeftPct(win)).toBeGreaterThan(before);
  }, 60_000);

  test("dragging the ruler pans", async () => {
    const win = await open();
    await win.click("#zoomin");
    await win.click("#zoomin");
    const box = (await win.locator("#ruler").boundingBox())!;
    const y = box.y + box.height / 2;
    const before = await windowLeftPct(win);
    // Dragging the ruler LEFT brings later time into view.
    await win.mouse.move(box.x + box.width * 0.8, y);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width * 0.4, y, { steps: 5 });
    await win.mouse.up();
    expect(await windowLeftPct(win)).toBeGreaterThan(before);
  }, 60_000);

  test("the arrow keys pan the focused ruler, not the playhead", async () => {
    const win = await open();
    await win.click("#zoomin");
    await win.click("#zoomin");
    const frame = await win.getAttribute("#scrub", "value");
    const before = await windowLeftPct(win);
    await win.focus("#ruler");
    await win.keyboard.press("ArrowRight");
    expect(await windowLeftPct(win)).toBeGreaterThan(before);
    expect(await win.getAttribute("#scrub", "value")).toBe(frame);
  }, 60_000);
});

describe("override box", () => {
  test("is drawn only while hovering the selected block", async () => {
    const win = await open();
    await win.click(".zoomblock");
    await win.waitForSelector("#overridebox", { state: "attached" });
    // Pointer parked away from the block and the preview.
    await win.mouse.move(2, 2);
    expect(await win.evaluate(() => document.getElementById("overridebox")!.hasAttribute("data-shown"))).toBe(false);
    await win.hover(".zoomblock.selected");
    expect(await win.evaluate(() => document.getElementById("overridebox")!.hasAttribute("data-shown"))).toBe(true);
    await win.mouse.move(2, 2);
    expect(await win.evaluate(() => document.getElementById("overridebox")!.hasAttribute("data-shown"))).toBe(false);
  }, 60_000);
});
