import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  guidesShown, roundedRectPath, scrimFadeOutMs, windowDimPath, windowHolesPath, SCRIM_FADE_IN_MS, SCRIM_FADE_OUT_MS, type GuideInputs,
} from "../src/scrim.js";

const base: GuideInputs = {
  mode: "region", hasSelection: false, dragging: false, pressing: false, pointerInside: true,
};

describe("guide lines (STC-644)", () => {
  it("show in Area mode before the drag", () => {
    expect(guidesShown(base)).toBe(true);
  });
  it("never show in Window mode", () => {
    expect(guidesShown({ ...base, mode: "window" })).toBe(false);
  });
  it("go the moment a button is down, before the reducer answers", () => {
    expect(guidesShown({ ...base, pressing: true })).toBe(false);
  });
  it("stay gone while dragging and once a selection exists", () => {
    expect(guidesShown({ ...base, dragging: true })).toBe(false);
    expect(guidesShown({ ...base, hasSelection: true })).toBe(false);
  });
  it("show only on the display the pointer is over", () => {
    expect(guidesShown({ ...base, pointerInside: false })).toBe(false);
  });
});

describe("scrim fades (STC-644)", () => {
  it("main waits for the exit fade, and not at all under reduced motion", () => {
    expect(scrimFadeOutMs(false)).toBe(SCRIM_FADE_OUT_MS);
    expect(scrimFadeOutMs(true)).toBe(0);
  });
  it("out is shorter than in", () => {
    expect(SCRIM_FADE_OUT_MS).toBeLessThan(SCRIM_FADE_IN_MS);
  });
});

describe("overlay.html wiring (STC-644)", () => {
  const html = readFileSync(fileURLToPath(new URL("../renderer/overlay.html", import.meta.url)), "utf8");
  it("drops every fade under reduced motion", () => {
    const reduce = html.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/);
    expect(reduce, "a reduced-motion block").not.toBeNull();
    expect(reduce![1]).toMatch(/#dim[^{]*\{[^}]*transition: none/);
    expect(reduce![1]).toMatch(/body\.leaving[^{]*\{[^}]*transition: none/);
  });
  it("Window mode keeps the scrim token (Space changes the target, not the dim)", () => {
    expect(html).toMatch(/#wdim \.dim \{[^}]*fill: var\(--scrim\)/);
  });
  it("the marquee wears the paired edge", () => {
    expect(html).toMatch(/#marquee \{[^}]*box-shadow: inset 0 0 0 1px var\(--handle-edge\), 0 0 0 100000px var\(--scrim\)/);
  });
});

describe("window cutout (STC-644)", () => {
  const frame = { x: 100, y: 50, width: 400, height: 300 };
  it("a square rect is four lines and no arcs", () => {
    expect(roundedRectPath({ x: 0, y: 0, width: 10, height: 20 }, [0, 0, 0, 0])).toBe("M0 0H10V20H0V0Z");
  });
  it("a fully visible window is one hole, rounded at all four corners", () => {
    const d = windowHolesPath(frame, [frame], 10);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/A10 10/g)).toHaveLength(4);
  });
  it("a window cut by one in front keeps square corners on the cut", () => {
    // The right third is covered: the left piece meets the frame at its two
    // left corners only.
    const d = windowHolesPath(frame, [{ x: 100, y: 50, width: 250, height: 300 }], 10);
    expect(d).toBe("M110 50H350V350H110A10 10 0 0 1 100 340V60A10 10 0 0 1 110 50Z");
  });
  it("clamps a radius to half a sliver", () => {
    const d = roundedRectPath({ x: 0, y: 0, width: 4, height: 100 }, [10, 10, 10, 10]);
    expect(d).toContain("A2 2");
    expect(d).not.toContain("A10");
  });
  it("the dim is the viewport first, then the holes", () => {
    const d = windowDimPath({ x: 0, y: 0, width: 1000, height: 800 }, frame, [frame], 10);
    expect(d.startsWith("M0 0H1000V800H0V0Z")).toBe(true);
    expect(d.match(/M/g)).toHaveLength(2);
  });
});
