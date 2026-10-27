/**
 * What the library can say about a saved GIF from its own bytes (STC-592):
 * its size, its frame count and how long it plays.
 *
 * A saved GIF is untagged (STC-395) and has no bundle, so the file is the
 * only source. Pure `Uint8Array` in, facts out, no node and no DOM, for the
 * same reason `media-probe.ts` is: testable anywhere, and against this repo's
 * own encoder (`gif-encode.ts`).
 *
 * Duration needs every frame's Graphic Control Extension, and a GIF has no
 * index, so the walk visits every block. Image data is skipped by its
 * sub-block lengths, never decoded.
 *
 * Every read degrades rather than throws. A file that is not a GIF is
 * `undefined`; a GIF cut short keeps its size and loses its duration, because
 * a duration counted up to the cut would understate it with nothing to say so.
 */

export interface GifFacts {
  width: number;
  height: number;
  /** Frames up to the trailer, or up to the cut when the file is truncated. */
  frames: number;
  /** Undefined when the file ends before its trailer. */
  durationMs?: number;
}

/**
 * The shortest delay a viewer honours, in centiseconds. Browsers and Preview
 * play a delay of 0 or 1 cs at 10 cs, so a GIF that says 0 is counted as
 * what it actually plays as. `gif-encode.ts` never writes one.
 */
const MIN_PLAYED_DELAY_CS = 2;
const CLAMPED_DELAY_CS = 10;

/** The header and logical screen descriptor: "GIF89a", width, height, packed, bg, aspect. */
const HEADER_BYTES = 13;

export function probeGif(b: Uint8Array): GifFacts | undefined {
  if (b.length < HEADER_BYTES) return undefined;
  const sig = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!);
  if (sig !== "GIF87a" && sig !== "GIF89a") return undefined;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  let at = HEADER_BYTES + colorTableBytes(b[10]!);

  let frames = 0;
  let cs = 0;
  let pendingDelay = 0;
  const cut = (): GifFacts => ({ width, height, frames });

  for (;;) {
    if (at >= b.length) return cut();
    const block = b[at]!;
    if (block === 0x3b) break;                                    // trailer
    if (block === 0x21) {                                         // extension
      if (at + 1 >= b.length) return cut();
      if (b[at + 1] === 0xf9 && at + 5 < b.length && b[at + 2] === 4) {
        pendingDelay = b[at + 4]! | (b[at + 5]! << 8);            // Graphic Control Extension
      }
      const next = skipSubBlocks(b, at + 2);
      if (next === undefined) return cut();
      at = next;
    } else if (block === 0x2c) {                                  // image descriptor
      if (at + 10 >= b.length) return cut();
      // descriptor (10) + local colour table + LZW minimum code size (1)
      const next = skipSubBlocks(b, at + 10 + colorTableBytes(b[at + 9]!) + 1);
      if (next === undefined) return cut();
      frames++;
      cs += pendingDelay < MIN_PLAYED_DELAY_CS ? CLAMPED_DELAY_CS : pendingDelay;
      pendingDelay = 0;
      at = next;
    } else {
      return cut();                                               // not a block a GIF can hold
    }
  }
  return { width, height, frames, durationMs: cs * 10 };
}

/** A global or local colour table's length, from its descriptor's packed byte. */
function colorTableBytes(packed: number): number {
  return packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
}

/** Past a run of length-prefixed sub-blocks and its 0 terminator; undefined when cut. */
function skipSubBlocks(b: Uint8Array, at: number): number | undefined {
  for (;;) {
    if (at >= b.length) return undefined;
    const n = b[at]!;
    if (n === 0) return at + 1;
    at += n + 1;
  }
}
