/**
 * `scripts/compare-still-exports.mjs` (STC-477) — the check a person runs on a
 * P3 Mac to say the still editor's export now matches the panel's.
 *
 * It only ever runs on hardware CI does not have, so the one thing CI CAN
 * settle is that the check is able to fail: every test here but the first is
 * a way the two exports could differ, shaped like the bug it stands for, and
 * each must come back as a finding (exit 1) rather than a pass. A comparer
 * that passed everything would look exactly like a fixed bug.
 */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const SCRIPT = join(__dirname, "..", "..", "scripts", "compare-still-exports.mjs");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** An 8-bit RGBA PNG, one filter per row cycled through all five, so the reader's unfilter is exercised. */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number],
             profile: string | null): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const rows: Buffer[] = [];
  const img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(pixel(x, y), y * stride + x * 4);
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    const line = Buffer.alloc(stride + 1);
    line[0] = f;
    for (let i = 0; i < stride; i++) {
      const cur = img[y * stride + i]!;
      const a = i >= 4 ? img[y * stride + i - 4]! : 0;
      const b = y > 0 ? img[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= 4 ? img[(y - 1) * stride + i - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
        : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i + 1] = (cur - pred) & 255;
    }
    rows.push(line);
  }
  const iccp = profile === null ? [] : [chunk("iCCP", Buffer.concat([
    Buffer.from(profile, "latin1"), Buffer.from([0, 0]), deflateSync(Buffer.from("not a real profile")),
  ]))];
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", ihdr), ...iccp,
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Saturated, varied content — the kind a P3/sRGB mix-up changes. */
const picture = (x: number, y: number): [number, number, number, number] =>
  [(x * 37) & 255, (y * 53) & 255, ((x + y) * 29) & 255, 255];

function takeDir(colorSpace: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "stc-compare-"));
  if (colorSpace !== null) writeFileSync(join(dir, "shot.json"), JSON.stringify({ display: { colorSpace } }));
  return dir;
}

/** Writes the panel's file, then the editor's a second later — the order `--dir` relies on. */
function save(dir: string, panel: Buffer, editor: Buffer): { panel: string; editor: string } {
  const p = join(dir, "Capture 1.png"), e = join(dir, "Capture 1-2.png");
  writeFileSync(p, panel); writeFileSync(e, editor);
  const now = Date.now() / 1000;
  utimesSync(p, now - 1, now - 1); utimesSync(e, now, now);
  return { panel: p, editor: e };
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const P3 = "Display P3";

describe("compare-still-exports (STC-477)", () => {
  test("PASS: the same picture at the same size with the same P3 profile", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    save(dir, png(24, 16, picture, P3), png(24, 16, picture, P3));
    const r = run("--dir", dir);
    expect(r.out).toContain("PASS");
    expect(r.code).toBe(0);
  });

  test("a difference of 1 in a channel is encoder rounding, not a finding", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    const nudged = (x: number, y: number): [number, number, number, number] => {
      const [r, g, b, a] = picture(x, y);
      return [r === 255 ? 254 : r + 1, g, b, a];
    };
    save(dir, png(24, 16, picture, P3), png(24, 16, nudged, P3));
    expect(run("--dir", dir).code).toBe(0);
  });

  test("FAIL: the editor at twice the panel's size — the scale bug", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    save(dir, png(24, 16, picture, P3), png(48, 32, picture, P3));
    const r = run("--dir", dir);
    expect(r.out).toMatch(/size: panel 24x16, editor 48x32/);
    expect(r.out).toContain("2.00x");
    expect(r.code).toBe(1);
  });

  test("FAIL: same size and profile, different numbers — the colour-space bug", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    // What an sRGB canvas does to saturated P3 content: the same picture,
    // shifted values, still tagged P3 on the way out.
    const srgbish = (x: number, y: number): [number, number, number, number] => {
      const [r, g, b, a] = picture(x, y);
      return [Math.min(255, Math.round(r * 1.08)), Math.round(g * 0.94), b, a];
    };
    save(dir, png(24, 16, picture, P3), png(24, 16, srgbish, P3));
    const r = run("--dir", dir);
    expect(r.out).toMatch(/pixels: \d+ of 384 differ/);
    expect(r.code).toBe(1);
  });

  test("FAIL: a P3 shot exported with no profile at all", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    save(dir, png(24, 16, picture, null), png(24, 16, picture, null));
    const r = run("--dir", dir);
    expect(r.out).toMatch(/panel: expected a Display P3 profile, found "none"/);
    expect(r.code).toBe(1);
  });

  test("an sRGB shot passes but SAYS it proves nothing about the colour-space bug", () => {
    const dir = takeDir("kCGColorSpaceSRGB");
    save(dir, png(24, 16, picture, "sRGB IEC61966-2.1"), png(24, 16, picture, "sRGB IEC61966-2.1"));
    const r = run("--dir", dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cannot show/);
  });

  test("--dir on a save folder finds the shot in raw/, skipping a newer recording bundle", () => {
    // The real layout (takes.ts, STC-413): finished files at the top, bundles
    // in raw/<stamp>/. A P3 still bundle, then a NEWER recording bundle that
    // has no shot.json — reading that one's anchors, or none, would silently
    // turn the P3 check off.
    const folder = takeDir(null);
    const still = join(folder, "raw", "20260929-101500");
    const rec = join(folder, "raw", "20260929-101600");
    mkdirSync(still, { recursive: true }); mkdirSync(rec, { recursive: true });
    writeFileSync(join(still, "shot.json"), JSON.stringify({ display: { colorSpace: "kCGColorSpaceDisplayP3" } }));
    writeFileSync(join(rec, "anchors.json"), "{}");
    save(folder, png(24, 16, picture, null), png(24, 16, picture, null));
    const r = run("--dir", folder);
    expect(r.out).toContain("20260929-101500");
    expect(r.out).toMatch(/expected a Display P3 profile/);
    expect(r.code).toBe(1);
  });

  test("explicit paths work the same as --dir, with --shot", () => {
    const dir = takeDir("kCGColorSpaceDisplayP3");
    const f = save(dir, png(24, 16, picture, P3), png(48, 32, picture, P3));
    expect(run(f.panel, f.editor, "--shot", join(dir, "shot.json")).code).toBe(1);
  });

  test("could not run is 3, never 1: one export only, a missing file, not a PNG", () => {
    const one = takeDir("kCGColorSpaceDisplayP3");
    writeFileSync(join(one, "Capture 1.png"), png(4, 4, picture, P3));
    writeFileSync(join(one, "frame.png"), png(4, 4, picture, P3)); // the capture itself, never an export
    expect(run("--dir", one).code).toBe(3);

    expect(run("/nonexistent/a.png", "/nonexistent/b.png").code).toBe(3);

    const junk = takeDir(null);
    writeFileSync(join(junk, "a.png"), "not a png");
    writeFileSync(join(junk, "b.png"), "not a png");
    expect(run(join(junk, "a.png"), join(junk, "b.png")).code).toBe(3);
  });
});
