import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WALLPAPER_FILE } from "@transform/looks.js";

/**
 * Reading a take's wallpaper (STC-626). No Electron: the helper's `wallpaper`
 * verb is handed in, so a test can stand in for it.
 *
 * ## Why during the countdown, and why a scratch folder
 *
 * The read has to be FINISHED before `start`. The take's one project.json is
 * written right after `start` so a crash keeps its choices (STC-493) and never
 * overwrites, so a read still in flight there would mean a second write or a
 * Stop that reaches the panel before the look exists. It also keeps the verb's
 * own `SCShareableContent` call from overlapping `start`'s (STC-470).
 *
 * But the helper makes the take's folder during `start`, and removes it when a
 * start fails, so the file waits elsewhere and moves in after. Scratch is the
 * system temp folder and not the temp takes root, which the sweep and recovery
 * scan. It can be another volume, so the move is a copy and a remove.
 */

export type WallpaperOutcome = { file: string } | { error: string };

type ReadVerb = (dir: string, displayId: number, file: string) => Promise<unknown>;

export interface PendingWallpaper {
  /** Resolves when the read answers. Never rejects. */
  settled: Promise<WallpaperOutcome>;
  /** Moves the file into `dir`, and removes the scratch folder. Never rejects: a failed move is an `{ error }`. */
  moveInto(dir: string): Promise<WallpaperOutcome>;
  /** Removes the scratch folder, now or once the read answers. */
  discard(): void;
}

async function askHelper(read: ReadVerb, dir: string, displayId: number): Promise<void> {
  const r = await read(dir, displayId, WALLPAPER_FILE) as { file?: unknown } | undefined;
  if (r?.file !== WALLPAPER_FILE) throw new Error(`helper answered ${JSON.stringify(r)}`);
}

export function startWallpaperRead(read: ReadVerb, displayId: number | undefined): PendingWallpaper {
  let scratch: string | undefined;
  const removeScratch = () => (scratch ? rm(scratch, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());
  const settled = (async (): Promise<WallpaperOutcome> => {
    if (displayId === undefined) return { error: "no display for this window" };
    try {
      scratch = await mkdtemp(join(tmpdir(), "stc-wallpaper-"));
      await askHelper(read, scratch, displayId);
      return { file: WALLPAPER_FILE };
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  })();
  return {
    settled,
    async moveInto(dir) {
      const got = await settled;
      try {
        if ("error" in got) return got;
        await copyFile(join(scratch!, WALLPAPER_FILE), join(dir, WALLPAPER_FILE));
        return got;
      } catch (e) {
        return { error: String((e as Error)?.message ?? e) };
      } finally {
        await removeScratch();
      }
    },
    discard() {
      void settled.then(removeScratch);
    },
  };
}

/**
 * The wallpaper a capture already in the library wears, for an editor's
 * Wallpaper pick. A picture already in the folder is kept: picking Wallpaper
 * again must not replace it with today's desktop, or fall back to Clean when
 * that display is gone. Otherwise the display's wallpaper is read now.
 */
export async function ensureWallpaper(
  read: ReadVerb | undefined, dir: string, displayId: () => Promise<number>, notice: string,
): Promise<{ ok: true; file: string } | { ok: false; notice: string }> {
  const existing = await stat(join(dir, WALLPAPER_FILE)).catch(() => undefined);
  if (existing?.isFile()) return { ok: true, file: WALLPAPER_FILE };
  if (!read) return { ok: false, notice };
  // Outside the try: a document that cannot be read is its own refusal, for the
  // caller to report, and is not a wallpaper that could not be read.
  const display = await displayId();
  try {
    await askHelper(read, dir, display);
    return { ok: true, file: WALLPAPER_FILE };
  } catch (e) {
    console.log("[wallpaper] could not read for the editor:", e);
    return { ok: false, notice };
  }
}
