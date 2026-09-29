import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { demuxTrack } from "../src/demux.js";
import { ChunkReader, memorySource, type ByteSource } from "../src/chunk-reader.js";
import { demuxTrackOracle } from "./_demux-oracle.js";

const root = join(__dirname, "..", "..");
const ab = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer; };

/** Every committed MP4 under fixtures/ — a fixture added later is checked too. */
const FIXTURES = (readdirSync(join(root, "fixtures"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".mp4"))
  .map((f) => join(root, "fixtures", f));

function counting(src: ByteSource): ByteSource & { bytes: number } {
  const s = { size: src.size, bytes: 0, read: (o: number, l: number) => { s.bytes += l; return src.read(o, l); } };
  return s;
}

describe("lazy demuxTrack agrees with the whole-file demux on every fixture", () => {
  test("there are fixtures to check", () => expect(FIXTURES.length).toBeGreaterThanOrEqual(3));

  for (const path of FIXTURES) {
    test(relative(root, path), async () => {
      const buf = ab(path);
      const oracle = await demuxTrackOracle(buf, path);
      const src = counting(memorySource(buf, path));
      const lazy = await demuxTrack(src, path);

      expect(lazy.framesNs).toEqual(oracle.framesNs);
      expect(lazy.codec).toBe(oracle.codec);
      expect(lazy.codedWidth).toBe(oracle.codedWidth);
      expect(lazy.codedHeight).toBe(oracle.codedHeight);
      expect([...lazy.description]).toEqual([...oracle.description]);
      expect(lazy.chunks.map((c) => [c.type, c.timestampUs])).toEqual(oracle.chunks.map((c) => [c.type, c.timestampUs]));

      // The index alone: a small fraction of the file (1.5% on fixtures/basic, 0.02% on a real 46 MB take).
      expect(src.bytes).toBeLessThan(buf.byteLength / 10);

      const bytes = await new ChunkReader(lazy.chunks, lazy.bytes, path).read(0, lazy.chunks.length);
      bytes.forEach((b, i) => expect(Buffer.from(b).equals(Buffer.from(oracle.chunks[i]!.data)), `chunk ${i}`).toBe(true));
    });
  }

  test("a file cut inside its moov is not a readable MP4", async () => {
    const buf = ab(join(root, "fixtures", "basic", "display.mp4"));
    await expect(demuxTrack(memorySource(buf.slice(0, buf.byteLength - 100), "cut.mp4"), "cut.mp4"))
      .rejects.toThrow(/cut\.mp4 is not a readable MP4/);
  });

  test("a 20-byte file is not a readable MP4", async () => {
    const buf = ab(join(root, "fixtures", "basic", "display.mp4"));
    await expect(demuxTrack(memorySource(buf.slice(0, 20), "tiny.mp4"), "tiny.mp4")).rejects.toThrow(/tiny\.mp4/);
  });
});
