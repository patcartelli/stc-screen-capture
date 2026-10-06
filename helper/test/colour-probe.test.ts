import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * STC-510: proves the colour probe itself runs, with no grant and no capture —
 * `recording-colour.grant.test.ts` is the only place it reads a real take.
 * `fixtures/basic/display.mp4` is generated untagged, so this also pins that an
 * untagged track is REPORTED as `none` rather than defaulted to a colour space
 * (the ticket's whole subject is a default nobody chose).
 */
const FIXTURE = join(__dirname, "..", "..", "fixtures", "basic", "display.mp4");

describe("colour probe (STC-510)", () => {
  test("reads the tags and two rect colours from a real mp4", async () => {
    const out = await runSwiftHarness({
      label: "colour-probe",
      sources: ["helper/test/colour-probe/main.swift"],
      args: [FIXTURE, "2.5", "10", "10", "100", "100", "300", "10", "100", "100"],
    });
    expect(out).toMatch(/TAG_PRIMARIES=none/);
    for (const k of ["RECT1_P3", "RECT2_P3"]) {
      const m = new RegExp(`${k}=([\\d.]+),([\\d.]+),([\\d.]+)`).exec(out);
      expect(m, out).not.toBeNull();
      for (const v of m!.slice(1)) expect(Number(v)).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
