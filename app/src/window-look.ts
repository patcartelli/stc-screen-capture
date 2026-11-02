import { LOOKS, lookWrite, wallpaperLookWrite, type LookWrite } from "@transform/backgrounds.js";

/**
 * What a fresh window capture looks like (STC-628) — pure, node-free, no
 * Electron: settings.ts (main), main.ts and the Settings renderer all import it.
 */
export type WindowShotLook = "window-only" | "window-shadow" | "background" | "wallpaper";

export const WINDOW_SHOT_LOOKS: readonly { value: WindowShotLook; label: string }[] = [
  { value: "window-only", label: "Just the window" },
  { value: "window-shadow", label: "Window with shadow" },
  { value: "background", label: "Capture background" },
  { value: "wallpaper", label: "Desktop wallpaper" },
];

const lookById = (id: string) => LOOKS.find((l) => l.id === id)!;
const cleanWrite = () => lookWrite(lookById("clean"));

/** The fallback line, said by the panel and the still editor alike. */
export const WALLPAPER_NOTICE = "Couldn't read your wallpaper, so this shot uses Clean.";

export const wantsWallpaper = (look: WindowShotLook): boolean => look === "wallpaper";

/** A Capture-backgrounds look: a background mode whose background is not the wallpaper. */
export function isRememberedBackground(write: LookWrite): boolean {
  if (write.mode !== "window-shadow-background" && write.mode !== "window-shadow-custom-background") return false;
  return write.background?.kind !== "wallpaper";
}

/**
 * The look a fresh window capture is written with. A wallpaper that could not
 * be read falls back to Clean and says so, so the shot is never a surprise.
 */
export function captureLook(
  look: WindowShotLook,
  lastBackground: LookWrite | null,
  wallpaper: { file: string } | { error: string } | undefined,
): { write: LookWrite; notice?: string } {
  switch (look) {
    case "window-only":
    case "window-shadow":
      return { write: lookWrite(lookById(look)) };
    case "background":
      return { write: lastBackground ?? cleanWrite() };
    case "wallpaper":
      if (wallpaper && "file" in wallpaper) return { write: wallpaperLookWrite(wallpaper.file) };
      return { write: cleanWrite(), notice: WALLPAPER_NOTICE };
  }
}

/**
 * How a fresh capture's panel is presented. `afterShot` is the panel preference
 * already resolved ("clipboard" = `thumbnail.skip`, or a variant hotkey). A
 * notice must be seen, so it shows the panel even in clipboard mode, for that
 * one shot only, and the shot is still copied (`copy`), as the silent path
 * would have done (Patrick, 2026-11-02).
 */
export function presentFlags(
  afterShot: "panel" | "clipboard",
  notice?: string,
): { silent: boolean; copy: boolean } {
  if (afterShot === "panel") return { silent: false, copy: false };
  return notice ? { silent: false, copy: true } : { silent: true, copy: false };
}
