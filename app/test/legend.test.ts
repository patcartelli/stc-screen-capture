import { describe, test, expect } from "vitest";
import { legendItems } from "../src/legend.js";

const words = (mode: string, phase: "select" | "options" | undefined) =>
  legendItems(mode, phase).map((i) => [...i.keys, i.label].join(" "));

describe("legend (STC-598)", () => {
  test("window mode", () => {
    expect(words("window", "select")).toEqual(["Click select window", "Space region", "Esc cancel"]);
  });

  test("area mode", () => {
    expect(words("region", "select")).toEqual(["Drag region", "Space window", "Esc cancel"]);
    expect(words("region", undefined)).toEqual(words("region", "select"));
  });

  test("options phase says Click, never Return: Return only re-confirms the selection", () => {
    for (const mode of ["window", "region"]) {
      const text = words(mode, "options");
      expect(text).toEqual(["Adjust selection", "Click Capture Video", "Esc cancel"]);
      expect(text.join(" ")).not.toMatch(/return|↵/i);
    }
  });
});
