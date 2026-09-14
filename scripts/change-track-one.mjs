/**
 * Run STC-322's post-recording pass against a real take and write
 * changes.json beside it, printing the measured cost.
 *
 * This is the piece of the spike this repo's own Linux sandbox cannot run to
 * completion: it decodes real video, and the bundled Playwright Chromium
 * here fails with `NotSupportedError: H.264 decoding is not supported` —
 * the same blocker every `npm run gate*` already hits on Linux, confirmed by
 * driving this exact harness page rather than assumed (see
 * docs/STC-322-change-track-spike.md). `channel: "chrome"` below needs a
 * real installed Chrome, same as scripts/export-one.mjs.
 *
 * Usage: node scripts/change-track-one.mjs <sessionDir> [threshold]
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const sessionDir = process.argv[2];
const threshold = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
if (!sessionDir || !existsSync(join(sessionDir, "display.mp4"))) {
  console.error("usage: node scripts/change-track-one.mjs <sessionDir> [threshold]");
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
        if (name !== "display.mp4") return next();
        res.setHeader("content-type", "video/mp4");
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
  await page.goto("http://localhost:5202/change-track.html");
  await page.waitForFunction(() => window.__changeTrackReady === true, { timeout: 60_000 });

  console.log(`computing change grid over /session${threshold !== undefined ? ` at threshold ${threshold}` : " (default threshold)"}…`);
  const r = await page.evaluate(([opts]) =>
    window.computeChanges("/session", opts), [threshold !== undefined ? { threshold } : {}]);

  const dest = join(sessionDir, "changes.json");
  writeFileSync(dest, JSON.stringify(r.changes, null, 2));
  console.log(`\n${r.frameCount} frames, ${r.totalMs.toFixed(1)}ms total` +
              (r.msPerFramePair !== null ? `, ${r.msPerFramePair.toFixed(2)}ms/frame-pair` : ""));
  console.log(`grid ${r.changes.gridWidth}x${r.changes.gridHeight}, threshold ${r.changes.threshold}`);
  console.log(`wrote ${dest}`);
  out = 0;
} catch (e) {
  console.error("FAILED:", String(e?.stack ?? e));
} finally {
  await browser.close();
  await server.close();
}
process.exit(out);
