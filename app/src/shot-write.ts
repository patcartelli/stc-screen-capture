import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseShot, shotForWrite, type Shot, type Decoration } from "@transform/shot.js";
import { applyLook, type LookWrite } from "@transform/backgrounds.js";
import { THUMBNAIL_FILE } from "./library-items.js";

/**
 * Rewrite a stored shot's decoration (STC-297/599/628), the one way main
 * changes `shot.json` after the helper wrote it. The stored document is read,
 * `decorate` replaces the decoration and nothing else, and the result goes
 * back through `parseShot` before anything is written: a decoration the
 * schema would refuse throws here and never reaches the disk.
 *
 * Electron-free so the merge is unit tested; `main.ts`'s `still:writeShot` and
 * `captureStill` both come through here.
 *
 * Not atomic, deliberately: a half-written `shot.json` costs the DECORATION,
 * never the capture — `frame.png` is untouched and is what the shot is.
 */
export async function rewriteShot(dir: string, decorate: (stored: Shot) => Decoration): Promise<Shot> {
  const file = join(dir, "shot.json");
  const stored = parseShot(JSON.parse(await readFile(file, "utf8")));
  const next = parseShot({ ...stored, decoration: decorate(stored) });
  // Through `shotForWrite`, which decides the VERSION: a shot with no
  // annotations stays shot-1 and must not carry the v2-only key, since shot-1
  // declares additionalProperties: false and a document that fails its own
  // schema is the defect this project has now paid for three times.
  await writeFile(file, JSON.stringify(shotForWrite(next), null, 2));
  // The library's cached thumbnail (STC-294) was rendered from the document
  // that just changed. Dropped rather than re-rendered: this process has no
  // canvas, and the grid renders a missing one the next time the tile is on
  // screen. A failure here costs a stale picture, never the write.
  await rm(join(dir, THUMBNAIL_FILE), { force: true }).catch(() => {});
  return next;
}

/** Put a look on a stored shot: mode, background and shadow, nothing else. */
export const writeShotLook = (dir: string, write: LookWrite): Promise<Shot> =>
  rewriteShot(dir, (stored) => applyLook(stored.decoration, write));
