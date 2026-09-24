import { describe, test, expect } from "vitest";
import { mintCaptureId, isCaptureId, CAPTURE_ID_LENGTH } from "../src/capture-id.js";

describe("capture id", () => {
  test("a minted id validates and is the declared length", () => {
    const id = mintCaptureId();
    expect(isCaptureId(id)).toBe(true);
    expect(id).toHaveLength(CAPTURE_ID_LENGTH);
    expect(id.startsWith("cap_")).toBe(true);
  });

  test("two mints differ", () => {
    expect(mintCaptureId()).not.toBe(mintCaptureId());
  });

  test("the alphabet excludes the ambiguous Crockford letters", () => {
    // 200 mints is enough to see any of I/L/O/U if they were reachable.
    const body = Array.from({ length: 200 }, () => mintCaptureId().slice(4)).join("");
    expect(body).not.toMatch(/[ILOU]/);
    expect(body).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  test("refuses everything that is not an id", () => {
    for (const bad of [
      "", "cap_", "nope", 42, null, undefined, {},
      "cap_" + "A".repeat(25),            // too short
      "cap_" + "A".repeat(27),            // too long
      "CAP_" + "A".repeat(26),            // wrong prefix case
      "cap_" + "a".repeat(26),            // lowercase body
      "cap_" + "I".repeat(26),            // excluded letter
    ]) {
      expect(isCaptureId(bad as unknown)).toBe(false);
    }
  });
});
