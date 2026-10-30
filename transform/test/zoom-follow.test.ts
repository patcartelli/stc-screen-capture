import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  createFollowSim, followPointsUv, FOLLOW_DEAD_ZONE_FRACTION, type FollowPoint,
} from "../src/zoom-follow.js";
import { tickOf } from "../src/time.js";
import { render } from "../src/render.js";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import type { Project, Session, SessionEvent, ZoomOverride } from "../src/types.js";

/**
 * STC-617: a zoom block that follows the cursor. The pure sim's rules first
 * (open on the cursor, dead zone, one spring, inside the frame, frozen after
 * the block, seek == step), then render() reading it and the project-19
 * round trip.
 */

const MS = 1_000_000;
const S = 1000 * MS;
const RECT = { x: 0.25, y: 0.25, width: 0.4, height: 0.4 };

const at = (t: number, x: number, y: number): FollowPoint => ({ t, x, y });
const centre = (r: { x: number; y: number; width: number; height: number }) =>
  ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

describe("the follow sim (zoom-follow.ts)", () => {
  test("opens centred on the cursor at the block's start, not on the rect", () => {
    const sim = createFollowSim([at(0, 0.4, 0.6)], 1 * S, 5 * S, RECT);
    const c = centre(sim.cropAt(tickOf(1 * S)));
    expect(c.x).toBeCloseTo(0.4, 12);
    expect(c.y).toBeCloseTo(0.6, 12);
    expect(sim.cropAt(tickOf(1 * S)).width).toBe(RECT.width);
    expect(sim.cropAt(tickOf(1 * S)).height).toBe(RECT.height);
  });

  test("before the block's start it holds the opening place", () => {
    const sim = createFollowSim([at(0, 0.4, 0.6), at(2 * S, 0.9, 0.9)], 1 * S, 5 * S, RECT);
    expect(sim.cropAt(0)).toEqual(sim.cropAt(tickOf(1 * S)));
  });

  test("a take with no positioned event keeps the rect's own place", () => {
    const sim = createFollowSim([], 1 * S, 5 * S, RECT);
    expect(sim.cropAt(tickOf(3 * S))).toEqual(RECT);
  });

  test("a move inside the dead zone never pans the crop", () => {
    const half = (FOLLOW_DEAD_ZONE_FRACTION * RECT.width) / 2;
    const points = [at(0, 0.5, 0.5)];
    // Jitter right up to (but inside) the dead zone's edge, for two seconds.
    for (let i = 1; i <= 40; i++) points.push(at(1 * S + i * 50 * MS, 0.5 + (i % 2 ? 0.99 : -0.99) * half, 0.5));
    const sim = createFollowSim(points, 1 * S, 5 * S, RECT);
    for (let n = tickOf(1 * S); n <= tickOf(4 * S); n += 7) {
      expect(centre(sim.cropAt(n)).x).toBe(0.5);
      expect(centre(sim.cropAt(n)).y).toBe(0.5);
    }
  });

  test("a cursor that leaves the dead zone is followed until it sits on the zone's edge", () => {
    const half = (FOLLOW_DEAD_ZONE_FRACTION * RECT.width) / 2;
    const sim = createFollowSim([at(0, 0.5, 0.5), at(2 * S, 0.7, 0.5)], 1 * S, 8 * S, RECT);
    const before = centre(sim.cropAt(tickOf(2 * S) - 1)).x;
    const soon = centre(sim.cropAt(tickOf(2.2 * S))).x;
    const settled = centre(sim.cropAt(tickOf(5 * S))).x;
    expect(before).toBe(0.5);
    expect(soon).toBeGreaterThan(0.5);
    expect(soon).toBeLessThan(settled); // a spring, not a jump
    expect(settled).toBeCloseTo(0.7 - half, 4);
  });

  test("the crop never leaves the frame, even chasing a cursor into a corner", () => {
    const points = [at(0, 0.5, 0.5), at(1.5 * S, 1, 1), at(3 * S, 0, 0), at(4.5 * S, 1, 0)];
    const sim = createFollowSim(points, 1 * S, 8 * S, RECT);
    for (let n = 0; n <= tickOf(8 * S); n++) {
      const r = sim.cropAt(n);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-12);
      expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  test("after the block ends it stops chasing", () => {
    const sim = createFollowSim([at(0, 0.5, 0.5), at(6 * S, 0.9, 0.9)], 1 * S, 5 * S, RECT);
    expect(sim.cropAt(tickOf(7 * S))).toEqual(sim.cropAt(tickOf(5 * S)));
  });

  test("seeking and stepping agree bit for bit, across checkpoints", () => {
    const points: FollowPoint[] = [];
    for (let i = 0; i < 400; i++) points.push(at(i * 37 * MS, (Math.sin(i / 7) + 1) / 2, (Math.cos(i / 11) + 1) / 2));
    const stepped = createFollowSim(points, 1 * S, 14 * S, RECT);
    const walk = [];
    for (let n = 0; n <= tickOf(15 * S); n++) walk.push(stepped.cropAt(n));
    const seeking = createFollowSim(points, 1 * S, 14 * S, RECT);
    for (const n of [tickOf(15 * S), 1700, 5, 1600, tickOf(1 * S) + 1024, tickOf(1 * S) + 1023, 900]) {
      expect(seeking.cropAt(n)).toEqual(walk[n]);
    }
  });
});

describe("followPointsUv", () => {
  test("maps positioned events to capture UV, in time order, and skips the rest", () => {
    const pts = followPointsUv([
      { t: 2 * S, kind: "move", x: 1920, y: 0 },
      { t: 1 * S, kind: "down", x: 960, y: 540, button: 0 },
      { t: 1.5 * S, kind: "cursor", shape: "arrow" },
    ] as SessionEvent[], session([]).anchors, [0]);
    expect(pts).toEqual([at(1 * S, 0.5, 0.5), at(2 * S, 1, 0)]);
  });
});

function session(events: SessionEvent[]): Session {
  return {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: 12 * S, reason: "user" },
    },
    events, frames: [0, 16_000_000, 32_000_000],
  } as unknown as Session;
}

describe("render() follows a following block (STC-617)", () => {
  // A click at 2 s opens a derived window [1.7 s, 4.5 s]; the pointer then
  // travels to the right edge.
  const events: SessionEvent[] = [
    { t: 2000 * MS, kind: "down", x: 480, y: 540, button: 0 },
    { t: 2050 * MS, kind: "up", x: 480, y: 540, button: 0 },
    { t: 3000 * MS, kind: "move", x: 1700, y: 540 },
  ];
  const windowId = String(1700 * MS);
  const withOverride = (o: ZoomOverride): Project => ({ ...defaultProject(1920, 1080), overrides: [o] });

  test("a fixed geometry block stays put; the same block with follow moves toward the pointer", () => {
    const s = session(events);
    const fixed = render(withOverride({ kind: "geometry", windowId, rect: RECT }), s, 4200 * MS);
    const follow = render(withOverride({ kind: "geometry", windowId, rect: RECT, follow: true }), s, 4200 * MS);
    expect(fixed.zoom.crop).toEqual(render(withOverride({ kind: "geometry", windowId, rect: RECT }), s, 4200 * MS).zoom.crop);
    expect(follow.zoom.crop.x).toBeGreaterThan(fixed.zoom.crop.x + 0.1);
  });

  test("a manual block follows too", () => {
    const s = session(events);
    const manual = (follow: boolean): Project => withOverride({
      kind: "manual", id: "m1", startNs: 1 * S, endNs: 6 * S, rect: RECT, easing: "standard",
      ...(follow ? { follow: true as const } : {}),
    });
    const a = render(manual(false), s, 5 * S).zoom.crop;
    const b = render(manual(true), s, 5 * S).zoom.crop;
    expect(b.x).toBeGreaterThan(a.x + 0.1);
  });

  test("a document with no following block renders what it did before", () => {
    const s = session(events);
    const p = withOverride({ kind: "geometry", windowId, rect: RECT });
    for (const t of [0, 1800 * MS, 3000 * MS, 4200 * MS, 6000 * MS]) {
      expect(render(p, s, t).zoom.crop).toEqual(render(structuredClone(p), session(events), t).zoom.crop);
    }
  });
});

describe("project-19 (STC-617)", () => {
  const Ajv = (AjvImport as any).default ?? AjvImport;
  const root = join(__dirname, "..", "..");
  const validate19 = new Ajv({ allErrors: true, strict: true })
    .compile(JSON.parse(readFileSync(join(root, "schema/project-19.schema.json"), "utf8")));
  const duration = 12 * S;

  test("follow is written only when true, and only then reaches v19", () => {
    const off = projectForWrite(
      { ...defaultProject(1920, 1080), overrides: [{ kind: "geometry", windowId: "1", rect: RECT }] }, duration);
    expect(off.version).toBe(6);
    const on = projectForWrite(
      { ...defaultProject(1920, 1080), overrides: [{ kind: "geometry", windowId: "1", rect: RECT, follow: true }] }, duration);
    expect(on.version).toBe(19);
    expect(on.overrides).toEqual([{ kind: "geometry", windowId: "1", rect: RECT, follow: true }]);
    expect(validate19(on), JSON.stringify(validate19.errors)).toBe(true);
  });

  test("a parse keeps follow: true and drops anything else, never the entry", () => {
    const doc = (follow: unknown) => ({
      ...projectForWrite(defaultProject(1920, 1080), duration), version: 19,
      overrides: [
        { kind: "geometry", windowId: "1", rect: RECT, follow },
        { kind: "manual", id: "m", startNs: 0, endNs: S, rect: RECT, easing: "calm", follow },
      ],
    });
    const kept = parseProject(doc(true), 1920, 1080, duration).overrides!;
    expect(kept.map((o) => (o as { follow?: true }).follow)).toEqual([true, true]);
    for (const bad of [false, "yes", 1, null]) {
      const out = parseProject(doc(bad), 1920, 1080, duration).overrides!;
      expect(out).toHaveLength(2);
      expect(out.every((o) => !("follow" in o))).toBe(true);
    }
  });

  test("the schema refuses follow: false (absent is the off state)", () => {
    const on = projectForWrite(
      { ...defaultProject(1920, 1080), overrides: [{ kind: "geometry", windowId: "1", rect: RECT, follow: true }] }, duration);
    expect(validate19({ ...on, overrides: [{ kind: "geometry", windowId: "1", rect: RECT, follow: false }] })).toBe(false);
  });
});
