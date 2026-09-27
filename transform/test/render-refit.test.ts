import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { defaultProject } from "../src/trim.js";
import { geometryAt, checkGeometry } from "../src/display-geometry.js";
import type { Anchors, Project, Session } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const exists = (p: string) => existsSync(join(root, p));

/**
 * `fixtures/real-session` has only `anchors.json`/`events.json` (a real
 * recording's sidecars, mp4 omitted) — no `frames.json`/`project.json`. Every
 * 16_666_667 ns up to `anchors.stop.t` stands in for a frame grid; the real
 * VFR grid does not matter here, only that SOME grid exists so `render()` has
 * a frame to hold.
 */
function syntheticFrames(stopNs: number): number[] {
  const frames: number[] = [];
  for (let t = 0; t <= stopNs; t += 16_666_667) frames.push(t);
  return frames;
}

function session(dir: string): Session {
  const anchors: Anchors = load(`${dir}/anchors.json`);
  const frames = exists(`${dir}/frames.json`)
    ? (load(`${dir}/frames.json`) as number[])
    : syntheticFrames(anchors.stop!.t);
  return { anchors, events: load(`${dir}/events.json`).events, frames };
}

function projectFor(dir: string, anchors: Anchors, zoomEnabled: boolean): Project {
  const base: Project = exists(`${dir}/project.json`)
    ? load(`${dir}/project.json`)
    : defaultProject(anchors.capture.width, anchors.capture.height);
  return { ...base, zoom: { ...(base.zoom ?? defaultProject(anchors.capture.width, anchors.capture.height).zoom!), enabled: zoomEnabled } };
}

function cursorTrace(project: Project, s: Session): unknown[] {
  const end = s.frames.at(-1)!;
  const out = [];
  for (let i = 0; i < 200; i++) {
    const t = Math.floor((end * i) / 199);
    const f = render(project, s, t);
    out.push([t, f.cursor.x, f.cursor.y, f.cursor.vx, f.cursor.vy, f.cursor.pxPerPoint, f.zoom.crop]);
  }
  return out;
}

// Goldens are written ONCE, on master's code, before the refactor. After that
// this test only compares. Regenerating them to make a failure go away is the
// defect this test exists to catch.
describe("every take before STC-235 renders byte-identically", () => {
  const cases: [string, string, boolean][] = [
    ["basic", "fixtures/basic", false],
    ["real-session", "fixtures/real-session", false],
    ["real-session-zoom", "fixtures/real-session", true],
  ];

  test.each(cases)("%s", (name, dir, zoomEnabled) => {
    const golden = join(__dirname, "golden", `render-cursor-${name}.json`);
    const s = session(dir);
    const project = projectFor(dir, s.anchors, zoomEnabled);
    const trace = cursorTrace(project, s);
    if (process.env.STC_WRITE_GOLDEN === "1" && !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(trace));
    }
    expect(JSON.stringify(trace)).toBe(readFileSync(golden, "utf8"));
  });
});

describe("a refitted take maps the cursor into contentRect", () => {
  const s = session("fixtures/refit");
  const project: Project = load("fixtures/refit/project.json");
  const refitNs = s.anchors.geometry![1]!.startNs;

  test("fixtures/refit passes checkGeometry", () => {
    expect(() => checkGeometry(s.anchors)).not.toThrow();
  });

  test("after the refit, the display's top-left global point lands on contentRect's top-left", () => {
    // The cursor is a SPRING (120 Hz, OMEGA 30), not the raw event position:
    // put the only move right after the refit and read it ~2 s later, when the
    // spring has long settled, at the last frame of the fixture.
    const e = { ...s, events: [{ t: refitNs + 1, kind: "move", x: 100, y: 0 }] as Session["events"] };
    const tRead = s.frames.at(-1)!;
    expect(tRead - refitNs).toBeGreaterThan(1_500_000_000);   // the fixture's midpoint refit leaves room
    const f = render(project, e, tRead);
    const sx = project.output.width / s.anchors.capture.width;
    expect(f.cursor.x).toBeCloseTo(80 * sx, 6);
    expect(f.cursor.y).toBeCloseTo(0, 6);
  });

  test("pxPerPoint follows the new scale", () => {
    const f = render(project, s, refitNs + 100_000_000);
    const expected = project.cursor.scale * (480 / 480) * (project.output.width / 640);
    expect(f.cursor.pxPerPoint).toBeCloseTo(expected, 9);
  });

  test("a t inside the seam uses the HELD frame's geometry, not the next one", () => {
    const iRefit = s.frames.indexOf(refitNs);
    const tSeam = refitNs - 1;                    // the frame shown is frames[iRefit-1]
    expect(geometryAt(s.anchors, s.frames[iRefit - 1]!).contentRect.x).toBe(0);
    const f = render(project, s, tSeam);
    expect(f.framePtsNs).toBe(s.frames[iRefit - 1]);
    const g0 = render(project, { ...s, anchors: { ...s.anchors, version: 6, geometry: undefined } }, tSeam);
    expect(f.cursor.x).toBe(g0.cursor.x);          // identical to the pre-refit mapping
  });
});
