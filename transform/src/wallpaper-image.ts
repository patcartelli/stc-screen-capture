import type { DrawableImage } from "./session.js";

/**
 * The ONE decode of a take's wallpaper (STC-626): preview, export, Copy and the
 * identity gate all come through here, so every sink draws the same pixels.
 *
 * Never rejects. A file that is missing or will not decode is `null`, and
 * `composite()` then draws the background's fallback colour in every sink alike,
 * so a lost file costs the picture, never the take.
 */
export async function decodeWallpaper(bytes: ArrayBuffer | null | undefined): Promise<DrawableImage | null> {
  if (!bytes) return null;
  try {
    return await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return null;
  }
}
