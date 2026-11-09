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
    const r = await ensureWallpaper(async () => { reads++; return { file: FILE }; }, take, async () => 7, NOTICE);
    expect(r).toEqual({ ok: true, file: FILE });
    expect(reads).toBe(0);
    expect(readFileSync(join(take, FILE), "utf8")).toBe("from the take");
    rmSync(take, { recursive: true });
  });

  test("no file: the display's wallpaper is read into the take", async () => {
    const take = tempDir();
    expect(await ensureWallpaper(realRead, take, async () => 7, NOTICE)).toEqual({ ok: true, file: FILE });
    expect(existsSync(join(take, FILE))).toBe(true);
    rmSync(take, { recursive: true });
  });

  test("a read that fails answers with the notice", async () => {
    const take = tempDir();
    const r = await ensureWallpaper(async () => { throw new Error("gone"); }, take, async () => 7, NOTICE);
    expect(r).toEqual({ ok: false, notice: NOTICE });
    rmSync(take, { recursive: true });
  });

  test("a picture already there needs no helper and no display: neither is even asked for", async () => {
    const take = tempDir();
    writeFileSync(join(take, FILE), "from the take");
    const r = await ensureWallpaper(undefined, take, async () => { throw new Error("shot.json is unreadable"); }, NOTICE);
    expect(r).toEqual({ ok: true, file: FILE });
    rmSync(take, { recursive: true });
  });

  test("no picture and no helper answers with the notice", async () => {
    const take = tempDir();
    expect(await ensureWallpaper(undefined, take, async () => 7, NOTICE)).toEqual({ ok: false, notice: NOTICE });
    rmSync(take, { recursive: true });
  });

  test("a document that cannot be read rejects: it is not a wallpaper that could not be read", async () => {
    const take = tempDir();
    await expect(ensureWallpaper(realRead, take, async () => { throw new Error("no shot.json"); }, NOTICE))
      .rejects.toThrow("no shot.json");
    rmSync(take, { recursive: true });
  });

  test("an answer naming another file is a failed read", async () => {
    const take = tempDir();
    const r = await ensureWallpaper(async () => ({ file: "other.jpg" }), take, async () => 7, NOTICE);
    expect(r).toEqual({ ok: false, notice: NOTICE });
    rmSync(take, { recursive: true });
  });
});

/**
 * Pinned at the source: main.ts cannot be imported here, and these two handlers
 * are where the rule can be lost. A picture already in the folder must be kept
 * without a helper and without reading the document, so nothing that can fail
 * may run ahead of `ensureWallpaper`, which checks for the file first.
 */
describe("the two fetch handlers put the file check first (STC-626)", () => {
  const main = readFileSync(join(__dirname, "..", "src", "main.ts"), "utf8");
  const body = (channel: string) => {
    const from = main.indexOf(`ipcMain.handle("${channel}"`);
    expect(from, channel).toBeGreaterThan(-1);
    return main.slice(from, main.indexOf("\n});", from));
  };

  test.each(["still:fetchWallpaper", "editor:fetchWallpaper"])("%s reaches ensureWallpaper with nothing that can fail ahead of it", (channel) => {
    const ahead = body(channel).split("ensureWallpaper(")[0]!;
    expect(ahead).not.toMatch(/if \(!sup\)/);
    expect(ahead).not.toMatch(/readFile\(/);
  });
});
