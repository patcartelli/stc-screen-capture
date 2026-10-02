/**
 * The video framing gate (STC-396). Asserts PROPERTIES of the framed picture's
 * pixels (interior untouched, rounded corner, no dark fringe, a shadow that
 * fades to zero, a pointer clipped to the picture) — no golden images, for the
 * reason scripts/still-gate.mjs gives. Decodes no video, so STC-259 cannot
 * wedge it. Structure mirrors still-gate.mjs.
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { bounded, closeQuietly, STILL_MS, isBoundFailure, instrumentPage } from "./gate-bounds.mjs";

let failures = 0;
function fail(msg) { console.error(`FAIL: ${msg}`); failures++; }
function ok(msg) { console.log(`  ok  ${msg}`); }

const server = await createServer({
  configFile: false, root: "harness", publicDir: false,
  resolve: { alias: { "@transform": new URL("../transform/src", import.meta.url).pathname } },
  server: { fs: { allow: ["."] }, hmr: false },
});

let browser;
try {
  await server.listen(5208);
  // Bundled Chromium: no H.264 needed (see still-gate.mjs). Same overrides.
  const channel = process.env.STC_STILL_GATE_CHANNEL;
  const executablePath = process.env.STC_STILL_GATE_BROWSER;
  browser = await chromium.launch({
    headless: true,
    ...(channel ? { channel } : {}),
    ...(executablePath ? { executablePath } : {}),
  });
  console.log(`browser: ${executablePath ?? channel ?? "bundled chromium"} ${browser.version()}`);
  const page = await browser.newPage();
  const trail = await instrumentPage(page);
  try {
    await page.goto("http://localhost:5208/framing.html");
    await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60_000 });

    const result = await bounded(page.evaluate(() => window.__framingGate()), STILL_MS, "in-page framing gate");
    const L = (q) => 0.2126 * q.r + 0.7152 * q.g + 0.0722 * q.b;
    for (const p of result.probes) {
      const tag = p.preset;
      const { r, g, b, a } = p.interior, f = result.fill;
      if (a !== 255 || Math.abs(r - f.r) > 2 || Math.abs(g - f.g) > 2 || Math.abs(b - f.b) > 2) {
        fail(`${tag}: the picture's interior is ${r},${g},${b} (alpha ${a}), not the recording's ${f.r},${f.g},${f.b} — framing must not tint it`);
      } else ok(`${tag}: the picture reaches the canvas untouched`);

      // the rounded corner is clipped: the very corner pixel shows chrome, not the picture
      const k = p.corner;
      if (Math.abs(k.r - f.r) <= 2 && Math.abs(k.g - f.g) <= 2 && Math.abs(k.b - f.b) <= 2) {
        fail(`${tag}: the content corner is not rounded (corner pixel is still the recording's colour)`);
      } else ok(`${tag}: the corner is rounded`);

      // no dark fringe: a corner pixel may not be darker than BOTH the picture and the background
      const floor = Math.min(L(f), L(p.background));
      console.log(`  measured ${tag}: corner lum ${L(k).toFixed(1)} (${k.r},${k.g},${k.b}), picture ${L(f).toFixed(1)}, background ${L(p.background).toFixed(1)}, same pixel with the shadow off ${L(p.cornerNoShadow).toFixed(1)}`);
      if (L(k) < floor - 12) fail(`${tag}: dark fringe at the rounded corner (corner ${L(k).toFixed(1)} vs floor ${floor.toFixed(1)})`);
      else ok(`${tag}: no dark fringe at the rounded corner`);

      // the background covers every pixel it should: opaque at both far corners
      if (p.background.a !== 255 || p.backgroundFar.a !== 255) fail(`${tag}: the background has a hole at a canvas corner`);

      // the shadow reaches zero: at and beyond its reach, the pixel equals the no-shadow reference
      const last = p.below.at(-1);
      if (Math.abs(last.lum - last.ref) > 1.5) fail(`${tag}: the shadow has not faded to nothing by ${last.d}px (lum ${last.lum.toFixed(1)} vs ${last.ref.toFixed(1)})`);
      else ok(`${tag}: the shadow reaches zero within the padding`);
      // and it is present near the picture
      const first = p.below[0];
      console.log(`  measured ${tag}: shadow at edge lum ${first.lum.toFixed(1)} vs no-shadow ${first.ref.toFixed(1)}`);
      if (first.ref - first.lum < 2 && p.preset !== "dark") fail(`${tag}: no shadow visible against the picture's edge`);

      if (!p.repeatEqual) fail(`${tag}: two renders of one document differ inside this browser`);
      else ok(`${tag}: two renders agree byte for byte`);
    }
    if (result.chromeDiff !== 0) fail(`a pointer outside the picture was drawn over the chrome (${result.chromeDiff} pixels differ)`);
    else ok("a pointer outside the picture is clipped, not drawn over the background");

    console.log("");
    console.log(failures === 0 ? "FRAMING GATE: PASS" : `FRAMING GATE: FAIL (${failures})`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    if (isBoundFailure(e)) {
      console.error(`ENVIRONMENT: ${e.message}`);
      trail.dump();
    } else {
      console.error(`FAIL: ${e?.stack ?? e}`);
    }
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`FAIL: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  await closeQuietly(browser, server);
}
