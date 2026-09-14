import { describe, test, expect } from "vitest";
import { changeGrid, changed, luma8, tileStart, GRID_W, GRID_H, LUMA_R, LUMA_G, LUMA_B, DEFAULT_THRESHOLD, type Frame } from "../src/frame-diff-rule.js";

/**
 * Correctness fixtures for the vendored kernel (STC-322), adapted from
 * `patcartelli/studio-cartelli`'s `src/lib/frame-diff-fixtures.ts` (STC-320) —
 * trimmed to what a single implementation needs (no `toBitmap`, no
 * multi-implementation cross-check apparatus; that lives upstream where
 * there are GLSL and WGSL ports to cross-check against). Sized 640x360 to
 * match `fixtures/basic`, same reason upstream chose it: the caret sweep is
 * only meaningful against a real sampling lattice.
 */
const W = 640, H = 360;

function blank(r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return data;
}

function fillRect(data: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let y = y0; y < Math.min(H, y0 + h); y++) {
    for (let x = x0; x < Math.min(W, x0 + w); x++) {
      const p = (y * W + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b;
    }
  }
}

const frame = (data: Uint8ClampedArray): Frame => ({ data, width: W, height: H });

describe("changed()", () => {
  test("is >= threshold, not >", () => {
    expect(changed(0.08, 0.08)).toBe(true);
    expect(changed(0.079999, 0.08)).toBe(false);
  });
});

describe("tileStart()", () => {
  test("tiles an axis exactly — no gaps, no overlaps, for a size not divisible by the cell count", () => {
    const cells = 64, size = 640; // divides evenly, as a sanity baseline
    for (let i = 0; i < cells; i++) {
      expect(tileStart(i + 1, size, cells)).toBe(tileStart(i, size, cells) + size / cells);
    }
    // a real capture width, not divisible by 64
    const odd = 1920;
    let prevEnd = 0;
    for (let i = 0; i < cells; i++) {
      const s = tileStart(i, odd, cells);
      expect(s).toBe(prevEnd);
      prevEnd = tileStart(i + 1, odd, cells);
    }
    expect(prevEnd).toBe(odd);
  });
});

describe("changeGrid() — closed-form fixtures", () => {
  test("nothing moves: every cell and the frame-wide fraction are exactly zero", () => {
    const g = changeGrid(frame(blank(20, 30, 40)), frame(blank(20, 30, 40)), DEFAULT_THRESHOLD);
    expect(g.changedFraction).toBe(0);
    expect(g.changedPixels).toBe(0);
    expect([...g.cells].every((c) => c === 0)).toBe(true);
  });

  test("the left half turns white: exactly 0.5, a scale check", () => {
    const a = blank(20, 30, 40);
    const b = blank(20, 30, 40);
    fillRect(b, 0, 0, W / 2, H, 230, 230, 230);
    const g = changeGrid(frame(a), frame(b), DEFAULT_THRESHOLD);
    expect(g.changedFraction).toBe(0.5);
  });

  test("a 2x16 text caret is exactly 32 pixels of 230400 — the change that matters most", () => {
    const a = blank(245, 245, 245);
    const b = blank(245, 245, 245);
    fillRect(b, 100, 100, 2, 16, 20, 20, 20);
    const g = changeGrid(frame(a), frame(b), DEFAULT_THRESHOLD);
    expect(g.changedPixels).toBe(32);
    expect(g.changedFraction).toBeCloseTo(32 / (W * H), 10);
  });

  test("the caret registers at EVERY position relative to the grid lattice — the reduction has no blind spot", () => {
    // STC-320's finding: a NEAREST point-sampled 64x36 readback sees a 2px
    // caret at only 2 of the 10 lattice-period positions. The reduction
    // (this file) must see it at all 10, which is the whole reason STC-322
    // lifts this kernel rather than the study-one raster.
    const stride = W / GRID_W; // 10
    for (let i = 0; i < stride; i++) {
      const a = blank(245, 245, 245);
      const b = blank(245, 245, 245);
      fillRect(b, 100 + i, 100, 2, 16, 20, 20, 20);
      const g = changeGrid(frame(a), frame(b), DEFAULT_THRESHOLD);
      expect(g.changedPixels, `caret at x=${100 + i}`).toBe(32);
    }
  });

  test("threshold 10% under a known 8-level grey shift: the whole frame counts as changed", () => {
    const delta = 8 / 255;
    const a = blank(100, 100, 100);
    const b = blank(108, 108, 108);
    const g = changeGrid(frame(a), frame(b), delta * 0.9);
    expect(g.changedFraction).toBe(1);
  });

  test("threshold 10% over the same shift: nothing counts as changed", () => {
    const delta = 8 / 255;
    const a = blank(100, 100, 100);
    const b = blank(108, 108, 108);
    const g = changeGrid(frame(a), frame(b), delta * 1.1);
    expect(g.changedFraction).toBe(0);
  });

  test("luma weighting order: blue < red < green (Rec.601), pinned independently of each other", () => {
    const probe = (r: number, g: number, b: number, threshold: number) => {
      const a = blank(0, 0, 0);
      const bb = blank(0, 0, 0);
      fillRect(bb, 0, 0, W, H, r, g, b);
      return changeGrid(frame(a), frame(bb), threshold).changedFraction;
    };
    expect(probe(0, 0, 60, 0.05)).toBe(0); // blue alone stays under 0.05
    expect(probe(60, 0, 0, 0.05)).toBe(1); // red alone clears it
    expect(probe(60, 0, 0, 0.10)).toBe(0); // red alone stays under 0.10
    expect(probe(0, 60, 0, 0.10)).toBe(1); // green alone clears it
  });

  test("mismatched frame sizes are refused, not silently truncated", () => {
    const a: Frame = { data: blank(0, 0, 0), width: W, height: H };
    const b: Frame = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    expect(() => changeGrid(a, b, DEFAULT_THRESHOLD)).toThrow(/size mismatch/);
  });

  test("swapping LUMA_R and LUMA_B would be a transposition bug the greyscale fixtures above cannot catch — pinned directly", () => {
    // luma8 is exported specifically so this file need not fabricate an
    // RGB triple through changeGrid to pin the weights.
    expect(luma8(255, 0, 0)).toBeCloseTo(LUMA_R, 5);
    expect(luma8(0, 255, 0)).toBeCloseTo(LUMA_G, 5);
    expect(luma8(0, 0, 255)).toBeCloseTo(LUMA_B, 5);
  });
});

/**
 * The cost measurement STC-322 asks for ("measure the cost... record the
 * number"). This is the one piece of that ask this sandbox can actually
 * answer: the REDUCTION's own compute cost, in pure JS, at a real capture
 * resolution — no decode, no canvas, no browser needed, since changeGrid
 * operates on plain typed arrays. It is NOT the full pass's cost (decode +
 * canvas readback are unmeasured here — see the finding doc) but it is a
 * real, reproducible number rather than a guess.
 */
describe("changeGrid() cost at capture resolution (informational, not a gate)", () => {
  test("one 3840x2160 reduction, timed", () => {
    const w = 3840, h = 2160;
    const mk = (seed: number): Frame => {
      const data = new Uint8ClampedArray(w * h * 4);
      // Deterministic pseudo-random content so the two frames actually
      // differ in a structured way, rather than being solid colour (which
      // would let a JIT skip work a real screen recording could not).
      let s = seed >>> 0;
      for (let i = 0; i < w * h; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        data[i * 4] = s & 0xff;
        data[i * 4 + 1] = (s >>> 8) & 0xff;
        data[i * 4 + 2] = (s >>> 16) & 0xff;
        data[i * 4 + 3] = 255;
      }
      return { data, width: w, height: h };
    };
    const a = mk(1), b = mk(2);
    const start = performance.now();
    const g = changeGrid(a, b, DEFAULT_THRESHOLD);
    const ms = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(`[STC-322] changeGrid 3840x2160 (64x36 grid): ${ms.toFixed(1)} ms`);
    expect(g.totalPixels).toBe(w * h);
    // Not a correctness assertion — a generous ceiling so a real regression
    // (an accidental O(n^2) somewhere) fails loudly, without pretending this
    // sandbox's CPU says anything about the number that belongs in the
    // finding doc.
    expect(ms).toBeLessThan(10_000);
  });
});
