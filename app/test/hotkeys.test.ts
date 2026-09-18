import { describe, test, expect } from "vitest";
import {
  ACTION_LABELS, SHOT_ACTIONS, BINDABLE_ACTIONS, DEFAULT_SHORTCUTS, HYPER, SYSTEM_CLAIMED,
  acceleratorFromKeyStroke, explainShortcut, formatAccelerator, isShotAction,
  parseAccelerator, planShortcuts,
  type ShortcutReport, type Shortcuts,
} from "../src/hotkeys.js";

/**
 * The global capture shortcuts' decisions (STC-292), with no Electron and no
 * keyboard — the arrangement `selection.test.ts` has for the overlay.
 *
 * What this file can settle: the grammar, the refusals, the normalisation, the
 * duplicate rule and every sentence the user is shown. What it CANNOT settle,
 * and the runbook therefore owns: whether macOS actually delivers the chord to
 * a background app, and whether `globalShortcut.register` returns false where
 * this module predicted "reserved".
 */

describe("parsing an accelerator", () => {
  test("normalises case, aliases and modifier order", () => {
    for (const spelling of ["cmd+shift+a", "Shift+Command+A", "META+shift+A", "  shift + cmd + a "]) {
      expect(parseAccelerator(spelling)).toEqual({ ok: true, accelerator: "Shift+Command+A" });
    }
  });

  test("the hyperkey default is what a caps-lock remap sends", () => {
    // Written the way the four modifiers arrive, in any order, and normalised
    // to the one string the settings file and the menu bar both carry.
    expect(parseAccelerator("Command+Shift+Alt+Control+1"))
      .toEqual({ ok: true, accelerator: `${HYPER}+1` });
    expect(DEFAULT_SHORTCUTS.region).toBe(`${HYPER}+1`);
  });

  test("a bare key is refused — it would be taken from every app on the machine", () => {
    expect(parseAccelerator("A")).toEqual({ ok: false, problem: "no-modifier" });
    expect(parseAccelerator("F5")).toEqual({ ok: false, problem: "no-modifier" });
  });

  test("modifiers alone are not a shortcut", () => {
    expect(parseAccelerator("Command+Shift")).toEqual({ ok: false, problem: "no-key" });
  });

  test("two keys are refused, and the refusal names them", () => {
    expect(parseAccelerator("Command+A+B"))
      .toEqual({ ok: false, problem: "too-many-keys", token: "A+B" });
  });

  test("a token that is neither a modifier nor a key is refused by name", () => {
    expect(parseAccelerator("Command+Hyper")).toEqual({ ok: false, problem: "unknown-token", token: "Hyper" });
    expect(parseAccelerator("Command+F25")).toEqual({ ok: false, problem: "unknown-token", token: "F25" });
  });

  test("media keys are refused because they would need an Accessibility grant", () => {
    // The whole permission story of the ticket: a still capture must work with
    // only Screen Recording. Electron binds ordinary keys through Carbon and
    // media keys through a CGEventTap, and only the second needs Accessibility.
    expect(parseAccelerator("MediaPlayPause"))
      .toEqual({ ok: false, problem: "needs-accessibility", token: "MediaPlayPause" });
    expect(parseAccelerator("Command+VolumeUp").ok).toBe(false);
  });

  test("the system screenshot bindings are refused, in every spelling", () => {
    for (const n of ["3", "4", "5", "6"]) {
      expect(parseAccelerator(`Command+Shift+${n}`)).toEqual({ ok: false, problem: "reserved" });
      expect(parseAccelerator(`shift+cmd+${n}`)).toEqual({ ok: false, problem: "reserved" });
      expect(parseAccelerator(`ctrl+shift+cmd+${n}`)).toEqual({ ok: false, problem: "reserved" });
    }
  });

  test("every entry of the reserved list is refused however it is spelled", () => {
    // The list reads in Apple's order (⌘⇧4), which is NOT this module's
    // canonical order — written as literals the entries matched nothing and
    // every system binding was quietly accepted. That is what this caught.
    for (const a of SYSTEM_CLAIMED) {
      const mods = a.split("+").slice(0, -1);
      const key = a.split("+").at(-1)!;
      const shuffled = [...mods].reverse().join("+") + "+" + key;
      expect(parseAccelerator(shuffled), a).toEqual({ ok: false, problem: "reserved" });
    }
  });

  test("named keys, function keys, digits and punctuation all bind", () => {
    expect(parseAccelerator("Alt+space")).toEqual({ ok: true, accelerator: "Alt+Space" });
    expect(parseAccelerator("Control+f12")).toEqual({ ok: true, accelerator: "Control+F12" });
    expect(parseAccelerator("Command+Alt+7")).toEqual({ ok: true, accelerator: "Alt+Command+7" });
    expect(parseAccelerator("Control+/")).toEqual({ ok: true, accelerator: "Control+/" });
  });

  test("an empty binding is empty, not malformed", () => {
    expect(parseAccelerator("")).toEqual({ ok: false, problem: "empty" });
    expect(parseAccelerator("   ")).toEqual({ ok: false, problem: "empty" });
  });
});

describe("planning a whole set", () => {
  const plan = (s: Partial<Shortcuts>) =>
    planShortcuts({ ...DEFAULT_SHORTCUTS, ...s });

  test("the defaults all plan clean, and differ from each other", () => {
    // Every BINDABLE action now, not just the four shots (STC-388) — record
    // is planned exactly like the rest.
    const p = plan({});
    expect(p.map((x) => x.problem)).toEqual(BINDABLE_ACTIONS.map(() => undefined));
    expect(new Set(p.map((x) => x.accelerator)).size).toBe(BINDABLE_ACTIONS.length);
  });

  test("no default collides with a system binding", () => {
    // The ticket's own requirement, checked rather than asserted in a comment.
    for (const a of Object.values(DEFAULT_SHORTCUTS)) {
      expect(parseAccelerator(a!).ok, a!).toBe(true);
    }
  });

  test("null is unbound, which is not a problem", () => {
    const [region] = plan({ region: null });
    expect(region).toEqual({ action: "region", accelerator: null });
  });

  test("a duplicate is refused on the LATER action, not on both", () => {
    // Two actions on one key can only fire one of them; failing both would
    // take a working binding away from the user for someone else's mistake.
    const p = plan({ window: DEFAULT_SHORTCUTS.region });
    expect(p[0]!.problem).toBeUndefined();
    expect(p[1]!.problem).toBe("duplicate");
    expect(p[2]!.problem).toBeUndefined();
  });

  test("a duplicate is judged on the NORMALISED form, not the spelling", () => {
    const p = plan({ window: "shift+alt+control+command+1" });
    expect(p[1]!.problem).toBe("duplicate");
  });

  test("a malformed binding keeps the user's own text, so the UI can show it back", () => {
    const p = plan({ display: "Command+Hyper" });
    expect(p[2]).toMatchObject({ accelerator: "Command+Hyper", problem: "unknown-token", token: "Hyper" });
  });
});

describe("what the user is told", () => {
  const report = (o: Partial<ShortcutReport>): ShortcutReport =>
    ({ action: "region", accelerator: `${HYPER}+1`, registered: false, ...o });

  test("a registered shortcut says nothing", () => {
    expect(explainShortcut(report({ registered: true }))).toBeUndefined();
  });

  test("an unbound action says nothing either", () => {
    expect(explainShortcut(report({ accelerator: null }))).toBeUndefined();
  });

  test("every problem has its own sentence, and none is empty", () => {
    const problems = ["no-modifier", "no-key", "too-many-keys", "unknown-token",
                      "needs-accessibility", "reserved", "duplicate", "unavailable"] as const;
    const said = problems.map((problem) => explainShortcut(report({ problem, token: "X" })));
    for (const [i, s] of said.entries()) {
      expect(s, problems[i]).toBeTruthy();
      expect(s!.length, problems[i]).toBeGreaterThan(10);
    }
    // Distinct: "macOS owns this" and "another app owns this" are different
    // problems with different fixes, and must not read as one message.
    expect(new Set(said).size).toBe(problems.length);
  });

  test("a system claim and a third-party claim are worded apart", () => {
    expect(explainShortcut(report({ problem: "reserved" }))).toMatch(/macOS/);
    expect(explainShortcut(report({ problem: "unavailable" }))).toMatch(/Mac/);
    expect(explainShortcut(report({ problem: "reserved" })))
      .not.toBe(explainShortcut(report({ problem: "unavailable" })));
  });
});

describe("recording a keystroke", () => {
  const stroke = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    acceleratorFromKeyStroke({ code, ...mods });

  test("the hyperkey chord records as the default binding", () => {
    expect(stroke("Digit1", { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }))
      .toBe(`${HYPER}+1`);
  });

  test("`code` is used, not `key` — ⌥⇧1 is an unrelated glyph on macOS", () => {
    // KeyA under ⌥ produces "å"; the binding must still be A.
    expect(stroke("KeyA", { metaKey: true, altKey: true })).toBe("Alt+Command+A");
  });

  test("modifiers alone are not an answer — the chord is still being pressed", () => {
    for (const code of ["MetaLeft", "ShiftRight", "ControlLeft", "AltLeft", "CapsLock"]) {
      expect(stroke(code, { metaKey: true }), code).toBeNull();
    }
  });

  test("named keys, the numpad and the function row all record", () => {
    expect(stroke("Space", { ctrlKey: true })).toBe("Control+Space");
    expect(stroke("Numpad5", { metaKey: true })).toBe("Command+5");
    expect(stroke("F7", { altKey: true })).toBe("Alt+F7");
    expect(stroke("Slash", { metaKey: true })).toBe("Command+/");
  });

  test("what it records is still put through the grammar", () => {
    // ⌘⇧4 can be TYPED at the field; it must be refused there like anywhere
    // else, which is why this returns an accelerator rather than a verdict.
    const recorded = stroke("Digit4", { metaKey: true, shiftKey: true });
    expect(recorded).toBe("Shift+Command+4");
    expect(parseAccelerator(recorded!)).toEqual({ ok: false, problem: "reserved" });
  });
});

describe("showing a binding", () => {
  test("the hyperkey default renders as its four glyphs", () => {
    expect(formatAccelerator(`${HYPER}+1`)).toBe("⌃⌥⇧⌘1");
  });

  test("an unbound action renders as a dash, not as an empty gap", () => {
    expect(formatAccelerator(null)).toBe("—");
  });
});

/**
 * Stills are called "Shot" now (STC-398).
 *
 * The rename is a LABEL change, and this pins the thing that makes that safe:
 * the action ids are what `settings.json` stores a user's bindings against, so
 * a label may be rewritten freely but an id may not — renaming one silently
 * unbinds every hotkey that user had chosen. That is this ticket's own second
 * acceptance criterion, and it is the half no amount of reading the labels
 * would catch.
 */
describe("stills are Shot (STC-398)", () => {
  test("no label calls a still a Capture — the app itself is Capture now", () => {
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      expect(label, `${action} still says Capture`).not.toMatch(/capture/i);
    }
  });

  test("every SHOT label says Shot — Record (STC-388) is not a still and keeps its own word", () => {
    for (const action of SHOT_ACTIONS) expect(ACTION_LABELS[action]).toMatch(/^Shot\b/);
  });

  test("the action IDS are untouched, so stored bindings still resolve", () => {
    // Exactly the keys a pre-rename settings.json holds. If this list ever has
    // to change, it needs a settings migration — not a relabel.
    expect([...SHOT_ACTIONS]).toEqual(["region", "window", "display", "self-timer"]);
    // DEFAULT_SHORTCUTS now also carries `record` (STC-388) — a fifth,
    // brand-new key, not a rename of any of the four above.
    expect(Object.keys(DEFAULT_SHORTCUTS).sort())
      .toEqual(["display", "record", "region", "self-timer", "window"]);
  });

  test("a binding stored before the rename still plans onto its action", () => {
    // A real pre-rename shortcuts block, keyed by id rather than by label —
    // plus `record` (STC-388), since `Shortcuts` now covers every bindable
    // action and a caller can no longer omit it.
    const stored: Shortcuts = { region: `${HYPER}+1`, window: `${HYPER}+2`,
                     display: `${HYPER}+3`, record: `${HYPER}+4`, "self-timer": `${HYPER}+5` };
    const planned = planShortcuts(stored);
    for (const p of planned) {
      expect(p.accelerator, `${p.action} lost its binding`).toBe(stored[p.action]);
    }
  });
});

describe("Record is a bindable action, not a Shot (STC-388)", () => {
  test("record is bindable but is not a shot", () => {
    expect(BINDABLE_ACTIONS).toContain("record");
    expect([...SHOT_ACTIONS] as string[]).not.toContain("record");
    expect(isShotAction("record")).toBe(false);
    for (const a of SHOT_ACTIONS) expect(isShotAction(a)).toBe(true);
  });

  test("SHOT_ACTIONS is DERIVED, so the two lists cannot disagree", () => {
    // Not a second literal: every shot action must appear in the wider list,
    // in the same relative order, and nothing else may be in it.
    expect(SHOT_ACTIONS).toEqual(BINDABLE_ACTIONS.filter((a) => a !== "record"));
    expect(new Set(BINDABLE_ACTIONS).size).toBe(BINDABLE_ACTIONS.length);
  });

  test("the four persisted shot ids are unchanged — renaming one costs a hotkey", () => {
    expect([...SHOT_ACTIONS]).toEqual(["region", "window", "display", "self-timer"]);
  });

  test("Record's default is the slot STC-391 left open", () => {
    expect(DEFAULT_SHORTCUTS.record).toBe(`${HYPER}+4`);
    expect(parseAccelerator(DEFAULT_SHORTCUTS.record!)).toEqual({
      ok: true, accelerator: `${HYPER}+4`,
    });
  });

  test("the action list and the numeric defaults cannot drift apart", () => {
    // BINDABLE_ACTIONS' order is load-bearing twice over: it is the order
    // preferences lists actions in, and the order planShortcuts resolves
    // duplicates in. The numeric defaults are a second statement of the same
    // ordering, so they are asserted to agree rather than left to drift.
    const digits = BINDABLE_ACTIONS.map((a) => {
      const acc = DEFAULT_SHORTCUTS[a];
      expect(acc, `${a} has no default binding`).toBeTruthy();
      const m = /^(.*)\+(\d)$/.exec(acc!);
      expect(m, `${a}'s default is not HYPER+<digit>: ${acc}`).not.toBeNull();
      expect(m![1]).toBe(HYPER);
      return Number(m![2]);
    });
    expect(digits).toEqual([...digits].sort((x, y) => x - y));
    expect(new Set(digits).size).toBe(digits.length);
  });

  test("every bindable action has a label, and Record's says Record", () => {
    for (const a of BINDABLE_ACTIONS) expect(ACTION_LABELS[a]).toBeTruthy();
    expect(ACTION_LABELS.record).toBe("Record");
  });

  test("planShortcuts covers record, and resolves a duplicate in list order", () => {
    const plans = planShortcuts({
      ...DEFAULT_SHORTCUTS, region: `${HYPER}+9`, record: `${HYPER}+9`,
    });
    expect(plans.map((p) => p.action)).toEqual([...BINDABLE_ACTIONS]);
    // region comes first in BINDABLE_ACTIONS, so it keeps the key.
    expect(plans.find((p) => p.action === "region")!.problem).toBeUndefined();
    expect(plans.find((p) => p.action === "record")!.problem).toBe("duplicate");
  });
});
