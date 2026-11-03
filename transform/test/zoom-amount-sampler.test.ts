import { describe, test, expect } from "vitest";
import { defaultProject } from "../src/trim.js";
import { render, zoomAmountSampler } from "../src/render.js";
import type { Project, Session, SessionEvent, ZoomOverride } from "../src/types.js";

/**
 * The editor's Zoom lane reads the zoom amount through `zoomAmountSampler`
 * (STC-620) instead of a whole `render()` per sample. Its one promise is that
 * the two cannot disagree, so every case here compares them with `toBe`, not
 * `toBeCloseTo`: the same sims, read in a different order.
 */

const MS = 1_000_000;
const duration = 30_000_000_000;

const click = (ms: number): SessionEvent[] => [
  { t: ms * MS, kind: "down", x: 960, y: 540, button: 0 },
  { t: (ms + 50) * MS, kind: "up", x: 960, y: 540, button: 0 },
];
// Three well-separated clicks: three derived windows (each ~[t - 300 ms, t + 2500 ms]).
const events: SessionEvent[] = [...click(2000), ...click(9000), ...click(20_000)];

const session = {
  anchors: {
    version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
               pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
    capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
    files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
  },
  events, frames: [0, 16_000_000, 32_000_000],
} as unknown as Session;

const RECT = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
const project = (over: Partial<Project> = {}): Project => ({ ...defaultProject(1920, 1080), ...over });

/** Instants across the take, including on and around every window edge. */
const times = (() => {
  const out: number[] = [];
  for (let t = 0; t <= duration; t += 37 * MS) out.push(t);
  for (const edge of [1700, 4500, 8700, 11_500, 19_700, 22_500, 12_000, 15_000]) {
    for (let d = -40; d <= 40; d += 4) out.push((edge + d) * MS);
  }
  return out;
})();

function agree(p: Project): void {
  const sampler = zoomAmountSampler(p, session);
  const got = sampler.amountsAt(times);
  expect(got).toHaveLength(times.length);
  times.forEach((t, i) => expect(got[i], `t=${t / MS}ms`).toBe(render(p, session, t).zoom.amount));
  // STC-636: the lane's height is the crop's magnification, from the same crop.
  const mags = sampler.magnificationsAt(times, got);
  times.forEach((t, i) => {
    const crop = render(p, session, t).zoom.crop;
    expect(mags[i], `t=${t / MS}ms`).toBe(1 / Math.max(crop.width, crop.height));
  });
}

describe("zoomAmountSampler reads exactly what render() reports", () => {
  test("the default project", () => {
    agree(project());
    expect(Math.max(...zoomAmountSampler(project(), session).amountsAt(times))).toBeGreaterThan(0.9);
  });

  test("each preset", () => {
    for (const preset of ["calm", "standard", "snappy"] as const) {
      agree(project({ zoom: { enabled: true, intensity: 1, preset } as Project["zoom"] }));
    }
  });

  test("intensity scales it, and off is flat zero", () => {
    agree(project({ zoom: { enabled: true, intensity: 0.5, preset: "standard" } as Project["zoom"] }));
    const off = project({ zoom: { enabled: false, intensity: 1, preset: "standard" } as Project["zoom"] });
    agree(off);
    expect(zoomAmountSampler(off, session).amountsAt(times).every((a) => a === 0)).toBe(true);
  });

  test("separate in and out speeds on a block (STC-619) and a manual window", () => {
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "1700000000", rect: RECT, easing: { in: "calm", out: "snappy" } } as ZoomOverride,
      { kind: "manual", id: "m1", startNs: 12_000 * MS, endNs: 15_000 * MS, rect: RECT, easing: { in: "snappy", out: "calm" } } as ZoomOverride,
    ];
    agree(project({ overrides }));
    // The windows it reports are the resolved ones: the manual window is among them.
    const sampler = zoomAmountSampler(project({ overrides }), session);
    expect(sampler.windows.some((w) => w.startNs === 12_000 * MS && w.endNs === 15_000 * MS)).toBe(true);
  });

  test("magnification follows a block's region (STC-636): 1 outside, its own amount at the plateau", () => {
    const quarter = { x: 0.1, y: 0.1, width: 0.25, height: 0.25 };
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "1700000000", rect: quarter } as ZoomOverride,
      { kind: "geometry", windowId: "8700000000", rect: RECT, follow: true } as ZoomOverride,
      { kind: "geometry", windowId: "19700000000", easing: { in: "snappy" } } as ZoomOverride,
    ];
    const p = project({ overrides });
    agree(p);
    const sampler = zoomAmountSampler(p, session);
    const at = [0, 3500 * MS, 10_500 * MS];
    const m = sampler.magnificationsAt(at, sampler.amountsAt(at));
    expect(m[0]).toBe(1);
    expect(m[1]).toBeCloseTo(4, 2);
    // A following block keeps its size, so its magnification is its region's.
    expect(m[2]).toBeCloseTo(2.5, 2);
  });

  test("the order of the times does not matter", () => {
    const p = project();
    const forward = zoomAmountSampler(p, session).amountsAt(times);
    const reversed = zoomAmountSampler(p, session).amountsAt([...times].reverse()).reverse();
    expect(reversed).toEqual(forward);
  });

  test("the windows are the derived ones, with their real bounds", () => {
    const w = zoomAmountSampler(project(), session).windows;
    expect(w).toHaveLength(3);
    expect(w[0]!.startNs).toBeLessThan(2000 * MS);
    expect(w[0]!.endNs).toBeGreaterThan(2000 * MS);
  });
});
