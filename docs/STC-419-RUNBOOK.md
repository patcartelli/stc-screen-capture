# STC-419 — show keystrokes (keycast): what to run on the Mac

**Run this from `accounts/stc-419-show-keystrokes`. It is not on `master` yet.**

Spec: `docs/superpowers/specs/2026-10-01-stc-419-keycast-design.md`.
Plan: `docs/superpowers/plans/2026-10-01-stc-419-keycast.md`.

## What this ticket does, and the one rule

Commands only: arrows, Return/Enter, Tab, Escape, Delete, Home/End, Page Up/Down, F1-F12, and chords with ⌘ or ⌃ on a printable ASCII key. **Typing never reaches disk.** The rule is `decideKeyEvent` in `helper/src/KeyDecisions.swift`; the schema enforces it again (`schema/events-3.schema.json`, an if/then) and so does the loader (`checkKeyEvent` in `transform/src/keycast.ts`). Dropped keys are only counted (`keysRecorded`/`keysDropped`, in the `stop` reply only, never the periodic stats, which would expose typing rhythm). The keyboard layout snapshot is taken in `start()` in `helper/src/main.swift`, on the main thread (TIS must run there), and passed down. It is the ASCII-capable layout (`TISCopyCurrentASCIICapableKeyboardLayoutInputSource`): the current layout when that is ASCII-capable, otherwise the one macOS resolves shortcuts against. Keys are split into `Session.keys` by the loader and never enter `session.events`. The keycast is drawn last by `composite()` on the output canvas with a system font stack (`TRANSFORM_VERSION` 12). project-13 `keycast.show` is written only when false.

What has been verified on this Mac: unit suites, `npm run typecheck`, and `gate:identity` on `fixtures/keycast` and `fixtures/basic` (0 mismatches). **Not run here:** the new e2e files (`app/test/keys-toggle.e2e.test.ts`, `app/test/keycast-editor.e2e.test.ts`, two new cases in `app/test/preview-write-project.e2e.test.ts`); they run on CI. `STC_KEY_INJECT` (tests) builds real CGEvents and feeds `handleTapEvent`, so it proves everything except the tap actually delivering keyDown, which is §1-§2. While it is set, the real keyboard is kept OUT of the tap's mask, so typing at the machine during a grant run cannot land in the test's takes.

## Results (Patrick, 2026-10-02, macOS 27)

- **§1 PASSES.** No TCC prompt on a Keys-on take (an Input Monitoring prompt had appeared some launches earlier, for the cursor tap STC-315 already requires). Capture is NOT in the Accessibility-class list. On macOS 27 there is no "Accessibility" row in Privacy & Security; the equivalent is **Device Control and Data Access** ("monitor your keyboard … control any app"), and Capture is absent there. Input Monitoring is the only input grant keys need.
- **The real tap delivers keyDown.** The first grant run, before the mask fix, recorded a real ⌘H pressed mid-run, and dropped 2 real typed keys as typing.
- **`keys.grant.test.ts`: 3/3 pass** after the mask fix.
- **§2, Keys on: passes.**
- **§3: the export looks good** at column width. No change to `KEYCAST_HOLD_TICKS` or `KEYCAST_FONT_FRACTION`.
- **§2, Keys OFF: passes** — `events.json` version 2, no key events, with ⌘K and arrows pressed. The mask is what keeps a Keys-off take keyless.
- **Open:** the non-Latin layout check (optional).

## 0. Build and branch

```
git fetch && git checkout accounts/stc-419-show-keystrokes && helper/build.sh && npm run app:start
```

## 1. Permissions (the claim this ticket rests on; passed 2026-10-02, see Results)

The premise: Input Monitoring already covers keyDown on a listen-only event tap, so no Accessibility grant is needed.

Turn Keys on in the Record bar and record a take. Expect **no new TCC prompt**. The app must **not** be in the Accessibility-class list: System Settings > Privacy & Security > Accessibility before macOS 27, **Device Control and Data Access** on macOS 27 (the Accessibility row is gone). Input Monitoring is the only input grant. If any prompt appears, stop and report which one: that sends the ticket's permission premise back for a decision.

## 2. The real tap

In a real treegrid (or Finder's list view) press ↓ ↓ ↓ → Return, ⌘K, then type a word into a text field, then Space, then hold ↓ for 2 s. Stop and open the take's `events.json`. Expect version 3 with ↓ ×3, →, Return, `K` with `["cmd"]`, and one ↓ for the hold (auto-repeat dropped). The typed word and the Space must be **absent**.

Also run:

```
npm run test:capture -- helper/test/keys.grant.test.ts
```

Its "K" assertion assumes a US/ABC layout.

**Non-Latin layout.** Switch to a Russian (or any non-Latin) input source, record with Keys on, press ⌘K, stop. Expect `{"key":"K","mods":["cmd"]}` in `events.json`: the chord is labelled from the ASCII-capable layout macOS uses for shortcuts, not dropped.

**Keys OFF (the mask).** Turn Keys off in the Record bar, record, press ⌘K and the arrows, stop. Expect `events.json` **version 2** with **no** `"kind":"key"` events. Injection cannot prove this one: it feeds `handleTapEvent` directly and never touches the tap's event mask.

## 3. Legibility at column width

Export at the case-study column width (2464 px wide, STC-313's number) and view it at 1232 CSS px. Is the pill readable? Does `↓ ×3` read as a count? Does the 1.2 s hold feel right, or should it be shorter? Report the numbers to change: the dials are `KEYCAST_HOLD_TICKS` and `KEYCAST_FONT_FRACTION` in `transform/src/keycast.ts`. Also check the editor's Keys switch (`#keycastbtn`) hides the pill without removing the recorded keys, and that the Record bar's Keys control is sticky and starts off.

## 4. Gates

```
npm run gate:identity -- fixtures/keycast
npm run gate:identity -- fixtures/basic
```

## 5. Known limits

- A keyboard layout switched mid-take is not seen; the snapshot is taken at start.
- Space, lone modifiers and ⌥+letter never show (they are typing, or carry no command).
- On a non-Latin layout (Russian, Greek), chords are labelled from the ASCII-capable layout macOS uses for shortcuts, so ⌘K reads ⌘K. §2 checks it.
