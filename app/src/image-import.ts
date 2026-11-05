import { copyFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { shotForWrite, defaultDecoration, parseShot } from "@transform/shot.js";
import { createTake } from "./takes.js";

/**
 * Open an image this app did not capture (STC-575).
 *
 * **It is imported, not edited in place.** The rule that both editors open
 * library takes only (`insideTakesRoot`) is what keeps the user's own files
 * out of reach of a redaction, a re-decoration and a Trash: the library owns
 * `shot.json`, the pixels and the right to delete them. An image the user
 * picked from Downloads becomes a NEW shot beside the others, a copy, and the
 * original is never touched. The cost is a copy on disk, which is also what
 * Duplicate costs.
 *
 * **What `shot.json` says for a picture with no display behind it** is the
 * honest minimum, not a made-up capture: a display-crop of the whole image,
 * one point per pixel, `backingScale` 1, display id 0 at the origin, and no
 * `colorSpace` (the field is optional, and absent is exactly what the helper
 * writes when a colour space has no name, STC-478). `capturedAtNs` is the
 * import time, in nanoseconds against a 1/1 timebase: there is no mach clock
 * for a file. Scale 1 means a 2x screenshot from elsewhere is treated as a
 * large 1x picture; nothing here can know better.
 */
export const IMPORT_EXTENSIONS = [".png", ".jpg", ".jpeg"] as const;

/** What the picker offers, as Electron's `filters` spell it. */
export const IMPORT_FILTER = { name: "Images", extensions: IMPORT_EXTENSIONS.map((e) => e.slice(1)) };

export const FRAME_FILE = "frame.png";

export function canImport(file: string): boolean {
  return (IMPORT_EXTENSIONS as readonly string[]).includes(extname(file).toLowerCase());
}

/** The sentence shown when `file` is not something the editor can open. */
export function importRefusal(file: string): string {
  return `Capture can open ${IMPORT_EXTENSIONS.join(", ")} images; “${file}” is not one of them.`;
}

/** The shot document for an imported picture of `width` × `height` pixels. */
export function importedShot(width: number, height: number, at: Date) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("that image has no size this app can read");
  }
  return shotForWrite(parseShot({
    version: 1,
    kind: "display-crop",
    capturedAtNs: (BigInt(at.getTime()) * 1_000_000n).toString(),
    timebase: { numer: 1, denom: 1 },
    display: { id: 0, pointWidth: width, pointHeight: height, pixelWidth: width, pixelHeight: height,
               backingScale: 1, originX: 0, originY: 0 },
    crop: { x: 0, y: 0, width, height },
    frame: { file: FRAME_FILE, width, height, alpha: false },
    decoration: defaultDecoration("display-crop"),
  }));
}

/** An image read for import: its size, and PNG bytes when the source is not already a PNG. */
export interface DecodedImage { width: number; height: number; png?: Buffer }

/**
 * Copy `src` into the library as a new shot and return its directory.
 *
 * `decode` is the Electron half (`nativeImage`), injected so this stays a node
 * module the unit tests can drive. A PNG is copied byte for byte, so its
 * colour profile survives; any other format is re-encoded by `decode` and
 * loses its profile, which the runbook records.
 */
export async function importImage(env: NodeJS.ProcessEnv, saveFolder: string | null, src: string,
                                  decode: (file: string) => Promise<DecodedImage>,
                                  at: Date = new Date()): Promise<string> {
  if (!canImport(src)) throw new Error(importRefusal(src));
  const image = await decode(src);
  const shot = importedShot(image.width, image.height, at);
  return createTake(env, saveFolder, async (dest) => {
    if (image.png) await writeFile(join(dest, FRAME_FILE), image.png);
    else await copyFile(src, join(dest, FRAME_FILE));
    await writeFile(join(dest, "shot.json"), JSON.stringify(shot, null, 2));
  });
}
