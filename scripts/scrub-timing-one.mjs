/**
 * Where a playhead drag's time goes on a real take (STC-632).
 *
 * Replays drags (forward and backward, short and across the whole take) through
 * the editor's own PreviewPlayer in real Chrome, a seek per 60 Hz pointer move,
 * and prints per painted frame: render(), read + decode, composite, how many
 * frames were decoded to reach each one, and decoder restarts. `settle` is how
 * long the picture took to reach the pointer after it stopped.
 *
 * Usage: node scripts/scrub-timing-one.mjs <sessionDir> [--headed]
 *
 * Headless Chrome may not decode on the hardware the app uses; run --headed on
 * the Mac for numbers that compare with the editor.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// The take's folder, or any file in it: pointing at display.mp4 is the natural mistake.
const arg = process.argv[2];
const sessionDir = arg && /\.(mp4|json|m4a)$/.test(arg) ? dirname(arg) : arg;
const headed = process.argv.includes("--headed");
if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("usage: node scripts/scrub-timing-one.mjs <sessionDir> [--headed]");
  process.exit(2);
}

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
  optimizeDeps: { include: ["mp4box"] },
  plugins: [{
    name: "serve-session",
    configureServer(s) {
      s.middlewares.use("/session", (req, res, next) => {
        const name = (req.url || "").split("?")[0].replace(/^\//, "");
        if (!["anchors.json", "events.json", "display.mp4", "camera.mp4", "mic.m4a", "system.m4a"].includes(name)) return next();
        if (!existsSync(join(sessionDir, name))) { res.statusCode = 404; res.end(); return; }
        res.setHeader("content-type", name.endsWith(".json") ? "application/json" : "video/mp4");
        res.end(readFileSync(join(sessionDir, name)));
      });
    },
  }],
});
await server.listen(5206);

const browser = await chromium.launch({ channel: "chrome", headless: !headed });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e)));
let out = 1;
try {
  await page.goto("http://localhost:5206/scrub.html");
  await page.waitForFunction(() => window.__scrubReady === true, { timeout: 60_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__scrubReady === true, { timeout: 60_000 });
  const projectPath = join(sessionDir, "project.json");
  const projectRaw = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, "utf8")) : null;
  const { take, results } = await page.evaluate(([p]) => window.runScrub("/session", p, null), [projectRaw]);

  console.log(`take: ${take.durationS.toFixed(1)} s, ${take.frames} frames, capture ${take.capture}, ` +
              `output ${take.output}, mean GOP ${take.meanGop.toFixed(1)} frames, ` +
              `camera ${take.camera ? "yes" : "no"}, zoom overrides ${take.zoomBlocks}` +
              `${headed ? "" : "  (headless)"}`);
  const f = (n, d = 1) => n.toFixed(d).padStart(7);
  console.log("\ndrag                        moves painted  /s   settle  render  decode  compos  maxDec  dec/pt restarts flushes peakBuf  kept keptMB");
  for (const r of results) {
    console.log(`${r.name.padEnd(27)} ${String(r.moves).padStart(5)} ${String(r.painted).padStart(7)}` +
                `${f(r.paintedPerS)} ${f(r.settleMs, 0)}ms${f(r.renderMs, 2)}${f(r.decodeMs)}${f(r.compositeMs, 2)}` +
                `${f(r.maxDecodeMs, 0)}${f(r.decodedPerPaint)}${String(r.decoderRestarts).padStart(9)}${String(r.flushes).padStart(8)}${String(r.peakBuffered).padStart(8)}` +
                `${String(r.keptHits).padStart(6)}${f(r.peakKeptMB, 0)}`);
  }
  console.log("\n(render/decode/compos are mean ms per painted frame; dec/pt = frames decoded per painted frame;\n kept = paints served by a frame already decoded behind the playhead, keptMB = the most those frames held, STC-635)");
  out = 0;
} catch (e) {
  console.error(String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
process.exit(out);
