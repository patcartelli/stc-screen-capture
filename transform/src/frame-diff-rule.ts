/**
 * The frame-difference kernel (STC-322), vendored from `patcartelli/studio-cartelli`'s
 * `src/lib/frame-diff-rule.ts` (STC-320's lab study, PR #524), NOT imported —
 * the two are separate GitHub repos with no package published between them.
 * This is the reverse of the direction that repo already vendors in (its own
 * `src/lib/session/` copies this repo's `transform/src/{session,demux,decode,
 * timeout,decoder-preference}.ts`, per STC-319); each side names the other's
 * original so a re-sync is a deliberate, by-hand decision rather than a silent
 * drift.
 *
 * Upstream: patcartelli/studio-cartelli, src/lib/frame-diff-rule.ts, as of
 * commit 7df03edc225de14c915dbb71e52eb3d9a4b33e3 (PR #524).
 *
 * Trimmed on the way in: the upstream file also carries `pointSampledFraction`
 * (a faithful model of study one's NEAREST-sampled 64x36 readback, kept there
 * only so the GLSL/WGSL cross-check has something to measure the gap against)
 * and `compareGrids` (the cross-check's own agreement metric). Neither has a
 * caller here — this repo has no second implementation to cross-check against,
 * only this one reference — so both are left out rather than carried as dead
 * code. If a WGSL or WebGL port of this kernel is ever added HERE, restore
 * them from upstream rather than re-deriving; that is the whole point of the
 * three-ports-of-one-reference arrangement STC-320 built.
 *
 * Everything else below is unchanged from upstream, doc comments included,
 * because they record findings (the point-sample vs. reduction gap, the
 * float32 rounding trap, the `>=` convention) that apply here exactly as they
 * did there — this repo is the reason those findings exist (STC-322 is what
 * "lifting the kernel into the recorder" means).
 */

/**
 * Rec.601 luma weights. These are the numbers baked into study one's GLSL
 * (`dot(c, vec3(0.299, 0.587, 0.114))`), and the WGSL port carries the same
 * three constants rather than a "better" colour space — a port that quietly
 * improved the luma would make every downstream difference unattributable.
 */
export const LUMA_R = 0.299;
export const LUMA_G = 0.587;
export const LUMA_B = 0.114;

/**
 * The change grid's resolution. 64x36 is study one's offscreen readback size
 * and is kept exactly, because the grid is the thing the two studies have to
 * agree on and changing its shape would make them incomparable by
 * construction. (STC-322's own ticket guessed "something like 48x27, the
 * study says what" — the study says 64x36, and this keeps that answer rather
 * than the guess, for the same reason: a sidecar grid that does not match the
 * lab study's own grid would need a second set of findings.)
 */
export const GRID_W = 64;
export const GRID_H = 36;

/**
 * Luma of one 0..255 RGB triple, in 0..1 to match the shaders' unorm sampling.
 *
 * Computed in FLOAT32, deliberately, via `Math.fround` — and this is not
 * fussiness. Both shaders work in 32-bit floats, so a float64 oracle is not
 * a more accurate model of them, it is a different one, and the difference
 * is reachable: the Rec.601 weights sum to 0.99999999999999989 rather than
 * 1, so a frame pair engineered to differ by exactly the threshold comes out
 * 5.6e-17 BELOW it in float64 and exactly ON it in float32. Measured, not
 * feared — `>=` then answers false on the CPU and true on both GPUs, and the
 * harness would have reported a port bug that existed only in its own
 * arithmetic.
 *
 * The rounding order below models a strict left-to-right f32 dot product.
 * A real GPU may fuse or reassociate it, so this is close but not
 * guaranteed identical — which is exactly why any future cross-check should
 * judge rule OUTCOMES and its fixtures should avoid sitting on the threshold.
 */
export function luma8(r: number, g: number, b: number): number {
  const rf = Math.fround(r / 255);
  const gf = Math.fround(g / 255);
  const bf = Math.fround(b / 255);
  return Math.fround(
    Math.fround(Math.fround(LUMA_R * rf) + Math.fround(LUMA_G * gf)) + Math.fround(LUMA_B * bf),
  );
}

/**
 * The per-pixel test, isolated so there is exactly one place that decides
 * what "changed" means.
 *
 * GLSL says `step(uThreshold, d)`, which is `d >= threshold` — NOT `>`. A
 * port that flipped this would be invisible on real footage (a luma
 * difference landing exactly on the threshold is vanishingly rare in 8-bit
 * video) and would show up only on a synthetic fixture built to sit on the
 * boundary — which is precisely why upstream's equivalence harness includes
 * one, and why this port's own tests keep it (see
 * `transform/test/frame-diff-rule.test.ts`).
 */
export function changed(dLuma: number, threshold: number): boolean {
  return dLuma >= threshold;
}

/** RGBA8 pixels plus their dimensions. What `ImageData`'s `.data` looks like. */
export interface Frame {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Tile bounds for grid cell `i` along an axis of `size` pixels split into
 * `cells` cells.
 *
 * Exported because a future GPU port has to compute the identical bounds and
 * this is the one definition of them. Integer floor division on both sides:
 * cell i covers [floor(i*size/cells), floor((i+1)*size/cells)). That tiles
 * the axis exactly — no gaps, no overlaps, no leftover strip — for any size,
 * including sizes not divisible by the cell count, which is every real
 * capture width against 64.
 */
export function tileStart(i: number, size: number, cells: number): number {
  return Math.floor((i * size) / cells);
}

export interface ChangeGrid {
  /** GRID_W * GRID_H cells, row-major from the TOP-left. Each is the fraction (0..1) of that tile's pixels that changed. */
  readonly cells: Float32Array;
  /** Changed pixels over total pixels, across the whole frame. Exact — not the mean of `cells`, which would misweight uneven tiles. */
  readonly changedFraction: number;
  readonly changedPixels: number;
  readonly totalPixels: number;
}

/**
 * The reduction: for every grid cell, what fraction of the pixels IN that
 * cell changed.
 *
 * This is the shape STC-320 established ("the change grid is a reduction,
 * not a raster") — every pixel is visited exactly once, which is what makes
 * a two-pixel-wide caret register at every position it can occupy relative
 * to the grid, unlike a NEAREST point-sampled readback (see STC-320's
 * finding, `docs/STC-320-WGSL-PORT.md`).
 */
export function changeGrid(
  prev: Frame,
  curr: Frame,
  threshold: number,
  gridW: number = GRID_W,
  gridH: number = GRID_H,
): ChangeGrid {
  if (prev.width !== curr.width || prev.height !== curr.height) {
    throw new Error(
      `frame size mismatch: ${prev.width}x${prev.height} vs ${curr.width}x${curr.height}`,
    );
  }
  const { width, height } = prev;
  const cells = new Float32Array(gridW * gridH);
  let changedPixels = 0;

  for (let gy = 0; gy < gridH; gy++) {
    const y0 = tileStart(gy, height, gridH);
    const y1 = tileStart(gy + 1, height, gridH);
    for (let gx = 0; gx < gridW; gx++) {
      const x0 = tileStart(gx, width, gridW);
      const x1 = tileStart(gx + 1, width, gridW);

      let cellChanged = 0;
      let cellTotal = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          const p = (row + x) * 4;
          const dl = Math.abs(
            luma8(prev.data[p]!, prev.data[p + 1]!, prev.data[p + 2]!) -
              luma8(curr.data[p]!, curr.data[p + 1]!, curr.data[p + 2]!),
          );
          if (changed(dl, threshold)) cellChanged++;
          cellTotal++;
        }
      }
      cells[gy * gridW + gx] = cellTotal === 0 ? 0 : cellChanged / cellTotal;
      changedPixels += cellChanged;
    }
  }

  const totalPixels = width * height;
  return { cells, changedFraction: changedPixels / totalPixels, changedPixels, totalPixels };
}

/** The threshold study one's page opens on, and the default here for the same reason. */
export const DEFAULT_THRESHOLD = 0.08;
