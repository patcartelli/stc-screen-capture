import { describe, test, expect } from "vitest";
import {
  MESSAGE_TOAST_MAX_MS, MESSAGE_TOAST_MIN_MS, MESSAGE_TOAST_PER_CHAR_MS,
  MESSAGE_TOAST_SIZE, UNDO_TOAST_SIZE, messageToastMs,
} from "../src/toast.js";

/**
 * The toast's pure decisions (STC-412 final review, C1).
 *
 * `toast.ts` exists precisely so these can be checked with no Electron: the
 * defect it was split out to fix was the message mode silently inheriting the
 * undo toast's one size and one fixed duration, and "silently" is the word —
 * every e2e assertion in this suite reads `textContent`, which is blind to
 * CSS clipping, so the whole thing stayed green over a warning showing a
 * fifth of itself for four seconds.
 *
 * The other half of the fix is measured where it can only be measured, in a
 * real renderer: `warnings.e2e.test.ts` puts the longest real message on
 * screen and asserts the text is not taller than the box holding it.
 */
describe("the message toast's own clock", () => {
  test("a short notice gets the floor, not less", () => {
    expect(messageToastMs("")).toBe(MESSAGE_TOAST_MIN_MS);
    expect(messageToastMs("Copied")).toBeGreaterThanOrEqual(MESSAGE_TOAST_MIN_MS);
  });

  test("a longer message gets longer, in proportion to its own length", () => {
    const short = messageToastMs("x".repeat(20));
    const longer = messageToastMs("x".repeat(120));
    expect(longer).toBeGreaterThan(short);
    expect(longer - short).toBe(100 * MESSAGE_TOAST_PER_CHAR_MS);
  });

  test("and is capped, because this window floats over a live take", () => {
    // 20,000 characters is not a real message; the point is that there is no
    // input at all for which this window outstays MESSAGE_TOAST_MAX_MS.
    expect(messageToastMs("x".repeat(20_000))).toBe(MESSAGE_TOAST_MAX_MS);
  });

  test("the cap covers every RECORDING_FAULTS/CAMERA_FAULTS-sized message in full", () => {
    // The longest of those is `camera-no-frames`, ~190 characters. Only the
    // `event-tap-unavailable` REFUSAL (572, and the one message that can only
    // fire when nothing is recording) is deliberately clamped — see
    // MESSAGE_TOAST_MAX_MS's own comment.
    expect(messageToastMs("x".repeat(250))).toBeLessThan(MESSAGE_TOAST_MAX_MS);
  });

  test("the real one still asks for more than the floor — the bug this fixes", () => {
    // The `event-tap-unavailable` refusal's real length (refusals.ts). At the
    // flat 4 s this replaced, a reader got the floor for a message that wants
    // eight times it; the assertion is simply that length now MATTERS.
    expect(messageToastMs("x".repeat(572))).toBe(MESSAGE_TOAST_MAX_MS);
    expect(messageToastMs("x".repeat(572))).toBeGreaterThan(MESSAGE_TOAST_MIN_MS);
  });
});

describe("the two modes are sized apart", () => {
  test("the undo toast is unchanged — 240x68, the notice it has always been", () => {
    expect(UNDO_TOAST_SIZE).toEqual({ width: 240, height: 68 });
  });

  test("the message toast is bigger in BOTH dimensions", () => {
    // Both, not just taller: a warning re-flowed into a 240px column is a
    // very tall thin paragraph, which is how the first version of this fix
    // could have "fitted" the text and still read as broken.
    expect(MESSAGE_TOAST_SIZE.width).toBeGreaterThan(UNDO_TOAST_SIZE.width);
    expect(MESSAGE_TOAST_SIZE.height).toBeGreaterThan(UNDO_TOAST_SIZE.height);
  });
});
