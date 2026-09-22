/**
 * A capture's id, carried INSIDE the media file it produced (STC-413).
 *
 * This is the frontmatter analogue. Obsidian's metadata survives a move
 * because there is only one object; a sidecar is a second object and only
 * survives if the user moves both halves. So the id lives in the bytes.
 *
 * Pure `Uint8Array` in, `Uint8Array` out — no node, no DOM — because the
 * browser typecheck pass follows even a type-only import, and because this
 * has to be testable on a checkout with no Swift toolchain and no Mac.
 *
 * Every read degrades to `undefined` rather than throwing. A file we cannot
 * parse is a file with reduced metadata, never a crash in a 500-file scan.
 *
 * `tagPng` has no production caller yet, and that is deliberate rather than
 * dead code — the production writer for stills is ImageIO (Task 6), because
 * it covers PNG, JPEG and HEIC in one place where `tagPng` covers only PNG.
 * What `tagPng` buys is that `readPngCaptureId` is verifiable on a checkout
 * with no Swift toolchain and no Mac, which is this repo's chronic
 * verification gap — see CLAUDE.md's running list of things "written on
 * Linux, so X is unseen". A later task (MP4 support, Task 3) reuses the
 * private chunk-walking helpers below rather than re-deriving them.
 */
import { isCaptureId } from "./capture-id.js";

/** What `tagPng` writes. */
export const PNG_TEXT_KEYWORD = "stc-capture-id";

/**
 * What ImageIO writes for `kCGImagePropertyPNGDescription`, which is how the
 * Swift still encoder tags a capture. Read, never written, by this module.
 */
export const IMAGEIO_TEXT_KEYWORD = "Description";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Big-endian encode/decode of a 32-bit unsigned int — the width every field
 * in an MP4 or PNG box/chunk header uses. Module-private and reused by
 * Task 3's MP4 support, which is why these are not inlined into the PNG
 * functions below.
 */
const be32 = (n: number): number[] =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const readBe32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** Decode `len` bytes at `at` as Latin-1/ASCII — chunk types and tEXt keys. */
const ascii = (b: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...b.subarray(at, at + len));

/**
 * Walk a PNG's chunks. Yields `[type, start, totalLength]` where `start` is
 * the chunk's own first byte. Stops at the first length that would run past
 * the buffer — a truncated file is read as far as it is intact.
 */
function* pngChunks(b: Uint8Array): Generator<[string, number, number]> {
  let at = 8;
  while (at + 8 <= b.length) {
    const len = readBe32(b, at);
    const total = 12 + len;
    if (len > b.length || at + total > b.length) return;
    yield [ascii(b, at + 4, 4), at, total];
    at += total;
  }
}

function textChunk(keyword: string, value: string): number[] {
  const data = [...keyword].map((c) => c.charCodeAt(0))
    .concat(0, [...value].map((c) => c.charCodeAt(0)));
  const typed = new Uint8Array([...[..."tEXt"].map((c) => c.charCodeAt(0)), ...data]);
  return [...be32(data.length), ...typed, ...be32(crc32(typed))];
}

/** The value of the first tEXt chunk under `keyword` that is a valid id. */
function idUnderKeyword(bytes: Uint8Array, keyword: string): string | undefined {
  for (const [type, start, total] of pngChunks(bytes)) {
    if (type !== "tEXt") continue;
    const data = bytes.subarray(start + 8, start + total - 4);
    const nul = data.indexOf(0);
    if (nul < 0) continue;
    if (ascii(data, 0, nul) !== keyword) continue;
    const value = ascii(data, nul + 1, data.length - nul - 1);
    if (isCaptureId(value)) return value;
  }
  return undefined;
}

/**
 * The id, or undefined for an untagged, foreign, truncated or corrupt file.
 *
 * Two keywords are accepted because there are two writers: `tagPng` here, and
 * ImageIO in the Swift still encoder. **Our own keyword wins**, and that
 * precedence is deliberate rather than incidental — a file could carry both
 * (ImageIO tagged it at export, something re-tagged it later), and resolving
 * by chunk ORDER would return whichever happened to sit earlier in the file.
 * A rule that depends on byte order is a rule nobody can reason about.
 *
 * Both candidates are gated by `isCaptureId`, so a human-written description
 * cannot be read as identity.
 */
export function readPngCaptureId(bytes: Uint8Array): string | undefined {
  if (!isPng(bytes)) return undefined;
  return idUnderKeyword(bytes, PNG_TEXT_KEYWORD)
      ?? idUnderKeyword(bytes, IMAGEIO_TEXT_KEYWORD);
}

/**
 * Insert the id before the first IDAT, removing any tag already there so
 * re-tagging replaces rather than accumulates. A non-PNG is returned
 * UNCHANGED — refusing is always better than writing something that corrupts
 * a file we did not understand.
 */
export function tagPng(bytes: Uint8Array, id: string): Uint8Array {
  if (!isPng(bytes) || !isCaptureId(id)) return bytes;

  const out: number[] = [...PNG_SIG];
  let inserted = false;
  for (const [type, start, total] of pngChunks(bytes)) {
    if (type === "tEXt") {
      const data = bytes.subarray(start + 8, start + total - 4);
      const nul = data.indexOf(0);
      if (nul >= 0 && ascii(data, 0, nul) === PNG_TEXT_KEYWORD) continue;  // drop the old one
    }
    if (!inserted && (type === "IDAT" || type === "IEND")) {
      out.push(...textChunk(PNG_TEXT_KEYWORD, id));
      inserted = true;
    }
    out.push(...bytes.subarray(start, start + total));
  }
  if (!inserted) return bytes;   // no IDAT and no IEND: not a file we understand
  return new Uint8Array(out);
}
