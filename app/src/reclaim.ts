import { fmtBytes } from "./library-items.js";
import type { ToastMessage } from "./toast-message.js";
import type { BundleKind, OrphanedBundle, ReclaimReport } from "./temp-takes.js";

/**
 * "Reclaim space" — every sentence the user is shown (STC-435).
 *
 * Pure, on the `tray-menu.ts`/`thumbnail-menu.ts` precedent: nothing in
 * Electron reads a `dialog.showMessageBox` back once it is up, so everything
 * checkable about it is checked here, before it gets there. `main.ts` only
 * finds, asks with what this returns, and trashes.
 *
 * ## The rules
 *
 * 1. **Nothing to offer is a toast, never a dialog.** A dialog with one
 *    button is a modal that says "OK" — the toast already exists for this.
 * 2. **A blocker is always NAMED.** Before STC-435 the skip case was a stderr
 *    line nobody in a packaged app could see; the whole point of the ticket
 *    is that "I couldn't check these" comes with "because of these files",
 *    which is something the user can act on (move them, or delete them).
 * 3. **The list is capped in the text, never in what is trashed.** `dirs` is
 *    every offered bundle; only `detail` stops at {@link RECLAIM_LIST_MAX}.
 *    A blocked bundle is never in `dirs`.
 * 4. **The size the button names is the total of what will move**, so the
 *    one number the user decides on is on the thing they press.
 */

/** Lines of bundle list a dialog's `detail` holds before "…and N more". */
export const RECLAIM_LIST_MAX = 12;

/** Blocker file names named before "and N more". */
const BLOCKER_LIST_MAX = 5;

const KIND_LABEL: Record<BundleKind, string> = {
  recording: "recording",
  still: "still",
  unknown: "unfinished take",
};

const takes = (n: number): string => `${n} ${n === 1 ? "take" : "takes"}`;
const total = (bs: OrphanedBundle[]): number => bs.reduce((s, b) => s + b.bytes, 0);

function nameList(names: string[], max: number): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/** The held-back sentence, or undefined when nothing was held back (rule 2). */
function blockedSentence(report: ReclaimReport, lead: string): string | undefined {
  if (report.blocked.length === 0) return undefined;
  const files = [...new Set(report.blocked.flatMap((b) => b.blockers))];
  const have = files.length === 1 ? "has" : "have";
  const it = files.length === 1 ? "it" : "them";
  return `${lead}${takes(report.blocked.length)} (${fmtBytes(total(report.blocked))}) can't be checked ` +
    `while ${nameList(files, BLOCKER_LIST_MAX)} ${have} no capture id — any of ${it} could be one of ` +
    `those takes' files. Move or delete ${it} to check again.`;
}

export type ReclaimPrompt =
  | { kind: "toast"; message: ToastMessage }
  | {
      kind: "dialog";
      message: string;
      detail: string;
      buttons: [string, string];
      defaultId: 0;
      cancelId: 1;
      /** Every offered bundle — what a confirm moves (rule 3). */
      dirs: string[];
    };

export function reclaimPrompt(report: ReclaimReport): ReclaimPrompt {
  const { orphans } = report;
  if (orphans.length === 0) {
    return {
      kind: "toast",
      message: {
        title: "Nothing to reclaim",
        body: blockedSentence(report, "") ??
          "Every take's source folder still belongs to a file in the folder.",
      },
    };
  }

  const lines = orphans.slice(0, RECLAIM_LIST_MAX)
    .map((b) => `• ${b.name} — ${KIND_LABEL[b.kind]}, ${fmtBytes(b.bytes)}`);
  if (orphans.length > RECLAIM_LIST_MAX) lines.push(`…and ${orphans.length - RECLAIM_LIST_MAX} more`);
  const size = fmtBytes(total(orphans));
  const detail = [
    "These are the source folders (in raw/) of takes whose file is no longer in the folder — " +
      "no file in the folder carries their capture id, so nothing in the library uses them.",
    lines.join("\n"),
    `Total: ${size}. They go to the Trash, so you can put them back.`,
    blockedSentence(report, "Another "),
  ].filter((s): s is string => s !== undefined).join("\n\n");

  return {
    kind: "dialog",
    message: `Move ${orphans.length} unused ${orphans.length === 1 ? "take" : "takes"} to the Trash?`,
    detail,
    buttons: [`Move to Trash (${size})`, "Cancel"],
    defaultId: 0,
    cancelId: 1,
    dirs: orphans.map((b) => b.dir),
  };
}

/**
 * The toast after a confirm. `moved` is what actually reached the Trash —
 * never the list the user agreed to, which a file coming back mid-dialog or a
 * failed `trashItem` can both shrink.
 */
export function reclaimResult(moved: OrphanedBundle[], failed: number): ToastMessage {
  const parts: string[] = [];
  if (moved.length > 0) parts.push(`Moved ${takes(moved.length)} (${fmtBytes(total(moved))}) to the Trash.`);
  else if (failed === 0) parts.push("Nothing was moved — every take's file is back in the folder.");
  if (failed > 0) parts.push(`${failed} could not be moved.`);
  return { title: "Reclaim space", body: parts.join(" ") };
}
