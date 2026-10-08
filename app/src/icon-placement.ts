/**
 * Where the app's icon lives (STC-502) — the pure decisions. No Electron, no DOM.
 *
 * Launch opens no window: the entry point is the hotkey and the menu bar, and
 * the library is a view the user opens. Where the icon appears is a
 * preference, and this module is the whole rule so `main.ts` only carries it
 * out:
 *
 * | setting   | menu bar | Dock                      |
 * | --------- | -------- | ------------------------- |
 * | `both`    | yes      | always                    |
 * | `menubar` | yes      | only while a window is open |
 * | `dock`    | no       | always                    |
 *
 * 1. There is no setting for "neither". With both gone the hotkey would be the
 *    only way back in, so the type cannot say it and a stored value that does
 *    falls back to the default.
 * 2. In `both` and `dock` the Dock follows the SETTING, never a window. The
 *    icon used to slide in and out of the Dock every time the library or an
 *    editor opened or closed (STC-292); that is now `menubar`'s alone.
 * 3. `menubar` shows the Dock icon while a window is open because macOS only
 *    lists an app in Cmd-Tab if it has one (decided 2026-10-05). A window with
 *    no way to Cmd-Tab to it cannot be found again once something covers it.
 * 4. "A window" is a document window: the library, the video editor or the
 *    still editor. A capture's overlay, countdown, floating panel, toast and
 *    pill come and go with a capture; counting them would flash the Dock icon
 *    during every shot.
 */

export type IconPlacement = "both" | "menubar" | "dock";

export const ICON_PLACEMENTS: readonly IconPlacement[] = ["both", "menubar", "dock"];

export const DEFAULT_ICON_PLACEMENT: IconPlacement = "both";

/** What each setting is called in Preferences — here so a test can read the sentences. */
export const ICON_PLACEMENT_LABELS: Record<IconPlacement, string> = {
  both: "Menu bar and Dock",
  menubar: "Menu bar only",
  dock: "Dock only",
};

/** Anything that is not one of the three becomes the default (rule 1). */
export function cleanIconPlacement(value: unknown): IconPlacement {
  return ICON_PLACEMENTS.includes(value as IconPlacement)
    ? (value as IconPlacement)
    : DEFAULT_ICON_PLACEMENT;
}

export interface IconState {
  /** Whether the menu-bar item exists. */
  tray: boolean;
  /** Whether the Dock icon shows. */
  dock: boolean;
}

/** The icons for a setting and a count of open document windows (rules 2-4). */
export function decideIcons(placement: IconPlacement, documentWindows: number): IconState {
  switch (placement) {
    case "both": return { tray: true, dock: true };
    case "menubar": return { tray: true, dock: documentWindows > 0 };
    case "dock": return { tray: false, dock: true };
  }
}
