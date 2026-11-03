import { describe, test, expect } from "vitest";
import { LOOK_FILLS, LINEAR_STOPS_MIN, LINEAR_STOPS_MAX } from "../src/looks.js";

const HEX = /^#[0-9a-f]{6}$/i;

describe("looks catalogue", () => {
  test("every fill is #rrggbb and every linear has 2-8 stops", () => {
    for (const fill of Object.values(LOOK_FILLS)) {
      if (fill.kind === "solid") expect(fill.color).toMatch(HEX);
      else {
        expect(fill.colors.length).toBeGreaterThanOrEqual(LINEAR_STOPS_MIN);
        expect(fill.colors.length).toBeLessThanOrEqual(LINEAR_STOPS_MAX);
        for (const c of fill.colors) expect(c).toMatch(HEX);
      }
    }
  });

  test("aurora and ember are three-stop", () => {
    expect(LOOK_FILLS.aurora).toEqual({ kind: "linear", colors: ["#050a12", "#0d4a52", "#5b3fd1"], angleDeg: 135 });
    expect(LOOK_FILLS.ember).toEqual({ kind: "linear", colors: ["#12061a", "#7a1f5c", "#ff7a3d"], angleDeg: 160 });
  });
});
