/**
 * The Zoom lane draws a block's ease-in and ease-out, wired (STC-620).
 *
 * `timeline-activity.test.ts` proves `zoomCurveSamples` covers a Fast ramp and
 * `zoom-amount-sampler.test.ts` proves the amounts are render()'s own. This
 * drives the real editor: set a block's In (then Out) to Slow, then to Fast,
 * and read where the lane's canvas actually rises and falls. The fixture is
 * `fixtures/basic` (5 s, one block), where a ramp is tens of pixels wide, so
 * the difference between Slow (~0.28 s to half) and Fast (~0.07 s) is plain.
 * On a long take the same ramps are under a pixel until you zoom in; that is
 * the unit tests' ground, not this file's.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { launchWithTakeInEditor, waitForTakeLoaded } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

async function openBlock(): Promise<Page> {
  const { app: a, editorWin: win } = await launchWithTakeInEditor();
  app = a;
  await waitForTakeLoaded(win);
  await expect.poll(() => win.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(1);
  await win.click(".zoomblock");
  await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
  // A region, so the override has something to carry the easing on.
  await win.focus("#chipamount");
  await win.keyboard.press("ArrowUp");
  return win;
}

async function setSpeed(win: Page, side: "in" | "out", speed: "calm" | "snappy"): Promise<void> {
  await win.click(`#chipside [data-side="${side}"]`);
  await win.click(`#chipspeed [data-speed="${speed}"]`);
}

async function done(win: Page): Promise<void> {
  await win.click("#overridedone");
  await win.waitForSelector("#overridebar", { state: "hidden", timeout: 10_000 });
}

/**
 * Where the lane's top edge crosses half height: the first and the last canvas
 * column at or above it. null while nothing is drawn.
 */
const halfHeightCrossings = (win: Page): Promise<{ rise: number; fall: number } | null> => win.evaluate(() => {
  const c = document.getElementById("zoom-curve") as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  const { width: w, height: h } = c;
  const data = ctx.getImageData(0, 0, w, h).data;
  /** The row of the top-most pixel that is clearly drawn (the 2px stroke is ~0.85 alpha). */
  const topRow = (x: number): number => {
    for (let y = 0; y < h; y++) if (data[(y * w + x) * 4 + 3]! > 90) return y;
    return h;
  };
  let rise = -1, fall = -1;
  for (let x = 0; x < w; x++) {
    if (topRow(x) <= h * 0.5) { if (rise < 0) rise = x; fall = x; }
  }
  return rise < 0 ? null : { rise, fall };
});

describe("the Zoom lane shows a block's In and Out speeds", () => {
  test("In: Slow rises later than Fast, by tens of pixels", async () => {
    const win = await openBlock();
    await setSpeed(win, "in", "calm");
    await done(win);
    await expect.poll(() => halfHeightCrossings(win), { timeout: 10_000 }).not.toBeNull();
    const slow = (await halfHeightCrossings(win))!;

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await setSpeed(win, "in", "snappy");
    await done(win);
    await expect.poll(async () => (await halfHeightCrossings(win))?.rise ?? slow.rise, { timeout: 10_000 })
      .toBeLessThan(slow.rise);
    const fast = (await halfHeightCrossings(win))!;
    expect(slow.rise - fast.rise).toBeGreaterThanOrEqual(8);
    // The Out side was not touched, so the falling edge stays where it was.
    expect(Math.abs(fast.fall - slow.fall)).toBeLessThanOrEqual(2);
  }, 120_000);

  test("Out: Slow falls later than Fast, by tens of pixels", async () => {
    const win = await openBlock();
    await setSpeed(win, "out", "calm");
    await done(win);
    await expect.poll(() => halfHeightCrossings(win), { timeout: 10_000 }).not.toBeNull();
    const slow = (await halfHeightCrossings(win))!;

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await setSpeed(win, "out", "snappy");
    await done(win);
    await expect.poll(async () => (await halfHeightCrossings(win))?.fall ?? slow.fall, { timeout: 10_000 })
      .toBeLessThan(slow.fall);
    const fast = (await halfHeightCrossings(win))!;
    expect(slow.fall - fast.fall).toBeGreaterThanOrEqual(8);
    expect(Math.abs(fast.rise - slow.rise)).toBeLessThanOrEqual(2);
  }, 120_000);
});
