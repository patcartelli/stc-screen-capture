// scripts/gif-bench.mjs
/**
 * STC-395's de-risk: how fast gifenc indexes and encodes frames at a GIF size,
 * in Node, before any UI exists. Synthetic "screen-like" frames: a static UI
 * with a moving box and a blinking caret, so the transparency diff does what
 * it does on a real take.
 *
 * Usage: node --import tsx scripts/gif-bench.mjs [width=960] [frames=150] [rich]
 * (tsx is not a dependency here; `npx vite-node scripts/gif-bench.mjs 960 150`
 * also works, as does bundling with esbuild.)
 */
import { buildPalette, GifWriter } from "../transform/src/gif-encode.ts";
import { gifDelaysCs } from "../transform/src/gif-options.ts";

const W = Number(process.argv[2] ?? 960), H = Math.round((W * 9) / 16 / 2) * 2;
const N = Number(process.argv[3] === "rich" ? 150 : process.argv[3] ?? 150);
// "rich": smooth 2-D gradient + low-amplitude noise, so a frame has thousands
// of distinct RGB565 keys (gradients, anti-aliasing, shadows, video). The
// default "flat" mode has ~5 colours and almost always hits applyPalette's cache.
const RICH = process.argv[4] === "rich" || process.argv[3] === "rich";
function frame(k) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (RICH) {
      const n = ((x * 73856093) ^ (y * 19349663)) & 7;   // static noise, 0..7
      a[i] = 40 + (x * 180) / W + n; a[i + 1] = 60 + (y * 160) / H + n;
      a[i + 2] = 120 + ((x + y) * 90) / (W + H) + n; a[i + 3] = 255;
      continue;
    }
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
console.log(`${RICH ? "rich" : "flat"} ${W}x${H}, ${N} frames: palette ${(t1 - t0).toFixed(0)} ms, ` +
  `encode ${((t2 - t1) / N).toFixed(1)} ms/frame, ${(bytes.length / 1e6).toFixed(2)} MB`);
