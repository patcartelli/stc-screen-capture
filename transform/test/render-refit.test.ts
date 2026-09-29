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
    // The fixture's post-refit display is 960x720 points (2x backing) rather
    // than 640x360 — a display whose point size ALSO doubles the capture's,
    // so sx is 1 before and after the refit and this test cannot fail on
    // geometry-ignoring code (a controller ruling caught the original
    // fixture's flaw: 640/640 pre-refit and (640/480)*(480/640) post-refit
    // are both 1). With 960x720, sx changes from 1 to 0.5, so a render that
    // ignores geometry produces the SAME pxPerPoint before and after, and
    // this test catches that directly via the not-equal assertion below.
    const preRefit = render(project, s, refitNs - 100_000_000).cursor.pxPerPoint;
    const postRefit = render(project, s, refitNs + 100_000_000).cursor.pxPerPoint;
    const expectedPre = project.cursor.scale * (project.output.width / 640);
    const expectedPost = project.cursor.scale * (project.output.width / 960) * (480 / 640);
    expect(preRefit).toBeCloseTo(expectedPre, 9);
    expect(postRefit).toBeCloseTo(expectedPost, 9);
    // Proves the refit actually changed the scale — the assertion a
    // geometry-ignoring render() would fail, since it would report the same
    // pxPerPoint on both sides of the refit.
    expect(postRefit).not.toBeCloseTo(preRefit, 6);
  });

  test("a t inside the seam is rendered with the HELD frame's geometry, equal to the no-geometry mapping", () => {
    // Keying geometry by the SHOWN frame's PTS rather than by t makes no
    // difference for any t >= frames[0], since every geometry entry's
    // startNs is itself a frame PTS and frameIndexAt/geometryAt agree on
    // which one is held. What this test actually checks: a t just before the
    // refit's frame renders with the frame BEFORE it (never the refit's own
    // frame arriving early), and that render is byte-identical to a v6
    // document with no geometry at all — i.e. the pre-refit mapping, exactly.
    const iRefit = s.frames.indexOf(refitNs);
    const tSeam = refitNs - 1;                    // the frame shown is frames[iRefit-1]
    expect(geometryAt(s.anchors, s.frames[iRefit - 1]!).contentRect.x).toBe(0);
    const f = render(project, s, tSeam);
    expect(f.framePtsNs).toBe(s.frames[iRefit - 1]);
    const g0 = render(project, { ...s, anchors: { ...s.anchors, version: 6, geometry: undefined } }, tSeam);
    expect(f.cursor.x).toBe(g0.cursor.x);          // identical to the pre-refit mapping

    // Before the first frame (framePtsNs null), geometryAt falls back to
    // entry 0 / the top-level display. `fixtures/refit`'s own frames[0] is 0
    // (render() does not accept negative t — the cursor spring has no state
    // before tick 0), so this drops the fixture's first frame to get a t < a
    // frame[0] that is still >= 0.
    const shifted: Session = { ...s, frames: s.frames.slice(1) };
    const tBeforeFirstFrame = 0;
    expect(tBeforeFirstFrame).toBeLessThan(shifted.frames[0]!);
    const fBefore = render(project, shifted, tBeforeFirstFrame);
    expect(fBefore.framePtsNs).toBeNull();
    const g0Before = render(project, { ...shifted, anchors: { ...shifted.anchors, version: 6, geometry: undefined } }, tBeforeFirstFrame);
    expect(fBefore.cursor.x).toBe(g0Before.cursor.x);
  });
});
