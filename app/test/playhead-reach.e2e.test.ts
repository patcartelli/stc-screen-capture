/**
 * The playhead stays reachable when the timeline is zoomed in, wired (STC-621).
 *
 * `timeline-zoom.test.ts` proves `revealSpan`/`followSpan`/`centreSpan` DECIDE
 * correctly. This drives the real editor: a real key that moves the playhead
 * off the visible span, the off-screen marker, "go to playhead", and playback
 * flipping a page. "Zoomed in" is four presses of + around the playhead at
 * frame 0, which leaves about a fifth of `fixtures/basic`'s 4.98 s showing.
 *
 * Off-screen is arranged by writing #scrub and dispatching `input`, the way
 * scrubber.e2e.test.ts seeks: that is a seek the editor does not treat as an
 * explicit move, so the playhead is left where the test put it.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { formatTimecode } from "../src/scrubber.js";
import { launchWithTakeInEditor, waitForTakeLoaded } from "./_editor-fixture.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

const LAST_FRAME = 299;

async function openZoomedIn(): Promise<Page> {
  const { app: a, editorWin } = await launchWithTakeInEditor();
  app = a;
  await waitForTakeLoaded(editorWin);
  await expect.poll(() => spanWidthPct(editorWin), { timeout: 10_000 }).toBeCloseTo(100, 3);
  for (let i = 0; i < 4; i++) await editorWin.click("#zoomin");
  expect(await spanWidthPct(editorWin)).toBeLessThan(25);
  return editorWin;
}

const spanWidthPct = (win: Page): Promise<number> =>
  win.evaluate(() => parseFloat(document.getElementById("ruler")!.dataset.spanWidth ?? "NaN"));
const spanLeftPct = (win: Page): Promise<number> =>
  win.evaluate(() => parseFloat(document.getElementById("ruler")!.dataset.spanLeft ?? "NaN"));
const frameOf = (win: Page): Promise<number> =>
  win.evaluate(() => Number((document.getElementById("scrub") as HTMLInputElement).value));
const playheadShown = (win: Page): Promise<boolean> =>
  win.evaluate(() => !document.getElementById("playhead")!.hidden);
const chipShown = (win: Page): Promise<boolean> =>
  win.evaluate(() => !document.getElementById("playheadchip")!.hidden);

/** Move the playhead without telling the editor it is an explicit move. */
async function moveSilently(win: Page, frame: number): Promise<void> {
  await win.fill("#scrub", String(frame));
  await win.dispatchEvent("#scrub", "input");
  await expect.poll(() => frameOf(win), { timeout: 20_000 }).toBe(frame);
  await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 })
    .toMatch(new RegExp(`^${formatTimecode(frame).replace(/[:.]/g, "\\$&")} /`));
}

describe("a key that moves the playhead pulls the view along", () => {
  test("End from a zoomed-in start brings the end into view, at the same zoom", async () => {
    const win = await openZoomedIn();
    const width = await spanWidthPct(win);
    expect(await spanLeftPct(win)).toBeCloseTo(0, 3);
    expect(await playheadShown(win)).toBe(true);

    await win.keyboard.press("End");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(LAST_FRAME);
    await expect.poll(() => spanLeftPct(win), { timeout: 10_000 }).toBeGreaterThan(50);
    expect(await spanWidthPct(win)).toBeCloseTo(width, 3);
    await expect.poll(() => playheadShown(win), { timeout: 10_000 }).toBe(true);
    expect(await chipShown(win)).toBe(false);

    // And back: Home is the same door the other way.
    await win.keyboard.press("Home");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => spanLeftPct(win), { timeout: 10_000 }).toBeCloseTo(0, 3);
    await expect.poll(() => playheadShown(win), { timeout: 10_000 }).toBe(true);
  }, 90_000);

  test("a step that stays in view does not move the view", async () => {
    const win = await openZoomedIn();
    const left = await spanLeftPct(win);
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(1);
    expect(await spanLeftPct(win)).toBe(left);
  }, 60_000);
});

describe("the off-screen marker", () => {
  test("appears at the edge the playhead left by, with its time, and a click brings it home", async () => {
    const win = await openZoomedIn();
    expect(await chipShown(win)).toBe(false);
    await moveSilently(win, 250);
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(true);
    expect(await playheadShown(win)).toBe(false);
    expect(await win.getAttribute("#playheadchip", "data-side")).toBe("after");
    expect(await win.textContent("#playheadchip")).toContain("→");
    expect(await win.getAttribute("#playheadchip", "aria-label")).toContain("Go to playhead");

    const width = await spanWidthPct(win);
    await win.click("#playheadchip");
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => playheadShown(win), { timeout: 10_000 }).toBe(true);
    expect(await spanWidthPct(win)).toBeCloseTo(width, 3);
    expect(await frameOf(win)).toBe(250); // it brought the VIEW, not the playhead
  }, 60_000);

  test("is on the left when the view is panned past the playhead", async () => {
    const win = await openZoomedIn();
    await win.focus("#ruler");
    await win.keyboard.press("ArrowRight"); // pans the ruler by a quarter of the span
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(true);
    expect(await win.getAttribute("#playheadchip", "data-side")).toBe("before");
    expect(await win.textContent("#playheadchip")).toContain("←");
  }, 60_000);

  test("G goes to the playhead too, and does nothing while a field has the keyboard", async () => {
    const win = await openZoomedIn();
    await moveSilently(win, 250);
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(true);
    const before = await spanLeftPct(win);

    // A text field owns the letter (the scrubber's rule 8). The audio panel's
    // inputs are number/range; the title field is the one real text input.
    const typed = await win.evaluate(() => {
      const input = document.createElement("input");
      input.type = "text";
      input.id = "g-probe";
      document.body.append(input);
      input.focus();
      return document.activeElement === input;
    });
    expect(typed).toBe(true);
    await win.keyboard.press("g");
    expect(await spanLeftPct(win)).toBe(before);
    expect(await chipShown(win)).toBe(true);
    // Removing the focused field hands the keyboard back to the page.
    await win.evaluate(() => document.getElementById("g-probe")!.remove());
    await win.keyboard.press("g");
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => playheadShown(win), { timeout: 10_000 }).toBe(true);
    expect(await frameOf(win)).toBe(250);
  }, 60_000);

  test("the button beside Fit does the same", async () => {
    const win = await openZoomedIn();
    await moveSilently(win, 250);
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(true);
    await win.click("#zoomplayhead");
    await expect.poll(() => chipShown(win), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => playheadShown(win), { timeout: 10_000 }).toBe(true);
  }, 60_000);

  test("the zoom buttons still fit in their 64px cell with the new one", async () => {
    const win = await openZoomedIn();
    const fits = await win.evaluate(() => {
      const bar = document.getElementById("zoombar")!;
      return bar.scrollWidth <= bar.clientWidth + 0.5;
    });
    expect(fits).toBe(true);
  }, 60_000);
});

describe("playback follows the playhead", () => {
  test("flips a page when the playhead reaches the right edge, and keeps it in view", async () => {
    const win = await openZoomedIn();
    expect(await spanLeftPct(win)).toBeCloseTo(0, 3);
    await win.keyboard.press("Space");
    // The first page is about a fifth of the take (~1 s), so a flip is due
    // within a couple of seconds of real playback.
    await expect.poll(() => spanLeftPct(win), { timeout: 15_000 }).toBeGreaterThan(5);
    await expect.poll(() => playheadShown(win), { timeout: 5_000 }).toBe(true);
    expect(await chipShown(win)).toBe(false);
    await win.keyboard.press("k");
  }, 60_000);

  test("a pan by hand during playback ends the following until the next Play", async () => {
    const win = await openZoomedIn();
    await win.keyboard.press("Space");
    await expect.poll(() => win.evaluate(() => document.getElementById("playpause")!.hasAttribute("data-playing")),
      { timeout: 10_000 }).toBe(true);
    // Pan well past the playhead before it reaches the first page's edge.
    await win.focus("#ruler");
    for (let i = 0; i < 3; i++) await win.keyboard.press("ArrowRight");
    await expect.poll(() => chipShown(win), { timeout: 5_000 }).toBe(true);
    const held = await spanLeftPct(win);
    await win.waitForTimeout(400);
    // A followed view would have flipped back to the playhead on the next tick.
    expect(await spanLeftPct(win)).toBe(held);
    await win.keyboard.press("k");
  }, 60_000);
});
