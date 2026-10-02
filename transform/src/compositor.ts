import type { FrameState } from "./render.js";
import { isWholeFrame, uvRectToPixels, type Rect } from "./spaces.js";
import { gradientLine, type FramingLayout } from "./framing.js";
import { CLICK_HIGHLIGHT_PT, drawCircle, drawCursor } from "./cursor-art.js";
import { KEYCAST_BG_ALPHA, KEYCAST_BG_RGB, KEYCAST_TEXT_COLOR, keycastFont, keycastFontPx, keycastLayout, keycastText } from "./keycast.js";

/**
 * The one compositor. Both sinks call exactly this with identical inputs, and
 * that is what makes the pre-encode RGBA gate meaningful. Sinks may not fork
 * this any more than they may fork render().
 *
 * The contexts are NOT identically configured, and an earlier version of this
 * comment said they were: the gates and a hashing export use
 * { alpha: false, willReadFrequently: true } (software raster, so pixels can
 * be read back), while the app's preview and a plain export use { alpha: false }
 * alone. PHASE-2 measured the two raster paths byte-identical on this machine;
 * the identity gate compares them for real, inside one browser, and
 * export-identity.slow pins both processes to software because across
 * rasterizers they differ (CLAUDE.md, the rasterization-backend trap).
 */
/**
 * A decoded frame reaches the compositor as either shape: the gates decode
 * everything up front through `decodeAll()` into real `ImageBitmap`s, while
 * both real sinks (`export.ts`'s `ForwardFrameSource`, `preview.ts`'s
 * `SeekingFrameSource`) stream a raw `VideoFrame` per WebCodecs' own memory
 * discipline (PHASE-0 §4b — never buffer a VideoFrame). The two do not share
 * a `.width`/`.height`: `ImageBitmap` has them, `VideoFrame` does not (it has
 * `codedWidth`/`codedHeight` and `displayWidth`/`displayHeight` instead) — so
 * a cast from one to the other, which every real caller used to do to satisfy
 * this file's old `ImageBitmap`-only signature, typechecked a lie. Found by
 * watching a real take: any crop narrower than the full frame read
 * `frame.width` as `undefined`, `uvRectToPixels` propagated `NaN` all the way
 * through, and `drawImage` with a non-finite source rect draws nothing per
 * spec — no exception, the canvas simply keeps its black fill. `gate:identity`
 * never caught it because the gate's own harness is the ImageBitmap path, not
 * the one either real sink runs.
 */
type DecodedFrame = ImageBitmap | VideoFrame;

function frameSize(frame: DecodedFrame): { width: number; height: number } {
  return "displayWidth" in frame
    ? { width: frame.displayWidth, height: frame.displayHeight }
    : { width: frame.width, height: frame.height };
}

/**
 * The display frame, cropped to the zoom's rectangle.
 *
 * The full-frame case takes the FIVE-argument `drawImage` rather than the
 * nine-argument one with a full source rect. The two are equivalent by spec
 * and this repo does not make claims about rasterisers it does not control —
 * CLAUDE.md records the pre-encode hash already differing between GPU and
 * swiftshader for far simpler drawing. Taking the old call when the crop is
 * the whole frame makes "auto-zoom stage 1 changes no pixels" true by
 * CONSTRUCTION rather than by a measurement that might not hold on the next
 * Chromium. The nine-argument path goes live the moment ANY window's crop is
 * not the whole frame — first reachable by a MANUAL override (STC-330), on
 * purpose, ahead of stage 2's automatic targets (STC-326).
 *
 * The crop is UV over the CAPTURE, so it is converted against the frame's own
 * size through spaces.ts — the one owner (STC-314).
 */
function drawSource(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: DecodedFrame,
  fs: FrameState,
  dest: Rect,
): void {
  const c = fs.zoom.crop;
  if (isWholeFrame(c)) {
    ctx.drawImage(frame, dest.x, dest.y, dest.width, dest.height);
    return;
  }
  const { width: fw, height: fh } = frameSize(frame);
  const src = uvRectToPixels(c, { x: 0, y: 0, width: fw, height: fh });
  ctx.drawImage(frame, src.x, src.y, src.width, src.height, dest.x, dest.y, dest.width, dest.height);
}

/**
 * The frame's chrome (STC-396): the background over the whole canvas, then the
 * shadow, cast from the rounded content rect.
 *
 * The shadow is drawn WITHOUT a core: the rounded rect is filled far off-canvas
 * to the left and `shadowOffsetX` shifts its shadow back into place, so only the
 * shadow lands on the canvas and no opaque shape is painted. A core would be
 * covered by the picture's ANTIALIASED rounded clip, so at the corner the edge
 * coverage applies twice (black core, then a partial picture over it) and the
 * corner reads darker than the background — a seam. The shift exceeds the
 * canvas width plus the blur's reach, so the shape itself is never visible.
 */
function drawChrome(
  ctx: OffscreenCanvasRenderingContext2D, f: FramingLayout, width: number, height: number,
): void {
  const bg = f.background;
  if (bg.kind === "solid") {
    ctx.fillStyle = bg.color;
  } else {
    const l = gradientLine(bg.angleDeg, width, height);
    const g = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
    g.addColorStop(0, bg.colors[0]);
    g.addColorStop(1, bg.colors[1]);
    ctx.fillStyle = g;
  }
  ctx.fillRect(0, 0, width, height);

  if (f.shadow.opacity > 0 && f.shadow.blur > 0) {
    const c = f.content;
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${f.shadow.opacity})`;
    ctx.shadowBlur = f.shadow.blur;
    const SHIFT = width * 2 + 1000;
    ctx.shadowOffsetX = SHIFT;
    ctx.shadowOffsetY = f.shadow.offsetY;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.roundRect(c.x - SHIFT, c.y, c.width, c.height, f.radius);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * The keycast pill (STC-419), on the OUTPUT canvas after everything else —
 * a caption, not part of the picture, so the zoom never moves or scales it.
 * keycast.ts decides the text and the box; this only draws them.
 */
function drawKeycast(
  ctx: OffscreenCanvasRenderingContext2D, k: NonNullable<FrameState["keycast"]>, width: number, height: number,
): void {
  const text = keycastText(k);
  ctx.save();
  ctx.font = keycastFont(keycastFontPx(width));
  const box = keycastLayout(width, height, ctx.measureText(text).width);
  ctx.globalAlpha = k.opacity;
  ctx.fillStyle = `rgba(${KEYCAST_BG_RGB}, ${KEYCAST_BG_ALPHA})`;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, box.radius);
  ctx.fill();
  ctx.fillStyle = KEYCAST_TEXT_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, box.textX, box.textY, box.maxTextWidth);
  ctx.restore();
}

export function composite(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: DecodedFrame | null,
  camera: DecodedFrame | null,
  fs: FrameState,
  width: number,
  height: number,
): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const framing = fs.framing;
  if (framing) drawChrome(ctx, framing, width, height);
  if (frame) {
    if (framing) {
      const c = framing.content;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(c.x, c.y, c.width, c.height, framing.radius);
      ctx.clip();
      drawSource(ctx, frame, fs, c);
      ctx.restore();
    } else {
      drawSource(ctx, frame, fs, { x: 0, y: 0, width, height });
    }
  }

  // The PiP and the pointer live ON the picture, so a framed take clips them to
  // it: a pointer on another display is outside the capture, and unframed the
  // canvas edge hides it — framed, it would otherwise be painted over the
  // background. The keycast below is a caption on the canvas and is not clipped.
  if (framing) {
    const c = framing.content;
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.width, c.height);
    ctx.clip();
  }

  // The PiP sits UNDER the cursor deliberately: a cursor over the bottom-right
  // corner must stay visible. render() has already decided the rectangle; this
  // only draws it. Drawn only when both the geometry and a decoded frame exist
  // — no frame yet is a black gap, not a stretched stale one.
  if (fs.pip && camera) {
    ctx.drawImage(camera, fs.pip.x, fs.pip.y, fs.pip.width, fs.pip.height);
  }

  if (fs.cursor.visible) {
    // The click highlight sits UNDER the pointer, centred on the hotspot, so the
    // artwork stays legible through a click. (x, y) IS the hotspot: macOS
    // reports event locations at the hotspot, and cursor-art.ts puts each
    // shape's hotspot at its origin.
    const { x, y, pxPerPoint, pressed, showClicks, shape, style } = fs.cursor;
    if (pressed && showClicks) {
      ctx.beginPath();
      ctx.arc(x, y, CLICK_HIGHLIGHT_PT * pxPerPoint, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fill();
    }
    if (style === "circle") drawCircle(ctx, x, y, pxPerPoint);
    else drawCursor(ctx, shape, x, y, pxPerPoint);
  }

  if (framing) ctx.restore();

  if (fs.keycast) drawKeycast(ctx, fs.keycast, width, height);
}
