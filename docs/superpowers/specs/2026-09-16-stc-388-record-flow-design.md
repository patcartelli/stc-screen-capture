# STC-388 — Record flow: one hotkey, scope → options → record → countdown

**Date:** 2026-09-16
**Branch:** `accounts/stc-388-record-flow` (off `origin/master` @ `c6a3937`)
**Linear:** [STC-388](https://linear.app/studio-cartelli/issue/STC-388)

## What this changes

A recording can only be started from the main window's Record button, and it
records whatever the window's sticky Scope picker last pointed at. This ticket
replaces that with one flow, identical from all three entry points (window
button, menu-bar item, hotkey):

```
scope  →  options  →  Record  →  countdown  →  recording
(fresh)   (bar on      (button)   (STC-391)
          the marquee)
```

Nothing about the scope is remembered between takes. That is the point of the
ticket, not an incidental consequence: sticky scope was rejected outright, and
"use my current scope" with it.

## What the ticket got wrong, and why it matters

STC-388 was written against `CAPTURE_ACTIONS` and `app/src/tray-menu.ts:53`.
Both moved in STC-398 (`c6a3937`), which landed between the ticket being
rewritten and this branch starting — and it moved them in exactly the direction
this ticket needs:

> `ShotAction` (STC-398) is the better name for exactly that reason: it names
> the OUTCOME rather than the timing, and all four produce a shot. … Motion
> stays "Record".

So the structural work the ticket describes is smaller than it feared. `record`
is not a fifth `ShotAction`. It is a second kind of bindable action beside them,
and the seam for it is already named.

## Non-negotiables this inherits

* `render(project, events, t) → FrameState` is untouched. Nothing here reaches
  the transform.
* The helper is a producer to spec; no schema changes, and `start` keeps the
  parameters it already takes (`displayId` + `region`, or `windowId`).
* Read from stored preferences, never from a renderer-supplied value — see §3
  for how this survives the flow moving into the overlay.

---

## 1. The action model

### The problem

Three lists would now describe one ordering: `SHOT_ACTIONS`, a new record-aware
list, and the numeric defaults (`HYPER+1`…`HYPER+5`). CLAUDE.md names this:

> **A restated type, enum or ordering convention is a copy too.** A list written
> in the reader's order, compared in the code's order, matches nothing and looks
> implemented.

### The shape

One ordered list owns the order; everything else derives from it.

```ts
export const BINDABLE_ACTIONS = [
  "region", "window", "display", "record", "self-timer",
] as const;

export type BindableAction = (typeof BINDABLE_ACTIONS)[number];
export type RecordAction   = "record";
export type ShotAction     = Exclude<BindableAction, RecordAction>;

export function isShotAction(a: BindableAction): a is ShotAction {
  return a !== "record";
}

/** Derived, never restated — the one place the shot subset is decided. */
export const SHOT_ACTIONS: readonly ShotAction[] =
  BINDABLE_ACTIONS.filter(isShotAction);
```

`ShotAction` resolves to `"region" | "window" | "display" | "self-timer"` —
character-for-character what it is today. The values are what `settings.json`
binds against, so **no settings migration**, which is the acceptance criterion
STC-398 already set for itself.

`Shortcuts`, `ACTION_LABELS` and `planShortcuts` widen to `BindableAction`.
`captureStill` keeps taking `ShotAction`, so the typechecker refuses to hand it
`record` — the narrowing is load-bearing, not decorative.

```ts
export const ACTION_LABELS: Record<BindableAction, string> = {
  region: "Shot Area", window: "Shot Window", display: "Shot Full Display",
  record: "Record",
  "self-timer": "Shot with Self-Timer",
};

export const DEFAULT_SHORTCUTS: Shortcuts = {
  region: `${HYPER}+1`, window: `${HYPER}+2`, display: `${HYPER}+3`,
  record: `${HYPER}+4`,
  "self-timer": `${HYPER}+5`,
};
```

`HYPER+4` is the slot STC-391 deliberately left open, in a comment naming this
ticket.

### The guard

`BINDABLE_ACTIONS`' order is also the order preferences lists actions in, and
the order `planShortcuts` resolves duplicates in (first claimant keeps the key).
It is therefore load-bearing and can drift from the defaults silently. The test
asserts the two agree:

> For every action whose default is `HYPER+N`, `N` ascends in
> `BINDABLE_ACTIONS` order.

That fires if someone appends an action to the list but numbers it in the
middle, or renumbers a default without moving it. Per CLAUDE.md's rule that a
structural guard must be able to fire, it is checked against a planted
violation, not just observed green.

---

## 2. The overlay's second phase

### Why it is one window and not two

The bar carries W×H and expand-to-full-display, so the marquee stays live while
options are set. A separate panel window would mean the rect exists in two
places and is mirrored between them on every adjustment — CLAUDE.md's most
repeated defect, in its second variant:

> **Two halves of one answer decided in different places** … Every local check
> passes while the pair disagrees.

There is also a concrete precedent for the other half of the cost: `5850e4f`,
where the countdown panel never had focus because the app was activating
instead. A second focusable window in this flow would be the same hazard again.

So: one overlay window stack, one reducer, one broadcast.

### `selection.ts` — unchanged

It already handles both modes, the spacebar window pick, and all eight resize
handles. It stays pure and untouched. Its `confirm` still produces a
`SelectionOutcome`; what changes is only what the *session* does with one.

### `record-options.ts` — new, pure, headless

Decisions only, in the arrangement `selection.ts` and `overlay-hittest.ts`
already establish. `app/test/record-options.test.ts` exercises it with no
screen, no pointer and no Electron.

```ts
export type ControlId =
  | "size" | "expand" | "mic" | "camera" | "record";

export interface OptionsState {
  micDeviceUid: string | null;
  camera: boolean;
  /** Devices offered by the mic menu; empty disables the control. */
  mics: readonly MicDevice[];
  /**
   * Set by the `expand` control, NOT inferred from the marquee's geometry.
   *
   * `SelectionOutcome` has only `region` and `window` kinds, so "the whole
   * display" has no representation in it — and the two candidate encodings are
   * not equivalent downstream: `{ displayId, region }` covering the full screen
   * takes the helper's crop path, while a bare `{ displayId }` takes its
   * full-display path. Deriving this from "does the rect equal the display
   * bounds" would be a second rule for one answer, and would silently reclassify
   * a user who happened to drag to the edges. So it is a flag the control sets,
   * and `startParams` omits `region` when it is set.
   */
  fullDisplay: boolean;
}

/** Where the bar sits, in GLOBAL points. */
export function barLayout(
  selection: Rect, display: DisplayInfo, metrics: BarMetrics,
): BarLayout;

/** Which control a press landed on, or undefined for none. */
export function controlAt(p: Point, layout: BarLayout): ControlId | undefined;

/** Whether a control can be pressed, and why not when it cannot. */
export function controlEnabled(id: ControlId, s: OptionsState): boolean;
```

`barLayout` is where the tests earn their keep. The rules, stated so they can be
asserted individually rather than as one blob:

1. **Below the marquee by default**, horizontally centred on it.
2. **Flips above** when below would not fit inside the display.
3. **Never overlaps the marquee** in either of those placements. Asserted
   separately from rules 1–2, because a flip that lands on top of the selection
   satisfies "fits on screen" and still hides what is being recorded.
4. **Falls back to `inside`** — anchored to the selection's bottom inner edge
   and clamped to the display — when neither below nor above fits. A marquee
   covering the whole display leaves nowhere that satisfies rule 3, so rule 3
   cannot be absolute; making the fallback an explicit third `placement` keeps
   that honest and lets the view style it, rather than silently producing a bar
   half off the screen with an unreachable Record button. The test asserts
   `inside` appears **only** when neither other placement fits.

Per CLAUDE.md, the composition is asserted, not the magnitude: each term is
named and required, then mutated to watch the assertion fail.

### `overlay-session.ts` — a purpose, and a phase

```ts
export interface OpenOptions {
  // …existing…
  /** A shot resolves on confirm, as today. A record advances to the options
   *  bar and resolves on Record. */
  purpose: "shot" | "record";
}

export interface OverlayResult {
  outcome: SelectionOutcome;
  excludeWindowIds: number[];
  /** Present only when `purpose` was "record". */
  options?: OptionsState;
}
```

The marquee stays fully interactive through the options phase — all eight
handles, the move gesture and the arrow-key nudges keep working, and the bar's
W×H readout and placement follow every change. That is the whole reason the bar
lives in this window (§2), so "the selection is still adjustable" is a
requirement of the phase, not an incidental property of it.

`runRecordFlow` returns:

```ts
type RecordResult =
  | { ok: true; dir: string; info: unknown }
  | { ok: false; cancelled: true }
  | { ok: false; code: string; detail?: string };
```

`purpose: "shot"` is today's behaviour byte-for-byte, so the still paths cannot
regress. The options phase waits on a human with no timeout, which makes it the
third **deliberately unbounded wait** in the app and it will say so in a comment
naming why — CLAUDE.md requires every wait to carry a bound and a reason, and
the two existing unbounded waits already follow this convention.

---

## 3. The flow lives in main

### One function, three doors

```ts
async function runRecordFlow(source: RecordSource): Promise<RecordResult>
```

`RecordSource` is `"window" | "menu-bar" | "hotkey"`, mirroring `CaptureSource`.
This is the arrangement `captureStill` already documents for itself:

> A FUNCTION, not just an IPC handler … so there is one capture path with three
> doors rather than three implementations that can drift.

### Why the preference invariant survives

`recorder:start` today reads scope from settings, with a comment explaining that
a renderer-supplied value would be a second source of truth for what the helper
is pointed at. Scope is now per-take, so it cannot come from settings — but it
does **not** come from the renderer either. The overlay is owned by the main
process, so the outcome is already in main's hands when `startRecording` is
called. The renderer's Record button becomes a bare trigger carrying no
parameters at all, which is a stronger position than the one the comment
defends.

`camera` and `micDeviceUid` stay sticky settings and are still read from
storage; the bar writes them back when changed. Only *scope* is per-take.

### Order of operations

```
1. guard      recording? → stop (§4). capturing/overlay/countdown? → refuse
2. windows    helper `windows` (failure is non-fatal: region mode needs no list)
3. overlay    openOverlay({ purpose: "record", … })  → outcome + options
              cancelled → return { ok: false, cancelled: true }
4. close      closeOverlay(), AWAITED
5. persist    writeSettings({ camera, micDeviceUid }) if the bar changed them
6. countdown  runCountdown({ purpose: "record" }) — always (STC-391)
              not fired → return { ok: false, cancelled: true }
7. panel      closeThumbnail()
8. start      newTempTakeDir() → sup.startRecording(dir, startParams)
```

Step 4 is awaited before step 6, and both precede step 8, because — unlike a
still capture — `start` has no `excludeWindowIds` for the overlay to be added
to. The existing code already reasons this way about the floating panel:

> Any floating panel still on screen would be IN the take, and unlike a still
> capture there is no exclusion list for `start` to be added to.

`startParams` is built from the overlay outcome and `options.fullDisplay`:
`{ windowId }` for a window; otherwise `{ displayId }`, plus `region` **only
when `fullDisplay` is unset**. One expression, so the crop path and the
full-display path cannot be chosen by two different rules.
The `no-capture-target` refusal disappears — it existed only because a sticky
scope could name nothing, and a fresh selection always names something.

---

## 4. Toggle-to-stop

`⌃⌥⇧⌘4`, in priority order:

| State | Effect |
|---|---|
| `sup.state === "recording"` | stop the take |
| a **Record** flow is in flight | cancel it (`closeOverlay` / `cancelCountdown`) |
| otherwise | `runRecordFlow("hotkey")` |

The tray item follows the same state, reading **"Stop Recording"** mid-take, so
`TrayContext` gains `recording?: boolean` beside its existing `busy`.

### The latent hazard, named

CLAUDE.md:

> **A feature can make a LATENT hazard reachable.** When a change makes
> something possible that was not before, ask what the old code relied on being
> *impossible*.

The old code relied on there being no way to interrupt an in-flight capture from
a hotkey. There now is. So the middle row above is scoped deliberately: it
cancels **only a Record flow**. With a Shot overlay or a self-timer countdown
open, `⌃⌥⇧⌘4` stays refused as `capture-in-flight`, exactly as today — ending
someone's self-timer with the Record key is not what "Record toggles" means.
This requires the session to know which flow owns the overlay, which
`purpose` already records.

---

## 5. Removals

| Removed | Why |
|---|---|
| `Settings.scope`, `ScopeSettings`, `cleanScope`, `DEFAULT_SCOPE_SETTINGS` | scope is per-take |
| renderer scope picker, source labels, clear buttons, `scopeHasTarget`, `renderScope` | ditto |
| `recorder:pickCaptureTarget` IPC + `pickCaptureTarget()` | the flow picks its own scope |
| `scope-indicator.ts`, `scope-indicator-window.ts` | dead once nothing flashes |
| `app/test/scope-picker.e2e.test.ts`, `scope-indicator.test.ts`, `scope-indicator.e2e.test.ts` | their subjects are gone |
| `no-capture-target` refusal code | unreachable |

An old `settings.json` keeps a stray `scope` key. `cleanSettings` builds a fresh
document field by field and simply never reads it, so there is nothing to
migrate and nothing left to drift.

**STC-381 is retired, not merely unwired.** The ticket asks whether its
indicator still makes sense once scope is fresh every take; the answer is no.
The marquee was on screen a moment earlier and the countdown is about to be — a
third confirmation between them is noise. This is recorded here because deleting
a shipped feature should be legible in the design, not discovered in a diff.

---

## 6. Tests

| File | Covers |
|---|---|
| `app/test/record-options.test.ts` *(new)* | `barLayout` rules 1–4 each asserted separately; `controlAt` hit-testing; `controlEnabled` with no mics; `fullDisplay` set by `expand` and **not** by a marquee that merely happens to match the display bounds |
| `app/test/hotkeys.test.ts` | `record` in `BINDABLE_ACTIONS`; `SHOT_ACTIONS` derives correctly; list order vs. numeric defaults; `planShortcuts` covers `record`; duplicate resolution |
| `app/test/tray-menu.test.ts` | Record item present with its accelerator; "Stop Recording" when `recording`; disabled when `busy` |
| `app/test/settings.test.ts` | an old file gains the `record` default; a stray `scope` key is ignored |
| `app/test/record-flow.e2e.test.ts` *(new)* | overlay opens from the Record button; options phase appears; Record → countdown → `startRecording`; Esc at each phase |

Every new bound is checked against the bounds already covering the same code, not
only against what it bounds — three bounds added in one day here each failed to
fire. The E2E's own timeout must exceed the bounds waiting inside it (`bc9faaf`).

`tsconfig.json`'s `include` must cover `record-options.ts`, or it gets no static
checking at all rather than weaker checking.

---

## 7. Out of scope, and the follow-ups this files

Untouched, per the ticket: countdown component (STC-391, merged), floating panel
(STC-392), GIF (STC-395), All-In-One.

Three of the options bar's seven named controls do not exist anywhere in the
codebase and are each their own ticket:

| Control | State found | Why it is its own ticket |
|---|---|---|
| **System audio** | no code in app, helper or transform | a helper-side SCK + `AVAssetWriter` audio-path feature |
| **Show keystrokes** | nothing, anywhere | helper capture *and* transform render, plus a schema |
| **Show clicks** | `compositor.ts` draws the highlight unconditionally | needs a setting, a `FrameState` flag and a transform change |

`record-options.ts` is built so each arrives as one entry in the control list
and one placement term, not a redesign of the bar.

## 8. Risks

1. **The mic menu is custom-drawn.** A transparent overlay cannot host a native
   `<select>`. The menu is drawn by `overlay.ts` and hit-tested by
   `record-options.ts`. Mitigated by keeping it a flat list of devices with no
   submenus; if it proves awkward on hardware, it is the one part that could
   move to a panel without disturbing the rect.
2. **Two surfaces now read `purpose`.** The session and the hotkey handler both
   branch on whether a Record flow owns the overlay. One owner
   (`overlay-session.ts`), queried — never a second copy of the answer.
3. **Only hardware can settle** whether the bar's placement reads well against a
   marquee near a screen edge, and whether the flow feels like one gesture.
   A runbook (`docs/STC-388-RUNBOOK.md`) carries those.
