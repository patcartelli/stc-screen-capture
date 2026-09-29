# STC-236 Streaming Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The editor (preview and export) stops holding a whole `display.mp4`/`camera.mp4` in memory: it reads the MP4 sample index (a few KB) up front and each keyframe group's bytes on demand.

**Architecture:** `demuxTrack` takes a `ByteSource` instead of an `ArrayBuffer`, walks the file's top-level boxes, feeds mp4box every box except `mdat`'s body, and returns chunk *references* (`offset`/`size`) instead of chunk bytes. A new `ChunkReader` is the one place chunk bytes come from — it fetches whole keyframe groups, coalescing contiguous samples into one read, and caches the last two groups. The frame sources `await` bytes from it before feeding the decoder. The editor supplies an IPC-backed `ByteSource`; everything else (harness, gates, tests) uses `memorySource`.

**Tech Stack:** TypeScript, mp4box.js 2.x, WebCodecs `VideoDecoder`, vitest (Node), Playwright-Electron e2e, Electron IPC.

**Spec:** `docs/superpowers/specs/2026-09-26-stc-236-streaming-preview-design.md` — read it first; this plan argues from it.

## Global Constraints

- No Swift / helper change. No schema change. **No `TRANSFORM_VERSION` bump** — the bytes reaching `EncodedVideoChunk` are identical, so nothing pixel-deciding changes.
- Audio (`micM4a`, `systemM4a`, `demux-audio.ts`, `decode-audio.ts`) is untouched and still read whole.
- The renderer never names a path: the editor uses only the existing `preview:size` and `preview:chunk` IPC channels. No new IPC channel.
- PHASE-0 §4b rules in both frame sources stay intact: one in-flight request per decoder, superseded seeks resolve `null`, the bounded 50 ms wait, close a frame as soon as it is superseded.
- A read that is short, fails, or is out of range THROWS with the file name, offset and length. Never pad, never skip a chunk.
- `chunk-reader.ts` and `mp4-boxes.ts` are pure: no DOM, no Electron, no node imports — they must pass `tsconfig.browser.json` and run in vitest.
- Branch: `accounts/stc-236-n-minute-segmentation`, worktree `.claude/worktrees/stc-236`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run typecheck` runs ALL THREE tsc passes; run it, not bare `tsc`.

## Two corrections to the spec, found while planning

1. **A truncated LAST box is tolerated, not refused.** The spec said "refuse a box whose extent runs past EOF". But a crash-recovered file (STC-394, `helper/test/fragmented-writer.test.ts` "killed mid-write") ends in exactly such a box — the in-flight fragment — and today's demux reads it successfully up to the kill. So: a box running past EOF ends the walk and is not fed; samples whose bytes run past EOF are dropped *as a suffix* (and it is an error if they are not a suffix). `size < header` is still refused.
2. **The 15 s demux watchdog is removed.** It guarded against mp4box's silence on a malformed file (no `onReady`, no `onError`). Parsing is now driven by our own loop, so that silence surfaces synchronously as "no track information found" after the last append — there is nothing left for a timer to catch, and a timer would wrongly bound a legitimately slow IPC index read of a long fragmented file.

## Review Focus

1. **A seek superseded while its bytes are in flight** (fast scrub over IPC): the old request must resolve `null` without feeding the decoder, and the newer one must show the right frame. → Task 3, `seeking-frame-source.test.ts` "superseded while awaiting bytes".
2. **A crash-recovered (fragmented, truncated) file**: must still open and yield the same clean frame prefix as before. → Task 2 "truncated trailing box" test + Task 2's change to `helper/test/fragmented-writer.test.ts` comparing against the oracle.
3. **Samples not contiguous inside a keyframe group** (measured: 6 gaps in a real 740-frame take): bytes must follow the index, never one blind range per group. → Task 1 "one read per contiguous run".
4. **A read error in the middle of preview or export** (file deleted/truncated while the editor has it open): must surface as a visible error, never a silently frozen or wrong frame. → Task 3 "a failed read poisons the source".
5. **Scrubbing back and forth within one keyframe group**: must not re-fetch the group on every input event. → Task 1 "cache hit".

---

## File structure

| file | create/modify | responsibility |
|---|---|---|
| `transform/src/chunk-reader.ts` | create | `ByteSource`, `memorySource`, `VideoChunkRef`, `ChunkReader` (group-granular fetch, run coalescing, 2-group LRU, prefetch) |
| `transform/src/mp4-boxes.ts` | create | `walkTopLevelBoxes` — the top-level box walk only |
| `transform/src/demux.ts` | modify | `demuxTrack(src: ByteSource, what)` building chunk refs from boxes |
| `transform/src/session.ts` | modify | `SessionInput.displayMp4`/`cameraMp4` become `ByteSource` |
| `transform/src/seeking-frame-source.ts` | modify | fetch via `ChunkReader` before feeding; supersession check after the await |
| `transform/src/frame-source.ts` | modify | fetch via `ChunkReader`; prefetch the next group (Task 4) |
| `transform/src/decode.ts` | modify | `decodeAll` reads group by group via `ChunkReader` |
| `harness/{main,seek,luma,change-track,export,sink-identity}.ts` | modify | wrap fetched buffers in `memorySource`; `luma.ts` reads via `ChunkReader` |
| `app/src/editor.ts` | modify | `ipcSource`; video opened by range; `window.__stcVideoBytesRead` test hook |
| `transform/test/_demux-oracle.ts` | create | the pre-change `demuxTrack`, verbatim, as the equivalence oracle |
| `transform/test/_fake-webcodecs.ts` | create | minimal fake `VideoDecoder`/`EncodedVideoChunk` for Node |
| `transform/test/chunk-reader.test.ts` | create | Task 1 |
| `transform/test/mp4-boxes.test.ts` | create | Task 2 |
| `transform/test/demux-lazy.test.ts` | create | Task 2 equivalence |
| `transform/test/seeking-frame-source.test.ts`, `transform/test/forward-frame-source.test.ts` | create | Tasks 3–4 |
| `transform/test/{session,export-pip}.test.ts`, `app/test/system-audio-fixture.test.ts`, `helper/test/fragmented-writer.test.ts` | modify | callers pass `memorySource` |
| `app/test/preview.e2e.test.ts` | modify | Task 5 byte-count test |
| `docs/STC-236-RUNBOOK.md` | create | Task 6 |
| `docs/CORRECTNESS-TRAPS.md`, `docs/TICKET-LOG.md`, `CLAUDE.md` | modify | Task 6 |

---

### Task 1: `ChunkReader` and `ByteSource`

**Files:**
- Create: `transform/src/chunk-reader.ts`
- Test: `transform/test/chunk-reader.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact):
  ```ts
  export interface ByteSource { readonly size: number; read(offset: number, length: number): Promise<Uint8Array>; }
  export interface VideoChunkRef { type: "key" | "delta"; timestampUs: number; offset: number; size: number; }
  export function memorySource(buf: ArrayBuffer, what: string): ByteSource;
  export class ChunkReader {
    static readonly MAX_CACHED_GROUPS: number;          // 2
    constructor(chunks: readonly VideoChunkRef[], bytes: ByteSource, what: string);
    groupOf(index: number): { start: number; end: number };   // [start, end) keyframe group
    read(first: number, count: number): Promise<Uint8Array[]>;
    prefetch(index: number): void;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`transform/test/chunk-reader.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { ChunkReader, memorySource, type ByteSource, type VideoChunkRef } from "../src/chunk-reader.js";

/**
 * A synthetic track: `n` chunks, a keyframe every `gop`, chunk i filled with
 * the byte (i % 251). A 3-byte gap is left before every chunk whose index is
 * a multiple of `gapEvery`, so a keyframe group is NOT one contiguous range —
 * the shape a real take has (6 discontinuities in a real 740-frame display.mp4).
 */
export function syntheticTrack(n = 30, gop = 10, gapEvery = 7): { buf: ArrayBuffer; chunks: VideoChunkRef[] } {
  const chunks: VideoChunkRef[] = [];
  let off = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % gapEvery === 0) off += 3;
    const size = 10 + (i % 7);
    chunks.push({ type: i % gop === 0 ? "key" : "delta", timestampUs: i * 16_667, offset: off, size });
    off += size;
  }
  const bytes = new Uint8Array(off);
  chunks.forEach((c, i) => bytes.fill(i % 251, c.offset, c.offset + c.size));
  return { buf: bytes.buffer, chunks };
}

/** Wraps a source and records every read. */
function counting(src: ByteSource): ByteSource & { reads: [number, number][] } {
  const reads: [number, number][] = [];
  return { size: src.size, reads, read: (o, l) => { reads.push([o, l]); return src.read(o, l); } };
}

describe("memorySource", () => {
  test("returns exactly the requested bytes", async () => {
    const src = memorySource(new Uint8Array([1, 2, 3, 4, 5]).buffer, "t.mp4");
    expect([...(await src.read(1, 3))]).toEqual([2, 3, 4]);
    expect(src.size).toBe(5);
  });
  test("a read past the end throws, naming the file and range", async () => {
    const src = memorySource(new Uint8Array(5).buffer, "t.mp4");
    await expect(src.read(3, 4)).rejects.toThrow(/t\.mp4.*\[3, 7\).*5-byte/);
    await expect(src.read(-1, 1)).rejects.toThrow(/t\.mp4/);
  });
});

describe("ChunkReader", () => {
  test("groupOf finds the keyframe group", () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    expect(r.groupOf(0)).toEqual({ start: 0, end: 10 });
    expect(r.groupOf(9)).toEqual({ start: 0, end: 10 });
    expect(r.groupOf(10)).toEqual({ start: 10, end: 20 });
    expect(r.groupOf(29)).toEqual({ start: 20, end: 30 });
  });

  test("returns each chunk's own bytes, across group boundaries", async () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    const got = await r.read(8, 5);            // spans groups 0 and 1
    expect(got.length).toBe(5);
    got.forEach((b, k) => {
      expect(b.byteLength).toBe(chunks[8 + k]!.size);
      expect(b.every((x) => x === (8 + k) % 251)).toBe(true);
    });
  });

  test("one read per contiguous run, never one blind range per group", async () => {
    const { buf, chunks } = syntheticTrack(10, 10, 7);   // one group, a gap before chunk 7
    const src = counting(memorySource(buf, "t"));
    await new ChunkReader(chunks, src, "t").read(0, 1);
    expect(src.reads).toEqual([
      [chunks[0]!.offset, chunks[6]!.offset + chunks[6]!.size - chunks[0]!.offset],
      [chunks[7]!.offset, chunks[9]!.offset + chunks[9]!.size - chunks[7]!.offset],
    ]);
  });

  test("cache hit: scrubbing inside one group does not re-read it", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    await r.read(3, 1);
    const after = src.reads.length;
    await r.read(0, 2);
    await r.read(9, 1);
    expect(src.reads.length).toBe(after);
  });

  test("keeps at most MAX_CACHED_GROUPS groups", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    expect(ChunkReader.MAX_CACHED_GROUPS).toBe(2);
    await r.read(0, 1); await r.read(10, 1); await r.read(20, 1);   // group 0 evicted
    const before = src.reads.length;
    await r.read(0, 1);
    expect(src.reads.length).toBeGreaterThan(before);
  });

  test("prefetch issues the group's reads before anyone asks", async () => {
    const { buf, chunks } = syntheticTrack();
    const src = counting(memorySource(buf, "t"));
    const r = new ChunkReader(chunks, src, "t");
    r.prefetch(15);
    expect(src.reads.some(([o]) => o === chunks[10]!.offset)).toBe(true);
    const before = src.reads.length;
    await r.read(12, 2);
    expect(src.reads.length).toBe(before);
  });

  test("a failed read is not cached: the next read tries again", async () => {
    const { buf, chunks } = syntheticTrack();
    const good = memorySource(buf, "t");
    let fail = true;
    const flaky: ByteSource = { size: good.size, read: (o, l) => fail ? Promise.reject(new Error("t: gone")) : good.read(o, l) };
    const r = new ChunkReader(chunks, flaky, "t");
    await expect(r.read(0, 1)).rejects.toThrow("t: gone");
    fail = false;
    expect((await r.read(0, 1))[0]!.byteLength).toBe(chunks[0]!.size);
  });

  test("a failed prefetch surfaces on the next read, not as an unhandled rejection", async () => {
    const { chunks } = syntheticTrack();
    const broken: ByteSource = { size: 1e6, read: () => Promise.reject(new Error("t: gone")) };
    const r = new ChunkReader(chunks, broken, "t");
    r.prefetch(0);
    await expect(r.read(0, 1)).rejects.toThrow("t: gone");
  });

  test("out-of-range requests throw", async () => {
    const { buf, chunks } = syntheticTrack();
    const r = new ChunkReader(chunks, memorySource(buf, "t"), "t");
    await expect(r.read(-1, 1)).rejects.toThrow(/out of range/);
    await expect(r.read(29, 2)).rejects.toThrow(/out of range/);
    await expect(r.read(0, 0)).rejects.toThrow(/out of range/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run transform/test/chunk-reader.test.ts`
Expected: FAIL — `Failed to resolve import "../src/chunk-reader.js"`.

- [ ] **Step 3: Implement**

`transform/src/chunk-reader.ts`:

```ts
/**
 * Where a video chunk's bytes come from (STC-236).
 *
 * The editor used to read a whole display.mp4 into one ArrayBuffer before
 * demuxing it: +548 MB of renderer RSS for a 458 MB take, so ~15 minutes at
 * 4K was the ceiling (STC-251). A chunk is now a REFERENCE — an offset and a
 * size in the file — and this module is the one place its bytes are fetched.
 *
 * It fetches a whole keyframe GROUP at a time, because that is the unit every
 * consumer needs: a seek decodes forward from the governing keyframe, and
 * export walks groups in order. Inside a group the samples are usually, but
 * NOT always, back to back (measured: 6 discontinuities in a real 740-frame
 * take), so a group is fetched as one read per contiguous run, never as one
 * blind range from its first byte to its last.
 *
 * Pure: no DOM, no Electron, no node. The editor supplies an IPC-backed
 * ByteSource; the harness, the gates and every test use `memorySource`.
 */

export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`, or throws. Never short, never padded. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface VideoChunkRef {
  type: "key" | "delta";
  timestampUs: number;
  /** absolute offset in the file */
  offset: number;
  size: number;
}

export function memorySource(buf: ArrayBuffer, what: string): ByteSource {
  const size = buf.byteLength;
  return {
    size,
    read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        return Promise.reject(new Error(`${what}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`));
      }
      return Promise.resolve(new Uint8Array(buf, offset, length));
    },
  };
}

export class ChunkReader {
  /**
   * Two: the group being decoded and the one after it. Export prefetches the
   * next group while the current one decodes, and a seek's feed-ahead can
   * cross one boundary; neither ever needs a third. At 4K a group is a few MB
   * of ENCODED bytes, so this is the whole of what the editor holds per track.
   */
  static readonly MAX_CACHED_GROUPS = 2;

  private readonly keyStarts: number[];
  private readonly cache = new Map<number, Promise<Uint8Array[]>>();

  constructor(private readonly chunks: readonly VideoChunkRef[],
              private readonly bytes: ByteSource,
              private readonly what: string) {
    const starts = chunks.map((c, i) => (c.type === "key" ? i : -1)).filter((i) => i > 0);
    this.keyStarts = [0, ...starts];
  }

  groupOf(index: number): { start: number; end: number } {
    let lo = 0, hi = this.keyStarts.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyStarts[mid]! <= index) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return { start: this.keyStarts[best]!, end: this.keyStarts[best + 1] ?? this.chunks.length };
  }

  async read(first: number, count: number): Promise<Uint8Array[]> {
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || first + count > this.chunks.length) {
      throw new Error(`${this.what}: chunks [${first}, ${first + count}) are out of range (0..${this.chunks.length})`);
    }
    const out: Uint8Array[] = [];
    const stop = first + count;
    for (let i = first; i < stop;) {
      const g = this.groupOf(i);
      const group = await this.group(g.start, g.end);
      const until = Math.min(g.end, stop);
      out.push(...group.slice(i - g.start, until - g.start));
      i = until;
    }
    return out;
  }

  prefetch(index: number): void {
    if (index < 0 || index >= this.chunks.length) return;
    const g = this.groupOf(index);
    // A failure here is kept in the promise and surfaces on the next read of
    // this group; the no-op catch only stops it being reported as unhandled.
    this.group(g.start, g.end).catch(() => {});
  }

  private group(start: number, end: number): Promise<Uint8Array[]> {
    const hit = this.cache.get(start);
    if (hit) { this.cache.delete(start); this.cache.set(start, hit); return hit; }
    const p = this.fetchGroup(start, end);
    this.cache.set(start, p);
    while (this.cache.size > ChunkReader.MAX_CACHED_GROUPS) this.cache.delete(this.cache.keys().next().value!);
    // A failed read is not remembered: the next ask tries the file again.
    p.catch(() => { if (this.cache.get(start) === p) this.cache.delete(start); });
    return p;
  }

  private async fetchGroup(start: number, end: number): Promise<Uint8Array[]> {
    const runs: { first: number; last: number }[] = [];
    for (let i = start; i < end; i++) {
      const run = runs[runs.length - 1];
      const prev = this.chunks[i - 1];
      if (run && prev && this.chunks[i]!.offset === prev.offset + prev.size) run.last = i;
      else runs.push({ first: i, last: i });
    }
    const pieces = await Promise.all(runs.map(async ({ first, last }) => {
      const from = this.chunks[first]!.offset;
      const to = this.chunks[last]!.offset + this.chunks[last]!.size;
      const bytes = await this.bytes.read(from, to - from);
      const out: Uint8Array[] = [];
      for (let i = first; i <= last; i++) {
        const c = this.chunks[i]!;
        out.push(bytes.subarray(c.offset - from, c.offset - from + c.size));
      }
      return out;
    }));
    return pieces.flat();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run transform/test/chunk-reader.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expected clean.

```bash
git add transform/src/chunk-reader.ts transform/test/chunk-reader.test.ts
git commit -m "STC-236: ChunkReader — a video chunk's bytes, fetched a keyframe group at a time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Box walker, lazy `demuxTrack`, and every caller

`DemuxedVideo.chunks` stops carrying `data`, so every consumer changes in this task: the four decode sites (both frame sources, `decodeAll`, `harness/luma.ts`) get a straightforward await-then-feed conversion here so the tree compiles and the gates stay meaningful; Task 3 adds the supersession/failure rules and their tests to the frame sources.

**Files:**
- Create: `transform/src/mp4-boxes.ts`, `transform/test/mp4-boxes.test.ts`, `transform/test/_demux-oracle.ts`, `transform/test/demux-lazy.test.ts`
- Modify: `transform/src/demux.ts`, `transform/src/session.ts:20-40,198-207`, `transform/src/decode.ts:19-45`, `transform/src/seeking-frame-source.ts`, `transform/src/frame-source.ts`, `harness/{main,seek,luma,change-track,export,sink-identity}.ts`, `transform/test/session.test.ts:10-13`, `transform/test/export-pip.test.ts`, `app/test/system-audio-fixture.test.ts`, `helper/test/fragmented-writer.test.ts`

**Interfaces:**
- Consumes: `ByteSource`, `VideoChunkRef`, `memorySource`, `ChunkReader` from Task 1.
- Produces:
  ```ts
  // mp4-boxes.ts
  export interface TopBox { type: string; offset: number; size: number; headerSize: 8 | 16 }
  export interface BoxWalk { boxes: TopBox[]; truncated: TopBox | null }
  export function walkTopLevelBoxes(src: ByteSource, what: string): Promise<BoxWalk>;
  // demux.ts
  export interface DemuxedVideo { framesNs: number[]; codec: string; codedWidth: number; codedHeight: number;
    description: Uint8Array; chunks: VideoChunkRef[]; bytes: ByteSource }
  export function demuxTrack(src: ByteSource, what: string): Promise<DemuxedVideo>;
  // session.ts
  SessionInput.displayMp4: ByteSource; SessionInput.cameraMp4?: ByteSource
  // test oracle
  export function demuxTrackOracle(buf: ArrayBuffer, what: string): Promise<OracleVideo>  // chunks carry data
  ```

- [ ] **Step 1: Capture the oracle before touching demux.ts**

```bash
git show HEAD:transform/src/demux.ts \
  | sed -e 's/^export interface DemuxedVideo /export interface OracleVideo /' \
        -e 's/Promise<DemuxedVideo>/Promise<OracleVideo>/' \
        -e 's/^export function demuxTrack(/export function demuxTrackOracle(/' \
  > transform/test/_demux-oracle.ts
```

Then prepend this header comment to `transform/test/_demux-oracle.ts` (above the import):

```ts
/**
 * THE PRE-STC-236 demuxTrack, verbatim, kept only as a test oracle. It reads
 * the whole file and extracts every sample's bytes through mp4box's own
 * onSamples path — the implementation every take has been read with until
 * now. demux-lazy.test.ts and fragmented-writer.test.ts check the lazy demux
 * against it. Do not "fix" or modernise this file: its value is that it is
 * the old behaviour.
 */
```

Run: `grep -c "demuxTrackOracle\|OracleVideo" transform/test/_demux-oracle.ts` — expected `≥ 3`.

- [ ] **Step 2: Write the failing box-walker tests**

`transform/test/mp4-boxes.test.ts`:

```ts
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
```

Run: `npx vitest run transform/test/mp4-boxes.test.ts` — expected FAIL, `Failed to resolve import "../src/mp4-boxes.js"`.

- [ ] **Step 3: Implement the walker**

`transform/src/mp4-boxes.ts`:

```ts
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
```

Run: `npx vitest run transform/test/mp4-boxes.test.ts` — expected PASS, 6 tests.

- [ ] **Step 4: Write the failing equivalence test**

`transform/test/demux-lazy.test.ts`:

```ts
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
```

Run: `npx vitest run transform/test/demux-lazy.test.ts` — expected FAIL (type error / `demuxTrack` rejects an object without `byteLength`).

- [ ] **Step 5: Rewrite `demuxTrack`**

In `transform/src/demux.ts`, replace the `DemuxedVideo` interface and the whole `demuxTrack` function with the code below. Keep the file's top comment and the mp4box import. The two long comments inside (edit-list offset, STC-394 chain) are MOVED verbatim, not rewritten — copy them from the old body into the marked places.

```ts
import { walkTopLevelBoxes } from "./mp4-boxes.js";
import type { ByteSource, VideoChunkRef } from "./chunk-reader.js";

export interface DemuxedVideo {
  /** source-frame PTS grid, session-relative integer ns — this IS Session.frames */
  framesNs: number[];
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC payload for VideoDecoder.configure */
  description: Uint8Array;
  /** where each sample lives in the file; ChunkReader fetches the bytes (STC-236) */
  chunks: VideoChunkRef[];
  bytes: ByteSource;
}

/**
 * Reads the sample INDEX, never the samples (STC-236). Every top-level box is
 * handed to mp4box whole except an mdat, which gets only its header: mp4box
 * then skips to the next box, and builds trak.samples (offset, size, sync,
 * duration) from moov — plus every moof, for a crash-recovered fragmented
 * file. Measured on a real 46 MB take: 10.9 KB read, 740 samples, every
 * sample's bytes identical to the old whole-file demux.
 *
 * No watchdog any more. It existed because mp4box reports a malformed file by
 * never calling back; parsing is now driven by this loop, so that silence
 * shows up synchronously as "no track information found" after the last box.
 */
export async function demuxTrack(src: ByteSource, what: string): Promise<DemuxedVideo> {
  const walk = await walkTopLevelBoxes(src, what);

  const file = MP4Box.createFile();
  file.discardMdatData = true;
  let info: any;
  let parseError: string | null = null;
  file.onReady = (i: any) => { info = i; };
  file.onError = (e: unknown) => { parseError = String(e); };

  for (const b of walk.boxes) {
    const bytes = await src.read(b.offset, b.type === "mdat" ? b.headerSize : b.size);
    const ab = bytes.slice().buffer as ArrayBuffer & { fileStart: number };
    ab.fileStart = b.offset;
    try {
      file.appendBuffer(ab);
    } catch (e) {
      throw new Error(`could not parse ${what}: ${String(e)}`);
    }
  }
  file.flush();
  if (parseError) throw new Error(`mp4box reading ${what}: ${parseError}`);
  if (!info) throw new Error(`${what} is not a readable MP4 — no track information found`);

  const track = info.videoTracks[0];
  if (!track) throw new Error(`no video track in ${what}`);

  // avcC description: serialize the box, strip the 8-byte box header.
  // NB PHASE-0 §4b.5: DataStream must come off the module export in use.
  const trak = file.getTrackById(track.id);
  const entries = trak.mdia.minf.stbl.stsd.entries;
  const avcC = entries.map((e: any) => e.avcC).find(Boolean);
  if (!avcC) throw new Error(`no avcC box in ${what}`);
  const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  avcC.write(ds);
  const description = new Uint8Array(ds.buffer, 8, ds.position - 8);

  // [MOVE HERE, verbatim: the "Presentation time = media time + edit-list offset" comment block]
  const movieTimescale = file.moov.mvhd.timescale;
  // [MOVE HERE, verbatim: the "Rounded, not exact" comment block]
  const editOffsetNs = Math.round(
    (trak.edts?.elst?.entries ?? [])
      .filter((e: any) => e.media_time === -1)
      .reduce((sum: number, e: any) => sum + (e.segment_duration / movieTimescale) * 1_000_000_000, 0),
  );

  // A crash-recovered file's last fragment can be cut short (the kill landed
  // inside it): its moof describes samples whose bytes never reached disk.
  // They are dropped — but only as a SUFFIX. A sample past EOF followed by one
  // inside it means the table itself is wrong, and a reader must never have to
  // guess which frames are trustworthy.
  const all = trak.samples as any[];
  let kept = all.findIndex((s) => s.offset + s.size > src.size);
  if (kept === -1) kept = all.length;
  if (all.slice(kept).some((s) => s.offset + s.size <= src.size)) {
    throw new Error(`${what}: sample ${kept} points past the end of the file but a later one does not — the sample table is corrupt`);
  }
  const samples = all.slice(0, kept);

  // [MOVE HERE, verbatim: the "Chained from durations, not read from each sample's own `cts` (STC-394)" comment block]
  let cumulative = samples.length ? (samples[0].cts as number) : 0;
  const framesNs = samples.map((s, i) => {
    if (i > 0) cumulative += samples[i - 1].duration;
    const scale = 1_000_000_000 / s.timescale;
    const pts = cumulative * scale + editOffsetNs;
    if (!Number.isInteger(pts)) throw new Error(`non-integer ns PTS: cts=${cumulative} timescale=${s.timescale}`);
    return pts;
  });

  return {
    framesNs,
    codec: track.codec,
    codedWidth: track.track_width,
    codedHeight: track.track_height,
    description,
    chunks: samples.map((s, i) => ({
      type: s.is_sync ? "key" : "delta",
      timestampUs: Math.round(framesNs[i]! / 1000),
      offset: s.offset as number,
      size: s.size as number,
    })),
    bytes: src,
  };
}
```

- [ ] **Step 6: `session.ts` takes `ByteSource`**

In `transform/src/session.ts`, add `import type { ByteSource } from "./chunk-reader.js";` and change the two fields of `SessionInput`:

```ts
  displayMp4: ByteSource;
  cameraMp4?: ByteSource;
```

Nothing else in `loadSession` changes — it already passes them straight to `demuxTrack`.

- [ ] **Step 7: Convert the four decode sites (plain await-then-feed; Task 3 hardens the frame sources)**

`transform/src/decode.ts` — add `import { ChunkReader } from "./chunk-reader.js";` and replace the `for (const c of video.chunks) { decoder.decode(...) }` loop with:

```ts
  // Group by group (STC-236): a chunk carries no bytes, only where they are.
  const reader = new ChunkReader(video.chunks, video.bytes, "video");
  for (let i = 0; i < video.chunks.length;) {
    const g = reader.groupOf(i);
    const datas = await reader.read(g.start, g.end - g.start);
    datas.forEach((data, k) => {
      const c = video.chunks[g.start + k]!;
      decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
    });
    i = g.end;
  }
```

`harness/luma.ts` — add `import { ChunkReader, memorySource } from "@transform/chunk-reader";`, change `const v = await demuxTrack(buf, url);` to `const v = await demuxTrack(memorySource(buf, url), url);`, and replace its `for (const c of v.chunks) { … }` loop with:

```ts
  const reader = new ChunkReader(v.chunks, v.bytes, url);
  for (let i = 0; i < v.chunks.length;) {
    const g = reader.groupOf(i);
    const datas = await reader.read(g.start, g.end - g.start);
    for (let k = 0; k < datas.length; k++) {
      const c = v.chunks[g.start + k]!;
      dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: datas[k] as BufferSource }));
      // Bounded queue: feeding a whole take at once makes the decoder hold every
      // chunk, and on a large track that is where memory goes.
      while (dec.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
    }
    i = g.end;
  }
```

`transform/src/seeking-frame-source.ts` — add `import { ChunkReader } from "./chunk-reader.js";`, a field `private readonly reader: ChunkReader;` initialised in the constructor as `this.reader = new ChunkReader(video.chunks, video.bytes, "video");`, and replace the feeding `while` loop at the top of `pump` with:

```ts
    const feedLimit = target + SeekingFrameSource.FEED_AHEAD;
    const upto = Math.min(this.video.chunks.length, feedLimit + 1,
                          this.nextFeed + Math.max(0, SeekingFrameSource.FEED_AHEAD - d.decodeQueueSize));
    if (upto > this.nextFeed) {
      const from = this.nextFeed;
      const datas = await this.reader.read(from, upto - from);
      datas.forEach((data, k) => {
        const c = this.video.chunks[from + k]!;
        d.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
      });
      this.nextFeed = upto;
    }
```

(keep the existing comment about bounding by `nextFeed`; delete the now-duplicate `const feedLimit` line that followed it).

`transform/src/frame-source.ts` — same import and `reader` field, and replace the feeding `while` loop at the top of `pump` with:

```ts
    const upto = Math.min(this.video.chunks.length,
                          this.nextChunk + Math.max(0, ForwardFrameSource.QUEUE_TARGET - this.decoder.decodeQueueSize));
    if (upto > this.nextChunk) {
      const from = this.nextChunk;
      const datas = await this.reader.read(from, upto - from);
      datas.forEach((data, k) => {
        const c = this.video.chunks[from + k]!;
        this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
      });
      this.nextChunk = upto;
    }
```

- [ ] **Step 8: Wrap every other caller in `memorySource`**

Each is a one-line change plus the import `import { memorySource } from "@transform/chunk-reader";` (harness) or `"../src/chunk-reader.js"` / `"../../transform/src/chunk-reader.js"` (tests):

- `harness/main.ts:132` → `demuxTrack(memorySource(mp4, "display.mp4"), "display.mp4")`
- `harness/seek.ts:40` → `demuxTrack(memorySource(buf, mp4Url), mp4Url)`
- `harness/change-track.ts:24` → `demuxTrack(memorySource(displayMp4, "display.mp4"), "display.mp4")`
- `harness/export.ts:51` → `loadSession({ anchors, events, displayMp4: memorySource(displayMp4, "display.mp4"), cameraMp4: cameraMp4 && memorySource(cameraMp4, "camera.mp4"), micM4a, systemM4a })`
- `harness/sink-identity.ts:55` → `loadSession({ anchors, events, displayMp4: memorySource(mp4, "display.mp4"), cameraMp4: cameraMp4 && memorySource(cameraMp4, "camera.mp4"), micM4a, systemM4a })`
- `transform/test/session.test.ts:10-13` → the `mp4` helper returns `memorySource(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, p)`. Check with `grep -n "mp4(" transform/test/session.test.ts` that it is only used for `displayMp4`/`cameraMp4`; any use for `micM4a`/`systemM4a` needs a separate raw-buffer helper.
- `transform/test/export-pip.test.ts` → same change to its own `mp4` helper (same check).
- `app/test/system-audio-fixture.test.ts:26,44` → `displayMp4: memorySource(buf(join(takeDir, "display.mp4")), "display.mp4")`
- `helper/test/fragmented-writer.test.ts` → every `demuxTrack(readAb(X), NAME)` becomes `demuxTrack(memorySource(readAb(X), NAME), NAME)` (lines ~100, 101, 121, 147, 189); import `memorySource` from `"../../transform/src/chunk-reader.js"` inside each dynamic-import block alongside `demuxTrack`.

Run: `grep -rn "demuxTrack(\|loadSession(" transform/src app/src harness transform/test app/test helper/test | grep -v memorySource | grep -v "export async function\|export function"` — expected: only `transform/src/session.ts`'s own `demuxTrack(input.displayMp4` / `input.cameraMp4` calls and `app/src/editor.ts`'s `loadSession` (Task 5).

- [ ] **Step 9: Pin the crash-recovered file against the oracle**

In `helper/test/fragmented-writer.test.ts`, inside the test `"killed mid-write, the file is still readable up to close to the kill"`, after `const video = await demuxTrack(...)`, add:

```ts
    // STC-236: the lazy demux (index from boxes, a truncated last fragment
    // dropped as a suffix) must recover exactly what the whole-file demux did.
    const { demuxTrackOracle } = await import("../../transform/test/_demux-oracle.js");
    const { ChunkReader } = await import("../../transform/src/chunk-reader.js");
    const oracle = await demuxTrackOracle(readAb(out), "crashed.mp4");
    expect(video.framesNs).toEqual(oracle.framesNs);
    const bytes = await new ChunkReader(video.chunks, video.bytes, "crashed.mp4").read(0, video.chunks.length);
    bytes.forEach((b, i) => expect(Buffer.from(b).equals(Buffer.from(oracle.chunks[i]!.data)), `chunk ${i}`).toBe(true));
```

- [ ] **Step 10: Run everything this task touched**

```bash
npx vitest run transform/test/mp4-boxes.test.ts transform/test/demux-lazy.test.ts transform/test/session.test.ts transform/test/export-pip.test.ts app/test/system-audio-fixture.test.ts helper/test/fragmented-writer.test.ts
```

Expected: PASS. `fragmented-writer.test.ts` needs `swiftc` (present on this Mac).

**If the crash test fails with fewer lazy frames than oracle frames**, mp4box did not merge the moof samples into `trak.samples` on its own. Add, immediately after `file.flush();` in `demuxTrack`:

```ts
  // mp4box builds trak.samples from moov on parse, but merges fragment (moof)
  // samples only when asked; a crash-recovered file needs them.
  if (file.isFragmented) file.updateSampleLists();
```

and re-run. If it then reports MORE lazy frames than the oracle, the difference is samples the old demux never delivered: stop and report the two counts rather than changing the assertion.

- [ ] **Step 11: Full suite, typecheck, gates**

```bash
npm run typecheck
npm test
npm run gate:once && npm run gate:seek && npm run gate:export && npm run gate:identity
```

Expected: typecheck clean; `npm test` green; all four gates pass. The gates are what exercise the frame sources for real in Chrome (Node has no `VideoDecoder`).

- [ ] **Step 12: Commit**

```bash
git add transform/src/mp4-boxes.ts transform/src/demux.ts transform/src/session.ts transform/src/decode.ts \
        transform/src/seeking-frame-source.ts transform/src/frame-source.ts harness \
        transform/test/_demux-oracle.ts transform/test/mp4-boxes.test.ts transform/test/demux-lazy.test.ts \
        transform/test/session.test.ts transform/test/export-pip.test.ts app/test/system-audio-fixture.test.ts \
        helper/test/fragmented-writer.test.ts
git commit -m "STC-236: demux reads the sample index, not the samples

A chunk is an offset and a size now; ChunkReader fetches its bytes.
Checked against the pre-change demux on every fixture and on a
crash-recovered fragmented file.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frame sources survive supersession and read failure

**Files:**
- Create: `transform/test/_fake-webcodecs.ts`, `transform/test/seeking-frame-source.test.ts`, `transform/test/forward-frame-source.test.ts`
- Modify: `transform/src/seeking-frame-source.ts` (`seek`, `pump`), `transform/src/frame-source.ts` (`pump`)

**Interfaces:**
- Consumes: `ChunkReader`, `memorySource`, `ByteSource`, `VideoChunkRef` (Task 1); `DemuxedVideo` (Task 2); `syntheticTrack` exported from `transform/test/chunk-reader.test.ts` — move it to `transform/test/_synthetic-track.ts` in Step 1 so tests don't import a test file.
- Produces: `installFakeWebCodecs(): FakeWebCodecs` (test-only), where
  ```ts
  interface FakeWebCodecs { fed: { timestamp: number; data: Uint8Array }[]; restore(): void }
  ```

- [ ] **Step 1: Test scaffolding**

Move `syntheticTrack` out of `transform/test/chunk-reader.test.ts` into `transform/test/_synthetic-track.ts` (same code, `export function syntheticTrack`), and import it from there in `chunk-reader.test.ts`. Add to `_synthetic-track.ts`:

```ts
import type { DemuxedVideo } from "../src/demux.js";
import { memorySource, type ByteSource } from "../src/chunk-reader.js";

export function syntheticVideo(bytes?: (buf: ArrayBuffer) => ByteSource, n = 30, gop = 10): DemuxedVideo {
  const { buf, chunks } = syntheticTrack(n, gop);
  return {
    framesNs: chunks.map((c) => c.timestampUs * 1000),
    codec: "avc1.fake", codedWidth: 16, codedHeight: 16,
    description: new Uint8Array(0),
    chunks,
    bytes: bytes ? bytes(buf) : memorySource(buf, "synthetic.mp4"),
  };
}
```

`transform/test/_fake-webcodecs.ts`:

```ts
/**
 * Just enough WebCodecs for the frame sources' own logic to run in Node:
 * every decoded chunk comes back, one macrotask later, as a frame carrying
 * its timestamp. It decodes nothing — the gates do that in real Chrome. What
 * it lets a Node test see is the part the gates cannot aim at: what the
 * sources feed, in what order, and what they do while waiting for bytes.
 */
export interface FakeFrame { timestamp: number; closed: boolean; close(): void }
export interface FakeWebCodecs { fed: { timestamp: number; data: Uint8Array }[]; restore(): void }

export function installFakeWebCodecs(): FakeWebCodecs {
  const g = globalThis as any;
  const saved = { VideoDecoder: g.VideoDecoder, EncodedVideoChunk: g.EncodedVideoChunk };
  const fed: FakeWebCodecs["fed"] = [];

  g.EncodedVideoChunk = class {
    type: string; timestamp: number; data: Uint8Array;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      this.type = init.type; this.timestamp = init.timestamp; this.data = new Uint8Array(init.data);
    }
  };
  g.VideoDecoder = class {
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private readonly cb: { output: (f: FakeFrame) => void; error: (e: unknown) => void }) {}
    configure() { this.state = "configured"; }
    decode(chunk: { timestamp: number; data: Uint8Array }) {
      fed.push({ timestamp: chunk.timestamp, data: chunk.data });
      this.decodeQueueSize++;
      setTimeout(() => {
        if (this.state === "closed") return;
        this.decodeQueueSize--;
        const f: FakeFrame = { timestamp: chunk.timestamp, closed: false, close() { this.closed = true; } };
        this.cb.output(f);
      }, 0);
    }
    flush() { return new Promise<void>((r) => setTimeout(r, 1)); }
    close() { this.state = "closed"; }
  };
  return { fed, restore: () => Object.assign(g, saved) };
}
```

- [ ] **Step 2: Write the failing tests**

`transform/test/seeking-frame-source.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { syntheticVideo } from "./_synthetic-track.js";
import { memorySource, type ByteSource } from "../src/chunk-reader.js";
import { SeekingFrameSource } from "../src/seeking-frame-source.js";

let wc: FakeWebCodecs;
beforeEach(() => { wc = installFakeWebCodecs(); });
afterEach(() => wc.restore());

/** A source whose reads wait until `release()` — an IPC round trip we control. */
function gated(buf: ArrayBuffer): { src: ByteSource; started(): number; release(): void } {
  const inner = memorySource(buf, "synthetic.mp4");
  let open!: () => void;
  let started = 0;
  const gate = new Promise<void>((r) => { open = r; });
  return {
    src: { size: inner.size, read: async (o, l) => { started++; await gate; return inner.read(o, l); } },
    started: () => started,
    release: () => open(),
  };
}

describe("SeekingFrameSource over a ByteSource (STC-236)", () => {
  test("returns the requested frame, fed with that chunk's own bytes", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    const f = (await s.frameAt(14)) as any;
    expect(f.timestamp).toBe(video.chunks[14]!.timestampUs);
    const fed14 = wc.fed.find((x) => x.timestamp === video.chunks[14]!.timestampUs)!;
    expect(fed14.data.every((b) => b === 14 % 251)).toBe(true);
    expect(fed14.data.byteLength).toBe(video.chunks[14]!.size);
    s.close();
  });

  test("superseded while awaiting bytes: resolves null and feeds nothing for it", async () => {
    let g!: ReturnType<typeof gated>;
    const video = syntheticVideo((buf) => (g = gated(buf)).src);
    const s = new SeekingFrameSource(video);
    const first = s.frameAt(4);
    // The second request must arrive while the first is INSIDE its read. Asked
    // any earlier, the first is superseded while still queued on the chain and
    // resolves null before reading anything — a pass that proves nothing.
    await vi.waitFor(() => expect(g.started()).toBeGreaterThan(0));
    const second = s.frameAt(25);
    g.release();
    expect(await first).toBeNull();
    const f = (await second) as any;
    expect(f.timestamp).toBe(video.chunks[25]!.timestampUs);
    // Nothing from group 0 reached the decoder: the first seek never fed.
    expect(wc.fed.some((x) => x.timestamp < video.chunks[10]!.timestampUs)).toBe(false);
    s.close();
  });

  test("a failed read poisons the source: this request and the next reject, naming the file", async () => {
    const video = syntheticVideo(() => ({ size: 1e6, read: () => Promise.reject(new Error("synthetic.mp4: read [0, 91) failed")) }));
    const s = new SeekingFrameSource(video);
    await expect(s.frameAt(3)).rejects.toThrow(/synthetic\.mp4/);
    await expect(s.frameAt(3)).rejects.toThrow(/synthetic\.mp4/);
    s.close();
  });
});
```

`transform/test/forward-frame-source.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { syntheticVideo } from "./_synthetic-track.js";
import { ForwardFrameSource } from "../src/frame-source.js";

let wc: FakeWebCodecs;
beforeEach(() => { wc = installFakeWebCodecs(); });
afterEach(() => wc.restore());

describe("ForwardFrameSource over a ByteSource (STC-236)", () => {
  test("every frame in order, each fed with its own bytes", async () => {
    const video = syntheticVideo();
    const s = new ForwardFrameSource(video);
    for (let i = 0; i < video.chunks.length; i++) {
      expect(((await s.frameAt(i)) as any).timestamp).toBe(video.chunks[i]!.timestampUs);
    }
    expect(wc.fed.map((x) => x.timestamp)).toEqual(video.chunks.map((c) => c.timestampUs));
    wc.fed.forEach((x, i) => expect(x.data.every((b) => b === i % 251)).toBe(true));
    s.close();
  });

  test("a failed read rejects frameAt and every later call", async () => {
    const video = syntheticVideo(() => ({ size: 1e6, read: () => Promise.reject(new Error("synthetic.mp4: gone")) }));
    const s = new ForwardFrameSource(video);
    await expect(s.frameAt(0)).rejects.toThrow("synthetic.mp4: gone");
    await expect(s.frameAt(1)).rejects.toThrow("synthetic.mp4: gone");
    s.close();
  });
});
```

- [ ] **Step 3: Run to see which fail**

Run: `npx vitest run transform/test/seeking-frame-source.test.ts transform/test/forward-frame-source.test.ts`
Expected: "superseded while awaiting bytes" FAILS — Task 2's conversion feeds group 0 once its bytes arrive, so a timestamp below chunk 10's reaches the decoder. The other tests may already pass: without the fix a second call simply retries the read, which fails again. They stay as guards on the `this.failure` path. Do not weaken the supersession test to make it pass.

- [ ] **Step 4: Harden `SeekingFrameSource`**

In `transform/src/seeking-frame-source.ts`:

Change the `pump` signature and its call site in `seek`:

```ts
      if (!(await this.pump(index, mine))) break;
```

```ts
  private async pump(target: number, mine: number): Promise<boolean> {
```

Replace the fetch block from Task 2 Step 7 with:

```ts
    if (upto > this.nextFeed) {
      const from = this.nextFeed;
      let datas: Uint8Array[];
      try {
        datas = await this.reader.read(from, upto - from);
      } catch (e) {
        // A read failure is as fatal as a decoder error and surfaces the same
        // way: every later request throws it too, rather than a frozen frame.
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      }
      // The await is a window a newer seek can use. It cannot touch this
      // decoder — the chain serialises seeks — but it has asked for a
      // different frame, and feeding ones nobody wants only delays it. Feed
      // nothing and let seek() see the new ticket and resolve null.
      if (mine !== this.ticket) return true;
      datas.forEach((data, k) => {
        const c = this.video.chunks[from + k]!;
        d.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
      });
      this.nextFeed = upto;
    }
```

- [ ] **Step 5: Harden `ForwardFrameSource`**

In `transform/src/frame-source.ts`, replace the fetch block from Task 2 Step 7 with:

```ts
    if (upto > this.nextChunk) {
      const from = this.nextChunk;
      let datas: Uint8Array[];
      try {
        datas = await this.reader.read(from, upto - from);
      } catch (e) {
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      }
      datas.forEach((data, k) => {
        const c = this.video.chunks[from + k]!;
        this.decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
      });
      this.nextChunk = upto;
    }
```

`frameAt`'s loop already checks `if (this.failure) throw this.failure;` first, which is what makes the next call reject.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run transform/test/seeking-frame-source.test.ts transform/test/forward-frame-source.test.ts transform/test/chunk-reader.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, gates, commit**

```bash
npm run typecheck
npm run gate:seek && npm run gate:export && npm run gate:identity
git add transform/src/seeking-frame-source.ts transform/src/frame-source.ts transform/test/_fake-webcodecs.ts \
        transform/test/_synthetic-track.ts transform/test/chunk-reader.test.ts \
        transform/test/seeking-frame-source.test.ts transform/test/forward-frame-source.test.ts
git commit -m "STC-236: frame sources — a seek superseded mid-read feeds nothing; a failed read is fatal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Export prefetches the next keyframe group

**Files:**
- Modify: `transform/src/frame-source.ts` (`pump`)
- Test: `transform/test/forward-frame-source.test.ts`

**Interfaces:**
- Consumes: `ChunkReader.prefetch(index)`, `ChunkReader.groupOf(index)` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add `import { memorySource, type ByteSource } from "../src/chunk-reader.js";` to the imports at the top of `transform/test/forward-frame-source.test.ts`, then add this test inside its `describe`:

```ts
test("while group g decodes, group g+1's bytes are already being read", async () => {
  const reads: number[] = [];
  const video = syntheticVideo((buf) => {
    const inner = memorySource(buf, "synthetic.mp4");
    return { size: inner.size, read: (o, l) => { reads.push(o); return inner.read(o, l); } } as ByteSource;
  });
  const s = new ForwardFrameSource(video);
  await s.frameAt(0);                                   // group 0 is being fed
  expect(reads).toContain(video.chunks[10]!.offset);    // group 1 already requested
  expect(reads).not.toContain(video.chunks[20]!.offset);   // but not group 2: at most two groups held
  s.close();
});
```

Run: `npx vitest run transform/test/forward-frame-source.test.ts` — expected FAIL on `toContain(video.chunks[10]!.offset)`.

- [ ] **Step 2: Implement**

In `transform/src/frame-source.ts`, directly after `this.nextChunk = upto;` inside the fetch block, add:

```ts
      // Start reading the NEXT group while this one decodes (STC-236). Over
      // IPC a group is one round trip, and export would otherwise stall on it
      // at every keyframe. ChunkReader holds two groups, so this is the most
      // that can ever be ahead.
      const g = this.reader.groupOf(upto - 1);
      if (g.end < this.video.chunks.length) this.reader.prefetch(g.end);
```

- [ ] **Step 3: Verify, gate, commit**

```bash
npx vitest run transform/test/forward-frame-source.test.ts
npm run gate:export && npm run gate:identity
git add transform/src/frame-source.ts transform/test/forward-frame-source.test.ts
git commit -m "STC-236: export prefetches the next keyframe group while the current one decodes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: test PASS, both gates pass.

---

### Task 5: The editor opens video by range

**Files:**
- Modify: `app/src/editor.ts` (near `readVideo`, ~line 1327; `openTakeOrThrow`, ~1340-1357; `closeTake`)
- Test: `app/test/preview.e2e.test.ts`

**Interfaces:**
- Consumes: `ByteSource` (Task 1), `SessionInput.displayMp4/cameraMp4: ByteSource` (Task 2); existing `editor.takeFileSize(name)` (`preview:size`) and `editor.readTakeChunk(name, offset, length)` (`preview:chunk`).
- Produces: `window.__stcVideoBytesRead(): { display: number; displaySize: number; camera: number }` — a test hook the e2e test reads.

- [ ] **Step 1: Write the failing e2e test**

Append inside the `describe` in `app/test/preview.e2e.test.ts`:

```ts
  // STC-236. The preview used to read display.mp4 whole before showing
  // anything; now it reads the sample index plus the keyframe group it needs.
  // fixtures/basic has two groups, so showing frame 0 must read strictly less
  // than the file. Counted by the editor's own ByteSource, not inferred.
  test("opening a take reads the index and one keyframe group, not the whole video", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    const r = await editorWin.evaluate(() =>
      (window as unknown as { __stcVideoBytesRead: () => { display: number; displaySize: number } }).__stcVideoBytesRead());
    expect(r.display).toBeGreaterThan(0);
    expect(r.display).toBeLessThan(r.displaySize);
  }, 120_000);
```

Run: `npm run app:build && npx vitest run --project e2e app/test/preview.e2e.test.ts -t "keyframe group"`
Expected: FAIL — `__stcVideoBytesRead is not a function`.

- [ ] **Step 2: Implement `ipcSource` and use it**

In `app/src/editor.ts`, add `import type { ByteSource } from "../../transform/src/chunk-reader.js";` (match the relative style of the file's existing transform imports — check `grep -n "transform/src" app/src/editor.ts | head -3`).

Directly after `readVideo`, add:

```ts
/**
 * A take file read by range (STC-236), over the same preview:size /
 * preview:chunk channels readVideo uses — the renderer still never names a
 * path. The video tracks go through this; the audio tracks still go through
 * readVideo, whole (decoded PCM is their real cost, a separate ticket).
 *
 * preview:chunk returns fewer bytes than asked at EOF rather than failing, so
 * the length is checked here: a short chunk handed to the decoder would be a
 * corrupt frame, not an error anyone could see.
 */
async function ipcSource(name: string): Promise<ByteSource & { readonly bytesRead: number }> {
  const size = await editor.takeFileSize(name);
  let bytesRead = 0;
  return {
    size,
    get bytesRead() { return bytesRead; },
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        throw new Error(`${name}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`);
      }
      if (length === 0) return new Uint8Array(0);
      const got = new Uint8Array(await editor.readTakeChunk(name, offset, length));
      if (got.byteLength !== length) {
        throw new Error(`${name}: short read at ${offset} — asked for ${length} bytes, got ${got.byteLength}. Was the file changed while open?`);
      }
      bytesRead += length;
      return got;
    },
  };
}

let openVideoSources: { display: Awaited<ReturnType<typeof ipcSource>>; camera?: Awaited<ReturnType<typeof ipcSource>> } | undefined;

// Test hook (app/test/preview.e2e.test.ts): how much of each video file the
// open take has actually read. Read-only, and zero when nothing is open.
(window as unknown as { __stcVideoBytesRead: () => { display: number; displaySize: number; camera: number } })
  .__stcVideoBytesRead = () => ({
    display: openVideoSources?.display.bytesRead ?? 0,
    displaySize: openVideoSources?.display.size ?? 0,
    camera: openVideoSources?.camera?.bytesRead ?? 0,
  });
```

In `openTakeOrThrow`, replace `readVideo(),` in the `Promise.all` with `ipcSource("display.mp4"),` (rename the destructured `mp4` to `displaySrc`), replace the `cameraMp4` line with:

```ts
  const cameraSrc = anchors.files?.camera ? await ipcSource(anchors.files.camera) : undefined;
```

and the `loadSession` call with:

```ts
  const session = await loadSession({ anchors, events, displayMp4: displaySrc, cameraMp4: cameraSrc, micM4a, systemM4a });
  openVideoSources = { display: displaySrc, camera: cameraSrc };
```

In `closeTake` (find it with `grep -n "async function closeTake" app/src/editor.ts`), next to `openSession = undefined;`, add `openVideoSources = undefined;`.

- [ ] **Step 3: Verify**

```bash
npm run typecheck
npm run app:build
npx vitest run --project e2e app/test/preview.e2e.test.ts app/test/export-size.e2e.test.ts app/test/manage.e2e.test.ts
```

Expected: all PASS — the new test, plus the existing open/scrub/PiP/export e2e tests, which now run over `ipcSource`.

- [ ] **Step 4: Commit**

```bash
git add app/src/editor.ts app/test/preview.e2e.test.ts
git commit -m "STC-236: the editor opens video by range instead of reading it whole

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Measure on this Mac, runbook, docs, follow-up

**Files:**
- Create: `docs/STC-236-RUNBOOK.md`
- Modify: `docs/CORRECTNESS-TRAPS.md` (the "Preview holds the whole video in memory" bullet, ~line 138), `docs/TICKET-LOG.md` (append a row; update the STC-251/252 row), `CLAUDE.md` (table rows), `docs/BRIEF.md` only if it states the 15-minute ceiling (`grep -n "15.min" docs/BRIEF.md`)

- [ ] **Step 1: Measure before/after on a real take**

`scripts/measure-preview-memory.mjs` launches the built app. Measure the newest real take on `master`'s build and on this branch's:

The baseline is built in a SEPARATE worktree — never check `master` out inside this one, and never use bare `git stash` (the stash stack is shared with peer sessions). `$SCRATCH` is the session scratchpad directory.

```bash
TAKE=$(ls -td ~/Desktop/stc/*/ | head -1)
git worktree add ../stc-236-baseline master
(cd ../stc-236-baseline && npm ci && npm run app:build && node scripts/measure-preview-memory.mjs "$TAKE") | tee "$SCRATCH/baseline.txt"
npm run app:build && node scripts/measure-preview-memory.mjs "$TAKE" | tee "$SCRATCH/after.txt"
git worktree remove ../stc-236-baseline
```

Record both absolute RSS growth numbers and the take's `display.mp4` size. Expected: growth after is roughly the fixed decoder cost, not proportional to the file. If after ≥ baseline, STOP and investigate before writing any docs.

- [ ] **Step 2: Write the runbook**

`docs/STC-236-RUNBOOK.md` with these sections, filled with the Step 1 numbers:

```markdown
# STC-236 runbook — streaming the preview

Branch: `accounts/stc-236-n-minute-segmentation` until merged, then `master`.

## What changed
The editor reads display.mp4/camera.mp4 by range: the sample index at open, then one keyframe group at a time. Audio is still read whole.

## Measured here (2026-09-26, <display.mp4 size> take)
| build | renderer RSS growth |
|---|---|
| master | <baseline> |
| this branch | <after> |

## What only a person with a Mac can settle
1. **A long take.** Record ≥ 15 min at 4K (the old ceiling), then `node scripts/measure-preview-memory.mjs <takeDir>`. Pass: growth within ~2x of the short-take number above, not ~1.2x the file size.
2. **Scrub feel.** On that take, drag the scrubber fast end to end, then small back-and-forth drags. Pass: no worse than a short take. Fail: a visible lag on crossing keyframes (each group is one IPC read).
3. **Export time.** Export the long take. Pass: within ~10% of the same take on master.
4. **A file removed while open.** Open a take, move its folder to the Trash in Finder, then scrub. Pass: a visible error. Fail: a frozen frame with no message.
```

- [ ] **Step 3: Update the docs**

- `docs/CORRECTNESS-TRAPS.md`: rewrite the "Preview holds the whole video in memory" bullet to say it held until STC-236, which reads video by range; keep the 458 MB → +548 MB history, add the Step 1 numbers, and note audio is still whole.
- `docs/TICKET-LOG.md`: append an STC-236 row — redirected from segmentation (why, in one line each: no OOM evidence; `movieFragmentInterval` already bounds crash loss to ~2 s; the real limit was the editor reading the file whole), what shipped (ChunkReader, box-walk demux, supersession-safe frame sources, editor `ipcSource`), the two spec corrections (truncated last box tolerated; watchdog removed), measured numbers, and what's open (runbook §1-4, audio PCM follow-up). Change the STC-251/252 row to point at STC-236.
- `CLAUDE.md` table: add rows for `transform/src/chunk-reader.ts` + `transform/src/mp4-boxes.ts` (one row) and `docs/STC-236-RUNBOOK.md`, in the file's own voice (what the module is, and the non-obvious thing: groups are fetched per contiguous run, and a truncated last box is a crash-recovered file, not an error).

- [ ] **Step 4: File the audio follow-up (list first)**

List Linear issues in the Capture project matching "audio" and "memory" (`list_issues` with a query) and check open PRs (`gh pr list --search "audio memory"`). Only if nothing covers it, create: title "Preview audio memory — decoded PCM grows with take length", body: mic/system are decoded whole to float32 PCM (48 kHz stereo ≈ 23 MB/min, ~1.4 GB/hour), now the larger preview ceiling after STC-236; relate to STC-236 and STC-251.

- [ ] **Step 5: Final verification and commit**

```bash
npm run typecheck
npm test
npm run gate:once && npm run gate:seek && npm run gate:export && npm run gate:identity
git add docs/STC-236-RUNBOOK.md docs/CORRECTNESS-TRAPS.md docs/TICKET-LOG.md CLAUDE.md docs/BRIEF.md
git commit -m "STC-236: runbook, measured numbers, docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then push and open the PR (`git push -u origin HEAD`, `gh pr create --base master`), and merge only with `npm run merge -- <pr>`. The hand-off to Patrick names the runbook AND the branch.
