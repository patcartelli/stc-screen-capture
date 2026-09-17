import { describe, test, expect } from "vitest";
import { PendingTrash } from "../src/pending-trash.js";
import { UNDO_WINDOW_MS } from "../src/panel-actions.js";

/**
 * The undo window as a DECISION, with an injected clock (`thumbnail.ts`'s
 * rule 2, applied to a different panel): "the undo expired" has to be
 * producible on demand rather than waited for.
 */
describe("the undo window", () => {
  test("a promised deletion is not due until the window has elapsed", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 1_000);
    expect(p.due(1_000 + UNDO_WINDOW_MS - 1)).toEqual([]);
    expect(p.due(1_000 + UNDO_WINDOW_MS)).toEqual(["/t/a"]);
  });

  test("due() is a one-shot — a deletion is handed out once, never twice", () => {
    // `due` is what the caller trashes from. Returning the same directory on
    // the next tick would trash it twice: the second call sees a path that no
    // longer exists and reports a failure for something that worked.
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    expect(p.due(UNDO_WINDOW_MS)).toEqual(["/t/a"]);
    expect(p.due(UNDO_WINDOW_MS + 10_000)).toEqual([]);
  });

  test("undo takes it back, and only before it is due", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    expect(p.undo("/t/a")).toBe(true);
    expect(p.due(UNDO_WINDOW_MS)).toEqual([]);
    // Already handed out: there is nothing left to take back, and saying
    // otherwise would let the panel reappear for a take already in the Trash.
    p.promise("/t/b", 0);
    p.due(UNDO_WINDOW_MS);
    expect(p.undo("/t/b")).toBe(false);
  });

  test("everything still promised is nameable, for the shutdown commit", () => {
    // Quit must not leave a promised deletion in temp storage: STC-393's
    // recovery prompt would offer it back on the next launch, and the user
    // pressed delete.
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    p.promise("/t/b", 0);
    expect(p.all().sort()).toEqual(["/t/a", "/t/b"]);
    p.undo("/t/a");
    expect(p.all()).toEqual(["/t/b"]);
  });

  test("promising the same take twice does not queue two deletions", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    p.promise("/t/a", 5_000);
    expect(p.all()).toEqual(["/t/a"]);
    // The LATER promise decides when: the panel was reopened by an undo and
    // deleted again, and the second press is the one the user is watching.
    expect(p.due(5_000 + UNDO_WINDOW_MS - 1)).toEqual([]);
    expect(p.due(5_000 + UNDO_WINDOW_MS)).toEqual(["/t/a"]);
  });

  // STC-392 review, I4: the quit commit must DRAIN, not merely read, or the
  // periodic sweep (`main.ts`'s `due()` interval) racing the quit teardown's
  // own async chain can hand the same directory to `shell.trashItem` twice.
  test("drainAll takes everything AND empties the map, unlike all()", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    p.promise("/t/b", 0);
    expect(p.drainAll().sort()).toEqual(["/t/a", "/t/b"]);
    // Taken: a second read sees nothing, so a caller racing this one (the
    // periodic sweep) cannot also commit the same directories.
    expect(p.all()).toEqual([]);
    expect(p.drainAll()).toEqual([]);
  });

  test("drainAll does not hand back an already-undone promise", () => {
    const p = new PendingTrash();
    p.promise("/t/a", 0);
    expect(p.undo("/t/a")).toBe(true);
    expect(p.drainAll()).toEqual([]);
  });
});
