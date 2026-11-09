import { describe, test, expect } from "vitest";
import { LOOKS, lookWrite, wallpaperLookWrite } from "@transform/backgrounds.js";
import {
  captureLook, displayOfWindow, isRememberedBackground, presentFlags, recordingLook, wantsWallpaper,
  WALLPAPER_TAKE_NOTICE, WINDOW_SHOT_LOOKS,
} from "../src/window-look.js";
import { framingProblem, wallpaperFraming } from "@transform/framing.js";
import { DARK_SHADOW_OPACITY, LOOK_FILLS } from "@transform/looks.js";

const byId = (id: string) => LOOKS.find((l) => l.id === id)!;
const clean = lookWrite(byId("clean"));

describe("captureLook (STC-628)", () => {
  test("window-only and window-shadow give their own look", () => {
    expect(captureLook("window-only", null, undefined).write).toEqual(lookWrite(byId("window-only")));
    expect(captureLook("window-shadow", null, undefined).write).toEqual(lookWrite(byId("window-shadow")));
  });
  test("background gives the remembered look, else Clean", () => {
    const dark = lookWrite(byId("dark"));
    expect(captureLook("background", dark, undefined).write).toEqual(dark);
    expect(captureLook("background", null, undefined).write).toEqual(clean);
  });
  test("wallpaper with a file gives the wallpaper look, no notice", () => {
    const r = captureLook("wallpaper", null, { file: "wallpaper.jpg" });
    expect(r.write).toEqual(wallpaperLookWrite("wallpaper.jpg"));
    expect(r.notice).toBeUndefined();
  });
  test("wallpaper that failed or is missing falls back to Clean with a notice", () => {
    for (const w of [{ error: "nope" }, undefined]) {
      const r = captureLook("wallpaper", lookWrite(byId("dark")), w);
      expect(r.write).toEqual(clean);
      expect(r.notice).toBe("Couldn't read your wallpaper, so this shot uses Clean.");
    }
  });
  test("wantsWallpaper is true only for wallpaper", () => {
    expect(WINDOW_SHOT_LOOKS.filter((l) => wantsWallpaper(l.value)).map((l) => l.value)).toEqual(["wallpaper"]);
  });
  test("labels", () => {
    expect(WINDOW_SHOT_LOOKS.map((l) => l.label)).toEqual(
      ["Just the window", "Window with shadow", "Capture background", "Desktop wallpaper"]);
  });
});

describe("isRememberedBackground", () => {
  test("Capture backgrounds count; plain windows and the wallpaper do not", () => {
    expect(isRememberedBackground(clean)).toBe(true);
    expect(isRememberedBackground(lookWrite(byId("dark")))).toBe(true);
    expect(isRememberedBackground(lookWrite(byId("aurora")))).toBe(true);
    expect(isRememberedBackground(lookWrite(byId("window-only")))).toBe(false);
    expect(isRememberedBackground(lookWrite(byId("window-shadow")))).toBe(false);
    expect(isRememberedBackground(wallpaperLookWrite("w.png"))).toBe(false);
    expect(isRememberedBackground({ ...clean, background: { kind: "image", file: "i.png", colors: ["#000000"] } } as typeof clean)).toBe(false);
  });
});

describe("presentFlags (STC-628)", () => {
  const NOTICE = "Couldn't read your wallpaper, so this shot uses Clean.";
  test("the panel preference is kept when there is nothing to say", () => {
    expect(presentFlags("panel")).toEqual({ silent: false, copy: false });
    expect(presentFlags("clipboard")).toEqual({ silent: true, copy: false });
  });
  test("a notice shows the panel, and clipboard mode still copies", () => {
    expect(presentFlags("panel", NOTICE)).toEqual({ silent: false, copy: false });
    expect(presentFlags("clipboard", NOTICE)).toEqual({ silent: false, copy: true });
  });
});

describe("recordingLook (STC-626)", () => {
  const fill = (id: "clean" | "dark" | "aurora") => (LOOK_FILLS[id] as { colors: readonly string[] }).colors;

  test("Just the window is no framing at all", () => {
    expect(recordingLook("window-only", null, undefined)).toEqual({});
  });
  test("Window with shadow is plain white with the preset's padding, corners and shadow", () => {
    expect(recordingLook("window-shadow", null, undefined).framing).toEqual({
      preset: "clean", background: { kind: "solid", color: "#ffffff" },
    });
  });
  test("Capture background with nothing remembered is Clean", () => {
    const b = recordingLook("background", null, undefined).framing!.background as { colors: string[] };
    expect(b.colors).toEqual(fill("clean"));
  });
  test("a remembered Clean, which stores no background, is Clean", () => {
    const b = recordingLook("background", clean, undefined).framing!.background as { colors: string[] };
    expect(b.colors).toEqual(fill("clean"));
  });
  test("a remembered Dark keeps its deeper shadow", () => {
    const f = recordingLook("background", lookWrite(byId("dark")), undefined).framing!;
    expect((f.background as { colors: string[] }).colors).toEqual(fill("dark"));
    expect(f.shadow?.opacity).toBe(DARK_SHADOW_OPACITY);
  });
  test("a remembered three-stop look comes across", () => {
    const f = recordingLook("background", lookWrite(byId("aurora")), undefined).framing!;
    expect((f.background as { colors: string[] }).colors).toEqual(fill("aurora"));
  });
  test("a remembered Custom keeps its colours and angle", () => {
    const write = lookWrite(byId("custom"), { kind: "linear", colors: ["#112233", "#445566"], angleDeg: 135 });
    expect(recordingLook("background", write, undefined).framing!.background)
      .toEqual({ kind: "linear", colors: ["#112233", "#445566"], angleDeg: 135 });
  });
  test.each([
    ["radial", { kind: "radial", colors: ["#111111", "#222222"] }],
    ["mesh", { kind: "mesh", colors: ["#111111", "#222222", "#333333"], seed: 1, sheen: 0, warp: 0, scale: 1, grain: false, points: null, t: 0 }],
  ])("a remembered %s, which video cannot draw, is Clean", (_n, background) => {
    const write = lookWrite(byId("custom"), background as any);
    const b = recordingLook("background", write, undefined).framing!.background as { colors: string[] };
    expect(b.colors).toEqual(fill("clean"));
  });
  test("every look it produces is one the write gate accepts", () => {
    for (const look of WINDOW_SHOT_LOOKS) {
      const { framing } = recordingLook(look.value, lookWrite(byId("ember")), { file: "wallpaper.jpg" });
      if (framing) expect(framingProblem(framing)).toBeUndefined();
    }
  });
  test("Desktop wallpaper with a file draws it, with no notice", () => {
    const r = recordingLook("wallpaper", null, { file: "wallpaper.jpg" });
    expect(r.framing).toEqual({ preset: "clean", background: wallpaperFraming() });
    expect(r.notice).toBeUndefined();
  });
  test("Desktop wallpaper that could not be read is Clean, and says so", () => {
    for (const w of [{ error: "nope" }, undefined]) {
      const r = recordingLook("wallpaper", lookWrite(byId("dark")), w);
      expect((r.framing!.background as { colors: string[] }).colors).toEqual(fill("clean"));
      expect(r.notice).toBe(WALLPAPER_TAKE_NOTICE);
    }
    expect(WALLPAPER_TAKE_NOTICE).toBe("Couldn't read your wallpaper, so this take uses Clean.");
  });
});

describe("displayOfWindow (STC-626)", () => {
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
    { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 } },
  ];
  test("the display holding the window's midpoint", () => {
    expect(displayOfWindow({ x: 1100, y: 100, width: 200, height: 200 }, displays)).toBe(2);
  });
  test("a window spanning two goes by its midpoint", () => {
    expect(displayOfWindow({ x: 900, y: 100, width: 400, height: 200 }, displays)).toBe(2);
  });
  test("a midpoint on no display falls to the first, the helper's own rule", () => {
    expect(displayOfWindow({ x: 5000, y: 5000, width: 10, height: 10 }, displays)).toBe(1);
  });
  test("no displays at all is no answer", () => {
    expect(displayOfWindow({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeUndefined();
  });
});
