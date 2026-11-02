import { WALLPAPER_FILE } from "@transform/backgrounds.js";

/**
 * Which file names `still:frame` reads out of a shot folder for a renderer.
 *
 * Any plain `*.png` leaf (the frame, whatever it was named), or EXACTLY the
 * wallpaper's own name — a JPEG since STC-628. Deliberately not "any `.jpg`":
 * the channel hands file bytes to a sandboxed renderer, and the only JPEG a
 * shot folder is meant to hold is the one the helper writes. No path, no `..`.
 */
export function stillFrameNameAllowed(name: string): boolean {
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9._-]+\.png$/.test(name) || name === WALLPAPER_FILE;
}
