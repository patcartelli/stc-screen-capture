import { describe, test, expect } from "vitest";
import {
  BAR_GAP, BAR_HEIGHT, BAR_MARGIN, CAPTURE_GAP, CAPTURE_HEIGHT, CONTROL_IDS, MENU_GAP,
  PANE_WIDTH, barContains, barLayout, controlAt, controlEnabled, expandedSelection,
  menuAnchor, sizeLabel, parseDimension, resizeToPixels,
} from "../src/record-options.js";
import { MIN_SELECTION_POINTS } from "../src/selection.js";
import type { DisplayInfo, Rect } from "../src/selection.js";

/**
 * The options bar's decisions (STC-388, then STC-456's new two-row pane), with
 * no screen and no Electron — the arrangement `selection.test.ts` and
 * `overlay-hittest.test.ts` already have.
 *
 * What this file can settle: where the bar goes, which control a press lands
 * on, and what is offered. What it CANNOT settle, and the runbook therefore
 * owns: whether the bar READS well against a marquee near a screen edge.
 */

const display: DisplayInfo = {
  id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2,
};
const bottom = (r: Rect) => r.y + r.height;
const right = (r: Rect) => r.x + r.width;
const overlaps = (a: Rect, b: Rect) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

describe("where the bar goes", () => {
  test("rule 1: below the marquee, centred on it", () => {
    const sel = { x: 400, y: 300, width: 400, height: 200 };
    const l = barLayout(sel, display);
    expect(l.placement).toBe("below");
    expect(l.rect.y).toBe(bottom(sel) + BAR_GAP);
    expect(l.rect.x + l.rect.width / 2).toBe(sel.x + sel.width / 2);
    expect(l.rect.height).toBe(BAR_HEIGHT);
    expect(l.rect.width).toBe(PANE_WIDTH);
  });

  test("rule 2: flips above when below would not fit", () => {
    // A marquee whose bottom leaves less than gap + height + margin below it.
    const sel = { x: 400, y: 300, width: 400, height: 1000 - 300 - 10 };
    const l = barLayout(sel, display);
    expect(l.placement).toBe("above");
    expect(bottom(l.rect)).toBe(sel.y - BAR_GAP);
  });

  test("rule 3: neither placement overlaps the marquee", () => {
    for (const sel of [
      { x: 400, y: 300, width: 400, height: 200 },
      { x: 400, y: 300, width: 400, height: 1000 - 300 - 10 },
    ]) {
      const l = barLayout(sel, display);
      expect(l.placement).not.toBe("inside");
      expect(overlaps(l.rect, sel)).toBe(false);
    }
  });

  test("rule 4: inside ONLY when neither below nor above fits", () => {
    // A full-display marquee leaves nowhere that satisfies rule 3, so rule 3
    // cannot be absolute — the fallback is explicit rather than a bar half
    // off the screen with an unreachable Record button.
    const l = barLayout(expandedSelection(display), display);
    expect(l.placement).toBe("inside");
    expect(bottom(l.rect)).toBe(display.bounds.height - BAR_MARGIN);
  });

  test("the bar is always fully inside the display, in every placement", () => {
    for (const sel of [
      { x: 0, y: 0, width: 40, height: 40 },                  // hard top-left
      { x: 1560, y: 960, width: 40, height: 40 },             // hard bottom-right
      { x: 780, y: 0, width: 40, height: 1000 },              // full height, thin
      expandedSelection(display),
    ]) {
      const l = barLayout(sel, display);
      expect(l.rect.x).toBeGreaterThanOrEqual(BAR_MARGIN);
      expect(right(l.rect)).toBeLessThanOrEqual(display.bounds.width - BAR_MARGIN);
      expect(l.rect.y).toBeGreaterThanOrEqual(BAR_MARGIN);
      expect(bottom(l.rect)).toBeLessThanOrEqual(display.bounds.height - BAR_MARGIN);
    }
  });

  test("the bar is placed in GLOBAL points — a display at an offset moves it", () => {
    const second: DisplayInfo = {
      id: 2, bounds: { x: 1600, y: -200, width: 1280, height: 800 }, scaleFactor: 1,
    };
    const sel = { x: 1800, y: 0, width: 300, height: 200 };
    const l = barLayout(sel, second);
    expect(l.rect.x).toBeGreaterThanOrEqual(second.bounds.x + BAR_MARGIN);
    expect(right(l.rect)).toBeLessThanOrEqual(second.bounds.x + second.bounds.width - BAR_MARGIN);
  });
});

describe("the controls (STC-456)", () => {
  const sel = { x: 400, y: 300, width: 400, height: 200 };
  const l = barLayout(sel, display);

  test("the pane is 340 × 108 and the capture button sits 8 below it, full width", () => {
    expect(l.pane).toMatchObject({ width: 340, height: 108 });
    expect(l.capture).toMatchObject({ x: l.pane.x, width: 340, height: CAPTURE_HEIGHT });
    expect(l.capture.y).toBe(l.pane.y + 108 + CAPTURE_GAP);
    expect(l.rect).toEqual({ x: l.pane.x, y: l.pane.y, width: 340, height: BAR_HEIGHT });
  });
  test("every control id is laid out exactly once, in CONTROL_IDS order", () => {
    expect(l.controls.map((c) => c.id)).toEqual([...CONTROL_IDS]);
  });
  test("every pane control sits inside the pane's 16px padding", () => {
    for (const c of l.controls.filter((c) => c.id !== "record")) {
      expect(c.rect.x).toBeGreaterThanOrEqual(l.pane.x + 16);
      expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(l.pane.x + 340 - 16);
      expect(c.rect.y).toBeGreaterThanOrEqual(l.pane.y + 16);
      expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(l.pane.y + 108 - 16);
    }
  });
  test("row 1 is size, expand, crop; row 2 is settings, mic, camera, keys, clicks", () => {
    const y = (id: string) => l.controls.find((c) => c.id === id)!.rect.y;
    for (const id of ["expand", "crop"]) expect(y(id)).toBe(y("size"));
    for (const id of ["mic", "camera", "keys", "clicks"]) expect(y(id)).toBe(y("settings"));
    expect(y("settings")).toBeGreaterThan(y("size"));
  });
  test("record IS the capture button", () => {
    expect(l.controls.find((c) => c.id === "record")!.rect).toEqual(l.capture);
  });
  test("controls do not overlap each other", () => {
    for (const a of l.controls) for (const b of l.controls) {
      if (a !== b) expect(overlaps(a.rect, b.rect)).toBe(false);
    }
  });
  test("a press finds the control under it", () => {
    for (const c of l.controls) {
      expect(controlAt({ x: c.rect.x + c.rect.width / 2, y: c.rect.y + c.rect.height / 2 }, l)).toBe(c.id);
    }
  });
  test("the gap between pane and button is NOT the bar, and so not a swallowed press", () => {
    const gap = { x: l.pane.x + 170, y: l.pane.y + 108 + CAPTURE_GAP / 2 };
    expect(barContains(gap, l)).toBe(false);
    expect(controlAt(gap, l)).toBeUndefined();
  });
  test("the pane's own padding IS the bar: a press there is swallowed, not a new marquee (Review Focus 3)", () => {
    const padding = { x: l.pane.x + 4, y: l.pane.y + 4 };
    expect(barContains(padding, l)).toBe(true);
    expect(controlAt(padding, l)).toBeUndefined();
  });
  test("keys and clicks are always disabled; mic needs a mic", () => {
    expect(controlEnabled("keys", { mics: [{}] })).toBe(false);
    expect(controlEnabled("clicks", { mics: [{}] })).toBe(false);
    expect(controlEnabled("mic", { mics: [] })).toBe(false);
    expect(controlEnabled("mic", { mics: [{}] })).toBe(true);
    expect(controlEnabled("camera", { mics: [] })).toBe(true);
  });
});

describe("where a menu opens (STC-456)", () => {
  // Patrick, 2026-09-28: below its trigger, OVER the capture button.
  test("drops from the trigger's bottom-left, 4 below it", () => {
    const l = barLayout({ x: 200, y: 200, width: 300, height: 200 }, display);
    const trig = l.controls.find((c) => c.id === "mic")!.rect;
    expect(menuAnchor(l, "mic", display)).toEqual(
      { menu: "mic", side: "below", x: trig.x, y: trig.y + trig.height + MENU_GAP });
  });
  test("it covers the capture button rather than avoiding it", () => {
    const l = barLayout({ x: 200, y: 200, width: 300, height: 200 }, display);
    const a = menuAnchor(l, "camera", display);
    expect(a.y).toBeLessThan(l.capture.y + l.capture.height);
  });
  test("flips ABOVE the trigger when a full menu would run off the display's bottom", () => {
    // Bar placed low: the marquee fills the display, so the bar sits inside at the bottom.
    const l = barLayout(display.bounds, display);
    const trig = l.controls.find((c) => c.id === "mic")!.rect;
    const a = menuAnchor(l, "mic", display);
    expect(a.side).toBe("above");
    expect(a.y).toBe(trig.y - MENU_GAP);
  });
});

describe("expand, and the readout", () => {
  test("expandedSelection is the display's own bounds, in global points", () => {
    expect(expandedSelection(display)).toEqual(display.bounds);
  });

  test("the readout is PIXELS, not points — it is what the file will be", () => {
    // scaleFactor 2: a 400x200 point marquee records 800x400 pixels, and the
    // number a user checks against a spec is the pixel one.
    expect(sizeLabel({ x: 0, y: 0, width: 400, height: 200 }, display)).toBe("800 × 400");
  });
});

describe("typing a size (STC-456)", () => {
  // scaleFactor 2: 1 pt = 2 px.
  test("parseDimension keeps digits and refuses everything else", () => {
    expect(parseDimension("1440")).toBe(1440);
    expect(parseDimension(" 1440 ")).toBe(1440);
    expect(parseDimension("")).toBeUndefined();
    expect(parseDimension("0")).toBeUndefined();
    expect(parseDimension("14a0")).toBeUndefined();
    expect(parseDimension("-5")).toBeUndefined();
    expect(parseDimension("1e3")).toBeUndefined();
  });
  test("resizes around the marquee's centre, and the readout shows what was typed", () => {
    const anchor = { x: 400, y: 300, width: 400, height: 200 };
    const r = resizeToPixels(anchor, display, 1000, 600);
    expect(r).toEqual({ x: 350, y: 250, width: 500, height: 300 });
    expect(sizeLabel(r, display)).toBe("1000 × 600");
  });
  test("an odd pixel count on a 2x display rounds to a whole point", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 1001, 601);
    expect(Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
  });
  test("larger than the display clamps to the display (Review Focus 2)", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 99999, 99999);
    expect(r).toEqual(display.bounds);
  });
  test("tiny clamps UP to MIN_SELECTION_POINTS, never to an invisible marquee", () => {
    const r = resizeToPixels({ x: 400, y: 300, width: 400, height: 200 }, display, 1, 1);
    expect(r.width).toBe(MIN_SELECTION_POINTS);
    expect(r.height).toBe(MIN_SELECTION_POINTS);
  });
  test("growing near an edge shifts the rect back inside rather than clipping it", () => {
    const r = resizeToPixels({ x: 1500, y: 900, width: 100, height: 100 }, display, 800, 400);
    expect(r).toEqual({ x: 1200, y: 800, width: 400, height: 200 });
  });
});
