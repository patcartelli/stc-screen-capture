import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { importImage, importedShot, canImport } from "../src/image-import.js";
import { parseShot } from "@transform/shot.js";
import { rawRoot } from "../src/takes.js";

let root: string, src: string;
const env = (): NodeJS.ProcessEnv => ({ STC_RECORDINGS_DIR: root });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "imp-")); src = mkdtempSync(join(tmpdir(), "src-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); });

describe("importing an image (STC-575)", () => {
  test("the document is a whole-image display-crop that loads back", () => {
    const doc = importedShot(800, 600, new Date("2026-11-03T12:00:00Z"));
    const shot = parseShot(doc);
    expect(shot.kind).toBe("display-crop");
    expect(shot.crop).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(shot.display.backingScale).toBe(1);
    expect(shot.display.colorSpace).toBeUndefined();
    expect(shot.frame).toEqual({ file: "frame.png", width: 800, height: 600, alpha: false });
    expect(doc.version).toBe(1);
  });

  test("a PNG is copied byte for byte into a new shot under raw/, and the original is untouched", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const file = join(src, "a.PNG");
    writeFileSync(file, png);
    const dir = await importImage(env(), null, file, async () => ({ width: 10, height: 5 }));
    expect(dir.startsWith(rawRoot(env(), null))).toBe(true);
    expect(readFileSync(join(dir, "frame.png")).equals(png)).toBe(true);
    expect(parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).frame.width).toBe(10);
    expect(readFileSync(file).equals(png)).toBe(true);
  });

  test("a re-encoded image writes the decoder's PNG bytes", async () => {
    const file = join(src, "a.jpg");
    writeFileSync(file, "jpeg");
    const out = Buffer.from("PNGDATA");
    const dir = await importImage(env(), null, file, async () => ({ width: 3, height: 3, png: out }));
    expect(readFileSync(join(dir, "frame.png")).equals(out)).toBe(true);
  });

  test("an unsupported extension, or an unreadable size, is refused and leaves nothing", async () => {
    expect(canImport("x.heic")).toBe(false);
    await expect(importImage(env(), null, join(src, "x.heic"), async () => ({ width: 1, height: 1 }))).rejects.toThrow(/png/);
    const file = join(src, "z.png");
    writeFileSync(file, "x");
    await expect(importImage(env(), null, file, async () => ({ width: 0, height: 0 }))).rejects.toThrow(/size/);
    const raw = rawRoot(env(), null);
    expect(existsSync(raw) ? readdirSync(raw) : []).toEqual([]);
  });

  test("a write that fails removes the half-built directory", async () => {
    const file = join(src, "gone.png");   // never created: the copy throws
    await expect(importImage(env(), null, file, async () => ({ width: 2, height: 2 }))).rejects.toThrow();
    expect(readdirSync(rawRoot(env(), null))).toEqual([]);
  });

  test("two imports in the same second get two directories", async () => {
    const file = join(src, "a.png");
    writeFileSync(file, "x");
    const at = new Date();
    const [a, b] = await Promise.all([1, 2].map(() => importImage(env(), null, file, async () => ({ width: 2, height: 2 }), at)));
    expect(a).not.toBe(b);
  });
});
