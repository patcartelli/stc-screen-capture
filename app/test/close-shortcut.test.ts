import { describe, test, expect } from "vitest";
import { isCloseKey } from "../src/close-shortcut.js";

const k = (o: Partial<Parameters<typeof isCloseKey>[0]> = {}) =>
  ({ type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false, ...o });

describe("isCloseKey (STC-552)", () => {
  test("⌘W is the close key, either case", () => {
    expect(isCloseKey(k())).toBe(true);
    expect(isCloseKey(k({ key: "W" }))).toBe(true);
  });
  test("anything else is not", () => {
    for (const o of [{ meta: false }, { shift: true }, { alt: true }, { control: true }, { key: "q" }, { type: "keyUp" }])
      expect(isCloseKey(k(o)), JSON.stringify(o)).toBe(false);
  });
});
