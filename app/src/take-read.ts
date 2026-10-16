/**
 * Reading a take's files for a window, split by whether the file may be absent
 * (STC-525).
 *
 * A take has no `project.json` until someone edits it, and `loadTake` defaults
 * both it and `events.json`. Answering their absence by throwing meant Electron
 * logged "Error occurred in handler for 'preview:read'" on every load of a fresh
 * take, which read as a fault and buried real ones. The optional files get their
 * own channel that answers "not there" as `null`; everything else still goes
 * through `preview:read`, where a missing file stays a loud failure.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Files `loadTake` is allowed to find missing. `anchors.json` and the media are NOT here. */
export const OPTIONAL_TAKE_FILES: ReadonlySet<string> = new Set(["project.json", "events.json"]);

/** The file's bytes as a plain ArrayBuffer, or null if it does not exist. Any other error still throws. */
export async function readOptionalTakeFile(
  dir: string, name: string, read: typeof readFile = readFile,
): Promise<ArrayBuffer | null> {
  if (!OPTIONAL_TAKE_FILES.has(name)) throw new Error(`"${name}" is not an optional take file`);
  try {
    const buf = await read(join(dir, name));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}
