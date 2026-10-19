import { describe, expect, test } from "vitest";
import {
  BUTTON_ZOOM_STEP, MIN_SPAN_FRACTION, fitSpan, grabOffset, isFit, isMinSpan, overviewBox,
  overviewSpanFor, panBy, timelineZoomKeyIntent, wheelIntent, zoomAbout, zoomByIntent, zoomReadout,
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
