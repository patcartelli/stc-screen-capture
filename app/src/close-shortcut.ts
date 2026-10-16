/**
 * ⌘W (STC-552) — pure, so the key test needs no Electron.
 *
 * The default menu's Close Window would take the whole window with it while
 * the Settings sheet is open; the sheet is what ⌘W should close first. Main
 * intercepts the key in `before-input-event` (which runs ahead of menu
 * accelerators) and uses this to recognise it.
 */
export interface KeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export function isCloseKey(i: KeyInput): boolean {
  return i.type === "keyDown" && i.meta && !i.control && !i.alt && !i.shift
    && i.key.toLowerCase() === "w";
}

/** Runs in the renderer: clicks the sheet's own close button if it is open
 * (the real handler, not a second way to close) and answers whether it did. */
export const CLOSE_SHEET_SCRIPT =
  `(() => { const s = document.getElementById("profilesheet");
    if (!s || !s.classList.contains("open")) return false;
    document.getElementById("profileclose").click(); return true; })()`;
