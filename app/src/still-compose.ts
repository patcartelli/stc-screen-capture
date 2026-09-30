import type { Shot } from "@transform/shot";
import { layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { colorSpaceFor, planRender, type ExportOptions, type RenderPlan } from "@transform/still-export";

/**
 * Composite a shot into a canvas at export scale and the display's own
 * colour space (STC-465 review, risk register row 17 / step-2 finding D1).
 *
 * Every renderer that turns a `Shot` into pixels bound for `still:export` —
 * today the post-capture panel (`thumbnail-renderer.ts`) and the still editor
 * (`still-editor-renderer.ts`) — needs the same two decisions made
 * identically, and "composite, then export" had drifted into two independent
 * copies before this existed:
 *
 * 1. **Scale.** The canvas must be sized from `planRender`'s SCALED layout
 *    (`plan.layout.canvas`), never from `layoutStill`'s raw one. A `1x`
 *    export of a `2x` capture halves the layout; sizing the canvas from the
 *    unscaled layout draws the picture into the top-left corner of a canvas
 *    twice as big and then hands THAT size to `still:export`, so the file
 *    lands at native resolution however the user set the scale preference.
 *    Invisible at the default `native` scale (factor 1), which is how the
 *    still editor's own copy of this drifted without anyone noticing.
 * 2. **Colour space.** The 2D context must be created with the shot's own
 *    `colorSpace` (`colorSpaceFor(shot.display.colorSpace)`). An untagged
 *    context reads and writes plain sRGB numbers; `still:export`'s request
 *    still declares `shot.display.colorSpace`, and `main.ts` tags the
 *    ENCODED file with it regardless of what the canvas actually did. A P3
 *    capture composited on an untagged (sRGB) context and then tagged
 *    `display-p3` on the way out is oversaturated on any P3-calibrated
 *    screen — the numbers didn't change, but what they now MEAN did.
 *
 * Callers still own the fallback-to-PNG decision (`stillIsBlocked`, when a
 * stored format cannot carry the alpha a mode needs) and the shot they pass
 * in — a live decoration in progress, an already-persisted document, or a
 * mode's derived preset. This only turns a `Shot` + its decoded frame + the
 * `ExportOptions` that survived that decision into pixels.
 */
export function composeStill(
  shot: Shot,
  frame: ImageBitmap,
  options: ExportOptions,
): { canvas: HTMLCanvasElement; plan: RenderPlan } {
  const layout = layoutStill(shot);
  const pxPerPoint = pxPerPointOf(shot);
  const plan = planRender(options, { layout, pxPerPoint });

  const canvas = document.createElement("canvas");
  canvas.width = plan.layout.canvas.width;
  canvas.height = plan.layout.canvas.height;
  const ctx = canvas.getContext("2d", {
    alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never,
  });
  if (!ctx) throw new Error("no 2d context for a still composite");
  // Sampled from the FRAME, not a previous composite: a region is normalised
  // against the frame, and reading an existing composite would read pixels an
  // earlier fill had already replaced.
  const redactionFills = sampleRedactionFills(frame, shot.frame, shot.decoration.redactions);
  renderStill(ctx as never, { frame, redactionFills }, plan.layout);
  return { canvas, plan };
}

/** The raw RGBA bytes of a composed canvas, ready for `still:export`'s `bytes`. */
export function stillPixelBytes(canvas: HTMLCanvasElement): ArrayBuffer {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("no 2d context to read a still composite back from");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}
