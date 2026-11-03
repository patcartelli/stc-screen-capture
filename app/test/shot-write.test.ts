import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOKS, lookWrite, wallpaperLookWrite, WALLPAPER_FILE } from "@transform/backgrounds.js";
import { parseShot } from "@transform/shot.js";
import { writeShotLook } from "../src/shot-write.js";

const root = join(__dirname, "..", "..");

/**
 * `writeShotLook` (STC-628): the one merge a look goes through on its way into
 * `shot.json`, shared by a fresh capture and the still editor's picker.
 */
describe("writeShotLook (STC-628)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stc-shot-write-"));
    cpSync(join(root, "fixtures", "shot-window"), dir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const stored = () => parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8")));

  test("round-trips a wallpaper write, and returns what it wrote", async () => {
    const written = await writeShotLook(dir, wallpaperLookWrite(WALLPAPER_FILE));
    const onDisk = stored();
    expect(onDisk).toEqual(written);
    expect(onDisk.decoration.mode).toBe("window-shadow-custom-background");
    expect(onDisk.decoration.background).toMatchObject({ kind: "wallpaper", file: WALLPAPER_FILE });
    // Nothing else about the shot moved.
    expect(onDisk.window?.id).toBe(4711);
    expect(onDisk.decoration.redactions).toEqual([]);
    // No version bump: a wallpaper shot is still shot-1.
    expect(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8")).version).toBe(1);
  });

  test("drops the library's cached thumbnail", async () => {
    writeFileSync(join(dir, "thumb.png"), "stale");
    await writeShotLook(dir, lookWrite(LOOKS.find((l) => l.id === "clean")!));
    expect(existsSync(join(dir, "thumb.png"))).toBe(false);
  });

  test("a write parseShot refuses throws and leaves the file alone", async () => {
    const before = readFileSync(join(dir, "shot.json"), "utf8");
    await expect(writeShotLook(dir, { mode: "no-such-mode" as never, background: null, shadow: null }))
      .rejects.toThrow();
    expect(readFileSync(join(dir, "shot.json"), "utf8")).toBe(before);
  });
});
