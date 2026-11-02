import { describe, test, expect } from "vitest";
import { LOOKS, lookWrite, wallpaperLookWrite } from "@transform/backgrounds.js";
import {
  captureLook, isRememberedBackground, wantsWallpaper, WINDOW_SHOT_LOOKS,
} from "../src/window-look.js";

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
    const r = captureLook("wallpaper", null, { file: "wallpaper.png" });
    expect(r.write).toEqual(wallpaperLookWrite("wallpaper.png"));
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
  });
});
