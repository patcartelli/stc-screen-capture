import { describe, test, expect } from "vitest";
import { formatHex, copiedToast, pickOutcome, pickFailure } from "../src/color-pick.js";

/** STC-627: the hex and the "which space" decision, with no sampler. */
describe("formatHex", () => {
  test("rounds each channel to 8 bits, lower case, zero padded", () => {
    expect(formatHex({ r: 0, g: 0, b: 0 }).hex).toBe("#000000");
    expect(formatHex({ r: 1, g: 1, b: 1 }).hex).toBe("#ffffff");
    expect(formatHex({ r: 10 / 255, g: 171 / 255, b: 205 / 255 }).hex).toBe("#0aabcd");
    expect(formatHex({ r: 0.5, g: 0.5, b: 0.5 }).hex).toBe("#808080");
  });

  test("a color inside sRGB is not clamped, rounding noise included", () => {
    expect(formatHex({ r: 1.0000001, g: -0.0000001, b: 0.2 }).clamped).toBe(false);
  });

  test("a P3 color outside sRGB clamps to the nearest value and says so", () => {
    const out = formatHex({ r: 1.0918, g: -0.2267, b: -0.1501 });
    expect(out).toEqual({ hex: "#ff0000", clamped: true });
  });
});

describe("copiedToast", () => {
  test("carries the swatch and the value, and no space note in gamut", () => {
    const t = copiedToast({ r: 1, g: 0, b: 0 });
    expect(t.title).toBe("#ff0000");
    expect(t.swatch).toBe("#ff0000");
    expect(t.tone).toBe("success");
    expect(t.body).not.toMatch(/sRGB/);
  });

  test("names the space only when clamped", () => {
    expect(copiedToast({ r: 1.1, g: -0.2, b: 0 }).body).toMatch(/clamped to the nearest sRGB/);
  });
});

describe("pickOutcome", () => {
  test("a color is copied", () => {
    const o = pickOutcome({ r: 0, g: 1, b: 0 });
    expect(o.kind === "copied" && o.hex).toBe("#00ff00");
  });
  test("Esc is cancelled and shows nothing", () => {
    expect(pickOutcome({ cancelled: true })).toEqual({ kind: "cancelled" });
  });
  test("a reply with no color is a visible failure", () => {
    for (const bad of [undefined, {}, { r: 1, g: 1 }, { r: "1", g: 0, b: 0 }, { r: NaN, g: 0, b: 0 }]) {
      const o = pickOutcome(bad as Record<string, unknown> | undefined);
      expect(o.kind).toBe("failed");
    }
  });
  test("pickFailure keeps the detail", () => {
    expect(pickFailure("boom").toast.body).toBe("boom");
  });
});
