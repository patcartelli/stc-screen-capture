import { describe, test, expect } from "vitest";
import { tagPng, readPngCaptureId, PNG_TEXT_KEYWORD, tagMp4, readMp4CaptureId } from "../src/media-tag.js";
import { mintCaptureId, CAPTURE_ID_LENGTH } from "../src/capture-id.js";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A structurally valid 1x1 PNG skeleton: signature, IHDR, IDAT, IEND. */
function skeletonPng(): Uint8Array {
  const chunk = (type: string, data: number[]): number[] => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
    const len = data.length;
    // CRC is checked by readers, not by our own walker — zeros are fine here,
    // and Task 2's implementation computes real ones for what it writes.
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
            ...body, 0, 0, 0, 0];
  };
  const ihdr = [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0];   // 1x1, RGBA
  return new Uint8Array([...SIG, ...chunk("IHDR", ihdr),
                         ...chunk("IDAT", [1, 2, 3]), ...chunk("IEND", [])]);
}

/**
 * Insert a tEXt chunk under an ARBITRARY keyword, so the test can stand in for
 * ImageIO's writer without a Mac. Test-local on purpose: the module exports no
 * keyword-parameterised writer, because production has exactly two writers and
 * neither needs one.
 */
function tagPngWithKeyword(bytes: Uint8Array, keyword: string, value: string): Uint8Array {
  const data = [...keyword].map((c) => c.charCodeAt(0))
    .concat(0, [...value].map((c) => c.charCodeAt(0)));
  const len = data.length;
  const text = [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
                ...[..."tEXt"].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  // After the 8-byte signature and the 25-byte IHDR chunk, before IDAT.
  return new Uint8Array([...bytes.subarray(0, 33), ...text, ...bytes.subarray(33)]);
}

describe("png capture-id tag", () => {
  test("round trips", () => {
    const id = mintCaptureId();
    expect(readPngCaptureId(tagPng(skeletonPng(), id))).toBe(id);
  });

  test("an untagged png has no id", () => {
    expect(readPngCaptureId(skeletonPng())).toBeUndefined();
  });

  test("a tEXt Description is read too", () => {
    const id = mintCaptureId();
    // This test used to be titled "that is how stills are tagged". It is NOT:
    // ImageIO turns kCGImagePropertyPNGDescription into XMP in an iTXt chunk,
    // never a tEXt one, so for a while every still the app produced carried an
    // id this reader could not see. See the XMP tests below, and the round
    // trip against the real encoder in helper/test/still-encode.test.ts. The
    // keyword is still read because a tEXt-writing encoder would plausibly
    // use it, but it is not the app's own path.
    const out = tagPngWithKeyword(skeletonPng(), "Description", id);
    expect(readPngCaptureId(out)).toBe(id);
  });

  test("a human-written Description is not mistaken for an id", () => {
    const out = tagPngWithKeyword(skeletonPng(), "Description", "screenshot of the login bug");
    expect(readPngCaptureId(out)).toBeUndefined();
  });

  test("our own keyword wins over Description, whatever the byte order", () => {
    // A file can legitimately carry both. Resolving by chunk order would
    // return whichever sat earlier, which is not a rule anyone can reason about.
    const ours = mintCaptureId(), theirs = mintCaptureId();
    const bothWaysRound = [
      tagPng(tagPngWithKeyword(skeletonPng(), "Description", theirs), ours),
      tagPngWithKeyword(tagPng(skeletonPng(), ours), "Description", theirs),
    ];
    for (const out of bothWaysRound) expect(readPngCaptureId(out)).toBe(ours);
  });

  test("the tag goes before IDAT, where a tEXt chunk is legal", () => {
    const out = tagPng(skeletonPng(), mintCaptureId());
    const s = Buffer.from(out).toString("latin1");
    expect(s.indexOf(PNG_TEXT_KEYWORD)).toBeGreaterThan(-1);
    expect(s.indexOf(PNG_TEXT_KEYWORD)).toBeLessThan(s.indexOf("IDAT"));
  });

  test("tagging twice replaces rather than accumulating", () => {
    const a = mintCaptureId(), b = mintCaptureId();
    const out = tagPng(tagPng(skeletonPng(), a), b);
    expect(readPngCaptureId(out)).toBe(b);
    const s = Buffer.from(out).toString("latin1");
    expect(s.split(PNG_TEXT_KEYWORD).length - 1).toBe(1);
  });

  test("garbage degrades to no id rather than throwing", () => {
    for (const bad of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(SIG),                              // signature, no chunks
      new Uint8Array([...SIG, 0xff, 0xff, 0xff, 0xff]), // length past the end
    ]) {
      expect(() => readPngCaptureId(bad)).not.toThrow();
      expect(readPngCaptureId(bad)).toBeUndefined();
    }
  });

  test("a non-png is refused rather than corrupted", () => {
    const notPng = new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]);
    expect(tagPng(notPng, mintCaptureId())).toEqual(notPng);
  });
});

/**
 * STC-413 C1: the chunk ImageIO actually writes.
 *
 * `kCGImagePropertyPNGDescription` becomes XMP in an `iTXt` chunk keyed
 * `XML:com.adobe.xmp`, not a `tEXt` chunk keyed `Description` — so for a
 * while every still the app produced carried an id the only reader could not
 * see, and the encoder's own tests could not tell, because they asserted on
 * the properties dictionary rather than on the bytes.
 *
 * `helper/test/still-encode.test.ts` is the round trip against the REAL
 * encoder and is the assertion that matters; these are the same claim made
 * on a checkout with no Mac, plus the boundary cases no real file supplies.
 */
describe("png capture-id in XMP (iTXt), which is what ImageIO writes", () => {
  /**
   * The real chunk's body, verbatim in shape: the `XML:com.adobe.xmp`
   * keyword, iTXt's four flag/language bytes, then the RDF the id sits in.
   */
  function xmpPng(body: string): Uint8Array {
    const data = [...chars("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...chars(body)];
    const len = data.length;
    const chunk = [...be32(len), ...chars("iTXt"), ...data, 0, 0, 0, 0];
    return new Uint8Array([...skeletonPng().subarray(0, 33), ...chunk,
                           ...skeletonPng().subarray(33)]);
  }

  const rdf = (v: string) =>
    `<x:xmpmeta><rdf:RDF><rdf:Description><dc:description><rdf:Alt>` +
    `<rdf:li xml:lang="x-default">${v}</rdf:li>` +
    `</rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;

  test("the id is read out of the XMP an ImageIO export carries", () => {
    const id = mintCaptureId();
    expect(readPngCaptureId(xmpPng(rdf(id)))).toBe(id);
  });

  test("a human-written description in XMP is not mistaken for an id", () => {
    expect(readPngCaptureId(xmpPng(rdf("screenshot of the login bug")))).toBeUndefined();
  });

  test("a longer token starting cap_ is not read as its own 30-character prefix", () => {
    // The scan's one real hazard: without the boundary check, any run of
    // Crockford characters long enough would have its head read as an id.
    const id = mintCaptureId();
    expect(readPngCaptureId(xmpPng(rdf(id + "XYZ")))).toBeUndefined();
  });

  test("a tEXt tag still wins over XMP, whatever the byte order", () => {
    const ours = mintCaptureId(), theirs = mintCaptureId();
    expect(readPngCaptureId(tagPng(xmpPng(rdf(theirs)), ours))).toBe(ours);
  });

  test("an iTXt chunk with no id at all degrades to undefined", () => {
    expect(readPngCaptureId(xmpPng(rdf("")))).toBeUndefined();
  });
});

// Hoisted to module scope: the extended-size tests below build their own
// box layouts and need these too.
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type: string, data: number[]) =>
  [...be32(8 + data.length), ...chars(type), ...data];

/** A structurally valid minimal MP4: an ftyp box and an mdat box. */
function skeletonMp4(): Uint8Array {
  return new Uint8Array([
    ...box("ftyp", [...chars("isom"), 0, 0, 0, 0]),
    ...box("mdat", [9, 9, 9, 9, 9, 9, 9, 9]),
  ]);
}

describe("mp4 capture-id tag", () => {
  test("round trips", () => {
    const id = mintCaptureId();
    expect(readMp4CaptureId(tagMp4(skeletonMp4(), id))).toBe(id);
  });

  test("an untagged mp4 has no id", () => {
    expect(readMp4CaptureId(skeletonMp4())).toBeUndefined();
  });

  test("the original bytes are preserved exactly — nothing before the tag moves", () => {
    const original = skeletonMp4();
    const out = tagMp4(original, mintCaptureId());
    expect(out.subarray(0, original.length)).toEqual(original);
    expect(out.length).toBeGreaterThan(original.length);
  });

  test("tagging twice replaces rather than accumulating", () => {
    const a = mintCaptureId(), b = mintCaptureId();
    const out = tagMp4(tagMp4(skeletonMp4(), a), b);
    expect(readMp4CaptureId(out)).toBe(b);
    expect(out.length).toBe(tagMp4(skeletonMp4(), b).length);
  });

  test("garbage degrades to no id rather than throwing", () => {
    for (const bad of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0, 0, 0, 200, 102, 116, 121, 112]),  // size past the end
    ]) {
      expect(() => readMp4CaptureId(bad)).not.toThrow();
      expect(readMp4CaptureId(bad)).toBeUndefined();
    }
  });

  // ── the extended sizes, which real files actually use ──────────────────

  /** A box whose size is carried in a 64-bit largesize, as AVAssetWriter writes mdat. */
  function largesizeBox(type: string, payload: number[]): number[] {
    const total = 16 + payload.length;
    return [0, 0, 0, 1, ...[...type].map((c) => c.charCodeAt(0)),
            0, 0, 0, 0, ...be32(total), ...payload];
  }

  test("A LARGESIZE BOX IS WALKED, NOT TRUNCATED", () => {
    // The regression that reduced a real 83,894-byte capture to 82 bytes.
    const id = mintCaptureId();
    const original = new Uint8Array([
      ...box("ftyp", chars("isom")),
      ...largesizeBox("mdat", [7, 7, 7, 7, 7, 7, 7, 7]),
      ...box("moov", [1, 2, 3, 4]),
    ]);
    const out = tagMp4(original, id);
    expect(out.subarray(0, original.length)).toEqual(original);   // nothing lost
    expect(out.length).toBeGreaterThan(original.length);
    expect(readMp4CaptureId(out)).toBe(id);                       // readable past mdat
  });

  test("THE REAL FIXTURE SURVIVES TAGGING", async () => {
    // The check that would have caught this immediately. fixtures/basic/
    // display.mp4 is this project's own AVAssetWriter output and its mdat
    // uses a largesize.
    const { readFile } = await import("node:fs/promises");
    const original = new Uint8Array(await readFile("fixtures/basic/display.mp4"));
    const id = mintCaptureId();
    const out = tagMp4(original, id);
    expect(out.subarray(0, original.length)).toEqual(original);
    expect(out.length).toBe(original.length + 4 + 4 + 16 + CAPTURE_ID_LENGTH);
    expect(readMp4CaptureId(out)).toBe(id);
  });

  test("a file we cannot fully walk is REFUSED, never truncated", () => {
    const truncated = new Uint8Array([
      ...box("ftyp", chars("isom")),
      0, 0, 0, 200, ...chars("mdat"), 1, 2, 3,     // claims 200 bytes, has 3
    ]);
    expect(tagMp4(truncated, mintCaptureId())).toEqual(truncated);
  });

  test("a trailing to-EOF box is refused — our tag would land inside it", () => {
    const toEof = new Uint8Array([
      ...box("ftyp", chars("isom")),
      0, 0, 0, 0, ...chars("mdat"), 9, 9, 9, 9,
    ]);
    expect(tagMp4(toEof, mintCaptureId())).toEqual(toEof);
  });

  test("a largesize below 16 is malformed and yields nothing, not a mis-walk", () => {
    // declared size 1 (largesize follows), type "mdat", largesize = 12 — smaller
    // than the 16-byte header it is claimed to be part of.
    const malformed = new Uint8Array([
      ...box("ftyp", chars("isom")),
      0, 0, 0, 1, ...chars("mdat"), ...be32(0), ...be32(12),
    ]);
    // The walk cannot get past the malformed box, so it never reaches the end
    // of the buffer, and tagMp4 refuses rather than tagging a partial file.
    expect(tagMp4(malformed, mintCaptureId())).toEqual(malformed);
    expect(readMp4CaptureId(malformed)).toBeUndefined();
  });
});
