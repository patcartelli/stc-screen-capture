# STC-395 GIF Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh recording's floating panel gets a `Video | GIF` switch; picking GIF converts the take to an animated GIF in the background, and Copy/Save then hand over the GIF.

**Architecture:** STC-488's hidden render window gains a second output format. Frames come from ONE frame loop extracted out of `exportSession` (so the GIF sink cannot fork the transform), are read back from the canvas and handed to a pure, Node-testable encoder (`gif-encode.ts`, wrapping `gifenc`). Main caches the finished GIF in `copiesRoot`, the panel's states come from a pure reducer (`gif-panel.ts`), and a saved GIF is a plain, untagged file beside the kept take — the library model is untouched.

**Tech Stack:** TypeScript, Electron (main + hidden renderer), WebCodecs/OffscreenCanvas in the render window, `gifenc` 1.0.3 (MIT) for quantize + encode, `omggif` 1.0.10 (MIT, devDependency) to decode in tests, vitest, Playwright-Electron e2e.

**Spec:** `docs/superpowers/specs/2026-10-08-stc-395-gif-output-design.md`

## Global Constraints

- GIF frame rates are exactly `{10, 12, 15, 20, 30}`; default 15. Each must divide `EXPORT_FPS` (60, `transform/src/time.ts`).
- GIF max widths are exactly `{480, 640, 960, 1280, "original"}`; default 960. Never upscale; dimensions come from `outputSizeFor` (`transform/src/output-size.ts`), so both are even.
- Delays are whole centiseconds, rounded cumulatively: frame `i` ends at `round((i+1) * 100 / fps)` cs.
- One global palette (≤255 colours + 1 reserved transparent slot), no dithering, unchanged pixels transparent, loop forever.
- Large-GIF threshold: `GIF_LARGE_BYTES = 10_000_000` (decimal). Warning text: `GIF · <size> — large for a GIF; Video is smaller`. Never blocks.
- The toggle appears only for `{ kind: "recording", origin: "fresh" }`, and every panel starts on Video.
- Save in GIF mode: wait for ready → promote (unchanged) → write `<save folder>/<take name>.gif` through `.partial` + rename → toast. A GIF failure after promote never loses the take.
- `.gif` must NOT join `MEDIA_EXTENSIONS` (`app/src/library.ts`) — the saved GIF is untagged and outside the library model.
- The cached GIF lives at `copiesRoot/<take leaf>.gif`; purge rules identical to the `.mp4` copy (24 h, clipboard spared, partial > 1 h removed, nothing deleted when the clipboard can't be read).
- `gate:export` and `gate:identity` hashes must be unchanged by the frame-loop extraction.
- Spec correction (found while planning): the panel has had no auto-dismiss timer since STC-392 (`thumbnail-window.ts` module doc), so spec §2's "holds its timer" needs no code. Task 12 corrects the spec text.
- E2E runs in the Tart VM first (`docs/VM-TESTING.md`), then CI — not locally on Patrick's Mac.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A trimmed take** — the GIF must cover exactly the trim window, not the whole take. Test: Task 4's `gif-one.mjs --check` on a fixture with a `trim` in `project.json`, asserting the summed delay equals the trim length within one frame.
2. **A take shorter than one GIF frame step / a 1-frame take** — must still produce a valid 1-frame GIF, not throw on an empty palette sample. Test: Task 2 encodes a single frame; Task 1 `gifFrameCount(1, 30) === 1`.
3. **A capture narrower than `maxWidth`** (an area recording 400 px wide) — must render at capture size, never upscaled. Test: Task 1 `gifSize({width:400,height:300}, 960)`.
4. **Flipping GIF → Video → GIF quickly while a conversion is mid-flight** — the second GIF must not inherit a cancelled job's outcome or a deleted file. Test: Task 8's `gif-cache.test.ts` (generation counter) and Task 11's e2e "flip back and forth".
5. **Saving when a `<take>.gif` already exists in the save folder** (two takes in the same second, or a re-save) — must not overwrite. Test: Task 5 `savedGifName` collision cases.

---

## File Structure

| file | responsibility |
|---|---|
| `transform/src/gif-options.ts` (new) | settings vocabulary + pure arithmetic: options, defaults, `cleanGifSettings`, `gifFrameStep`, `gifFrameCount`, `gifDelaysCs`, `gifSize`. Node-safe; imported by `settings.ts` and the render window |
| `transform/src/gif-encode.ts` (new) | pure encoder: `buildPalette`, `GifWriter`. RGBA in, bytes out |
| `transform/src/export.ts` (modify) | extract `compositeFrames` generator; `exportSession` consumes it |
| `transform/src/gif-export.ts` (new) | browser sink: two passes over `compositeFrames` (palette sample, then encode) |
| `harness/gif.html`, `harness/gif.ts`, `scripts/gif-one.mjs` (new) | run `exportGif` in real Chrome on a session dir; write the file; `--check` asserts structure |
| `app/src/copy-render.ts`, `app/src/copy-render-window.ts` (modify) | `format: "mp4" \| "gif"` per job |
| `app/src/recording-copy.ts` (modify) | `gifCopyPathFor`, purge learns `.gif`, `savedGifName` |
| `app/src/gif-cache.ts` (new) | main's per-take record of what the cached GIF was made with; generation counter |
| `app/src/settings.ts`, `app/renderer/index.html`, `app/src/renderer.ts` (modify) | `gif` settings block + profile-sheet row |
| `app/src/gif-panel.ts` (new) | pure reducer for the switch's states + size formatting + warning |
| `app/src/panel-actions.ts` (modify) | `offersFormat` |
| `app/src/main.ts`, `app/src/thumbnail-preload.ts`, `app/src/toast-message.ts` (modify) | `panel:gif`, `panel:cancelGif`, format on copy/save, reveal toast |
| `app/renderer/thumbnail.html`, `app/src/thumbnail-renderer.ts` (modify) | the switch and its states |
| `app/test/gif-panel.e2e.test.ts` (new) | wired behaviour |
| `docs/STC-395-RUNBOOK.md`, `docs/TICKET-LOG.md`, `CLAUDE.md` | docs |

---

### Task 1: GIF options and arithmetic

**Files:**
- Create: `transform/src/gif-options.ts`
- Test: `transform/test/gif-options.test.ts`
- Modify: `package.json` (deps)

**Interfaces:**
- Consumes: `EXPORT_FPS` (`transform/src/time.ts`), `outputSizeFor` (`transform/src/output-size.ts`), `Size` (`transform/src/spaces.ts`)
- Produces:
  - `GIF_FPS_OPTIONS: readonly [10,12,15,20,30]`, `type GifFps`
  - `GIF_WIDTH_OPTIONS: readonly [480,640,960,1280,"original"]`, `type GifMaxWidth`
  - `interface GifSettings { fps: GifFps; maxWidth: GifMaxWidth }`, `DEFAULT_GIF_SETTINGS`
  - `cleanGifSettings(v: unknown): GifSettings`
  - `gifFrameStep(fps: GifFps): number`
  - `gifFrameCount(exportFrames: number, fps: GifFps): number`
  - `gifDelaysCs(count: number, fps: GifFps): number[]`
  - `gifSize(capture: Size, maxWidth: GifMaxWidth): Size`

- [ ] **Step 1: Add dependencies**

```bash
npm install gifenc@1.0.3 && npm install -D omggif@1.0.10
```
Check `node_modules/gifenc/README.md` for `quantize`, `applyPalette`, `GIFEncoder().writeFrame(index, w, h, opts)` — Task 2 relies on `opts.delay` being MILLISECONDS (it is divided by 10 internally) and on `palette` being written as the global table on the first frame.

- [ ] **Step 2: Write the failing test**

```ts
// transform/test/gif-options.test.ts
import { describe, test, expect } from "vitest";
import {
  GIF_FPS_OPTIONS, DEFAULT_GIF_SETTINGS, cleanGifSettings,
  gifFrameStep, gifFrameCount, gifDelaysCs, gifSize,
} from "../src/gif-options.js";
import { EXPORT_FPS } from "../src/time.js";

describe("GIF frame rate", () => {
  test("every offered rate divides the export grid, so GIF frames land on export frames", () => {
    for (const fps of GIF_FPS_OPTIONS) expect(EXPORT_FPS % fps).toBe(0);
  });
  test("the step is export frames per GIF frame", () => {
    expect(gifFrameStep(15)).toBe(4);
    expect(gifFrameStep(30)).toBe(2);
    expect(gifFrameStep(12)).toBe(5);
  });
  test("a rate that is not an option is refused, not rounded", () => {
    expect(() => gifFrameStep(25 as never)).toThrow(/not a GIF frame rate/);
  });
  test("frame count covers every export frame, and a 1-frame take is 1 GIF frame", () => {
    expect(gifFrameCount(60, 15)).toBe(15);
    expect(gifFrameCount(61, 15)).toBe(16);
    expect(gifFrameCount(1, 30)).toBe(1);
    expect(gifFrameCount(0, 15)).toBe(0);
  });
});

describe("GIF delays", () => {
  test("15 fps rounds cumulatively (frame ends at 7, 13, 20, 27 … cs)", () => {
    expect(gifDelaysCs(6, 15)).toEqual([7, 6, 7, 7, 6, 7]);
  });
  test("the total never drifts from the duration", () => {
    for (const fps of GIF_FPS_OPTIONS) {
      for (const n of [1, 2, 7, 15, 899, 900]) {
        const total = gifDelaysCs(n, fps).reduce((a, b) => a + b, 0);
        expect(total).toBe(Math.round((n * 100) / fps));
      }
    }
  });
  test("10 fps is exact", () => {
    expect(gifDelaysCs(3, 10)).toEqual([10, 10, 10]);
  });
});
```
(`[7,6,7,7,6,7]`: ends at round(6.67)=7, round(13.33)=13, round(20)=20, round(26.67)=27, round(33.33)=33, round(40)=40 → diffs 7,6,7,7,6,7. The spec's "7, 7, 6" was illustrative; the cumulative rule is the requirement.)

```ts
describe("GIF size", () => {
  test("capped at maxWidth with the capture's aspect, both even", () => {
    expect(gifSize({ width: 3840, height: 2160 }, 960)).toEqual({ width: 960, height: 540 });
    expect(gifSize({ width: 1513, height: 997 }, 640)).toEqual({ width: 640, height: 422 });
  });
  test("never upscaled: a narrow area capture keeps its own width", () => {
    expect(gifSize({ width: 400, height: 300 }, 960)).toEqual({ width: 400, height: 300 });
  });
  test("'original' is the capture's own width, evened DOWN — never up (Review Focus 3)", () => {
    expect(gifSize({ width: 1513, height: 997 }, "original")).toEqual({ width: 1512, height: 996 });
  });
});

describe("cleanGifSettings", () => {
  test("defaults are 15 fps / 960", () => {
    expect(DEFAULT_GIF_SETTINGS).toEqual({ fps: 15, maxWidth: 960 });
  });
  test("valid values round-trip", () => {
    expect(cleanGifSettings({ fps: 30, maxWidth: "original" })).toEqual({ fps: 30, maxWidth: "original" });
  });
  test("each invalid field falls back on its own", () => {
    expect(cleanGifSettings({ fps: 25, maxWidth: 640 })).toEqual({ fps: 15, maxWidth: 640 });
    expect(cleanGifSettings({ fps: 10, maxWidth: 1000 })).toEqual({ fps: 10, maxWidth: 960 });
    expect(cleanGifSettings("nope")).toEqual(DEFAULT_GIF_SETTINGS);
    expect(cleanGifSettings(undefined)).toEqual(DEFAULT_GIF_SETTINGS);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run transform/test/gif-options.test.ts`
Expected: FAIL — cannot resolve `../src/gif-options.js`.

- [ ] **Step 4: Implement**

```ts
// transform/src/gif-options.ts
/**
 * A GIF's settings and the arithmetic they imply (STC-395). Pure and
 * Node-safe: `app/src/settings.ts` validates against these lists, and the
 * render window computes size, step and delays from them, so the two cannot
 * disagree about what a valid GIF setting is.
 *
 * Rates are the divisors of EXPORT_FPS that make sense for a GIF, so every
 * GIF frame IS an export frame (`render()` is never asked for a time off the
 * grid). GIF delays are whole centiseconds; 15 fps cannot be exact, so frame
 * ends are rounded cumulatively and the total never drifts.
 */
import { EXPORT_FPS } from "./time.js";
import { outputSizeFor } from "./output-size.js";
import type { Size } from "./spaces.js";

export const GIF_FPS_OPTIONS = [10, 12, 15, 20, 30] as const;
export type GifFps = (typeof GIF_FPS_OPTIONS)[number];

export const GIF_WIDTH_OPTIONS = [480, 640, 960, 1280, "original"] as const;
export type GifMaxWidth = (typeof GIF_WIDTH_OPTIONS)[number];

export interface GifSettings { fps: GifFps; maxWidth: GifMaxWidth }

export const DEFAULT_GIF_SETTINGS: GifSettings = { fps: 15, maxWidth: 960 };

export function cleanGifSettings(v: unknown): GifSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    fps: (GIF_FPS_OPTIONS as readonly unknown[]).includes(d.fps)
      ? d.fps as GifFps : DEFAULT_GIF_SETTINGS.fps,
    maxWidth: (GIF_WIDTH_OPTIONS as readonly unknown[]).includes(d.maxWidth)
      ? d.maxWidth as GifMaxWidth : DEFAULT_GIF_SETTINGS.maxWidth,
  };
}

export function gifFrameStep(fps: GifFps): number {
  if (!(GIF_FPS_OPTIONS as readonly number[]).includes(fps) || EXPORT_FPS % fps !== 0) {
    throw new Error(`${fps} is not a GIF frame rate (${GIF_FPS_OPTIONS.join(", ")})`);
  }
  return EXPORT_FPS / fps;
}

export function gifFrameCount(exportFrames: number, fps: GifFps): number {
  return Math.ceil(Math.max(0, exportFrames) / gifFrameStep(fps));
}

export function gifDelaysCs(count: number, fps: GifFps): number[] {
  gifFrameStep(fps);
  const end = (i: number) => Math.round((i * 100) / fps);
  return Array.from({ length: count }, (_, i) => end(i + 1) - end(i));
}

export function gifSize(capture: Size, maxWidth: GifMaxWidth): Size {
  const cap = maxWidth === "original" ? capture.width : Math.min(maxWidth, capture.width);
  // Floor to even BEFORE outputSizeFor: its own `even()` rounds to nearest, so an
  // odd capture width (1513) would come back as 1514 — a one-pixel upscale.
  return outputSizeFor(capture, cap - (cap % 2));
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run transform/test/gif-options.test.ts`
Expected: PASS. If the 15 fps delay row disagrees, recompute by hand from the cumulative rule — do not change the rule.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add package.json package-lock.json transform/src/gif-options.ts transform/test/gif-options.test.ts
git commit -m "STC-395: GIF settings vocabulary and frame arithmetic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The GIF encoder, and the speed checkpoint

**Files:**
- Create: `transform/src/gif-encode.ts`, `scripts/gif-bench.mjs`
- Test: `transform/test/gif-encode.test.ts`

**Interfaces:**
- Consumes: `gifenc` (`quantize`, `applyPalette`, `GIFEncoder`)
- Produces:
  - `type Palette = number[][]` (`[r,g,b]` entries)
  - `buildPalette(samples: readonly Uint8ClampedArray[]): Palette` — ≤255 colours, never empty
  - `class GifWriter { constructor(width: number, height: number, palette: Palette, delaysCs: readonly number[]); addFrame(rgba: Uint8ClampedArray): void; finish(): Uint8Array; readonly frameCount: number }`

- [ ] **Step 1: Write the failing test**

```ts
// transform/test/gif-encode.test.ts
import { describe, test, expect } from "vitest";
import { GifReader } from "omggif";
import { buildPalette, GifWriter } from "../src/gif-encode.js";

const W = 16, H = 8;
function solid(r: number, g: number, b: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) a.set([r, g, b, 255], i * 4);
  return a;
}
function withBox(base: Uint8ClampedArray, x0: number, y0: number, rgb: [number, number, number]) {
  const a = base.slice();
  for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) a.set([...rgb, 255], (y * W + x) * 4);
  return a;
}
/** Composite every frame the way a viewer does (disposal 1: keep the previous). */
function playAll(bytes: Uint8Array): Uint8ClampedArray[] {
  const r = new GifReader(bytes);
  const canvas = new Uint8ClampedArray(r.width * r.height * 4);
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i < r.numFrames(); i++) {
    r.decodeAndBlitFrameRGBA(i, canvas);   // leaves transparent pixels untouched
    out.push(canvas.slice());
  }
  return out;
}

describe("GifWriter", () => {
  const white = solid(255, 255, 255);
  const frames = [white, withBox(white, 2, 2, [255, 0, 0]), withBox(white, 10, 4, [0, 0, 255])];
  const palette = buildPalette(frames);

  function encode(fs = frames, delays = [7, 6, 7]) {
    const w = new GifWriter(W, H, palette, delays);
    for (const f of fs) w.addFrame(f);
    return w.finish();
  }

  test("is a looping GIF89a of the right size and frame count", () => {
    const bytes = encode();
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
    const r = new GifReader(bytes);
    expect([r.width, r.height, r.numFrames()]).toEqual([W, H, 3]);
    expect(r.loopCount()).toBe(0);                       // 0 = forever
  });

  test("delays are written as given, in centiseconds", () => {
    const r = new GifReader(encode());
    expect([0, 1, 2].map((i) => r.frameInfo(i).delay)).toEqual([7, 6, 7]);
  });

  test("one global palette, no local tables", () => {
    const r = new GifReader(encode());
    for (let i = 0; i < r.numFrames(); i++) expect(r.frameInfo(i).palette_offset).toBe(13);
  });

  test("unchanged pixels are transparent after frame 0, and frame 0 has none", () => {
    const r = new GifReader(encode());
    expect(r.frameInfo(0).transparent_index).toBe(null);
    expect(r.frameInfo(1).transparent_index).not.toBe(null);
    expect(r.frameInfo(1).disposal).toBe(1);
  });

  test("played back, every frame matches its input exactly (flat colours are in the palette)", () => {
    const played = playAll(encode());
    played.forEach((p, i) => expect(Buffer.from(p).equals(Buffer.from(frames[i]!))).toBe(true));
  });

  test("a single frame is a valid GIF (Review Focus 2)", () => {
    const w = new GifWriter(W, H, buildPalette([white]), [10]);
    w.addFrame(white);
    expect(new GifReader(w.finish()).numFrames()).toBe(1);
  });

  test("refuses a frame of the wrong size and a frame past the delay list", () => {
    const w = new GifWriter(W, H, palette, [10]);
    expect(() => w.addFrame(new Uint8ClampedArray(4))).toThrow(/size/);
    w.addFrame(white);
    expect(() => w.addFrame(white)).toThrow(/more frames/);
  });

  test("finish refuses a GIF missing frames, rather than writing a short one", () => {
    const w = new GifWriter(W, H, palette, [10, 10]);
    w.addFrame(white);
    expect(() => w.finish()).toThrow(/1 of 2/);
  });
});

describe("buildPalette", () => {
  test("at most 255 colours, leaving a slot for transparency", () => {
    const noisy = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 2654435761) >>> 24;
    expect(buildPalette([noisy]).length).toBeLessThanOrEqual(255);
  });
  test("refuses no samples", () => {
    expect(() => buildPalette([])).toThrow(/no frames/);
  });
});
```
(`palette_offset` 13 = right after the 6-byte header and 7-byte screen descriptor, i.e. the global table. If `omggif` reports frames' palette differently, assert instead that the GIF has no Local Color Table flag by scanning image descriptors — keep the assertion's meaning: one global palette.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run transform/test/gif-encode.test.ts`
Expected: FAIL — cannot resolve `../src/gif-encode.js`.

- [ ] **Step 3: Implement**

```ts
// transform/src/gif-encode.ts
/**
 * The GIF encoder (STC-395): RGBA frames in, bytes out. Pure, so it is tested
 * in Node; the render window does the canvas readback.
 *
 * - ONE global palette, quantized from sample frames spread across the take
 *   (`buildPalette`). Per-frame palettes flicker, and screen content has few
 *   colours.
 * - No dithering: dither makes UI text and flat fills noisy.
 * - From frame 1 on, a pixel whose palette index is the same as the previous
 *   frame's is written as the reserved transparent index, with disposal 1
 *   ("leave in place"). On a screen recording most of the screen is still most
 *   of the time; this is the largest size saving available.
 * - Loops forever.
 */
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export type Palette = number[][];

/** Leaves index 255 free for the transparent slot. */
const MAX_COLOURS = 255;

export function buildPalette(samples: readonly Uint8ClampedArray[]): Palette {
  if (samples.length === 0) throw new Error("buildPalette: no frames to sample");
  const total = samples.reduce((n, s) => n + s.length, 0);
  const all = new Uint8ClampedArray(total);
  let at = 0;
  for (const s of samples) { all.set(s, at); at += s.length; }
  const p = quantize(all, MAX_COLOURS) as Palette;
  return p.length > 0 ? p : [[0, 0, 0]];
}

export class GifWriter {
  private readonly gif = GIFEncoder();
  private readonly full: Palette;
  private readonly transparentIndex: number;
  private prev: Uint8Array | null = null;
  private n = 0;

  constructor(readonly width: number, readonly height: number,
              private readonly palette: Palette, private readonly delaysCs: readonly number[]) {
    this.transparentIndex = palette.length;            // ≤ 255 by construction
    this.full = [...palette, [0, 0, 0]];
  }

  get frameCount(): number { return this.n; }

  addFrame(rgba: Uint8ClampedArray): void {
    if (rgba.length !== this.width * this.height * 4) {
      throw new Error(`GifWriter: frame size ${rgba.length} is not ${this.width}x${this.height} RGBA`);
    }
    if (this.n >= this.delaysCs.length) {
      throw new Error(`GifWriter: more frames than the ${this.delaysCs.length} delays given`);
    }
    // Index against the palette WITHOUT the transparent slot, so no real pixel lands on it.
    const index = applyPalette(rgba, this.palette) as Uint8Array;
    const out = index.slice();
    const first = this.prev === null;
    if (!first) {
      const prev = this.prev!;
      for (let i = 0; i < out.length; i++) if (index[i] === prev[i]) out[i] = this.transparentIndex;
    }
    this.gif.writeFrame(out, this.width, this.height, {
      // gifenc takes MILLISECONDS and writes round(ms / 10) centiseconds.
      delay: this.delaysCs[this.n]! * 10,
      ...(first ? { palette: this.full, repeat: 0 } : {}),
      ...(first ? {} : { transparent: true, transparentIndex: this.transparentIndex }),
      dispose: 1,
    });
    this.prev = index;
    this.n++;
  }

  finish(): Uint8Array {
    if (this.n !== this.delaysCs.length) {
      throw new Error(`GifWriter: ${this.n} of ${this.delaysCs.length} frames were written`);
    }
    this.gif.finish();
    return this.gif.bytes();
  }
}
```
If `gifenc` has no TypeScript types, add `transform/src/gifenc.d.ts` declaring the four exports used, typed as above (`quantize(rgba: Uint8Array|Uint8ClampedArray, maxColors: number, opts?: object): number[][]`, `applyPalette(rgba, palette: number[][], format?: string): Uint8Array`, `GIFEncoder(): { writeFrame(index: Uint8Array, w: number, h: number, opts?: object): void; finish(): void; bytes(): Uint8Array }`). Same for `omggif` in `transform/test/omggif.d.ts` if needed.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run transform/test/gif-encode.test.ts`
Expected: PASS. If "every frame matches" fails on the box frames, print the first differing pixel; the likeliest cause is gifenc writing frame-1+ with a local table or a non-1 disposal — fix the writeFrame options, not the test.

- [ ] **Step 5: Write the speed benchmark**

```js
// scripts/gif-bench.mjs
/**
 * STC-395's de-risk: how fast gifenc indexes and encodes frames at a GIF size,
 * in Node, before any UI exists. Synthetic "screen-like" frames: a static UI
 * with a moving box and a blinking caret, so the transparency diff does what
 * it does on a real take.
 *
 * Usage: node --import tsx scripts/gif-bench.mjs [width=960] [frames=150]
 */
import { buildPalette, GifWriter } from "../transform/src/gif-encode.ts";
import { gifDelaysCs } from "../transform/src/gif-options.ts";

const W = Number(process.argv[2] ?? 960), H = Math.round((W * 9) / 16 / 2) * 2;
const N = Number(process.argv[3] ?? 150);
function frame(k) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const band = (y >> 5) % 2 ? 236 : 248;               // alternating UI rows
    a[i] = band; a[i + 1] = band; a[i + 2] = x < 200 ? 230 : band; a[i + 3] = 255;
  }
  const bx = (k * 7) % (W - 80), by = (k * 3) % (H - 40);
  for (let y = by; y < by + 40; y++) for (let x = bx; x < bx + 80; x++) a.set([20, 110, 220, 255], (y * W + x) * 4);
  if (k % 8 < 4) for (let y = 100; y < 118; y++) a.set([0, 0, 0, 255], (y * W + 300) * 4);
  return a;
}
const t0 = performance.now();
const palette = buildPalette([0, N >> 2, N >> 1, (3 * N) >> 2].map(frame));
const t1 = performance.now();
const w = new GifWriter(W, H, palette, gifDelaysCs(N, 15));
for (let k = 0; k < N; k++) w.addFrame(frame(k));
const bytes = w.finish();
const t2 = performance.now();
console.log(`${W}x${H}, ${N} frames: palette ${(t1 - t0).toFixed(0)} ms, ` +
  `encode ${((t2 - t1) / N).toFixed(1)} ms/frame, ${(bytes.length / 1e6).toFixed(2)} MB`);
```
(Synthetic frame generation is inside the timed loop; it is cheap next to `applyPalette` but if the result is borderline, time it separately.)

- [ ] **Step 6: Run the benchmark — CHECKPOINT**

Run: `node --import tsx scripts/gif-bench.mjs 960 150` and `node --import tsx scripts/gif-bench.mjs 1280 150`
Budget: a 60 s take at 15 fps is 900 frames; encoding must add **≤ 60 ms/frame at 960 px** (≈ 1 min for a 1-minute take on top of decode). **Report both lines to Patrick before Task 3.** If over budget, stop: the options are a lower default width (640), a faster `applyPalette` (cache by RGB565 key), or a Web Worker — that is a design change, not an implementation detail.

- [ ] **Step 7: Commit**

```bash
git add transform/src/gif-encode.ts transform/test/gif-encode.test.ts scripts/gif-bench.mjs transform/src/gifenc.d.ts transform/test/omggif.d.ts 2>/dev/null; git add -u
git commit -m "STC-395: pure GIF encoder (global palette, transparency diff) and speed bench

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Extract the shared frame loop from `exportSession`

**Files:**
- Modify: `transform/src/export.ts` (the `ctx` setup at ~L124-130 and the frame loop at ~L313-363)
- Test: existing `transform/test/export*.test.ts`, plus gates

**Interfaces:**
- Produces (exported from `transform/src/export.ts`):
```ts
export interface FrameLoopStats { peakBuffered: number; decodedFrames: number; cameraDecodedFrames: number }
export interface FrameLoopOptions {
  /** First export frame (grid index) and how many export frames the window spans. */
  from: number; total: number;
  /** Export frames per yielded frame; 1 for an MP4, gifFrameStep(fps) for a GIF. */
  step?: number;
  /** willReadFrequently on the canvas — true when the consumer reads pixels back. */
  readback?: boolean;
  signal?: AbortSignal;
  stats?: FrameLoopStats;
}
export interface CompositedFrame {
  /** 0-based index of this yielded frame. */ i: number;
  /** Export-grid frame relative to `from` (i * step). */ k: number;
  tNs: number;
  ctx: OffscreenCanvasRenderingContext2D;
}
export function compositeFrames(session: LoadedSession, project: Project, opts: FrameLoopOptions): AsyncGenerator<CompositedFrame>
```

- [ ] **Step 1: Record the baseline hashes**

Run: `npm run gate:export -- fixtures/basic` and `npm run gate:identity` (use the same fixture arguments the CI workflow passes — read `.github/workflows/*.yml` for the exact invocations).
Save the printed hashes to the scratchpad. These must not change.

- [ ] **Step 2: Add the generator above `exportSession`**

```ts
/**
 * The ONE frame loop (STC-395): `render()` → frame selection → `composite()`
 * onto an OffscreenCanvas. `exportSession` (MP4) and `exportGif` iterate it;
 * a sink that copied this loop would carry its own frame-selection rule and
 * the two would drift silently — the non-negotiable is "sinks may not fork
 * the transform".
 *
 * Owns its decoders: they are closed in `finally`, which runs when the
 * consumer finishes, breaks out of its `for await`, or throws.
 */
export async function* compositeFrames(
  session: LoadedSession, project: Project, opts: FrameLoopOptions,
): AsyncGenerator<CompositedFrame> {
  const source = new ForwardFrameSource(session.video);
  const cameraSource = session.cameraVideo ? new ForwardFrameSource(session.cameraVideo) : null;
  const { width, height } = project.output;
  const step = opts.step ?? 1;
  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    alpha: false,
    willReadFrequently: opts.readback ?? false,
    colorSpace: canvasColorSpace(session.anchors),
  }) as OffscreenCanvasRenderingContext2D;
  try {
    for (let i = 0, k = 0; k < opts.total; i++, k += step) {
      if (opts.signal?.aborted) return;
      const tNs = exportFrameTimeNs(opts.from + k);
      const fs = render(project, session, tNs);
      // Frame selection is render()'s answer, not the sink's to re-derive.
      const idx = fs.frameIndex;
      const frame = idx === null ? null : await source.frameAt(idx);
      const cameraFrame = fs.pip && cameraSource ? await cameraSource.frameAt(fs.pip.frameIndex) : null;
      if (opts.stats) {
        opts.stats.peakBuffered = Math.max(opts.stats.peakBuffered,
          source.bufferedCount + (cameraSource?.bufferedCount ?? 0));
      }
      composite(ctx, frame, cameraFrame, fs, width, height);
      yield { i, k, tNs, ctx };
    }
  } finally {
    if (opts.stats) {
      opts.stats.decodedFrames = source.decodedCount;
      opts.stats.cameraDecodedFrames = cameraSource?.decodedCount ?? 0;
    }
    source.close();
    cameraSource?.close();
  }
}
```
Carry over the existing comments from the old loop (the STC-510 colour-space note, the frame-selection note, the forward-only-camera note) into this function verbatim rather than dropping them.

- [ ] **Step 3: Make `exportSession` consume it**

In `exportSession`:
1. Delete the `source`, `cameraSource` and `ctx` constructions at the top (they move into the generator). Keep `width/height/fps`, `wantHash`, `from`, `total`, `originNs`.
2. Add `const stats: FrameLoopStats = { peakBuffered: 0, decodedFrames: 0, cameraDecodedFrames: 0 };` and remove `let peakBuffered`.
3. Replace `for (let k = 0; k < total; k++) {` … through `composite(ctx, frame, cameraFrame, fs, width, height);` with:
```ts
    let produced = 0;
    for await (const { k, tNs, ctx } of compositeFrames(session, project, {
      from, total, readback: opts.softwareRaster ?? wantHash, signal: opts.signal, stats,
    })) {
      if (encoderError) throw encoderError;
      produced++;
```
   and leave the rest of the loop body (hash, `VideoFrame`, back-pressure, progress yield) exactly as it is — it already reads `k`, `tNs`, `ctx`.
4. After the loop: `cancelled = produced < total && opts.signal?.aborted === true;` (replacing the in-loop `cancelled = true; break;`).
5. Result fields: `peakBufferedFrames: stats.peakBuffered`, `decodedFrames: stats.decodedFrames`, `cameraDecodedFrames: stats.cameraDecodedFrames`.
6. In `finally`, delete `source.close(); cameraSource?.close();` (the generator owns them).

- [ ] **Step 4: Run unit tests and typecheck**

Run: `npm run typecheck && npx vitest run transform/`
Expected: PASS.

- [ ] **Step 5: Run the gates — the hashes must be identical to Step 1**

Run the same `gate:export` and `gate:identity` commands as Step 1.
Expected: PASS with byte-identical hashes. Any difference means the loop moved a pixel; find it before going on.

- [ ] **Step 6: Commit**

```bash
git add transform/src/export.ts
git commit -m "STC-395: one frame loop (compositeFrames) shared by every export sink

Pure extraction; gate:export and gate:identity hashes unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `exportGif`, and running it in real Chrome

**Files:**
- Create: `transform/src/gif-export.ts`, `harness/gif.html`, `harness/gif.ts`, `scripts/gif-one.mjs`
- Modify: `tsconfig.browser.json` if `harness/*.ts` or new DOM-using transform files must be listed (follow how `transform/src/export.ts` and `harness/export.ts` are listed)

**Interfaces:**
- Consumes: `compositeFrames`, `FrameLoopOptions` (Task 3); `exportWindow`, `availableFrames` (`trim.ts`); `GifSettings`, `gifFrameStep`, `gifFrameCount`, `gifDelaysCs`, `gifSize` (Task 1); `buildPalette`, `GifWriter` (Task 2)
- Produces:
```ts
export interface GifExportOptions {
  settings: GifSettings;
  /** done/total in "units" across both passes; the panel shows done/total as a percentage. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}
export interface GifExportResult { bytes: Uint8Array; frames: number; width: number; height: number; durationCs: number; elapsedMs: number }
export const PALETTE_SAMPLES = 8;
export async function exportGif(session: LoadedSession, project: Project, opts: GifExportOptions): Promise<GifExportResult>
```
- `window.exportGif(sessionUrl, projectRaw, settings) => Promise<{ base64: string; frames; width; height; durationCs; elapsedMs }>` on the harness page.

- [ ] **Step 1: Implement `exportGif`**

```ts
// transform/src/gif-export.ts
/**
 * The GIF sink (STC-395). Two passes over the ONE frame loop:
 *   1. palette: PALETTE_SAMPLES frames spread evenly across the window. The
 *      frame source is forward-only and decodes every frame on the way, so
 *      this pass costs a decode of the take; it composites only the samples.
 *   2. encode: every GIF frame, read back and handed to GifWriter.
 * Progress is one bar across both: pass 1 is the first quarter.
 *
 * The project is rendered at the GIF's own size (cursor and keycast drawn at
 * GIF scale, not shrunk afterwards); the trim applies exactly as for an MP4.
 */
import { compositeFrames } from "./export.js";
import { exportWindow, availableFrames } from "./trim.js";
import type { LoadedSession } from "./session.js";
import type { Project } from "./types.js";
import { type GifSettings, gifFrameStep, gifFrameCount, gifDelaysCs, gifSize } from "./gif-options.js";
import { buildPalette, GifWriter } from "./gif-encode.js";

export const PALETTE_SAMPLES = 8;
const PALETTE_SHARE = 0.25;

export async function exportGif(session: LoadedSession, project: Project,
                                opts: GifExportOptions): Promise<GifExportResult> {
  const t0 = performance.now();
  const size = gifSize(session.anchors.capture, opts.settings.maxWidth);
  const gp: Project = { ...project, output: { ...project.output, ...size } };
  const lastFrameNs = session.frames[session.frames.length - 1]!;
  const clip = exportWindow(gp, lastFrameNs);
  const available = availableFrames(lastFrameNs, gp.output.fps);
  const from = Math.max(0, Math.min(clip.fromFrame, available - 1));
  const total = Math.min(clip.maxFrames, available - from);
  const step = gifFrameStep(opts.settings.fps);
  const count = gifFrameCount(total, opts.settings.fps);
  if (count === 0) throw new Error("the take has no frames to make a GIF from");
  const read = (ctx: OffscreenCanvasRenderingContext2D) =>
    ctx.getImageData(0, 0, size.width, size.height).data;
  const units = 1000;
  const report = (f: number) => opts.onProgress?.(Math.min(units, Math.round(f * units)), units);

  // Pass 1: sample frames, evenly spaced over the GIF frames (always includes frame 0).
  const sampleStep = Math.max(1, Math.floor(count / PALETTE_SAMPLES)) * step;
  const samples: Uint8ClampedArray[] = [];
  for await (const { k, ctx } of compositeFrames(session, gp,
      { from, total, step: sampleStep, readback: true, signal: opts.signal })) {
    samples.push(read(ctx).slice());
    report((PALETTE_SHARE * (k + 1)) / total);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
  const delays = gifDelaysCs(count, opts.settings.fps);
  const writer = new GifWriter(size.width, size.height, buildPalette(samples), delays);
  samples.length = 0;

  // Pass 2: every GIF frame.
  for await (const { i, ctx } of compositeFrames(session, gp,
      { from, total, step, readback: true, signal: opts.signal })) {
    writer.addFrame(read(ctx));
    if (i % 5 === 0) { report(PALETTE_SHARE + ((1 - PALETTE_SHARE) * (i + 1)) / count); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
  const bytes = writer.finish();
  report(1);
  return { bytes, frames: count, ...size, durationCs: delays.reduce((a, b) => a + b, 0),
           elapsedMs: Math.round(performance.now() - t0) };
}
```
Note: pass 1's `step: sampleStep` makes the generator yield every `sampleStep` export frames but the forward-only source still decodes through every intermediate frame — that is the stated cost. Read `exportWindow`'s signature in `trim.ts` before writing this; if it already clamps against `available`, drop the duplicate clamp (mirror exactly what `exportSession` does with `clip`).

- [ ] **Step 2: Harness page**

`harness/gif.html`: copy `harness/export.html`, script `./gif.ts`. `harness/gif.ts`: copy `harness/export.ts`'s session-loading and `parseProject` path (the same functions, not a re-implementation), then expose:
```ts
window.exportGif = async (url: string, projectRaw: unknown, settings: GifSettings) => {
  const { session, project } = await load(url, projectRaw);     // the same helper export.ts uses
  const r = await exportGif(session, project, { settings });
  let s = ""; for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
  return { base64: btoa(s), frames: r.frames, width: r.width, height: r.height, durationCs: r.durationCs, elapsedMs: r.elapsedMs };
};
window.__gifReady = true;
```

- [ ] **Step 3: `scripts/gif-one.mjs`**

Copy `scripts/export-one.mjs`'s server + browser scaffold (port 5202, page `gif.html`, ready flag `__gifReady`). Arguments: `<sessionDir> [fps=15] [maxWidth=960] [--check]`. After `page.evaluate(window.exportGif(...))`:
```js
const bytes = Buffer.from(r.base64, "base64");
const dest = join(sessionDir, `gif-${fps}fps-${maxWidth}.gif`);
writeFileSync(dest, bytes);
console.log(`${r.frames} frames ${r.width}x${r.height}, ${(r.durationCs / 100).toFixed(2)} s, ` +
            `${(bytes.length / 1e6).toFixed(2)} MB in ${(r.elapsedMs / 1000).toFixed(1)} s → ${dest}`);
if (check) {
  const { GifReader } = await import("omggif");
  const g = new GifReader(bytes);
  const delays = Array.from({ length: g.numFrames() }, (_, i) => g.frameInfo(i).delay);
  const sum = delays.reduce((a, b) => a + b, 0);
  const fail = [];
  if (g.numFrames() !== r.frames) fail.push(`frames ${g.numFrames()} != ${r.frames}`);
  if (g.width !== r.width || g.height !== r.height) fail.push("size mismatch");
  if (g.width % 2 || g.height % 2) fail.push("odd dimension");
  if (sum !== r.durationCs) fail.push(`delays sum ${sum} != ${r.durationCs}`);
  // Review Focus 1: the GIF covers the trim window, not the take.
  const expectCs = Number(process.env.EXPECT_DURATION_CS ?? NaN);
  if (Number.isFinite(expectCs) && Math.abs(sum - expectCs) > Math.ceil(100 / fps)) fail.push(`duration ${sum} cs, expected ~${expectCs}`);
  if (fail.length) { console.error("CHECK FAILED: " + fail.join("; ")); out = 1; }
  else console.log("check ok");
}
```

- [ ] **Step 4: Run it on the fixture, untrimmed and trimmed**

Run: `node scripts/gif-one.mjs fixtures/basic 15 960 --check`
Expected: `check ok`, a `.gif` beside the fixture. Open it (Quick Look) and look: cursor present and moving.

Then copy `fixtures/basic` to the scratchpad, add `"trim": { "inNs": 1000000000, "outNs": 3000000000 }` (use the exact trim shape from the current project schema — read `schema/project-16.schema.json`), and run:
`EXPECT_DURATION_CS=200 node scripts/gif-one.mjs <scratch copy> 15 960 --check`
Expected: `check ok`.

- [ ] **Step 5: Run it on one real take and report**

Run: `node scripts/gif-one.mjs <newest real take in ~/Desktop/stc/raw> 15 960 --check`
Report the printed line (frames, size, MB, seconds) to Patrick alongside Task 2's bench. This is the end-to-end speed number the runbook will ask him to confirm at 4K.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add transform/src/gif-export.ts harness/gif.html harness/gif.ts scripts/gif-one.mjs tsconfig*.json
git commit -m "STC-395: exportGif sink over the shared frame loop; gif-one script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Where GIFs live — copy path, purge, saved name

**Files:**
- Modify: `app/src/recording-copy.ts`
- Test: `app/test/recording-copy.test.ts`

**Interfaces:**
- Consumes: `uniqueTakeName` (`app/src/takes.ts`)
- Produces:
  - `gifCopyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string` → `copiesRoot/<leaf>.gif`
  - `savedGifName(takeName: string, existingNames: readonly string[]): string` → `<takeName>.gif` or `<takeName>-2.gif` …
  - `purgeDecision` unchanged signature, now also handling `.gif` / `.gif.partial`

- [ ] **Step 1: Write the failing tests** (append to `app/test/recording-copy.test.ts`; extend its import list)

```ts
describe("STC-395: GIF copies", () => {
  test("a GIF copy sits beside the mp4 copy, named after its take", () => {
    expect(gifCopyPathFor({ STC_COPIES_DIR: "/c" }, "/t/2026-10-08_10-00-00"))
      .toBe("/c/2026-10-08_10-00-00.gif");
  });

  const now = 10 * COPY_MAX_AGE_MS;
  const root = "/c";
  test("the purge treats .gif exactly as .mp4", () => {
    const entries = [
      { name: "old.gif", mtimeMs: now - COPY_MAX_AGE_MS - 1 },
      { name: "new.gif", mtimeMs: now - 1000 },
      { name: "pasted.gif", mtimeMs: now - COPY_MAX_AGE_MS - 1 },
      { name: "stale.gif" + PARTIAL_SUFFIX, mtimeMs: now - PARTIAL_MAX_AGE_MS - 1 },
      { name: "fresh.gif" + PARTIAL_SUFFIX, mtimeMs: now - 1000 },
    ];
    expect(purgeDecision(entries, now, new Set([join(root, "pasted.gif")]), root).sort())
      .toEqual(["old.gif", "stale.gif" + PARTIAL_SUFFIX]);
  });
  test("an unreadable clipboard still deletes nothing, GIFs included", () => {
    expect(purgeDecision([{ name: "old.gif", mtimeMs: 0 }], now, undefined, root)).toEqual([]);
  });
});

describe("STC-395: a saved GIF's name (Review Focus 5)", () => {
  test("the take's name when free", () => {
    expect(savedGifName("2026-10-08_10-00-00", ["2026-10-08_10-00-00.mp4", "raw"])).toBe("2026-10-08_10-00-00.gif");
  });
  test("never overwrites: -2, -3 … like a take directory", () => {
    expect(savedGifName("t", ["t.gif"])).toBe("t-2.gif");
    expect(savedGifName("t", ["t.gif", "t-2.gif"])).toBe("t-3.gif");
  });
  test("a partial in flight counts as taken", () => {
    expect(savedGifName("t", ["t.gif.partial"])).toBe("t-2.gif");
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `npx vitest run app/test/recording-copy.test.ts`
Expected: FAIL — `gifCopyPathFor` / `savedGifName` not exported; `.gif` rows not purged.

- [ ] **Step 3: Implement** (in `app/src/recording-copy.ts`)

```ts
import { uniqueTakeName } from "./takes.js";

/** The kinds of file a copy can be (STC-395 added GIF). Both purge alike. */
const COPY_EXTENSIONS = [".mp4", ".gif"] as const;

/** STC-395: the GIF beside the mp4 copy; same name rule, same purge. */
export function gifCopyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string {
  return join(copiesRoot(env), `${basename(takeDir)}.gif`);
}

/**
 * The saved GIF's leaf in the save folder: the take's name, or `-2`, `-3` …
 * — the collision rule take directories already use (`uniqueTakeName`). A
 * `.partial` in flight counts as taken. Untagged and outside the library's
 * media types on purpose (spec §3).
 */
export function savedGifName(takeName: string, existingNames: readonly string[]): string {
  const stems = existingNames
    .filter((n) => n.endsWith(".gif") || n.endsWith(`.gif${PARTIAL_SUFFIX}`))
    .map((n) => n.slice(0, n.indexOf(".gif")));
  return `${uniqueTakeName(takeName, stems)}.gif`;
}
```
And in `purgeDecision`, replace the two `.mp4`-specific checks with:
```ts
    const ext = COPY_EXTENSIONS.find((x) => e.name.endsWith(x) || e.name.endsWith(`${x}${PARTIAL_SUFFIX}`));
    if (!ext) continue;
    if (e.name.endsWith(PARTIAL_SUFFIX)) {
      if (age > PARTIAL_MAX_AGE_MS) out.push(e.name);
      continue;
    }
```
Update the module doc's purge paragraph to say "copies (mp4 and, since STC-395, gif)". Check `uniqueTakeName`'s import does not drag Electron into this Electron-free module (`takes.ts` imports only node modules — confirm with a grep before relying on it).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/test/recording-copy.test.ts`
Expected: PASS (old and new).

- [ ] **Step 5: Commit**

```bash
git add app/src/recording-copy.ts app/test/recording-copy.test.ts
git commit -m "STC-395: GIF copy path, purge and saved-file name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GIF settings and the profile-sheet row

**Files:**
- Modify: `app/src/settings.ts`, `app/renderer/index.html`, `app/src/renderer.ts`
- Test: `app/test/settings.test.ts`, `app/test/settings-sheet.e2e.test.ts`

**Interfaces:**
- Consumes: `GifSettings`, `DEFAULT_GIF_SETTINGS`, `cleanGifSettings`, `GIF_FPS_OPTIONS`, `GIF_WIDTH_OPTIONS` (Task 1)
- Produces: `Settings.gif: GifSettings`; DOM `#giffps` and `#gifwidth` selects

- [ ] **Step 1: Write the failing unit tests** (append to `app/test/settings.test.ts`, following its existing temp-dir pattern)

```ts
describe("STC-395: GIF settings", () => {
  test("default 15 fps / 960 px on an untouched install", () => {
    expect(readSettings(freshDir()).gif).toEqual({ fps: 15, maxWidth: 960 });
  });
  test("round-trips a chosen value", () => {
    const d = freshDir();
    writeSettings(d, { gif: { fps: 30, maxWidth: "original" } });
    expect(readSettings(d).gif).toEqual({ fps: 30, maxWidth: "original" });
  });
  test("an invalid stored value falls back per field", () => {
    const d = freshDir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ gif: { fps: 24, maxWidth: 640 } }));
    expect(readSettings(d).gif).toEqual({ fps: 15, maxWidth: 640 });
  });
  test("changing one field keeps the other", () => {
    const d = freshDir();
    writeSettings(d, { gif: { fps: 10, maxWidth: 480 } });
    writeSettings(d, { gif: { ...readSettings(d).gif, fps: 20 } });
    expect(readSettings(d).gif).toEqual({ fps: 20, maxWidth: 480 });
  });
});
```
(`freshDir` = whatever helper `settings.test.ts` already uses for a temp `userData`; reuse it.)

- [ ] **Step 2: Run to make sure they fail**

Run: `npx vitest run app/test/settings.test.ts`
Expected: FAIL — `gif` undefined.

- [ ] **Step 3: Implement in `settings.ts`**

- `import { type GifSettings, DEFAULT_GIF_SETTINGS, cleanGifSettings } from "@transform/gif-options";` — use the same import style `settings.ts` already uses for `transform/src` modules (it imports `DEFAULT_PIP_STYLE`; mirror that path).
- `Settings` interface: add
  ```ts
  /** STC-395: what a GIF is converted with. Read when a conversion starts. */
  gif: GifSettings;
  ```
- `DEFAULT_SETTINGS`: `gif: { ...DEFAULT_GIF_SETTINGS },`
- `readSettings`: `gif: cleanGifSettings(doc.gif),`
- `writeSettings`: in `merged`, `gif: { ...current.gif, ...(patch.gif ?? {}) },`; in `clean`, `gif: cleanGifSettings(merged.gif),`

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run app/test/settings.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: The profile-sheet row**

In `app/renderer/index.html`, directly after the Countdown block's `</div>` (the `.stillrow` holding `#countdownms`):
```html
    <!-- STC-395: what a recording's GIF is converted with. The options are
         built from gif-options.ts's lists, like the countdown's, so the list
         and the validator cannot drift. -->
    <div class="subhead">GIF</div>
    <div class="stillrow">
      <label>Frame rate <select id="giffps"></select></label>
      <label>Max width <select id="gifwidth"></select></label>
    </div>
```
In `app/src/renderer.ts`, next to `countdownSel`:
```ts
const gifFpsSel = $("giffps") as HTMLSelectElement;
const gifWidthSel = $("gifwidth") as HTMLSelectElement;
for (const fps of GIF_FPS_OPTIONS) gifFpsSel.add(new Option(`${fps} fps`, String(fps)));
for (const w of GIF_WIDTH_OPTIONS) gifWidthSel.add(new Option(w === "original" ? "Original" : `${w} px`, String(w)));
```
Where the sheet's controls are filled from settings (the function that sets `countdownSel.value`):
```ts
  gifFpsSel.value = String(settings.gif.fps);
  gifWidthSel.value = String(settings.gif.maxWidth);
```
Listeners (read-merge-write, the `patchThumbnail` pattern):
```ts
async function patchGif(patch: Partial<AppSettings["gif"]>): Promise<void> {
  const current = (await recorder.getSettings()).gif;
  await recorder.setSettings({ gif: { ...current, ...patch } });
}
gifFpsSel.addEventListener("change", () => void patchGif({ fps: Number(gifFpsSel.value) as AppSettings["gif"]["fps"] }));
gifWidthSel.addEventListener("change", () => {
  const v = gifWidthSel.value;
  void patchGif({ maxWidth: (v === "original" ? "original" : Number(v)) as AppSettings["gif"]["maxWidth"] });
});
```
Check `renderer.ts` is typechecked by `tsconfig.browser.json`: importing `gif-options.ts` must not reach node-only code (it imports `time.ts`, `output-size.ts`, `spaces.ts` — confirm none import node modules).

- [ ] **Step 6: Extend the settings-sheet e2e**

In `app/test/settings-sheet.e2e.test.ts`, add one test using that file's own launch/open-sheet helpers:
```ts
test("STC-395: the GIF row persists frame rate and max width", async () => {
  // open the sheet the way the other tests in this file do
  await win.selectOption("#giffps", "30");
  await win.selectOption("#gifwidth", "original");
  await expect.poll(() => JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).gif,
    { timeout: 15_000 }).toEqual({ fps: 30, maxWidth: "original" });
});
```
Update that file's timeout-budget comment if it has one (`_timeout-budget.ts` reads it).

- [ ] **Step 7: Typecheck, unit tests, commit** (the e2e runs in Task 11's VM pass)

```bash
npm run typecheck && npx vitest run app/test/settings.test.ts
git add app/src/settings.ts app/renderer/index.html app/src/renderer.ts app/test/settings.test.ts app/test/settings-sheet.e2e.test.ts
git commit -m "STC-395: GIF frame rate and max width preferences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The panel's GIF states — pure reducer and `offersFormat`

**Files:**
- Create: `app/src/gif-panel.ts`
- Modify: `app/src/panel-actions.ts`
- Test: `app/test/gif-panel.test.ts`, `app/test/panel-actions.test.ts`

**Interfaces:**
- Produces (`gif-panel.ts`, no DOM, no Electron, no node):
```ts
export type OutputFormat = "video" | "gif";
export type GifState =
  | { kind: "video" }
  | { kind: "converting"; permille: number }
  | { kind: "ready"; bytes: number }
  | { kind: "failed"; detail: string };
export type GifEvent =
  | { kind: "pick"; format: OutputFormat }
  | { kind: "progress"; done: number; total: number }
  | { kind: "done"; bytes: number }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };
export const GIF_LARGE_BYTES = 10_000_000;
export const INITIAL_GIF_STATE: GifState;               // { kind: "video" }
export function formatOf(s: GifState): OutputFormat;
export function reduceGif(s: GifState, e: GifEvent): GifState;
/** What a pick must make main do: start (or reuse) a conversion, cancel one, or nothing. */
export function effectOfPick(s: GifState, format: OutputFormat): "start" | "cancel" | "none";
export function formatBytes(n: number): string;          // decimal, Finder-style: "3.4 MB", "820 KB"
export function gifLabel(s: GifState): { text: string; warn: boolean } | null;
export function copySaveEnabled(s: GifState): boolean;
```
- Produces (`panel-actions.ts`): `export function offersFormat(take: PanelTake): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/gif-panel.test.ts
import { describe, test, expect } from "vitest";
import {
  INITIAL_GIF_STATE, reduceGif, effectOfPick, formatOf, gifLabel, copySaveEnabled,
  formatBytes, GIF_LARGE_BYTES, type GifState,
} from "../src/gif-panel.js";

const converting = (permille = 0): GifState => ({ kind: "converting", permille });

describe("the switch's states (spec §2's table)", () => {
  test("every panel starts on Video", () => {
    expect(INITIAL_GIF_STATE).toEqual({ kind: "video" });
    expect(formatOf(INITIAL_GIF_STATE)).toBe("video");
  });
  test("Video → GIF starts converting at 0", () => {
    expect(reduceGif(INITIAL_GIF_STATE, { kind: "pick", format: "gif" })).toEqual(converting(0));
    expect(effectOfPick(INITIAL_GIF_STATE, "gif")).toBe("start");
  });
  test("progress moves the bar, in permille, clamped", () => {
    expect(reduceGif(converting(), { kind: "progress", done: 420, total: 1000 })).toEqual(converting(420));
    expect(reduceGif(converting(), { kind: "progress", done: 5, total: 0 })).toEqual(converting(0));
    expect(reduceGif(converting(), { kind: "progress", done: 2000, total: 1000 })).toEqual(converting(1000));
  });
  test("done → ready with the real size", () => {
    expect(reduceGif(converting(900), { kind: "done", bytes: 3_400_000 })).toEqual({ kind: "ready", bytes: 3_400_000 });
  });
  test("a failure is shown, and Video is still one pick away", () => {
    const f = reduceGif(converting(), { kind: "failed", detail: "boom" });
    expect(f).toEqual({ kind: "failed", detail: "boom" });
    expect(reduceGif(f, { kind: "pick", format: "video" })).toEqual({ kind: "video" });
  });
  test("GIF → Video while converting cancels; while ready or failed there is nothing to cancel", () => {
    expect(effectOfPick(converting(300), "video")).toBe("cancel");
    expect(effectOfPick({ kind: "ready", bytes: 1 }, "video")).toBe("none");
    expect(effectOfPick({ kind: "failed", detail: "x" }, "video")).toBe("none");
  });
  test("picking the format already showing does nothing", () => {
    expect(effectOfPick(INITIAL_GIF_STATE, "video")).toBe("none");
    expect(effectOfPick(converting(), "gif")).toBe("none");
    expect(reduceGif(converting(10), { kind: "pick", format: "gif" })).toEqual(converting(10));
  });
  test("a failed GIF picked again retries", () => {
    expect(effectOfPick({ kind: "failed", detail: "x" }, "gif")).toBe("start");
  });
  test("late events after switching back to Video are ignored (Review Focus 4)", () => {
    const v: GifState = { kind: "video" };
    expect(reduceGif(v, { kind: "progress", done: 1, total: 2 })).toEqual(v);
    expect(reduceGif(v, { kind: "done", bytes: 9 })).toEqual(v);
    expect(reduceGif(v, { kind: "failed", detail: "late" })).toEqual(v);
  });
  test("cancelled while converting returns to Video", () => {
    expect(reduceGif(converting(5), { kind: "cancelled" })).toEqual({ kind: "video" });
  });
});

describe("what the panel shows", () => {
  test("Video shows nothing extra", () => { expect(gifLabel({ kind: "video" })).toBe(null); });
  test("converting shows a percentage", () => {
    expect(gifLabel(converting(423))).toEqual({ text: "GIF 42%", warn: false });
  });
  test("ready shows the size; the warning starts strictly above 10 MB", () => {
    expect(gifLabel({ kind: "ready", bytes: 3_400_000 })).toEqual({ text: "GIF · 3.4 MB", warn: false });
    expect(gifLabel({ kind: "ready", bytes: GIF_LARGE_BYTES })).toEqual({ text: "GIF · 10 MB", warn: false });
    expect(gifLabel({ kind: "ready", bytes: GIF_LARGE_BYTES + 1 }))
      .toEqual({ text: "GIF · 10 MB — large for a GIF; Video is smaller", warn: true });
  });
  test("failed names the reason", () => {
    expect(gifLabel({ kind: "failed", detail: "no frames" })).toEqual({ text: "GIF failed — no frames", warn: true });
  });
  test("Copy/Save: enabled for video, converting (they wait) and ready; disabled when failed", () => {
    expect(copySaveEnabled({ kind: "video" })).toBe(true);
    expect(copySaveEnabled(converting())).toBe(true);
    expect(copySaveEnabled({ kind: "ready", bytes: 1 })).toBe(true);
    expect(copySaveEnabled({ kind: "failed", detail: "x" })).toBe(false);
  });
  test("sizes read the way Finder reads them (decimal)", () => {
    expect(formatBytes(820_000)).toBe("820 KB");
    expect(formatBytes(3_400_000)).toBe("3.4 MB");
    expect(formatBytes(14_049_000)).toBe("14 MB");
  });
});
```
Append to `app/test/panel-actions.test.ts`:
```ts
describe("STC-395: offersFormat", () => {
  test("only a fresh recording gets the GIF / Video switch", () => {
    expect(offersFormat({ kind: "recording", origin: "fresh" })).toBe(true);
    expect(offersFormat({ kind: "recording", origin: "library" })).toBe(false);
    expect(offersFormat({ kind: "shot", origin: "fresh" })).toBe(false);
    expect(offersFormat({ kind: "shot", origin: "library" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

Run: `npx vitest run app/test/gif-panel.test.ts app/test/panel-actions.test.ts`
Expected: FAIL — module / export missing.

- [ ] **Step 3: Implement `app/src/gif-panel.ts`**

```ts
/**
 * The panel's GIF / Video switch, decided without a DOM (STC-395). The
 * renderer draws `gifLabel`, enables Copy/Save by `copySaveEnabled`, and asks
 * main to do whatever `effectOfPick` says; every sentence the user sees about
 * a GIF is here, with the one threshold that decides the warning.
 *
 * Events that arrive after the switch went back to Video (a progress tick or a
 * `done` racing a cancel) are ignored: the reducer only listens to a
 * conversion while one is showing.
 */
export type OutputFormat = "video" | "gif";
export type GifState =
  | { kind: "video" }
  | { kind: "converting"; permille: number }
  | { kind: "ready"; bytes: number }
  | { kind: "failed"; detail: string };
export type GifEvent =
  | { kind: "pick"; format: OutputFormat }
  | { kind: "progress"; done: number; total: number }
  | { kind: "done"; bytes: number }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/** Decimal, so the number matches what Finder shows. Slack/GitHub's practical inline ceiling. */
export const GIF_LARGE_BYTES = 10_000_000;
export const INITIAL_GIF_STATE: GifState = { kind: "video" };

export function formatOf(s: GifState): OutputFormat { return s.kind === "video" ? "video" : "gif"; }

export function effectOfPick(s: GifState, format: OutputFormat): "start" | "cancel" | "none" {
  if (format === "gif") return s.kind === "video" || s.kind === "failed" ? "start" : "none";
  return s.kind === "converting" ? "cancel" : "none";
}

export function reduceGif(s: GifState, e: GifEvent): GifState {
  switch (e.kind) {
    case "pick":
      if (e.format === "video") return { kind: "video" };
      return effectOfPick(s, "gif") === "start" ? { kind: "converting", permille: 0 } : s;
    case "progress":
      if (s.kind !== "converting") return s;
      return { kind: "converting",
               permille: e.total > 0 ? Math.max(0, Math.min(1000, Math.round((e.done / e.total) * 1000))) : 0 };
    case "done":
      return s.kind === "converting" ? { kind: "ready", bytes: e.bytes } : s;
    case "failed":
      return s.kind === "converting" ? { kind: "failed", detail: e.detail } : s;
    case "cancelled":
      return s.kind === "converting" ? { kind: "video" } : s;
  }
}

export function formatBytes(n: number): string {
  if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))} KB`;
  const mb = n / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

export function gifLabel(s: GifState): { text: string; warn: boolean } | null {
  switch (s.kind) {
    case "video": return null;
    case "converting": return { text: `GIF ${Math.floor(s.permille / 10)}%`, warn: false };
    case "ready":
      return s.bytes > GIF_LARGE_BYTES
        ? { text: `GIF · ${formatBytes(s.bytes)} — large for a GIF; Video is smaller`, warn: true }
        : { text: `GIF · ${formatBytes(s.bytes)}`, warn: false };
    case "failed": return { text: `GIF failed — ${s.detail}`, warn: true };
  }
}

export function copySaveEnabled(s: GifState): boolean { return s.kind !== "failed"; }
```
In `panel-actions.ts`, after `lockedWhileCopying`:
```ts
/**
 * Whether the panel shows the GIF / Video switch (STC-395). Only a fresh
 * recording: that is the only take with a recording Copy (`panel:copyRecording`
 * refuses anything outside the temp root), and a library re-open has no Save.
 */
export function offersFormat(take: PanelTake): boolean {
  return take.kind === "recording" && take.origin === "fresh";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/test/gif-panel.test.ts app/test/panel-actions.test.ts && npm run typecheck`
Expected: PASS. `gif-panel.ts` is imported by the renderer — add it to `tsconfig.browser.json`'s list if renderer-imported pure modules are listed there (follow `panel-actions.ts`).

- [ ] **Step 5: Commit**

```bash
git add app/src/gif-panel.ts app/src/panel-actions.ts app/test/gif-panel.test.ts app/test/panel-actions.test.ts tsconfig*.json
git commit -m "STC-395: the GIF / Video switch's states, decided without a DOM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Main — the GIF job, its cache, and Copy/Save in GIF mode

**Files:**
- Create: `app/src/gif-cache.ts`, `app/test/gif-cache.test.ts`
- Modify: `app/src/copy-render.ts`, `app/src/copy-render-window.ts`, `app/src/main.ts` (`panel:copyRecording` ~L3084, `panel:save` ~L3134, `toast:action` ~L136, new handlers), `app/src/thumbnail-preload.ts`, `app/src/toast-message.ts`

**Interfaces:**
- Consumes: `exportGif`, `GifExportResult` (Task 4); `GifSettings` (Task 1); `gifCopyPathFor`, `savedGifName` (Task 5); `Settings.gif` (Task 6); `OutputFormat` (Task 7)
- Produces:
  - `CopyJobOptions.format?: "mp4" | "gif"` and `CopyJobOptions.gif?: GifSettings`; `copyRenderFormat(takeDir): "mp4" | "gif" | undefined`
  - `gif-cache.ts`: `class GifCache { lookup(takeDir, settings): GifEntry | undefined; begin(takeDir): number; settle(takeDir, gen, entry: GifEntry): boolean; forget(takeDir): void }`, `interface GifEntry { path: string; settings: GifSettings; bytes: number }`
  - IPC `panel:gif(dir) → { ok: true; bytes: number } | { ok: false; cancelled?: true; detail?: string }`
  - IPC `panel:cancelGif(dir) → void`
  - IPC `panel:copyRecording(dir, format?: OutputFormat)`; `panel:save(dir, format?: OutputFormat) → { ok: true; dir: string; gifError?: string } | { ok: false; detail: string }`
  - progress continues on the existing `thumb:copyProgress` channel
  - toast action id `"reveal-saved-gif"`

- [ ] **Step 1: Failing test for the cache's rules**

```ts
// app/test/gif-cache.test.ts
import { describe, test, expect } from "vitest";
import { GifCache } from "../src/gif-cache.js";

const s15 = { fps: 15, maxWidth: 960 } as const;
const s30 = { fps: 30, maxWidth: 960 } as const;

describe("GifCache (STC-395)", () => {
  test("a finished GIF is reused only for the settings it was made with", () => {
    const c = new GifCache();
    const g = c.begin("/t/a");
    expect(c.settle("/t/a", g, { path: "/c/a.gif", settings: s15, bytes: 10 })).toBe(true);
    expect(c.lookup("/t/a", s15)?.path).toBe("/c/a.gif");
    expect(c.lookup("/t/a", s30)).toBeUndefined();
  });
  test("a job begun before a newer one cannot settle over it (Review Focus 4)", () => {
    const c = new GifCache();
    const old = c.begin("/t/a");
    const neu = c.begin("/t/a");
    expect(c.settle("/t/a", old, { path: "/c/a.gif", settings: s15, bytes: 1 })).toBe(false);
    expect(c.lookup("/t/a", s15)).toBeUndefined();
    expect(c.settle("/t/a", neu, { path: "/c/a.gif", settings: s30, bytes: 2 })).toBe(true);
    expect(c.lookup("/t/a", s30)?.bytes).toBe(2);
  });
  test("forget drops the record (Trash, dismiss)", () => {
    const c = new GifCache();
    c.settle("/t/a", c.begin("/t/a"), { path: "/c/a.gif", settings: s15, bytes: 1 });
    c.forget("/t/a");
    expect(c.lookup("/t/a", s15)).toBeUndefined();
  });
  test("beginning a job invalidates the old record (the file is about to be overwritten)", () => {
    const c = new GifCache();
    c.settle("/t/a", c.begin("/t/a"), { path: "/c/a.gif", settings: s15, bytes: 1 });
    c.begin("/t/a");
    expect(c.lookup("/t/a", s15)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to make sure it fails, then implement**

Run: `npx vitest run app/test/gif-cache.test.ts` → FAIL (module missing).

```ts
// app/src/gif-cache.ts
/**
 * Main's record of which GIF sits in `copiesRoot` for each take, and what it
 * was made WITH (STC-395). The file's name carries no settings (it is what a
 * paste shows), so this is what decides reuse. In memory on purpose: a fresh
 * panel does not outlive the app, and after a restart a flip just re-renders.
 *
 * Every job takes a generation; only the newest job for a take may record its
 * result, so a cancelled or superseded job finishing late cannot claim the file.
 */
import type { GifSettings } from "@transform/gif-options";

export interface GifEntry { path: string; settings: GifSettings; bytes: number }

export class GifCache {
  private readonly entries = new Map<string, GifEntry>();
  private readonly gens = new Map<string, number>();

  lookup(takeDir: string, settings: GifSettings): GifEntry | undefined {
    const e = this.entries.get(takeDir);
    return e && e.settings.fps === settings.fps && e.settings.maxWidth === settings.maxWidth ? e : undefined;
  }
  begin(takeDir: string): number {
    this.entries.delete(takeDir);
    const g = (this.gens.get(takeDir) ?? 0) + 1;
    this.gens.set(takeDir, g);
    return g;
  }
  settle(takeDir: string, gen: number, entry: GifEntry): boolean {
    if (this.gens.get(takeDir) !== gen) return false;
    this.entries.set(takeDir, entry);
    return true;
  }
  forget(takeDir: string): void {
    this.entries.delete(takeDir);
    this.gens.set(takeDir, (this.gens.get(takeDir) ?? 0) + 1);
  }
}
```
Run again → PASS. Use the same `@transform/...` import form that `app/src/settings.ts` uses.

- [ ] **Step 3: The render window learns the format**

`copy-render-window.ts`:
- `CopyJobOptions`: add `format?: "mp4" | "gif"; gif?: GifSettings;`
- `Job`: nothing new (format is on `opts`).
- `win.loadFile(...)`: build the query from both seams:
  ```ts
  const query: Record<string, string> = {};
  if (opts.delayMs) query.delayMs = String(opts.delayMs);
  if (opts.format === "gif" && opts.gif) {
    query.format = "gif"; query.fps = String(opts.gif.fps); query.maxWidth = String(opts.gif.maxWidth);
  }
  win.loadFile(join(opts.rendererDir, "copy-render.html"), Object.keys(query).length ? { query } : undefined)
  ```
- Add: `export function copyRenderFormat(takeDir: string): "mp4" | "gif" | undefined { const j = jobs.get(takeDir); return j?.state === "live" ? (j.opts.format ?? "mp4") : undefined; }`
- `startCopyRender`'s "a duplicate gets the running job's outcome" must not hand a GIF caller an mp4 job's outcome: at the top, `if (existing?.state === "live" && (existing.opts.format ?? "mp4") !== (opts.format ?? "mp4")) return Promise.resolve({ ok: false, detail: "another render of this take is running" });` (the panel prevents this; main enforces it too).

`copy-render.ts`, after loading the take:
```ts
const params = new URLSearchParams(location.search);
// … inside the try, after loadTake:
    if (params.get("format") === "gif") {
      const settings = cleanGifSettings({
        fps: Number(params.get("fps")),
        maxWidth: params.get("maxWidth") === "original" ? "original" : Number(params.get("maxWidth")),
      });
      let last = 0;
      const r = await exportGif(session, project, {
        settings,
        onProgress: (done, total) => {
          const now = performance.now();
          if (now - last < PROGRESS_EVERY_MS && done < total) return;
          last = now; io.progress(done, total);
        },
      });
      await io.write(r.bytes);
      return;
    }
```
(GIFs carry no capture id — spec §3 — so `captureId` is not read on this path. Hoist `params` and reuse it for `delayMs`.)

- [ ] **Step 4: Main — `ensureGif`, `panel:gif`, `panel:cancelGif`**

In `main.ts`, beside `panel:copyRecording`:
```ts
/** STC-395: the GIF cached per fresh take, and what it was made with. */
const gifCache = new GifCache();

type GifOutcome = { ok: true; path: string; bytes: number; rendered: boolean }
                | { ok: false; cancelled?: true; detail?: string };

/**
 * Start (or reuse) this take's GIF and resolve when it is ready. Settings are
 * read HERE, once, at the start of a conversion (spec §3): a change made while
 * a GIF is ready does not touch it. Progress goes out on `thumb:copyProgress`,
 * the channel the panel already listens on.
 */
async function ensureGif(dir: string, panel: Electron.WebContents): Promise<GifOutcome> {
  const settings = readSettings(app.getPath("userData")).gif;
  const hit = gifCache.lookup(dir, settings);
  if (hit && existsSync(hit.path)) return { ok: true, path: hit.path, bytes: hit.bytes, rendered: false };
  if (copyRenderFormat(dir) === "mp4") return { ok: false, detail: "a video copy is still rendering" };
  const out = gifCopyPathFor(process.env, dir);
  const gen = copyRenderFormat(dir) === "gif" ? undefined : gifCache.begin(dir);
  const r = await startCopyRender({
    takeDir: dir, outPath: out, dist: here, rendererDir: join(here, "..", "renderer"),
    format: "gif", gif: settings,
    delayMs: Number(process.env.STC_COPY_RENDER_DELAY_MS) || undefined,
    grant: (id, d) => openTakes.set(id, d),
    revoke: (id) => openTakes.delete(id),
    onProgress: (done, total) => { if (!panel.isDestroyed()) panel.send("thumb:copyProgress", done, total); },
  });
  if (!r.ok) return r.cancelled ? { ok: false, cancelled: true } : { ok: false, detail: r.detail };
  const bytes = statSync(out).size;
  if (gen !== undefined) gifCache.settle(dir, gen, { path: out, settings, bytes });
  return { ok: true, path: out, bytes, rendered: gen !== undefined };
}

ipcMain.handle("panel:gif", async (e, dir: string) => {
  if (typeof dir !== "string" || !insideTempTakesRoot(process.env, dir) || takeFor(dir)?.kind !== "recording") {
    return { ok: false, detail: "not a recording on a panel" };
  }
  const r = await ensureGif(dir, e.sender);
  return r.ok ? { ok: true, bytes: r.bytes } : r;
});

ipcMain.handle("panel:cancelGif", async (_e, dir: string) => {
  if (typeof dir !== "string" || copyRenderFormat(dir) !== "gif") return;
  gifCache.forget(dir);
  await cancelCopyRender(dir);
});
```
A second caller while a GIF job is live (Copy pressed mid-conversion) reaches `startCopyRender`'s duplicate path and gets the running job's outcome — that is "Copy/Save wait". `gen` is undefined for that joiner so it does not settle the cache twice; the first caller does. Import `statSync` if not already imported.

Also, wherever `panel:trash` and `panel:dismiss` call `cancelCopyRender(dir)`, add `gifCache.forget(dir);` beside it.

- [ ] **Step 5: Copy in GIF mode**

Change `panel:copyRecording`'s signature to `async (e, dir: string, format: unknown) =>` and, after the existing validation and `helper` capture, branch the render part:
```ts
  const wantGif = format === "gif";
  let out: string;
  let rendered = false;
  let changeBefore: number | undefined;
  if (wantGif) {
    changeBefore = await readChangeCount();
    const g = await ensureGif(dir, e.sender);
    if (!g.ok) return g.cancelled ? { ok: false, cancelled: true } : { ok: false, detail: g.detail };
    out = g.path; rendered = g.rendered;
  } else {
    out = copyPathFor(process.env, dir);
    // … the existing `if (!existsSync(out)) { … startCopyRender … }` block, unchanged …
  }
```
The rest (gone-panel check, changeCount comparison, `helper.copyFile(out)`) is shared and unchanged. Move `readChangeCount`'s declaration above the branch.

- [ ] **Step 6: Save in GIF mode**

Change `panel:save` to `async (e, dir: string, format: unknown) =>`. Before the promote:
```ts
    let gif: { path: string } | undefined;
    if (format === "gif") {
      if (!insideTempTakesRoot(process.env, dir)) return { ok: false, detail: "a GIF is saved only from a fresh take" };
      const g = await ensureGif(dir, e.sender);
      if (!g.ok) return { ok: false, detail: g.cancelled ? "the GIF was cancelled" : `the GIF could not be made: ${g.detail}` };
      gif = { path: g.path };
    }
```
Keep the existing `lockedWhileCopying("save") && copyRenderInFlight(dir)` refusal BEFORE this block only for `format !== "gif"` (in GIF mode the wait is `ensureGif` itself; an mp4 render in flight is refused by `ensureGif`). After `promoteIntoLibrary`:
```ts
    let gifError: string | undefined;
    if (gif) {
      try {
        const root = takesRoot(process.env, saveFolder);
        const name = savedGifName(basename(promoted), await readdir(root).catch(() => []));
        const dest = join(root, name);
        await copyFile(gif.path, dest + PARTIAL_SUFFIX);
        await rename(dest + PARTIAL_SUFFIX, dest);
        lastSavedGif = dest;
        showNotice({ title: "Saved GIF", body: name, action: { id: "reveal-saved-gif", label: "Show in Finder" } });
      } catch (err: any) {
        gifError = String(err?.message ?? err);
        showNotice({ title: "Saved the take", body: `The GIF couldn't be written: ${gifError}` });
      }
    }
    dismissThumbnail(dir);
    return { ok: true, dir: promoted, ...(gifError ? { gifError } : {}) };
```
`let lastSavedGif: string | undefined;` beside `lastStillFile`. Use `fs/promises` `copyFile`, `rename`, `readdir` (import what is missing). `showNotice` is the existing main-side message-toast function (`main.ts` ~L145); confirm its name and that it accepts a `ToastMessage`.

- [ ] **Step 7: The reveal toast action**

In `toast-message.ts`:
```ts
export type ToastActionId = "open-screen-recording-settings" | "open-input-monitoring-settings" | "reveal-saved-gif";
/** Actions that open a System Settings pane. "reveal-saved-gif" is main's, not a URL. */
export const TOAST_ACTION_URLS: Partial<Record<ToastActionId, string>> = { /* unchanged two entries */ };
```
and make `isToastActionId` accept the new id (read its body: if it checks `id in TOAST_ACTION_URLS`, change it to check a `TOAST_ACTION_IDS` array listing all three). Fix `permissions.ts`'s two reads to non-null (`TOAST_ACTION_URLS["open-screen-recording-settings"]!`). In `main.ts`'s `toast:action`:
```ts
  if (id === "reveal-saved-gif") { if (lastSavedGif) shell.showItemInFolder(lastSavedGif); hideToast(); return; }
  const url = TOAST_ACTION_URLS[id];
  if (url) void shell.openExternal(url);
  hideToast();
```
Run `npx vitest run app/test/toast*` — update any test that enumerates action ids.

- [ ] **Step 8: Preload**

`thumbnail-preload.ts`:
```ts
  copyRecording: (dir: string, format?: "video" | "gif") => ipcRenderer.invoke("panel:copyRecording", dir, format),
  // STC-395: start-or-reuse the take's GIF; resolves when ready. Progress on onCopyProgress.
  gif: (dir: string) => ipcRenderer.invoke("panel:gif", dir),
  cancelGif: (dir: string) => ipcRenderer.invoke("panel:cancelGif", dir),
  save: (dir: string, format?: "video" | "gif") => ipcRenderer.invoke("panel:save", dir, format),
```
Update `thumbnail-renderer.ts`'s `declare global` `thumb` type to match.

- [ ] **Step 9: Typecheck, unit tests, commit**

Run: `npm run typecheck && npm test`
Expected: PASS (e2e not included in `npm test`; Task 11).

```bash
git add app/src/gif-cache.ts app/test/gif-cache.test.ts app/src/copy-render.ts app/src/copy-render-window.ts app/src/main.ts app/src/thumbnail-preload.ts app/src/toast-message.ts app/src/permissions.ts app/src/thumbnail-renderer.ts
git commit -m "STC-395: main renders, caches, copies and saves a take's GIF

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The switch on the panel

**Files:**
- Modify: `app/renderer/thumbnail.html`, `app/src/thumbnail-renderer.ts`

**Interfaces:**
- Consumes: `offersFormat` (Task 7), `INITIAL_GIF_STATE`, `reduceGif`, `effectOfPick`, `formatOf`, `gifLabel`, `copySaveEnabled`, `GifState` (Task 7); `window.thumb.gif`, `.cancelGif`, `.copyRecording(dir, format)`, `.save(dir, format)` (Task 8)
- Produces: DOM `#format` (a `role="radiogroup"` with `button[data-format="video"]` and `button[data-format="gif"]`, `aria-checked`), `#giflabel` (with class `warn` when warning). E2E ids in Task 11 depend on these.

- [ ] **Step 1: Markup and style**

In `thumbnail.html`, directly above `<progress id="copyprogress" …>`:
```html
      <!-- STC-395: a fresh recording's output format. Never closes the panel. -->
      <div id="format" role="radiogroup" aria-label="Output format" hidden>
        <button type="button" role="radio" data-format="video" aria-checked="true">Video</button>
        <button type="button" role="radio" data-format="gif" aria-checked="false">GIF</button>
      </div>
      <div id="giflabel" hidden></div>
```
CSS in the same file's `<style>`, using existing tokens only:
```css
    #format { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-1, 6px); overflow: hidden; margin-top: var(--space-2); }
    #format[hidden], #giflabel[hidden] { display: none; }
    #format button { border: 0; background: transparent; padding: 2px var(--space-2); font: inherit; color: var(--text-muted); }
    #format button[aria-checked="true"] { background: var(--accent); color: var(--on-accent, #fff); }
    #format button:disabled { opacity: .5; }
    #giflabel { margin-top: var(--space-1); font-size: var(--type-caption, 11px); color: var(--text-muted); }
    #giflabel.warn { color: var(--warn); }
```
Check each token exists in `app/renderer/tokens.css`; replace any that do not with the nearest one it declares — do not add tokens here.

- [ ] **Step 2: Renderer wiring**

In `thumbnail-renderer.ts`:
```ts
import { offersFormat } from "./panel-actions.js";
import { INITIAL_GIF_STATE, reduceGif, effectOfPick, formatOf, gifLabel, copySaveEnabled,
         type GifState, type GifEvent, type OutputFormat } from "./gif-panel.js";

const formatGroup = $("format") as HTMLDivElement;
const gifLabelEl = $("giflabel") as HTMLDivElement;
let gif: GifState = INITIAL_GIF_STATE;

function drawGif(): void {
  for (const b of formatGroup.querySelectorAll<HTMLButtonElement>("button[data-format]")) {
    b.setAttribute("aria-checked", String(b.dataset.format === formatOf(gif)));
    // An mp4 Copy in flight cannot be cancelled without losing a Copy someone asked for (spec §2).
    b.disabled = copying;
  }
  const l = gifLabel(gif);
  gifLabelEl.hidden = !l;
  gifLabelEl.textContent = l?.text ?? "";
  gifLabelEl.classList.toggle("warn", l?.warn === true);
  copyProgress.hidden = gif.kind !== "converting" && !copying;
  if (gif.kind === "converting") copyProgress.value = gif.permille;
  setActionsEnabled(!busy);
}

function gifEvent(e: GifEvent): void { gif = reduceGif(gif, e); drawGif(); }

async function pickFormat(format: OutputFormat): Promise<void> {
  const effect = effectOfPick(gif, format);
  gifEvent({ kind: "pick", format });
  if (effect === "cancel") { await window.thumb.cancelGif(dir); return; }
  if (effect !== "start") return;
  const r = await window.thumb.gif(dir);
  if (r.ok) gifEvent({ kind: "done", bytes: r.bytes });
  else if (r.cancelled) gifEvent({ kind: "cancelled" });
  else gifEvent({ kind: "failed", detail: r.detail ?? "unknown error" });
}

formatGroup.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-format]");
  if (b && !b.disabled) void pickFormat(b.dataset.format as OutputFormat);
});
```
- Where the panel learns its `take` (the code that sets `take` and hides/shows actions), add: `formatGroup.hidden = !offersFormat(take); gif = INITIAL_GIF_STATE; drawGif();`
- In the existing `onCopyProgress` listener: if `gif.kind === "converting"`, `gifEvent({ kind: "progress", done, total })` and return; otherwise keep the mp4 bar behaviour.
- In `setActionsEnabled`, for `copy` and `save`: `btn.disabled = … || (formatOf(gif) === "gif" && !copySaveEnabled(gif));`
- `copyRecording()`: pass the format — `window.thumb.copyRecording(dir, formatOf(gif))`. In GIF mode do NOT set `copying = true` or show the mp4 bar (the GIF state already shows progress; Copy is just waiting on the same job). Status text on success: `formatOf(gif) === "gif" ? "Copied GIF, paste anywhere" : "Copied, paste anywhere"`.
- `run("save")` for a recording: `window.thumb.save(dir, formatOf(gif))`. Status while waiting in GIF mode: `"Saving… (GIF " + Math.floor(gif.permille/10) + "%)"` when converting, else `"Saving…"`. If `r.gifError`, the toast from main already says it; the panel closes as for any successful Save.
- `drawGif()` must also run wherever `copying` flips (start and `finally` of `copyRecording`), so the switch disables during an mp4 Copy.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && node app/build.mjs`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/thumbnail.html app/src/thumbnail-renderer.ts
git commit -m "STC-395: the GIF / Video switch on a fresh recording's panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The drift guard — `.gif` stays outside the library model

**Files:**
- Test: `app/test/library-seam.test.ts` (append) — or a new `app/test/gif-untagged.test.ts` if that file is grep-only

**Interfaces:**
- Consumes: `findOrphanedBundles` (`app/src/temp-takes.ts`), the library scan (`listLibrary` or whatever `app/src/library.ts` exports for a root)

- [ ] **Step 1: Write the tests**

```ts
// app/test/gif-untagged.test.ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-395 spec §3: a saved GIF is a plain output file, NOT a take's finished
 * file. If someone adds `.gif` to the library's media types, the editor's
 * Export (which overwrites a bundle's ONE finished file) could write MP4 bytes
 * into a `.gif`, and Reclaim would start reading GIFs as export proof. Making
 * the GIF a finished file is a design change (spec §3's alternative), not a
 * one-line edit — this test is what says so.
 */
describe("a saved GIF stays outside the library model", () => {
  const src = readFileSync(join(__dirname, "..", "src", "library.ts"), "utf8");
  test("MEDIA_EXTENSIONS does not list .gif", () => {
    const line = src.split("\n").find((l) => l.includes("const MEDIA_EXTENSIONS"))!;
    expect(line).toBeTruthy();                       // control: the pattern still finds the declaration
    expect(line).toContain(".mp4");                  // control: it is the list we think it is
    expect(line).not.toContain(".gif");
  });
});
```
Then add a behavioural case in the existing Reclaim/library test that builds a save folder (reuse `reclaim.test.ts`'s own fixture builder): one recording bundle in `raw/` with `capture.json` and no finished file, plus an untagged `<stamp>.gif` at the top level. Assert `findOrphanedBundles(...)` lists that bundle in `orphans` (not `blocked` — the GIF is no blocker), and that the library scan reports no item for the `.gif`.

- [ ] **Step 2: Run them**

Run: `npx vitest run app/test/gif-untagged.test.ts app/test/reclaim.test.ts`
Expected: PASS (these pin current behaviour; they fail only if someone changes it).

- [ ] **Step 3: Commit**

```bash
git add app/test/gif-untagged.test.ts app/test/reclaim.test.ts
git commit -m "STC-395: pin .gif outside the library and Reclaim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: E2E — the switch, wired

**Files:**
- Create: `app/test/gif-panel.e2e.test.ts`

**Interfaces:**
- Consumes: `recording-copy.e2e.test.ts`'s `launch`/`recordAndStop`/`readyPanel` pattern (copy those helpers into this file — they are file-local there), `_fake-helper.mjs`'s `STC_FAKE_COPY_LOG`, DOM ids from Task 9 (`#format button[data-format=gif]`, `#giflabel`, `#copyprogress`, `[data-action=copy]`, `[data-action=save]`, `[data-action=trash]`)

- [ ] **Step 1: Write the tests**

Header comment with the timeout arithmetic in the same form as `recording-copy.e2e.test.ts` (every test declares `300_000` as a literal; list each test's inner bounds). Tests:

```ts
describe("a recording's GIF (STC-395)", () => {
  test("flip to GIF converts with progress, shows the size, and Copy hands the GIF to the pasteboard", async () => {
    // launch (STC_COPY_RENDER_DELAY_MS 3000), recordAndStop, panel = readyPanel(...)
    await panel.click("#format button[data-format=gif]");
    await expect.poll(() => panel.isVisible("#copyprogress"), { timeout: POLL_MS }).toBe(true);
    await expect.poll(() => panel.textContent("#giflabel"), { timeout: 120_000 }).toMatch(/^GIF · \d/);
    const gifs = readdirSync(l.copies).filter((n) => n.endsWith(".gif"));
    expect(gifs).toHaveLength(1);
    expect(readFileSync(join(l.copies, gifs[0]!)).subarray(0, 6).toString()).toBe("GIF89a");
    await panel.click("[data-action=copy]");
    await expect.poll(() => existsSync(l.copyLog) ? readFileSync(l.copyLog, "utf8") : "", { timeout: POLL_MS })
      .toContain(join(l.copies, gifs[0]!));
    expect(await windowCount(app!, "thumbnail")).toBe(1);   // the panel stayed (use _windows.ts's real signature)
  }, 300_000);

  test("Copy pressed mid-conversion waits for it, then copies the GIF", async () => {
    // flip to GIF, immediately click copy, expect copy log contains the .gif path within 120 s
  }, 300_000);

  test("Save in GIF mode keeps the take and writes <take>.gif to the save folder", async () => {
    // flip, wait for ready, click save (clickThatCloses), then:
    // - recordings/raw/ has one bundle (promoted)
    // - recordings/ top level has exactly one *.gif, starting GIF89a, no *.partial
  }, 300_000);

  test("flipping back to Video mid-conversion cancels: no render window, no partial", async () => {
    // flip gif, wait #copyprogress visible, flip video;
    // poll windowUrls has no copy-render.html; copies dir has no *.partial and no *.gif;
    // #giflabel hidden; [data-action=copy] enabled
  }, 300_000);

  test("GIF → Video → GIF quickly ends ready, with one GIF (Review Focus 4)", async () => {
    // three clicks back to back; expect #giflabel /^GIF · / within 120 s; exactly one .gif, no .partial
  }, 300_000);

  test("Trash mid-conversion cancels it", async () => {
    // flip gif, wait progress, click trash (clickThatCloses); copies dir has no .gif/.partial
  }, 300_000);

  test("the switch is absent on a still's panel", async () => {
    // take a shot through the existing still flow used by recording-panel.e2e.test.ts; expect #format hidden
  }, 300_000);
});
```
Fill each commented body with the concrete calls, using the helpers exactly as `recording-copy.e2e.test.ts` uses them (`clickThatCloses`, `windowCount`/`windowUrls` from `_windows.ts`, `POLL_MS`). Do not use `app.windows()` for counts (CLAUDE.md, `_windows.ts`).

- [ ] **Step 2: Run in the Tart VM**

Follow `docs/VM-TESTING.md` for running the e2e project in the VM (not locally on Patrick's Mac). Run this file plus `recording-copy.e2e.test.ts` and `settings-sheet.e2e.test.ts` (regression for Tasks 6 and 8).
Expected: all PASS. A headless-render timeout (`render timeout after …`) is the CI trap STC-488 already documented — set `STC_COPY_RENDER_VISIBLE=1` in this file's env if the VM's display needs it, matching what `recording-copy.e2e.test.ts` does on CI.

- [ ] **Step 3: Commit**

```bash
git add app/test/gif-panel.e2e.test.ts
git commit -m "STC-395: e2e for the GIF / Video switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Runbook, ticket log, CLAUDE.md, spec correction, PR

**Files:**
- Create: `docs/STC-395-RUNBOOK.md`
- Modify: `docs/TICKET-LOG.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-08-stc-395-gif-output-design.md`

- [ ] **Step 1: Runbook**

Sections, each with what to do and what it must show:
- **§0 Branch.** `git fetch origin && git checkout accounts/stc-395-gif-output && npm ci && npm run app:start` (until merged; then `master`).
- **§1 Paste targets.** Record ~10 s, flip to GIF, Copy, paste into Slack, a GitHub comment box, Messages, Mail. Must: animate inline in each; filename `<take>.gif`.
- **§2 Look.** Default settings (15 fps, 960). A text-heavy window (an editor, a settings pane) and something with a gradient. Judge: text crisp, no colour flicker between frames, gradient banding acceptable. If banding is not acceptable, note which content — dithering is deliberately off (spec §1).
- **§3 Time.** A one-minute take at 4K capture. Time from flip to `GIF · …`. Record the number here. Compare against `scripts/gif-one.mjs`'s output on the same take.
- **§4 Large warning.** A long take (2+ minutes, lots of motion) at 1280 / 30 fps. Must: `… — large for a GIF; Video is smaller` in the warning colour; Copy and Save still work.
- **§5 Save.** Save in GIF mode: the take appears in the library as before, `<take>.gif` sits in the save folder, "Show in Finder" selects it. Then open the take in the editor and Export an MP4: the GIF must be untouched.
- **§6 Settings.** Change frame rate/width on the profile sheet; a GIF already showing `ready` on an open panel does not change; a new flip uses the new settings.

- [ ] **Step 2: Spec correction**

In the spec's §2 "The control" paragraph, replace the sentence about holding the auto-dismiss timer with: "The panel has had no auto-dismiss timer since STC-392, so nothing can close it mid-encode except Trash, dismiss or quit — each of which cancels the job."

- [ ] **Step 3: TICKET-LOG row and CLAUDE.md rows**

Append a `docs/TICKET-LOG.md` row for STC-395 in the existing table's format: what shipped (the switch, `gif-encode.ts`/`gif-export.ts`/`compositeFrames`, cache, Save-writes-a-.gif, settings), the measured numbers from Task 2 and Task 4, what was learned (no panel timer; forward-only decode makes the palette pass a full decode), and what is open (runbook unrun; GIF tile in the library and GIF from the editor's Export are out of scope).

Add `CLAUDE.md` table rows:
- `transform/src/gif-options.ts`, `transform/src/gif-encode.ts`, `transform/src/gif-export.ts`, `scripts/gif-one.mjs` — one row: the GIF sink and its rules (global palette, no dither, transparency diff, cumulative cs delays, rates divide EXPORT_FPS), and that `compositeFrames` in `export.ts` is now the ONE frame loop every sink iterates.
- `app/src/gif-panel.ts`, `app/src/gif-cache.ts`, `docs/STC-395-RUNBOOK.md` — the switch's states and sentences, main's reuse record, and the rule that a saved GIF is untagged and outside `MEDIA_EXTENSIONS` (pinned by `gif-untagged.test.ts`).

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`, plus `gate:export` and `gate:identity` once more.
Expected: all PASS; gate hashes equal Task 3 Step 1's.

- [ ] **Step 5: Commit, push, PR**

```bash
git add docs/STC-395-RUNBOOK.md docs/TICKET-LOG.md CLAUDE.md docs/superpowers/specs/2026-10-08-stc-395-gif-output-design.md
git commit -m "STC-395: runbook, ticket log, CLAUDE.md rows, spec correction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --base master --title "STC-395: GIF is an output format chosen at the panel" --body "…summary, test results, runbook link + branch…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Then bind the PR (`ccd_pr` tools) and merge only with `npm run merge -- <pr>` once CI is green — and only when Patrick says to.
