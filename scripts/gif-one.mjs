/**
 * Make a GIF from a session in real Chrome (STC-395) and, with --check, parse
 * it back with omggif: frame count, size, even dimensions, delays summing to
 * the reported duration, and (EXPECT_DURATION_CS) that the GIF covers the trim
 * window rather than the whole take.
 *
 * Usage: node scripts/gif-one.mjs <sessionDir> [fps=15] [maxWidth=960|original] [--check] [--no-dither] [--out <dir>]
 *
 * --no-dither turns off the gradient-only dither (gif-encode.ts), for a
 * before/after comparison; the app always dithers. --check also prints the
 * fraction of pixels dithered (frame 0, and over every frame), so SMOOTH_MIN /
 * SMOOTH_MAX are tuned on a number rather than a guess.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const dither = !args.includes("--no-dither");
const oi = args.indexOf("--out");
const outDir = oi >= 0 ? args[oi + 1] : null;
const pos = args.filter((a, i) => !a.startsWith("--") && !(oi >= 0 && i === oi + 1));
const sessionDir = pos[0];
const fps = Number(pos[1] ?? 15);
const maxWidth = pos[2] === "original" ? "original" : Number(pos[2] ?? 960);
if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("usage: node scripts/gif-one.mjs <sessionDir> [fps=15] [maxWidth=960|original] [--check] [--no-dither] [--out <dir>]");
  process.exit(2);
}

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  // HMR reloads the page when vite re-optimises deps, destroying any in-flight evaluate.
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box", "gifenc"] },
  plugins: [{
    name: "serve-session",
    configureServer(s) {
      s.middlewares.use("/session", (req, res, next) => {
        const name = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!["anchors.json", "events.json", "project.json", "display.mp4", "camera.mp4", "mic.m4a", "system.m4a"].includes(name)) return next();
        res.setHeader("content-type", name.endsWith(".json") ? "application/json" : "video/mp4");
        res.end(readFileSync(join(sessionDir, name)));
      });
    },
  }],
});
await server.listen(5202);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e)));
let out = 1;
try {
  await page.goto("http://localhost:5202/gif.html");
  await page.waitForFunction(() => window.__gifReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__gifReady === true, { timeout: 60_000 });
  const projectPath = join(sessionDir, "project.json");
  const projectRaw = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, "utf8")) : null;
  const r = await page.evaluate(([p, s, o]) => window.exportGif("/session", p, s, o),
    [projectRaw, { fps, maxWidth }, { dither }]);

  const bytes = Buffer.from(r.base64, "base64");
  const dir = outDir ?? sessionDir;
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `gif-${fps}fps-${maxWidth}.gif`);
  writeFileSync(dest, bytes);
  console.log(`${r.frames} frames ${r.width}x${r.height}, ${(r.durationCs / 100).toFixed(2)} s, ` +
              `${(bytes.length / 1e6).toFixed(2)} MB in ${(r.elapsedMs / 1000).toFixed(1)} s${dither ? "" : " (no dither)"} → ${dest}`);
  out = 0;
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
    const pct = (f) => `${(f * 100).toFixed(1)}%`;
    console.log(`dithered: frame 0 ${pct(r.ditherStats.firstFrame)}, overall ${pct(r.ditherStats.overall)}`);
  }
} catch (e) {
  console.error("FAILED:", String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
process.exit(out);
