import { describe, expect, test } from "vitest";
import {
  framingPadding, framingRadius, framingShadowOn, withPadding, withRadius, withShadow, radiusPx,
  backgroundOf, VIDEO_LOOKS, withLook, withCustom, customFraming, videoLookOf,
} from "../src/framing-edit.js";
import { videoLooksFor } from "../src/window-look.js";
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

describe("backgroundOf: the fill a framing draws (what Custom's fields show)", () => {
  test("an explicit background wins; else Solid's colour; else the preset's gradient", () => {
    expect(backgroundOf({ preset: "clean" })).toEqual(FRAMING_PRESETS.clean.background);
    expect(backgroundOf({ preset: "dark" })).toEqual(FRAMING_PRESETS.dark.background);
    expect(backgroundOf({ preset: "solid" })).toEqual({ kind: "solid", color: DEFAULT_SOLID_COLOR });
    expect(backgroundOf({ preset: "solid", color: "#112233" })).toEqual({ kind: "solid", color: "#112233" });
    const own = { kind: "solid", color: "#000000" } as const;
    expect(backgroundOf({ preset: "solid", color: "#112233", background: own })).toEqual(own);
  });
});

describe("video looks (STC-608)", () => {
  const ids = ["none", "clean", "dark", "solid", "aurora", "ember"] as const;
  const made: (Framing | undefined)[] = [];
  const keep = (f: Framing | undefined): Framing | undefined => { made.push(f); return f; };

  test("each look round-trips through videoLookOf", () => {
    for (const id of ids) expect(videoLookOf(keep(withLook(undefined, id)))).toBe(id);
  });
  test("the picker lists None first, then the stills' looks by their own labels", () => {
    expect(VIDEO_LOOKS.map((l) => l.label)).toEqual(["None", "Clean", "Dark", "Solid", "Aurora", "Ember", "Custom"]);
  });
  test("aurora writes its three stops explicitly with preset clean", () => {
    const f = keep(withLook(undefined, "aurora"))!;
    expect(f.preset).toBe("clean");
    expect(f.background).toEqual({ kind: "linear", colors: ["#050a12", "#0d4a52", "#5b3fd1"], angleDeg: 135 });
    expect(f.color).toBeUndefined();
  });
  test("solid drops a stale colour and writes the fill", () => {
    const f = keep(withLook({ preset: "solid", color: "#112233" }, "solid"))!;
    expect(f).toEqual({ preset: "solid", background: { kind: "solid", color: "#3b4252" } });
  });
  test("dark writes its shadow; leaving dark drops it", () => {
    const dark = keep(withLook(undefined, "dark"))!;
    expect(dark.shadow).toEqual(FRAMING_PRESETS.dark.shadow);
    expect(keep(withLook(dark, "aurora"))!.shadow).toBeUndefined();
  });
  test("shadow off survives every look", () => {
    const off = withShadow(withLook(undefined, "dark")!, false);
    const next = keep(withLook(off, "aurora"))!;
    expect(framingShadowOn(next)).toBe(false);
    expect(next.preset).toBe("clean");
    expect(videoLookOf(next)).toBe("aurora");
    // Back on, it is Aurora at the base strength, not Dark's 0.55.
    expect(videoLookOf(withShadow(next, true))).toBe("aurora");
  });
  test("dark with the shadow off still reads as dark", () => {
    expect(videoLookOf(keep(withShadow(withLook(undefined, "dark")!, false)))).toBe("dark");
  });
  test("padding and corners survive a look change", () => {
    const f = withRadius(withPadding(clean, 0.1), 0.03);
    expect(keep(withLook(f, "ember"))).toMatchObject({ paddingPct: 0.1, radiusPct: 0.03 });
  });
  test("pre-change documents", () => {
    expect(videoLookOf(keep({ preset: "dark" }))).toBe("dark");
    expect(videoLookOf(keep({ preset: "solid", color: "#3b4252" }))).toBe("solid");
    expect(videoLookOf(keep({ preset: "solid", color: "#112233" }))).toBe("custom");
    expect(videoLookOf(keep({
      preset: "clean", background: { kind: "linear", colors: ["#112233", "#cfd6e0"], angleDeg: 135 },
    }))).toBe("custom");
  });
  test("a retuned three-stop fill selects nothing", () => {
    const f = withLook(undefined, "aurora")!;
    const bg = f.background!;
    if (bg.kind !== "linear") throw new Error("aurora is linear");
    expect(videoLookOf(keep({ ...f, background: { ...bg, colors: ["#050a12", "#0d4a53", "#5b3fd1"] } }))).toBeUndefined();
  });
  test("a look's fill under another look's shadow is custom, not that look", () => {
    const f = { ...withLook(undefined, "clean")!, shadow: { ...FRAMING_PRESETS.dark.shadow } };
    expect(videoLookOf(keep(f))).toBe("custom");
  });
  test("custom keeps the document's preset", () => {
    const f = keep(withCustom(withLook(undefined, "dark"), { kind: "solid", color: "#445566" }))!;
    expect(f.preset).toBe("dark");
    expect(f.shadow!.opacity).toBe(0.55);
    expect(videoLookOf(f)).toBe("custom");
  });
  test("custom on no framing starts from clean", () => {
    expect(keep(withCustom(undefined, { kind: "solid", color: "#445566" }))!.preset).toBe("clean");
  });
  test("customFraming", () => {
    expect(customFraming("#112233")).toEqual({ ok: true, background: { kind: "solid", color: "#112233" } });
    expect(customFraming("#112233", "#445566")).toEqual({
      ok: true, background: { kind: "linear", colors: ["#112233", "#445566"], angleDeg: 135 },
    });
    expect(customFraming("nope").ok).toBe(false);
    for (const r of [customFraming("#112233"), customFraming("#112233", "#445566")]) {
      if (r.ok) keep(withCustom(undefined, r.background));
    }
  });
  test("every result is a framing the loader accepts", () => {
    expect(made.length).toBeGreaterThan(10);
    for (const f of made) if (f) expect(framingProblem(f)).toBeUndefined();
  });
});

describe("a window take's looks (STC-626)", () => {
  const windowLooks = videoLooksFor("window");
  const WHITE = { preset: "clean", background: { kind: "solid", color: "#ffffff" } } as Framing;

  test("other scopes get exactly today's grid", () => {
    for (const scope of ["display", "region", undefined]) expect(videoLooksFor(scope)).toEqual(VIDEO_LOOKS);
  });

  test("a window take's grid, in order, with its own first label", () => {
    expect(windowLooks.map((l) => l.id)).toEqual(
      ["none", "window-shadow", "clean", "dark", "solid", "aurora", "ember", "wallpaper", "custom"]);
    expect(windowLooks[0]!.label).toBe("Just the window");
    expect(windowLooks[1]!.label).toBe("Window with shadow");
    expect(windowLooks[7]!.label).toBe("Wallpaper");
  });

  test("every look round-trips through the document", () => {
    for (const { id } of windowLooks) {
      if (id === "custom") continue;
      const f = withLook(undefined, id);
      expect(videoLookOf(f, windowLooks), id).toBe(id);
      if (f) expect(framingProblem(f), id).toBeUndefined();
    }
  });

  test("white reads as Window with shadow only where that look exists", () => {
    expect(videoLookOf(WHITE, windowLooks)).toBe("window-shadow");
    expect(videoLookOf(WHITE)).toBe("custom");
  });

  test("a wallpaper framing on a grid without the swatch selects nothing, and still draws", () => {
    const f = withLook(undefined, "wallpaper")!;
    expect(videoLookOf(f)).toBeUndefined();
    expect(backgroundOf(f).kind).toBe("wallpaper");
  });

  test("leaving wallpaper keeps padding and corners, and a shadow switched off stays off", () => {
    const f = withShadow(withRadius(withPadding(withLook(undefined, "wallpaper")!, 0.1), 0.05), false);
    const next = withLook(f, "clean")!;
    expect(framingPadding(next)).toBe(0.1);
    expect(framingRadius(next)).toBe(0.05);
    expect(framingShadowOn(next)).toBe(false);
    expect(videoLookOf(next, windowLooks)).toBe("clean");
  });

  test("Custom on wallpaper replaces it with the typed fill", () => {
    const f = withCustom(withLook(undefined, "wallpaper"), { kind: "solid", color: "#123456" });
    expect(videoLookOf(f, windowLooks)).toBe("custom");
  });
});
