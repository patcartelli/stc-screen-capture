# STC-419: show keystrokes (keycast) — commands only

Linear: https://linear.app/studio-cartelli/issue/STC-419/show-keystrokes-render-typed-keys-into-the-export
(source of truth for the ticket; this doc records the design agreed with
Patrick on 2026-10-01 and answers the ticket's four open questions).

## Why now

STC-321 (demo #2, the Vividly walkthrough) is a keyboard-driven treegrid
demo, and its Steps list "this is the take that evaluates whether the
overlay reads". No overlay existed at any layer. Patrick's call
(2026-10-01): build this before recording that demo. STC-321 is blocked on
this ticket in Linear.

## The ticket's premise that no longer holds: permissions

STC-419 says keystrokes "almost certainly" need Accessibility. They do not,
as far as the code can show. The helper already runs a `.listenOnly`
`CGEvent.tapCreate` for cursor events (`helper/src/Capture.swift`,
`makeEventTap`), and since STC-315 that tap is REQUIRED. It is gated on
**Input Monitoring**, not Accessibility (`docs/PRE-DEMO-CHECKLIST.md`).
`keyDown` added to the same listen-only tap's mask lives under the same
grant. So the new permission cost is expected to be zero.

**Only a Mac can confirm this.** The runbook's first item is a real take
with Keys on, watching for any new TCC prompt and checking that
Accessibility still does not list the app.

## Decisions (Patrick, 2026-10-01)

| Question | Answer |
|---|---|
| Every key, or only chords? | **Commands only.** Non-printing keys plus chords. Typing is dropped **in the helper** and never reaches disk. |
| Passwords | Answered by the above. A password is typing, so no take can contain one. The schema refuses a document that could carry it (see §2). |
| Placement | **Bottom-centre of the output canvas, fixed**, drawn after the zoom crop. Customization comes later; placement lives in ONE layout function so a later project field has one place to plug in. |
| Dwell | **One key on screen, with a repeat count.** `↓`, then `↓ ×3`, then `→`, then `Return`. Visible 1.2 s after its last press, fades over 200 ms. |
| On/off | **Record bar + editor.** The Record bar's `keys` slot (sticky, default OFF) decides whether a take captures keys at all; that is STC-377's opt-in. A take that has keys gets an editor show/hide switch, saved on the project. Hiding never deletes events. |

## What counts as a "command"

This is decided in exactly one place, `helper/src/KeyDecisions.swift`
(pure, no CoreGraphics run loop, tested by `helper/test/keys/` the way
`DisplayChangeDecisions.swift` is). A `keyDown` is RECORDED when:

1. **It is a non-printing key** from the closed set below, with any
   modifiers (including none, and including Shift: `⇧Tab`, `⌥←` are
   commands), OR
2. **⌘ or ⌃ is held**, with any key that has a base character (`⌘K`,
   `⌃⌘F`, `⇧⌘4`).

Everything else is DROPPED and only counted (`keysDropped`, a stat, never a
key identity):

- A printable key with no modifier, or with only Shift. That is typing.
- A printable key with **⌥ alone, or ⌥⇧**. On macOS that is how accented
  and special characters are TYPED (`⌥e e` → é), so it is typing too.
- **Space alone** is a printable key, so it is dropped (a treegrid that
  uses Space to toggle won't show it; a stated, accepted cost).
- **Auto-repeat** (`kCGKeyboardEventAutorepeat` ≠ 0). Holding ↓ is one
  press, not thirty.
- Lone modifier presses (`flagsChanged`). These are not in the mask at all.

**The non-printing set (the `key` enum):** `ArrowUp`, `ArrowDown`,
`ArrowLeft`, `ArrowRight`, `Return`, `Enter` (keypad), `Tab`, `Escape`,
`Delete` (backspace), `ForwardDelete`, `Home`, `End`, `PageUp`,
`PageDown`, `F1`–`F12`. They are identified by virtual keycode
(`kVK_*`), so they are layout-independent.

**A chord's base character** comes from `UCKeyTranslate` against the
CURRENT keyboard layout with NO modifiers applied. That is what is printed
on the keycap, so AZERTY's ⌘A reads `⌘A`. A result that is not exactly one
printable ASCII character (U+0021–U+007E) drops the event. Letters are
upper-cased.

**Mods** are recorded as a set from `cmd`, `ctrl`, `opt`, `shift`.

## Architecture

### 1. Capture (helper)

- `start` gains an optional `keys: boolean` (default `false`). When it is
  false, `keyDown` is **not in the tap's mask at all**, so a Keys-off take
  never even sees a keystroke. That is the strongest form of opt-in.
- When it is true, `makeEventTap`'s mask adds `CGEventType.keyDown`.
  `handleTapEvent` routes key events to `decideKeyEvent(...)` and appends
  `{ t, kind: "key", key, mods }` for a `.record` decision.
- **Same rules as mouse events:** same `t` mapping (`CGEvent.timestamp`
  is already ns, never converted), same pause gate (STC-240: nothing
  recorded while paused), same lock.
- `events.json` is written as **version 3 only when at least one key event
  was recorded**, else version 2. That is the minimum-version rule
  `anchorsDocument`/`projectForWrite`/`shotForWrite` already follow, so a
  Keys-off take is byte-for-byte unchanged in format.
- Stats: `keysRecorded`, `keysDropped` (counts only) go to the existing
  stop summary, so a take with Keys on and zero recorded keys is legible.

**Test injection.** No test in this repo synthesizes input events (posting
them needs a further grant), and a key test that cannot run is a skip that
reads as coverage. `STC_KEY_INJECT=<path>` makes the helper read a JSON
list of `{ afterMs, keyCode, flags, autorepeat }`. It BUILDS real `CGEvent`s
(`CGEvent(keyboardEventSource:virtualKey:keyDown:)`, which needs no
permission) and feeds them through the same `handleTapEvent` path,
timestamped on the take's clock. This proves everything except the tap
delivering `keyDown`, and that last link is the runbook's job.

### 2. Schema and loader

- `schema/events-3.schema.json` is events-2 plus `keyEvent`:
  `{ t: int ≥0, kind: "key", key: <enum> | <one char>, mods: array of unique "cmd"|"ctrl"|"opt"|"shift" }`,
  where `<one char>` is the pattern ``^[!-`{-~]$``: U+0021–U+0060 and
  U+007B–U+007E, i.e. printable ASCII with the lowercase letters cut out
  (the helper upper-cases them).
- **The privacy rule is enforced by the schema too, not only by the
  helper.** A `keyEvent` whose `key` is a single character MUST have
  `mods` containing `cmd` or `ctrl` (an `if/then` on the key pattern). A
  stray letter is an invalid document, and the loader refuses it rather
  than defaulting, as every loader here does.
- `transform/src/session.ts`'s events loader accepts version 3. A v1/v2
  document simply has no key events.

### 3. Transform

**`transform/src/keycast.ts`** is pure and node-free.

- `KEYCAST_HOLD_TICKS = 144` (1.2 s at 120 Hz) and
  `KEYCAST_FADE_TICKS = 24` (200 ms). Time is integer sim ticks, as the
  non-negotiable requires; a key's tick is
  `floor(t × 120 / 1e9)`, the same rule as the cursor.
- `buildKeycastRuns(events)` → runs. A press with the same `key`+`mods`
  as the current run, arriving before that run's hold has ENDED (i.e.
  `tick < lastTick + HOLD`), extends it (`count + 1`, `lastTick` moves).
  Anything else starts a new run, which immediately replaces the old one
  on screen. This runs once per session and is memoised, like the cursor
  checkpoints.
- `keycastAt(runs, tick)` → `{ label, count, opacity } | null`, found
  by bisect over runs. Opacity is 1 through `lastTick + HOLD`, linear to 0
  across `FADE`, then null. It does not depend on how the tick was
  reached, so stepping and seeking give the same answer by construction,
  and a test holds them equal.
- `keyLabel(key, mods)` is the ONE label map. Modifiers come in macOS menu
  order and glyphs `⌃⌥⇧⌘`. Arrows are glyphs `↑↓←→`. Other keys are WORDS
  (`Return`, `Enter`, `Tab`, `Esc`, `Delete`, `Fwd Delete`, `Home`, `End`,
  `Page Up`, `Page Down`, `F5`): a viewer at column width knows "Home",
  not `↖`. The count renders as ` ×N` for N ≥ 2.

**`FrameState.keycast`**: `{ label, count, opacity } | null`, null when
hidden by the project, absent from the session, or between runs.

**Drawing.** `keycastLayout(outputW, outputH, textWidth)` is the one
placement function. It is bottom-centre with
font px = `max(14, round(outputW × 0.022))`, bottom margin = 6% of
output height, a pill radius of half the height, a background of
`rgba(0,0,0,0.72)` × opacity, and white text × opacity. It is drawn in
the compositor AFTER the cropped frame, cursor and PiP, so zoom never
moves or scales it.

**Font determinism, the trap to design out.** Both sinks must produce the
same pixels (`gate:identity`). `fillText` with a font that is not loaded
yet silently renders in a fallback face, so the first frames of one sink
would differ from the other. The keycast font is named in ONE constant
(following `still-annotate.ts`'s "the font in exactly one place"), loaded
via `FontFace` and **awaited before the first render in BOTH sinks**, and
the gate fixture includes a key event inside its first second, so a
missed await fails the gate rather than shipping.

**`TRANSFORM_VERSION` 11 → 12**, with its changelog entry, and
`npm run gate:identity` re-baselined.

### 4. Project and editor

- `schema/project-13.schema.json` is project-12 plus optional
  `keycast: { show: boolean }`. Absent means "show if the take has key
  events". `projectForWrite` emits v13 only when `keycast` is present
  (the user touched the switch), so an untouched project stays v12.
  `PROJECT_VERSIONS` gains 13 (the seam test refuses a second list).
- The editor gets a **Keys** switch that appears only when the session has
  key events. Toggling writes `keycast.show`. It never edits
  `events.json`.

### 5. Record bar and settings

- `app/src/record-options.ts`: the `keys` control stops being a disabled
  slot and becomes a toggle (pressed/unpressed state, the same treatment
  the bar's other toggles get). Its tooltip reads "Show keystrokes —
  commands and shortcuts only; typing is never recorded".
- `app/src/settings.ts`: `recordKeys: boolean`, default `false`, sticky.
  It is written by `writeBarOptions` on Settings and on Record, and NOT
  on Escape (the STC-456 rule).
- `app/src/main.ts`'s `recordFlowBody` start-param builder, the ONE
  place start parameters are built (STC-388), passes `keys`.

## Error handling

- Keys on, but the tap can't be created: unchanged. The tap is already
  required, so `event-tap-unavailable` refuses the take exactly as today.
- Keys on, zero keys recorded: a valid v2 take. The stop summary's
  `keysRecorded: 0` explains why the editor has no switch.
- A malformed key event in a v3 file: the loader refuses the session,
  with the event index in the message.
- `UCKeyTranslate` fails or yields non-ASCII: the event is dropped and
  counted, never guessed.

## Testing

| Layer | Test | Runs |
|---|---|---|
| Helper decisions | `helper/test/keys/`: every row of "what counts": typing, ⇧letter, ⌥letter, ⌥⇧letter, Space, autorepeat dropped; arrows/Return/⇧Tab/⌥←/⌘K/⌃⌘F recorded; non-ASCII base char dropped | CI |
| Helper end to end | `STC_KEY_INJECT` black-box test on the real binary: v3 `events.json`, schema-valid, typing absent, pause drops keys, `keys:false` writes v2 even with injection on (the CONTROL) | `test:capture` (needs a grant to start a take) |
| Schema | events-3 accepts commands; REFUSES a bare letter, a ⇧-only letter, an ⌥-only letter; v2 still valid | CI |
| Transform | `keycast.ts`: run grouping, count, hold/fade boundaries at exact ticks, step-vs-seek identity across all ticks of a fixture | CI |
| Render | frozen fixture with key events, a TRANSFORM_VERSION 12 golden for `FrameState.keycast`; `gate:identity` re-baselined with a key event in the first second | CI + gate |
| App | e2e: the Keys toggle persists, and reaches `start`'s params via `recordFlowBody` | e2e (VM first, per memory) |
| Mac only | runbook: no new TCC prompt; Accessibility does not list the app; real ↓↓↓→Return in a real treegrid; the pill legible at 1232 CSS px | Patrick |

## Out of scope

- Placement/size/style customization (a later project field; the layout
  function is where it plugs in).
- Editing or redacting keys after the fact (the ticket's own exclusion).
- Showing typing in any form, including masked `•••` bursts.
- Space, and lone modifier presses.
- Keystrokes as an auto-zoom trigger (STC-327 stays declined).

## Hand-off

`docs/STC-419-RUNBOOK.md` ships with the code and names its branch.
STC-321's runbook (demo #2) follows once this merges.
