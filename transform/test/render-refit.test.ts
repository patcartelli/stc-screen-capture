import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import { defaultProject } from "../src/trim.js";
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
