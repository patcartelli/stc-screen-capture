import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clicksOnTheRecording } from "../src/recorded-clicks.js";
import { zoomWindows, ZOOM_LEAD_NS } from "../src/zoom.js";
import { createCursorSim } from "../src/cursor.js";
import { tickOf } from "../src/time.js";
import { loadSession } from "../src/session.js";
import { memorySource } from "../src/chunk-reader.js";
import type { Anchors, SessionEvent } from "../src/types.js";

/**
 * Which presses count as clicks ON THE RECORDING (STC-654, STC-674).
 *
 * The event tap records every click on the machine. Before this, a click on a
 * second display, in another app beside a recorded window, or on Capture's own
 * Stop button opened an auto-zoom, and stage 2 slid its crop to the nearest
 * corner. Every test here states the claim through `zoomWindows`, because "no
 * window" is what the user sees; the controls show the same click INSIDE the
 * capture still opens one, so a filter that dropped everything would fail.
 */

const root = join(import.meta.dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

const MS = 1_000_000;
const S = 1000 * MS;

/** A 1000 x 800 pt display at global (0, 0), captured whole at 1x. */
function anchors(over: Partial<Anchors> = {}): Anchors {
  return {
    version: 6,
    timebase: { numer: 1, denom: 1 },
    t0Ns: "0",
    display: { id: 1, pixelWidth: 1000, pixelHeight: 800, backingScale: 1, originX: 0, originY: 0, pointWidth: 1000, pointHeight: 800 },
    capture: { width: 1000, height: 800, codec: "h264", firstFrameNs: 0 },
    files: { display: "display.mp4" },
    ...over,
  } as Anchors;
}

const FRAMES = [0];

const click = (t: number, x: number, y: number, button = 0): SessionEvent[] => [
  { t, kind: "down", x, y, button },
  { t: t + 80 * MS, kind: "up", x, y, button },
];

const windowsOf = (a: Anchors, events: SessionEvent[], frames: readonly number[] = FRAMES) =>
  zoomWindows(clicksOnTheRecording(a, events, frames));

describe("a click outside the capture is not a click on the recording (STC-654)", () => {
  test("whole display: a click 1500 pt left of the display opens no window", () => {
    const events = click(2 * S, -1500, 400);
    expect(zoomWindows(events)).toHaveLength(1);   // what it did before: the bug
    expect(windowsOf(anchors(), events)).toEqual([]);
  });

  test("whole display: a click on a second display to the right, or below, opens no window", () => {
    expect(windowsOf(anchors(), click(2 * S, 1400, 400))).toEqual([]);
    expect(windowsOf(anchors(), click(2 * S, 500, 900))).toEqual([]);
  });

  test("CONTROL: the same click inside the display still opens its window, untouched", () => {
    const events = click(2 * S, 500, 400);
    const kept = clicksOnTheRecording(anchors(), events, FRAMES);
    expect(kept).toBe(events);   // nothing dropped: the very array, so the take renders as it did
    expect(zoomWindows(kept)).toHaveLength(1);
  });

  test("a display that is not at the global origin is judged in its own place", () => {
    const a = anchors();
    a.display = { ...a.display, originX: -1000, originY: 200 };
    expect(windowsOf(a, click(2 * S, -500, 600))).toHaveLength(1);   // on it
    expect(windowsOf(a, click(2 * S, 500, 600))).toEqual([]);        // on the main display beside it
  });

  test("region scope: a click on the display but outside the region opens no window", () => {
    const a = anchors({
      version: 3,
      capture: { width: 400, height: 300, codec: "h264", firstFrameNs: 0 },
      scope: { kind: "region", region: { x: 100, y: 100, width: 400, height: 300 } },
    } as Partial<Anchors>);
    expect(windowsOf(a, click(2 * S, 800, 600))).toEqual([]);
    expect(windowsOf(a, click(2 * S, 50, 50))).toEqual([]);
    expect(windowsOf(a, click(2 * S, 300, 250))).toHaveLength(1);   // CONTROL: inside the region
  });

  test("window scope: a click in another app beside the window opens no window", () => {
    const a = anchors({
      version: 3,
      capture: { width: 600, height: 400, codec: "h264", firstFrameNs: 0 },
      scope: { kind: "window", window: { id: 7, bounds: { x: 200, y: 100, width: 600, height: 400 } } },
    } as unknown as Partial<Anchors>);
    expect(windowsOf(a, click(2 * S, 100, 300))).toEqual([]);
    expect(windowsOf(a, click(2 * S, 500, 700))).toEqual([]);
    expect(windowsOf(a, click(2 * S, 500, 300))).toHaveLength(1);   // CONTROL: inside the window
  });

  test("a refit: each click is judged by the display of the frame shown at its time (STC-235)", () => {
    const a: Anchors = load("fixtures/refit/anchors.json");
    const frames: number[] = load("fixtures/refit/frames.json");
    const refitNs = a.geometry![1]!.startNs;
    // geometry[0] is a 640x360 pt display at (0, 0); geometry[1] is 960x720 at (100, 0).
    // Global (900, 500) is off the first and on the second.
    const before = click(refitNs - 500 * MS, 900, 500);
    const after = click(refitNs + 500 * MS, 900, 500);
    expect(windowsOf(a, before, frames)).toEqual([]);
    expect(windowsOf(a, after, frames)).toHaveLength(1);
  });

  test("the pointer's path is unchanged: a dropped press stays as two moves", () => {
    const events = click(2 * S, -1500, 400);
    const kept = clicksOnTheRecording(anchors(), events, FRAMES);
    expect(kept).toEqual([
      { t: 2 * S, kind: "move", x: -1500, y: 400 },
      { t: 2 * S + 80 * MS, kind: "move", x: -1500, y: 400 },
    ]);
  });

  test("no click highlight: the cursor is never pressed for a click outside the capture", () => {
    const events = click(2 * S, -1500, 400);
    const at = tickOf(2 * S + 40 * MS);
    expect(createCursorSim(events).stateAt(at).pressed).toBe(true);   // before
    expect(createCursorSim(clicksOnTheRecording(anchors(), events, FRAMES)).stateAt(at).pressed).toBe(false);
  });

  test("a drag that starts inside and ends outside is kept whole", () => {
    const events: SessionEvent[] = [
      { t: 2 * S, kind: "down", x: 900, y: 400, button: 0 },
      { t: 2 * S + 100 * MS, kind: "move", x: 1100, y: 400 },
      { t: 2 * S + 200 * MS, kind: "up", x: 1200, y: 400, button: 0 },
    ];
    expect(clicksOnTheRecording(anchors(), events, FRAMES)).toBe(events);
  });

  test("a drag that starts outside is dropped whole, down and up, even when it ends inside", () => {
    const events: SessionEvent[] = [
      { t: 2 * S, kind: "down", x: 1200, y: 400, button: 0 },
      { t: 2 * S + 100 * MS, kind: "move", x: 900, y: 400 },
      { t: 2 * S + 200 * MS, kind: "up", x: 500, y: 400, button: 0 },
    ];
    const kept = clicksOnTheRecording(anchors(), events, FRAMES);
    expect(kept.map((e) => e.kind)).toEqual(["move", "move", "move"]);
    expect(zoomWindows(kept)).toEqual([]);   // its held moves are plain moves now
  });

  test("buttons are paired by number: an outside right-click does not swallow an inside left-up", () => {
    const events: SessionEvent[] = [
      { t: 2 * S, kind: "down", x: 500, y: 400, button: 0 },
      { t: 2 * S + 10 * MS, kind: "down", x: 1500, y: 400, button: 1 },
      { t: 2 * S + 20 * MS, kind: "up", x: 500, y: 400, button: 0 },
      { t: 2 * S + 30 * MS, kind: "up", x: 1500, y: 400, button: 1 },
    ];
    const kept = clicksOnTheRecording(anchors(), events, FRAMES);
    expect(kept.map((e) => e.kind)).toEqual(["down", "move", "up", "move"]);
  });

  test("an up with no down (the take began mid-press) is left alone", () => {
    const events: SessionEvent[] = [{ t: 100 * MS, kind: "up", x: 1500, y: 400, button: 0 }];
    expect(clicksOnTheRecording(anchors(), events, FRAMES)).toBe(events);
  });

  test("cursor-shape events and plain moves pass through", () => {
    const events: SessionEvent[] = [
      { t: 1 * S, kind: "move", x: -50, y: 10 },
      { t: 1 * S + 1, kind: "cursor", shape: "ibeam" },
      ...click(2 * S, -1500, 400),
    ];
    const kept = clicksOnTheRecording(anchors(), events, FRAMES);
    expect(kept.slice(0, 2)).toEqual(events.slice(0, 2));
  });
});

describe("the click that stopped the take is not a click on the recording (STC-674)", () => {
  const stopped = (t: number) => anchors({ stop: { t, reason: "user" } });

  test("a press 34 ms before stop.t (Stop on the pill, in the real take) opens no window", () => {
    const stopT = 16_724 * MS;
    const events = [...click(1_960 * MS, 500, 400), { t: stopT - 34 * MS, kind: "down", x: 500, y: 51, button: 0 } as SessionEvent];
    const windows = windowsOf(stopped(stopT), events);
    expect(zoomWindows(events)).toHaveLength(2);   // before: a second window the take cannot finish
    expect(windows).toHaveLength(1);
    expect(windows[0]!.events.every((e) => e.t < 3 * S)).toBe(true);
  });

  test("it does not extend or move a window that is still open either", () => {
    // A real click 1 s before the stop: its window is still held when Stop is pressed.
    const stopT = 10 * S;
    const events = [...click(9 * S, 500, 400), ...click(stopT - 100 * MS, 480, 51).slice(0, 1)];
    const windows = windowsOf(stopped(stopT), events);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.events.map((e) => e.t)).toEqual([9 * S, 9 * S + 80 * MS]);
  });

  test("the boundary: a press exactly ZOOM_LEAD_NS before stop.t is kept, one ns later is not", () => {
    const stopT = 10 * S;
    expect(windowsOf(stopped(stopT), click(stopT - ZOOM_LEAD_NS, 500, 400))).toHaveLength(1);
    expect(windowsOf(stopped(stopT), click(stopT - ZOOM_LEAD_NS + 1, 500, 400))).toEqual([]);
  });

  test("a drag begun earlier and still held at the stop is kept, its late up included", () => {
    const stopT = 10 * S;
    const events: SessionEvent[] = [
      { t: 9 * S, kind: "down", x: 500, y: 400, button: 0 },
      { t: stopT - 150 * MS, kind: "move", x: 600, y: 400 },
      { t: stopT - 50 * MS, kind: "up", x: 600, y: 400, button: 0 },
    ];
    expect(clicksOnTheRecording(stopped(stopT), events, FRAMES)).toBe(events);
  });

  test("CONTROL: with no stop block there is no end to measure from, and nothing is dropped", () => {
    const events = click(10 * S, 500, 400);
    expect(clicksOnTheRecording(anchors(), events, FRAMES)).toBe(events);
  });
});

describe("loadSession applies it (the one place)", () => {
  const rawBuf = (p: string) => {
    const b = readFileSync(join(root, p));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };

  test("a loaded take's events carry no press that was off the recording", async () => {
    const s = await loadSession({
      anchors: {
        version: 1, timebase: { numer: 125, denom: 3 }, t0Ns: "1000",
        display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 640, pixelHeight: 360, backingScale: 1, originX: 0, originY: 0 },
        capture: { width: 640, height: 360, codec: "h264", firstFrameNs: 250_000_000 },
        files: { display: "display.mp4" },
      } as Anchors,
      events: { version: 1, events: [...click(1 * S, 320, 180), ...click(2 * S, -1500, 180)] },
      displayMp4: memorySource(rawBuf("fixtures/offset/display.mp4"), "display.mp4"),
    });
    expect(s.events.map((e) => e.kind)).toEqual(["down", "up", "move", "move"]);
    expect(zoomWindows(s.events)).toHaveLength(1);
  });
});
