import { describe, test, expect } from "vitest";
import { auditTake, activityMap, renderReport } from "../src/zoom-audit.js";
import type { Changes } from "../src/changes.js";
import type { SessionEvent, Anchors } from "../src/types.js";

/**
 * STC-405's audit, on hand-authored change tracks shaped like the things a
 * Meet/Zoom share does. Same posture as zoom-change.test.ts: no recording, no
 * decode. Each case is one way the change track can mislead a real click.
 */

const MS = 1_000_000;
const G = 10;
const anchors: Anchors = {
  version: 6,
  timebase: { numer: 1, denom: 1 },
  t0Ns: "0",
  display: { id: 1, pixelWidth: 1000, pixelHeight: 1000, backingScale: 1, originX: 0, originY: 0, pointWidth: 1000, pointHeight: 1000 },
  capture: { width: 1000, height: 1000, codec: "h264", firstFrameNs: 0 },
  files: { display: "display.mp4" },
};

/** a click at (x, y) points at time t: down then up, where the window is built from */
const click = (tMs: number, x: number, y: number): SessionEvent[] => [
  { t: tMs * MS, kind: "down", x, y, button: 0 } as SessionEvent,
  { t: (tMs + 50) * MS, kind: "up", x, y, button: 0 } as SessionEvent,
];

/** a frame every 100 ms for `lenMs`; `active(tMs)` says which [col,row] cells changed */
function track(lenMs: number, active: (tMs: number) => [number, number][]): Changes {
  const frames = [];
  for (let tMs = 0; tMs <= lenMs; tMs += 100) {
    const cells = new Array(G * G).fill(0);
    const on = active(tMs);
    for (const [c, r] of on) cells[r * G + c] = 0.5;
    frames.push({ t: tMs * MS, cells, changedFraction: on.length / (G * G) });
  }
  return { version: 1, gridWidth: G, gridHeight: G, threshold: 0.08, frames };
}

const burstAt = (from: number, cells: [number, number][]) => (t: number) => (t >= from && t <= from + 500 ? cells : []);

describe("auditTake — per window", () => {
  test("a change where the user clicked is clean", () => {
    const a = auditTake({ anchors, events: click(2000, 500, 500), changes: track(6000, burstAt(2000, [[5, 5]])) });
    expect(a.windows).toHaveLength(1);
    expect(a.windows[0]!.finding).toBe("clean");
    expect(a.windows[0]!.containsTriggers).toBe(true);
  });

  test("a continuous tile is classed ambient and does not move the crop", () => {
    const tile: [number, number][] = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) tile.push([c, r]);
    const a = auditTake({
      anchors, events: click(2000, 500, 500),
      changes: track(6000, (t) => [...tile, ...burstAt(2000, [[5, 5]])(t)]),
    });
    expect(a.windows[0]!.cells.ambient).toBe(9);
    expect(a.windows[0]!.finding).toBe("clean");
  });

  test("a toast that lands in the click's burst margin, far from the click, misdirects the zoom", () => {
    // click top-left; the burst is bottom-right, within BURST_TRAIL of the click
    const a = auditTake({ anchors, events: click(2000, 150, 150), changes: track(6000, burstAt(2100, [[8, 8]])) });
    const w = a.windows[0]!;
    expect(w.finding).toBe("misdirected");
    expect(w.containsTriggers).toBe(false);
    expect(w.farSurvivors).toBe(1);
  });

  test("everything changing swallows the zoom: suppressed", () => {
    const all: [number, number][] = [];
    for (let c = 0; c < G; c++) for (let r = 0; r < G; r++) all.push([c, r]);
    const a = auditTake({ anchors, events: click(2000, 500, 500), changes: track(6000, () => all) });
    expect(a.windows[0]!.changeCrop).toBeNull();
    expect(a.windows[0]!.cursorCrop).not.toBeNull();
    expect(a.windows[0]!.finding).toBe("suppressed");
  });

  test("a change track that does not reach the window is no-coverage, not clean", () => {
    const c = track(500, () => []);
    const a = auditTake({ anchors, events: click(5000, 500, 500), changes: c });
    expect(a.windows[0]!.finding).toBe("no-coverage");
  });

  test("a take with no click asks for no zoom", () => {
    const a = auditTake({ anchors, events: [], changes: track(1000, () => []) });
    expect(a.windows).toEqual([]);
  });
});

describe("auditTake — the noise floor", () => {
  test("change outside every window is counted, and a burst beside a window is flagged", () => {
    // click at 2000 -> window 1700..4500. A burst at 5000 is 500 ms after it; one at 0..200 is not.
    const a = auditTake({
      anchors, events: click(2000, 500, 500),
      changes: track(9000, (t) => (t >= 5000 && t <= 5200) || (t >= 8000 && t <= 8100) ? [[1, 1], [2, 2], [3, 3]] : []),
    });
    const { census } = a;
    expect(census.bursts).toHaveLength(2);
    const byStart = [...census.bursts].sort((x, y) => x.startNs - y.startNs);
    expect(byStart[0]!.nearWindow).toBe(true);
    expect(byStart[1]!.nearWindow).toBe(false);
    expect(census.idleMax).toBeCloseTo(0.03, 5);
  });

  test("a cell active on most frames shows as persistent and dark on the map", () => {
    const a = auditTake({ anchors, events: [], changes: track(3000, () => [[0, 0]]) });
    expect(a.census.persistentCells).toBe(1);
    expect(a.census.cellActivity[0]).toBe(1);
    expect(activityMap(a.census).startsWith("@")).toBe(true);
  });
});

describe("renderReport", () => {
  test("names every finding and leaves the judged column for a person", () => {
    const a = auditTake({ anchors, events: click(2000, 150, 150), changes: track(6000, burstAt(2100, [[8, 8]])) });
    const md = renderReport(a, "fixture");
    expect(md).toContain("**misdirected**");
    expect(md).toContain("judged (you)");
    expect(md).toContain("Noise floor");
  });
});
