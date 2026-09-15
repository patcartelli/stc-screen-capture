import { describe, test, expect } from "vitest";
import {
  deriveZoomCrop, BURST_LEAD_NS, BURST_TRAIL_NS, VIEWPORT_MIN_FRACTION, VIEWPORT_MAX_FRACTION,
  CURSOR_DEAD_ZONE_UV,
} from "../src/zoom-change.js";
import type { Changes } from "../src/changes.js";
import type { ZoomWindow } from "../src/zoom.js";
import type { SessionEvent } from "../src/types.js";

/**
 * The pure half of auto-zoom stage 2 (STC-326): `deriveZoomCrop(window,
 * changes, display) -> Rect | null`. `zoom-change.ts`'s own header explains
 * why the classifier below is reasoned from THIS ticket's four stated
 * outcomes rather than sourced from STC-319's rules list, which does not
 * exist. These fixtures are hand-authored `changes.json`-shaped data — no
 * recording, no decode, exactly what the ticket itself suggests.
 */

const MS = 1_000_000;
const DISPLAY = { originX: 0, originY: 0, pointWidth: 1000, pointHeight: 1000 };

function makeChanges(
  gridWidth: number, gridHeight: number,
  frames: { t: number; active: [number, number][]; value?: number }[],
): Changes {
  return {
    version: 1, gridWidth, gridHeight, threshold: 0.08,
    frames: frames.map((f) => {
      const cells = new Array(gridWidth * gridHeight).fill(0);
      for (const [col, row] of f.active) cells[row * gridWidth + col] = f.value ?? 0.5;
      return { t: f.t, cells, changedFraction: f.active.length / (gridWidth * gridHeight) };
    }),
  };
}

const clickWindow = (tNs: number): ZoomWindow => ({
  startNs: tNs - 300 * MS, endNs: tNs + 2500 * MS,
  events: [{ t: tNs, kind: "down", x: 500, y: 500, button: 0 } as SessionEvent],
});

/** Every 100ms from window.startNs to window.endNs inclusive — a plain, regular sampling. */
function regularFrameTimes(w: ZoomWindow): number[] {
  const out: number[] = [];
  for (let t = w.startNs; t <= w.endNs; t += 100 * MS) out.push(t);
  return out;
}

const centerOf = (r: { x: number; y: number; width: number; height: number }) =>
  ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

describe("deriveZoomCrop — the change track", () => {
  test("discrete change near the event: frame it", () => {
    const w = clickWindow(2000 * MS);
    const changes = makeChanges(10, 10, regularFrameTimes(w).map((t) => ({
      t,
      // Only active in the burst window right after the click.
      active: t >= 2000 * MS && t <= 2000 * MS + BURST_TRAIL_NS ? [[5, 5]] as [number, number][] : [],
    })));
    const crop = deriveZoomCrop(w, changes, DISPLAY);
    expect(crop).not.toBeNull();
    // Cell (5,5) of a 10x10 grid centres near UV (0.55, 0.55).
    const c = centerOf(crop!);
    expect(c.x).toBeCloseTo(0.55, 1);
    expect(c.y).toBeCloseTo(0.55, 1);
  });

  test("several regions change together: their UNION, never just one", () => {
    const w = clickWindow(2000 * MS);
    const burstEnd = 2000 * MS + BURST_TRAIL_NS;
    const changes = makeChanges(10, 10, regularFrameTimes(w).map((t) => ({
      t,
      active: t >= 2000 * MS && t <= burstEnd ? [[1, 1], [8, 1]] as [number, number][] : [],
    })));
    const crop = deriveZoomCrop(w, changes, DISPLAY);
    expect(crop).not.toBeNull();
    // The union's centre sits BETWEEN the two regions (~0.5), not on either
    // one (~0.15 or ~0.85) — this survives the viewport clamp because the
    // clamp preserves the centre it is given.
    const c = centerOf(crop!);
    expect(c.x).toBeGreaterThan(0.35);
    expect(c.x).toBeLessThan(0.65);
    // Same row, different columns — a wide, one-cell-tall union, which is
    // exactly the asymmetric shape that used to clamp width and height to
    // different final values and visibly distort the picture.
    expect(crop!.width).toBeCloseTo(crop!.height, 9);
  });

  test("everything changes (a video, a page scrolling): don't zoom", () => {
    const w = clickWindow(2000 * MS);
    const frames = regularFrameTimes(w);
    // Every cell active in every frame — ambient, not a reaction to the click.
    const active: [number, number][] = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) active.push([c, r]);
    const changes = makeChanges(10, 10, frames.map((t) => ({ t, active })));
    expect(deriveZoomCrop(w, changes, DISPLAY)).toBeNull();
  });

  test("nothing changes (a click with no visible result): don't zoom", () => {
    const w = clickWindow(2000 * MS);
    const changes = makeChanges(10, 10, regularFrameTimes(w).map((t) => ({ t, active: [] })));
    expect(deriveZoomCrop(w, changes, DISPLAY)).toBeNull();
  });

  test("a computed crop barely tighter than the full frame: don't zoom", () => {
    const w = clickWindow(2000 * MS);
    const burstEnd = 2000 * MS + BURST_TRAIL_NS;
    // Discrete (not ambient — only active in the burst), but spans nearly
    // the whole grid: two corners, both real event-triggered change, whose
    // union simply doesn't crop much.
    const changes = makeChanges(10, 10, regularFrameTimes(w).map((t) => ({
      t,
      active: t >= 2000 * MS && t <= burstEnd ? [[0, 0], [9, 9]] as [number, number][] : [],
    })));
    expect(deriveZoomCrop(w, changes, DISPLAY)).toBeNull();
  });

  test("change spread evenly through the window, uncorrelated with the event: excluded as diffuse", () => {
    const w = clickWindow(2000 * MS);
    const frames = regularFrameTimes(w);
    // Active in EVERY frame but only ~15% of cells changed per frame at each
    // sampling instant — the frame-level activeFrames test alone would not
    // catch this if it looked only at "changedFraction"; the burst-weight
    // test does, since none of this cell's weight concentrates near the
    // click (it is spread across the whole window, not a reaction to it).
    const changes = makeChanges(10, 10, frames.map((t, i) => ({
      t, active: i % 3 === 0 ? [[4, 4]] as [number, number][] : [],
    })));
    expect(deriveZoomCrop(w, changes, DISPLAY)).toBeNull();
  });

  test("changes present but no frame covers the window: uninformative, falls back to cursor", () => {
    const w = clickWindow(2000 * MS);
    // All frames sit well after the window ends.
    const changes = makeChanges(10, 10, [{ t: 50_000 * MS, active: [[5, 5]] }]);
    const crop = deriveZoomCrop(w, changes, DISPLAY);
    // Falls back to the cursor cluster around the click at (500, 500) of a
    // 1000x1000 display -> UV (0.5, 0.5).
    expect(crop).not.toBeNull();
    const c = centerOf(crop!);
    expect(c.x).toBeCloseTo(0.5, 1);
    expect(c.y).toBeCloseTo(0.5, 1);
  });
});

describe("deriveZoomCrop — the cursor-clustering fallback", () => {
  test("changes entirely absent: a bare click clusters to a small dead zone around it", () => {
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 4500 * MS,
      events: [
        { t: 2000 * MS, kind: "down", x: 500, y: 500, button: 0 },
        { t: 2050 * MS, kind: "up", x: 500, y: 500, button: 0 },
      ],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    expect(crop).not.toBeNull();
    const c = centerOf(crop!);
    expect(c.x).toBeCloseTo(0.5, 1);
    expect(c.y).toBeCloseTo(0.5, 1);
    // Floored to VIEWPORT_MIN_FRACTION — a dead zone this small always is.
    expect(crop!.width).toBeCloseTo(VIEWPORT_MIN_FRACTION, 5);
    expect(crop!.height).toBeCloseTo(VIEWPORT_MIN_FRACTION, 5);
  });

  test("a drag grows the cluster to the drag's own bounding box, not just the dead zone", () => {
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 6000 * MS,
      events: [
        { t: 2000 * MS, kind: "down", x: 200, y: 500, button: 0 },
        { t: 2100 * MS, kind: "move", x: 400, y: 500 },
        { t: 2200 * MS, kind: "move", x: 600, y: 500 },
        { t: 2300 * MS, kind: "up", x: 600, y: 500, button: 0 },
      ],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    expect(crop).not.toBeNull();
    // The drag spans UV x in [0.2, 0.6] — wider than the dead zone alone —
    // so its centre sits at the drag's own midpoint (0.4), not at either end.
    const c = centerOf(crop!);
    expect(c.x).toBeCloseTo(0.4, 1);
  });

  test("an asymmetric cluster still produces a crop with equal UV width and height", () => {
    // Same drag as above — wide, zero raw height — which is exactly the
    // shape that squished the picture on a real take before this was fixed:
    // width and height used to be clamped into [0.5, 0.7] INDEPENDENTLY, so
    // a bbox with very different extents on each axis could clamp to two
    // different final values. A UV rect's pixel aspect ratio is
    // (uvWidth/uvHeight) times the frame's own, and compositor.ts always
    // stretches whatever rect it is given to fill the (frame-proportioned)
    // output — so uvWidth !== uvHeight is a crop that visibly distorts the
    // picture the instant it is drawn, on ANY display, square or not.
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 6000 * MS,
      events: [
        { t: 2000 * MS, kind: "down", x: 200, y: 500, button: 0 },
        { t: 2100 * MS, kind: "move", x: 400, y: 500 },
        { t: 2200 * MS, kind: "move", x: 600, y: 500 },
        { t: 2300 * MS, kind: "up", x: 600, y: 500, button: 0 },
      ],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    expect(crop).not.toBeNull();
    expect(crop!.width).toBeCloseTo(crop!.height, 9);
  });

  test("a point already inside the current cluster does not grow it (the dead zone itself)", () => {
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 4500 * MS,
      events: [
        { t: 2000 * MS, kind: "down", x: 500, y: 500, button: 0 },
        // Jitter well inside the starting dead zone (CURSOR_DEAD_ZONE_UV of
        // display width, centred on the down) — must not grow the cluster.
        { t: 2010 * MS, kind: "move", x: 500 + CURSOR_DEAD_ZONE_UV * 1000 * 0.1, y: 500 },
        { t: 2050 * MS, kind: "up", x: 500, y: 500, button: 0 },
      ],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    // Still floored at VIEWPORT_MIN_FRACTION, exactly as the bare-click case.
    expect(crop!.width).toBeCloseTo(VIEWPORT_MIN_FRACTION, 5);
  });

  test("a click near the edge clamps into the frame rather than overflowing", () => {
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 4500 * MS,
      events: [{ t: 2000 * MS, kind: "down", x: 20, y: 20, button: 0 }],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    expect(crop).not.toBeNull();
    expect(crop!.x).toBeGreaterThanOrEqual(0);
    expect(crop!.y).toBeGreaterThanOrEqual(0);
    expect(crop!.x + crop!.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(crop!.y + crop!.height).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("deriveZoomCrop — the viewport clamp applies to both signals identically", () => {
  test("a crop naturally larger than VIEWPORT_MAX_FRACTION is capped, centre preserved", () => {
    const w: ZoomWindow = {
      startNs: 1700 * MS, endNs: 6000 * MS,
      events: [
        { t: 2000 * MS, kind: "down", x: 100, y: 500, button: 0 },
        { t: 2100 * MS, kind: "move", x: 900, y: 500 },
        { t: 2200 * MS, kind: "up", x: 900, y: 500, button: 0 },
      ],
    };
    const crop = deriveZoomCrop(w, undefined, DISPLAY);
    expect(crop).not.toBeNull();
    expect(crop!.width).toBeLessThanOrEqual(VIEWPORT_MAX_FRACTION + 1e-9);
    expect(centerOf(crop!).x).toBeCloseTo(0.5, 1);
  });
});

describe("BURST_LEAD_NS / BURST_TRAIL_NS sanity", () => {
  test("both are positive, and the window leans forward (trail exceeds lead)", () => {
    expect(BURST_LEAD_NS).toBeGreaterThan(0);
    expect(BURST_TRAIL_NS).toBeGreaterThan(BURST_LEAD_NS);
  });
});
