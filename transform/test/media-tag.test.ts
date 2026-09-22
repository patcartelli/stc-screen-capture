import { describe, test, expect } from "vitest";
import { tagPng, readPngCaptureId, PNG_TEXT_KEYWORD, tagMp4, readMp4CaptureId } from "../src/media-tag.js";
import { mintCaptureId } from "../src/capture-id.js";

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

  test("ImageIO's Description keyword is read too — that is how stills are tagged", () => {
    const id = mintCaptureId();
    // Exactly the chunk CGImageDestination writes for kCGImagePropertyPNGDescription.
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

/** A structurally valid minimal MP4: an ftyp box and an mdat box. */
function skeletonMp4(): Uint8Array {
  const box = (type: string, data: number[]): number[] => {
    const size = 8 + data.length;
    return [(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255,
            ...[...type].map((c) => c.charCodeAt(0)), ...data];
  };
  return new Uint8Array([
    ...box("ftyp", [...["isom"].flatMap((s) => [...s].map((c) => c.charCodeAt(0))), 0, 0, 0, 0]),
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
      new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112]),    // size 0 == to EOF
    ]) {
      expect(() => readMp4CaptureId(bad)).not.toThrow();
      expect(readMp4CaptureId(bad)).toBeUndefined();
    }
  });
});
