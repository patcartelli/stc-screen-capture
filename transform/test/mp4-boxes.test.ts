import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkTopLevelBoxes } from "../src/mp4-boxes.js";
import { memorySource } from "../src/chunk-reader.js";

const root = join(__dirname, "..", "..");

function box(type: string, bodyLen: number, opts: { large?: boolean; toEnd?: boolean } = {}): Uint8Array {
  const header = opts.large ? 16 : 8;
  const b = new Uint8Array(header + bodyLen);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, opts.toEnd ? 0 : opts.large ? 1 : header + bodyLen);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  if (opts.large) dv.setBigUint64(8, BigInt(header + bodyLen));
  return b;
}
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return memorySource(out.buffer, "t.mp4");
};

describe("walkTopLevelBoxes", () => {
  test("a real fixture: ftyp, mdat, moov, back to back to EOF", async () => {
    const b = readFileSync(join(root, "fixtures", "basic", "display.mp4"));
    const src = memorySource(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), "display.mp4");
    const walk = await walkTopLevelBoxes(src, "display.mp4");
    expect(walk.boxes.map((x) => x.type)).toEqual(["ftyp", "mdat", "moov"]);
    expect(walk.truncated).toBeNull();
    const last = walk.boxes[walk.boxes.length - 1]!;
    expect(last.offset + last.size).toBe(src.size);
  });

  test("64-bit largesize", async () => {
    const walk = await walkTopLevelBoxes(cat(box("ftyp", 4), box("mdat", 20, { large: true }), box("moov", 4)), "t.mp4");
    expect(walk.boxes.map((x) => [x.type, x.size, x.headerSize])).toEqual([["ftyp", 12, 8], ["mdat", 36, 16], ["moov", 12, 8]]);
  });

  test("size 0 runs to the end of the file", async () => {
    const walk = await walkTopLevelBoxes(cat(box("ftyp", 4), box("mdat", 30, { toEnd: true })), "t.mp4");
    expect(walk.boxes[1]).toEqual({ type: "mdat", offset: 12, size: 38, headerSize: 8 });
  });

  test("a truncated LAST box ends the walk and is reported, not thrown (a crash-recovered file ends like this)", async () => {
    const full = box("mdat", 100);
    const walk = await walkTopLevelBoxes(cat(box("ftyp", 4), box("moov", 4), full.subarray(0, 40)), "t.mp4");
    expect(walk.boxes.map((x) => x.type)).toEqual(["ftyp", "moov"]);
    expect(walk.truncated).toEqual({ type: "mdat", offset: 24, size: 108, headerSize: 8 });
  });

  test("fewer than 8 bytes left is a truncated tail too", async () => {
    const walk = await walkTopLevelBoxes(cat(box("ftyp", 4), new Uint8Array(5)), "t.mp4");
    expect(walk.boxes.map((x) => x.type)).toEqual(["ftyp"]);
    expect(walk.truncated).not.toBeNull();
  });

  test("a box smaller than its own header is refused", async () => {
    const bad = box("moov", 4);
    new DataView(bad.buffer).setUint32(0, 4);
    await expect(walkTopLevelBoxes(cat(box("ftyp", 4), bad), "t.mp4")).rejects.toThrow(/could not parse t\.mp4: box "moov" at 12 declares 4 bytes/);
  });
});
