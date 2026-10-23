/**
 * axe over every renderer HTML (STC-506): `npm run axe:renderers`.
 *
 * Loads each `app/renderer/*.html` in Chrome, light AND dark, with the preload
 * bridges stubbed (the pages throw without them, and a page that threw before
 * building its DOM would be audited as empty), and runs axe on the WCAG 2.0/2.1
 * A and AA rules. Exits 1 on any violation.
 *
 * What this does NOT see: anything a page only draws after a real state
 * arrives (the overlay's options bar is `hidden` until a payload lands, the
 * panel's expanded picker, an open menu). axe skips hidden nodes. It is a
 * floor, not the whole answer; the audit doc lists what still needs eyes.
 * Best-practice rules (landmarks, a level-one heading) are deliberately off:
 * they describe documents, and these are floating panels.
 *
 * Not in CI (needs Chrome, like the other gates). `STC_CHROME` overrides the
 * browser path.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const dir = fileURLToPath(new URL("../app/renderer/", import.meta.url));
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));

const launch = process.env.STC_CHROME
  ? { executablePath: process.env.STC_CHROME, args: ["--no-sandbox"] }
  : { channel: "chrome" };
const browser = await chromium.launch(launch);
let failed = 0;
for (const scheme of ["light", "dark"]) {
  for (const name of pages) {
    const ctx = await browser.newContext({ bypassCSP: true, colorScheme: scheme, viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const stub = () => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : stub()), apply: () => stub() });
      for (const k of ["overlay", "countdown", "pill", "toast", "thumbnail", "editor", "stc", "recorder", "still", "copyRender", "stillEditor"]) {
        try { Object.defineProperty(window, k, { value: stub(), configurable: true, writable: true }); } catch { /* already defined */ }
      }
    });
    page.on("pageerror", () => {});
    await page.goto(new URL(name, `file://${dir}`).href);
    await page.waitForTimeout(400);
    await page.evaluate(axeSrc);
    const r = await page.evaluate(() => axe.run(document, {
      resultTypes: ["violations"], runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    }));
    console.log(`${name} [${scheme}]: ${r.violations.length} violation(s)`);
    for (const v of r.violations) {
      failed += v.nodes.length;
      console.log(`  - ${v.id} x${v.nodes.length}`);
      for (const n of v.nodes.slice(0, 8)) console.log(`      ${n.target.join(" ")}  ${(n.any[0]?.message ?? "").slice(0, 150)}`);
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
