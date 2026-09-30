import { describe, test, expect } from "vitest";
import { checkGeometry, geometryAt, fullFrame } from "../src/display-geometry.js";
import type { Anchors } from "../src/types.js";

const D0 = { id: 1, pointWidth: 1728, pointHeight: 1117, pixelWidth: 3456, pixelHeight: 2234,
             backingScale: 2, originX: 0, originY: 0 };
const D1 = { ...D0, pointWidth: 1440, pointHeight: 900, pixelWidth: 2880, pixelHeight: 1800 };

function v7(): Anchors {
  return {
    version: 7, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
    display: D0,
    capture: { width: 3340, height: 2160, codec: "h264", firstFrameNs: 16_000_000 },
    files: { display: "display.mp4" },
    geometry: [
      { startNs: 16_000_000, display: D0, contentRect: { x: 0, y: 0, width: 3340, height: 2160 } },
      { startNs: 4_000_000_000, display: D1, contentRect: { x: 0, y: 36, width: 3340, height: 2088 } },
    ],
  } as Anchors;
}

describe("geometryAt — the entry for the frame being SHOWN", () => {
  test("no geometry: the top-level display and the full frame", () => {
    const a = { ...v7(), version: 6, geometry: undefined } as Anchors;
    expect(geometryAt(a, 5_000_000_000)).toEqual({ display: D0, shown: D0, contentRect: fullFrame(a.capture) });
  });
  test("a frame before the refit uses entry 0", () => {
    expect(geometryAt(v7(), 3_999_999_999).display).toBe(D0);
  });
  test("the refitted frame itself uses entry 1", () => {
    expect(geometryAt(v7(), 4_000_000_000).display).toBe(D1);
  });
  test("no frame shown yet (null) uses entry 0", () => {
    expect(geometryAt(v7(), null).display).toBe(D0);
  });
});

describe("checkGeometry refuses rather than defaults", () => {
  const bad = (mut: (a: any) => void) => { const a: any = v7(); mut(a); return a; };
  test("a valid v7 passes", () => expect(() => checkGeometry(v7())).not.toThrow());
  test("no geometry passes (every take before STC-235)", () =>
    expect(() => checkGeometry({ ...v7(), version: 6, geometry: undefined } as Anchors)).not.toThrow());
  test.each([
    ["v7 without geometry", (a: any) => { delete a.geometry; }],
    ["geometry on a v6", (a: any) => { a.version = 6; }],
    ["one entry", (a: any) => { a.geometry.length = 1; }],
    ["entry 0 display differs", (a: any) => { a.geometry[0].display = D1; }],
    ["entry 0 not full frame", (a: any) => { a.geometry[0].contentRect.y = 2; }],
    ["entry 0 startNs != firstFrameNs", (a: any) => { a.geometry[0].startNs = 0; }],
    ["startNs not increasing", (a: any) => { a.geometry[1].startNs = 16_000_000; }],
    ["rect outside capture", (a: any) => { a.geometry[1].contentRect.height = 2160; }],
    ["odd rect edge", (a: any) => { a.geometry[1].contentRect.y = 35; }],
  ])("%s throws", (_, mut) => expect(() => checkGeometry(bad(mut))).toThrow());
});
