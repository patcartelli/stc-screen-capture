import { describe, test, expect } from "vitest";
import {
  BAR_GAP, BAR_HEIGHT, BAR_MARGIN, CONTROL_IDS, barLayout, barWidth,
  controlAt, controlEnabled, expandedSelection, micItemAt, micMenuLayout,
  sizeLabel, type OptionsState,
} from "../src/record-options.js";
import type { DisplayInfo, Rect } from "../src/selection.js";

/**
 * The options bar's decisions (STC-388), with no screen and no Electron — the
 * arrangement `selection.test.ts` and `overlay-hittest.test.ts` already have.
 *
 * What this file can settle: where the bar goes, which control a press lands
 * on, and what is offered. What it CANNOT settle, and the runbook therefore
 * owns: whether the bar READS well against a marquee near a screen edge.
 */

const display: DisplayInfo = {
  id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2,
};
const options = (over: Partial<OptionsState> = {}): OptionsState => ({
  micDeviceUid: null, camera: false, mics: [], fullDisplay: false,
  micMenuOpen: false, ...over,
});
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
    expect(l.rect.width).toBe(barWidth());
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

describe("the controls", () => {
  const l = barLayout({ x: 400, y: 300, width: 400, height: 200 }, display);

  test("every control is laid out, in order, inside the bar", () => {
    expect(l.controls.map((c) => c.id)).toEqual([...CONTROL_IDS]);
    for (const c of l.controls) {
      expect(c.rect.x).toBeGreaterThanOrEqual(l.rect.x);
      expect(right(c.rect)).toBeLessThanOrEqual(right(l.rect));
    }
  });

  test("controls do not overlap each other", () => {
    for (let i = 1; i < l.controls.length; i++) {
      expect(l.controls[i]!.rect.x).toBeGreaterThanOrEqual(right(l.controls[i - 1]!.rect));
    }
  });

  test("a press finds the control under it, and nothing outside the bar", () => {
    for (const c of l.controls) {
      const mid = { x: c.rect.x + c.rect.width / 2, y: c.rect.y + c.rect.height / 2 };
      expect(controlAt(mid, l)).toBe(c.id);
    }
    expect(controlAt({ x: l.rect.x - 1, y: l.rect.y - 1 }, l)).toBeUndefined();
    expect(controlAt({ x: right(l.rect) + 50, y: l.rect.y }, l)).toBeUndefined();
  });

  test("the mic control is offered only when there is a mic to offer", () => {
    expect(controlEnabled("mic", options())).toBe(false);
    expect(controlEnabled("mic", options({
      mics: [{ name: "Built-in", uid: "u", bluetooth: false }],
    }))).toBe(true);
    // Everything else is always available — Record most of all.
    for (const id of CONTROL_IDS) {
      if (id === "mic") continue;
      expect(controlEnabled(id, options())).toBe(true);
    }
  });
});

describe("the mic menu", () => {
  const mics = [
    { name: "Built-in", uid: "a", bluetooth: false },
    { name: "AirPods", uid: "b", bluetooth: true },
  ];
  const l = barLayout({ x: 400, y: 300, width: 400, height: 200 }, display);

  test("closed by default, and absent when there is nothing to list", () => {
    expect(micMenuLayout(l, options({ mics }), display)).toBeUndefined();
    expect(micMenuLayout(l, options({ micMenuOpen: true }), display)).toBeUndefined();
  });

  test("open, it lists Off first and then every device", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    expect(menu.items.map((i) => i.uid)).toEqual([null, "a", "b"]);
    expect(menu.items[0]!.label).toBe("Off");
    // The SAME label rule the window's mic picker uses — one owner, so the two
    // surfaces cannot name one device differently.
    expect(menu.items.map((i) => i.label)).toEqual(["Off", "Built-in", "AirPods (Bluetooth)"]);
  });

  test("a press picks the item under it", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    for (const item of menu.items) {
      const mid = { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
      expect(micItemAt(mid, menu)).toEqual({ uid: item.uid });
    }
    expect(micItemAt({ x: menu.rect.x - 5, y: menu.rect.y - 5 }, menu)).toBeUndefined();
  });

  test("the menu stays inside the display", () => {
    const menu = micMenuLayout(l, options({ mics, micMenuOpen: true }), display)!;
    expect(menu.rect.y).toBeGreaterThanOrEqual(BAR_MARGIN);
    expect(bottom(menu.rect)).toBeLessThanOrEqual(display.bounds.height - BAR_MARGIN);
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
