import { describe, test, expect } from "vitest";
import { nextPhase, fullDisplayFor, anchorRectFor } from "../src/overlay-session.js";
import { barLayout, CONTROL_IDS, expandedSelection, sizeLabel } from "../src/record-options.js";
import { confirm } from "../src/selection.js";
import type {
  DisplayInfo, Rect, SelectionContext, SelectionOutcome, SelectionState, WindowInfo,
} from "../src/selection.js";

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

// ── the bug this task fixes: window mode had no anchor at all ──────────────
//
// `selection.ts`'s pointerdown and Enter paths for a window pick attach only
// a bare `windowId` to the outcome — every `rect` assignment in that file is
// on the region-mode path — so `OverlaySession.push()` used to derive the
// bar's layout from `state.rect` alone, which is undefined in window mode.
// Recording a window was structurally impossible: `phase` advanced to
// "options" and the bar never rendered — no Record control, no readout,
// Escape the only way out.

const display: DisplayInfo = {
  id: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2,
};
const windowBounds: Rect = { x: 200, y: 150, width: 640, height: 480 };
const windows: WindowInfo[] = [{ id: 7, bounds: windowBounds, fullyVisible: true }];
const windowPick: SelectionOutcome = { kind: "window", windowId: 7 };

describe("the bar's anchor rect (STC-388)", () => {
  test("region mode: the anchor is the live marquee, exactly as before this ticket", () => {
    const rect: Rect = { x: 10, y: 10, width: 100, height: 80 };
    expect(anchorRectFor(region, rect, windows)).toEqual(rect);
    // No outcome confirmed yet (the select phase) falls back the same way.
    expect(anchorRectFor(undefined, rect, windows)).toEqual(rect);
  });

  test("window mode: the anchor is the PICKED WINDOW'S bounds — not the display's, and not undefined", () => {
    // state.rect is undefined here ON PURPOSE: selection.ts never sets one for
    // a window outcome, so an anchor that fell back to state.rect the way
    // region mode's does would be undefined too — the exact bug this fixes.
    const anchor = anchorRectFor(windowPick, undefined, windows);
    expect(anchor).toEqual(windowBounds);
    expect(anchor).not.toEqual(display.bounds);
    expect(anchor).not.toBeUndefined();
  });

  test("a window that has since vanished from the list yields no anchor, not a stale one", () => {
    const pending: SelectionOutcome = { kind: "window", windowId: 999 };
    expect(anchorRectFor(pending, undefined, windows)).toBeUndefined();
  });
});

describe("a window selection produces a real bar layout (STC-388)", () => {
  test("barLayout is defined for a window pick, with every control laid out", () => {
    const anchor = anchorRectFor(windowPick, undefined, windows);
    expect(anchor).toBeDefined();
    const layout = barLayout(anchor!, display);
    expect(layout).toBeDefined();
    expect(layout.controls.map((c) => c.id)).toEqual([...CONTROL_IDS]);
  });

  test("the W×H readout reflects the WINDOW, in pixels — not '—', not the display", () => {
    const anchor = anchorRectFor(windowPick, undefined, windows)!;
    // scaleFactor 2: a 640x480 point window reads 1280x960 pixels.
    expect(sizeLabel(anchor, display)).toBe("1280 × 960");
    expect(sizeLabel(anchor, display)).not.toBe(sizeLabel(display.bounds, display));
  });
});

describe("expand + a window pick: always a REGION, never a stale pair (STC-388)", () => {
  // onControl's own fix: pressing "expand" while a window is picked switches
  // mode to "region" BEFORE confirming, because `confirm` (selection.ts)
  // branches on `state.mode` alone and a window outcome has no rect for
  // `fullDisplay` to describe. Leaving mode at "window" would set a
  // full-display rect that confirm never looks at, and go on confirming the
  // hovered windowId instead — fullDisplay: true riding along with a
  // {kind:"window"} outcome, the same stale-pair shape 5850e4f already fixed
  // once. This tests the actual mechanism `onControl` relies on (mode switch
  // + expandedSelection + confirm), using only the exported pure pieces.
  test("switching mode to region before confirming yields a REGION outcome covering the display", () => {
    const ctx: SelectionContext = { displays: [display], windows };
    const stateAfterExpand: SelectionState = {
      mode: "region", rect: expandedSelection(display), hoveredWindowId: 7,
    };
    const outcome = confirm(stateAfterExpand, ctx);
    expect(outcome).toEqual({
      kind: "region", displayId: display.id, crop: display.bounds, global: display.bounds,
    });
  });

  test("had mode stayed \"window\", confirm would have kept confirming the WINDOW — the bug this avoids", () => {
    // The negative control: this is what onControl's expand case must NOT do.
    // Setting the rect while mode stays "window" produces a window outcome
    // with no relationship at all to the rect that was just set — the
    // fullDisplay flag would describe a rect nothing downstream reads.
    const ctx: SelectionContext = { displays: [display], windows };
    const stateWithModeUnchanged: SelectionState = {
      mode: "window", rect: expandedSelection(display), hoveredWindowId: 7,
    };
    expect(confirm(stateWithModeUnchanged, ctx)).toEqual({ kind: "window", windowId: 7 });
  });
});
