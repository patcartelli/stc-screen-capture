import { describe, test, expect } from "vitest";
import {
  cleanPipStyle, pipSize, pipRect, framingSource, clampFraming, styleFromFixedCorner,
  isDefaultPipStyle, pipStylesEqual, DEFAULT_PIP_STYLE, DEFAULT_PIP_FIXED, DEFAULT_FRAMING,
  PIP_WIDTH_MAX, PIP_FRAMING_ZOOM_MAX, type PipStyle,
} from "../src/pip-style.js";
import { fixedCornerPipUv, uvRectToPixels, outputRect, roundRect } from "../src/spaces.js";
import { DEFAULT_PIP } from "../src/trim.js";

const CAM = { width: 1280, height: 720 };
const style = (over: Partial<PipStyle> = {}): PipStyle => ({ ...DEFAULT_PIP_STYLE, ...over });

describe("cleanPipStyle — the one validator", () => {
  test("accepts the default and a full style", () => {
    expect(cleanPipStyle(DEFAULT_PIP_STYLE)).toEqual(DEFAULT_PIP_STYLE);
    const full = style({ shape: "circle", border: { widthPt: 2, color: "#FFffFF" }, shadow: true,
      mirror: true, framing: { x: 0.4, y: 0.6, zoom: 2 } });
    expect(cleanPipStyle(full)).toEqual(full);
  });
  test("never corrects a value — the colour's case is kept", () => {
    expect(cleanPipStyle(style({ border: { widthPt: 2, color: "#FFffFF" } }))!.border!.color).toBe("#FFffFF");
  });
  test.each([
    ["not an object", 7],
    ["unknown shape", { ...DEFAULT_PIP_STYLE, shape: "hexagon" }],
    ["radius above 0.5", { ...DEFAULT_PIP_STYLE, cornerRadius: 0.6 }],
    ["width below min", { ...DEFAULT_PIP_STYLE, width: 0.01 }],
    ["width above max", { ...DEFAULT_PIP_STYLE, width: PIP_WIDTH_MAX + 0.01 }],
    ["centre off 0..1", { ...DEFAULT_PIP_STYLE, center: { x: 1.2, y: 0.5 } }],
    ["NaN centre", { ...DEFAULT_PIP_STYLE, center: { x: NaN, y: 0.5 } }],
    ["named colour", { ...DEFAULT_PIP_STYLE, border: { widthPt: 2, color: "white" } }],
    ["border too thick", { ...DEFAULT_PIP_STYLE, border: { widthPt: 13, color: "#ffffff" } }],
    ["zoom below 1", { ...DEFAULT_PIP_STYLE, framing: { x: 0.5, y: 0.5, zoom: 0.9 } }],
    ["zoom above max", { ...DEFAULT_PIP_STYLE, framing: { x: 0.5, y: 0.5, zoom: PIP_FRAMING_ZOOM_MAX + 0.1 } }],
    ["mirror not boolean", { ...DEFAULT_PIP_STYLE, mirror: "yes" }],
  ])("refuses: %s", (_name, v) => {
    expect(cleanPipStyle(v)).toBeNull();
  });
});

describe("pipRect", () => {
  const outputs = [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
    { width: 1080, height: 1920 }, { width: 1279, height: 721 }];
  const cams = [CAM, { width: 640, height: 480 }, { width: 1920, height: 1080 }];
  for (const output of outputs) for (const cam of cams) for (const shape of ["rect", "square", "circle"] as const) {
    test(`integer and inside the frame — ${output.width}x${output.height}, cam ${cam.width}x${cam.height}, ${shape}`, () => {
      for (const cx of [0, 0.01, 0.5, 0.99, 1]) for (const cy of [0, 0.5, 1]) {
        const r = pipRect(style({ shape, width: 0.3, center: { x: cx, y: cy } }), output, cam);
        for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isInteger(v)).toBe(true);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(output.width);
        expect(r.y + r.height).toBeLessThanOrEqual(output.height);
      }
    });
  }
  test("square and circle are 1:1; rect follows the camera aspect", () => {
    const out = { width: 1920, height: 1080 };
    expect(pipSize(style({ shape: "circle", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 384 });
    expect(pipSize(style({ shape: "square", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 384 });
    expect(pipSize(style({ shape: "rect", width: 0.2 }), out, CAM)).toEqual({ width: 384, height: 216 });
  });
});

describe("styleFromFixedCorner — the first edit must not make the PiP jump", () => {
  for (const output of [{ width: 640, height: 360 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1279, height: 719 }])
    for (const cam of [CAM, { width: 640, height: 480 }, { width: 1080, height: 1920 }]) {
      test(`${output.width}x${output.height}, cam ${cam.width}x${cam.height}`, () => {
        const fixed = roundRect(uvRectToPixels(fixedCornerPipUv(DEFAULT_PIP, output, cam), outputRect(output)));
        expect(pipRect(styleFromFixedCorner(DEFAULT_PIP, output, cam), output, cam)).toEqual(fixed);
      });
    }
});

describe("framingSource", () => {
  test("absent framing = the largest crop of the shape's aspect, centred", () => {
    expect(framingSource(style({ shape: "rect" }), CAM)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(framingSource(style({ shape: "circle" }), CAM)).toEqual({ x: 280, y: 0, width: 720, height: 720 });
  });
  test("zoom 2 halves the crop around the framing centre", () => {
    expect(framingSource(style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } }), CAM))
      .toEqual({ x: 460, y: 180, width: 360, height: 360 });
  });
  test("a centre at the edge is clamped inside the camera frame", () => {
    const s = framingSource(style({ shape: "circle", framing: { x: 1, y: 0, zoom: 1 } }), CAM);
    expect(s).toEqual({ x: 560, y: 0, width: 720, height: 720 });
  });
  test("switching rect -> circle after reframing keeps the crop inside the camera (Review Focus 3)", () => {
    const f = { x: 0.05, y: 0.5, zoom: 1.2 };
    for (const shape of ["rect", "square", "circle"] as const) {
      const s = framingSource(style({ shape, framing: f }), CAM);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(CAM.width + 1e-9);
      expect(s.y + s.height).toBeLessThanOrEqual(CAM.height + 1e-9);
    }
  });
  test("clampFraming stores the same clamp the render applies", () => {
    const f = clampFraming({ x: 1, y: 0, zoom: 1 }, "circle", CAM);
    expect(framingSource(style({ shape: "circle", framing: f }), CAM))
      .toEqual(framingSource(style({ shape: "circle", framing: { x: 1, y: 0, zoom: 1 } }), CAM));
    expect(f.x).toBeCloseTo((560 + 360) / 1280, 12);
    expect(f.y).toBeCloseTo(0.5, 12);
  });
});

describe("defaults", () => {
  test("DEFAULT_PIP is the one fixed-corner value", () => {
    expect(DEFAULT_PIP).toEqual(DEFAULT_PIP_FIXED);
  });
  test("isDefaultPipStyle / pipStylesEqual", () => {
    expect(isDefaultPipStyle({ ...DEFAULT_PIP_STYLE, center: { ...DEFAULT_PIP_STYLE.center } })).toBe(true);
    expect(isDefaultPipStyle(style({ shadow: true }))).toBe(false);
    expect(pipStylesEqual(style({ framing: DEFAULT_FRAMING }), style({ framing: { ...DEFAULT_FRAMING } }))).toBe(true);
    expect(pipStylesEqual(style({ border: { widthPt: 2, color: "#ffffff" } }), style({ border: null }))).toBe(false);
  });
});
