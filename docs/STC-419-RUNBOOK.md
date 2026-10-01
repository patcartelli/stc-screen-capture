# STC-419 — show keystrokes (keycast): what to run on the Mac

**Run this from `accounts/stc-419-show-keystrokes`. It is not on `master` yet.**

Spec: `docs/superpowers/specs/2026-10-01-stc-419-keycast-design.md`.
Plan: `docs/superpowers/plans/2026-10-01-stc-419-keycast.md`.

## What this ticket does, and the one rule

Commands only: arrows, Return/Enter, Tab, Escape, Delete, Home/End, Page Up/Down, F1-F12, and chords with ⌘ or ⌃ on a printable ASCII key. **Typing never reaches disk.** The rule is `decideKeyEvent` in `helper/src/KeyDecisions.swift`; the schema enforces it again (`schema/events-3.schema.json`, an if/then) and so does the loader (`checkKeyEvent` in `transform/src/keycast.ts`). Dropped keys are only counted (`keysRecorded`/`keysDropped` stats). The keyboard layout snapshot is taken in `start()` in `helper/src/main.swift`, on the main thread (TIS must run there), and passed down. Keys are split into `Session.keys` by the loader and never enter `session.events`. The keycast is drawn last by `composite()` on the output canvas with a system font stack (`TRANSFORM_VERSION` 12). project-13 `keycast.show` is written only when false.

What has been verified on this Mac: unit suites, `npm run typecheck`, and `gate:identity` on `fixtures/keycast` and `fixtures/basic` (0 mismatches). **Not run here:** `helper/test/keys.grant.test.ts` (needs grants, SKIP-GRANT) and the new e2e files (`app/test/keys-toggle.e2e.test.ts`, `app/test/keycast-editor.e2e.test.ts`, two new cases in `app/test/preview-write-project.e2e.test.ts`). `STC_KEY_INJECT` (tests) builds real CGEvents and feeds `handleTapEvent`, so it proves everything except the tap actually delivering keyDown, which is §1-§2.

## 0. Build and branch

```
git fetch && git checkout accounts/stc-419-show-keystrokes && helper/build.sh && npm run app:start
```

## 1. Permissions (the claim this ticket rests on, UNVERIFIED on hardware)

The premise: Input Monitoring already covers keyDown on a listen-only event tap, so no Accessibility grant is needed. Nothing has confirmed this on a Mac.

Turn Keys on in the Record bar and record a take. Expect **no new TCC prompt**. In System Settings > Privacy & Security > Accessibility the app must **not** be listed; Input Monitoring is the only input grant. If any prompt appears, stop and report which one: that sends the ticket's permission premise back for a decision.

## 2. The real tap

In a real treegrid (or Finder's list view) press ↓ ↓ ↓ → Return, ⌘K, then type a word into a text field, then Space, then hold ↓ for 2 s. Stop and open the take's `events.json`. Expect version 3 with ↓ x3, →, Return, `K` with `["cmd"]`, and one ↓ for the hold (auto-repeat dropped). The typed word and the Space must be **absent**.

Also run:

```
npm run test:capture -- helper/test/keys.grant.test.ts
```

Its "K" assertion assumes a US/ABC layout. If one is available, repeat the ⌘-chord on a non-Latin layout (Russian, Greek) and check what happens (see §5).

## 3. Legibility at column width

Export at the case-study column width (2464 px wide, STC-313's number) and view it at 1232 CSS px. Is the pill readable? Does `↓ x3` read as a count? Does the 1.2 s hold feel right, or should it be shorter? Report the numbers to change: the dials are `KEYCAST_HOLD_TICKS` and `KEYCAST_FONT_FRACTION` in `transform/src/keycast.ts`. Also check the editor's Keys switch (`#keycastbtn`) hides the pill without removing the recorded keys, and that the Record bar's Keys control is sticky and starts off.

## 4. Gates

```
npm run gate:identity -- fixtures/keycast
npm run gate:identity -- fixtures/basic
```

## 5. Known limits

- A keyboard layout switched mid-take is not seen; the snapshot is taken at start.
- Space, lone modifiers and ⌥+letter never show (they are typing, or carry no command).
- A non-Latin layout (Russian, Greek) may currently drop ⌘-chords; a follow-up fix is on this branch. Check §2 on one if you have it.
