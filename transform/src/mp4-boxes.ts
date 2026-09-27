import type { ByteSource } from "./chunk-reader.js";

/**
 * The top-level box layout of an MP4, read header by header (STC-236).
 *
 * demuxTrack feeds mp4box every box EXCEPT an mdat's body — the index lives
 * in moov (and moof, for a crash-recovered fragmented file), the media lives
 * in mdat — so it needs to know where the boxes are without reading them.
 * 16 bytes per box: the 32-bit size, the type, and the 64-bit largesize when
 * size is 1.
 *
 * A box that runs past the end of the file is NOT an error. A process killed
 * mid-recording (STC-394) leaves exactly that: the fragment in flight at the
 * kill. It ends the walk and is reported as `truncated`; everything before it
 * is intact and readable. A box declaring fewer bytes than its own header is
 * corrupt, and that IS refused.
 */

export interface TopBox { type: string; offset: number; size: number; headerSize: 8 | 16 }
export interface BoxWalk { boxes: TopBox[]; truncated: TopBox | null }

export async function walkTopLevelBoxes(src: ByteSource, what: string): Promise<BoxWalk> {
  const boxes: TopBox[] = [];
  let off = 0;
  while (off < src.size) {
    const remaining = src.size - off;
    if (remaining < 8) return { boxes, truncated: { type: "", offset: off, size: remaining, headerSize: 8 } };
    const h = await src.read(off, Math.min(16, remaining));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const size32 = dv.getUint32(0);
    const type = String.fromCharCode(h[4]!, h[5]!, h[6]!, h[7]!);
    let size: number;
    let headerSize: 8 | 16 = 8;
    if (size32 === 1) {
      if (h.byteLength < 16) return { boxes, truncated: { type, offset: off, size: remaining, headerSize: 16 } };
      const big = dv.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`could not parse ${what}: box "${type}" at ${off} is larger than 2^53 bytes`);
      size = Number(big);
      headerSize = 16;
    } else if (size32 === 0) {
      size = remaining;
    } else {
      size = size32;
    }
    if (size < headerSize) {
      throw new Error(`could not parse ${what}: box "${type}" at ${off} declares ${size} bytes, smaller than its own header`);
    }
    const found: TopBox = { type, offset: off, size, headerSize };
    if (off + size > src.size) return { boxes, truncated: found };
    boxes.push(found);
    off += size;
  }
  return { boxes, truncated: null };
}
