import { LOOKS, lookWrite, wallpaperLookWrite, type LookWrite } from "@transform/backgrounds.js";
import { wallpaperFraming, type Framing, type FramingBackground } from "@transform/framing.js";
import { LOOK_FILLS, WINDOW_SHADOW_FILL, type FillLookId } from "@transform/looks.js";
import type { Rect } from "@transform/spaces.js";
import { sameFill, VIDEO_LOOKS, withCustom, withLook, type VideoLook } from "./framing-edit.js";

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
  return write.background?.kind !== "wallpaper" && write.background?.kind !== "image";
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

/** The fallback line for a recording, said on the panel after the take and in the editor's Frame pane. */
export const WALLPAPER_TAKE_NOTICE = "Couldn't read your wallpaper, so this take uses Clean.";

const CLEAN_FRAMING = (): Framing => withLook(undefined, "clean")!;

/** A remembered still background as video's framing, or null for a kind video cannot draw (radial, mesh). */
function rememberedFraming(write: LookWrite): Framing | null {
  const bg = write.background;
  if (!bg) return CLEAN_FRAMING(); // Clean stores no background: its mode derives one.
  let background: FramingBackground;
  if (bg.kind === "solid" && bg.colors?.[0]) background = { kind: "solid", color: bg.colors[0] };
  else if (bg.kind === "linear" && bg.colors && bg.angleDeg !== undefined) {
    background = { kind: "linear", colors: [...bg.colors], angleDeg: bg.angleDeg };
  } else return null;
  // A catalogue look goes through withLook, so Dark keeps its deeper shadow.
  const named = (Object.keys(LOOK_FILLS) as FillLookId[]).find((id) => sameFill(background, LOOK_FILLS[id]));
  return named ? withLook(undefined, named)! : withCustom(undefined, background);
}

/**
 * The framing a new window RECORDING starts with (STC-626), captureLook's
 * counterpart. Just the window is no framing at all. Window with shadow falls
 * on plain white, because an MP4 has no transparency to fall on (Patrick,
 * 2026-11-03). A wallpaper that could not be read is Clean and says so.
 */
export function recordingLook(
  look: WindowShotLook,
  lastBackground: LookWrite | null,
  wallpaper: { file: string } | { error: string } | undefined,
): { framing?: Framing; notice?: string } {
  switch (look) {
    case "window-only":
      return {};
    case "window-shadow":
      return { framing: { preset: "clean", background: { ...WINDOW_SHADOW_FILL } } };
    case "background":
      return { framing: (lastBackground && rememberedFraming(lastBackground)) ?? CLEAN_FRAMING() };
    case "wallpaper":
      if (wallpaper && "file" in wallpaper) return { framing: { preset: "clean", background: wallpaperFraming() } };
      return { framing: CLEAN_FRAMING(), notice: WALLPAPER_TAKE_NOTICE };
  }
}

/** The display a window is on: the one holding its midpoint, else the first, as the helper's chooseDisplayForWindow does. */
export function displayOfWindow(
  bounds: Rect, displays: readonly { id: number; bounds: Rect }[],
): number | undefined {
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const on = displays.find(({ bounds: d }) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height);
  return (on ?? displays[0])?.id;
}

/**
 * The Frame control's swatches for a take of this scope (STC-626). A window
 * take gets the same four looks a window shot has; every other scope keeps
 * exactly the grid it had. None is Just the window here: the same empty framing.
 */
export function videoLooksFor(scopeKind: string | undefined): readonly VideoLook[] {
  if (scopeKind !== "window") return VIDEO_LOOKS;
  const label = (value: WindowShotLook) => WINDOW_SHOT_LOOKS.find((l) => l.value === value)!.label;
  const named = VIDEO_LOOKS.filter((l) => l.id !== "none" && l.id !== "custom");
  return [
    { id: "none", label: label("window-only") },
    { id: "window-shadow", label: label("window-shadow"), fill: WINDOW_SHADOW_FILL },
    ...named,
    { id: "wallpaper", label: LOOKS.find((l) => l.id === "wallpaper")!.label },
    VIDEO_LOOKS.find((l) => l.id === "custom")!,
  ];
}
