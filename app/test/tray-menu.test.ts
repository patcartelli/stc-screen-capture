import { describe, test, expect } from "vitest";
import {
  TRAY_ICON_SIZE, TRAY_ICON_SIZE_2X, STOP_RECORDING_LABEL,
  bgraFromMask, marqueeMask, trayTemplate,
} from "../src/tray-menu.js";
import {
  BINDABLE_ACTIONS, SHOT_ACTIONS, DEFAULT_SHORTCUTS, HYPER,
} from "../src/hotkeys.js";

/**
 * The menu-bar item's contents and icon (STC-292).
 *
 * There is no Electron API that reads a `Tray` back — no enumeration, no menu
 * inspection, no synthetic click — so everything checkable about the menu bar
 * has to be checkable BEFORE it reaches Electron. That is the whole reason
 * `tray-menu.ts` is separate from `tray.ts`. What is left for the runbook is
 * whether the item is visible and legible in both menu-bar appearances.
 */

describe("the menu", () => {
  const ids = (ctx: Parameters<typeof trayTemplate>[0]) =>
    trayTemplate(ctx).map((i) => i.id);

  test("every shot action is offered, in the order preferences lists them", () => {
    // Filtered to the shot ids rather than sliced by position: Record
    // (STC-388) now sits BETWEEN the shots and the self-timer in
    // `BINDABLE_ACTIONS`, so the shots are no longer a contiguous prefix of
    // the template — only their own relative order is the claim here.
    const shotIds = ids({ shortcuts: DEFAULT_SHORTCUTS })
      .filter((id) => SHOT_ACTIONS.some((a) => id === `action:${a}`));
    expect(shotIds).toEqual(SHOT_ACTIONS.map((a) => `action:${a}`));
  });

  test("there is a way back to a window and a way to quit", () => {
    // Not decoration: with the Dock icon hidden while no window is open, this
    // menu is the only way to reopen the app and the only way to end it.
    const id = ids({ shortcuts: DEFAULT_SHORTCUTS });
    expect(id).toContain("library");
    expect(id).toContain("quit");
  });

  test("a bound action shows its accelerator VERBATIM, not pre-rendered", () => {
    // Electron does the ⌃⌥⇧⌘ substitution itself; handing it glyphs would put
    // a string it cannot parse where it expects a binding.
    const [region] = trayTemplate({ shortcuts: DEFAULT_SHORTCUTS });
    expect(region!.accelerator).toBe(`${HYPER}+1`);
  });

  test("an unbound action shows no accelerator at all", () => {
    // An item showing "—" where a shortcut would be reads as a broken binding
    // rather than as one nobody has set.
    const [region] = trayTemplate({ shortcuts: { ...DEFAULT_SHORTCUTS, region: null } });
    expect(region!.accelerator).toBeUndefined();
  });

  test("a shot in flight disables the shot actions and nothing else", () => {
    // Deliberately filtered to SHOT_ACTIONS rather than `startsWith("action:")`
    // — that prefix now also matches Record, which this scenario (busy, not
    // recording) disables identically, but is a DIFFERENT claim covered by
    // its own test below (STC-388).
    const busy = trayTemplate({ shortcuts: DEFAULT_SHORTCUTS, busy: true });
    const shots = busy.filter((i) => SHOT_ACTIONS.some((a) => i.id === `action:${a}`));
    // Every shot action, however many there are — and the count is asserted
    // too, so "disables the shots" cannot be satisfied by a filter that found
    // none of them.
    expect(shots).toHaveLength(SHOT_ACTIONS.length);
    expect(shots.map((i) => i.enabled)).toEqual(SHOT_ACTIONS.map(() => false));
    expect(busy.find((i) => i.id === "library")!.enabled).not.toBe(false);
    expect(busy.find((i) => i.id === "quit")!.enabled).not.toBe(false);
  });

  test("every item that is not a separator has a label", () => {
    for (const item of trayTemplate({ shortcuts: DEFAULT_SHORTCUTS })) {
      if (item.type === "separator") continue;
      expect(item.label, item.id).toBeTruthy();
    }
  });
});

describe("the icon", () => {
  const at = (m: Uint8Array, size: number, x: number, y: number) => m[y * size + x];

  for (const size of [TRAY_ICON_SIZE, TRAY_ICON_SIZE_2X]) {
    describe(`${size}px`, () => {
      const mask = marqueeMask(size);

      test("is the right length and only ever fully on or fully off", () => {
        expect(mask.length).toBe(size * size);
        expect(new Set(mask)).toEqual(new Set([0, 255]));
      });

      test("is symmetric both ways", () => {
        // An asymmetric menu-bar glyph reads as a rendering bug at 16px.
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            expect(at(mask, size, x, y), `${x},${y} horizontally`)
              .toBe(at(mask, size, size - 1 - x, y));
            expect(at(mask, size, x, y), `${x},${y} vertically`)
              .toBe(at(mask, size, x, size - 1 - y));
          }
        }
      });

      test("draws corner brackets: corners set, edge midpoints clear", () => {
        // The positive discriminator. "Some pixels are set" would pass for a
        // solid square, a dot, or a frame — none of which is this glyph.
        const inset = Math.round(size / 8);
        expect(at(mask, size, inset, inset)).toBe(255);
        expect(at(mask, size, size - 1 - inset, inset)).toBe(255);
        expect(at(mask, size, inset, size - 1 - inset)).toBe(255);
        expect(at(mask, size, size - 1 - inset, size - 1 - inset)).toBe(255);
        // A full frame would have these set; a bracket glyph does not.
        expect(at(mask, size, size >> 1, inset)).toBe(0);
        expect(at(mask, size, inset, size >> 1)).toBe(0);
        // And nothing in the middle at all.
        expect(at(mask, size, size >> 1, size >> 1)).toBe(0);
      });

      test("never leaves the inset rect, so nothing is clipped by the menu bar", () => {
        const inset = Math.round(size / 8);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (!at(mask, size, x, y)) continue;
            expect(x >= inset && x <= size - 1 - inset, `${x},${y}`).toBe(true);
            expect(y >= inset && y <= size - 1 - inset, `${x},${y}`).toBe(true);
          }
        }
      });
    });
  }

  test("the bitmap is pure alpha and black — a template image carries no colour", () => {
    // Colour under zero alpha is the classic way to get a grey halo out of
    // anything that later ignores the template flag.
    const mask = marqueeMask(TRAY_ICON_SIZE);
    const bgra = bgraFromMask(mask);
    expect(bgra.length).toBe(mask.length * 4);
    for (let i = 0; i < mask.length; i++) {
      expect(bgra[i * 4]).toBe(0);
      expect(bgra[i * 4 + 1]).toBe(0);
      expect(bgra[i * 4 + 2]).toBe(0);
      expect(bgra[i * 4 + 3]).toBe(mask[i]);
    }
  });
});

describe("Record in the menu bar (STC-388)", () => {
  const ctx = { shortcuts: DEFAULT_SHORTCUTS };

  test("every bindable action gets an item, in list order", () => {
    const ids = trayTemplate(ctx).filter((i) => i.id.startsWith("action:")).map((i) => i.id);
    expect(ids).toEqual(BINDABLE_ACTIONS.map((a) => `action:${a}`));
  });

  test("Record draws its own accelerator", () => {
    const item = trayTemplate(ctx).find((i) => i.id === "action:record")!;
    expect(item.label).toBe("Record");
    expect(item.accelerator).toBe(DEFAULT_SHORTCUTS.record);
  });

  test("mid-take the item says Stop Recording and stays clickable — the NORMAL state", () => {
    // STC-388 review, Finding 10 (deferred minor #2): the only test of this
    // used `busy: true`, which is a compound state (a shot ALSO in flight
    // during a recording) — the ordinary mid-take state, `busy: false`, had
    // never been exercised. The hotkey toggles, so the menu item must too —
    // an item that went grey the moment a take started would be the only
    // entry point that cannot stop one, which is the gap this ticket exists
    // to close.
    const item = trayTemplate({ ...ctx, recording: true, busy: false })
      .find((i) => i.id === "action:record")!;
    expect(item.label).toBe(STOP_RECORDING_LABEL);
    expect(item.enabled).toBe(true);
  });

  test("mid-take, WITH a shot also in flight, the item still says Stop Recording and stays clickable", () => {
    // The compound state the original test above covered — kept as its own
    // case rather than folded away, since `busy: true` disabling the SHOT
    // actions (the test two below) must not also disable Record.
    const item = trayTemplate({ ...ctx, recording: true, busy: true })
      .find((i) => i.id === "action:record")!;
    expect(item.label).toBe(STOP_RECORDING_LABEL);
    expect(item.enabled).toBe(true);
  });

  test("a shot is still refused while something is in flight", () => {
    const items = trayTemplate({ ...ctx, busy: true });
    for (const a of SHOT_ACTIONS) {
      expect(items.find((i) => i.id === `action:${a}`)!.enabled).toBe(false);
    }
  });

  test("Record is refused while a SHOT is in flight — busy without recording", () => {
    const item = trayTemplate({ ...ctx, busy: true }).find((i) => i.id === "action:record")!;
    expect(item.enabled).toBe(false);
    expect(item.label).toBe("Record");
  });
});
