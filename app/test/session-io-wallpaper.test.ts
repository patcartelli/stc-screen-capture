/**
 * STC-673. A window take's Wallpaper look was never drawn in the packaged app:
 * `loadTake` asked the optional-file channel for `wallpaper.jpg`,
 * `readOptionalTakeFile` refused the name (its list held only project.json and
 * events.json), and a blanket `.catch(() => null)` turned the refusal into "no
 * file", so every sink drew the fallback colour. `gate:identity` loads through
 * the harness and never touched this reader.
 *
 * So this goes through the REAL reader: `loadTake` with an `io` whose
 * `readOptional` is `readOptionalTakeFile` over a real folder, as
 * `preview:readOptional` is in main.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, stat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTake, type TakeIO } from "../src/session-io.js";
import { OPTIONAL_TAKE_FILES, readOptionalTakeFile } from "../src/take-read.js";
import { WALLPAPER_FILE } from "../../transform/src/looks.js";

const root = join(__dirname, "..", "..");
const exact = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** A take folder: fixtures/pip's media with fixtures/wallpaper-framed's project (and, unless told not to, its picture). */
function takeDir(withWallpaper = true): string {
  const dir = mkdtempSync(join(tmpdir(), "stc-673-"));
  for (const f of ["anchors.json", "events.json", "display.mp4", "camera.mp4"]) {
    copyFileSync(join(root, "fixtures", "pip", f), join(dir, f));
  }
  copyFileSync(join(root, "fixtures", "wallpaper-framed", "project.json"), join(dir, "project.json"));
  if (withWallpaper) copyFileSync(join(root, "fixtures", "wallpaper-framed", WALLPAPER_FILE), join(dir, WALLPAPER_FILE));
  return dir;
}

/** What a window's bridge is: main's handlers over one folder, the optional channel being the real reader. */
function diskIO(dir: string, readOptional: TakeIO["readOptional"] = (name) => readOptionalTakeFile(dir, name)): TakeIO {
  return {
    read: async (name) => exact(await readFile(join(dir, name))),
    readOptional,
    size: async (name) => (await stat(join(dir, name))).size,
    chunk: async (name, offset, length) => {
      const fh = await open(join(dir, name), "r");
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return exact(buf.subarray(0, bytesRead));
      } finally { await fh.close(); }
    },
  };
}

/** Node has no createImageBitmap; `decodeWallpaper` only needs it to answer. The stub records the bytes it was given. */
let decoded: Uint8Array[] = [];
const g = globalThis as { createImageBitmap?: unknown };
let dirs: string[] = [];
beforeEach(() => {
  decoded = [];
  g.createImageBitmap = async (blob: Blob) => {
    decoded.push(new Uint8Array(await blob.arrayBuffer()));
    return { width: 1, height: 1, close() {} };
  };
});
afterEach(() => {
  delete g.createImageBitmap;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const dir = (withWallpaper = true) => { const d = takeDir(withWallpaper); dirs.push(d); return d; };

describe("a wallpaper-framed take through the real optional reader (STC-673)", () => {
  test("the wallpaper's bytes reach the decoder and the session carries the picture", async () => {
    const d = dir();
    const { session, project } = await loadTake(diskIO(d));
    expect(project.framing?.background?.kind).toBe("wallpaper");
    expect(session.wallpaper).toBeTruthy();
    expect(decoded).toHaveLength(1);
    expect(Buffer.from(decoded[0]!).equals(readFileSync(join(d, WALLPAPER_FILE)))).toBe(true);
  });

  test("a MISSING wallpaper still loads, with no picture (the fallback colour)", async () => {
    const { session, project } = await loadTake(diskIO(dir(false)));
    expect(project.framing?.background?.kind).toBe("wallpaper");
    expect(session.wallpaper ?? null).toBeNull();
    expect(decoded).toHaveLength(0);
  });

  test("a REFUSED wallpaper read fails the load instead of passing as a missing file", async () => {
    const d = dir();
    const refusing: TakeIO["readOptional"] = async (name) => {
      if (name === WALLPAPER_FILE) throw new Error(`"${name}" is not an optional take file`);
      return readOptionalTakeFile(d, name);
    };
    await expect(loadTake(diskIO(d, refusing))).rejects.toThrow("not an optional take file");
  });
});

describe("every file a window asks the optional channel for is on its list (STC-673)", () => {
  // The names are written at the call sites, so a new optional read with no row in
  // OPTIONAL_TAKE_FILES fails here rather than in a packaged build.
  const CALL = /\b(?:readOptional|readTakeFileOptional)\(\s*("[^"]+"|[A-Z][A-Z0-9_]*)\s*\)/g;
  const CONSTANTS: Record<string, string> = { WALLPAPER_FILE };
  const namesIn = (file: string) => [...readFileSync(join(root, "app", "src", file), "utf8").matchAll(CALL)]
    .map((m) => (m[1]!.startsWith('"') ? m[1]!.slice(1, -1) : CONSTANTS[m[1]!] ?? `unknown constant ${m[1]}`));

  test("control: the pattern finds the three reads in session-io.ts", () => {
    expect(namesIn("session-io.ts").sort()).toEqual(["events.json", "project.json", WALLPAPER_FILE].sort());
  });
  test.each(["session-io.ts", "editor.ts"])("%s", (file) => {
    for (const name of namesIn(file)) expect(OPTIONAL_TAKE_FILES.has(name), name).toBe(true);
  });
});
