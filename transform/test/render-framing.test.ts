import { describe, test, expect } from "vitest";
import { DEFAULT_ZOOM, defaultProject } from "../src/trim.js";
import { render } from "../src/render.js";
import { framingLayout } from "../src/framing.js";
import type { Project, Session, SessionEvent } from "../src/types.js";

const MS = 1_000_000;
const duration = 12_000_000_000;
// One click at 2000 ms near the top-left, so a zoom crop clamps against the
// frame edge and the pointer sits OFF-centre in it. (STC-421's lesson: a click
// at dead centre maps centre to centre and passes against the bug.)
const events: SessionEvent[] = [
  { t: 2000 * MS, kind: "down", x: 300, y: 200, button: 0 },
  { t: 2050 * MS, kind: "up", x: 300, y: 200, button: 0 },
];

function session(camera = false): Session {
  return {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
      ...(camera ? { camera: { present: true, width: 1280, height: 720, firstFramePtsNs: 0,
                               lastFramePtsNs: 10_000 * MS, frameIntervalNs: 33 * MS } } : {}),
    },
    events, frames: [0, 16 * MS, 32 * MS],
    ...(camera ? { cameraFrames: Array.from({ length: 300 }, (_, i) => i * 33 * MS) } : {}),
  } as unknown as Session;
}

const noZoom = { ...DEFAULT_ZOOM, enabled: false };
const base = (over: Partial<Project> = {}): Project => ({ ...defaultProject(1920, 1080), ...over });
const framed = (over: Partial<Project> = {}): Project => base({ framing: { preset: "clean" }, ...over });

describe("render() with framing", () => {
  test("no framing: FrameState.framing is null", () => {
    expect(render(base(), session(), 3000 * MS).framing).toBeNull();
  });

  test("framing: carries the layout the pure module computes", () => {
    const fs = render(framed(), session(), 3000 * MS);
    expect(fs.framing).toEqual(framingLayout({ preset: "clean" }, { width: 1920, height: 1080 }, 1920 / 1080));
  });

  test("the cursor lands where the unframed UV maps into the content rect (zoom off)", () => {
    const un = render(base({ zoom: noZoom }), session(), 3000 * MS);
    const fr = render(framed({ zoom: noZoom }), session(), 3000 * MS);
    const c = fr.framing!.content;
    expect(fr.cursor.x).toBeCloseTo(c.x + (un.cursor.x / 1920) * c.width, 3);
    expect(fr.cursor.y).toBeCloseTo(c.y + (un.cursor.y / 1080) * c.height, 3);
  });

  test("...and under a zoom crop too: the crop is UV over the capture, so the same relation holds", () => {
    const un = render(base(), session(), 3000 * MS);
    const fr = render(framed(), session(), 3000 * MS);
    expect(un.zoom.crop).not.toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(fr.zoom.crop).toEqual(un.zoom.crop);
    const c = fr.framing!.content;
    expect(fr.cursor.x).toBeCloseTo(c.x + (un.cursor.x / 1920) * c.width, 3);
    expect(fr.cursor.y).toBeCloseTo(c.y + (un.cursor.y / 1080) * c.height, 3);
  });

  test("pointer size and velocity scale with the picture, not the canvas", () => {
    const un = render(base({ zoom: noZoom }), session(), 2020 * MS);
    const fr = render(framed({ zoom: noZoom }), session(), 2020 * MS);
    const k = fr.framing!.content.width / 1920;
    expect(fr.cursor.pxPerPoint).toBeCloseTo(un.cursor.pxPerPoint * k, 6);
    expect(fr.cursor.vx).toBeCloseTo(un.cursor.vx * k, 6);
  });

  test("the layout follows the output size (Embed), proportionally", () => {
    const big = render(framed(), session(), 3000 * MS).framing!.content;
    const small = render(framed({ output: { fps: 60, width: 1232, height: 693 } }), session(), 3000 * MS).framing!.content;
    expect(Math.abs(big.width / 1920 - small.width / 1232)).toBeLessThan(0.01);
  });

  test("the PiP stays inside the content rect with its normal margin", () => {
    const p = framed({ zoom: noZoom, pip: { enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 } });
    const fs = render(p, session(true), 3000 * MS);
    const c = fs.framing!.content;
    expect(fs.pip).not.toBeNull();
    expect(fs.pip!.x).toBeGreaterThanOrEqual(c.x);
    expect(fs.pip!.y).toBeGreaterThanOrEqual(c.y);
    expect(fs.pip!.x + fs.pip!.width).toBe(c.x + c.width - 32);
    expect(fs.pip!.y + fs.pip!.height).toBe(c.y + c.height - 32);
  });

  test("framing: absent changes nothing about the cursor or PiP (byte-identical to before)", () => {
    const a = render(base(), session(), 3000 * MS);
    const b = render({ ...base(), framing: undefined }, session(), 3000 * MS);
    expect(b).toEqual(a);
  });
});
