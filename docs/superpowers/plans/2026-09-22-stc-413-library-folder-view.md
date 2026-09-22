# STC-413: Library as a View Over a Folder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the library from a store the app owns into a view over the user's
chosen folder — finished captures as plain files at top level, source bundles in
`raw/`, and identity embedded in the media file so it survives any rename.

**Architecture:** Three new pure modules in `transform/src/` (mint an id, embed
and read it in MP4/PNG bytes, probe duration and dimensions from header bytes),
then a rewritten scan in `app/src/library.ts` that merges top-level media files
with `raw/` bundles into the **existing** `LibraryItem` contract. The adapter
boundary STC-294 built is what lets storage change underneath without touching
`library-items.ts` or `library-view.ts`.

**Tech Stack:** TypeScript (vitest), Swift 5.8 / ImageIO for the PNG writer,
`mp4-muxer` for the MP4 writer, Electron + Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-09-22-stc-413-library-folder-view-design.md`

---

## Global Constraints

- **Three typecheck passes, always.** Run `npm run typecheck`, never bare `tsc`
  — that runs one of three. All three must be clean before any commit.
- **`transform/src/` may not import node or DOM.** The browser pass follows even
  a type-only import. The three new modules are pure `Uint8Array` in, plain data
  out. No `node:fs`, no `Buffer`, no `document`.
- **No new dependencies.** CRC-32 for the PNG chunk is ~15 lines and must be
  written, not installed.
- **Never read a whole media file.** Probes read header bytes only — PNG `IHDR`
  is the first 24 bytes; MP4 walks top-level boxes. This is what keeps a
  500-file scan affordable and it is a hard rule, not an optimisation.
- **Degrade, never throw.** A corrupt tag, an unparseable container or a missing
  bundle yields "reduced metadata" — the item still lists. No scan path may
  throw on one bad file; CLAUDE.md's existing rule is that a take which quietly
  vanishes is indistinguishable from one that was deleted.
- **Capture id format:** `cap_` + 26 Crockford base32 chars (`0-9A-HJKMNP-TV-Z`
  — no I, L, O, U). Exactly 30 characters. Uppercase only.
- **Embedded payload key:** `stc-capture-id` (PNG `tEXt` keyword) and UUID
  `A1C4B2E0-7F3D-4B58-9E21-5C6D8F0A3B77` (MP4 `uuid` box).
- **`stripMetadata` does NOT suppress the id.** *Assumption, flagged in the
  spec's Open Decisions.* The id is opaque — no timestamp, no path — so it leaks
  nothing STC-293 protects, and suppressing it would make a privacy-stripped
  export permanently uneditable. It is a separate field from `capturedAt`.
- **Commit after every task.** Never batch.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `transform/src/capture-id.ts` | Mint and validate the id. Nothing else. |
| `transform/src/media-tag.ts` | Embed/extract the id in MP4 and PNG bytes. |
| `transform/src/media-probe.ts` | Duration + dimensions from header bytes. |
| `schema/capture-1.schema.json` | A bundle's identity document. |
| `transform/src/capture-doc.ts` | Parse/serialize it. Pure. |
| `app/src/capture-identity.ts` | `ensureCaptureId` — the IO half, race-guarded. |
| `transform/test/capture-doc.test.ts` | Task 5. |
| `app/test/capture-identity.test.ts` | Task 5. |
| `transform/test/capture-id.test.ts` | Task 1. |
| `transform/test/media-tag.test.ts` | Tasks 2-3. |
| `transform/test/media-probe.test.ts` | Task 4. |
| `transform/test/export-tag.test.ts` | Task 7. |
| `app/test/library-scan.test.ts` | Tasks 8 and 14 (the scan, and its 500-file measurement). |
| `app/test/orphan-sweep.test.ts` | Task 12. |
| `app/test/library-folder.e2e.test.ts` | Tasks 11 and 13 — end-to-end behaviour, and the only home for this plan's e2e helpers. |

**Modified:**

| Path | Change |
|---|---|
| `helper/src/StillEncodeDecisions.swift:321` | Add the id key to `stillImageProperties`. |
| `helper/src/StillEncode.swift` | Carry `captureId` on the request. |
| `transform/src/export.ts:339-340` | Tag the buffer after `finalize()`. |
| `app/src/takes.ts` | `RAW_SUBDIR`; `newTakeDir` targets `raw/`; retire `setTakeLabel`. |
| `app/src/temp-takes.ts` | `promoteTake` lands in `raw/`; orphan sweep. |
| `app/src/library.ts` | The scan rewrite. |
| `app/src/share.ts` | `planPublish` reads the top-level export. |
| `app/src/main.ts` | Delete removes both objects; take-dir handlers resolve `raw/`. |

**Deliberately untouched:** `app/src/library-items.ts`, `app/src/library-view.ts`.
If a task seems to need a change there, stop — that is the seam leaking, and
`app/test/library-seam.test.ts` will fail. Widen `LibraryItem` deliberately
instead, as rule 1 of that file's header instructs.

---

# PHASE 1 — Identity and tagging

Phase 1 changes **no file locations**. It adds ids to what the app writes and
proves they can be read back. It is independently shippable: nothing
user-visible changes, and Phase 2 depends on it for identity.

---

### Task 1: Capture id

**Files:**
- Create: `transform/src/capture-id.ts`
- Test: `transform/test/capture-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CAPTURE_ID_LENGTH: 30`, `mintCaptureId(random?: () => number): string`,
  `isCaptureId(v: unknown): v is string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { mintCaptureId, isCaptureId, CAPTURE_ID_LENGTH } from "../src/capture-id.js";

describe("capture id", () => {
  test("a minted id validates and is the declared length", () => {
    const id = mintCaptureId();
    expect(isCaptureId(id)).toBe(true);
    expect(id).toHaveLength(CAPTURE_ID_LENGTH);
    expect(id.startsWith("cap_")).toBe(true);
  });

  test("two mints differ", () => {
    expect(mintCaptureId()).not.toBe(mintCaptureId());
  });

  test("the alphabet excludes the ambiguous Crockford letters", () => {
    // 200 mints is enough to see any of I/L/O/U if they were reachable.
    const body = Array.from({ length: 200 }, () => mintCaptureId().slice(4)).join("");
    expect(body).not.toMatch(/[ILOU]/);
    expect(body).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  test("refuses everything that is not an id", () => {
    for (const bad of [
      "", "cap_", "nope", 42, null, undefined, {},
      "cap_" + "A".repeat(25),            // too short
      "cap_" + "A".repeat(27),            // too long
      "CAP_" + "A".repeat(26),            // wrong prefix case
      "cap_" + "a".repeat(26),            // lowercase body
      "cap_" + "I".repeat(26),            // excluded letter
    ]) {
      expect(isCaptureId(bad as unknown)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run transform/test/capture-id.test.ts`
Expected: FAIL — cannot resolve `../src/capture-id.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * A capture's stable identity, embedded in the media file it produced
 * (STC-413).
 *
 * Opaque on purpose: no timestamp, no path, no user data. It exists only to
 * point a finished file back at its source bundle in `raw/`, so it must be
 * safe to embed in a file the user may share — which is also why
 * `stripMetadata` does not suppress it.
 *
 * Its own module so the shape and its validation have exactly ONE owner. This
 * repo's most-repeated defect is one value with two copies.
 */

/** Crockford base32: no I, L, O or U, so a transcribed id cannot be ambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PREFIX = "cap_";
const BODY_LENGTH = 26;

export const CAPTURE_ID_LENGTH = PREFIX.length + BODY_LENGTH;

const PATTERN = new RegExp(`^${PREFIX}[${ALPHABET}]{${BODY_LENGTH}}$`);

/**
 * `random` is injected rather than reached for, so a test can pin the output.
 * Math.random is not cryptographic and does not need to be: this is a
 * collision-avoidance token within one user's folder, not a secret.
 */
export function mintCaptureId(random: () => number = Math.random): string {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    body += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? ALPHABET[0];
  }
  return PREFIX + body;
}

export function isCaptureId(v: unknown): v is string {
  return typeof v === "string" && PATTERN.test(v);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run transform/test/capture-id.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/capture-id.ts transform/test/capture-id.test.ts
git commit -m "STC-413: capture id — one owner for the shape and its validation"
```

---

### Task 2: Tag and read a PNG

**Files:**
- Create: `transform/src/media-tag.ts`
- Test: `transform/test/media-tag.test.ts`

**Interfaces:**
- Consumes: `isCaptureId` from Task 1.
- Produces: `tagPng(bytes: Uint8Array, id: string): Uint8Array`,
  `readPngCaptureId(bytes: Uint8Array): string | undefined`,
  `PNG_TEXT_KEYWORD: "stc-capture-id"`,
  `IMAGEIO_TEXT_KEYWORD: "Description"`.

**Two keywords, one reader — ruled at pre-flight, and not an oversight.** The
production writer for stills is ImageIO (Task 6), because it covers PNG, JPEG
and HEIC in one place where `tagPng` covers only PNG — and ImageIO writes a
`tEXt` chunk keyed `Description`, not ours. So `readPngCaptureId` accepts
**either** keyword, with every candidate gated by `isCaptureId`: a
30-character `cap_`-prefixed Crockford string is not something a human writes
into a description field by accident.

`tagPng` therefore has no production caller yet, and that is deliberate rather
than dead code — it is what makes `readPngCaptureId` verifiable on a checkout
with no Swift toolchain, which is this repo's chronic verification gap. Say so
in the module header so a reviewer does not flag it.

**Format note for the implementer:** a PNG is an 8-byte signature followed by
chunks of `[length:4][type:4][data:length][crc:4]`, all big-endian. The CRC
covers **type + data**, not the length. A `tEXt` chunk's data is
`keyword \0 value` in Latin-1. We insert before the first `IDAT`, which is where
ancillary text chunks are legal.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { tagPng, readPngCaptureId, PNG_TEXT_KEYWORD } from "../src/media-tag.js";
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run transform/test/media-tag.test.ts`
Expected: FAIL — cannot resolve `../src/media-tag.js`.

- [ ] **Step 3: Write the implementation**

```ts
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
 */
import { isCaptureId } from "./capture-id.js";

export const PNG_TEXT_KEYWORD = "stc-capture-id";

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

const be32 = (n: number): number[] =>
  [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const readBe32 = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

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

/** The id, or undefined for an untagged, foreign, truncated or corrupt file. */
export function readPngCaptureId(bytes: Uint8Array): string | undefined {
  if (!isPng(bytes)) return undefined;
  for (const [type, start, total] of pngChunks(bytes)) {
    if (type !== "tEXt") continue;
    const data = bytes.subarray(start + 8, start + total - 4);
    const nul = data.indexOf(0);
    if (nul < 0) continue;
    if (ascii(data, 0, nul) !== PNG_TEXT_KEYWORD) continue;
    const value = ascii(data, nul + 1, data.length - nul - 1);
    if (isCaptureId(value)) return value;
  }
  return undefined;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run transform/test/media-tag.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation check — prove the round-trip test has teeth**

Temporarily make `tagPng` return `bytes` unchanged as its first line. Re-run.
Expected: the round-trip, ordering and replace tests FAIL; the "untagged", 
"garbage" and "non-png" tests still pass. Revert the mutation.

This matters because a tag writer that silently no-ops is the exact failure
that would make every later task look correct while embedding nothing.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/media-tag.ts transform/test/media-tag.test.ts
git commit -m "STC-413: embed a capture id in a PNG tEXt chunk"
```

---

### Task 3: Tag and read an MP4

**Files:**
- Modify: `transform/src/media-tag.ts`
- Modify: `transform/test/media-tag.test.ts`

**Interfaces:**
- Consumes: `isCaptureId` (Task 1), the helpers in `media-tag.ts` (Task 2).
- Produces: `tagMp4(bytes: Uint8Array, id: string): Uint8Array`,
  `readMp4CaptureId(bytes: Uint8Array): string | undefined`,
  `MP4_UUID: Uint8Array` (16 bytes).

**Format note:** ISO-BMFF is a flat sequence of boxes, each
`[size:4][type:4][payload]`, big-endian, where `size` counts the header. A
`uuid` box carries a 16-byte UUID then private data. **We append at the very
end**, which is why no offset fixups are needed: `stco`/`co64` entries point
into `mdat`, and appending moves nothing. Conforming readers skip unknown
top-level boxes. `size == 1` means a 64-bit `largesize` follows the type;
`size == 0` means "to end of file".

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
import { tagMp4, readMp4CaptureId } from "../src/media-tag.js";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run transform/test/media-tag.test.ts`
Expected: FAIL — `tagMp4` is not exported.

- [ ] **Step 3: Write the implementation (append to `media-tag.ts`)**

```ts
/**
 * Our private-data UUID. Constant and arbitrary: it only has to not collide
 * with another vendor's uuid box in the same file.
 */
export const MP4_UUID = new Uint8Array([
  0xa1, 0xc4, 0xb2, 0xe0, 0x7f, 0x3d, 0x4b, 0x58,
  0x9e, 0x21, 0x5c, 0x6d, 0x8f, 0x0a, 0x3b, 0x77,
]);

/**
 * Walk top-level boxes. Yields `[type, start, totalLength]`.
 *
 * Refuses rather than guesses on the two sizes that cannot be walked past:
 * `size == 0` ("to end of file", so there is no next box) and `size == 1`
 * (64-bit largesize, which we never write and do not need to read).
 */
function* mp4Boxes(b: Uint8Array): Generator<[string, number, number]> {
  let at = 0;
  while (at + 8 <= b.length) {
    const size = readBe32(b, at);
    if (size < 8 || at + size > b.length) return;
    yield [ascii(b, at + 4, 4), at, size];
    at += size;
  }
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
  let sawAny = false;
  for (const [type, start, size] of mp4Boxes(bytes)) {
    sawAny = true;
    if (type === "uuid" && size >= 24 && isOurUuid(bytes, start + 8)) continue;
    keep.push([start, size]);
  }
  if (!sawAny) return bytes;   // not a box structure we understand

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run transform/test/media-tag.test.ts`
Expected: PASS, 11 tests (6 from Task 2 plus 5).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/media-tag.ts transform/test/media-tag.test.ts
git commit -m "STC-413: embed a capture id in a trailing MP4 uuid box"
```

---

### Task 4: Probe duration and dimensions from header bytes

**Files:**
- Create: `transform/src/media-probe.ts`
- Test: `transform/test/media-probe.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately — it must work on foreign files that carry no id).
- Produces: `probePng(bytes: Uint8Array): MediaFacts | undefined`,
  `probeMp4(bytes: Uint8Array): MediaFacts | undefined`,
  `interface MediaFacts { width: number; height: number; durationMs?: number }`,
  `MP4_TAIL_PROBE_BYTES: 65536`.

**Format note:** PNG `IHDR` is always the first chunk: width is bytes 16-19,
height 20-23, big-endian. For MP4, `moov` contains `mvhd` (timescale + duration)
and `trak/tkhd` (width/height as 16.16 fixed point). `mvhd` v0 body:
`version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)`; v1
widens creation/modification to 8 and duration to 8. `tkhd` v0 puts width at
body offset 76 and height at 80; v1 at 88 and 92.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { probePng, probeMp4, MP4_TAIL_PROBE_BYTES } from "../src/media-probe.js";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];

function png(w: number, h: number): Uint8Array {
  const ihdr = [...be32(w), ...be32(h), 8, 6, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be32(ihdr.length), ...chars("IHDR"), ...ihdr, 0, 0, 0, 0]);
}

/** timescale 600, duration 3000 → 5000 ms; track 1920x1080. */
function mp4(): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(3000)]);
  const tkhd = box("tkhd", [
    0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(0), ...be32(0),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(36).fill(0),
    ...be32(1920 * 65536), ...be32(1080 * 65536),
  ]);
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [...mvhd, ...box("trak", tkhd)])]);
}

describe("media probe", () => {
  test("png dimensions come from IHDR", () => {
    expect(probePng(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  test("mp4 duration and dimensions", () => {
    expect(probeMp4(mp4())).toEqual({ width: 1920, height: 1080, durationMs: 5000 });
  });

  test("a foreign file we cannot parse probes to undefined, never a throw", () => {
    for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3]),
                       new Uint8Array(chars("not a media file at all"))]) {
      expect(() => probePng(bad)).not.toThrow();
      expect(() => probeMp4(bad)).not.toThrow();
      expect(probePng(bad)).toBeUndefined();
      expect(probeMp4(bad)).toBeUndefined();
    }
  });

  test("an mp4 with no moov yields undefined rather than zeroes", () => {
    const noMoov = new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2])]);
    expect(probeMp4(noMoov)).toBeUndefined();
  });

  test("the tail probe window is big enough for a real moov", () => {
    // A 4K take's moov is tens of KB; 64 KB is the declared window.
    expect(MP4_TAIL_PROBE_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run transform/test/media-probe.test.ts`
Expected: FAIL — cannot resolve `../src/media-probe.js`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Duration and dimensions, from HEADER BYTES ONLY (STC-413).
 *
 * Never reads a whole file. That is the constraint that keeps a 500-file
 * library scan affordable — STC-294's own acceptance criterion is 500 takes —
 * and it is why this module takes bytes rather than a path: the caller decides
 * how little to read, and `MP4_TAIL_PROBE_BYTES` tells it how much that is.
 *
 * Takes no capture id and knows nothing about one, deliberately: these facts
 * must be available for a FOREIGN file dropped into the folder by hand, which
 * carries no id at all.
 */

export interface MediaFacts {
  width: number;
  height: number;
  /** Absent when the container declares no usable duration (any still). */
  durationMs?: number;
}

/**
 * How much of an MP4's tail to read before falling back to a front walk.
 *
 * `AVAssetWriter` and `mp4-muxer` both put `moov` at the END, so the tail is
 * where it is for every file this app produces. A faststart file from another
 * tool has it at the front, which the fallback covers.
 */
export const MP4_TAIL_PROBE_BYTES = 65536;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const be32 = (b: Uint8Array, at: number): number =>
  at + 4 <= b.length
    ? ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
    : 0;

const type4 = (b: Uint8Array, at: number): string =>
  String.fromCharCode(...b.subarray(at, at + 4));

export function probePng(bytes: Uint8Array): MediaFacts | undefined {
  if (bytes.length < 24 || !PNG_SIG.every((v, i) => bytes[i] === v)) return undefined;
  if (type4(bytes, 12) !== "IHDR") return undefined;
  const width = be32(bytes, 16), height = be32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Walk boxes within `[from, to)`, yielding `[type, payloadStart, payloadEnd]`. */
function* boxes(b: Uint8Array, from: number, to: number):
    Generator<[string, number, number]> {
  let at = from;
  while (at + 8 <= to) {
    const size = be32(b, at);
    if (size < 8 || at + size > to) return;
    yield [type4(b, at + 4), at + 8, at + size];
    at += size;
  }
}

/** Depth-first search for the first box of `type`. */
function find(b: Uint8Array, from: number, to: number, type: string,
              depth = 0): [number, number] | undefined {
  if (depth > 6) return undefined;             // containers here are shallow
  for (const [t, s, e] of boxes(b, from, to)) {
    if (t === type) return [s, e];
    if (CONTAINERS.has(t)) {
      const hit = find(b, s, e, type, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

export function probeMp4(bytes: Uint8Array): MediaFacts | undefined {
  const moov = find(bytes, 0, bytes.length, "moov");
  if (!moov) return undefined;
  const [ms, me] = moov;

  let durationMs: number | undefined;
  const mvhd = find(bytes, ms, me, "mvhd");
  if (mvhd) {
    const [s] = mvhd;
    const v = bytes[s];
    const timescale = v === 1 ? be32(bytes, s + 20) : be32(bytes, s + 12);
    // A v1 duration is 64-bit; the low word is ample for any real take.
    const duration = v === 1 ? be32(bytes, s + 28) : be32(bytes, s + 16);
    if (timescale > 0 && duration > 0) durationMs = Math.round((duration / timescale) * 1000);
  }

  const tkhd = find(bytes, ms, me, "tkhd");
  if (!tkhd) return undefined;
  const [s] = tkhd;
  const at = bytes[s] === 1 ? s + 88 : s + 76;
  const width = Math.round(be32(bytes, at) / 65536);
  const height = Math.round(be32(bytes, at + 4) / 65536);
  if (width <= 0 || height <= 0) return undefined;

  return durationMs === undefined ? { width, height } : { width, height, durationMs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run transform/test/media-probe.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify against a REAL file, not only a synthetic one**

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const { probeMp4 } = await import('./transform/src/media-probe.ts');
console.log(probeMp4(new Uint8Array(readFileSync('fixtures/basic/display.mp4'))));
"
```

Expected: real width/height/durationMs for the committed fixture, not
`undefined`. If this prints `undefined` the box walk is wrong in a way the
synthetic fixture did not catch — fix it before moving on. A synthetic fixture
built by the same mind that wrote the parser can agree with a shared mistake.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/media-probe.ts transform/test/media-probe.test.ts
git commit -m "STC-413: probe duration and dimensions from header bytes only"
```

---

### Task 5: Mint the id and persist it in the bundle

**Why this task exists:** Tasks 6 and 7 both consume a `captureId`, and Task 8's
scan matches a finished file's embedded id against its bundle. Nothing
otherwise writes one. The spec's flow line says "id minted into
`anchors.json`/`shot.json`", which would mean bumping two schemas and a Swift
writer; this is the cheaper shape, ruled on at pre-flight.

**The id is minted LAZILY, at export time.** A bundle with no finished file
needs no identity — nothing points back at it — so nothing on the capture or
promote path changes. `ensureCaptureId` is called by the two export paths and
by nothing else.

**Files:**
- Create: `schema/capture-1.schema.json`
- Create: `transform/src/capture-doc.ts`
- Create: `transform/test/capture-doc.test.ts`
- Create: `app/src/capture-identity.ts`
- Create: `app/test/capture-identity.test.ts`

**Interfaces:**
- Consumes: `mintCaptureId`, `isCaptureId` (Task 1).
- Produces: `CAPTURE_DOC_FILE: "capture.json"`,
  `parseCaptureDoc(doc: unknown): CaptureDoc` (refuses, never defaults),
  `captureDocForWrite(id: string): CaptureDoc`,
  `interface CaptureDoc { version: 1; id: string }`, and
  `ensureCaptureId(bundleDir: string): Promise<string>`.

**The load-bearing property is IDEMPOTENCE.** A second export of the same take
must return the SAME id — otherwise re-exporting silently orphans the file
exported before it, which is the exact failure this design exists to prevent.

- [ ] **Step 1: Write the failing tests**

`transform/test/capture-doc.test.ts` — schema and loader checked against each
other, the pattern `changes.test.ts` and `recording-1` already set:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { parseCaptureDoc, captureDocForWrite } from "../src/capture-doc.js";
import { mintCaptureId } from "../src/capture-id.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema = JSON.parse(readFileSync(join(root, "schema/capture-1.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

describe("capture-1 schema and loader agree", () => {
  test("a written document validates and round trips", () => {
    const id = mintCaptureId();
    const doc = captureDocForWrite(id);
    expect(validate(doc)).toBe(true);
    expect(parseCaptureDoc(doc).id).toBe(id);
  });

  test("the loader REFUSES rather than defaulting", () => {
    for (const bad of [
      {}, null, "nope", { version: 1 }, { id: mintCaptureId() },
      { version: 2, id: mintCaptureId() },
      { version: 1, id: "not-an-id" },
      { version: 1, id: mintCaptureId(), extra: true },   // noExtra, like parseShot
    ]) {
      expect(() => parseCaptureDoc(bad)).toThrow();
    }
  });
});
```

`app/test/capture-identity.test.ts` — the IO half:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCaptureId } from "../src/capture-identity.js";
import { CAPTURE_DOC_FILE } from "@transform/capture-doc.js";
import { isCaptureId } from "@transform/capture-id.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "stc-id-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ensureCaptureId", () => {
  test("mints an id and writes it into the bundle", async () => {
    const id = await ensureCaptureId(dir);
    expect(isCaptureId(id)).toBe(true);
    const doc = JSON.parse(await readFile(join(dir, CAPTURE_DOC_FILE), "utf8"));
    expect(doc.id).toBe(id);
  });

  test("IS IDEMPOTENT — a second export reuses the first id", async () => {
    // If this fails, re-exporting a take orphans the file exported before it.
    expect(await ensureCaptureId(dir)).toBe(await ensureCaptureId(dir));
  });

  test("a corrupt document is replaced rather than thrown on", async () => {
    await writeFile(join(dir, CAPTURE_DOC_FILE), "{ not json");
    const id = await ensureCaptureId(dir);
    expect(isCaptureId(id)).toBe(true);
    expect(await ensureCaptureId(dir)).toBe(id);   // and is stable afterwards
  });

  test("concurrent calls on one bundle agree", async () => {
    // Two exports racing is reachable: STC-296's stacking is the first thing
    // in this app that can export twice at once.
    const ids = await Promise.all([ensureCaptureId(dir), ensureCaptureId(dir)]);
    expect(ids[0]).toBe(ids[1]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run transform/test/capture-doc.test.ts app/test/capture-identity.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the schema**

`schema/capture-1.schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "capture-1",
  "description": "A bundle's stable identity (STC-413). Written lazily at export time; absent from a bundle that has never been exported.",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "id"],
  "properties": {
    "version": { "const": 1 },
    "id": { "type": "string", "pattern": "^cap_[0-9A-HJKMNP-TV-Z]{26}$" }
  }
}
```

- [ ] **Step 4: Write the pure document module**

`transform/src/capture-doc.ts` — refuses rather than defaults, the stance
`parseShot` takes, because a bundle whose identity cannot be read must be
treated as unidentified rather than quietly handed a fresh id that orphans the
file it already has.

```ts
import { isCaptureId } from "./capture-id.js";

export const CAPTURE_DOC_FILE = "capture.json";

export interface CaptureDoc { version: 1; id: string }

export class CaptureDocError extends Error {}

export function captureDocForWrite(id: string): CaptureDoc {
  if (!isCaptureId(id)) throw new CaptureDocError(`not a capture id: ${String(id)}`);
  return { version: 1, id };
}

export function parseCaptureDoc(doc: unknown): CaptureDoc {
  if (!doc || typeof doc !== "object") throw new CaptureDocError("capture.json is not an object");
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (k !== "version" && k !== "id") throw new CaptureDocError(`unexpected field: ${k}`);
  }
  if (d.version !== 1) throw new CaptureDocError(`unsupported version: ${String(d.version)}`);
  if (!isCaptureId(d.id)) throw new CaptureDocError("id is not a capture id");
  return { version: 1, id: d.id };
}
```

- [ ] **Step 5: Write the IO half**

`app/src/capture-identity.ts`. In-process claiming guards the concurrent case
the same way `takes.ts`'s `duplicating` set and `still-io.ts`'s name claim
already do — STC-296's stacking made two simultaneous exports reachable.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPTURE_DOC_FILE, captureDocForWrite, parseCaptureDoc,
} from "@transform/capture-doc.js";
import { mintCaptureId } from "@transform/capture-id.js";

/**
 * Ids handed out for a bundle but not yet on disk (STC-413).
 *
 * The read and the write are two moments, and two exports of one take racing
 * in the gap would both see no document and mint DIFFERENT ids — the second
 * overwriting the first, orphaning the file the first had already embedded.
 * Same race, and the same in-process fix, as `still-io.ts`'s export names.
 */
const claimed = new Map<string, Promise<string>>();

/** This bundle's id, minting and persisting one the first time it is asked for. */
export function ensureCaptureId(bundleDir: string): Promise<string> {
  const existing = claimed.get(bundleDir);
  if (existing) return existing;

  const work = (async () => {
    const path = join(bundleDir, CAPTURE_DOC_FILE);
    try {
      return parseCaptureDoc(JSON.parse(await readFile(path, "utf8"))).id;
    } catch {
      // Absent or unreadable. A corrupt document is replaced rather than
      // fatal: refusing to export because a bookkeeping file got mangled
      // would cost the user their take for nothing.
    }
    const id = mintCaptureId();
    await writeFile(path, JSON.stringify(captureDocForWrite(id), null, 2));
    return id;
  })().finally(() => { claimed.delete(bundleDir); });

  claimed.set(bundleDir, work);
  return work;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run transform/test/capture-doc.test.ts app/test/capture-identity.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Mutation check — prove idempotence is really tested**

Make `ensureCaptureId` always mint (delete the read-and-parse branch). Re-run.
Expected: the idempotence, corrupt-stability and concurrency tests FAIL. Revert.

This is the mutation that matters: an always-minting `ensureCaptureId` passes
every other test in this plan while orphaning a file on every re-export.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add schema/capture-1.schema.json transform/src/capture-doc.ts \
        transform/test/capture-doc.test.ts app/src/capture-identity.ts \
        app/test/capture-identity.test.ts
git commit -m "STC-413: a bundle's identity, minted lazily at export time"
```

---

### Task 6: The Swift PNG writer carries the id

**Files:**
- Modify: `helper/src/StillEncodeDecisions.swift:321-333`
- Modify: `helper/src/StillEncode.swift` (request parsing)
- Test: `helper/test/still-encode/main.swift`

**Interfaces:**
- Consumes: the id format from Task 1 (as a plain string over IPC). The VALUE
  comes from `ensureCaptureId` (Task 5), called on the shot's bundle by the
  main-process still-export path before the request is built.
- Produces: `StillExportRequest.captureId: String?`; `stillImageProperties`
  emits a PNG dictionary when it is set.

- [ ] **Step 1: Write the failing test in the pure harness**

Add to `helper/test/still-encode/main.swift`, following the existing
`stillPropertyKeys` idiom:

```swift
// STC-413: the capture id rides in the PNG dictionary, and — the point of the
// test — it is INDEPENDENT of capturedAt, so a metadata-stripped export stays
// editable. Stripping the timestamp must not strip identity.
let stripped = StillExportRequest(/* …existing fields…, */ capturedAt: nil,
                                  captureId: "cap_" + String(repeating: "A", count: 26))
expectContains(stillPropertyKeys(stripped), "\(kCGImagePropertyPNGDictionary)",
               "a stripped export still carries its capture id")
expectNotContains(stillPropertyKeys(stripped), "\(kCGImagePropertyExifDictionary)",
                  "a stripped export carries no EXIF date")

let untagged = StillExportRequest(/* …existing fields…, */ capturedAt: nil, captureId: nil)
expectNotContains(stillPropertyKeys(untagged), "\(kCGImagePropertyPNGDictionary)",
                  "no id means no PNG dictionary at all")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `helper/build.sh && helper/test/still-encode/run.sh`
(or the existing harness runner for that directory)
Expected: FAIL — `StillExportRequest` has no `captureId`.

**If this checkout has no `swiftc`:** this task cannot be run here. Do NOT skip
it silently — that is the pattern CLAUDE.md warns reads as covered and rots.
Commit it and record in the PR that Task 6 is unverified pending CI's macOS
runner, which is the first real compile.

- [ ] **Step 3: Implement**

In `StillEncodeDecisions.swift`, add the field to `StillExportRequest` and
extend the properties builder. Note the ORDER: the id block goes **before** the
`guard let iso = r.capturedAt` early return, or a stripped export loses it.

```swift
func stillImageProperties(_ r: StillExportRequest) -> [CFString: Any] {
    var props: [CFString: Any] = [:]
    if r.format.isLossy {
        props[kCGImageDestinationLossyCompressionQuality] = r.quality
    }
    // STC-413: identity is not metadata in the privacy sense — it is opaque,
    // carries no timestamp and no path — so it survives a metadata strip.
    // It must be set BEFORE the capturedAt guard returns.
    if let id = r.captureId {
        props[kCGImagePropertyPNGDictionary] = [kCGImagePropertyPNGDescription: id]
    }
    guard let iso = r.capturedAt, let stamp = exifDateString(fromISO: iso) else { return props }
    props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFDateTime: stamp]
    props[kCGImagePropertyExifDictionary] = [
        kCGImagePropertyExifDateTimeOriginal: stamp,
        kCGImagePropertyExifDateTimeDigitized: stamp,
    ]
    return props
}
```

Then parse `captureId` in `StillEncode.swift`'s request decoding beside the
existing fields, refusing a malformed one rather than passing it through.

- [ ] **Step 4: Run it to verify it passes**

Run: `helper/build.sh && helper/test/still-encode/run.sh`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add helper/src/StillEncodeDecisions.swift helper/src/StillEncode.swift \
        helper/test/still-encode/main.swift
git commit -m "STC-413: the still encoder carries a capture id, independent of stripMetadata"
```

---

### Task 7: The exporter tags the MP4 it writes

**Files:**
- Modify: `transform/src/export.ts:339-340`
- Test: `transform/test/export-tag.test.ts` (create)

**Interfaces:**
- Consumes: `tagMp4`, `readMp4CaptureId` (Task 3); `ensureCaptureId` (Task 5),
  called on the take's bundle by the caller that invokes `exportSession` —
  `exportSession` itself stays pure of node and receives the id as a string.
- Produces: `exportSession` accepts `captureId?: string` on its options and
  emits a tagged buffer.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { tagMp4, readMp4CaptureId } from "../src/media-tag.js";
import { mintCaptureId } from "../src/capture-id.js";

describe("export tagging", () => {
  test("a tagged buffer still begins with the muxer's own bytes", () => {
    // Stands in for the muxer's output: the contract is that tagging appends.
    const muxed = new Uint8Array([0, 0, 0, 16, ...[..."ftyp"].map((c) => c.charCodeAt(0)),
                                  ...new Array(8).fill(0)]);
    const id = mintCaptureId();
    const out = tagMp4(muxed, id);
    expect(out.subarray(0, muxed.length)).toEqual(muxed);
    expect(readMp4CaptureId(out)).toBe(id);
  });

  test("no id means the buffer is returned untouched", () => {
    const muxed = new Uint8Array([0, 0, 0, 8, ...[..."ftyp"].map((c) => c.charCodeAt(0))]);
    expect(tagMp4(muxed, "not-an-id")).toEqual(muxed);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run transform/test/export-tag.test.ts`
Expected: PASS for the pure helpers — they exist from Task 3. This test pins the
CONTRACT the wiring must honour; the wiring itself is verified in Step 4.

- [ ] **Step 3: Wire it into `export.ts`**

At line 339-340, replace:

```ts
      muxer.finalize();
      const buf = (muxer.target as ArrayBufferTarget).buffer;
```

with:

```ts
      muxer.finalize();
      // STC-413: identity goes in the bytes, appended AFTER finalize so no
      // chunk offset moves — stco/co64 point into mdat, which does not shift.
      const raw = new Uint8Array((muxer.target as ArrayBufferTarget).buffer);
      const tagged = opts.captureId ? tagMp4(raw, opts.captureId) : raw;
      const buf = tagged.buffer.slice(tagged.byteOffset,
                                      tagged.byteOffset + tagged.byteLength) as ArrayBuffer;
```

Add `captureId?: string` to the options interface and
`import { tagMp4 } from "./media-tag.js";` at the top.

- [ ] **Step 4: Verify end to end against a real export**

```bash
node scripts/export-one.mjs fixtures/basic 2
```

Then read the id back out of the produced file:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const { readMp4CaptureId } = await import('./transform/src/media-tag.ts');
console.log(readMp4CaptureId(new Uint8Array(readFileSync(process.argv[1]))));
" <path-to-the-export>
```

Expected: the id, and the file still plays. **Open it and watch it** — a file
that parses is not the same claim as a file QuickTime accepts, and this repo
already records that a trailing-box mistake is the kind of thing only a player
reveals.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/export.ts transform/test/export-tag.test.ts
git commit -m "STC-413: tag the exported MP4 with its capture id"
```

---

# PHASE 2 — The folder layout

Phase 2 moves files. Every task here is reversible and none deletes user data
except Task 12, which is gated on both orphan status and age.

---

### Task 8: The scan reads the folder

**Order matters: the scan learns to read `raw/` BEFORE anything writes there.**
Done the other way round, Task 9 would put new takes in a folder the library
cannot see and the suite would be red across two tasks. This task moves no
files, so it is backward-compatible on its own and the suite stays green.

**Files:**
- Modify: `app/src/library.ts`
- Test: `app/test/library-scan.test.ts` (create)

**Interfaces:**
- Consumes: `probePng`/`probeMp4` (Task 4), `readPngCaptureId`/`readMp4CaptureId`
  (Tasks 2-3), and `CAPTURE_DOC_FILE`/`parseCaptureDoc` (Task 5) — a bundle's
  own id is read from its `capture.json`, and a bundle without one has never
  been exported and therefore cannot match any finished file.
- Produces: `listLibrary` and `listTakes` keep their existing signatures and
  return the existing `LibraryList`/`TakeList`. `library-items.ts` is untouched.

**Scan rules, in order:**
1. Read the folder. A file with a media extension (`.mp4`, `.png`, `.heic`,
   `.jpg`, `.jpeg`) is a **finished capture**. Read its header, probe facts,
   extract its id.

   **`.jpg`/`.jpeg`/`.heic` have no probe, and that is ruled, not forgotten.**
   Only `probePng` and `probeMp4` exist — JPEG and HEIC header parsing is real
   work for little return here. Such a file lists with **no dimensions**,
   exactly like any other file the probe cannot read. This costs almost
   nothing in practice: a JPEG or HEIC still that the app itself produced is
   matched to its bundle by its id, and its dimensions come from that bundle's
   `shot.json`. Only a FOREIGN JPEG shows reduced metadata.
2. `raw/` and any dotfile are skipped by rule 1.
3. Read `raw/` if it exists. A directory with `anchors.json` or `shot.json` is a
   **bundle**. A bundle whose id appears in step 1 is that capture's source; one
   whose id does not is an **unfinished capture**.
4. A top-level directory with `anchors.json`/`shot.json` is a **legacy bundle**
   — treated exactly like a `raw/` one. This is the whole migration, and it is
   also what keeps this task green before Task 9 moves anything.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary } from "../src/library.js";
import { tagMp4 } from "@transform/media-tag.js";
import { mintCaptureId } from "@transform/capture-id.js";

const env = {} as NodeJS.ProcessEnv;
let root: string;

/**
 * A structurally valid, tiny MP4 that probeMp4 can read: timescale 600,
 * duration 3000 → 5000 ms, track 1920x1080. Written out in full rather than
 * imported from media-probe.test.ts — a test fixture shared between two files
 * is a coupling that makes one file's failure look like the other's.
 */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];

function mp4Bytes(): Uint8Array {
  const mvhd = box("mvhd", [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(3000)]);
  const tkhd = box("tkhd", [
    0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(0), ...be32(0),
    ...new Array(8).fill(0), 0, 0, 0, 0, 0, 0, 0, 0,
    ...new Array(36).fill(0),
    ...be32(1920 * 65536), ...be32(1080 * 65536),
  ]);
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [...mvhd, ...box("trak", tkhd)])]);
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "stc-lib-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the scan reads the folder", () => {
  test("a finished file at top level lists, with facts from its header", async () => {
    await writeFile(join(root, "login-bug.mp4"), tagMp4(mp4Bytes(), mintCaptureId()));
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain("login-bug");
  });

  test("a foreign file lists too, with no edit action", async () => {
    await writeFile(join(root, "holiday.mp4"), mp4Bytes());       // untagged
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(1);
    expect(items[0]!.actions.map((a) => a.id)).not.toContain("edit");
  });

  test("raw/ is not itself listed as a capture", async () => {
    await mkdir(join(root, "raw"), { recursive: true });
    const { items } = await listLibrary(env, root);
    expect(items).toHaveLength(0);
  });

  test("a bundle in raw/ with no finished file lists as unfinished", async () => {
    const dir = join(root, "raw", "2026-09-22_14-30-01");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "anchors.json"), JSON.stringify({ version: 5 }));
    const { items, invalid } = await listLibrary(env, root);
    expect(items.length + invalid.length).toBe(1);
  });

  test("a LEGACY top-level bundle still works — this is the whole migration", async () => {
    const dir = join(root, "2026-09-20_10-00-00");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "shot.json"), JSON.stringify({ version: 1 }));
    const { items, invalid } = await listLibrary(env, root);
    expect(items.length + invalid.length).toBe(1);
  });

  test("one unreadable file does not hide the rest", async () => {
    await writeFile(join(root, "broken.mp4"), new Uint8Array([1, 2, 3]));
    await writeFile(join(root, "good.mp4"), tagMp4(mp4Bytes(), mintCaptureId()));
    const { items } = await listLibrary(env, root);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test("a non-media file is ignored entirely", async () => {
    await writeFile(join(root, "notes.txt"), "hello");
    await writeFile(join(root, ".DS_Store"), "x");
    const { items, invalid } = await listLibrary(env, root);
    expect(items).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/library-scan.test.ts`
Expected: FAIL — the scan still only walks directories.

- [ ] **Step 3: Implement the scan**

Rewrite `scanRoot` to the four rules above. Read only `MP4_TAIL_PROBE_BYTES`
from a file's tail plus its first 24 bytes — never the whole file. Keep
`readRecording` and `readStill` for the bundle path; they are correct and only
their call site moves.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/test/library-scan.test.ts app/test/library-seam.test.ts`
Expected: PASS. **`library-seam.test.ts` must still pass untouched** — if it
fails, the scan leaked `kind` into the view, and the fix is to widen the adapter,
not to edit the seam test.

- [ ] **Step 5: Confirm the suite is still green — nothing has moved yet**

Run: `npx vitest run app/test`
Expected: PASS. This task is purely additive; a failure here means the scan
stopped understanding the CURRENT layout, which Task 9 would then bury.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add app/src/library.ts app/test/library-scan.test.ts
git commit -m "STC-413: the library scan reads media files and bundles in either position"
```

---

### Task 9: New captures land in `raw/`

**Files:**
- Modify: `app/src/takes.ts`
- Modify: `app/src/temp-takes.ts` (`promoteTake`)
- Test: `app/test/takes.test.ts`
- Restate: the e2e fixtures that assert a take's on-disk path

**Interfaces:**
- Consumes: the scan's both-positions support (Task 8).
- Produces: `RAW_SUBDIR: "raw"`, `rawRoot(env, saveFolder): string`.
  `newTakeDir` now returns a path inside `rawRoot`. `takesRoot` is UNCHANGED —
  it still names the user's folder, which is now the finished-capture root.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { newTakeDir, rawRoot, takesRoot, RAW_SUBDIR, insideTakesRoot } from "../src/takes.js";

const env = {} as NodeJS.ProcessEnv;

describe("raw/ is where source bundles live", () => {
  test("takesRoot still names the user's folder", () => {
    expect(takesRoot(env, "/tmp/f")).toBe("/tmp/f");
  });

  test("rawRoot is a subfolder of it", () => {
    expect(rawRoot(env, "/tmp/f")).toBe(`/tmp/f/${RAW_SUBDIR}`);
  });

  test("a new take lands in raw/, not at top level", () => {
    const dir = newTakeDir(env, "/tmp/f", new Date(2026, 8, 22, 14, 30, 1));
    expect(dir).toBe(`/tmp/f/${RAW_SUBDIR}/2026-09-22_14-30-01`);
  });

  test("the traversal guard still holds one level deeper", () => {
    expect(insideTakesRoot(env, "/tmp/f", `/tmp/f/${RAW_SUBDIR}/x`)).toBe(true);
    expect(insideTakesRoot(env, "/tmp/f", "/tmp/f-other/x")).toBe(false);
    expect(insideTakesRoot(env, "/tmp/f", "/tmp/f/../../etc")).toBe(false);
    expect(insideTakesRoot(env, "/tmp/f", "/tmp/f")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/takes.test.ts`
Expected: FAIL — `rawRoot` and `RAW_SUBDIR` are not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Source bundles live below the user's folder, not in it (STC-413).
 *
 * The folder itself is now a view of FINISHED captures — plain files someone
 * can open in Finder. A bundle is machine material: raw, cursorless video and
 * the sidecars that make an export possible. Visible rather than dotted,
 * deliberately, because "nothing is locked inside the app" means someone has
 * to be able to find it.
 */
export const RAW_SUBDIR = "raw";

export function rawRoot(env: NodeJS.ProcessEnv, saveFolder: string | null): string {
  return join(takesRoot(env, saveFolder), RAW_SUBDIR);
}
```

Change `newTakeDir` to build on `rawRoot` instead of `takesRoot`, and
`promoteTake` in `temp-takes.ts` to target `rawRoot`. Leave `takesRoot`,
`insideTakesRoot` and `uniqueTakeName` alone.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx vitest run app/test/takes.test.ts app/test/temp-takes.test.ts`
Expected: PASS.

- [ ] **Step 5: Restate the e2e fixtures that assert an on-disk path**

This is the task that breaks them, so it is the task that fixes them. Find them:

```bash
grep -rln "STC_RECORDINGS_DIR" app/test
grep -rn "join(root,.*_..-..-..\|takeDir\b" app/test | grep -v node_modules
```

A fixture that merely *sets* `STC_RECORDINGS_DIR` needs nothing — the root is
unchanged and only the bundle moved below it. Only fixtures that assert a take
landed at `<root>/<stamp>/` need the `raw/` segment added.

**Restate them, never loosen them.** Changing `expect(existsSync(dir)).toBe(true)`
into a `.toBeTruthy()` on something vaguer is how an assertion stops meaning
anything — CLAUDE.md's STC-296 lesson, and its STC-391 one about an assertion
going vacuous when the thing it counted moved out from under it. If a fixture
counted entries in the recordings root to prove "nothing was recorded", check
whether that count can still discriminate now that bundles live one level down;
if it cannot, the assertion must be repointed or deleted with a reason, not left
passing for the wrong reason.

- [ ] **Step 6: Run the whole app suite**

Run: `npx vitest run app/test`
Expected: PASS, with failures only from this sandbox's documented baseline (no
`swiftc` → `shell`/`frame-png`; the macOS-only Trash path in `manage`). Compare
against a **rebuilt** master baseline before believing any of them are new —
`node app/build.mjs` between checkout and run, or the comparison tests the
unstashed app against stashed tests and means nothing.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add app/src/takes.ts app/src/temp-takes.ts app/test
git commit -m "STC-413: source bundles land in raw/"
```

---

### Task 10: Exports land at top level

**Files:**
- Modify: `app/src/main.ts` (export destination), `app/src/share.ts`
- Test: `app/test/share.test.ts`

**Interfaces:**
- Consumes: `takesRoot`, `rawRoot` (Task 9).
- Produces: `exportMediaName(takeName)` returns `<takeName>.mp4` — the
  `export-` prefix is dropped, because location now says "finished".

- [ ] **Step 1: Write the failing test**

```ts
test("an export is named for its take, with no prefix", () => {
  expect(exportMediaName("2026-09-22_14-30-01")).toBe("2026-09-22_14-30-01.mp4");
});

test("publish reads the export from the folder, not from the bundle", () => {
  const plan = planPublish({
    takeName: "2026-09-22_14-30-01", takesRoot: "/tmp/f",
    /* …existing required fields… */
  });
  expect(plan.from).toBe("/tmp/f/2026-09-22_14-30-01.mp4");
  expect(plan.from).not.toContain("/raw/");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/share.test.ts`
Expected: FAIL — `from` still points inside the take directory.

- [ ] **Step 3: Implement**

Change `exportMediaName` to drop the prefix; change `planPublish` to build
`from` from the folder root rather than the take directory; change the export
write path in `main.ts` to the same. Leave `exportManifestName` writing into the
bundle — it is provenance about the source, not a deliverable, and the top level
is media files only.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/test/share.test.ts`
Expected: PASS. The grep test in that file keeps the filename rule single-owner;
if it fails, a second copy of the name was reintroduced.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add app/src/main.ts app/src/share.ts app/test/share.test.ts
git commit -m "STC-413: exports land at the top level of the folder"
```

---

### Task 11: Delete removes both objects

**Files:**
- Modify: `app/src/main.ts` (`take:delete`)
- Test: `app/test/library-folder.e2e.test.ts` (create)

**Interfaces:**
- Consumes: the scan (Task 8), `rawRoot` (Task 9).
- Produces: `take:delete` trashes the finished file AND its bundle.
- Also produces the e2e helpers Tasks 11 and 13 both use, defined at the top of
  `library-folder.e2e.test.ts` and nowhere else: `refreshLibrary(page)`,
  `itemCount(page)`, `deleteFirstItem(page)`, `openFirstItem(page)`,
  `renameFirstItem(page, name)`, `editorIsOpen(page)`.

**Before writing them, read `app/test/take-library.e2e.test.ts` and
`app/test/_editor-fixture.ts`** — the launch idiom, the `--user-data-dir`
isolation STC-403 made mandatory at every launch site, and
`closeEditorWindow`'s three-outcome close all already exist. Do not hand-roll a
second copy of any of them; `app/test/e2e-user-data-isolation.test.ts` will fail
the build if the launch omits `--user-data-dir`.

**Count windows through `app/test/_windows.ts`, never `app.windows()`** — that
helper's header records the measured lag that makes a raw count lie (STC-416).

- [ ] **Step 1: Write the failing test**

```ts
test("delete removes the finished file and its bundle together", async () => {
  // …launch the app with STC_RECORDINGS_DIR and STC_TEMP_TAKES_DIR pointed at
  // a temp root, per the existing fixture idiom, and with --user-data-dir set
  // (STC-403: every launch site must isolate userData).
  await deleteFirstItem(page);
  expect(existsSync(join(root, "login-bug.mp4"))).toBe(false);
  expect(existsSync(join(root, "raw", bundleName))).toBe(false);
}, 60_000);

test("a bundle whose file was deleted in Finder lists as unfinished", async () => {
  await rm(join(root, "login-bug.mp4"));
  await refreshLibrary(page);
  expect(await itemCount(page)).toBe(1);   // the bundle, now orphaned
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/library-folder.e2e.test.ts`
Expected: FAIL — the bundle survives the delete.

- [ ] **Step 3: Implement**

`take:delete` resolves the item's bundle by id and trashes both with
`shell.trashItem`, bounded the way `pending-trash.ts` already bounds a trash at
quit (STC-427 — an unbounded `trashItem` hung a CI runner for 30 s). Both go to
the Trash, so both are recoverable.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/test/library-folder.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add app/src/main.ts app/test/library-folder.e2e.test.ts
git commit -m "STC-413: delete removes a capture's file and its bundle"
```

---

### Task 12: Sweep orphaned bundles

**Files:**
- Modify: `app/src/temp-takes.ts`
- Test: `app/test/orphan-sweep.test.ts` (create)

**Interfaces:**
- Consumes: the scan's id set (Task 8).
- Produces: `sweepOrphanedBundles(env, saveFolder, now): Promise<string[]>`,
  `ORPHAN_MARKER_FILE: ".orphaned-at"`, reusing `TEMP_TAKE_MAX_AGE_MS`.

**The rule, and why it is two conditions:** a bundle is swept only when it is
**orphaned AND aged**. Age alone is wrong — `purgeStaleTempTakes` derives age
from the directory *name*, so a bundle behind a capture made eight days ago
would be swept while its finished file still sat at top level, silently making
it uneditable. Orphan status alone is wrong too — a read must not delete data,
and a file temporarily moved out would read as deleted. So: mark when first seen
orphaned, sweep when the mark is old, and clear the mark if the file comes back.

- [ ] **Step 1: Write the failing test**

```ts
describe("orphaned bundles are swept, aged from when they were orphaned", () => {
  test("a bundle with a live finished file is never marked", async () => {
    await sweepOrphanedBundles(env, root, Date.now());
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(false);
  });

  test("first sweep marks an orphan but does not delete it", async () => {
    await rm(join(root, "login-bug.mp4"));
    expect(await sweepOrphanedBundles(env, root, Date.now())).toEqual([]);
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(true);
    expect(existsSync(bundle)).toBe(true);
  });

  test("an orphan older than the threshold is removed", async () => {
    await rm(join(root, "login-bug.mp4"));
    const t0 = Date.now();
    await sweepOrphanedBundles(env, root, t0);
    const removed = await sweepOrphanedBundles(env, root, t0 + TEMP_TAKE_MAX_AGE_MS + 1);
    expect(removed).toHaveLength(1);
    expect(existsSync(bundle)).toBe(false);
  });

  test("a file that comes back clears the mark — a temporary move costs nothing", async () => {
    const bytes = await readFile(join(root, "login-bug.mp4"));
    await rm(join(root, "login-bug.mp4"));
    await sweepOrphanedBundles(env, root, Date.now());
    await writeFile(join(root, "login-bug.mp4"), bytes);
    await sweepOrphanedBundles(env, root, Date.now());
    expect(existsSync(join(bundle, ORPHAN_MARKER_FILE))).toBe(false);
  });

  test("a finished file is NEVER touched by the sweep", async () => {
    await sweepOrphanedBundles(env, root, Date.now() + TEMP_TAKE_MAX_AGE_MS * 10);
    expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/orphan-sweep.test.ts`
Expected: FAIL — `sweepOrphanedBundles` does not exist.

- [ ] **Step 3: Implement**

Write the marker on first orphan sighting, delete it when the capture's id is
seen again, and remove the bundle when `now - marker >= TEMP_TAKE_MAX_AGE_MS`.
Call it from the same 12-hour timer that already runs `purgeStaleTempTakes`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/test/orphan-sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation check**

Drop the orphan condition so the sweep runs on age alone. Expected: the "a
finished file is NEVER touched" and "live finished file is never marked" tests
FAIL. This is the exact bug the spec's self-review caught; the test must be able
to catch it again. Revert.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add app/src/temp-takes.ts app/test/orphan-sweep.test.ts
git commit -m "STC-413: sweep bundles that are orphaned AND aged, never aged alone"
```

---

### Task 13: The filename is the label

**Files:**
- Modify: `app/src/takes.ts` (retire `setTakeLabel`), `app/src/main.ts`,
  `app/src/library.ts`
- Test: `app/test/library-folder.e2e.test.ts`

**Interfaces:**
- Consumes: the scan (Task 8).
- Produces: `renameCapture(env, saveFolder, from, to): Promise<string>`.
  `setTakeLabel` and `take.json` reading are removed for finished captures;
  bundles keep `readLabel` for the unfinished case.

- [ ] **Step 1: Write the failing test**

```ts
test("renaming a capture renames the file on disk", async () => {
  await renameFirstItem(page, "login-bug");
  expect(existsSync(join(root, "login-bug.mp4"))).toBe(true);
  expect(existsSync(join(root, "2026-09-22_14-30-01.mp4"))).toBe(false);
});

test("a file renamed in Finder still opens its bundle", async () => {
  await rename(join(root, "2026-09-22_14-30-01.mp4"), join(root, "totally-different.mp4"));
  await refreshLibrary(page);
  await openFirstItem(page);
  expect(await editorIsOpen(page)).toBe(true);   // found by embedded id, not by name
});

test("a rename refuses to escape the folder", async () => {
  await expect(renameCapture(env, root, join(root, "a.mp4"), "../../evil"))
    .rejects.toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/test/library-folder.e2e.test.ts`
Expected: FAIL — rename still writes `take.json`.

- [ ] **Step 3: Implement**

`renameCapture` validates the new name (no separators, no `..`, non-empty,
within `MAX_LABEL_LENGTH`), preserves the extension, resolves collisions with
`uniqueTakeName`, and renames the file. Delete `setTakeLabel` and its call
sites. Keep `readLabel` in the bundle path — an unfinished capture has no
user-facing filename yet.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run app/test/library-folder.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add app/src/takes.ts app/src/main.ts app/src/library.ts \
        app/test/library-folder.e2e.test.ts
git commit -m "STC-413: the filename is the label; take.json retired"
```

---

### Task 14: Measure the 500-file scan

**Files:**
- Test: `app/test/library-scan.test.ts`

STC-294's acceptance criterion is 500 takes. The probe strategy is *designed*
for it; this repo's rule is that a number is measured, not assumed.

- [ ] **Step 1: Write the measurement**

```ts
test("500 files scan inside a budget", async () => {
  for (let i = 0; i < 500; i++) {
    await writeFile(join(root, `take-${String(i).padStart(3, "0")}.mp4`),
                    tagMp4(mp4Bytes(), mintCaptureId()));
  }
  const t0 = performance.now();
  const { items } = await listLibrary(env, root);
  const ms = performance.now() - t0;
  process.stderr.write(`500-file scan: ${Math.round(ms)} ms\n`);
  expect(items).toHaveLength(500);
  expect(ms).toBeLessThan(SCAN_BUDGET_MS);
}, 120_000);
```

- [ ] **Step 2: Run it and read the printed number**

Run: `npx vitest run app/test/library-scan.test.ts -t "500 files"`

**Do not pick `SCAN_BUDGET_MS` first and fit to it.** Run it, read the real
figure, then set the budget with headroom and a comment recording the machine it
was measured on — the shape `STILL_END_TO_END_MS` uses. If the real number is
bad, the fix is the probe, not the budget.

- [ ] **Step 3: Commit**

```bash
npm run typecheck
git add app/test/library-scan.test.ts
git commit -m "STC-413: measure the 500-file scan rather than assume it"
```

---

## Final verification

- [ ] `npm run typecheck` — all three passes clean
- [ ] `npm test` — full suite. Compare failures against a **rebuilt** master
      baseline (`node app/build.mjs` between checkout and run, or the comparison
      tests the unstashed app against stashed tests and means nothing).
- [ ] `npm run test:capture` on a Mac — Task 6's Swift half
- [ ] `npm run gate:identity` — the transform changed; the fingerprint must hold
- [ ] Open a tagged export in **QuickTime**. A file that parses is not a file a
      player accepts.
- [ ] Write `docs/STC-413-RUNBOOK.md` for what only a Mac can settle: whether
      the folder reads as browsable in Finder, whether `raw/` is understood
      without explanation, and whether a renamed file really reopens its bundle.

## Push back to Linear

The ticket's `Scope decided (2026-09-21)` says sidecar; this ships **embedded**.
Update it, and record that `take.json` is retired, so the ticket does not
describe something different from what shipped.
