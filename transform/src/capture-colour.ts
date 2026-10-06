/**
 * The colour space a take's PIXELS are in, and what a sink does about it (STC-510).
 *
 * The helper captures a recording on a wide-gamut display as Display P3 and records
 * that in `anchors.capture.colorSpace` (anchors-9, written only when it is not sRGB).
 * Everything that draws the take has to know, or it draws it into the browser's
 * default sRGB canvas and clips the colours the capture kept: measured on a real P3
 * take, an export came out with the P3-green swatch and the sRGB-green swatch the
 * SAME green.
 *
 * ONE function decides the canvas, and the preview and the export both call it. The
 * sinks may not fork the transform (the repo's non-negotiable), and a canvas colour
 * space is exactly the kind of setting that forks quietly: two `getContext` calls
 * that each remember to ask, or one that forgets.
 *
 * Absent means sRGB, which is what every take before anchors-9 is. An unknown name
 * is REFUSED, never read as sRGB: a document naming a space this build does not
 * know is a document it cannot draw correctly.
 */
import type { Anchors } from "./types.js";
import { SessionLoadError } from "./session-error.js";

/** Every colour space `anchors.capture.colorSpace` may name. */
export const CAPTURE_COLOR_SPACES = ["displayP3"] as const;

/** The canvas colour space for this take: what to pass to `getContext("2d", { colorSpace })`. */
export function canvasColorSpace(anchors: Pick<Anchors, "capture">): PredefinedColorSpace {
  return anchors.capture.colorSpace === "displayP3" ? "display-p3" : "srgb";
}

/**
 * Refuses a colour space this build does not know, and one claimed on a version that
 * cannot carry it (the field is new at anchors-9, so on an older document it is a
 * body that says one thing and a version that says another).
 */
export function checkCaptureColour(anchors: Pick<Anchors, "version" | "capture">): void {
  const space = anchors.capture.colorSpace;
  if (space === undefined) return;
  if (anchors.version < 9) {
    throw new SessionLoadError(`capture.colorSpace is new at anchors v9, found on v${anchors.version}`);
  }
  if (!(CAPTURE_COLOR_SPACES as readonly unknown[]).includes(space)) {
    throw new SessionLoadError(`capture.colorSpace "${String(space)}" is not a space this build can draw (known: ${CAPTURE_COLOR_SPACES.join(", ")})`);
  }
}
