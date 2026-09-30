import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { render } from "../src/render.js";
import { checkWindowTrack, stabiliseEvents, windowOriginAt } from "../src/window-track.js";
import type { Anchors, Project, Session, SessionEvent } from "../src/types.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

// STC-482. A window capture shows only the window's pixels, so dragging the
// window leaves the picture still while the cursor keeps travelling in global
// points. STC-471 maps through the bounds recorded at the start, so after a
// move the pointer is off by exactly how far the window went.

const DISPLAY = { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160, backingScale: 2, originX: 0, originY: 0 };
const BOUNDS = { x: 847, y: 44, width: 1020, height: 1002 };
const TRACK = [
  { t: 0, x: 847, y: 44 },
  { t: 3_000_000_000, x: 847, y: 44 },
  { t: 4_000_000_000, x: 272, y: 50 },        // dragged ~575 pt left, 6 down
];

const anchors = (track?: typeof TRACK, version: Anchors["version"] = 8): Anchors => ({
  version, timebase: { numer: 1, denom: 1 }, t0Ns: "0", display: DISPLAY,
  capture: { width: 2040, height: 2004, codec: "h264", firstFrameNs: 0 },
  scope: { kind: "window", window: { id: 1, bounds: BOUNDS, ...(track ? { track } : {}) } },
  files: { display: "display.mp4" }, stop: { t: 6_000_000_000, reason: "user" },
});

describe("windowOriginAt", () => {
  test("held before the first entry and after the last", () => {
    expect(windowOriginAt(TRACK, -5)).toEqual({ x: 847, y: 44 });
    expect(windowOriginAt(TRACK, 9e9)).toEqual({ x: 272, y: 50 });
  });
  test("linear between entries", () => {
    const o = windowOriginAt(TRACK, 3_500_000_000);
    expect(o.x).toBeCloseTo((847 + 272) / 2, 9);
    expect(o.y).toBeCloseTo(47, 9);
  });
  test("exactly on an entry", () => {
    expect(windowOriginAt(TRACK, 3_000_000_000)).toEqual({ x: 847, y: 44 });
    expect(windowOriginAt(TRACK, 4_000_000_000)).toEqual({ x: 272, y: 50 });
  });
});

describe("stabiliseEvents", () => {
  const ev = [
    { t: 1_000_000_000, kind: "move", x: 900, y: 60 },
    { t: 4_000_000_000, kind: "move", x: 300, y: 66 },
    { t: 4_500_000_000, kind: "cursor", shape: "arrow" },
  ] as SessionEvent[];

  test("no track: the very same array", () => {
    expect(stabiliseEvents(anchors(), ev)).toBe(ev);
    expect(stabiliseEvents({ ...anchors(), scope: undefined }, ev)).toBe(ev);
  });

  test("before the move nothing shifts; after it the window's displacement is taken out", () => {
    const out = stabiliseEvents(anchors(TRACK), ev);
    expect(out[0]).toEqual(ev[0]);
    // The cursor stayed 28 pt right of and 22 pt below the window's origin.
    expect(out[1]).toMatchObject({ x: 300 + 575, y: 66 - 6 });
  });

  test("a non-position event is untouched", () => {
    const out = stabiliseEvents(anchors(TRACK), ev);
    expect(out[2]).toBe(ev[2]);
  });

  test("a cursor holding the title bar stays put relative to the window through a whole drag", () => {
    const held: SessionEvent[] = [];
    for (let t = 3_000_000_000; t <= 4_000_000_000; t += 8_000_000) {
      const o = windowOriginAt(TRACK, t);
      held.push({ t, kind: "move", x: o.x + 100, y: o.y + 20 } as SessionEvent);
    }
    for (const e of stabiliseEvents(anchors(TRACK), held) as readonly { x: number; y: number }[]) {
      expect(e.x).toBeCloseTo(847 + 100, 9);
      expect(e.y).toBeCloseTo(44 + 20, 9);
    }
  });
});

describe("render: the pointer follows the window it is holding", () => {
  const frames = Array.from({ length: 400 }, (_, i) => Math.round((i * 1e9) / 60));
  const base = load("fixtures/basic/project.json") as Project;
  const project: Project = { ...base, output: { width: 1020, height: 1002, fps: 60 }, zoom: { ...base.zoom!, enabled: false } };

  // The cursor grabs the title bar 100 pt in and 20 down, and the window travels.
  const grab: SessionEvent[] = [];
  for (let t = 3_000_000_000; t <= 6_000_000_000; t += 8_000_000) {
    const o = windowOriginAt(TRACK, t);
    grab.push({ t, kind: "move", x: o.x + 100, y: o.y + 20 } as SessionEvent);
  }
  const a = anchors(TRACK);
  const session = (events: readonly SessionEvent[]): Session => ({ anchors: a, frames, events: events as Session["events"] });

  test("with the track it stays 100,20 into the frame the whole drag", () => {
    const s = session(stabiliseEvents(a, grab));
    for (const t of [3_400_000_000, 3_700_000_000, 4_500_000_000, 5_900_000_000]) {
      const c = render(project, s, t).cursor;
      expect(c.x).toBeCloseTo(100, 3);
      expect(c.y).toBeCloseTo(20, 3);
    }
  });

  test("the control: without the track the pointer leaves the bar", () => {
    const c = render(project, session(grab), 5_900_000_000).cursor;
    expect(c.x).toBeLessThan(0);                       // 575 pt off, and off the frame
  });
});

describe("checkWindowTrack refuses rather than defaults", () => {
  const bad = (mut: (a: any) => void, track = TRACK) => { const a: any = structuredClone(anchors(track)); mut(a); return a as Anchors; };
  test("a valid v8 track passes; a static take is fine", () => {
    expect(() => checkWindowTrack(anchors(TRACK))).not.toThrow();
    expect(() => checkWindowTrack(anchors(undefined, 3))).not.toThrow();
  });
  test("v8 with no track", () => expect(() => checkWindowTrack(anchors(undefined, 8))).toThrow(/no window track/));
  test("a track on a version before 8", () => expect(() => checkWindowTrack(anchors(TRACK, 7))).toThrow(/new at anchors v8/));
  test("fewer than two entries", () => expect(() => checkWindowTrack(anchors(TRACK.slice(0, 1)))).toThrow(/fewer than 2/));
  test("entry 0 is not the start", () => {
    expect(() => checkWindowTrack(bad((a) => { a.scope.window.track[0].x = 1; }))).toThrow(/not the take's start/);
    expect(() => checkWindowTrack(bad((a) => { a.scope.window.track[0].t = 5; }))).toThrow(/not the take's start/);
  });
  test("times must increase", () => {
    expect(() => checkWindowTrack(bad((a) => { a.scope.window.track[2].t = 3_000_000_000; }))).toThrow(/does not increase/);
  });
  test("a non-finite entry", () => {
    expect(() => checkWindowTrack(bad((a) => { a.scope.window.track[1].x = Number.NaN; }))).toThrow(/not finite/);
  });
});

describe("anchors-8 schema", () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(load("schema/anchors-8.schema.json"));
  const doc = () => structuredClone(anchors(TRACK)) as any;

  test("a moved window take validates", () => expect(validate(doc()), JSON.stringify(validate.errors)).toBe(true));
  test("a static window take at v8 still validates (track is optional in the schema)", () => {
    const d = doc(); delete d.scope.window.track;
    expect(validate(d), JSON.stringify(validate.errors)).toBe(true);
  });
  test("a one-entry track is refused (write none instead)", () => {
    const d = doc(); d.scope.window.track = d.scope.window.track.slice(0, 1);
    expect(validate(d)).toBe(false);
  });
  test("an unknown key in an entry is refused", () => {
    const d = doc(); d.scope.window.track[1].w = 1;
    expect(validate(d)).toBe(false);
  });
  test("anchors-7 refuses a track (new at 8)", () => {
    const v7 = new Ajv({ allErrors: true, strict: true }).compile(load("schema/anchors-7.schema.json"));
    const d = doc(); d.version = 7;
    expect(v7(d)).toBe(false);
  });
});
