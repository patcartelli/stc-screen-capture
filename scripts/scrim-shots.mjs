// STC-644: renders the REAL overlay (overlay.html + the built overlay.js) over a
// fake light and a fake dark desktop, in each scrim state, to PNGs a person can
// look at. Headless Chromium, no Electron, no grant. Not a gate: it asserts
// nothing, it exists so the look can be judged before the Mac run.
//
//   npm run app:build && node scripts/scrim-shots.mjs [outDir]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const out = process.argv[2] ?? "scrim-shots";
mkdirSync(out, { recursive: true });
const page0 = pathToFileURL(fileURLToPath(new URL("../app/renderer/overlay.html", import.meta.url))).href;

const W = 1280, H = 800;
const display = { id: 1, bounds: { x: 0, y: 0, width: W, height: H }, scaleFactor: 2 };
// A white window, partly covered on its right by a second, smaller one.
const white = { x: 160, y: 120, width: 640, height: 420 };
const front = { x: 700, y: 300, width: 380, height: 300 };
const windows = [
  { id: 2, bounds: front, visible: [front], app: "Notes", title: "" },
  { id: 3, bounds: white, visible: [{ x: 160, y: 120, width: 540, height: 420 }, { x: 700, y: 120, width: 100, height: 180 }],
    app: "Safari", title: "Docs" },
];

const desks = {
  light: "linear-gradient(160deg, #e9eef8, #c9d4e8)",
  dark: "linear-gradient(160deg, #1d2027, #0e1014)",
};

const states = {
  "1-area-before-drag": { mode: "region", pointer: { x: 520, y: 360 } },
  "2-area-selection-in-white-window": { mode: "region", rect: { x: 240, y: 200, width: 360, height: 220 } },
  "3-window-hover": { mode: "window", hoveredWindowId: 3, pointer: { x: 400, y: 300 } },
  "4-window-over-desktop": { mode: "window", pointer: { x: 1200, y: 60 } },
};

const browser = await chromium.launch();
for (const [desk, bg] of Object.entries(desks)) {
  for (const [name, state] of Object.entries(states)) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      let cb;
      window.overlay = { send() {}, onState(f) { cb = f; return () => {}; }, onCameraFrame() { return () => {}; } };
      window.__push = (p) => cb(p);
    });
    await page.goto(`${page0}?displayId=1&synthetic=1`);
    await page.evaluate(({ bg, windows }) => {
      const desk = document.createElement("div");
      Object.assign(desk.style, { position: "fixed", inset: "0", zIndex: "-1", background: bg });
      for (const w of [...windows].reverse()) {
        const el = document.createElement("div");
        const b = w.bounds;
        Object.assign(el.style, {
          position: "absolute", left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`,
          borderRadius: "10px", background: w.id === 3 ? "#ffffff" : "#2a2d33",
          boxShadow: "0 10px 30px rgba(0,0,0,.25), 0 0 0 1px rgba(0,0,0,.12)",
        });
        desk.appendChild(el);
      }
      document.body.prepend(desk);
    }, { bg, windows });
    await page.evaluate(({ state, display, windows }) =>
      window.__push({ display, displays: [display], windows, state, phase: "select" }), { state, display, windows });
    await page.waitForTimeout(300);   // past the entrance fade
    await page.screenshot({ path: join(out, `${desk}-${name}.png`) });
    await page.close();
  }
}
await browser.close();
console.log(`wrote ${Object.keys(desks).length * Object.keys(states).length} shots to ${out}`);
