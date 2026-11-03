// The swatch grid's pure halves (STC-608). The DOM half is covered by the still
// editor's e2e (window-shot-look.e2e.test.ts) and Task 6's video e2e.
import { describe, expect, it } from "vitest";
import { cssFill, nextSwatchIndex } from "../src/look-grid.js";

describe("nextSwatchIndex", () => {
  it("wraps at both ends for the arrow keys", () => {
    expect(nextSwatchIndex("ArrowRight", 6, 7)).toBe(0);
    expect(nextSwatchIndex("ArrowDown", 6, 7)).toBe(0);
    expect(nextSwatchIndex("ArrowLeft", 0, 7)).toBe(6);
    expect(nextSwatchIndex("ArrowUp", 0, 7)).toBe(6);
    expect(nextSwatchIndex("ArrowRight", 2, 7)).toBe(3);
  });
  it("sends Home and End to the ends", () => {
    expect(nextSwatchIndex("Home", 4, 7)).toBe(0);
    expect(nextSwatchIndex("End", 1, 7)).toBe(6);
  });
  it("leaves every other key alone", () => {
    expect(nextSwatchIndex("a", 1, 7)).toBeUndefined();
    expect(nextSwatchIndex("Enter", 1, 7)).toBeUndefined();
  });
});

describe("cssFill", () => {
  it("draws a linear fill with every stop", () => {
    expect(cssFill({ kind: "linear", colors: ["#111111", "#222222", "#333333"], angleDeg: 135 }))
      .toBe("linear-gradient(135deg, #111111, #222222, #333333)");
  });
  it("defaults a linear angle to 180", () => {
    expect(cssFill({ kind: "linear", colors: ["#111111", "#222222"] })).toBe("linear-gradient(180deg, #111111, #222222)");
  });
  it("draws a radial fill", () => {
    expect(cssFill({ kind: "radial", colors: ["#111111", "#222222"] })).toBe("radial-gradient(circle, #111111, #222222)");
  });
  it("gives a solid's colour in either shape", () => {
    expect(cssFill({ kind: "solid", color: "#3b4252" })).toBe("#3b4252");
    expect(cssFill({ kind: "solid", colors: ["#3b4252"] })).toBe("#3b4252");
    expect(cssFill({ kind: "linear", colors: ["#3b4252"] })).toBe("#3b4252");
  });
  it("gives nothing for no fill", () => {
    expect(cssFill(undefined)).toBe("");
    expect(cssFill({ kind: "linear", colors: [] })).toBe("");
  });
});
