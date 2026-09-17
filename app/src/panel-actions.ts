/**
 * What the post-capture panel may DO with a take (STC-392), with no DOM and
 * no Electron.
 *
 * The ticket is a four-column table, and every column is needed in at least
 * three places: `thumbnail-renderer.ts` draws the buttons, `main.ts` performs
 * them, and `thumbnail-menu.ts` offers the same set again as a context menu.
 * Three copies of one table is the most repeated defect in this codebase, so
 * the table is here and those three ask it.
 *
 * ## Why a take has a KIND and an ORIGIN, and why they are not one field
 *
 * `kind` answers "what is this" — a shot or a recording — and decides which
 * actions exist at all. `origin` answers "has anyone said yes to it yet" — a
 * fresh capture sitting in temp storage, or something re-opened from the
 * library — and decides what Save and Trash MEAN. Folding them into one enum
 * ("fresh-shot", "library-recording") would make the four combinations look
 * like four cases rather than two independent questions, and the next kind or
 * the next origin would double it again.
 *
 * ## The two absences are deliberate, and each has a reason on it
 *
 * **A shot has no Edit.** There is no still editor — `editor.ts` is a TAKE
 * editor (preview, trim, export, share) and `editor:open` refuses any path
 * outside the recordings root. A shot's editing is Redact, which lives in the
 * panel and does not close it, so it is not one of these actions at all.
 *
 * **A recording has no Copy.** Copy needs a format and a recording's format
 * picker is STC-395, explicitly out of scope here. The only video file in a
 * fresh take is `display.mp4`, which has `showsCursor` off by design — copying
 * it would hand someone a file that looks like their recording and is missing
 * the pointer. An action that looks like it worked is worse than an absent one.
 *
 * Both come back for free when their blocking ticket lands: one row each.
 *
 * NOTE (2026-09-17): the spec's "Copy → Trash on recordings" block overturns
 * the Copy half — see D6/Q1 in the plan. `actionsFor` gains `copy` for a
 * recording once Q1 is answered; the Edit half stands.
 */

export type PanelAction = "copy" | "save" | "edit" | "trash";

/** What the panel is showing. Decides which actions exist. */
export type TakeKind = "shot" | "recording";

/**
 * Whether anyone has said yes to it yet. Decides what Save and Trash mean.
 *
 * `fresh` is a capture still sitting in temp storage (STC-393) — nothing has
 * kept it, so Save promotes and Trash is cheap. `library` is STC-294's
 * re-open: already on disk, already kept, so there is nothing to Save and
 * Trash is destroying something the user chose.
 */
export type TakeOrigin = "fresh" | "library";

export interface PanelTake {
  kind: TakeKind;
  origin: TakeOrigin;
}

/**
 * The actions this take has, in the order the panel lays them out.
 *
 * Trash is always last and always present — it is the ✕, and a panel that
 * never closes on its own must always have a way out.
 */
export function actionsFor(take: PanelTake): readonly PanelAction[] {
  const out: PanelAction[] = [];
  // See the module doc: a recording has no Copy until STC-395.
  if (take.kind === "shot") out.push("copy");
  // Nothing to promote for something already in the library.
  if (take.origin === "fresh") out.push("save");
  // See the module doc: a shot has no Edit until a still editor exists.
  if (take.kind === "recording") out.push("edit");
  out.push("trash");
  return out;
}

/**
 * Whether performing this action ends the panel's life.
 *
 * Copy is the only one that does not, and that is the ticket's whole point:
 * "Copy and done" is two actions from the user, Copy and then Trash, because
 * the interface never deletes anything as a side effect of another action.
 */
export function closesPanel(action: PanelAction): boolean {
  return action !== "copy";
}

/**
 * Whether this action moves the take out of temp storage and into the library
 * (STC-393's `promoteTake`).
 *
 * Save obviously. Edit as well, and not as a convenience: `editor:open`
 * refuses any path outside the recordings root, so a take must be promoted
 * before the editor can be pointed at it. The editor's own Save is about the
 * EXPORT — the ticket's "you may only be trimming" — not about whether the
 * take is kept.
 *
 * Copy deliberately does NOT, which is the change STC-393's runbook asked for:
 * a Copy that promoted would leave a Trash pressed afterwards deleting
 * something already sitting in the library.
 */
export function promotes(action: PanelAction): boolean {
  return action === "save" || action === "edit";
}

/**
 * The ticket's Reconcile item, settled (D1): confirm what the user chose to
 * keep, undo what they never saved.
 *
 * The 2026-09-11 window-model decision ("Discard gets a confirmation dialog")
 * is about the LIBRARY — a grid you browse, holding things you already said
 * yes to, where a misclick lands on a stranger. This panel is the other
 * surface: a take seconds old with the pointer already on it, which the user
 * has not kept yet. A modal there is friction bought with nothing, and a
 * timed undo is the cheaper promise.
 *
 * Both are already the code's behaviour — `panel:trash` does not confirm,
 * `take:delete` does — and each file already argues for its own half. This
 * ticket adds only the toast, and this function is the one place the split is
 * stated rather than implied by which handler you happened to reach.
 */
export function trashStyle(origin: TakeOrigin): "undo" | "confirm" {
  return origin === "fresh" ? "undo" : "confirm";
}

/**
 * How long an undo stays reachable.
 *
 * Long enough to notice the toast, read it and move a pointer to it; short
 * enough that a take the user meant to delete is not still sitting in temp
 * storage when they quit. The commit-on-shutdown rule in `pending-trash.ts` is
 * what makes the second half true regardless.
 */
export const UNDO_WINDOW_MS = 8_000;
