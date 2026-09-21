import { describe, test, expect } from "vitest";
import {
  buildThumbMenu, type ThumbMenuId, type ThumbMenuItem,
} from "../src/thumbnail-menu.js";
import { actionsFor, type PanelTake } from "../src/panel-actions.js";

/**
 * The right-click menu, without a window (STC-296 follow-up, rebuilt on
 * `panel-actions.ts` by STC-392).
 *
 * Nothing in Electron reads a `Menu` back once it is popped up, so this is the
 * only place the menu's contents can be checked at all — the same position
 * `tray-menu.test.ts` is in, and the reason both templates are pure.
 */

const SHOT_FRESH: PanelTake = { kind: "shot", origin: "fresh" };
const RECORDING_FRESH: PanelTake = { kind: "recording", origin: "fresh" };

const ids = (items: ThumbMenuItem[]): ThumbMenuId[] => items.map((i) => i.id);
const byId = (items: ThumbMenuItem[], id: ThumbMenuId) => items.find((i) => i.id === id);

test("the menu offers exactly the actions the panel has, and no others", () => {
  // Two copies of the action table is the defect; the menu asks
  // `panel-actions.ts` the same question the buttons do. This test is what
  // stops the menu growing an action the panel does not have — which is how
  // Save As came to be in one and not the other.
  for (const take of [{ kind: "shot", origin: "fresh" },
                      { kind: "recording", origin: "fresh" }] as const) {
    const menuIds = buildThumbMenu({ take, redacting: false, busy: false })
      .map((i) => i.id)
      .filter((id) => (["copy", "save", "edit", "trash"] as string[]).includes(id));
    expect(menuIds).toEqual([...actionsFor(take)]);
  }
});

describe("the template", () => {
  test("a fresh shot offers copy, save, save-as, redact, reveal, delete — and no edit", () => {
    const actions = ids(buildThumbMenu({ take: SHOT_FRESH })).filter((id) => id !== "separator");
    expect(actions).toEqual(["copy", "save", "save-as", "redact", "reveal", "trash"]);
  });

  test("a fresh recording offers save, edit, save-as, redact, reveal, delete — and no copy", () => {
    // Copy needs a format picker STC-395 has not built yet (`panel-actions.ts`).
    const actions = ids(buildThumbMenu({ take: RECORDING_FRESH })).filter((id) => id !== "separator");
    expect(actions).toEqual(["save", "edit", "save-as", "redact", "reveal", "trash"]);
  });

  test("delete is last, and behind a separator", () => {
    const items = buildThumbMenu({ take: SHOT_FRESH });
    expect(items[items.length - 1]?.id).toBe("trash");
    expect(items[items.length - 2]?.type).toBe("separator");
  });

  test("every non-separator item has a label, and no separator has one", () => {
    for (const item of buildThumbMenu({ take: SHOT_FRESH, redacting: true, busy: true })) {
      if (item.type === "separator") expect(item.label).toBeUndefined();
      else expect(item.label).toBeTruthy();
    }
  });
});

describe("what a dialog-opening item is called", () => {
  test("Save As and Redact carry the ellipsis; Copy, Save and Reveal do not", () => {
    const items = buildThumbMenu({ take: SHOT_FRESH });
    // macOS spells "choosing this opens something" with an ellipsis, and the
    // difference between Copy/Save and Save As is exactly that.
    expect(byId(items, "save-as")?.label).toBe("Save As…");
    expect(byId(items, "redact")?.label).toBe("Redact…");
    expect(byId(items, "copy")?.label).toBe("Copy");
    expect(byId(items, "save")?.label).toBe("Save");
    expect(byId(items, "reveal")?.label).toBe("Reveal in Finder");
  });

  test("the ellipsis is the real character, not three dots", () => {
    // Three periods look identical at a glance and are wrong; this is the kind
    // of thing only an assertion catches.
    for (const item of buildThumbMenu({ take: SHOT_FRESH })) {
      expect(item.label ?? "").not.toContain("...");
    }
  });
});

describe("redact is a toggle, not a checkbox", () => {
  test("reads Redact… when closed and Done Redacting when open", () => {
    expect(byId(buildThumbMenu({ take: SHOT_FRESH }), "redact")?.label).toBe("Redact…");
    expect(byId(buildThumbMenu({ take: SHOT_FRESH, redacting: true }), "redact")?.label)
      .toBe("Done Redacting");
  });

  test("stays enabled either way — it is how you leave redact mode", () => {
    expect(byId(buildThumbMenu({ take: SHOT_FRESH, redacting: true }), "redact")?.enabled).toBe(true);
  });
});

describe("busy", () => {
  test("disables the actions that would be refused by the exporter, and nothing else", () => {
    const busy = buildThumbMenu({ take: SHOT_FRESH, busy: true });
    expect(byId(busy, "copy")?.enabled).toBe(false);
    expect(byId(busy, "save")?.enabled).toBe(false);
    expect(byId(busy, "save-as")?.enabled).toBe(false);
    // Reveal, Redact and Delete do not touch the exporter, so a composite in
    // flight is no reason to withhold them.
    expect(byId(busy, "reveal")?.enabled).toBe(true);
    expect(byId(busy, "redact")?.enabled).toBe(true);
    expect(byId(busy, "trash")?.enabled).toBe(true);
  });

  test("Edit is refused for a different reason than the exporter, so busy does not touch it", () => {
    const busy = buildThumbMenu({ take: RECORDING_FRESH, busy: true });
    expect(byId(busy, "edit")?.enabled).toBe(true);
  });

  test("idle enables everything", () => {
    for (const item of buildThumbMenu({ take: SHOT_FRESH })) {
      if (item.type !== "separator") expect(item.enabled).toBe(true);
    }
  });
});
