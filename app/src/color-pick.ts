/**
 * The color picker's decisions (STC-627). No Electron, no DOM, no helper.
 *
 * The helper's `pick-color` shows the system loupe (`NSColorSampler`) and
 * replies with the sampled color converted to EXTENDED sRGB, as floats. This
 * file turns that into the hex string for the clipboard and the words for the
 * toast.
 *
 * ## Which space: sRGB, always
 *
 * The ticket's acceptance is Digital Color Meter's sRGB reading, and `#rrggbb`
 * is read as sRGB by every design tool and browser it gets pasted into. A
 * Display P3 hex would paste as a visibly different color. So the value is
 * always sRGB.
 *
 * A P3 pixel can lie outside sRGB (extended sRGB components below 0 or above
 * 1). `#rrggbb` cannot hold that, so it is clamped to the nearest sRGB value
 * and the toast says so. A color inside sRGB, on any display, is not clamped
 * and says nothing about space.
 *
 * ## States
 *
 * picking (the loupe is up), copied, cancelled (Esc: nothing copied, nothing
 * shown), failed (a toast says why). `pickOutcome` maps a helper reply onto the
 * last three; "picking" is main holding the one in-flight request.
 */
import type { ToastMessage } from "./toast-message.js";

/** Extended-sRGB components, 0..1 inside the gamut. */
export interface SampledColor { r: number; g: number; b: number }

/** One level of an 8-bit channel is 1/255; half of it is what rounding forgives. */
const ROUNDING = 0.5 / 255;

const channel = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** `#rrggbb`, lower case, and whether clamping into sRGB changed the color. */
export function formatHex(c: SampledColor): { hex: string; clamped: boolean } {
  const hex = "#" + [c.r, c.g, c.b].map((v) => channel(v).toString(16).padStart(2, "0")).join("");
  const clamped = [c.r, c.g, c.b].some((v) => v < -ROUNDING || v > 1 + ROUNDING);
  return { hex, clamped };
}

/** The toast for a copied color: swatch, the value, and the space only if it matters. */
export function copiedToast(c: SampledColor): ToastMessage & { swatch: string } {
  const { hex, clamped } = formatHex(c);
  return {
    title: hex,
    body: clamped
      ? "Copied to the clipboard. Outside sRGB, so it was clamped to the nearest sRGB value."
      : "Copied to the clipboard.",
    tone: "success",
    swatch: hex,
  };
}

export type PickOutcome =
  | { kind: "copied"; hex: string; toast: ToastMessage & { swatch: string } }
  | { kind: "cancelled" }
  | { kind: "failed"; toast: ToastMessage };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What a `pick-color` reply means. Anything that is not a clear pick or a clear cancel is a failure. */
export function pickOutcome(reply: Record<string, unknown> | undefined): PickOutcome {
  if (reply?.cancelled === true) return { kind: "cancelled" };
  if (reply && finite(reply.r) && finite(reply.g) && finite(reply.b)) {
    const c = { r: reply.r, g: reply.g, b: reply.b };
    return { kind: "copied", hex: formatHex(c).hex, toast: copiedToast(c) };
  }
  return pickFailure("The color picker returned no color.");
}

/** A visible message for a sampler that was refused, unavailable or never answered. */
export function pickFailure(detail: string): PickOutcome & { kind: "failed" } {
  return {
    kind: "failed",
    toast: { title: "Couldn't pick a color", body: detail },
  };
}
