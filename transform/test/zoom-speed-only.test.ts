import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { render } from "../src/render.js";
import { zoomWindows } from "../src/zoom.js";
import { windowId } from "../src/zoom-override.js";
import { defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { PROJECT_VERSIONS } from "../src/project-version.js";
import type { Project, Session, SessionEvent, ZoomOverride } from "../src/types.js";

// STC-630: an Auto block with its own speed. Before project-20 a geometry
// override needed a rect, so a speed set on a block nobody had resized had
// nothing to ride on and was dropped without a word. Now the entry carries
// the speed alone, and stage 2 still decides where the block zooms.

const MS = 1_000_000;
const S = 1000 * MS;
const DUR = 12 * S;
const RECT = { x: 0.25, y: 0.25, width: 0.4, height: 0.4 };

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const validate20 = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/project-20.schema.json"), "utf8")));

const withOverrides = (overrides: ZoomOverride[]): Project => ({ ...defaultProject(1920, 1080), overrides });
const docWith = (overrides: unknown[]) => ({ ...projectForWrite(defaultProject(1920, 1080), DUR), version: 20, overrides });

describe("project-20: a speed with no rect (STC-630)", () => {
  test("20 is a readable version", () => expect(PROJECT_VERSIONS).toContain(20));

  test("a rectless speed is written at v20, round-trips, and is schema-valid", () => {
    for (const easing of ["calm", { in: "snappy", out: "calm" }] as const) {
      const out = projectForWrite(withOverrides([{ kind: "geometry", windowId: "1", easing }]), DUR);
      expect(out.version).toBe(20);
      expect(out.overrides).toEqual([{ kind: "geometry", windowId: "1", easing }]);
      expect(validate20(out), JSON.stringify(validate20.errors)).toBe(true);
      expect(parseProject(out, 1920, 1080, DUR).overrides).toEqual([{ kind: "geometry", windowId: "1", easing }]);
    }
  });

  test("a geometry entry WITH a rect stays at its older version", () => {
    expect(projectForWrite(withOverrides([{ kind: "geometry", windowId: "1", rect: RECT, easing: "calm" }]), DUR).version).toBe(6);
  });

  test("the loader drops a rectless entry with no speed, and a bad rect still drops the entry", () => {
    const out = parseProject(docWith([
      { kind: "geometry", windowId: "1" },
      { kind: "geometry", windowId: "2", easing: "wobbly" },
      { kind: "geometry", windowId: "3", rect: { x: "a" }, easing: "calm" },
    ]), 1920, 1080, DUR);
    expect(out.overrides).toEqual([]);
  });

  test("a rectless entry cannot follow: the loader keeps the speed and drops follow", () => {
    const out = parseProject(docWith([{ kind: "geometry", windowId: "1", easing: "calm", follow: true }]), 1920, 1080, DUR);
    expect(out.overrides).toEqual([{ kind: "geometry", windowId: "1", easing: "calm" }]);
  });

  test("the schema refuses what the loader would drop: no rect and no speed, follow with no rect", () => {
    expect(validate20(docWith([{ kind: "geometry", windowId: "1" }]))).toBe(false);
    expect(validate20(docWith([{ kind: "geometry", windowId: "1", easing: "calm", follow: true }]))).toBe(false);
    expect(validate20(docWith([{ kind: "geometry", windowId: "1", rect: RECT, follow: true }]))).toBe(true);
  });
});

function session(events: SessionEvent[]): Session {
  return {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: DUR, reason: "user" },
    },
    events, frames: [0, 16_000_000, 32_000_000],
  } as unknown as Session;
}

describe("render() plays a rectless speed (STC-630)", () => {
  const events: SessionEvent[] = [
    { t: 2000 * MS, kind: "down", x: 480, y: 540, button: 0 },
    { t: 2050 * MS, kind: "up", x: 480, y: 540, button: 0 },
  ];
  const s = session(events);
  const w = zoomWindows(events)[0]!;
  const id = windowId(w);
  const auto = withOverrides([]);
  const slow = withOverrides([{ kind: "geometry", windowId: id, easing: "calm" }]);
  const fast = withOverrides([{ kind: "geometry", windowId: id, easing: "snappy" }]);

  test("the speed changes the push in", () => {
    const t = w.startNs + 150 * MS;
    const [a, sl, f] = [auto, slow, fast].map((p) => render(p, s, t).zoom.amount);
    expect(sl).toBeLessThan(a!);
    expect(f).toBeGreaterThan(a!);
  });

  test("the place is still stage 2's: fully zoomed, the crop is the Auto block's own", () => {
    const t = w.endNs - 100 * MS;
    const a = render(auto, s, t).zoom;
    const sl = render(slow, s, t).zoom;
    expect(a.amount).toBeCloseTo(1, 3);
    expect(sl.amount).toBeCloseTo(1, 3);
    // Both settled on the same target; the crop is scaled by an amount still
    // a hair from 1 at different rates, so compare to 4 places.
    for (const k of ["x", "y", "width", "height"] as const) expect(sl.crop[k]).toBeCloseTo(a.crop[k], 4);
    expect(a.crop.width).toBeLessThan(0.9); // a real zoom, not the full frame
  });
});
