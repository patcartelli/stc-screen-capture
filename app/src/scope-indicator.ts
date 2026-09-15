import type { DisplayInfo, Rect, WindowInfo } from "./selection.js";
import { rectContains } from "./selection.js";
import type { ScopeSettings } from "./settings.js";

/**
 * The persistent scope indicator's one pure decision (STC-381): given the
 * current scope, the live display list, and — for a window scope — a FRESH
 * lookup of that window's current bounds, what should be outlined, if
 * anything. No Electron, no window: `scope-indicator-window.ts` is the only
 * caller and owns everything about actually drawing it.
 *
 * ## Why the window's bounds are handed in rather than looked up here
 *
 * A window can move or resize between picks, so drawing the bounds captured
 * at PICK time (`ScopeSettings.windowId` alone) would show a stale outline —
 * the ticket's own "tracks the window's live position" requirement. The fresh
 * lookup is a helper round trip (`sup.listWindows()`), which is async and
 * Electron-shaped; keeping it out of this function is what makes the
 * DECISION — do I draw, and where — testable without a display server, the
 * same split `pill.ts`/`pill-window.ts` and `selection.ts`/`overlay-session.ts`
 * already use.
 */

export interface IndicatorTarget {
  /** Which display's overlay window should show the outline. */
  displayId: number;
  /** GLOBAL points — the same space `screen.getAllDisplays()` and the
   * helper's `windows` verb both report in, so this can be handed straight
   * to `BrowserWindow.setBounds` with no conversion. */
  rect: Rect;
}

/**
 * `undefined` liveWindow means "not found by this fresh lookup" — a window
 * that closed, or a `windows` query that failed outright (no grant). Either
 * way this is a picker-time affordance only, so the correct answer is not to
 * draw rather than to fall back to a stale rect.
 */
export function resolveIndicatorTarget(
  scope: ScopeSettings,
  displays: DisplayInfo[],
  liveWindow: WindowInfo | undefined,
): IndicatorTarget | null {
  if (scope.kind === "region") {
    if (!scope.region) return null;
    const d = displays.find((x) => x.id === scope.region!.displayId);
    if (!d) return null;
    return {
      displayId: d.id,
      rect: {
        x: d.bounds.x + scope.region.x,
        y: d.bounds.y + scope.region.y,
        width: scope.region.width,
        height: scope.region.height,
      },
    };
  }
  if (scope.kind === "window") {
    if (scope.windowId == null) return null;
    if (!liveWindow || liveWindow.id !== scope.windowId) return null;
    const centre = {
      x: liveWindow.bounds.x + liveWindow.bounds.width / 2,
      y: liveWindow.bounds.y + liveWindow.bounds.height / 2,
    };
    const d = displays.find((x) => rectContains(x.bounds, centre));
    if (!d) return null;
    return { displayId: d.id, rect: liveWindow.bounds };
  }
  // "display" scope: the whole display is already unambiguous, nothing to
  // confirm (the ticket's own words for why Screen scope draws nothing).
  return null;
}
