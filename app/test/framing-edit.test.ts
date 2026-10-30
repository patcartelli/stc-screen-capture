import { describe, expect, test } from "vitest";
import {
  framingPadding, framingRadius, framingShadowOn, withPadding, withRadius, withShadow, radiusPx,
  framingColor, withColor,
} from "../src/framing-edit.js";
import {
  DEFAULT_SOLID_COLOR, FRAMING_PADDING_MAX, FRAMING_PRESETS, FRAMING_RADIUS_MAX, framingProblem, type Framing,
} from "@transform/framing";

const clean: Framing = { preset: "clean" };

describe("the Frame section's Padding, Corners and Shadow (STC-604)", () => {
  test("with nothing set, each reads the preset's own value", () => {
    expect(framingPadding(clean)).toBe(FRAMING_PRESETS.clean.paddingPct);
    expect(framingRadius({ preset: "dark" })).toBe(FRAMING_PRESETS.dark.radiusPct);
    expect(framingShadowOn(clean)).toBe(true);
  });
  test("an explicit field wins over the preset's, and is clamped to framing.ts's bounds", () => {
    expect(framingPadding(withPadding(clean, 0.1))).toBe(0.1);
    expect(withPadding(clean, 9).paddingPct).toBe(FRAMING_PADDING_MAX);
    expect(withPadding(clean, -1).paddingPct).toBe(0);
    expect(withRadius(clean, 9).radiusPct).toBe(FRAMING_RADIUS_MAX);
    expect(framingRadius(withRadius(clean, 0.03))).toBe(0.03);
  });
  test("an edit never touches the preset, colour or background", () => {
    const solid: Framing = { preset: "solid", color: "#112233", background: { kind: "solid", color: "#445566" } };
    expect(withPadding(solid, 0.1)).toMatchObject({ preset: "solid", color: "#112233", background: solid.background });
    expect(withShadow(solid, false)).toMatchObject({ preset: "solid", color: "#112233" });
  });
  test("shadow off zeroes the opacity and keeps the shape; on goes back to the preset's", () => {
    const off = withShadow(clean, false);
    expect(framingShadowOn(off)).toBe(false);
    expect(off.shadow).toEqual({ ...FRAMING_PRESETS.clean.shadow, opacity: 0 });
    const on = withShadow(off, true);
    expect(framingShadowOn(on)).toBe(true);
    expect(on.shadow).toBeUndefined();
  });
  test("an explicit visible shadow is kept when switched on", () => {
    const own = { ...clean, shadow: { offsetYPct: 0.02, blurPct: 0.05, opacity: 0.6 } };
    expect(withShadow(own, true)).toBe(own);
  });
  test("a dark preset's own shadow reads on", () => {
    expect(framingShadowOn({ preset: "dark" })).toBe(true);
  });
  test("every result is a framing the loader accepts", () => {
    for (const f of [withPadding(clean, 0.2), withRadius(clean, 0.05), withShadow(clean, false),
      withShadow(withShadow(clean, false), true), withPadding(withRadius(withShadow(clean, false), 0.02), 0.01)]) {
      expect(framingProblem(f)).toBeUndefined();
    }
  });
  test("corners read in output pixels off the short edge", () => {
    expect(radiusPx(withRadius(clean, 0.0111), 1080)).toBe(12);
    expect(radiusPx(clean, 1000)).toBe(12);
  });
});

describe("the Colour row: one swatch for every style (STC-604)", () => {
  test("the swatch shows the gradient's first colour for Clean and Dark, the fill for Solid", () => {
    expect(framingColor({ preset: "clean" })).toBe("#e9edf2");
    expect(framingColor({ preset: "dark" })).toBe("#2a3040");
    expect(framingColor({ preset: "solid" })).toBe(DEFAULT_SOLID_COLOR);
    expect(framingColor({ preset: "solid", color: "#112233" })).toBe("#112233");
  });

  test("editing Clean writes an explicit gradient: new first colour, the preset's second colour and angle", () => {
    const out = withColor({ preset: "clean" }, "#112233");
    const bg = FRAMING_PRESETS.clean.background;
    expect(bg.kind).toBe("linear");
    expect(out.background).toEqual({
      kind: "linear", colors: ["#112233", bg.kind === "linear" ? bg.colors[1] : ""], angleDeg: bg.kind === "linear" ? bg.angleDeg : 0,
    });
    expect(out.preset).toBe("clean");
    expect(framingColor(out)).toBe("#112233");
  });

  test("editing again changes only the first colour of the gradient already written", () => {
    const once = withColor({ preset: "dark" }, "#aa0000");
    const twice = withColor(once, "#00aa00");
    const bg = twice.background!;
    expect(bg.kind === "linear" && bg.colors[0]).toBe("#00aa00");
    const preset = FRAMING_PRESETS.dark.background;
    expect(bg.kind === "linear" && preset.kind === "linear" && bg.colors[1]).toBe(preset.kind === "linear" ? preset.colors[1] : "");
  });

  test("Solid with no explicit background is written the way it always was: `color`", () => {
    expect(withColor({ preset: "solid" }, "#445566")).toEqual({ preset: "solid", color: "#445566" });
  });

  test("a solid background set on a gradient preset stays solid", () => {
    const f: Framing = { preset: "clean", background: { kind: "solid", color: "#000000" } };
    expect(withColor(f, "#ffffff").background).toEqual({ kind: "solid", color: "#ffffff" });
  });

  test("an edit keeps padding, corners and shadow, and every result is a framing the loader accepts", () => {
    const f = withShadow(withRadius(withPadding({ preset: "clean" }, 0.1), 0.03), false);
    const out = withColor(f, "#123456");
    expect(out).toMatchObject({ paddingPct: 0.1, radiusPct: 0.03 });
    expect(out.shadow).toEqual(f.shadow);
    for (const x of [out, withColor({ preset: "dark" }, "#abcdef"), withColor({ preset: "solid" }, "#010203")]) {
      expect(framingProblem(x)).toBeUndefined();
    }
  });
});
