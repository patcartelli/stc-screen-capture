import { describe, test, expect } from "vitest";
import { composite } from "../src/compositor.js";
import { FULL_FRAME_UV, type FrameState } from "../src/render.js";
import { CIRCLE_PT, CLICK_HIGHLIGHT_PT } from "../src/cursor-art.js";
import { recorder } from "./_canvas-recorder.js";
import { framingLayout } from "../src/framing.js";

/**
 * Node has no canvas, so this cannot check pixels — the browser gates do that,
 * and they compare the two sinks' pixels for real. What a recording context
 * CAN pin is the drawing ORDER and the numbers handed to the context: where
 * the hotspot lands, that the click highlight is under the pointer and sized
 * from the same scale, and that an invisible cursor draws nothing at all.
 */
function frameState(over: Partial<FrameState["cursor"]> = {}): FrameState {
  return {
    tick: 0, frameIndex: null, framePtsNs: null, pip: null,
    zoom: { amount: 0, crop: FULL_FRAME_UV },
    keycast: null,
    framing: null,
    cursor: {
      x: 300.5, y: 200.25, vx: 0, vy: 0, pressed: false, showClicks: true, visible: true,
      shape: "arrow", style: "default", pxPerPoint: 1.5, ...over,
    },
  };
}

function draw(fs: FrameState) {
  const { ctx, ops } = recorder();
  composite(ctx as unknown as OffscreenCanvasRenderingContext2D, null, null, fs, 640, 360);
  return ops;
}

describe("auto-zoom stage 1 draws the source, and the stub changes nothing", () => {
  const bitmap = { width: 1280, height: 720 } as unknown as ImageBitmap;
  // What export.ts's ForwardFrameSource and preview.ts's SeekingFrameSource
  // ACTUALLY hand the compositor — a VideoFrame, which has no .width/.height
  // (WebCodecs: codedWidth/codedHeight, displayWidth/displayHeight). A fake
  // shaped like `bitmap` above shares the bug's own wrong assumption and
  // cannot catch it; this shape is what found it on a real take.
  const videoFrame = { displayWidth: 1280, displayHeight: 720 } as unknown as VideoFrame;

  function drawWith(
    crop: { x: number; y: number; width: number; height: number },
    frame: ImageBitmap | VideoFrame = bitmap,
  ): string[] {
    const { ctx, ops } = recorder();
    const fs: FrameState = { ...frameState(), zoom: { amount: 1, crop } };
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, frame, null, fs, 640, 360);
    return ops.filter((o) => o.startsWith("drawImage"));
  }

  test("the full-frame stub takes the FIVE-argument call, byte for byte the old one", () => {
    // The load-bearing claim of this slice: stage 1 is in the render path and
    // changes no pixels. Nine-argument drawImage with a full source rect is
    // equivalent BY SPEC, and this repo does not make claims about rasterisers
    // it does not control — so the old call is taken, and that is checkable
    // here rather than hoped for in a browser.
    expect(drawWith(FULL_FRAME_UV)).toEqual(["drawImage([object Object],0,0,640,360)"]);
  });

  test("a real crop takes the NINE-argument call, in capture pixels", () => {
    // The control. Without it, the test above is also satisfied by a
    // compositor that ignores the crop entirely — which is exactly the bug
    // that would make STC-326 look wired up while drawing the whole frame.
    expect(drawWith({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }))
      .toEqual(["drawImage([object Object],320,360,640,180,0,0,640,360)"]);
  });

  test("the two paths really differ — otherwise the guard above is decoration", () => {
    expect(drawWith(FULL_FRAME_UV)).not.toEqual(drawWith({ x: 0, y: 0, width: 0.5, height: 0.5 }));
  });

  test("a raw VideoFrame crops identically to an ImageBitmap of the same size", () => {
    // The regression this repo actually shipped (STC-326/330): drawSource
    // read frame.width/height directly, which is undefined on a VideoFrame,
    // so uvRectToPixels produced NaN and drawImage silently drew nothing —
    // no exception, the canvas just kept its black fill. Neither sink's own
    // frame source (ForwardFrameSource, SeekingFrameSource) ever hands the
    // compositor an ImageBitmap; only the gate's decodeAll() path does, which
    // is why gate:identity never saw it.
    const crop = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
    expect(drawWith(crop, videoFrame)).toEqual(drawWith(crop, bitmap));
    expect(drawWith(crop, videoFrame)).toEqual(["drawImage([object Object],320,360,640,180,0,0,640,360)"]);
  });
});

describe("composite() draws the pointer at the hotspot", () => {
  test("the artwork is translated to exactly (cursor.x, cursor.y) and scaled by pxPerPoint", () => {
    const ops = draw(frameState());
    expect(ops).toContain("translate(300.5,200.25)");
    expect(ops).toContain("scale(1.5,1.5)");
  });

  test("an invisible cursor draws nothing after the frame", () => {
    const ops = draw(frameState({ visible: false }));
    expect(ops.filter((o) => /^(translate|arc|moveTo|stroke)\(/.test(o))).toEqual([]);
  });

  test("a click draws the highlight UNDER the pointer, centred on the hotspot, sized in points", () => {
    const ops = draw(frameState({ pressed: true }));
    const arc = ops.findIndex((o) => o.startsWith("arc("));
    const translate = ops.indexOf("translate(300.5,200.25)");
    expect(arc).toBeGreaterThan(-1);
    expect(arc).toBeLessThan(translate);
    expect(ops[arc]).toBe(`arc(300.5,200.25,${CLICK_HIGHLIGHT_PT * 1.5},0,${Math.PI * 2})`);
  });

  test("showClicks off: a held button draws no highlight, and the pointer still draws (STC-420)", () => {
    const ops = draw(frameState({ pressed: true, showClicks: false }));
    expect(ops.some((o) => o.startsWith("arc("))).toBe(false);
    expect(ops).toContain("translate(300.5,200.25)");
  });

  test("showClicks off with style: circle keeps the disc but not the highlight (STC-420)", () => {
    const ops = draw(frameState({ style: "circle", pressed: true, showClicks: false }));
    const arcs = ops.filter((o) => o.startsWith("arc("));
    expect(arcs).toEqual([`arc(300.5,200.25,${CIRCLE_PT * 1.5},0,${Math.PI * 2})`]);
  });

  test("no highlight when no button is held", () => {
    const ops = draw(frameState({ pressed: false }));
    expect(ops.some((o) => o.startsWith("arc("))).toBe(false);
  });

  test("style: circle draws the placeholder disc at the hotspot and no artwork", () => {
    const ops = draw(frameState({ style: "circle", shape: "ibeam" }));
    expect(ops).toContain(`arc(300.5,200.25,${CIRCLE_PT * 1.5},0,${Math.PI * 2})`);
    expect(ops.some((o) => /^(translate|moveTo)\(/.test(o))).toBe(false);
    // white disc, black ring, ring width in points
    expect(ops.indexOf("fillStyle=#ffffff")).toBeLessThan(ops.indexOf("fill()"));
    expect(ops.indexOf("strokeStyle=#000000")).toBeLessThan(ops.indexOf("stroke()"));
    expect(ops).toContain(`lineWidth=${2 * 1.5}`);
  });

  test("style: circle still draws the click highlight under the disc", () => {
    const ops = draw(frameState({ style: "circle", pressed: true }));
    const arcs = ops.filter((o) => o.startsWith("arc("));
    expect(arcs[0]).toBe(`arc(300.5,200.25,${CLICK_HIGHLIGHT_PT * 1.5},0,${Math.PI * 2})`);
    expect(arcs[1]).toBe(`arc(300.5,200.25,${CIRCLE_PT * 1.5},0,${Math.PI * 2})`);
  });

  test("the FrameState's shape decides which artwork is traced", () => {
    // A compositor that ignored `shape` and always drew the arrow would pass
    // every positional test above. Two shapes must produce two traces.
    const outline = (ops: string[]) => ops.filter((o) => /^(moveTo|lineTo|quadraticCurveTo)\(/.test(o)).join(";");
    expect(outline(draw(frameState({ shape: "ibeam" })))).not.toBe(outline(draw(frameState({ shape: "arrow" }))));
  });
});

describe("framing (STC-396)", () => {
  const bitmap = { width: 1280, height: 720 } as unknown as ImageBitmap;
  const W = 640, H = 360;
  const layout = framingLayout({ preset: "clean" }, { width: W, height: H }, 16 / 9)!;
  const c = layout.content;
  const contentRect = `rect(${c.x},${c.y},${c.width},${c.height})`;

  function drawFramed(over: Partial<FrameState["cursor"]> = {}, extra: Partial<FrameState> = {}) {
    const { ctx, ops } = recorder();
    (ctx as unknown as { measureText: unknown }).measureText = () => ({ width: 50 });
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState(over), framing: layout, ...extra }, W, H);
    return ops;
  }
  const idx = (ops: string[], prefix: string, from = 0) => ops.findIndex((o, i) => i >= from && o.startsWith(prefix));

  test("order: background, shadow, then a rounded clip, then the picture inside the content rect", () => {
    const ops = drawFramed({ visible: false });
    const gradient = idx(ops, "createLinearGradient");
    const bgFill = idx(ops, `fillRect(0,0,${W},${H})`, gradient);
    const shadow = idx(ops, `shadowBlur=${layout.shadow.blur}`);
    const clip = idx(ops, "clip(");
    const picture = idx(ops, `drawImage(${String(bitmap)},${c.x},${c.y},${c.width},${c.height})`);
    expect(gradient).toBeGreaterThan(-1);
    expect(bgFill).toBeGreaterThan(gradient);
    expect(shadow).toBeGreaterThan(bgFill);
    expect(clip).toBeGreaterThan(shadow);
    expect(picture).toBeGreaterThan(clip);
    expect(ops.some((o) => o === `roundRect(${c.x},${c.y},${c.width},${c.height},${layout.radius})`)).toBe(true);
  });

  test("the cursor is clipped to the content rect: save, rect, clip BEFORE it, restore AFTER it and before the keycast", () => {
    const ops = drawFramed({ visible: true, pressed: true },
      { keycast: { label: "A", count: 1, opacity: 1 } });
    const picture = idx(ops, `drawImage(${String(bitmap)},`);
    const rectOp = idx(ops, contentRect, picture);
    const clipOp = idx(ops, "clip(", rectOp);
    const saveOp = ops.lastIndexOf("save()", rectOp);
    const cursorOp = idx(ops, "arc(", clipOp);          // the click highlight, the first cursor op
    const lastCursorOp = ops.reduce((last, o, i) => (/^(moveTo|lineTo|quadraticCurveTo|arc)\(/.test(o) ? i : last), -1);
    const restoreOp = idx(ops, "restore()", lastCursorOp);
    const keycastSave = idx(ops, "save()", restoreOp);
    expect(picture).toBeGreaterThan(-1);
    expect(saveOp).toBeGreaterThan(picture);            // after the picture's own restore
    expect(rectOp).toBeGreaterThan(saveOp);
    expect(clipOp).toBeGreaterThan(rectOp);
    expect(cursorOp).toBeGreaterThan(clipOp);
    expect(restoreOp).toBeGreaterThan(lastCursorOp);
    // the keycast is a caption on the canvas: drawn after the clip is undone
    expect(keycastSave).toBeGreaterThan(restoreOp);
    expect(idx(ops, "fillText(", keycastSave)).toBeGreaterThan(keycastSave);
  });

  test("a solid background fills with the colour, no gradient", () => {
    const solid = framingLayout({ preset: "solid", color: "#112233" }, { width: W, height: H }, 16 / 9)!;
    const { ctx, ops } = recorder();
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), framing: solid }, W, H);
    expect(ops.some((o) => o.startsWith("createLinearGradient"))).toBe(false);
    expect(ops).toContain("fillStyle=#112233");
  });

  test("a zoom crop under framing draws the crop's source rect into the content rect", () => {
    const { ctx, ops } = recorder();
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), zoom: { amount: 1, crop }, framing: layout }, W, H);
    expect(ops.some((o) => o === `drawImage(${String(bitmap)},128,144,640,360,${c.x},${c.y},${c.width},${c.height})`)).toBe(true);
  });

  test("framing: null draws exactly the pre-framing sequence (no clip, no gradient, no shadow)", () => {
    const { ctx, ops } = recorder();
    composite(ctx as unknown as OffscreenCanvasRenderingContext2D, bitmap, null,
              { ...frameState({ visible: false }), framing: null }, W, H);
    expect(ops.some((o) => o.startsWith("clip(") || o.startsWith("createLinearGradient") || o.startsWith("shadow"))).toBe(false);
    expect(ops).toContain(`drawImage(${String(bitmap)},0,0,${W},${H})`);
  });
});
