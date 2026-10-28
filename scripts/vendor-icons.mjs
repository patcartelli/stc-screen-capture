#!/usr/bin/env node
/**
 * Vendor the app's icon glyphs (STC-456).
 *
 *   node scripts/vendor-icons.mjs
 *
 * Material Symbols, Outlined, weight 300 (Patrick, 2026-09-28), from the npm
 * package `@material-symbols/svg-300` at a PINNED version, Apache-2.0. This
 * packs that exact version into a temp dir, keeps only each glyph's path `d`
 * (their viewBox is `0 -960 960 960`), and writes:
 *
 *   app/src/icons.ts           — GENERATED; edit only by re-running this
 *   app/src/icons.LICENSE.txt  — the package's own LICENSE, verbatim
 *
 * Both are committed. The build never fetches anything; this script is how a
 * glyph gets added or the version moved, and it is the only way.
 *
 * It also writes the menu-bar menu's bitmaps (STC-597):
 *
 *   app/src/tray-icons.ts      — GENERATED; alpha masks at 16 and 32 px
 *
 * A native Electron menu item takes a bitmap, not a path, so each tray glyph
 * is rasterised here (resvg, pinned, installed into the temp dir like the
 * glyph package, so the repo gains no dependency) and committed as raw alpha,
 * base64. Raw alpha rather than PNG files because `tray-menu.ts` already
 * builds its menu-bar glyph from an alpha mask and `bgraFromMask`, the
 * packaged app's `files` list needs no new entry, and a mask is readable in a
 * test; a template image is pure alpha anyway.
 *
 * WHY MATERIAL, not another set (STC-597, assessed 2026-10-28 by rendering the
 * eight menu concepts at 16 pt, 1x and 2x, black on white and white on dark,
 * from Material Symbols w300, Lucide, Phosphor light and Tabler outline):
 *
 *   - Lucide and Tabler draw a fixed 2 px stroke on a 24 px grid. At 16 pt
 *     that is ~1.3 px against Material w300's ~1 px, and their ink coverage is
 *     0.25 against 0.15. Beside the app's own weight-300 glyphs they read as
 *     bold, and in a menu they outweigh the label next to them.
 *   - Phosphor light is the right weight and the wrong size to rasterise:
 *     92% of its inked pixels are partial alpha at 16 px (Material 73%), so
 *     its 1x is a smudge in either appearance.
 *   - Material Symbols has all eight glyphs the menu needs (the ticket
 *     counted six as missing from the 14 vendored, but they are one lookup
 *     away in the SAME package: screenshot_region, web_asset, desktop_windows,
 *     timer, video_library, movie_edit), so the menu and the record bar stay
 *     one family at one weight and nothing new has to be licensed.
 *   - SF Symbols is not an option as we read its licence: it ties the glyphs
 *     to Apple's tooling and to apps on Apple platforms, and shipping them as
 *     exported images is outside that.
 *
 * Licences: Material Apache-2.0 (icons.LICENSE.txt, unchanged); Lucide ISC,
 * Phosphor and Tabler MIT, none of which would ship.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG = "@material-symbols/svg-300";
const VERSION = "0.47.5";
/** Our glyph name -> the Material Symbol it is drawn with. */
const MAP = {
  "expand": "open_in_full",
  "crop": "crop",
  "settings": "tune",
  "mic": "mic",
  "mic-off": "mic_off",
  "camera": "videocam",
  "camera-off": "videocam_off",
  "system-audio": "laptop_mac",
  "command": "keyboard_command_key",
  "click": "ads_click",
  "record": "radio_button_checked",
  "return": "keyboard_return",
  "caret": "keyboard_arrow_down",
  "check": "check",
  // STC-597: the menu-bar menu. `record` and `settings` above are reused.
  "area": "screenshot_region",
  "window": "web_asset",
  "display": "desktop_windows",
  "record-stop": "stop_circle",
  "timer": "timer",
  "library": "video_library",
  "editor": "movie_edit",
};

/** The glyphs the menu-bar menu draws, rasterised into app/src/tray-icons.ts. */
const TRAY = ["area", "window", "display", "record", "record-stop", "timer", "library", "editor", "settings"];
/** 16 pt at 1x and 2x: the two representations a menu asks for. */
const TRAY_SIZES = [16, 32];
const RESVG = "@resvg/resvg-js@2.6.2";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "vendor-icons-"));
try {
  writeFileSync(join(tmp, "package.json"), "{}");
  execFileSync("npm", ["install", RESVG, "--silent", "--no-audit", "--no-fund"], { cwd: tmp });
  const { Resvg } = createRequire(join(tmp, "x.js"))("@resvg/resvg-js");
  const out = execFileSync("npm", ["pack", `${PKG}@${VERSION}`, "--silent"], { cwd: tmp, encoding: "utf8" });
  const tgz = out.trim().split("\n").pop();
  const members = ["package/LICENSE", ...Object.values(MAP).map((n) => `package/outlined/${n}.svg`)];
  execFileSync("tar", ["-xzf", tgz, ...members], { cwd: tmp });

  const paths = {};
  for (const [glyph, symbol] of Object.entries(MAP)) {
    const svg = readFileSync(join(tmp, "package/outlined", `${symbol}.svg`), "utf8");
    if (!svg.includes('viewBox="0 -960 960 960"')) throw new Error(`${symbol}: unexpected viewBox`);
    const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
    if (ds.length === 0) throw new Error(`${symbol}: no <path d>`);
    paths[glyph] = ds.join("");
  }

  const glyphs = Object.keys(MAP);
  const ts = `// GENERATED by scripts/vendor-icons.mjs — do not edit; re-run the script.
//
// Material Symbols, Outlined, weight 300: ${PKG}@${VERSION}, Apache-2.0
// (the licence is app/src/icons.LICENSE.txt). One path per glyph, viewBox
// 0 -960 960 960. Node-free, so every renderer can import it. Material
// Symbols are FILLED outlines: draw them with \`fill: currentColor\`, never a
// stroke.

export type Glyph =
${glyphs.map((g) => `  | ${JSON.stringify(g)}`).join("\n")};

/** Which Material Symbol each glyph is, for anyone checking the mapping. */
export const SYMBOL: Readonly<Record<Glyph, string>> = {
${glyphs.map((g) => `  ${JSON.stringify(g)}: ${JSON.stringify(MAP[g])},`).join("\n")}
};

const PATHS: Readonly<Record<Glyph, string>> = {
${glyphs.map((g) => `  ${JSON.stringify(g)}: ${JSON.stringify(paths[g])},`).join("\n")}
};

/** One glyph as an inline SVG, filled with currentColor; CSS sizes it. */
export function iconSvg(g: Glyph, cls = ""): string {
  return \`<svg class="\${cls}" viewBox="0 -960 960 960" aria-hidden="true"><path d="\${PATHS[g]}"/></svg>\`;
}
`;
  writeFileSync(join(root, "app/src/icons.ts"), ts);
  writeFileSync(join(root, "app/src/icons.LICENSE.txt"), readFileSync(join(tmp, "package/LICENSE"), "utf8"));
  console.log(`wrote app/src/icons.ts (${glyphs.length} glyphs from ${PKG}@${VERSION})`);

  // One alpha byte per pixel, row-major, black ink: all a template image needs.
  const mask = (g, px) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path fill="#000" d="${paths[g]}"/></svg>`;
    const { pixels, width, height } = new Resvg(svg, { fitTo: { mode: "width", value: px } }).render();
    if (width !== px || height !== px) throw new Error(`${g}: rendered ${width}x${height}, wanted ${px}`);
    const alpha = Buffer.alloc(px * px);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
    return alpha.toString("base64");
  };
  const tray = `// GENERATED by scripts/vendor-icons.mjs — do not edit; re-run the script.
//
// The menu-bar menu's icons (STC-597): the Material Symbols w300 glyphs in
// icons.ts, rasterised at ${TRAY_SIZES.join(" and ")} px (16 pt at 1x and 2x) as raw alpha,
// one byte per pixel, row-major, base64. A macOS template image is pure alpha,
// so this is all a menu item needs; \`tray-menu.ts\`'s \`bgraFromMask\` turns it
// into the bitmap Electron takes. Node-free. Why Material: scripts/vendor-icons.mjs.

export type TrayGlyph =
${TRAY.map((g) => `  | ${JSON.stringify(g)}`).join("\n")};

export type TrayIconSize = ${TRAY_SIZES.join(" | ")};

const MASKS: Readonly<Record<TrayGlyph, Readonly<Record<TrayIconSize, string>>>> = {
${TRAY.map((g) => `  ${JSON.stringify(g)}: {\n${TRAY_SIZES.map((s) => `    ${s}: ${JSON.stringify(mask(g, s))},`).join("\n")}\n  },`).join("\n")}
};

export const TRAY_GLYPHS = Object.keys(MASKS) as readonly TrayGlyph[];

/** A glyph's alpha mask: \`size * size\` bytes, row-major. */
export function trayGlyphMask(g: TrayGlyph, size: TrayIconSize): Uint8Array {
  return Uint8Array.from(atob(MASKS[g][size]), (c) => c.charCodeAt(0));
}
`;
  writeFileSync(join(root, "app/src/tray-icons.ts"), tray);
  console.log(`wrote app/src/tray-icons.ts (${TRAY.length} glyphs at ${TRAY_SIZES.join(", ")} px)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
