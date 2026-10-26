/**
 * Global capture shortcuts (STC-292) — the decisions, with no Electron and no
 * DOM.
 *
 * Same arrangement `selection.ts` has for the overlay: everything that DECIDES
 * — what an accelerator string means, whether it is well formed, whether macOS
 * has already claimed it, what the user's keystroke should be recorded as, and
 * how a registration failure is worded — lives here and is exercised by
 * `app/test/hotkeys.test.ts` without a screen, a keyboard or an app. `main.ts`
 * registers what this plans; it does not repeat the reasoning.
 *
 * ## Why registration cannot be the only check
 *
 * `globalShortcut.register` returns false when the binding is already taken,
 * and that IS the authority — but it can only be consulted by trying, and a
 * user rebinding in preferences deserves to be told "the system owns ⌘⇧4"
 * before anything is attempted, rather than watching a field accept a binding
 * that then silently never fires. So there are two gates: this module refuses
 * what is knowably wrong, and `main.ts` reports what registration then refused
 * anyway. The report distinguishes them, because "you cannot have this" and
 * "something on this machine already has this" are different problems with
 * different fixes.
 *
 * ## Why media keys are refused rather than passed through
 *
 * The ticket's permission requirement is that a still capture must work with
 * only Screen Recording granted. Electron registers ordinary accelerators
 * through Carbon's `RegisterEventHotKey`, which needs no Accessibility grant;
 * media keys (Play, Volume, Brightness…) go through a CGEventTap instead,
 * which does. A binding that quietly demands a second permission would fail
 * exactly the acceptance criterion this ticket exists for, so it is refused at
 * the point where the user can still choose something else.
 */

/**
 * What a global shortcut can be bound to.
 *
 * ONE ordered list, and everything else derives from it. The order is
 * load-bearing twice: it is the order preferences lists actions in, and the
 * order `planShortcuts` resolves duplicates in (first claimant keeps the key).
 * A second hand-written list in a different order would be CLAUDE.md's
 * restated-ordering trap — "a list written in the reader's order, compared in
 * the code's order, matches nothing and looks implemented" — so `SHOT_ACTIONS`
 * is filtered from this rather than typed out again.
 *
 * `record` (STC-388) is the first member that does not produce a shot, which is
 * why the shot-only list still has to exist: `captureStill` takes a
 * `ShotAction` and the typechecker must refuse to hand it `record`.
 *
 * The VALUES are the ids `settings.json` stores bindings against. The four shot
 * ids may not be renamed without a settings migration; `record` is new here and
 * is frozen from this commit on.
 */
export const BINDABLE_ACTIONS = [
  "region", "window", "display", "record", "self-timer",
] as const;

export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

/** Motion. Exactly one member, named so the shot type can Exclude it. */
export type RecordAction = "record";

/**
 * Stills (STC-398): it names the OUTCOME rather than the timing, and all four
 * produce a shot — `self-timer` after a countdown, the rest immediately.
 */
export type ShotAction = Exclude<BindableAction, RecordAction>;

export function isShotAction(a: BindableAction): a is ShotAction {
  return a !== "record";
}

/** DERIVED, never restated — see `BINDABLE_ACTIONS`. */
export const SHOT_ACTIONS: readonly ShotAction[] = BINDABLE_ACTIONS.filter(isShotAction);

/**
 * What each action is CALLED (STC-398).
 *
 * "Shot", not "Capture": the app itself is now called Capture (STC-397), so
 * the stills mode cannot also be — one word would name both the product and
 * one of the two things it does. "Shot" follows macOS's own screenshot
 * language, and it is what this codebase has called the artefact all along
 * (`shot.json`, `parseShot`, the `Shot` type), so the UI now agrees with the
 * data model rather than contradicting it. Motion stays "Record".
 *
 * These are LABELS only. The action ids they key off (`region`, `window`,
 * `display`, `record`, `self-timer` — STC-388 review, Finding 10: `record`
 * belongs in this list too now, not just the original four `ShotAction`s)
 * are unchanged and are what `settings.json` persists a user's bindings
 * against — renaming a label cannot cost anyone a hotkey, which is this
 * ticket's own acceptance criterion.
 *
 * "Area" rather than "Region": STC-374 had a Scope picker in the main window
 * that called the same rectangle Area, and this matched it. STC-388 deleted
 * that picker outright (task 6, "remove the sticky scope"), so the
 * justification is gone — "Area" stays anyway, since it is still the better
 * word and nothing needs re-litigating, but nothing in the main window
 * governs this label's naming any more.
 */
export const ACTION_LABELS: Record<BindableAction, string> = {
  region: "Shot Area",
  window: "Shot Window",
  display: "Shot Full Display",
  // "Record", bare: STC-398 settled that motion keeps this word while stills
  // became "Shot", so it needs no qualifier to be unambiguous in the menu.
  record: "Record",
  // Named for what it does rather than for the countdown it shows: the
  // countdown is the mechanism, "with a delay" is the reason anyone reaches
  // for it. It is one shot, not a mode that stays on (STC-391).
  "self-timer": "Shot with Self-Timer",
};

/** `null` is a deliberately unbound action, which is not a failure. */
export type Shortcuts = Record<BindableAction, string | null>;

/**
 * All four modifiers at once — what a caps-lock "hyperkey" remap sends.
 *
 * The defaults until STC-415. It stays exported for two reasons: a settings
 * file that still holds exactly this set is an UNTOUCHED set and moves to
 * `DEFAULT_SHORTCUTS` (`LEGACY_DEFAULT_SHORTCUTS`, `settings.ts`), and a
 * rebinding to it is as valid as any other.
 */
export const HYPER = "Control+Alt+Shift+Command";

/**
 * What a fresh install binds (STC-415): CleanShot's own row, ⇧⌘3 / ⇧⌘4, with
 * the gaps filled beside it. Moved off HYPER because the capture-time outcome
 * variants (`OUTCOME_MODIFIERS`) ADD a modifier to a binding, and a base that
 * already holds all four has nothing left to add.
 *
 * `window` is 2 and `self-timer` is 7 so 2/3/4 read as window / display /
 * area and 6 stays Record's, with 5 left free for an "all-in-one" later.
 */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  region: "Shift+Command+4",
  window: "Shift+Command+2",
  display: "Shift+Command+3",
  record: "Shift+Command+6",
  "self-timer": "Shift+Command+7",
};

/**
 * The pre-STC-415 defaults, kept only to recognise an untouched settings file
 * (`settings.ts`'s `cleanShortcuts`). Never bound by anything but that check.
 */
export const LEGACY_DEFAULT_SHORTCUTS: Shortcuts = {
  region: `${HYPER}+1`,
  window: `${HYPER}+2`,
  display: `${HYPER}+3`,
  record: `${HYPER}+4`,
  "self-timer": `${HYPER}+5`,
};

// ── the accelerator grammar ─────────────────────────────────────────────────

/** Canonical order, so two spellings of one binding compare equal. */
const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Command"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  command: "Command", cmd: "Command", meta: "Command", super: "Command",
  commandorcontrol: "Command", cmdorctrl: "Command",
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt", opt: "Alt",
  shift: "Shift",
};

/** Named keys Electron accepts that this app is willing to bind. */
const NAMED_KEYS: Record<string, string> = {
  space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete",
  insert: "Insert", return: "Return", enter: "Return",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  escape: "Escape", esc: "Escape", plus: "Plus",
};

/** Punctuation Electron takes literally. */
const PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/**
 * Keys Electron can only register through a CGEventTap, which needs an
 * Accessibility grant. Refused by name so the refusal can say why.
 */
const MEDIA_KEYS = new Set([
  "medianexttrack", "mediaprevioustrack", "mediastop", "mediaplaypause",
  "volumeup", "volumedown", "volumemute",
]);

export type ShortcutProblem =
  | "empty"
  | "no-modifier"
  | "no-key"
  | "too-many-keys"
  | "unknown-token"
  | "needs-accessibility"
  | "reserved"
  | "duplicate"
  /** Set by main.ts, never by this module: `globalShortcut.register` said no. */
  | "unavailable";

export type ParsedAccelerator =
  | { ok: true; accelerator: string }
  | { ok: false; problem: Exclude<ShortcutProblem, "duplicate" | "unavailable">; token?: string };

/**
 * Bindings macOS owns.
 *
 * Deliberately SHORT and deliberately not exhaustive — a full map of every
 * system binding would be wrong within one macOS release and would read as
 * authoritative. This is the set worth refusing before the user has pressed
 * anything else: the switchers whose loss would be immediately confusing. Everything else is left
 * to `globalShortcut.register`, which is the real authority and is reported.
 */
export const SYSTEM_CLAIMED: readonly string[] = [
  // STC-415: ⌘⇧3/4/5/6 and their ⌃ clipboard variants used to be here. They
  // are macOS's screenshot family and this app now defaults to them, which
  // only works on a Mac where those system shortcuts are switched off (the
  // CleanShot arrangement). `globalShortcut.register` stays the authority: if
  // macOS still holds one it returns false and preferences says "something
  // else on this Mac already holds this shortcut".
  // Spotlight, the character/emoji viewer, the app switcher, quit.
  "Command+Space", "Control+Space", "Alt+Command+Space",
  "Control+Command+Space",
  "Command+Tab", "Shift+Command+Tab",
  "Command+Q",
];

/**
 * Normalised at load, not written normalised.
 *
 * The list above reads in Apple's own order (⌘⇧4), which is NOT this module's
 * canonical order (Control, Alt, Shift, Command) — so written as literals the
 * entries matched nothing and every system binding was quietly accepted. Caught
 * by `hotkeys.test.ts` on its first run. Normalising here means the list can be
 * written however it reads best and still be compared against the one form
 * `parseAccelerator` produces.
 */
const claimed = new Set(SYSTEM_CLAIMED.map((a) => {
  const n = normalise(a);
  // A typo in the list would otherwise be an entry that silently never matches
  // — the same failure, one level up.
  if (!n.ok) throw new Error(`SYSTEM_CLAIMED entry is not an accelerator: ${a}`);
  return n.accelerator;
}));

/**
 * `"cmd+shift+A"` → `"Shift+Command+A"`, or the reason it is not a binding.
 *
 * Case-insensitive and alias-tolerant on the way in, canonical on the way out,
 * so a stored preference, a keystroke recorded in the UI and a default all
 * compare as strings.
 */
export function parseAccelerator(input: string): ParsedAccelerator {
  const n = normalise(input);
  if (!n.ok) return n;
  if (claimed.has(n.accelerator)) return { ok: false, problem: "reserved" };
  return n;
}

/** The grammar alone, with no reserved check — which is what builds the
 * reserved set itself, and could not consult it without recursing. */
function normalise(input: string): ParsedAccelerator {
  const raw = String(input ?? "").trim();
  if (raw === "") return { ok: false, problem: "empty" };

  const mods = new Set<Modifier>();
  const keys: string[] = [];
  for (const part of raw.split("+")) {
    const token = part.trim();
    if (token === "") return { ok: false, problem: "unknown-token", token: part };
    const lower = token.toLowerCase();
    const mod = MODIFIER_ALIASES[lower];
    if (mod) { mods.add(mod); continue; }
    if (MEDIA_KEYS.has(lower)) return { ok: false, problem: "needs-accessibility", token };
    const key = canonicalKey(token);
    if (!key) return { ok: false, problem: "unknown-token", token };
    keys.push(key);
  }

  if (keys.length === 0) return { ok: false, problem: "no-key" };
  if (keys.length > 1) return { ok: false, problem: "too-many-keys", token: keys.join("+") };
  // A bare key registered globally would swallow that key for every app on the
  // machine — never what someone means, and not something to let them discover.
  if (mods.size === 0) return { ok: false, problem: "no-modifier" };

  return { ok: true, accelerator: [...MODIFIER_ORDER.filter((m) => mods.has(m)), keys[0]].join("+") };
}

function canonicalKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower];
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return "F" + lower.slice(1);
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (token.length === 1 && PUNCTUATION.has(token)) return token;
  return undefined;
}

// ── planning a whole set ────────────────────────────────────────────────────

export interface ShortcutPlan {
  action: BindableAction;
  /** The normalised accelerator when it is bindable; otherwise what was asked
   * for, verbatim, so the UI can show the user their own text back. */
  accelerator: string | null;
  /** `undefined` means bindable. */
  problem?: ShortcutProblem;
  /** The offending token, when there is one worth naming. */
  token?: string;
}

/**
 * What each action would bind to, before anything is registered.
 *
 * Duplicates are resolved in `BINDABLE_ACTIONS` order rather than rejected on
 * both sides: two actions on one key can only fire one of them, and silently
 * letting the pair through would give the user a binding whose behaviour
 * depends on registration order.
 */
export function planShortcuts(s: Shortcuts): ShortcutPlan[] {
  const taken = new Set<string>();
  return BINDABLE_ACTIONS.map((action): ShortcutPlan => {
    const wanted = s[action];
    if (wanted == null || wanted === "") return { action, accelerator: null };
    const parsed = parseAccelerator(wanted);
    if (!parsed.ok) {
      return { action, accelerator: wanted, problem: parsed.problem, ...(parsed.token ? { token: parsed.token } : {}) };
    }
    if (taken.has(parsed.accelerator)) {
      return { action, accelerator: parsed.accelerator, problem: "duplicate" };
    }
    taken.add(parsed.accelerator);
    return { action, accelerator: parsed.accelerator };
  });
}

/**
 * One outcome variant after registration (STC-415). `problem` is the plan's
 * own ("held", "duplicate") or "unavailable" once the system refused it.
 */
export interface OutcomeVariantReport {
  action: ShotAction;
  outcome: Outcome;
  accelerator: string | null;
  problem?: "held" | "duplicate" | "unavailable";
  registered: boolean;
}

/** A plan plus what registration actually did with it. */
export interface ShortcutReport extends ShortcutPlan {
  registered: boolean;
  /** A shot's ⌃/⌥ variants, absent when the base has none (unbound, refused, Record). */
  variants?: OutcomeVariantReport[];
}

/** What a variant is CALLED in preferences. */
export const OUTCOME_LABELS: Record<Outcome, string> = {
  clipboard: "To clipboard",
  editor: "To editor",
};

/**
 * The one line preferences shows beside a variant: "Active" is the caller's,
 * this is only the reason it is not. `undefined` for a registered variant.
 */
export function explainVariant(v: OutcomeVariantReport): string | undefined {
  if (v.registered) return undefined;
  switch (v.problem) {
    case "held":
      return `This shortcut already uses ${SYMBOLS[OUTCOME_MODIFIERS[v.outcome]]}, so it has no ${OUTCOME_LABELS[v.outcome].toLowerCase()} variant.`;
    case "duplicate":
      return "Another binding already uses this.";
    case "unavailable":
      return "Something else on this Mac already holds this shortcut.";
    case undefined:
      return "Not registered.";
  }
}

/**
 * The one sentence preferences shows under a binding, or `undefined` when
 * there is nothing to say.
 *
 * Here rather than in the renderer so the wording is testable and so a new
 * problem cannot be added without something failing to describe it — the
 * exhaustive switch is the check.
 */
export function explainShortcut(r: ShortcutReport): string | undefined {
  if (r.registered) return undefined;
  switch (r.problem) {
    case undefined:
    case "empty":
      return r.accelerator == null ? undefined : "Not registered.";
    case "no-modifier":
      return "Add a modifier — a bare key would be taken from every app on the machine.";
    case "no-key":
      return "Modifiers alone are not a shortcut; add a key.";
    case "too-many-keys":
      return `Only one key, plus modifiers — not “${r.token ?? ""}”.`;
    case "unknown-token":
      return `“${r.token ?? ""}” is not a key this can bind.`;
    case "needs-accessibility":
      return "Media keys need an Accessibility grant, which capture does not otherwise require.";
    case "reserved":
      return "macOS has already claimed this one.";
    case "duplicate":
      return "Another action already uses this.";
    case "unavailable":
      return "Something else on this Mac already holds this shortcut.";
  }
}

// ── the capture-time outcome (STC-415) ───────────────────────────────────────

/**
 * What a shot does once it is taken, chosen at the keystroke.
 *
 * - `clipboard`: straight to the clipboard, no panel — the "Skip it"
 *   preference, for this one capture.
 * - `editor`: promoted into the library and opened in the still editor, no
 *   panel.
 *
 * The base binding is the third, default outcome: whatever the panel
 * preference says. Not a member here because it is not a variant of anything.
 */
export const OUTCOMES = ["clipboard", "editor"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * The modifier each outcome ADDS to a shot's own binding. ⌃ is macOS's own
 * "to the clipboard" modifier on its screenshot shortcuts (⌃⇧⌘4); ⌥ is free.
 *
 * Variants are DERIVED, never stored: a stored one would be a second binding
 * to rebind, reset and migrate, and could drift from the base it belongs to.
 * Rebinding a shot moves its variants with it.
 */
export const OUTCOME_MODIFIERS: Record<Outcome, Modifier> = {
  clipboard: "Control",
  editor: "Alt",
};

/** `undefined` when the binding already holds that modifier, so there is no
 * second keystroke to derive — a HYPER binding has all four. */
export function outcomeAccelerator(base: string, outcome: Outcome): string | undefined {
  const parsed = normalise(base);
  if (!parsed.ok) return undefined;
  const parts = parsed.accelerator.split("+");
  const mod = OUTCOME_MODIFIERS[outcome];
  if (parts.includes(mod)) return undefined;
  const key = parts[parts.length - 1]!;
  const mods = new Set<string>(parts.slice(0, -1));
  mods.add(mod);
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

export interface OutcomeVariantPlan {
  action: ShotAction;
  outcome: Outcome;
  /** `null` when there is nothing to register, with `problem` saying why. */
  accelerator: string | null;
  problem?: "held" | "duplicate";
}

/**
 * Every outcome variant the bindable shots would register, resolved against
 * the whole plan: a variant that lands on another action's binding (or on an
 * earlier variant) is dropped rather than registered twice — the base
 * bindings win, because they are what the user typed.
 *
 * Only shots have variants. Record has no panel to skip, and Self-Timer's
 * variants are included: the countdown is the mechanism, the outcome is
 * still a shot's.
 */
export function planOutcomeVariants(plans: readonly ShortcutPlan[]): OutcomeVariantPlan[] {
  const taken = new Set<string>();
  for (const p of plans) if (p.problem === undefined && p.accelerator) taken.add(p.accelerator);
  const out: OutcomeVariantPlan[] = [];
  for (const p of plans) {
    if (p.problem !== undefined || !p.accelerator || !isShotAction(p.action)) continue;
    for (const outcome of OUTCOMES) {
      const accelerator = outcomeAccelerator(p.accelerator, outcome);
      if (accelerator === undefined) {
        out.push({ action: p.action, outcome, accelerator: null, problem: "held" });
      } else if (taken.has(accelerator)) {
        out.push({ action: p.action, outcome, accelerator: null, problem: "duplicate" });
      } else {
        taken.add(accelerator);
        out.push({ action: p.action, outcome, accelerator });
      }
    }
  }
  return out;
}

// ── recording a keystroke, and showing one ──────────────────────────────────

/** What the UI hands over: a `KeyboardEvent` reduced to what matters. */
export interface KeyStroke {
  /** `KeyboardEvent.code` — layout-independent, unlike `key`, which on macOS
   * turns ⌥⇧1 into an unrelated glyph. */
  code: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  Enter: "Return", NumpadEnter: "Return", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
  Slash: "/", Backquote: "`",
};

/**
 * A keystroke → an accelerator string, or `null` when the user has only
 * pressed modifiers so far (which is not an error — it is the middle of
 * pressing a chord, and the field should keep waiting).
 *
 * Returns the accelerator UNVALIDATED: `parseAccelerator` still gets the last
 * word, so a recorded ⌘⇧4 is refused by exactly the same rule as one typed in.
 */
export function acceleratorFromKeyStroke(e: KeyStroke): string | null {
  const key = keyFromCode(e.code);
  if (key === undefined) return null;
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Command");
  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), key].join("+");
}

function keyFromCode(code: string): string | undefined {
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fn = /^F([1-9]|1\d|2[0-4])$/.exec(code);
  if (fn) return code;
  return undefined;
}

const SYMBOLS: Record<string, string> = {
  Control: "⌃", Alt: "⌥", Shift: "⇧", Command: "⌘",
  Space: "Space", Return: "↩", Tab: "⇥", Escape: "⎋", Delete: "⌫",
  Backspace: "⌫", Up: "↑", Down: "↓", Left: "←", Right: "→",
};

/** `"Control+Alt+Shift+Command+1"` → `"⌃⌥⇧⌘1"`, for the UI and the menu bar. */
export function formatAccelerator(accelerator: string | null): string {
  if (!accelerator) return "—";
  return accelerator.split("+").map((t) => SYMBOLS[t] ?? t).join("");
}
