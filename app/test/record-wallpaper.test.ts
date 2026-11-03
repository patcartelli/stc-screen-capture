import { describe, test, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWallpaper, startWallpaperRead } from "../src/record-wallpaper.js";

const FILE = "wallpaper.jpg";

/** What the helper's `wallpaper` verb does: makes the folder and writes the file. */
const realRead = async (dir: string, _id: number, file: string): Promise<unknown> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), "picture");
  return { file };
};

/** Every folder the read was pointed at, so a test can see whether it survived. */
function spying(read: typeof realRead) {
  const dirs: string[] = [];
  return { dirs, read: (d: string, id: number, f: string) => { dirs.push(d); return read(d, id, f); } };
}

const tempDir = () => mkdtempSync(join(tmpdir(), "stc-626-test-"));

describe("startWallpaperRead (STC-626)", () => {
  test("moveInto puts the file in the take and removes the scratch folder", async () => {
    const take = tempDir();
    const s = spying(realRead);
    const p = startWallpaperRead(s.read, 7);
    await expect(p.settled).resolves.toEqual({ file: FILE });
    await expect(p.moveInto(take)).resolves.toEqual({ file: FILE });
    expect(readFileSync(join(take, FILE), "utf8")).toBe("picture");
    expect(existsSync(s.dirs[0]!)).toBe(false);
    rmSync(take, { recursive: true });
  });

  test("a read that fails is an answer, not a rejection, and nothing reaches the take", async () => {
    const take = tempDir();
    const s = spying(async () => { throw new Error("no wallpaper window"); });
    const p = startWallpaperRead(s.read, 7);
    expect(await p.settled).toEqual({ error: expect.stringContaining("no wallpaper window") });
    expect(await p.moveInto(take)).toEqual({ error: expect.stringContaining("no wallpaper window") });
    expect(readdirSync(take)).toEqual([]);
    expect(existsSync(s.dirs[0]!)).toBe(false);
    rmSync(take, { recursive: true });
  });

  test("a countdown cancelled mid-read leaves nothing, even though the read answers later", async () => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => { answer = r; });
    const s = spying(async (d, id, f) => { await realRead(d, id, f); await gate; return { file: f }; });
    const p = startWallpaperRead(s.read, 7);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.dirs).toHaveLength(1);
    p.discard();
    answer();
    await p.settled;
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(s.dirs[0]!)).toBe(false);
  });

  test("a take folder that cannot be written is an answer, not a rejection", async () => {
    const s = spying(realRead);
    const p = startWallpaperRead(s.read, 7);
    const r = await p.moveInto(join(tmpdir(), "stc-626-no-such-folder", "take"));
    expect(r).toEqual({ error: expect.any(String) });
    expect(existsSync(s.dirs[0]!)).toBe(false);
  });

  test("no display is an error without asking the helper", async () => {
    const s = spying(realRead);
    const p = startWallpaperRead(s.read, undefined);
    expect(await p.settled).toEqual({ error: expect.any(String) });
    expect(s.dirs).toEqual([]);
  });
});

describe("ensureWallpaper (STC-626)", () => {
  const NOTICE = "the notice";

  test("a picture already in the take is kept, and the desktop is not read again", async () => {
    const take = tempDir();
    writeFileSync(join(take, FILE), "from the take");
    let reads = 0;
    const r = await ensureWallpaper(async () => { reads++; return { file: FILE }; }, take, 7, NOTICE);
    expect(r).toEqual({ ok: true, file: FILE });
    expect(reads).toBe(0);
    expect(readFileSync(join(take, FILE), "utf8")).toBe("from the take");
    rmSync(take, { recursive: true });
  });

  test("no file: the display's wallpaper is read into the take", async () => {
    const take = tempDir();
    expect(await ensureWallpaper(realRead, take, 7, NOTICE)).toEqual({ ok: true, file: FILE });
    expect(existsSync(join(take, FILE))).toBe(true);
    rmSync(take, { recursive: true });
  });

  test("a read that fails answers with the notice", async () => {
    const take = tempDir();
    const r = await ensureWallpaper(async () => { throw new Error("gone"); }, take, 7, NOTICE);
    expect(r).toEqual({ ok: false, notice: NOTICE });
    rmSync(take, { recursive: true });
  });

  test("an answer naming another file is a failed read", async () => {
    const take = tempDir();
    const r = await ensureWallpaper(async () => ({ file: "other.jpg" }), take, 7, NOTICE);
    expect(r).toEqual({ ok: false, notice: NOTICE });
    rmSync(take, { recursive: true });
  });
});
