import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { geometryAt } from "../src/display-geometry.js";
import { effectivePointWidth } from "../src/legibility.js";
import { scopeRect, scopedDisplay, displayToOutput, mapPoint } from "../src/spaces.js";
import type { Anchors, Project, Session } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

// STC-471. The helper writes the WHOLE display into `anchors.display` and the
// region or window into `anchors.scope`; `capture` is only the scope. The
// transform used to map through `display` alone, so it stretched the whole
// display across a frame that held only the region.

const DISPLAY = { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160, backingScale: 2, originX: 0, originY: 0 };
// The ticket's own take: 1499x857 pt at (295, 54), captured at 2998x1714.
const REGION = { x: 295, y: 54, width: 1499, height: 857 };

describe("scopeRect / scopedDisplay", () => {
  test("no scope, or a display scope, is the display itself — the same object", () => {
    expect(scopeRect(undefined)).toBeUndefined();
    expect(scopeRect({ kind: "display" })).toBeUndefined();
    expect(scopedDisplay(DISPLAY, undefined)).toBe(DISPLAY);
    expect(scopedDisplay(DISPLAY, { kind: "display" })).toBe(DISPLAY);
  });

  test("a region is its rect; a window is its bounds", () => {
    expect(scopeRect({ kind: "region", region: REGION })).toEqual(REGION);
    expect(scopeRect({ kind: "window", window: { id: 7, bounds: REGION } })).toEqual(REGION);
  });

  test("the scoped display sits at the display origin plus the scope origin, at the scope's size", () => {
    const d = { ...DISPLAY, originX: -1920, originY: 100 };
    expect(scopedDisplay(d, { kind: "region", region: REGION })).toEqual({
      originX: -1920 + 295, originY: 100 + 54, pointWidth: 1499, pointHeight: 857,
    });
  });
});

describe("a region take maps the cursor into the region, not the display", () => {
  const anchors: Anchors = {
    version: 3, timebase: { numer: 1, denom: 1 }, t0Ns: "0",
    display: DISPLAY, capture: { width: 2998, height: 1714, codec: "h264", firstFrameNs: 0 },
    scope: { kind: "region", region: REGION },
    files: { display: "display.mp4" }, stop: { t: 3_000_000_000, reason: "user" },
  };
  const frames = Array.from({ length: 180 }, (_, i) => Math.round((i * 1e9) / 60));
  const project = (load("fixtures/basic/project.json") as Project);
  const out = { width: 1499, height: 857, fps: 60 as const };
  const p: Project = { ...project, output: out, zoom: { ...project.zoom!, enabled: false } };

  // The cursor is a spring: put one move at the start and read it long after.
  const at = (x: number, y: number, a: Anchors = anchors): { x: number; y: number } => {
    const s: Session = { anchors: a, frames, events: [{ t: 1, kind: "move", x, y }] as Session["events"] };
    return render(p, s, frames.at(-1)!).cursor;
  };

  test("the region's top-left global point lands on the output's top-left", () => {
    const c = at(295, 54);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });

  test("the region's bottom-right lands on the output's bottom-right", () => {
    const c = at(295 + 1499, 54 + 857);
    expect(c.x).toBeCloseTo(1499, 6);
    expect(c.y).toBeCloseTo(857, 6);
  });

  test("a point inside the region is where the region says, and pxPerPoint is the region's", () => {
    const c = at(295 + 749.5, 54 + 428.5);
    expect(c.x).toBeCloseTo(749.5, 6);
    expect(c.y).toBeCloseTo(428.5, 6);
    const s: Session = { anchors, frames, events: [] };
    expect(render(p, s, frames.at(-1)!).cursor.pxPerPoint)
      .toBeCloseTo(p.cursor.scale * (1499 / 1499), 9);
  });

  test("the same take with the scope stripped is the OLD, wrong, answer — the control", () => {
    const { scope: _scope, ...bare } = anchors;
    const c = at(295, 54, { ...bare, version: 2 } as Anchors);
    expect(c.x).not.toBeCloseTo(0, 1);      // the display's mapping puts it at 295 * (1499 / 1920)
    expect(c.x).toBeCloseTo(295 * (1499 / 1920), 6);
  });

  test("a scope on a display that is not at the origin", () => {
    const a: Anchors = { ...anchors, display: { ...DISPLAY, originX: 1920, originY: 0 } };
    const c = at(1920 + 295, 54, a);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
  });
});

describe("a window take maps through the window's bounds", () => {
  const bounds = { x: 100, y: 200, width: 800, height: 600 };
  const anchors: Anchors = {
    version: 3, timebase: { numer: 1, denom: 1 }, t0Ns: "0",
    display: DISPLAY, capture: { width: 1600, height: 1200, codec: "h264", firstFrameNs: 0 },
    scope: { kind: "window", window: { id: 42, bounds } },
    files: { display: "display.mp4" }, stop: { t: 1_000_000_000, reason: "user" },
  };

  test("geometryAt hands out the scope-adjusted space and keeps the real display", () => {
    const g = geometryAt(anchors, 0);
    expect(g.display).toBe(DISPLAY);
    expect(g.shown).toEqual({ originX: 100, originY: 200, pointWidth: 800, pointHeight: 600 });
  });

  test("displayToOutput over the shown space scales by the window, not the display", () => {
    const g = geometryAt(anchors, 0);
    const m = displayToOutput(g.shown, { width: 1600, height: 1200 }, g.contentRect, anchors.capture);
    expect(mapPoint(m, { x: 100, y: 200 })).toEqual({ x: 0, y: 0 });
    expect(mapPoint(m, { x: 500, y: 500 })).toEqual({ x: 800, y: 600 });
  });
});

describe("a region take that survives a refit composes region, then contentRect", () => {
  // The display's point size changes mid-take: 1920x1080 -> 960x540 (a 2x
  // scaled-resolution change). The region is in display points, so the SAME
  // region in the new display's points is the region scaled by the new display.
  const anchors: Anchors = {
    version: 7, timebase: { numer: 1, denom: 1 }, t0Ns: "0",
    display: DISPLAY, capture: { width: 2998, height: 1714, codec: "h264", firstFrameNs: 0 },
    scope: { kind: "region", region: REGION },
    geometry: [
      { startNs: 0, display: DISPLAY, contentRect: { x: 0, y: 0, width: 2998, height: 1714 } },
      { startNs: 1_000_000_000, display: { ...DISPLAY, pointWidth: 960, pointHeight: 540 },
        contentRect: { x: 0, y: 0, width: 2998, height: 1714 } },
    ],
    files: { display: "display.mp4" }, stop: { t: 2_000_000_000, reason: "user" },
  };

  test("each entry's shown space is the scope on THAT entry's display", () => {
    const g0 = geometryAt(anchors, 0);
    const g1 = geometryAt(anchors, 1_000_000_000);
    expect(g0.shown.pointWidth).toBe(1499);
    expect(g1.shown.pointWidth).toBe(1499);          // the region keeps its point size
    expect(g1.display.pointWidth).toBe(960);
  });
});

describe("legibility follows the scope's point width", () => {
  test("no scope: the display's width, untouched", () => {
    expect(effectivePointWidth({ display: { pointWidth: 1920 }, capture: { width: 2998 } })).toBe(1920);
  });

  test("a region: the region's width — the text is bigger in the frame than the display's would say", () => {
    expect(effectivePointWidth({
      display: { pointWidth: 1920 }, capture: { width: 2998 },
      scope: { kind: "region", region: REGION },
    })).toBe(1499);
  });

  test("a window: the window's width", () => {
    expect(effectivePointWidth({
      display: { pointWidth: 1920 }, capture: { width: 1600 },
      scope: { kind: "window", window: { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } } },
    })).toBe(800);
  });

  test("a region across a refit takes the worst entry, on the region's width", () => {
    const w = effectivePointWidth({
      display: { pointWidth: 1920 }, capture: { width: 2998 },
      scope: { kind: "region", region: REGION },
      geometry: [
        { display: { pointWidth: 1920 }, contentRect: { width: 2998 } },
        { display: { pointWidth: 960 }, contentRect: { width: 1499 } },     // pillarboxed into half the frame
      ],
    });
    expect(w).toBeCloseTo(1499 * 2998 / 1499, 9);
  });
});
