import { describe, test, expect } from "vitest";
import { holdFraming, restoreFraming, withHeldFraming, chosenFraming } from "../src/framing-hold.js";
import type { Project } from "@transform/types";

const proj = (framing?: any) => ({ version: 15, output: { width: 100, height: 50, fps: 60 }, ...(framing ? { framing } : {}) }) as unknown as Project;

describe("framing hold (STC-396)", () => {
  test("hold strips framing from the live project and restore puts it back", () => {
    const p = proj({ preset: "clean" });
    const h = holdFraming(p);
    expect(p.framing).toBeUndefined();
    expect(chosenFraming(p, h)).toEqual({ preset: "clean" });
    restoreFraming(p, h);
    expect(p.framing).toEqual({ preset: "clean" });
  });
  test("withHeldFraming writes a copy with the framing and leaves the live project stripped", () => {
    const p = proj({ preset: "solid", color: "#112233" });
    const h = holdFraming(p);
    expect(withHeldFraming(p, h).framing).toEqual({ preset: "solid", color: "#112233" });
    expect(p.framing).toBeUndefined();
  });
  test("no framing means no hold, and everything is a no-op", () => {
    const p = proj();
    const h = holdFraming(p);
    expect(h).toBeNull();
    expect(withHeldFraming(p, h)).toBe(p);
    restoreFraming(p, h);
    expect(p.framing).toBeUndefined();
  });
});
