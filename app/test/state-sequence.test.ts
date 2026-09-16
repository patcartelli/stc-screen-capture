import { describe, test, expect } from "vitest";
import { occursBefore } from "./_state-sequence.js";

/**
 * STC-389's ordering claim, isolated from Playwright: given a recorded
 * sequence of an element's text values, did the device name appear before
 * the terminal "no frames" state replaced it? No timing, no polling — this
 * is the part of the fix that can be proven without a real window.
 */
describe("occursBefore (STC-389)", () => {
  test("true when the needle is followed later by the terminal state", () => {
    const seq = ["", "FaceTime HD Camera", "FaceTime HD Camera — no frames"];
    expect(occursBefore(seq, "FaceTime HD Camera", "no frames")).toBe(true);
  });

  // The mutation test the ticket names: a stand-in that never sends the
  // device-name event must fail the ordering assertion, not merely time out
  // waiting for a state that was never going to come.
  test("false when the terminal state appears but the needle never did", () => {
    const seq = ["", "no frames"];
    expect(occursBefore(seq, "FaceTime HD Camera", "no frames")).toBe(false);
  });

  test("false when the terminal state never appears — nothing to be before", () => {
    const seq = ["", "FaceTime HD Camera"];
    expect(occursBefore(seq, "FaceTime HD Camera", "no frames")).toBe(false);
  });

  test("false when the needle appears only after the terminal state", () => {
    const seq = ["", "no frames", "FaceTime HD Camera"];
    expect(occursBefore(seq, "FaceTime HD Camera", "no frames")).toBe(false);
  });

  test("matches by substring, the same way the E2E tests' textContent checks do", () => {
    const seq = ["", "Camera: FaceTime HD Camera", "Camera: FaceTime HD Camera (no frames)"];
    expect(occursBefore(seq, "FaceTime HD Camera", "no frames")).toBe(true);
  });
});
