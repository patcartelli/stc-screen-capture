import { describe, test, expect } from "vitest";
import { recorder } from "./_canvas-recorder.js";
import { renderStill, coverRect, type StillRenderContext } from "../src/still-render.js";
import { layoutStill, PRESET_SHADOW } from "../src/still-decorate.js";
import { parseShot, type Shot } from "../src/shot.js";

/** STC-628: an image or wallpaper background is cover-cropped, never stretched. */

describe("coverRect", () => {
  test("same aspect uses the whole source", () => {
    expect(coverRect(1600, 1000, 800, 500)).toEqual({ sx: 0, sy: 0, sw: 1600, sh: 1000 });
  });
  test("a taller canvas crops the sides", () => {
    expect(coverRect(1600, 1000, 500, 500)).toEqual({ sx: 300, sy: 0, sw: 1000, sh: 1000 });
  });
  test("a wider canvas crops the top and bottom", () => {
    expect(coverRect(1000, 1000, 800, 400)).toEqual({ sx: 0, sy: 250, sw: 1000, sh: 500 });
  });
});

const shotWith = (background: Record<string, unknown>): Shot => parseShot({
  version: 3,
  kind: "window",
  capturedAtNs: "1000000000",
  timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
             backingScale: 2, originX: 0, originY: 0 },
  window: { id: 7, bounds: { x: 200, y: 120, width: 800, height: 600 } },
  frame: { file: "frame.png", width: 1600, height: 1200, alpha: true },
  decoration: {
    mode: "window-shadow-background", canvas: "1:1", cursor: false, redactions: [],
    paddingPct: 0.09, shadow: { ...PRESET_SHADOW }, background,
  },
});

const drawImages = (ops: string[]) => ops.filter((o) => o.startsWith("drawImage("));

describe("renderStill background drawing", () => {
  test("a wallpaper is drawn with the cover source rectangle", () => {
    const layout = layoutStill(shotWith({ kind: "wallpaper", colors: ["#222222"] }));
    const { canvas } = layout;
    const { ctx, ops } = recorder();
    const img = { width: 1600, height: 1000 };
    renderStill(ctx as unknown as StillRenderContext, { frame: "<frame>", background: img }, layout);
    const r = coverRect(1600, 1000, canvas.width, canvas.height);
    expect(r.sw).not.toBe(1600);   // the canvas is square, so this really crops
    expect(drawImages(ops)[0]).toBe(
      `drawImage(${String(img)},${r.sx},${r.sy},${r.sw},${r.sh},0,0,${canvas.width},${canvas.height})`);
  });

  test("a mesh keeps the 5-argument form", () => {
    const layout = layoutStill(shotWith({
      kind: "mesh", colors: ["#111111", "#444444", "#888888"], seed: 1, sheen: 0.3, warp: 0.2,
      scale: 1, grain: false, points: null, t: 0,
    }));
    const { ctx, ops } = recorder();
    const img = { width: 1600, height: 1000 };
    renderStill(ctx as unknown as StillRenderContext, { frame: "<frame>", background: img }, layout);
    expect(drawImages(ops)[0]).toBe(
      `drawImage(${String(img)},0,0,${layout.canvas.width},${layout.canvas.height})`);
  });
});
