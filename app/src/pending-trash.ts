import { UNDO_WINDOW_MS } from "./panel-actions.js";

/**
 * Deletions the user has asked for and can still take back (STC-392).
 *
 * ## Why the deletion is DEFERRED rather than undone
 *
 * `shell.trashItem` has no inverse — nothing in Node or Electron can pull a
 * file back out of the Trash, and asking the user to do it in the Finder is
 * not an undo. So the ✕ does not trash anything: it PROMISES to, closes the
 * panel, and puts up a toast. The promise is kept when the window elapses.
 * Undo simply breaks it, and nothing was ever moved.
 *
 * The user cannot tell the difference — the panel is gone either way — and it
 * is the only version of "timed undo toast" that is honest about what the
 * filesystem can do.
 *
 * ## Why quitting KEEPS the promise
 *
 * A promised deletion still sitting in temp storage when the app quits would
 * be found by STC-393's recovery prompt on the next launch and offered back
 * as an unsaved take — the app handing someone a thing they deleted eight
 * seconds before they quit. So `drainAll()` exists, and `main.ts`'s shutdown
 * commits every outstanding promise before the recovery path can ever see
 * them. The direction that fails safe here is honouring the delete, not
 * resurrecting it.
 *
 * ## Electron-free, and the clock is a parameter
 *
 * The same split `thumbnail.ts`/`thumbnail-window.ts` makes, and the same
 * rule: `due` takes `now` rather than reading a clock, so "the undo expired"
 * is producible in a test rather than waited for.
 */
/**
 * How long a quit waits for ONE promised deletion to reach the Trash before
 * quitting without it (STC-427).
 *
 * `shell.trashItem` normally answers in milliseconds; it also, on the macOS
 * CI runner, sometimes never answers at all — one run in five, the app then
 * unable to quit because the very first link of its teardown chain never
 * settled. "Every wait needs a bound and a reason" (CLAUDE.md): this is the
 * bound, and the reason is that a quit which can hang forever is worse than
 * a deletion that is not honoured. On timeout the take is left where it is,
 * in temp storage — nothing is lost, and it is deliberately NOT removed some
 * other way: the ✕ promised the Trash, and a `rm` is a different promise.
 * The cost, stated: STC-393's recovery prompt will offer it back on the next
 * launch, once, for a deletion the user thought was done.
 *
 * 5 s is two orders of magnitude over a normal commit and far enough under
 * the E2E teardown bounds that derive from it (`panel-waits.e2e.test.ts`)
 * for the quit to be observed completing rather than timing out alongside.
 */
export const TRASH_COMMIT_AT_QUIT_MS = 5_000;

export class PendingTrash {
  /** dir → the moment the promise was made. */
  private readonly promised = new Map<string, number>();

  /**
   * The user pressed ✕. Nothing is moved yet.
   *
   * A second promise for the same take REPLACES the first rather than queuing
   * beside it: the path there is an undo followed by another delete, and the
   * window the user is watching is the one that started with the second press.
   */
  promise(dir: string, at: number = Date.now()): void {
    this.promised.set(dir, at);
  }

  /**
   * Take it back. `false` when there was nothing to take back — already
   * committed, or never promised — so a caller cannot reopen a panel for a
   * take that is already in the Trash.
   */
  undo(dir: string): boolean {
    return this.promised.delete(dir);
  }

  /**
   * Every promise whose window has elapsed, handed out ONCE.
   *
   * One-shot because this is what the caller trashes from: returning the same
   * directory on a later tick would trash it twice, and the second attempt
   * would report a failure for something that worked.
   */
  due(now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const [dir, at] of this.promised) {
      if (now - at >= UNDO_WINDOW_MS) out.push(dir);
    }
    for (const dir of out) this.promised.delete(dir);
    return out;
  }

  /**
   * Everything still outstanding, LOOKED AT without being taken. Read-only
   * on purpose (`pending-trash.test.ts`'s own "everything still promised is
   * nameable" test relies on this not mutating) — for anything that
   * actually COMMITS what it reads, see `drainAll()` below.
   */
  all(): string[] {
    return [...this.promised.keys()];
  }

  /**
   * Every promise still outstanding, taken all at once and removed —
   * `main.ts`'s shutdown commit uses this, not `all()` (STC-392 review, I4).
   *
   * `all()` alone would let the periodic sweep (`pendingTrash.due()`,
   * `main.ts`'s 1s interval) ALSO pick up the same directories while the
   * quit teardown's own async chain (`closeThumbnail`/`closeOverlay`/
   * `sup.shutdown`) is still running — both callers would then hand the
   * same path to `shell.trashItem`, and the second call is exactly the
   * "reports a failure for something that worked" one-shot `due()` already
   * exists to prevent, just reached from a second direction. `drainAll`
   * closes it the same way: whichever caller's read happens first empties
   * the map for the other.
   */
  drainAll(): string[] {
    const out = this.all();
    this.promised.clear();
    return out;
  }
}
