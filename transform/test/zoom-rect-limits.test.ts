import { describe, test, expect } from "vitest";
import { defaultProject, parseProject } from "../src/trim.js";
import { render, zoomAmountSampler } from "../src/render.js";
import { rectFromGesture, resolvedCrop, manualWindows } from "../src/zoom-override.js";
import type { Project, Session, ZoomOverride } from "../src/types.js";

/**
 * STC-653: a zoom region is held to the Amount control's own limits (1.1x to
 * 4x) everywhere one can come from: a drag on the stage, a parsed
 * project.json, and render() itself for a live document that met neither.
 *
 * Before this, a drag from the frame's edge outward saved a 0 x 0 rect, a
 * 15 px drag saved a 32x one, and the loader took any four finite numbers.
 * The limits are written out here as numbers on purpose: this file must fail
 * if the constants are retuned without anyone deciding to.
 */
const MIN_SIZE = 1 / 4;
const MAX_SIZE = 1 / 1.1;
const EPS = 1e-9;

const MS = 1_000_000;
const duration = 12_000_000_000;

function expectHeld(r: { x: number; y: number; width: number; height: number }): void {
  expect(r.width).toBeGreaterThanOrEqual(MIN_SIZE - EPS);
  expect(r.height).toBeGreaterThanOrEqual(MIN_SIZE - EPS);
  expect(r.width).toBeLessThanOrEqual(MAX_SIZE + EPS);
  expect(r.height).toBeLessThanOrEqual(MAX_SIZE + EPS);
  expect(r.x).toBeGreaterThanOrEqual(-EPS);
  expect(r.y).toBeGreaterThanOrEqual(-EPS);
  expect(r.x + r.width).toBeLessThanOrEqual(1 + EPS);
  expect(r.y + r.height).toBeLessThanOrEqual(1 + EPS);
}

describe("rectFromGesture holds a drag to the Amount limits", () => {
  test("a drag from the frame's edge outward is not 0 x 0", () => {
    const r = rectFromGesture({ x: 1, y: 0.5 }, { x: 1.2, y: 0.5 });
    expectHeld(r);
    expect(r.width).toBeCloseTo(MIN_SIZE, 10);
    // It still hangs off the anchor's edge: the box ends where the drag began.
    expect(r.x + r.width).toBeCloseTo(1, 10);
  });

  test("a drag that starts 0.5% inside the edge is not a 200x zoom", () => {
    expectHeld(rectFromGesture({ x: 0.995, y: 0.995 }, { x: 1.3, y: 1.3 }));
    expectHeld(rectFromGesture({ x: 0.005, y: 0.005 }, { x: -0.3, y: -0.3 }));
  });

  test("a small drag (the 15 px one that saved 32x) is the smallest allowed box, from its anchor", () => {
    const r = rectFromGesture({ x: 0.4, y: 0.4 }, { x: 0.43125, y: 0.41 });
    expect(r.width).toBeCloseTo(MIN_SIZE, 10);
    expect(r.height).toBeCloseTo(MIN_SIZE, 10);
    expect(r.x).toBeCloseTo(0.4, 10);
    expect(r.y).toBeCloseTo(0.4, 10);
  });

  test("a small drag up and to the left keeps its anchor at the far corner", () => {
    const r = rectFromGesture({ x: 0.6, y: 0.6 }, { x: 0.55, y: 0.57 });
    expect(r.width).toBeCloseTo(MIN_SIZE, 10);
    expect(r.x + r.width).toBeCloseTo(0.6, 10);
    expect(r.y + r.height).toBeCloseTo(0.6, 10);
  });

  test("a drag across the whole frame stops at the least zoom Amount allows", () => {
    const r = rectFromGesture({ x: 0, y: 0 }, { x: 1, y: 1 });
    expectHeld(r);
    expect(r.width).toBeCloseTo(MAX_SIZE, 10);
  });

  test("a drag already inside the limits is exactly what it was", () => {
    expect(rectFromGesture({ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.5 }))
      .toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  });
});

const doc = (overrides: unknown) => ({
  version: 6, output: { fps: 60, width: 640, height: 360 },
  cursor: { style: "default", scale: 1 }, transform: { version: 4 },
  overrides,
});
const manualDoc = (rect: unknown) => doc([
  { kind: "manual", id: "m1", startNs: 2000 * MS, endNs: 5000 * MS, rect, easing: "standard" },
]);
const geometryDoc = (rect: unknown) => doc([{ kind: "geometry", windowId: "1000000000", rect }]);
const parsed = (d: unknown): ZoomOverride[] => parseProject(d, 640, 360, duration).overrides ?? [];

describe("parseProject refuses a rect that is not a region of the frame", () => {
  const bad: [string, unknown][] = [
    ["zero size", { x: 1, y: 0.5, width: 0, height: 0 }],
    ["zero width only", { x: 0.2, y: 0.2, width: 0, height: 0.4 }],
    ["negative size", { x: 0.5, y: 0.5, width: -0.3, height: -0.3 }],
    ["larger than the frame", { x: 0, y: 0, width: 1.5, height: 1.5 }],
    ["starting before the frame", { x: -0.2, y: 0.1, width: 0.4, height: 0.4 }],
    ["running off the far edge", { x: 0.8, y: 0.8, width: 0.4, height: 0.4 }],
    ["not finite", { x: 0.1, y: 0.1, width: Infinity, height: 0.4 }],
  ];
  for (const [name, rect] of bad) {
    test(`${name}: the entry is dropped, manual or geometry`, () => {
      expect(parsed(manualDoc(rect))).toEqual([]);
      expect(parsed(geometryDoc(rect))).toEqual([]);
    });
  }

  test("one bad entry does not cost the good one beside it", () => {
    const good = { kind: "geometry", windowId: "7", rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } };
    const out = parsed(doc([
      { kind: "geometry", windowId: "1", rect: { x: 1, y: 0.5, width: 0, height: 0 } }, good,
    ]));
    expect(out).toEqual([good]);
  });
});

describe("parseProject holds a real region to the Amount limits", () => {
  test("a region inside the limits is read exactly as written", () => {
    const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
    expect(parsed(manualDoc(rect))[0]).toMatchObject({ rect });
    // The limits themselves, as the Amount control writes them, are inside.
    for (const size of [MIN_SIZE, MAX_SIZE]) {
      const edge = { x: 0, y: 0, width: size, height: size };
      expect(parsed(geometryDoc(edge))[0]).toMatchObject({ rect: edge });
    }
  });

  test("the 32x region an older build saved comes back at 4x, about the same centre", () => {
    const out = parsed(manualDoc({ x: 0.4, y: 0.4, width: 0.03125, height: 0.03125 }));
    expect(out).toHaveLength(1);
    const rect = (out[0] as Extract<ZoomOverride, { kind: "manual" }>).rect;
    expect(rect.width).toBeCloseTo(MIN_SIZE, 10);
    expect(rect.height).toBeCloseTo(MIN_SIZE, 10);
    expect(rect.x + rect.width / 2).toBeCloseTo(0.415625, 10);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.415625, 10);
  });

  test("a tiny region in the corner slides back inside the frame", () => {
    const out = parsed(geometryDoc({ x: 0.99, y: 0.99, width: 0.005, height: 0.005 }));
    expectHeld((out[0] as Extract<ZoomOverride, { kind: "geometry" }>).rect!);
  });

  test("a whole-frame region an older build's full drag saved comes back at 1.1x", () => {
    const out = parsed(manualDoc({ x: 0, y: 0, width: 1, height: 1 }));
    const rect = (out[0] as Extract<ZoomOverride, { kind: "manual" }>).rect;
    expect(rect.width).toBeCloseTo(MAX_SIZE, 10);
    expectHeld(rect);
  });
});

describe("render() never divides by a zero-size crop", () => {
  const session = {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 640,
                 pixelHeight: 360, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 640, height: 360, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
    },
    events: [{ t: 0, type: "move", x: 100, y: 100 }],
    frames: [0, 16_000_000, 32_000_000],
  } as unknown as Session;
  // A LIVE document, never through parseProject: the last line of defence.
  const live = (rect: { x: number; y: number; width: number; height: number }): Project => ({
    ...defaultProject(640, 360),
    overrides: [{ kind: "manual", id: "m1", startNs: 1000 * MS, endNs: 6000 * MS, rect, easing: "snappy" }],
  });

  for (const [name, rect] of [
    ["a zero-size rect", { x: 1, y: 0.5, width: 0, height: 0 }],
    ["a negative rect", { x: 0.5, y: 0.5, width: -0.2, height: -0.2 }],
    ["a 200x rect", { x: 0.5, y: 0.5, width: 0.005, height: 0.005 }],
  ] as const) {
    test(`${name} renders a real crop and a finite pointer at full zoom`, () => {
      const p = live(rect);
      const state = render(p, session, 4000 * MS);
      expectHeld(state.zoom.crop);
      expect(Number.isFinite(state.cursor.pxPerPoint)).toBe(true);
      expect(state.cursor.pxPerPoint).toBeLessThanOrEqual(4 + 1e-6);
      expect(Number.isFinite(state.cursor.x)).toBe(true);

      const sampler = zoomAmountSampler(p, session);
      const [m] = sampler.magnificationsAt([4000 * MS], [1]);
      expect(m).toBeLessThanOrEqual(4 + 1e-6);
    });
  }

  test("resolvedCrop is the one place the hold is applied for a tuned block", () => {
    const [w] = manualWindows(live({ x: 1, y: 0.5, width: 0, height: 0 }).overrides);
    expectHeld(resolvedCrop(undefined, w!)!);
  });

  test("a rect inside the limits is the very same object out (no pixel moves)", () => {
    const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const [w] = manualWindows(live(rect).overrides);
    expect(resolvedCrop(undefined, w!)).toBe(rect);
  });
});
