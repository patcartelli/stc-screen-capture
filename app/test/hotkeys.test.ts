import { describe, test, expect } from "vitest";
import {
  ACTION_LABELS, SHOT_ACTIONS, BINDABLE_ACTIONS, DEFAULT_SHORTCUTS, LEGACY_DEFAULT_SHORTCUTS, SUPERSEDED_DEFAULT_SHORTCUTS, HYPER, SYSTEM_CLAIMED,
  OUTCOMES, OUTCOME_MODIFIERS, OUTCOME_LABELS, outcomeAccelerator, planOutcomeVariants, explainVariant,
  type OutcomeVariantReport,
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
    expect(LEGACY_DEFAULT_SHORTCUTS.region).toBe(`${HYPER}+1`);
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

  test("the screenshot family is bindable now — it is the default (STC-415)", () => {
    // The app defaults to ⇧⌘3/4 like CleanShot, which needs a Mac with the
    // system shortcuts off. `globalShortcut.register` stays the authority.
    for (const n of ["3", "4", "5", "6"]) {
      expect(parseAccelerator(`Command+Shift+${n}`).ok).toBe(true);
      expect(parseAccelerator(`ctrl+shift+cmd+${n}`).ok).toBe(true);
    }
    // What stays reserved is what stays reserved.
    expect(parseAccelerator("Command+Space")).toEqual({ ok: false, problem: "reserved" });
    expect(parseAccelerator("Command+Q")).toEqual({ ok: false, problem: "reserved" });
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
    const p = plan({ window: "cmd+SHIFT+4" });
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
    // A recorded chord goes through the same grammar as a typed one, which is
    // why this returns an accelerator rather than a verdict.
    const recorded = stroke("Digit4", { metaKey: true, shiftKey: true });
    expect(recorded).toBe("Shift+Command+4");
    expect(parseAccelerator(recorded!)).toEqual({ ok: true, accelerator: "Shift+Command+4" });
    // ...while a binding that is still reserved is refused there too.
    expect(parseAccelerator(stroke("Space", { metaKey: true })!))
      .toEqual({ ok: false, problem: "reserved" });
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
    const stored: Shortcuts = { ...LEGACY_DEFAULT_SHORTCUTS };
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

  test("Record's default is ⇧⌘8, not the ⇧⌘6 that collided with Siri (STC-415)", () => {
    expect(DEFAULT_SHORTCUTS.record).toBe("Shift+Command+8");
    expect(SUPERSEDED_DEFAULT_SHORTCUTS.record).toContain("Shift+Command+6");
    expect(parseAccelerator(DEFAULT_SHORTCUTS.record!)).toEqual({
      ok: true, accelerator: "Shift+Command+8",
    });
  });

  test("every default is ⇧⌘+<digit>, one digit each, and plans without a problem", () => {
    const digits = BINDABLE_ACTIONS.map((a) => {
      const acc = DEFAULT_SHORTCUTS[a];
      expect(acc, `${a} has no default binding`).toBeTruthy();
      const m = /^Shift\+Command\+(\d)$/.exec(acc!);
      expect(m, `${a}'s default is not Shift+Command+<digit>: ${acc}`).not.toBeNull();
      return Number(m![1]);
    });
    expect(new Set(digits).size).toBe(digits.length);
    for (const p of planShortcuts(DEFAULT_SHORTCUTS)) expect(p.problem, p.action).toBeUndefined();
    // CleanShot's own row: area 4, fullscreen 3.
    expect(DEFAULT_SHORTCUTS.region).toBe("Shift+Command+4");
    expect(DEFAULT_SHORTCUTS.display).toBe("Shift+Command+3");
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

describe("the capture-time outcome variants (STC-415)", () => {
  test("⌃ adds the clipboard outcome and ⌥ the editor, in canonical order", () => {
    expect(OUTCOME_MODIFIERS).toEqual({ clipboard: "Control", editor: "Alt" });
    expect(outcomeAccelerator("Shift+Command+4", "clipboard")).toBe("Control+Shift+Command+4");
    expect(outcomeAccelerator("Shift+Command+4", "editor")).toBe("Alt+Shift+Command+4");
    // However the base was spelled, the variant is the normalised string.
    expect(outcomeAccelerator("cmd+shift+4", "editor")).toBe("Alt+Shift+Command+4");
  });

  test("a binding that already holds the modifier has no variant — HYPER has all four", () => {
    for (const o of OUTCOMES) expect(outcomeAccelerator(`${HYPER}+1`, o)).toBeUndefined();
    expect(outcomeAccelerator("Control+Shift+Command+4", "clipboard")).toBeUndefined();
    expect(outcomeAccelerator("Control+Shift+Command+4", "editor")).toBe("Control+Alt+Shift+Command+4");
  });

  test("an unparseable base has no variant", () => {
    expect(outcomeAccelerator("nonsense", "clipboard")).toBeUndefined();
  });

  test("every default shot gets both variants; Record gets none", () => {
    const v = planOutcomeVariants(planShortcuts(DEFAULT_SHORTCUTS));
    expect(v.map((x) => x.action)).not.toContain("record");
    for (const action of SHOT_ACTIONS) {
      for (const outcome of OUTCOMES) {
        const hit = v.find((x) => x.action === action && x.outcome === outcome);
        expect(hit, `${action}/${outcome}`).toBeDefined();
        expect(hit!.problem, `${action}/${outcome}`).toBeUndefined();
        expect(hit!.accelerator).toBe(outcomeAccelerator(DEFAULT_SHORTCUTS[action]!, outcome));
      }
    }
    // Every registered accelerator, bases and variants, is distinct.
    const all = [
      ...planShortcuts(DEFAULT_SHORTCUTS).map((p) => p.accelerator),
      ...v.map((x) => x.accelerator),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("on the old hyperkey defaults every variant is reported as held, never registered", () => {
    const v = planOutcomeVariants(planShortcuts(LEGACY_DEFAULT_SHORTCUTS));
    expect(v.length).toBe(SHOT_ACTIONS.length * OUTCOMES.length);
    for (const x of v) expect(x).toMatchObject({ accelerator: null, problem: "held" });
  });

  test("a variant that lands on another action's binding is dropped, the base wins", () => {
    // window is bound to what region's clipboard variant would be.
    const plans = planShortcuts({ ...DEFAULT_SHORTCUTS, window: "Control+Shift+Command+4" });
    const v = planOutcomeVariants(plans);
    expect(v.find((x) => x.action === "region" && x.outcome === "clipboard"))
      .toMatchObject({ accelerator: null, problem: "duplicate" });
    expect(plans.find((p) => p.action === "window")!.accelerator).toBe("Control+Shift+Command+4");
  });

  test("an unbound or refused base has no variants", () => {
    const v = planOutcomeVariants(planShortcuts({ ...DEFAULT_SHORTCUTS, region: null, window: "Command+Space" }));
    expect(v.some((x) => x.action === "region" || x.action === "window")).toBe(false);
  });
});

describe("what a variant's line says (STC-415)", () => {
  const variant = (o: Partial<OutcomeVariantReport> = {}): OutcomeVariantReport => ({
    action: "region", outcome: "clipboard", accelerator: "Control+Shift+Command+4", registered: false, ...o,
  });

  test("a live variant has nothing to explain", () => {
    expect(explainVariant(variant({ registered: true }))).toBeUndefined();
  });

  test("a held modifier names the modifier and the variant it costs", () => {
    expect(explainVariant(variant({ outcome: "clipboard", accelerator: null, problem: "held" })))
      .toMatch(/⌃.*to clipboard/);
    expect(explainVariant(variant({ outcome: "editor", accelerator: null, problem: "held" })))
      .toMatch(/⌥.*to editor/);
  });

  test("every problem has its own sentence, and an unknown one is still not silent", () => {
    const said = (["held", "duplicate", "unavailable", undefined] as const)
      .map((problem) => explainVariant(variant({ problem })));
    for (const m of said) expect(m).toBeTruthy();
    expect(new Set(said).size).toBe(said.length);
    expect(explainVariant(variant({ problem: "unavailable" }))).toMatch(/Something else/);
    expect(explainVariant(variant({ problem: "duplicate" }))).toMatch(/Another binding/);
  });

  test("both outcomes have a label", () => {
    for (const o of OUTCOMES) expect(OUTCOME_LABELS[o]).toBeTruthy();
  });
});

describe("superseded defaults (STC-415)", () => {
  test("every superseded default is a real accelerator and none is a current default", () => {
    for (const a of BINDABLE_ACTIONS) {
      expect(SUPERSEDED_DEFAULT_SHORTCUTS[a].length, a).toBeGreaterThan(0);
      for (const old of SUPERSEDED_DEFAULT_SHORTCUTS[a]) {
        expect(parseAccelerator(old).ok, `${a}: ${old}`).toBe(true);
        expect(old, `${a} still ships ${old}`).not.toBe(DEFAULT_SHORTCUTS[a]);
      }
    }
  });
});
