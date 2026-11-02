import { describe, expect, test } from "vitest";
import {
  BUTTON_ZOOM_STEP, FOLLOW_LANDING_FRACTION, MIN_SPAN_FRACTION, REVEAL_MARGIN_FRACTION, centreSpan,
  fitSpan, followSpan, grabOffset, isFit, isMinSpan, overviewBox, overviewSpanFor, panBy,
  playheadKeyIntent, playheadSide, revealSpan, spanTransform, timelineZoomKeyIntent, wheelIntent, zoomAbout,
  zoomByIntent, zoomReadout,
} from "../src/timeline-zoom.js";

const S = 1_000_000_000;
const D = 100 * S;
const wheel = (o: Partial<Parameters<typeof wheelIntent>[0]>) =>
  wheelIntent({ deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, ...o });

describe("zoomAbout", () => {
  test("keeps the anchored instant at the same place on screen", () => {
    const span = { startNs: 20 * S, endNs: 60 * S };
    const next = zoomAbout(span, D, 2, 30 * S);
    const before = (30 * S - span.startNs) / (span.endNs - span.startNs);
    const after = (30 * S - next.startNs) / (next.endNs - next.startNs);
    expect(after).toBeCloseTo(before, 9);
    expect(next.endNs - next.startNs).toBeCloseTo(20 * S, 3);
  });

  test("never wider than the take and never narrower than the floor", () => {
    expect(zoomAbout(fitSpan(D), D, 0.1, 50 * S)).toEqual(fitSpan(D));
    const tight = zoomAbout(fitSpan(D), D, 1e9, 50 * S);
    expect(tight.endNs - tight.startNs).toBeCloseTo(D * MIN_SPAN_FRACTION, 3);
  });

  test("stays inside the take at the edges", () => {
    const next = zoomAbout({ startNs: 0, endNs: 50 * S }, D, 4, 0);
    expect(next.startNs).toBe(0);
    const end = zoomAbout({ startNs: 50 * S, endNs: D }, D, 4, D);
    expect(end.endNs).toBeCloseTo(D, 3);
  });

  test("an anchor off screen is clamped rather than throwing the view away", () => {
    const span = { startNs: 40 * S, endNs: 60 * S };
    const next = zoomAbout(span, D, 2, 5 * S);
    expect(next.startNs).toBeGreaterThanOrEqual(40 * S - 1);
    expect(next.endNs).toBeLessThanOrEqual(60 * S + 1);
  });
});

describe("buttons and keys", () => {
  test("zoom around the playhead when it is showing", () => {
    const span = { startNs: 0, endNs: 60 * S };
    const next = zoomByIntent(span, D, "in", 45 * S);
    const frac = (45 * S - next.startNs) / (next.endNs - next.startNs);
    expect(frac).toBeCloseTo(0.75, 9);
    expect(next.endNs - next.startNs).toBeCloseTo((60 * S) / BUTTON_ZOOM_STEP, 3);
  });

  test("zoom around the middle when the playhead has scrolled away", () => {
    const span = { startNs: 40 * S, endNs: 60 * S };
    const next = zoomByIntent(span, D, "in", 90 * S);
    expect((next.startNs + next.endNs) / 2).toBeCloseTo(50 * S, 3);
  });

  test("fit shows the whole take, and in then out round-trips the width", () => {
    expect(zoomByIntent({ startNs: 10 * S, endNs: 20 * S }, D, "fit", 15 * S)).toEqual(fitSpan(D));
    const a = zoomByIntent(fitSpan(D), D, "in", 50 * S);
    const b = zoomByIntent(a, D, "out", 50 * S);
    expect(b.endNs - b.startNs).toBeCloseTo(D, 3);
    expect(isFit(b, D)).toBe(true);
  });

  test("isMinSpan is true only at the floor", () => {
    expect(isMinSpan(fitSpan(D), D)).toBe(false);
    expect(isMinSpan(zoomAbout(fitSpan(D), D, 1e9, 0), D)).toBe(true);
  });
});

describe("wheelIntent", () => {
  test("plain scroll pans, on whichever axis moved more", () => {
    expect(wheel({ deltaY: 30 })).toEqual({ kind: "pan", deltaPx: 30 });
    expect(wheel({ deltaX: -40, deltaY: 5 })).toEqual({ kind: "pan", deltaPx: -40 });
  });

  test("⌘-scroll zooms in on scroll up and out on scroll down", () => {
    const up = wheel({ metaKey: true, deltaY: -50 });
    const down = wheel({ metaKey: true, deltaY: 50 });
    expect(up.kind === "zoom" && up.factor > 1).toBe(true);
    expect(down.kind === "zoom" && down.factor < 1).toBe(true);
  });

  test("a pinch (ctrlKey) zooms, and a small pinch still moves the view", () => {
    const p = wheel({ ctrlKey: true, deltaY: -2 });
    expect(p.kind === "zoom" && p.factor > 1.005).toBe(true);
  });

  test("a fling cannot cross the whole range in one event", () => {
    const f = wheel({ metaKey: true, deltaY: -100000 });
    expect(f.kind === "zoom" && f.factor < 1.3).toBe(true);
  });

  test("no movement is no intent", () => {
    expect(wheel({})).toEqual({ kind: "none" });
    expect(wheel({ metaKey: true })).toEqual({ kind: "none" });
  });
});

describe("timelineZoomKeyIntent", () => {
  test("⌘= ⌘+ in, ⌘- out, ⌘0 fit", () => {
    expect(timelineZoomKeyIntent({ key: "=", metaKey: true })).toBe("in");
    expect(timelineZoomKeyIntent({ key: "+", metaKey: true, shiftKey: true })).toBe("in");
    expect(timelineZoomKeyIntent({ key: "-", metaKey: true })).toBe("out");
    expect(timelineZoomKeyIntent({ key: "0", metaKey: true })).toBe("fit");
  });

  test("bare keys, ⌥ chords and other letters are not ours", () => {
    expect(timelineZoomKeyIntent({ key: "=" })).toBeNull();
    expect(timelineZoomKeyIntent({ key: "0", metaKey: true, altKey: true })).toBeNull();
    expect(timelineZoomKeyIntent({ key: "c", metaKey: true })).toBeNull();
  });
});

describe("overview strip", () => {
  test("the box mirrors the span", () => {
    expect(overviewBox({ startNs: 25 * S, endNs: 50 * S }, D)).toEqual({ leftPct: 25, widthPct: 25 });
    expect(overviewBox(fitSpan(D), D)).toEqual({ leftPct: 0, widthPct: 100 });
  });

  test("dragging by the middle keeps the grab point under the pointer", () => {
    const span = { startNs: 10 * S, endNs: 30 * S };
    const grab = grabOffset(overviewBox(span, D), 0.2);
    expect(grab).toBeCloseTo(0.5, 9);
    const next = overviewSpanFor(span, D, 0.5, grab!);
    expect((next.startNs + next.endNs) / 2).toBeCloseTo(50 * S, 3);
    expect(next.endNs - next.startNs).toBeCloseTo(20 * S, 3);
  });

  test("a press outside the window brings it to the pointer, clamped to the take", () => {
    const span = { startNs: 10 * S, endNs: 30 * S };
    expect(grabOffset(overviewBox(span, D), 0.9)).toBeNull();
    const next = overviewSpanFor(span, D, 1, 0.5);
    expect(next.endNs).toBeCloseTo(D, 3);
  });
});

describe("panBy", () => {
  test("slides by a fraction of the span and stops at the ends", () => {
    const span = { startNs: 10 * S, endNs: 30 * S };
    expect(panBy(span, D, 0.5).startNs).toBeCloseTo(20 * S, 3);
    expect(panBy(span, D, -10).startNs).toBe(0);
    expect(panBy(span, D, 100).endNs).toBeCloseTo(D, 3);
  });
});

describe("zoomReadout", () => {
  test("whole take at fit, level and range otherwise", () => {
    expect(zoomReadout(fitSpan(D), D)).toBe("Whole take");
    expect(zoomReadout({ startNs: 12 * S, endNs: 37 * S }, D)).toBe("4.0× · 0:12.0–0:37.0");
    expect(zoomReadout({ startNs: 0, endNs: 5 * S }, D)).toBe("20× · 0:00.0–0:05.0");
  });
});

// ---- keeping the playhead in reach (STC-621) -------------------------------

describe("playheadSide", () => {
  const span = { startNs: 20 * S, endNs: 80 * S };
  test("names the side the playhead is off, edges included as in view", () => {
    expect(playheadSide(span, 10 * S)).toBe("before");
    expect(playheadSide(span, 90 * S)).toBe("after");
    expect(playheadSide(span, 20 * S)).toBeNull();
    expect(playheadSide(span, 80 * S)).toBeNull();
    expect(playheadSide(span, 50 * S)).toBeNull();
  });
});

describe("revealSpan", () => {
  const span = { startNs: 20 * S, endNs: 80 * S }; // a minute at 100 s
  const width = 60 * S;
  const margin = width * REVEAL_MARGIN_FRACTION;

  test("a playhead already in view leaves the span untouched (same object)", () => {
    expect(revealSpan(span, D, 50 * S)).toBe(span);
    expect(revealSpan(span, D, 20 * S)).toBe(span);
    expect(revealSpan(span, D, 80 * S)).toBe(span);
  });

  test("slides the least that shows it, keeping the width", () => {
    const right = revealSpan(span, D, 90 * S);
    expect(right.endNs - right.startNs).toBeCloseTo(width, 3);
    expect(right.endNs).toBeCloseTo(90 * S + margin, 3);
    const left = revealSpan(span, D, 5 * S);
    expect(left.endNs - left.startNs).toBeCloseTo(width, 3);
    expect(left.startNs).toBeCloseTo(5 * S - margin, 3);
  });

  test("the result always contains the playhead, including at the take's ends", () => {
    for (const t of [0, 1, 99 * S, D]) {
      const next = revealSpan({ startNs: 40 * S, endNs: 50 * S }, D, t);
      expect(next.startNs).toBeLessThanOrEqual(t);
      expect(next.endNs).toBeGreaterThanOrEqual(t);
      expect(next.startNs).toBeGreaterThanOrEqual(0);
      expect(next.endNs).toBeLessThanOrEqual(D + 1e-3);
    }
  });

  describe("with where the playhead was (a held arrow key)", () => {
    test("stepping into the margin at the right edge scrolls so the playhead sits a margin in", () => {
      const at = 80 * S - margin + 0.1 * S; // just inside the margin, in view
      const next = revealSpan(span, D, at, at - 0.1 * S);
      expect(next.endNs - next.startNs).toBeCloseTo(width, 3);
      expect(next.endNs).toBeCloseTo(at + margin, 3);
    });
    test("repeated one-frame steps move the view one frame each, never a margin's worth", () => {
      const frame = S / 60;
      let view = span;
      let t = 80 * S - margin - 5 * frame;
      for (let i = 0; i < 30; i++) {
        const prevStart = view.startNs;
        view = revealSpan(view, D, t + frame, t);
        t += frame;
        expect(view.startNs - prevStart).toBeLessThanOrEqual(frame + 1e-3);
      }
      expect(t).toBeGreaterThan(80 * S - margin); // it did cross into the margin
      expect(view.endNs).toBeGreaterThanOrEqual(t); // and the playhead stayed in view
    });
    test("the same at the left edge, stepping backwards", () => {
      const at = 20 * S + margin - 0.1 * S;
      const next = revealSpan(span, D, at, at + 0.1 * S);
      expect(next.startNs).toBeCloseTo(at - margin, 3);
    });
    test("a step AWAY from an edge never moves the view, even inside its margin", () => {
      const inLeftMargin = 20 * S + margin / 2;
      expect(revealSpan(span, D, inLeftMargin + 0.05 * S, inLeftMargin)).toBe(span);
      const inRightMargin = 80 * S - margin / 2;
      expect(revealSpan(span, D, inRightMargin - 0.05 * S, inRightMargin)).toBe(span);
    });
    test("without a previous position it is the old rule: only a playhead out of view moves it", () => {
      expect(revealSpan(span, D, 80 * S - margin / 2)).toBe(span);
    });
  });

  test("a degenerate span or take changes nothing", () => {
    const flat = { startNs: 5, endNs: 5 };
    expect(revealSpan(flat, D, 10 * S)).toBe(flat);
    expect(revealSpan(span, 0, 10 * S)).toBe(span);
  });
});

describe("centreSpan", () => {
  test("keeps the zoom and puts the playhead in the middle", () => {
    const next = centreSpan({ startNs: 20 * S, endNs: 40 * S }, D, 70 * S);
    expect(next.endNs - next.startNs).toBeCloseTo(20 * S, 3);
    expect((next.startNs + next.endNs) / 2).toBeCloseTo(70 * S, 3);
  });

  test("slides back inside the take near its ends, playhead still in view", () => {
    const early = centreSpan({ startNs: 20 * S, endNs: 40 * S }, D, 2 * S);
    expect(early.startNs).toBe(0);
    expect(early.endNs).toBeCloseTo(20 * S, 3);
    const late = centreSpan({ startNs: 20 * S, endNs: 40 * S }, D, 99 * S);
    expect(late.endNs).toBeCloseTo(D, 3);
    expect(late.startNs).toBeLessThanOrEqual(99 * S);
  });
});

describe("followSpan", () => {
  const span = { startNs: 0, endNs: 30 * S };
  const width = 30 * S;

  test("null while the playhead is in view, edges included", () => {
    expect(followSpan(span, D, 15 * S, 1)).toBeNull();
    expect(followSpan(span, D, 30 * S, 1)).toBeNull();
  });

  test("past the right edge flips a page, landing it near the left", () => {
    const next = followSpan(span, D, 31 * S, 1)!;
    expect(next.endNs - next.startNs).toBeCloseTo(width, 3);
    expect((31 * S - next.startNs) / width).toBeCloseTo(FOLLOW_LANDING_FRACTION, 6);
  });

  test("past the left edge (reverse shuttle) lands it near the right", () => {
    const next = followSpan({ startNs: 60 * S, endNs: 90 * S }, D, 59 * S, -1)!;
    expect((next.endNs - 59 * S) / width).toBeCloseTo(FOLLOW_LANDING_FRACTION, 6);
  });

  test("the last page does not run past the end of the take", () => {
    const next = followSpan({ startNs: 0, endNs: 30 * S }, D, 95 * S, 1)!;
    expect(next.endNs).toBeCloseTo(D, 3);
    expect(next.startNs).toBeLessThanOrEqual(95 * S);
  });

  test("a playhead off the LEFT while playing forward still lands near the left", () => {
    const next = followSpan({ startNs: 60 * S, endNs: 90 * S }, D, 20 * S, 1)!;
    expect((20 * S - next.startNs) / width).toBeCloseTo(FOLLOW_LANDING_FRACTION, 6);
  });

  test("after a flip the playhead is in view, so the next tick does nothing", () => {
    const next = followSpan(span, D, 31 * S, 1)!;
    expect(followSpan(next, D, 31.04 * S, 1)).toBeNull();
  });
});

describe("playheadKeyIntent", () => {
  test("a bare G, either case, is go-to-playhead", () => {
    expect(playheadKeyIntent({ key: "g" })).toBe(true);
    expect(playheadKeyIntent({ key: "G", shiftKey: true })).toBe(true);
  });
  test("not while typing, and not with a modifier (⌘G stays the platform's)", () => {
    expect(playheadKeyIntent({ key: "g", inTextField: true })).toBe(false);
    expect(playheadKeyIntent({ key: "g", metaKey: true })).toBe(false);
    expect(playheadKeyIntent({ key: "g", ctrlKey: true })).toBe(false);
    expect(playheadKeyIntent({ key: "g", altKey: true })).toBe(false);
  });
  test("collides with no zoom chord and no scrubber letter", () => {
    for (const key of ["=", "+", "-", "_", "0", "j", "k", "l", "i", "o", "m", " "]) {
      expect(playheadKeyIntent({ key })).toBe(false);
    }
    for (const key of ["=", "+", "-", "_", "0", "g"]) {
      expect(timelineZoomKeyIntent({ key, metaKey: false })).toBeNull();
    }
  });
});

// ---- the CSS transform every layer shares (STC-621) -------------------------

describe("spanTransform", () => {
  /** Where CSS puts a track point `x` (0..W): `scaleX(s) translateX(t%)` is s * (x + t/100 * W). */
  const placedAt = (x: number, t: { scale: number; translatePct: number }, W: number) =>
    t.scale * (x + (t.translatePct / 100) * W);
  const W = 1000;
  const xOf = (ns: number) => (ns / D) * W;

  test.each([
    ["Fit", { startNs: 0, endNs: D }],
    ["from the start", { startNs: 0, endNs: 20 * S }],
    ["a pan", { startNs: 50 * S, endNs: 70 * S }],
    ["against the end", { startNs: 80 * S, endNs: D }],
    ["narrow, late", { startNs: 91 * S, endNs: 91 * S + D / 64 }],
  ])("%s: the span's start lands at the left edge and its end at the right", (_n, span) => {
    const t = spanTransform(span, D);
    expect(placedAt(xOf(span.startNs), t, W)).toBeCloseTo(0, 6);
    expect(placedAt(xOf(span.endNs), t, W)).toBeCloseTo(W, 6);
  });

  test("the control: the formula it replaced puts a panned span nowhere near", () => {
    // translate by startNs / SPAN WIDTH, as editor.ts did from STC-373 to STC-621.
    const span = { startNs: 50 * S, endNs: 70 * S };
    const old = { scale: D / (span.endNs - span.startNs), translatePct: -(span.startNs / (span.endNs - span.startNs)) * 100 };
    expect(Math.abs(placedAt(xOf(span.startNs), old, W))).toBeGreaterThan(W);
  });

  test("an empty take is the identity", () => {
    expect(spanTransform({ startNs: 0, endNs: 0 }, 0)).toEqual({ scale: 1, translatePct: 0 });
  });
});
