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
 *
 * STC-636: the lane's height is the crop's magnification on a log scale (1x
 * the floor, 2x halfway, 4x the top), not the ease's progress. So each block
 * here is set to Amount 4x first, and the crossing read is the height of a 4x
 * block HALFWAY THROUGH its ease (`MID_EASE`), the same instants this file read
 * before. Higher up the ramp (2x, two thirds through) a Slow push in has not
 * fully settled when the block ends, so the fall moved with the In speed.
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
  await setAmount(win, 4);
  return win;
}

async function setAmount(win: Page, amount: number): Promise<void> {
  await win.fill("#zoomamountrange", String(amount));
  await win.dispatchEvent("#zoomamountrange", "input");
}

async function setSpeed(win: Page, side: "in" | "out", speed: "calm" | "snappy"): Promise<void> {
  await win.click(`#chipside [data-side="${side}"]`);
  await win.click(`#chipspeed [data-speed="${speed}"]`);
}

async function done(win: Page): Promise<void> {
  await win.click("#overridedone");
  await win.waitForSelector("#overridebar", { state: "hidden", timeout: 10_000 });
}

/** A 4x block's lane height halfway through its ease: crop 1 - 0.75 * 0.5, on log4. */
const MID_EASE = Math.log(1 / (1 - 0.75 * 0.5)) / Math.log(4);

/**
 * Where the lane's top edge crosses `MID_EASE`: the first and the last canvas
 * column at or above it. null while nothing is drawn.
 */
const halfHeightCrossings = (win: Page): Promise<{ rise: number; fall: number } | null> => win.evaluate((mid) => {
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
    if (topRow(x) <= h * (1 - mid)) { if (rise < 0) rise = x; fall = x; }
  }
  return rise < 0 ? null : { rise, fall };
}, MID_EASE);

/** The top-most drawn row anywhere on the lane, as a fraction of its height from the bottom. */
const peakHeight = (win: Page): Promise<number> => win.evaluate(() => {
  const c = document.getElementById("zoom-curve") as HTMLCanvasElement;
  const { width: w, height: h } = c;
  const data = c.getContext("2d")!.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]! > 90) return (h - y) / h;
  }
  return 0;
});

describe("the Zoom lane's height is how far in the block zooms (STC-636)", () => {
  test("a 4x block fills the lane; 1.5x is under a third of it; Auto (2.0x here) is about half", async () => {
    const win = await openBlock();
    await done(win);
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.9);

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await setAmount(win, 1.5);
    await done(win);
    // log(1.5) / log(4) = 0.29.
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeLessThan(0.36);
    expect(await peakHeight(win)).toBeGreaterThan(0.2);

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await win.click('#chipplace [data-place="auto"]');
    await done(win);
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.42);
    expect(await peakHeight(win)).toBeLessThan(0.58);
  }, 120_000);
});

describe("the Zoom lane shows a block's In and Out speeds", () => {
  test("In: Slow rises later than Fast, by tens of pixels", async () => {
    const win = await openBlock();
    await setSpeed(win, "in", "calm");
    await done(win);
    // Wait for the committed 4x block: while it was open the lane drew stage
    // 2's 2.0x block, which also crosses MID_EASE, but earlier on its way out.
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.9);
    const slow = (await halfHeightCrossings(win))!;

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await setSpeed(win, "in", "snappy");
    await done(win);
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.9);
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
    // Wait for the committed 4x block: while it was open the lane drew stage
    // 2's 2.0x block, which also crosses MID_EASE, but earlier on its way out.
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.9);
    const slow = (await halfHeightCrossings(win))!;

    await win.click(".zoomblock");
    await win.waitForSelector("#overridebar", { state: "visible", timeout: 10_000 });
    await setSpeed(win, "out", "snappy");
    await done(win);
    await expect.poll(() => peakHeight(win), { timeout: 10_000 }).toBeGreaterThan(0.9);
    await expect.poll(async () => (await halfHeightCrossings(win))?.fall ?? slow.fall, { timeout: 10_000 })
      .toBeLessThan(slow.fall);
    const fast = (await halfHeightCrossings(win))!;
    expect(slow.fall - fast.fall).toBeGreaterThanOrEqual(8);
    expect(Math.abs(fast.rise - slow.rise)).toBeLessThanOrEqual(2);
  }, 120_000);
});
