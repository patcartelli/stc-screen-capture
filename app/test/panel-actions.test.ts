import { describe, test, expect } from "vitest";
import {
  actionsFor, closesPanel, promotes, trashStyle, UNDO_WINDOW_MS, lockedWhileCopying,
  type PanelAction, type PanelTake,
} from "../src/panel-actions.js";

/**
 * STC-392's action table, with no window and no Electron.
 *
 * The table in the ticket is four columns — action, effect, whether the panel
 * closes, and (for a recording) whether the action exists at all. Every one of
 * those answers is needed in at least two places: the renderer draws the
 * buttons, main performs them, and `thumbnail-menu.ts` offers the same set
 * again in a context menu. Three copies of one table is the defect this repo
 * has hit five ways, so the table lives here and those three ask.
 */

const fresh = (kind: PanelTake["kind"]): PanelTake => ({ kind, origin: "fresh" });

describe("which actions a take has", () => {
  test("a fresh shot has copy, save, edit and trash", () => {
    // Edit opens a still editor now (STC-300) — Redact moved out of the
    // panel and into it, so a shot gets Edit the same as a recording does.
    expect(actionsFor(fresh("shot"))).toEqual(["copy", "save", "edit", "trash"]);
  });

  test("a fresh recording has copy, save, edit and trash", () => {
    // STC-488: Copy RENDERS a recording (cursor and zoom included) to a file
    // in the copies folder, so a Trash afterwards cannot break the paste.
    expect(actionsFor(fresh("recording"))).toEqual(["copy", "save", "edit", "trash"]);
  });

  test("a take re-opened from the library cannot be saved again", () => {
    // STC-294's re-open: it is already in the library, and a second Save would
    // be the app inventing work nobody asked for.
    expect(actionsFor({ kind: "shot", origin: "library" })).toEqual(["copy", "edit", "trash"]);
    expect(actionsFor({ kind: "recording", origin: "library" })).toEqual(["copy", "edit", "trash"]);
  });

  test("every take has trash, and it is always last", () => {
    for (const kind of ["shot", "recording"] as const) {
      for (const origin of ["fresh", "library"] as const) {
        const actions = actionsFor({ kind, origin });
        expect(actions.at(-1)).toBe("trash");
      }
    }
  });
});

describe("what an action does to the panel", () => {
  test("copy is the only action that leaves the panel open", () => {
    // The ticket's own words: "Copy and done" takes two actions from you.
    const all: PanelAction[] = ["copy", "save", "edit", "trash"];
    expect(all.filter((a) => !closesPanel(a))).toEqual(["copy"]);
  });

  test("save and edit promote out of temp storage; copy and trash do not", () => {
    // A Copy that promoted would leave a Trash pressed afterwards deleting
    // something already sitting in the library (STC-393 runbook's own note).
    const all: PanelAction[] = ["copy", "save", "edit", "trash"];
    expect(all.filter(promotes)).toEqual(["save", "edit"]);
  });

  test("nothing that promotes also closes without promoting, and vice versa", () => {
    // Composition, not magnitude: the two predicates must not be able to
    // disagree about `save`, which is the one action that does both.
    expect(promotes("save") && closesPanel("save")).toBe(true);
    expect(promotes("copy") || closesPanel("copy")).toBe(false);
  });

  describe("dismiss (STC-412)", () => {
    test("dismiss does not promote and does not appear in actionsFor", () => {
      // actionsFor's four-action contract is UNCHANGED — dismiss is a close
      // affordance (X / Esc / click-outside), never a fifth action-row button.
      for (const kind of ["shot", "recording"] as const) {
        for (const origin of ["fresh", "library"] as const) {
          expect(actionsFor({ kind, origin })).not.toContain("dismiss");
        }
      }
    });

    test("dismiss closes the panel and does nothing to the take", () => {
      expect(closesPanel("dismiss")).toBe(true);
      expect(promotes("dismiss")).toBe(false);
    });
  });
});

describe("the reconcile (D1)", () => {
  test("an unsaved take gets a timed undo; a library one gets a confirmation", () => {
    expect(trashStyle("fresh")).toBe("undo");
    expect(trashStyle("library")).toBe("confirm");
  });

  test("the undo window is long enough to read the toast and reach it", () => {
    expect(UNDO_WINDOW_MS).toBeGreaterThanOrEqual(5_000);
    expect(UNDO_WINDOW_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("what a recording's copy locks while it renders (STC-488)", () => {
  test("copy, save and edit lock; trash and dismiss never do", () => {
    // Save would move the take out from under the render reading it, and Edit
    // promotes first, the same move. A second Copy would start a second job.
    // Trash and dismiss are the panel's way out, and they cancel the render.
    const all: PanelAction[] = ["copy", "save", "edit", "trash", "dismiss"];
    expect(all.filter(lockedWhileCopying)).toEqual(["copy", "save", "edit"]);
  });
});
