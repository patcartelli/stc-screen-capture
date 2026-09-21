import { actionsFor, type PanelAction, type PanelTake } from "./panel-actions.js";

/**
 * The floating thumbnail's right-click menu (STC-296 follow-up, rebuilt on
 * `panel-actions.ts` by STC-392) — pure, so every label, every ordering and
 * every enabled state is decided where `app/test/thumbnail-menu.test.ts` can
 * look at it.
 *
 * Same reasoning as `tray-menu.ts`, and for the same reason: nothing in
 * Electron reads a `Menu` back once it has been popped up, so a template
 * checked here and handed over verbatim is the only version of this that can
 * be tested at all. What is left for a person is whether the menu appears
 * under the pointer and reads well — which no test could have claimed.
 *
 * ## The menu asks `panel-actions.ts` the same question the buttons do
 *
 * `copy` / `save` / `edit` / `trash` are `actionsFor(ctx.take)` — not a
 * second table. Two copies of the action list is the defect that let Save As
 * exist in the menu and not on the card before this ticket; this file no
 * longer has an opinion of its own about which of the four a take gets.
 * `save-as`, `redact` and `reveal` stay as extra rows below a separator —
 * they are panel FACILITIES (a save that asks first, a mode of the canvas, a
 * way to find a file already on disk), not one of the take's own actions, so
 * `actionsFor` has nothing to say about them.
 *
 * ## Delete moves to the Trash, and does NOT confirm
 *
 * `main.ts`'s take deletion puts a modal in front of `shell.trashItem`, and
 * that is right THERE: a recording is minutes of work and the library is a
 * place you browse. A shot whose panel is still on screen is two seconds old
 * and the pointer is already on it. A confirm on top of an action the Trash
 * already makes reversible is friction bought with nothing, so this deletes
 * straight away — and to the Trash, never `rm`, so "straight away" is still
 * recoverable.
 *
 * This is also the semantic the swipe-to-discard gesture and the ⌘⌫ key share
 * (`thumbnail-renderer.ts`'s `perform`). Two ways to throw a take away that
 * disagreed about where it went would be the defect, not the second gesture.
 */

export type ThumbMenuId = PanelAction | "save-as" | "redact" | "reveal" | "separator";

export interface ThumbMenuItem {
  id: ThumbMenuId;
  type?: "separator";
  label?: string;
  enabled?: boolean;
}

export interface ThumbMenuContext {
  /** What the panel is showing — decides which of the four actions appear at all. */
  take: PanelTake;
  /**
   * Redact mode is open right now. The item is a TOGGLE rather than a
   * checkbox: "Redact" while already redacting reads as "start again", which
   * is not what choosing it does.
   */
  redacting?: boolean;
  /**
   * A composite or export is already in flight. Copy and Save (and Save As)
   * are refused while one is, so they are shown unavailable rather than
   * offered and then declined — the same courtesy `trayTemplate` extends to a
   * capture that would be refused as `overlay-open`. Edit does not touch the
   * exporter (it promotes, then hands off to a different window), so it stays
   * enabled; neither does Reveal, Redact or Trash.
   */
  busy?: boolean;
}

/** What each of `panel-actions.ts`'s four actions is called on this menu. */
const ACTION_LABEL: Record<PanelAction, string> = {
  copy: "Copy", save: "Save", edit: "Edit", trash: "Delete",
  // dismiss (STC-412) is unreachable — it is a close affordance (X / Esc /
  // click-outside), never returned by actionsFor, never looked up from this record.
  dismiss: "",
};

/** Whether the exporter would refuse this action while `busy` — see `ThumbMenuContext.busy`. */
function touchesExporter(action: PanelAction): boolean {
  return action === "copy" || action === "save";
}

/**
 * The menu for one take, in the order a macOS menu puts them: the take's own
 * actions in `actionsFor`'s order (produce, then promote, then the
 * destructive one held back for its own separator), with the panel's other
 * facilities — Save As, Redact, Reveal — between them and the end.
 */
export function buildThumbMenu(ctx: ThumbMenuContext): ThumbMenuItem[] {
  const busy = ctx.busy === true;
  const actions = actionsFor(ctx.take);
  const items: ThumbMenuItem[] = [];
  for (const action of actions) {
    // Trash is placed LAST, behind its own separator, below — never here in
    // the middle of the take's other actions.
    if (action === "trash") continue;
    items.push({
      id: action, label: ACTION_LABEL[action],
      enabled: touchesExporter(action) ? !busy : true,
    });
  }
  // The ellipsis is not decoration: macOS spells "this opens a dialog" that
  // way, and Copy/Save vs Save As differ in exactly that.
  items.push({ id: "save-as", label: "Save As…", enabled: !busy });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "redact", label: ctx.redacting ? "Done Redacting" : "Redact…", enabled: true });
  items.push({ id: "reveal", label: "Reveal in Finder", enabled: true });
  items.push({ id: "separator", type: "separator" });
  items.push({ id: "trash", label: ACTION_LABEL.trash, enabled: true });
  return items;
}
