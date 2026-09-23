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
import { CAPTURE_ID_LENGTH, isCaptureId } from "./capture-id.js";

/** What `tagPng` writes. */
export const PNG_TEXT_KEYWORD = "stc-capture-id";

/**
 * What a PNG writer MIGHT key a `tEXt` description under. Read, never
 * written, by this module.
 *
 * This was added on the assumption that ImageIO turns
 * `kCGImagePropertyPNGDescription` into a `tEXt` chunk keyed `Description`.
 * **It does not** — see `xmpCaptureId` below for what it actually writes, and
 * for the measurement. The keyword is kept because it costs one cheap chunk
 * walk and a `tEXt`-writing encoder (ours is not the only one that could ever
 * produce a file here) would plausibly use it; it is no longer the path the
 * app's own stills take.
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

/**
 * Exported for `media-probe.ts` (STC-413 Task 4), which reads big-endian
 * fields out of box bodies (`mvhd`/`tkhd`) after locating them with
 * `mp4BoxesIn` below — the same primitive this module uses for box headers.
 */
export const readBe32 = (b: Uint8Array, at: number): number =>
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

/** Is this byte one a capture id's body may contain? Crockford base32. */
const ID_BODY_BYTE = (() => {
  const ok = new Uint8Array(256);
  for (const c of "0123456789ABCDEFGHJKMNPQRSTVWXYZ") ok[c.charCodeAt(0)] = 1;
  return ok;
})();

/**
 * The first capture-id-shaped token in a run of bytes, or undefined.
 *
 * Deliberately a SCAN rather than a parse. The bytes it is handed are XMP —
 * a whole RDF/XML document — and a real parser for that in a module that may
 * import neither node nor DOM would be a large amount of code standing
 * between a 500-file scan and an id it can already see. What makes the scan
 * safe is that it decides nothing: every candidate is gated through
 * `isCaptureId`, so the only strings it can return are ones that already
 * match the exact `cap_` + 26-Crockford shape `capture-id.ts` owns. A
 * 30-character token of that shape does not appear in a screenshot's
 * metadata by accident.
 *
 * The boundary check is the one subtlety: without it a LONGER run of
 * Crockford characters would have its first 30 read as an id. A candidate
 * must therefore not be followed by another body character — the id is a
 * whole token, never a prefix of something else.
 */
function captureIdIn(data: Uint8Array): string | undefined {
  for (let i = 0; i + CAPTURE_ID_LENGTH <= data.length; i++) {
    if (data[i] !== 0x63 || data[i + 1] !== 0x61       // "ca"
        || data[i + 2] !== 0x70 || data[i + 3] !== 0x5f) continue;   // "p_"
    const after = data[i + CAPTURE_ID_LENGTH];
    if (after !== undefined && ID_BODY_BYTE[after]) continue;
    const candidate = ascii(data, i, CAPTURE_ID_LENGTH);
    if (isCaptureId(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The id out of an `iTXt` chunk — which is where a still the app itself
 * produced actually carries it.
 *
 * **This is the path every still the app writes takes, and the original
 * `tEXt`-only reader could not see it.** `StillEncodeDecisions.swift` tags a
 * still by setting `kCGImagePropertyPNGDescription`, and ImageIO does not
 * turn that into a `tEXt` chunk: it routes it into XMP, in a single `iTXt`
 * chunk keyed `XML:com.adobe.xmp`. Dumped from the real built helper's
 * output, the chunk layout is
 *
 *     IHDR  sRGB  eXIf  iTXt(798)  IDAT  IEND
 *
 * and the id sits inside that `iTXt` body as
 * `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">cap_…</rdf:li>`.
 * So the id was in the file and unreadable by the only reader — every still
 * listed as two tiles, rename-in-Finder was broken for stills, and the
 * orphan sweep's `provable` gate failed on every still export.
 *
 * The chunk's KEYWORD is not checked. An `iTXt` chunk is textual metadata
 * whatever it is keyed under, `isCaptureId` is what decides, and pinning
 * `XML:com.adobe.xmp` would make the reader depend on an ImageIO
 * implementation detail that has already surprised this module once.
 */
function xmpCaptureId(bytes: Uint8Array): string | undefined {
  for (const [type, start, total] of pngChunks(bytes)) {
    if (type !== "iTXt") continue;
    // The whole chunk body, keyword and flags included — `captureIdIn`
    // needs no structure, and a compressed iTXt simply yields nothing
    // rather than garbage, since deflated bytes will not spell `cap_`
    // followed by 26 Crockford characters.
    const id = captureIdIn(bytes.subarray(start + 8, start + total - 4));
    if (id) return id;
  }
  return undefined;
}

/**
 * The id, or undefined for an untagged, foreign, truncated or corrupt file.
 *
 * Three sources are accepted, in a FIXED precedence rather than by chunk
 * order: `tagPng`'s own `tEXt` keyword, a `tEXt` description, then XMP in an
 * `iTXt` chunk (what ImageIO actually writes — see `xmpCaptureId`). A file
 * could carry more than one (ImageIO tagged it at export, something re-tagged
 * it later), and resolving by byte order would return whichever happened to
 * sit earlier in the file. A rule that depends on byte order is a rule nobody
 * can reason about.
 *
 * Every candidate is gated by `isCaptureId`, so a human-written description
 * cannot be read as identity.
 */
export function readPngCaptureId(bytes: Uint8Array): string | undefined {
  if (!isPng(bytes)) return undefined;
  return idUnderKeyword(bytes, PNG_TEXT_KEYWORD)
      ?? idUnderKeyword(bytes, IMAGEIO_TEXT_KEYWORD)
      ?? xmpCaptureId(bytes);
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

/**
 * Our private-data UUID. Constant and arbitrary: it only has to not collide
 * with another vendor's uuid box in the same file.
 */
export const MP4_UUID = new Uint8Array([
  0xa1, 0xc4, 0xb2, 0xe0, 0x7f, 0x3d, 0x4b, 0x58,
  0x9e, 0x21, 0x5c, 0x6d, 0x8f, 0x0a, 0x3b, 0x77,
]);

/**
 * Walk boxes within `[from, to)`. Yields `[type, start, totalLength]`.
 *
 * **Both extended sizes are HANDLED, not refused, and that is load-bearing.**
 * A `size == 1` box carries a 64-bit largesize after its type, and this
 * project's own `AVAssetWriter` output uses exactly that for `mdat` —
 * `fixtures/basic/display.mp4` is written that way. A walker that refuses it
 * is not being conservative: it reports an 83 KB file as two boxes long and
 * stops before the video data.
 *
 * `size == 0` means "to the end of the file", so such a box is necessarily
 * the last one; it is yielded with its true extent and the walk then ends.
 *
 * Exported (STC-413 Task 4) so `media-probe.ts` can walk `moov`'s CHILDREN —
 * `[from, to)` bounded to a box's own payload — without a second copy of this
 * function. Two walkers would be two places to get largesize right; there is
 * one. `mp4Boxes(b)` below is the original top-level-only entry point,
 * unchanged in behaviour, now a thin delegate.
 */
export function* mp4BoxesIn(b: Uint8Array, from: number, to: number):
    Generator<[string, number, number]> {
  let at = from;
  while (at + 8 <= to) {
    const declared = readBe32(b, at);
    const type = ascii(b, at + 4, 4);
    let size: number;
    if (declared === 1) {
      if (at + 16 > to) return;
      // The high word of a largesize would mean a box past 4 GiB. Nothing
      // this app produces comes close, and carrying it through a JS number
      // would lose precision — so such a file is refused rather than
      // mis-walked.
      if (readBe32(b, at + 8) !== 0) return;
      size = readBe32(b, at + 12);
      // A largesize below 16 is smaller than the 16-byte header it is part
      // of — malformed, not merely small. The old `size < 8` guard below let
      // this through and advanced into the middle of that same header; it
      // could not hang (the advance stays monotonic) but it was looser than
      // the format allows.
      if (size < 16) return;
    } else if (declared === 0) {
      size = to - at;                  // to end of the range: the last box
    } else {
      size = declared;
    }
    if (size < 8 || at + size > to) return;
    yield [type, at, size];
    at += size;
  }
}

function* mp4Boxes(b: Uint8Array): Generator<[string, number, number]> {
  yield* mp4BoxesIn(b, 0, b.length);
}

const isOurUuid = (b: Uint8Array, at: number): boolean =>
  MP4_UUID.every((v, i) => b[at + i] === v);

/** The id, or undefined for an untagged, foreign, truncated or corrupt file. */
export function readMp4CaptureId(bytes: Uint8Array): string | undefined {
  for (const [type, start, size] of mp4Boxes(bytes)) {
    if (type !== "uuid" || size < 8 + 16) continue;
    if (!isOurUuid(bytes, start + 8)) continue;
    const value = ascii(bytes, start + 24, size - 24);
    if (isCaptureId(value)) return value;
  }
  return undefined;
}

/**
 * Append the id as a trailing top-level `uuid` box, dropping any of ours
 * already present so re-tagging replaces rather than accumulates.
 *
 * Appending is what makes this safe: `stco`/`co64` chunk offsets point into
 * `mdat`, and nothing before the new box moves — so there are no offset
 * fixups and no in-place patching, on a buffer we already hold whole.
 */
export function tagMp4(bytes: Uint8Array, id: string): Uint8Array {
  if (!isCaptureId(id)) return bytes;

  const keep: Array<[number, number]> = [];
  let end = 0;
  let lastIsToEof = false;
  for (const [type, start, size] of mp4Boxes(bytes)) {
    end = start + size;
    lastIsToEof = readBe32(bytes, start) === 0;
    if (type === "uuid" && size >= 24 && isOurUuid(bytes, start + 8)) continue;
    keep.push([start, size]);
  }

  // REFUSE rather than truncate, and this is the single most important line
  // in the module. A walk that did not consume the whole buffer means a box
  // we could not parse; keeping only what came before it silently DESTROYS
  // the file. An earlier version did exactly that, turning a real 83,894-byte
  // capture into 82 bytes while every in-module test still passed — because a
  // truncated prefix is still a prefix.
  if (end !== bytes.length || keep.length === 0) return bytes;

  // A final `size == 0` box claims every byte to EOF, so anything appended
  // after it is read as part of THAT box rather than as our tag. Refuse; the
  // alternative is rewriting its size field, which is a bigger promise than
  // tagging should make.
  if (lastIsToEof) return bytes;

  const body = [...id].map((c) => c.charCodeAt(0));
  const size = 8 + MP4_UUID.length + body.length;
  const box = [...be32(size), ...[..."uuid"].map((c) => c.charCodeAt(0)),
               ...MP4_UUID, ...body];

  const out = new Uint8Array(keep.reduce((n, [, s]) => n + s, 0) + box.length);
  let at = 0;
  for (const [start, s] of keep) { out.set(bytes.subarray(start, start + s), at); at += s; }
  out.set(box, at);
  return out;
}

// ── HEIC ───────────────────────────────────────────────────────────────────

/**
 * Brands that mean "an HEIF-family still". `mif1`/`miaf` are the generic
 * image-container brands and appear in the compatible list of every HEIC this
 * app writes; the `he**`/`hev*` family are the HEVC-coded ones.
 *
 * This is a GUARD, not a dispatch — `library.ts` already picks the reader by
 * extension. It exists so a file that is not an HEIF at all cannot reach the
 * scan below on the strength of its filename.
 */
const HEIF_BRANDS = new Set([
  "heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs",
  "mif1", "msf1", "miaf",
]);

function isHeif(b: Uint8Array): boolean {
  for (const [type, start, size] of mp4Boxes(b)) {
    // ISO-BMFF requires `ftyp` FIRST. Anything else leading means this is not
    // a file we are willing to guess about.
    if (type !== "ftyp") return false;
    // major_brand, then minor_version (which spells no brand), then the
    // compatible_brands list — walked as one run of 4-byte codes.
    for (let at = start + 8; at + 4 <= start + size; at += 4) {
      if (HEIF_BRANDS.has(ascii(b, at, 4))) return true;
    }
    return false;
  }
  return false;
}

/**
 * The id out of a HEIC still.
 *
 * ## The measurement this is built on
 *
 * Taken on real hardware 2026-09-23, encoding one RGBA buffer through the
 * REAL helper three times with the same id and scanning each output's bytes:
 *
 *     png   1,193 bytes   id present
 *     heic  3,696 bytes   id present
 *     jpeg  3,990 bytes   id ABSENT
 *
 * So `StillEncodeDecisions.swift` setting only `kCGImagePropertyPNGDictionary`
 * does NOT mean the id is PNG-only: ImageIO normalises that description into
 * XMP, and HEIF carries XMP as an item. JPEG genuinely carries nothing, and
 * that stays a known limitation rather than a bug this module can close.
 *
 * On a 1,200x800 export (1,009,782 bytes) the XMP is `infe` item 9, type
 * `mime`, content-type `application/rdf+xml`, located by `iloc` at
 * offset 1,034 length 776 — with the id itself at byte 1,668. Well inside the
 * front window `library.ts` already reads for a PNG.
 *
 * ## Why a scan and not an `iloc` parse
 *
 * The same reasoning `xmpCaptureId` records one format over, with one extra
 * fact: **the XMP item's bytes live inside `mdat`** (`mdat` starts at 880
 * above, the item at 1,034), so no cheap structural bound excludes the
 * compressed HEVC payload. Excluding it exactly means resolving `iinf` →
 * `infe` → `iloc` through every version and field-width variant those boxes
 * allow — and the failure mode of getting that wrong on an unfamiliar
 * encoder's file is the SAME silent miss the scan already has, for several
 * times the code, inside a 500-file scan.
 *
 * What makes the scan safe is that it decides nothing: `captureIdIn` gates
 * every candidate through `isCaptureId`, so the only strings this can return
 * already match the exact `cap_` + 26-Crockford shape. For compressed bytes to
 * spell one by accident they must hit 4 exact bytes and then 26 bytes each
 * drawn from 32 of 256 values — about 2^-110 per position. A wrong id is not
 * a risk worth writing a parser against; a missed one degrades to exactly
 * today's behaviour.
 *
 * Bounded by whatever the caller hands in, never by this function.
 */
export function readHeicCaptureId(bytes: Uint8Array): string | undefined {
  if (!isHeif(bytes)) return undefined;
  return captureIdIn(bytes);
}
