import { describe, test, expect } from "vitest";
import {
  cleanPipStyle, pipSize, pipRect, framingSource, clampFraming, styleFromFixedCorner,
  isDefaultPipStyle, pipStylesEqual, DEFAULT_PIP_STYLE, DEFAULT_PIP_FIXED, DEFAULT_FRAMING,
  PIP_WIDTH_MAX, PIP_FRAMING_ZOOM_MAX, type PipStyle,
  PIP_PRESETS, editPipStyle, snapCenter, resizeFromCorner, panFraming, zoomFraming,
  PIP_SNAP_MARGIN_PX, PIP_WIDTH_MIN, DEFAULT_BORDER, inspectorSide, inspectorLeftPx,
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
    { width: 1080, height: 1920 }, { width: 1279, height: 721 }, { width: 3840, height: 1080 }];
  const cams = [CAM, { width: 640, height: 480 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }];
  for (const output of outputs) for (const cam of cams) for (const shape of ["rect", "square", "circle"] as const) for (const w of [0.3, PIP_WIDTH_MAX]) {
    test(`integer and inside the frame — ${output.width}x${output.height}, cam ${cam.width}x${cam.height}, ${shape}, w ${w}`, () => {
      for (const cx of [0, 0.01, 0.5, 0.99, 1]) for (const cy of [0, 0.5, 1]) {
        const r = pipRect(style({ shape, width: w, center: { x: cx, y: cy } }), output, cam);
        for (const v of [r.x, r.y, r.width, r.height]) expect(Number.isInteger(v)).toBe(true);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(output.width);
        expect(r.y + r.height).toBeLessThanOrEqual(output.height);
      }
    });
  }
  test("a PiP taller than the output is capped to fit, keeping the camera aspect", () => {
    const sz = pipSize(style({ shape: "rect", width: PIP_WIDTH_MAX }), { width: 1920, height: 1080 }, { width: 1080, height: 1920 });
    expect(sz).toEqual({ width: Math.round(1080 * 1080 / 1920), height: 1080 });
  });
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
  test("DEFAULT_PIP_STYLE IS the fixed corner at the Settings mock's nominal 1920x1080 / 1280x720", () => {
    // Exact equality, not toBeCloseTo: isDefaultPipStyle compares with ===, so a
    // near miss would make an untouched Settings default seed every new take.
    expect(styleFromFixedCorner(DEFAULT_PIP_FIXED, { width: 1920, height: 1080 }, { width: 1280, height: 720 }))
      .toEqual(DEFAULT_PIP_STYLE);
    expect(isDefaultPipStyle(styleFromFixedCorner(DEFAULT_PIP_FIXED, { width: 1920, height: 1080 }, CAM))).toBe(true);
  });
  test("isDefaultPipStyle / pipStylesEqual", () => {
    expect(isDefaultPipStyle({ ...DEFAULT_PIP_STYLE, center: { ...DEFAULT_PIP_STYLE.center } })).toBe(true);
    expect(isDefaultPipStyle(style({ shadow: true }))).toBe(false);
    expect(pipStylesEqual(style({ framing: DEFAULT_FRAMING }), style({ framing: { ...DEFAULT_FRAMING } }))).toBe(true);
    expect(pipStylesEqual(style({ border: { widthPt: 2, color: "#ffffff" } }), style({ border: null }))).toBe(false);
  });
});

describe("presets", () => {
  test("every preset yields a valid style", () => {
    for (const p of PIP_PRESETS) {
      expect(cleanPipStyle(editPipStyle(DEFAULT_PIP_STYLE, { kind: "preset", name: p.name }, CAM))).not.toBeNull();
    }
  });
  test("a preset is a LOOK: position, framing and mirror survive it", () => {
    const placed = style({ center: { x: 0.2, y: 0.3 }, mirror: true, framing: { x: 0.4, y: 0.5, zoom: 1.5 } });
    const after = editPipStyle(placed, { kind: "preset", name: "circle" }, CAM);
    expect(after.shape).toBe("circle");
    expect(after.center).toEqual({ x: 0.2, y: 0.3 });
    expect(after.mirror).toBe(true);
    expect(after.framing).toEqual({ x: 0.4, y: 0.5, zoom: 1.5 });
  });
  test("names are unique", () => {
    expect(new Set(PIP_PRESETS.map((p) => p.name)).size).toBe(PIP_PRESETS.length);
  });
});

describe("editPipStyle clamps rather than producing an invalid style", () => {
  test.each([
    [{ kind: "size", value: 9 } as const, (s: PipStyle) => expect(s.width).toBe(PIP_WIDTH_MAX)],
    [{ kind: "size", value: 0 } as const, (s: PipStyle) => expect(s.width).toBe(PIP_WIDTH_MIN)],
    [{ kind: "radius", value: -1 } as const, (s: PipStyle) => expect(s.cornerRadius).toBe(0)],
    [{ kind: "move", center: { x: -0.5, y: 2 } } as const, (s: PipStyle) => expect(s.center).toEqual({ x: 0, y: 1 })],
    [{ kind: "borderWidth", pt: 99 } as const, (s: PipStyle) => expect(s.border!.widthPt).toBe(12)],
  ])("%j", (edit, check) => {
    const s = editPipStyle(style({ border: DEFAULT_BORDER }), edit, CAM);
    expect(cleanPipStyle(s)).not.toBeNull();
    check(s);
  });
  test("border on uses DEFAULT_BORDER; off is null; a bad colour is ignored", () => {
    const on = editPipStyle(DEFAULT_PIP_STYLE, { kind: "border", on: true }, CAM);
    expect(on.border).toEqual(DEFAULT_BORDER);
    expect(editPipStyle(on, { kind: "border", on: false }, CAM).border).toBeNull();
    expect(editPipStyle(on, { kind: "borderColor", color: "red" }, CAM).border!.color).toBe(DEFAULT_BORDER.color);
  });
  test("a framing edit is stored clamped", () => {
    const s = editPipStyle(style({ shape: "circle" }), { kind: "framing", framing: { x: 1, y: 0, zoom: 1 } }, CAM);
    expect(s.framing!.x).toBeCloseTo((560 + 360) / 1280, 12);
  });
});

describe("snapCenter — nine anchors, per axis", () => {
  const out = { width: 1920, height: 1080 };
  const size = { width: 384, height: 216 };
  const toPx = (c: { x: number; y: number }) => ({ x: c.x * out.width, y: c.y * out.height });
  test("near the bottom-right anchor snaps the PiP's edge onto the margin", () => {
    const anchorX = out.width - PIP_SNAP_MARGIN_PX - size.width / 2;
    const anchorY = out.height - PIP_SNAP_MARGIN_PX - size.height / 2;
    const c = snapCenter({ x: (anchorX - 10) / out.width, y: (anchorY + 9) / out.height }, size, out, 12);
    expect(toPx(c)).toEqual({ x: anchorX, y: anchorY });
    const r = pipRect(style({ width: 0.2, center: c }), out, CAM);
    expect(r.x + r.width).toBe(out.width - PIP_SNAP_MARGIN_PX);
    expect(r.y + r.height).toBe(out.height - PIP_SNAP_MARGIN_PX);
  });
  test("just outside the threshold does not snap", () => {
    const anchorX = PIP_SNAP_MARGIN_PX + size.width / 2;
    const c = snapCenter({ x: (anchorX + 13) / out.width, y: 0.37 }, size, out, 12);
    expect(toPx(c).x).toBeCloseTo(anchorX + 13, 9);
    expect(c.y).toBeCloseTo(0.37, 12);
  });
  test("dead centre is an anchor", () => {
    expect(toPx(snapCenter({ x: 0.503, y: 0.497 }, size, out, 12))).toEqual({ x: 960, y: 540 });
  });
});

describe("resizeFromCorner", () => {
  test("width is twice the pointer's distance from the centre, clamped", () => {
    const out = { width: 1000, height: 1000 };
    const s = style({ shape: "square", center: { x: 0.5, y: 0.5 } });
    expect(resizeFromCorner(s, { x: 650, y: 500 }, out, CAM).width).toBeCloseTo(0.3, 12);
    expect(resizeFromCorner(s, { x: 2000, y: 500 }, out, CAM).width).toBe(PIP_WIDTH_MAX);
    expect(resizeFromCorner(s, { x: 500, y: 500 }, out, CAM).width).toBe(PIP_WIDTH_MIN);
  });
});

describe("panFraming", () => {
  test("dragging the window right moves the framing centre right", () => {
    const s = style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(panFraming(s, { x: 64, y: 0 }, CAM).x).toBeCloseTo(0.55, 12);
  });
  test("mirrored: the same drag moves the crop the OTHER way in camera space (Review Focus 2)", () => {
    const s = style({ shape: "square", mirror: true, framing: { x: 0.5, y: 0.5, zoom: 2 } });
    expect(panFraming(s, { x: 64, y: 0 }, CAM).x).toBeCloseTo(0.45, 12);
  });
  test("clamped at the camera edge", () => {
    const s = style({ shape: "square", framing: { x: 0.5, y: 0.5, zoom: 2 } });
    const f = panFraming(s, { x: 5000, y: 0 }, CAM);
    expect(framingSource({ ...s, framing: f }, CAM).x + 360).toBeCloseTo(1280, 9);
  });
  test("zoomFraming clamps to 1..PIP_FRAMING_ZOOM_MAX and keeps the crop inside", () => {
    const s = style({ shape: "circle", framing: { x: 0.95, y: 0.5, zoom: 3 } });
    expect(zoomFraming(s, 0.2, CAM).zoom).toBe(1);
    expect(zoomFraming(s, 9, CAM).zoom).toBe(PIP_FRAMING_ZOOM_MAX);
    const f = zoomFraming(s, 1, CAM);
    const src = framingSource({ ...s, framing: f }, CAM);
    expect(src.x + src.width).toBeLessThanOrEqual(1280 + 1e-9);
  });
});

describe("inspectorSide — the panel opens away from the PiP", () => {
  test("a PiP in the right half puts the panel on the left, and vice versa", () => {
    expect(inspectorSide(style({ center: { x: 0.9, y: 0.9 } }))).toBe("left");
    expect(inspectorSide(style({ center: { x: 0.1, y: 0.1 } }))).toBe("right");
    expect(inspectorSide(style({ center: { x: 0.5, y: 0.5 } }))).toBe("right");
  });
  test("the default (fixed bottom-right corner) PiP opens it on the left", () => {
    const s = styleFromFixedCorner(DEFAULT_PIP, { width: 3840, height: 2160 }, CAM);
    expect(inspectorSide(s)).toBe("left");
  });
  test("left edge in screen px, gap in from the chosen stage edge", () => {
    const stage = { left: 10, right: 1010 };
    expect(inspectorLeftPx(stage, "left", 300, 12)).toBe(22);
    expect(inspectorLeftPx(stage, "right", 300, 12)).toBe(698);
  });
});
