import { describe, test, expect } from "vitest";
import { stillFrameNameAllowed } from "../src/still-frame-name.js";
import { WALLPAPER_FILE } from "../../transform/src/backgrounds.js";

/** STC-628: `still:frame` reads the frame PNGs and the wallpaper JPEG, and nothing else. */
describe("still:frame's file-name rule", () => {
  test("any plain png leaf, as before", () => {
    expect(stillFrameNameAllowed("frame.png")).toBe(true);
    expect(stillFrameNameAllowed("grab-2.png")).toBe(true);
  });

  test("exactly the wallpaper's name, which is a jpg", () => {
    expect(WALLPAPER_FILE).toBe("wallpaper.jpg");
    expect(stillFrameNameAllowed(WALLPAPER_FILE)).toBe(true);
  });

  test("no other jpg, and no other image type", () => {
    expect(stillFrameNameAllowed("frame.jpg")).toBe(false);
    expect(stillFrameNameAllowed("wallpaper.jpeg")).toBe(false);
    expect(stillFrameNameAllowed("Wallpaper.jpg")).toBe(false);
    expect(stillFrameNameAllowed("wallpaper.heic")).toBe(false);
  });

  test("never a path", () => {
    expect(stillFrameNameAllowed("../frame.png")).toBe(false);
    expect(stillFrameNameAllowed("x/frame.png")).toBe(false);
    expect(stillFrameNameAllowed("../wallpaper.jpg")).toBe(false);
    expect(stillFrameNameAllowed("..png")).toBe(false);
  });
});
