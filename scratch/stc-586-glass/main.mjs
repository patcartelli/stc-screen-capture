// STC-586 spike: can the title bar alone get native macOS 26 glass?
//
// A throwaway window, not part of the app. It is a 760 x 560 copy of
// STC-581's Settings window with filler content that scrolls under the title
// bar, so each approach can be screenshotted and compared:
//
//   css      opaque window; the bar is CSS backdrop-filter over the page's
//            own content (the Figma version, and the fallback the ticket names)
//   vibrancy Electron's built-in `vibrancy` (public NSVisualEffectView). It
//            covers the whole window. The page paints itself opaque everywhere
//            except the bar, so only the bar shows the effect
//   library  electron-liquid-glass (NSGlassEffectView). Requires
//            `transparent: true`; the page is painted the same way as vibrancy
//
//   npx electron scratch/stc-586-glass/main.mjs --mode=css [--layout=under|below] [--scroll=240] [--shot=out.png]
//
// --shot writes a screenshot with `screencapture -l` (the window as the window
// server composites it, glass and shadow included) and quits. `capturePage()`
// would only see the page, never a native view behind it. On Linux, where there
// is no screencapture, it falls back to capturePage(), which is enough for css.
// docs/STC-586-SPIKE.md is the runbook and the finding.
import { app, BrowserWindow, nativeTheme } from "electron";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MODES = ["css", "vibrancy", "library"];
const mode = arg("mode", "css");
if (!MODES.includes(mode)) {
  console.error(`--mode must be one of ${MODES.join(", ")}; got ${mode}`);
  process.exit(2);
}
const scroll = Number(arg("scroll", "0"));
const shot = arg("shot", "");
// under = the pane scrolls under the bar (the design); below = it is clipped at
// the bar. Default: under for css, below for the native modes (page.html says why).
const layout = arg("layout", mode === "css" ? "under" : "below");

// The window options are the whole difference between the three modes, so
// they are spelled out in full rather than merged from a base.
const WINDOW = { width: 760, height: 560, titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 18 }, show: false };
const OPTIONS = {
  css: { ...WINDOW, backgroundColor: "#141414" },
  vibrancy: { ...WINDOW, vibrancy: "titlebar", visualEffectState: "followWindow" },
  library: { ...WINDOW, transparent: true },
};

const state = () => ({
  mode,
  transparent: mode === "library",
  hasShadow: win.hasShadow(),
  reducedTransparency: nativeTheme.prefersReducedTransparency,
  glassId,
});

let win;
let glassId = null;

async function applyLibraryGlass() {
  // Not a dependency of this repo: the runbook installs it with --no-save.
  let liquidGlass;
  try {
    liquidGlass = (await import("electron-liquid-glass")).default;
  } catch (err) {
    console.error("[spike] electron-liquid-glass is not installed: npm i --no-save electron-liquid-glass", err.message);
    return;
  }
  win.setWindowButtonVisibility(true);
  // Public options only. The unstable_* setters are private API, which the
  // ticket's decision rule excludes.
  glassId = liquidGlass.addView(win.getNativeWindowHandle(), {});
  console.log(`[spike] liquidGlass.addView -> ${glassId} (supported: ${liquidGlass.isGlassSupported()})`);
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  void win.webContents.executeJavaScript(`window.spikeState(${JSON.stringify(state())})`);
}

async function screenshot(path) {
  const out = resolve(path);
  if (process.platform === "darwin") {
    // getMediaSourceId() is "window:<CGWindowID>:0".
    const id = win.getMediaSourceId().split(":")[1];
    await new Promise((ok, fail) => execFile("screencapture", ["-x", `-l${id}`, out], (e) => (e ? fail(e) : ok())));
  } else {
    await writeFile(out, (await win.webContents.capturePage()).toPNG());
  }
  console.log(`[spike] wrote ${out}`);
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    ...OPTIONS[mode],
    // No preload, no node: the page only draws, and main tells it what it needs.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(join(here, "page.html"), { query: { mode, layout, scroll: String(scroll) } });
  if (mode === "library") await applyLibraryGlass();
  pushState();
  nativeTheme.on("updated", pushState);
  win.on("focus", pushState);
  win.on("blur", pushState);
  win.show();
  console.log("[spike]", JSON.stringify(state()));
  if (shot) {
    // Let the scroll, the WebGPU frame and the glass settle before the shot.
    await new Promise((r) => setTimeout(r, 1500));
    await screenshot(shot);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
