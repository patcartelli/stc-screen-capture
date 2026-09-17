import { describe, test, expect } from "vitest";
import { nextPhase, fullDisplayFor } from "../src/overlay-session.js";
import type { Rect, SelectionOutcome } from "../src/selection.js";

const region: SelectionOutcome = {
  kind: "region", displayId: 1, crop: { x: 0, y: 0, width: 10, height: 10 },
  global: { x: 0, y: 0, width: 10, height: 10 },
};
const cancelled: SelectionOutcome = { kind: "cancelled" };

const displayRect: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const smallerRect: Rect = { x: 100, y: 100, width: 400, height: 300 };

describe("what an outcome means, per purpose (STC-388)", () => {
  test("a shot finishes on its outcome, exactly as before", () => {
    expect(nextPhase("shot", "select", region)).toEqual({ act: "finish", outcome: region });
  });

  test("a record holds its first outcome and shows the options bar", () => {
    expect(nextPhase("record", "select", region)).toEqual({ act: "options", outcome: region });
  });

  test("re-confirming in the options phase REPLACES the held outcome", () => {
    // The marquee stays live through the options phase, so Enter after an
    // adjustment must update what would be recorded — not start a take with
    // the rect the user has just moved away from.
    expect(nextPhase("record", "options", region)).toEqual({ act: "options", outcome: region });
  });

  test("cancelled always finishes, in either purpose and either phase", () => {
    for (const p of ["shot", "record"] as const) {
      for (const ph of ["select", "options"] as const) {
        expect(nextPhase(p, ph, cancelled)).toEqual({ act: "finish", outcome: cancelled });
      }
    }
  });
});

describe("fullDisplay: an assertion, not an inference (STC-388 review)", () => {
  test("expand sets fullDisplay true", () => {
    // didExpand: true is the only door — it does not matter what current was,
    // or what the rects are, since expand is an explicit assertion.
    expect(fullDisplayFor(false, true, undefined, displayRect)).toBe(true);
    expect(fullDisplayFor(true, true, displayRect, displayRect)).toBe(true);
  });

  test("a marquee adjustment after expand clears fullDisplay back to false", () => {
    // The bug this review found: expand sets fullDisplay, then the user drags a
    // handle to shrink the marquee, and nothing had ever cleared the flag — a
    // small region would settle paired with fullDisplay: true. didExpand is
    // false here because this is an ordinary selection event, not a press on
    // the expand control.
    expect(fullDisplayFor(true, false, displayRect, smallerRect)).toBe(false);
  });

  test("a pointermove that changes nothing does not clear fullDisplay", () => {
    // Same rect, by VALUE, not by reference — a duplicate event must not read
    // as a redraw.
    const same: Rect = { ...displayRect };
    expect(fullDisplayFor(true, false, displayRect, same)).toBe(true);
  });

  test("a marquee that merely equals the display bounds is never inferred as fullDisplay", () => {
    // The property record-options.ts's OptionsState.fullDisplay doc requires:
    // "does this rect equal the display bounds" must never be the rule. Here
    // current starts false and didExpand is false, so even a rect that happens
    // to equal the display's own bounds must not flip the flag on.
    expect(fullDisplayFor(false, false, smallerRect, displayRect)).toBe(false);
  });
});
