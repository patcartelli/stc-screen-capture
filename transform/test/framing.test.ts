import { describe, test, expect } from "vitest";
import {
  framingLayout, framingProblem, cleanFraming, gradientLine, contentFraction,
  FRAMING_PRESETS, FRAMING_PADDING_MAX, DEFAULT_SOLID_COLOR,
} from "../src/framing.js";

const OUT = { width: 1920, height: 1080 };
const ASPECT = 16 / 9;

describe("framingLayout", () => {
  test("no framing means no layout", () => {
    expect(framingLayout(undefined, OUT, ASPECT)).toBeUndefined();
  });

  test("clean on a matching-aspect output: padded, centred, whole pixels, inside the output", () => {
    const l = framingLayout({ preset: "clean" }, OUT, ASPECT)!;
    const pad = Math.round(1080 * FRAMING_PRESETS.clean.paddingPct);
    for (const n of [l.content.x, l.content.y, l.content.width, l.content.height]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(l.content.y).toBeGreaterThanOrEqual(pad);
    expect(l.content.x).toBeGreaterThanOrEqual(pad);
    expect(l.content.x + l.content.width).toBeLessThanOrEqual(OUT.width - pad);
    expect(l.content.y + l.content.height).toBeLessThanOrEqual(OUT.height - pad);
    expect(Math.abs(l.content.x * 2 + l.content.width - OUT.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.content.y * 2 + l.content.height - OUT.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(l.content.width / l.content.height - ASPECT)).toBeLessThan(0.01);
  });

  test("an output of a different aspect letterboxes the picture; it is never stretched", () => {
    const l = framingLayout({ preset: "clean" }, { width: 1000, height: 1000 }, ASPECT)!;
    expect(Math.abs(l.content.width / l.content.height - ASPECT)).toBeLessThan(0.01);
    expect(l.content.width).toBeLessThan(1000);
    expect(l.content.height).toBeLessThan(l.content.width);
  });

  test("the shadow's reach never exceeds the padding, at any output size", () => {
    for (const out of [{ width: 320, height: 180 }, { width: 640, height: 360 },
                       { width: 1232, height: 693 }, { width: 3840, height: 2160 },
                       { width: 200, height: 200 }]) {
      const l = framingLayout({ preset: "clean" }, out, ASPECT)!;
      const short = Math.min(out.width, out.height);
      const pad = Math.min(Math.round(short * FRAMING_PRESETS.clean.paddingPct), Math.floor((short - 2) / 2));
      expect(l.shadow.blur * 1.5 + Math.abs(l.shadow.offsetY)).toBeLessThanOrEqual(pad + 1e-9);
    }
  });

  test("zero padding leaves no room for a shadow and fills the output", () => {
    const l = framingLayout({ preset: "clean", paddingPct: 0 }, OUT, ASPECT)!;
    expect(l.content).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(l.shadow.blur).toBe(0);
    expect(l.shadow.offsetY).toBe(0);
  });

  test("a tiny output keeps at least 2 px of picture on both axes", () => {
    for (const out of [{ width: 4, height: 4 }, { width: 8, height: 8 }, { width: 6, height: 4 }]) {
      const l = framingLayout({ preset: "clean", paddingPct: FRAMING_PADDING_MAX }, out, 1)!;
      expect(l.content.width).toBeGreaterThanOrEqual(2);
      expect(l.content.height).toBeGreaterThanOrEqual(2);
    }
  });

  test("the radius never exceeds half the picture's short side", () => {
    const l = framingLayout({ preset: "clean", radiusPct: 0.1 }, { width: 100, height: 100 }, 1)!;
    expect(l.radius).toBeLessThanOrEqual(Math.floor(Math.min(l.content.width, l.content.height) / 2));
  });

  test("the layout is proportional across output sizes (Embed vs capture size)", () => {
    const a = framingLayout({ preset: "clean" }, { width: 3840, height: 2160 }, ASPECT)!;
    const b = framingLayout({ preset: "clean" }, { width: 1232, height: 693 }, ASPECT)!;
    expect(Math.abs(a.content.width / 3840 - b.content.width / 1232)).toBeLessThan(0.01);
    expect(Math.abs(a.content.x / 3840 - b.content.x / 1232)).toBeLessThan(0.01);
  });

  test("explicit values beat the preset; solid takes its colour; dark differs from clean", () => {
    const wide = framingLayout({ preset: "clean", paddingPct: 0.1 }, OUT, ASPECT)!;
    const std = framingLayout({ preset: "clean" }, OUT, ASPECT)!;
    expect(wide.content.width).toBeLessThan(std.content.width);

    const bg = { kind: "solid", color: "#112233" } as const;
    expect(framingLayout({ preset: "clean", background: bg }, OUT, ASPECT)!.background).toEqual(bg);

    expect(framingLayout({ preset: "solid", color: "#aabbcc" }, OUT, ASPECT)!.background)
      .toEqual({ kind: "solid", color: "#aabbcc" });
    expect(framingLayout({ preset: "solid" }, OUT, ASPECT)!.background)
      .toEqual({ kind: "solid", color: DEFAULT_SOLID_COLOR });
    expect(framingLayout({ preset: "dark" }, OUT, ASPECT)!.background)
      .not.toEqual(framingLayout({ preset: "clean" }, OUT, ASPECT)!.background);
  });
});

describe("framingProblem / cleanFraming", () => {
  test("accepts each preset and a full set of overrides", () => {
    for (const preset of ["clean", "dark", "solid"]) expect(framingProblem({ preset })).toBeUndefined();
    expect(framingProblem({
      preset: "solid", color: "#0a0b0c", paddingPct: 0.1, radiusPct: 0.02,
      shadow: { offsetYPct: 0.01, blurPct: 0.03, opacity: 0.4 },
      background: { kind: "linear", colors: ["#000000", "#ffffff"], angleDeg: 90 },
    })).toBeUndefined();
  });

  test("refuses every malformed shape", () => {
    const bad: unknown[] = [
      null, 5, [], {}, { preset: "none" }, { preset: "clean", extra: 1 },
      { preset: "clean", color: "red" }, { preset: "clean", paddingPct: -0.1 },
      { preset: "clean", paddingPct: FRAMING_PADDING_MAX + 0.01 },
      { preset: "clean", paddingPct: "0.1" }, { preset: "clean", radiusPct: 0.5 },
      { preset: "clean", shadow: { offsetYPct: 0, blurPct: 0, opacity: 2 } },
      { preset: "clean", shadow: { offsetYPct: 0, blurPct: 0, opacity: 1, spread: 1 } },
      { preset: "clean", background: { kind: "radial" } },
      { preset: "clean", background: { kind: "solid", color: "#12" } },
      { preset: "clean", background: { kind: "linear", colors: ["#000000"], angleDeg: 0 } },
    ];
    for (const b of bad) expect(framingProblem(b), JSON.stringify(b)).toEqual(expect.any(String));
  });

  test("cleanFraming drops a bad block and keeps a good one", () => {
    expect(cleanFraming({ preset: "nope" })).toBeUndefined();
    expect(cleanFraming({ preset: "dark" })).toEqual({ preset: "dark" });
  });
});

describe("gradientLine", () => {
  test("90 degrees runs left to right through the centre", () => {
    const l = gradientLine(90, 200, 100);
    expect(l.x0).toBeCloseTo(0); expect(l.x1).toBeCloseTo(200);
    expect(l.y0).toBeCloseTo(50); expect(l.y1).toBeCloseTo(50);
  });
  test("135 degrees runs top-left to bottom-right, symmetric about the centre", () => {
    const l = gradientLine(135, 100, 100);
    expect(l.x0 + l.x1).toBeCloseTo(100); expect(l.y0 + l.y1).toBeCloseTo(100);
    expect(l.x1).toBeGreaterThan(l.x0); expect(l.y1).toBeGreaterThan(l.y0);
  });
});

describe("contentFraction", () => {
  test("1 with no framing, the picture's share of the width with it", () => {
    expect(contentFraction(undefined, OUT, ASPECT)).toBe(1);
    const f = contentFraction({ preset: "clean" }, OUT, ASPECT);
    expect(f).toBeGreaterThan(0.8);
    expect(f).toBeLessThan(1);
  });
});
