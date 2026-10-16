/**
 * How Settings opens (STC-551 follow-up) — pure.
 *
 * Settings is a slide-over in the main window, so something has to be the
 * window. When one already exists (the library is open) the sheet slides over
 * it as always. When none does — Menu bar only, a tray click — making one
 * would put the library grid on screen, which the ticket says Settings must not
 * do. The window is then made for Settings alone: "standalone", showing only
 * the sheet, and closing it closes the window.
 */
export type SettingsMode = "over-library" | "standalone";

export function settingsMode(libraryWindowExists: boolean): SettingsMode {
  return libraryWindowExists ? "over-library" : "standalone";
}
