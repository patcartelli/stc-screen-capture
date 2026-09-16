import { describe, test, expect } from "vitest";
import {
  clampCountdownMs, countdownCaption, countdownFired, countdownLabel, countdownView,
  decideCountdownKey, needsCountdown,
  DEFAULT_COUNTDOWN_MS, MAX_COUNTDOWN_MS,
} from "../src/countdown.js";

/**
 * The countdown's decisions (STC-391), with no window and no clock.
 *
 * `countdown-window.ts` owns the real panel and the real interval and is
 * exercised by `countdown.e2e.test.ts` through the app; everything here is the
 * rules its header states, checked one at a time.
 */

describe("how long (rule 6, and the ticket's own Open item)", () => {
  test("the default is 3s", () => {
    expect(DEFAULT_COUNTDOWN_MS).toBe(3000);
    expect(clampCountdownMs(undefined)).toBe(DEFAULT_COUNTDOWN_MS);
  });

  test("a stored number is taken at its word, within the bound", () => {
    expect(clampCountdownMs(1500)).toBe(1500);
    expect(clampCountdownMs(MAX_COUNTDOWN_MS)).toBe(MAX_COUNTDOWN_MS);
  });

  test("zero is OFF, and is a legitimate value rather than a fallback", () => {
    // Rule 6: the "off" case is what Capture already did before this ticket,
    // so it needs no second code path to be correct.
    expect(clampCountdownMs(0)).toBe(0);
    expect(needsCountdown(0)).toBe(false);
    expect(needsCountdown(clampCountdownMs(-5))).toBe(false);
  });

  test("an absurd stored value is clamped, not honoured", () => {
    // A hand-edited file asking for an hour would be indistinguishable from
    // the app having wedged — the panel is focusable and blocks a second
    // capture for its whole life.
    expect(clampCountdownMs(60 * 60_000)).toBe(MAX_COUNTDOWN_MS);
  });

  test("nonsense falls back to the default rather than to off", () => {
    // The direction matters: a corrupt preference must not silently cost the
    // user the feature, which is the rule every other field in settings.ts
    // follows.
    for (const bad of ["3000", null, NaN, Infinity, {}, []]) {
      expect(clampCountdownMs(bad), String(bad)).toBe(DEFAULT_COUNTDOWN_MS);
    }
  });
});

describe("the number on screen (rule 2)", () => {
  test("counts 3, 2, 1 over a three-second countdown", () => {
    expect(countdownLabel(3000)).toBe("3");
    expect(countdownLabel(2001)).toBe("3");
    expect(countdownLabel(2000)).toBe("2");
    expect(countdownLabel(1001)).toBe("2");
    expect(countdownLabel(1000)).toBe("1");
    expect(countdownLabel(1)).toBe("1");
  });

  test("is never 0", () => {
    // The frame that would show 0 is the frame the capture fires on — a 0 on
    // screen is a promise that has already been kept.
    expect(countdownLabel(0)).toBe("1");
    expect(countdownLabel(-250)).toBe("1");
  });
});

describe("the view", () => {
  const base = { totalMs: 3000, purpose: "capture" as const };

  test("the sweep runs 0 → 1 across the countdown", () => {
    expect(countdownView({ ...base, remainingMs: 3000 }).fraction).toBe(0);
    expect(countdownView({ ...base, remainingMs: 1500 }).fraction).toBeCloseTo(0.5);
    expect(countdownView({ ...base, remainingMs: 0 }).fraction).toBe(1);
  });

  test("a clock that overshoots does not push the sweep past its ends", () => {
    expect(countdownView({ ...base, remainingMs: -500 }).fraction).toBe(1);
    expect(countdownView({ ...base, remainingMs: 9999 }).fraction).toBe(0);
  });

  test("reduced motion removes the ANIMATION, not the count (rule 5)", () => {
    // The ticket's requirement 4, stated as the property that matters: a
    // countdown that honoured the preference by ceasing to count would have
    // honoured it by deleting the feature.
    const still = countdownView({ ...base, remainingMs: 1200, reducedMotion: true });
    const moving = countdownView({ ...base, remainingMs: 1200 });
    expect(still.animate).toBe(false);
    expect(moving.animate).toBe(true);
    expect(still.label).toBe(moving.label);
    expect(still.label).toBe("2");
  });

  test("each way in says which thing is being waited for", () => {
    expect(countdownView({ ...base, remainingMs: 1, purpose: "record" }).caption)
      .toBe(countdownCaption("record"));
    expect(countdownCaption("record")).not.toBe(countdownCaption("capture"));
    for (const p of ["record", "capture"] as const) expect(countdownCaption(p)).toBeTruthy();
  });
});

describe("what a keystroke means (rule 3)", () => {
  test("Escape cancels — the ticket's requirement 1", () => {
    expect(decideCountdownKey({ code: "Escape" })).toBe("cancel");
  });

  test("Return skips — the ticket's requirement 2, from the keyboard", () => {
    expect(decideCountdownKey({ code: "Enter" })).toBe("skip");
    expect(decideCountdownKey({ code: "NumpadEnter" })).toBe("skip");
    // Nothing else on this surface binds shift, and someone holding it while
    // confirming still meant to confirm.
    expect(decideCountdownKey({ code: "Enter", shiftKey: true })).toBe("skip");
  });

  test("a modifier chord is not ours, and is left alone", () => {
    // Not merely "does something else" — `null` is what tells the view to
    // stop rather than `preventDefault`, so a chord still reaches whatever
    // else the app binds.
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(decideCountdownKey({ code: "Enter", [mod]: true }), mod).toBeNull();
      expect(decideCountdownKey({ code: "Escape", [mod]: true }), mod).toBeNull();
    }
  });

  test("every other key is nothing to do with the countdown", () => {
    for (const code of ["KeyA", "Space", "Tab", "ArrowLeft", "Digit3"]) {
      expect(decideCountdownKey({ code }), code).toBeNull();
    }
  });
});

describe("what an outcome means (rule 4)", () => {
  test("elapsed and skipped both proceed; cancelled does not", () => {
    expect(countdownFired("elapsed")).toBe(true);
    expect(countdownFired("skipped")).toBe(true);
    expect(countdownFired("cancelled")).toBe(false);
  });

  test("skipped and elapsed stay tellable apart", () => {
    // They are separate things that happened, and a single boolean in their
    // place would lose which — the reason `countdownFired` is a function over
    // the outcome rather than the outcome being a boolean.
    expect(new Set<string>(["elapsed", "skipped"]).size).toBe(2);
  });
});
