import { describe, test, expect } from "vitest";
import {
  initialState, show, dismiss, positionFor,
  parseCorner,
  discardDirection, isHorizontal, swipeOffset, isDiscardSwipe, SWIPE_DISCARD_PX,
  classifyDrag, DRAG_START_PX,
  stackPosition, STACK_STEP_PX, MAX_STACKED, PANEL_SIZE,
  CORNERS,
} from "../src/thumbnail.js";

/**
 * STC-296's panel decisions, without a window or a real clock.
 *
 * The wiring — a real `BrowserWindow`, the real timer, hiding it for a
 * subsequent capture — is `app/test/thumbnail.e2e.test.ts`'s job; this is
 * everything that can be settled by argument.
 */

describe("the panel state machine (STC-392: it waits)", () => {
  test("starts idle", () => {
    expect(initialState()).toEqual({ kind: "idle" });
  });

  test("a capture opens it, and there is nowhere else for it to go on its own", () => {
    // The whole of STC-392: `showing` used to carry an `expiresAt`, and
    // `isExpired` used to be the second way out. Both are gone — the only
    // transition off `open` is `dismiss`, which a user action calls.
    expect(show()).toEqual({ kind: "open" });
  });

  test("dismiss always returns to idle, and is idempotent", () => {
    expect(dismiss()).toEqual({ kind: "idle" });
    expect(dismiss()).toEqual(dismiss());
  });

  test("the module exports no clock at all", async () => {
    // A structural guard with a control: the names below were the panel's
    // timeout, and a re-introduced one would be a second way for a take to be
    // decided without the user. The control asserts the guard can see names
    // that ARE there, so a typo in the list cannot make this pass vacuously.
    const mod = await import("../src/thumbnail.js");
    for (const gone of ["isExpired", "clampTimeoutMs", "parseSettleAction",
                        "DEFAULT_THUMBNAIL_TIMEOUT_MS", "MIN_THUMBNAIL_TIMEOUT_MS"]) {
      expect(Object.keys(mod)).not.toContain(gone);
    }
    for (const present of ["show", "dismiss", "positionFor", "stackPosition"]) {
      expect(Object.keys(mod)).toContain(present);
    }
  });
});

describe("the corner preference", () => {
  test("all four corners round-trip", () => {
    for (const c of CORNERS) expect(parseCorner(c)).toBe(c);
  });

  test("anything else falls back to the default rather than to nothing", () => {
    for (const bad of [undefined, null, "middle", 1, {}]) {
      expect(parseCorner(bad)).toBe("bottom-right");
    }
  });
});

describe("corner positioning", () => {
  // A work area that is NOT at the origin and NOT the same as a display's full
  // bounds — the one a single-monitor-at-(0,0) test would hide.
  const workArea = { x: 200, y: 100, width: 1600, height: 900 };
  const size = { width: 220, height: 150 };

  test("each corner lands inside the work area, margin from both edges it names", () => {
    expect(positionFor("bottom-right", workArea, size, 20))
      .toEqual({ x: 200 + 1600 - 220 - 20, y: 100 + 900 - 150 - 20 });
    expect(positionFor("top-left", workArea, size, 20))
      .toEqual({ x: 220, y: 120 });
    expect(positionFor("top-right", workArea, size, 20))
      .toEqual({ x: 200 + 1600 - 220 - 20, y: 120 });
    expect(positionFor("bottom-left", workArea, size, 20))
      .toEqual({ x: 220, y: 100 + 900 - 150 - 20 });
  });

  test("a bigger margin pushes it further from both edges it applies to", () => {
    const tight = positionFor("bottom-right", workArea, size, 10);
    const loose = positionFor("bottom-right", workArea, size, 40);
    expect(loose.x).toBeLessThan(tight.x);
    expect(loose.y).toBeLessThan(tight.y);
  });
});


describe("swipe to discard (STC-296 follow-up)", () => {
  const D = SWIPE_DISCARD_PX;

  test("off-screen is right from a right corner and left from a left one", () => {
    expect(discardDirection("bottom-right")).toBe(1);
    expect(discardDirection("top-right")).toBe(1);
    expect(discardDirection("bottom-left")).toBe(-1);
    expect(discardDirection("top-left")).toBe(-1);
  });

  test("a full swipe toward the near edge discards", () => {
    expect(isDiscardSwipe(D, 0, "bottom-right")).toBe(true);
    expect(isDiscardSwipe(-D, 0, "bottom-left")).toBe(true);
  });

  test("the SAME drag that discards from one corner does nothing from the other", () => {
    // The positive discriminator: one delta, two corners, opposite answers.
    // Without the corner in the decision this pair cannot both hold.
    expect(isDiscardSwipe(D, 0, "bottom-right")).toBe(true);
    expect(isDiscardSwipe(D, 0, "bottom-left")).toBe(false);
  });

  test("a drag away from the edge never discards, however far it goes", () => {
    expect(isDiscardSwipe(-D * 10, 0, "bottom-right")).toBe(false);
    expect(swipeOffset(-D * 10, 0, "bottom-right")).toBe(0);
  });

  test("short of the threshold is not a discard", () => {
    expect(isDiscardSwipe(D - 1, 0, "bottom-right")).toBe(false);
    expect(isDiscardSwipe(D, 0, "bottom-right")).toBe(true);
  });

  test("a mostly-vertical drag is not a swipe, however far sideways it also went", () => {
    // A slow diagonal reaches the distance eventually; without this it would
    // destroy a capture nobody aimed at.
    expect(isDiscardSwipe(D * 2, D * 3, "bottom-right")).toBe(false);
    expect(swipeOffset(D * 2, D * 3, "bottom-right")).toBe(0);
  });

  test("a perfect diagonal is ambiguous, so it does not discard", () => {
    expect(isHorizontal(50, 50)).toBe(false);
    expect(isDiscardSwipe(D, D, "bottom-right")).toBe(false);
  });

  test("the panel is drawn following the pointer, but only outward", () => {
    expect(swipeOffset(40, 5, "bottom-right")).toBe(40);
    expect(swipeOffset(-40, 5, "bottom-left")).toBe(40);
    // The wrong way does not budge it — the gesture says "not here" by not
    // moving, without anything having to be explained.
    expect(swipeOffset(40, 5, "bottom-left")).toBe(0);
  });

  test("vertical movement never displaces the panel", () => {
    expect(swipeOffset(0, 80, "bottom-right")).toBe(0);
  });

  test("the threshold is a distance, not a speed", () => {
    // Same total delta, however it was delivered: nothing here reads a clock,
    // so a loaded machine cannot change the answer.
    expect(isDiscardSwipe(D + 1, 0, "bottom-right")).toBe(true);
  });
});


describe("one gesture, two outcomes (STC-296 drag-out)", () => {
  const D = SWIPE_DISCARD_PX;
  const S = DRAG_START_PX;
  const BR = "bottom-right" as const;

  test("a small movement is still a click — the panel expands on release", () => {
    expect(classifyDrag(0, 0, BR)).toBe("none");
    expect(classifyDrag(S - 1, 0, BR)).toBe("none");
    expect(classifyDrag(0, S - 1, BR)).toBe("none");
  });

  test("far toward the near edge discards", () => {
    expect(classifyDrag(D, 0, BR)).toBe("discard");
  });

  test("away from the edge is a drag-out, at the shorter threshold", () => {
    expect(classifyDrag(-S, 0, BR)).toBe("drag-out");
    expect(classifyDrag(0, -S, BR)).toBe("drag-out");
  });

  test("PARTWAY toward the edge is neither — the swipe must stay reachable", () => {
    // The load-bearing case. If this returned "drag-out", the OS would take
    // the pointer at 12 px and the discard could never reach 90: one feature
    // would silently make the other unreachable, and both would look built.
    for (const dx of [S, S + 1, D / 2, D - 1]) {
      expect(classifyDrag(dx, 0, BR)).toBe("none");
    }
    expect(classifyDrag(D, 0, BR)).toBe("discard");
  });

  test("the same partway drag from the OTHER corner IS a drag-out", () => {
    // The positive discriminator: identical delta, opposite corners, and the
    // only thing that can separate them is the corner being in the decision.
    expect(classifyDrag(D / 2, 0, "bottom-right")).toBe("none");
    expect(classifyDrag(D / 2, 0, "bottom-left")).toBe("drag-out");
  });

  test("a drag can never be both", () => {
    // One answer, so a drag cannot discard a shot it has just handed over.
    for (const dx of [-200, -S, 0, S, D, 400]) {
      for (const dy of [-200, 0, 200]) {
        for (const corner of CORNERS) {
          expect(["none", "discard", "drag-out"]).toContain(classifyDrag(dx, dy, corner));
        }
      }
    }
  });

  test("a mostly-vertical drag toward the edge is a drag-out, not a discard", () => {
    // isHorizontal gates the discard arm, so this falls through to drag-out
    // rather than being stuck as "none" — dragging diagonally up-and-out to
    // Finder from a bottom-right panel has to work.
    expect(classifyDrag(D, D * 2, BR)).toBe("drag-out");
  });

  test("drag-out commits sooner than discard, deliberately", () => {
    // The cheap-to-undo gesture is the easy one to reach: an OS drag dropped
    // on nothing does nothing, a discard destroys a capture.
    expect(DRAG_START_PX).toBeLessThan(SWIPE_DISCARD_PX);
  });
});


describe("stacking (STC-296 follow-up)", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 220, height: 150 };

  test("the newest panel sits exactly where a lone panel would", () => {
    // Not a separate calculation: the single-panel case cannot drift from the
    // stacked one because index 0 IS `positionFor`.
    for (const corner of CORNERS) {
      expect(stackPosition(0, corner, workArea, size))
        .toEqual(positionFor(corner, workArea, size));
    }
  });

  test("older panels move further INTO the screen, never off its edge", () => {
    const topLeft = stackPosition(1, "top-left", workArea, size);
    const bottomLeft = stackPosition(1, "bottom-left", workArea, size);
    // Down from a top corner, up from a bottom one.
    expect(topLeft.y).toBeGreaterThan(stackPosition(0, "top-left", workArea, size).y);
    expect(bottomLeft.y).toBeLessThan(stackPosition(0, "bottom-left", workArea, size).y);
  });

  test("the step is uniform, so the stack reads as a deck", () => {
    const ys = [0, 1, 2, 3].map((i) => stackPosition(i, "bottom-right", workArea, size).y);
    const gaps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]!));
    expect(gaps).toEqual([STACK_STEP_PX, STACK_STEP_PX, STACK_STEP_PX]);
  });

  test("stacking never moves a panel sideways", () => {
    // The stack is anchored to its corner; drifting horizontally would take it
    // away from the edge it belongs to.
    for (const corner of CORNERS) {
      const xs = [0, 1, 2, 3].map((i) => stackPosition(i, corner, workArea, size).x);
      expect(new Set(xs).size).toBe(1);
    }
  });

  test("a full stack of the ONE panel size still fits the work area", () => {
    // Re-anchored for STC-392 (D3): the card is one size now, and it is taller
    // than the old collapsed thumbnail because its actions are always visible.
    // The old test measured the collapsed size and would have stayed green
    // while five of the real card ran off the screen.
    const workArea = { x: 0, y: 0, width: 1440, height: 900 };
    const oldest = stackPosition(MAX_STACKED - 1, "bottom-right", workArea, PANEL_SIZE);
    expect(oldest.y).toBeGreaterThanOrEqual(workArea.y);
    expect(oldest.y + PANEL_SIZE.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    // Composition, not magnitude: the clearance must come from the stack's own
    // arithmetic, not from slack in a display that happens to be tall.
    const consumed = PANEL_SIZE.height + (MAX_STACKED - 1) * STACK_STEP_PX + 2 * 20;
    expect(consumed).toBeLessThanOrEqual(workArea.height);
  });

  test("the cap matches the acceptance case it exists for", () => {
    // "Five captures in five seconds produce five recoverable shots."
    expect(MAX_STACKED).toBeGreaterThanOrEqual(5);
  });
});
