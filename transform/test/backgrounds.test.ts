import { describe, test, expect } from "vitest";
import {
  LOOKS, customBackground, lookOf, lookWrite, applyLook, parseLookWrite, CUSTOM_START_COLOR,
} from "../src/backgrounds.js";
import { FRAMING_PRESETS, DEFAULT_SOLID_COLOR } from "../src/framing.js";
import { PRESET_BACKGROUND, PRESET_SHADOW, decorationForMode } from "../src/still-decorate.js";
import { parseShot, defaultDecoration, type Shot } from "../src/shot.js";

const windowShot = (decoration: Record<string, unknown> = {}): Shot => parseShot({
  version: 1, kind: "window", capturedAtNs: "1", timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160, backingScale: 2, originX: 0, originY: 0 },
  window: { id: 7, app: "Notes", title: "Draft", bounds: { x: 0, y: 0, width: 800, height: 600 } },
  frame: { file: "frame.png", width: 1600, height: 1200, alpha: true },
  decoration: { mode: "window-only", canvas: "natural", cursor: false, redactions: [], ...decoration },
});

const look = (id: string) => LOOKS.find((l) => l.id === id)!;

describe("the picker's looks come from video's presets (STC-599)", () => {
  test("clean is the mode default, and the mode default is video's clean", () => {
    const clean = FRAMING_PRESETS.clean.background;
    expect(look("clean").background).toBeUndefined();
    expect(clean.kind).toBe("linear");
    expect(PRESET_BACKGROUND).toEqual({
      kind: "linear", colors: clean.kind === "linear" ? clean.colors : [], angleDeg: 135,
    });
  });

  test("dark reads colours and shadow opacity from FRAMING_PRESETS", () => {
    const dark = FRAMING_PRESETS.dark.background;
    expect(dark.kind).toBe("linear");
    expect(look("dark").background).toEqual({
      kind: "linear", colors: dark.kind === "linear" ? dark.colors : [], angleDeg: 135,
    });
    expect(look("dark").shadow).toEqual({ ...PRESET_SHADOW, opacity: FRAMING_PRESETS.dark.shadow.opacity });
  });

  test("solid is video's default solid colour, with the preset shadow", () => {
    expect(look("solid").background).toEqual({ kind: "solid", colors: [DEFAULT_SOLID_COLOR] });
    expect(look("solid").shadow).toBeUndefined();
    // The two presets that leave the still's shadow alone must agree with it.
    expect(FRAMING_PRESETS.solid.shadow.opacity).toBe(PRESET_SHADOW.opacity);
    expect(FRAMING_PRESETS.clean.shadow.opacity).toBe(PRESET_SHADOW.opacity);
    expect(CUSTOM_START_COLOR).toBe(DEFAULT_SOLID_COLOR);
  });

  test("every look is a document parseShot accepts, on a window shot", () => {
    const custom = customBackground("#102030", "#405060");
    if (!custom.ok) throw new Error("setup");
    for (const l of LOOKS) {
      const shot = windowShot();
      const d = applyLook(shot.decoration, lookWrite(l, custom.background));
      expect(() => parseShot({ ...shot, decoration: d }), l.id).not.toThrow();
    }
  });
});

describe("lookOf recovers the swatch from what a document draws", () => {
  test.each(LOOKS.filter((l) => l.id !== "custom"))("$id round-trips", (l) => {
    const shot = windowShot();
    expect(lookOf(applyLook(shot.decoration, lookWrite(l)))).toBe(l.id);
  });

  test("an explicit preset background is still Clean", () => {
    const d = decorationForMode("window-shadow-background",
      { background: { ...PRESET_BACKGROUND }, shadow: { ...PRESET_SHADOW } });
    expect(lookOf(d)).toBe("clean");
  });

  test("a custom solid and a custom pair are Custom", () => {
    for (const [a, b] of [["#112233", undefined], ["#112233", "#445566"]] as const) {
      const c = customBackground(a, b);
      if (!c.ok) throw new Error("setup");
      const shot = windowShot();
      expect(lookOf(applyLook(shot.decoration, lookWrite(look("custom"), c.background)))).toBe("custom");
    }
  });

  test("a hand-edited radial selects nothing", () => {
    const shot = windowShot();
    const d = applyLook(shot.decoration, {
      mode: "window-shadow-custom-background",
      background: { kind: "radial", colors: ["#111111", "#222222"] },
      shadow: null,
    });
    expect(lookOf(d)).toBeUndefined();
  });

  test("a fresh window shot is Window only", () => {
    expect(lookOf(defaultDecoration("window"))).toBe("window-only");
  });
});

describe("choosing a look replaces the previous one's fields", () => {
  test("Clean after Dark drops Dark's explicit background and shadow", () => {
    const shot = windowShot();
    const dark = applyLook(shot.decoration, lookWrite(look("dark")));
    expect(dark.background).toBeDefined();
    const clean = applyLook(dark, lookWrite(look("clean")));
    expect(clean.background).toBeUndefined();
    expect(clean.shadow).toBeUndefined();
    expect(lookOf(clean)).toBe("clean");
  });

  test("Window only after a background drops it, rather than carrying it silently", () => {
    const shot = windowShot();
    const aurora = applyLook(shot.decoration, lookWrite(look("aurora")));
    const bare = applyLook(aurora, lookWrite(look("window-only")));
    expect(bare.background).toBeUndefined();
    expect(bare.mode).toBe("window-only");
  });

  test("redactions survive a look", () => {
    const shot = windowShot({ redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] });
    expect(applyLook(shot.decoration, lookWrite(look("ember"))).redactions).toHaveLength(1);
  });
});

describe("customBackground", () => {
  test("one colour is a solid, two are a 135 degree pair, lowercased", () => {
    expect(customBackground("#AABBCC")).toEqual({ ok: true, background: { kind: "solid", colors: ["#aabbcc"] } });
    expect(customBackground("#aabbcc", " #001122 ")).toEqual({
      ok: true, background: { kind: "linear", colors: ["#aabbcc", "#001122"], angleDeg: 135 },
    });
    expect(customBackground("#aabbcc", "")).toMatchObject({ ok: true });
  });

  test.each(["red", "#abc", "#12345", "#1234567", "#12345678", "aabbcc", ""])("refuses %j", (v) => {
    expect(customBackground(v).ok).toBe(false);
    expect(customBackground("#aabbcc", v === "" ? "x" : v).ok).toBe(false);
  });
});

describe("parseLookWrite is shape only", () => {
  test("accepts the three fields, refuses anything else", () => {
    expect(parseLookWrite({ mode: "window-shadow", background: null, shadow: null }))
      .toEqual({ mode: "window-shadow", background: null, shadow: null });
    expect(() => parseLookWrite({ mode: "window-shadow", background: null, shadow: null, canvas: "1:1" })).toThrow(/unknown field/);
    expect(() => parseLookWrite({ mode: "window-shadow", background: [], shadow: null })).toThrow();
    expect(() => parseLookWrite({ mode: "window-shadow" })).toThrow();
    expect(() => parseLookWrite("x")).toThrow();
  });
});
