import { describe, test, expect } from "vitest";
import { defaultProject } from "../src/trim.js";
import { render } from "../src/render.js";
import type { Project, Session, SessionEvent } from "../src/types.js";
import type { Changes } from "../src/changes.js";

/**
 * Stage 2 (STC-326) actually wired into render() — the same split
 * `zoom-override-project.test.ts` already established for phase 1: the pure
 * classifier is proven in isolation (`zoom-change.test.ts`), this proves
 * render() reads it, falls back to cursor clustering when nothing else
 * applies, and still lets a manual override win.
 */

const MS = 1_000_000;
const duration = 12_000_000_000;

// One click at t=2000ms: window is [1700ms, 4500ms] (300ms lead, 2500ms hold).
const events: SessionEvent[] = [
  { t: 2000 * MS, kind: "down", x: 960, y: 540, button: 0 },
  { t: 2050 * MS, kind: "up", x: 960, y: 540, button: 0 },
];

function baseSession(changes?: Changes): Session {
  return {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
    },
    events, frames: [0, 16_000_000, 32_000_000],
    changes,
  } as unknown as Session;
}

describe("render() reads stage 2's derived crop", () => {
  test("with no override and no changes.json, a window still crops itself via the cursor fallback", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: [] };
    const session = baseSession(undefined);
    const fs = render(p, session, 3000 * MS); // well inside the hold, spring settled
    expect(fs.zoom.amount).toBeGreaterThan(0.95);
    // Full-frame crop would be exactly {0,0,1,1}; stage 2 must have moved it.
    expect(fs.zoom.crop).not.toEqual({ x: 0, y: 0, width: 1, height: 1 });
    // The click was dead-centre (960/1920, 540/1080) = (0.5, 0.5), so the
    // derived crop should straddle the centre.
    expect(fs.zoom.crop.x).toBeLessThan(0.5);
    expect(fs.zoom.crop.x + fs.zoom.crop.width).toBeGreaterThan(0.5);
  });

  test("long before the window, amount is 0 and the crop is exactly the whole frame regardless of stage 2", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: [] };
    const session = baseSession(undefined);
    const fs = render(p, session, 0);
    expect(fs.zoom.amount).toBe(0);
    expect(fs.zoom.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("a manual override still wins over stage 2's derived crop", () => {
    const WINDOW_ID = String(1700 * MS);
    const OVERRIDE_TARGET = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    const p: Project = {
      ...defaultProject(1920, 1080),
      overrides: [{ kind: "geometry", windowId: WINDOW_ID, rect: OVERRIDE_TARGET }],
    };
    const session = baseSession(undefined);
    const fs = render(p, session, 3000 * MS);
    expect(fs.zoom.crop.x).toBeCloseTo(OVERRIDE_TARGET.x, 1);
    expect(fs.zoom.crop.y).toBeCloseTo(OVERRIDE_TARGET.y, 1);
    expect(fs.zoom.crop.width).toBeCloseTo(OVERRIDE_TARGET.width, 1);
  });

  test("session.changes, when it covers the window, is read ahead of the cursor fallback", () => {
    // A discrete change far from the click, near the top-left — if the
    // change track is being read, the crop moves there instead of straddling
    // the click at centre.
    const gridWidth = 20, gridHeight = 20;
    const frames = [];
    for (let t = 1700 * MS; t <= 4500 * MS; t += 100 * MS) {
      const cells = new Array(gridWidth * gridHeight).fill(0);
      if (t >= 2000 * MS && t <= 2400 * MS) cells[1 * gridWidth + 1] = 0.6; // near (0.05,0.05)
      frames.push({ t, cells, changedFraction: 0 });
    }
    const changes: Changes = { version: 1, gridWidth, gridHeight, threshold: 0.08, frames };
    const p: Project = { ...defaultProject(1920, 1080), overrides: [] };
    const session = baseSession(changes);
    const fs = render(p, session, 3000 * MS);
    // Floored to VIEWPORT_MIN_FRACTION (0.5) and centred near the changed
    // cell rather than the click — the change track, not the cursor, decided.
    expect(fs.zoom.crop.x).toBeLessThan(0.3);
    expect(fs.zoom.crop.y).toBeLessThan(0.3);
  });

  test("seeking straight to a tick gives the same crop as stepping there (stage 2 included)", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: [] };
    const session = baseSession(undefined);
    const t = 2200 * MS;
    const seeked = render(p, session, t).zoom;

    const s2: Session = { ...session, events: [...events] };
    for (let u = 0; u < t; u += 8_333_333) render(p, s2, u);
    const stepped = render(p, s2, t).zoom;

    expect(stepped).toEqual(seeked);
  });

  test("does not mutate the session's events or the project's overrides", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: [] };
    const session = baseSession(undefined);
    const before = JSON.stringify(session);
    for (const t of [0, 2000 * MS, 5000 * MS]) render(p, session, t);
    expect(JSON.stringify(session)).toBe(before);
  });
});
