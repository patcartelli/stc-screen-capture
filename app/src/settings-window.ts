import { BrowserWindow, nativeTheme, screen, type WebContents } from "electron";
import { join } from "node:path";
import { PRODUCT_NAME } from "./product.js";
import { settingsBounds } from "./window-size.js";

/**
 * The Settings window (STC-581), its own window since it stopped being a
 * slide-over in the library: 760 x 560, fixed, always dark. One at a time:
 * asking again brings the open one forward. The library's gear, the menu
 * bar's Settings… and the record bar's Settings control all open it, and
 * none of them opens the library.
 *
 * The title bar is STC-586's CSS glass. Its Reduce Transparency fallback keys
 * off `nativeTheme.prefersReducedTransparency`, read here and pushed to the
 * page, because Chromium may not report the media query itself.
 */

/** Traffic lights at Figma's place: 20px in, 22px down (Settings frames). */
const TRAFFIC_LIGHTS = { x: 20, y: 22 };

/**
 * STC-594 spike: `STC_GLASS_SIDEBAR=clear|tint` makes the sidebar native
 * glass (public `vibrancy: "sidebar"`, an NSVisualEffectView behind the page,
 * no transparent window). Off by default; docs/STC-594-SPIKE.md is the
 * runbook. Anything else, or unset, is the opaque window it always was.
 */
function glassSidebar(): "clear" | "tint" | null {
  const v = process.env.STC_GLASS_SIDEBAR;
  return v === "clear" || v === "tint" ? v : null;
}

let win: BrowserWindow | undefined;

export interface SettingsWindowOptions {
  /** Where settings-preload.cjs lives. */
  dist: string;
  /** Where settings.html lives. */
  rendererDir: string;
  /** Called once the window has closed, for main's own bookkeeping (the Dock). */
  onClosed(): void;
}

export function openSettingsWindow(opts: SettingsWindowOptions): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const glass = process.platform === "darwin" ? glassSidebar() : null;
  const w = new BrowserWindow({
    ...settingsBounds(area),
    resizable: false, maximizable: false, fullscreenable: false,
    title: `${PRODUCT_NAME} Settings`,
    titleBarStyle: "hidden",
    trafficLightPosition: TRAFFIC_LIGHTS,
    // A vibrancy window keeps a clear background, or the colour covers the glass.
    ...(glass
      ? { vibrancy: "sidebar" as const, visualEffectState: "followWindow" as const, backgroundColor: "#00000000" }
      : { backgroundColor: "#0c0c0c" }),
    show: false,
    webPreferences: {
      preload: join(opts.dist, "settings-preload.cjs"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win = w;
  const pushReduce = () => {
    if (!w.isDestroyed()) w.webContents.send("settings:reduced-transparency", nativeTheme.prefersReducedTransparency);
  };
  nativeTheme.on("updated", pushReduce);
  w.once("ready-to-show", () => w.show());
  w.on("closed", () => {
    nativeTheme.removeListener("updated", pushReduce);
    if (win === w) win = undefined;
    opts.onClosed();
  });
  void w.loadFile(join(opts.rendererDir, "settings.html"), {
    query: { reduceTransparency: nativeTheme.prefersReducedTransparency ? "1" : "0", ...(glass ? { glass } : {}) },
  });
}

export function settingsWindowIsOpen(): boolean {
  return win !== undefined && !win.isDestroyed();
}

export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close();
}

/** Whether `sender` is the Settings window's page. */
export function isSettingsWindow(sender: WebContents): boolean {
  return !!win && !win.isDestroyed() && win.webContents === sender;
}

/** Tell the Settings window another window wrote a preference. */
export function notifySettingsWindow(channel: "settings:changed"): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, undefined);
}
