# STC-447 — the bar's visual pass + recording profile: what to check on the Mac

Written on a Linux sandbox with no `swiftc`/`xcrun` at all (not even the
Command Line Tools fallback other Linux sessions in this repo have had) —
`helper/build.sh` cannot run, so `npm test`'s global setup (which builds the
helper before any test file is collected) cannot run either. Everything
checkable without it was checked: all three `tsc` passes are clean, and 929
pure unit tests pass (`transform/test/**`, plus the settings/menu/pill tests
this ticket touches), run through a throwaway local vitest config with no
`globalSetup` since the real one is unusable here. No e2e test was added or
run for the same reason — this file is what replaces that.

## What changed

- **Visual pass on `#pill`** (`app/renderer/index.html`, mirrored in
  `pill.ts`'s `PILL_THEME`): a 1px translucent ring and a soft drop shadow,
  plus a hover tint. This is a direct answer to the STC-375 runbook's own
  open question — "is the whole pill legible against whatever is likely to
  be behind it (light desktop backgrounds especially)" — which had no
  answer before this. Nothing about the pill's SHAPE, size, or click
  behaviour changed; see `pill.ts`'s header for why those stay put (traps 1
  and 3, snap-not-animate).
- **A recording-profile selector** (`#recprofile` in `#record-row`) —
  optional, sticky (`Settings.recordingProfileId`), never required to start
  a recording. Clicking it pops a real macOS menu
  (`recorder:profileMenu` → `buildRecordingProfileMenu`, same pattern
  `thumbnail:menu`/`buildThumbMenu` already use) listing "No profile" plus
  the two built-in profiles (`transform/src/recording-profile.ts`):
  **Instagram** (1080px wide) and **4K case study** (3840px wide, capped to
  the capture's own width — never upscaled). Picking one writes the id
  through the existing `recorder:setSettings` channel; nothing new writes
  settings.json.
- **What a profile actually does**: nothing until the recording ends. When
  `recording-ended` fires with a profile selected, `main.ts`'s
  `writeRecordingProfileHint` resolves the profile's target size against
  the take's real capture size (from its `anchors.json`) and drops a small
  hint file (`profile-hint.json`, `PROFILE_HINT_FILE`) in the take
  directory — two plain numbers, not a `project.json`. The FIRST time that
  take is opened in the editor with no `project.json` on disk yet,
  `editor.ts` reads the hint and seeds `defaultProject` with the profile's
  size instead of the capture's own — so the take opens already sized for
  where it's headed, the same value a person would otherwise set by hand in
  the export dialog afterward. A take opened a second time, or one with a
  hand-authored `project.json`, ignores the hint entirely (real weight-of-a-
  real-decision `project.json` always wins).
- **Why a hint file and not a real `project.json`**: `docs/CORRECTNESS-
  TRAPS.md` already documents the exact trap — importing `trim.ts`'s
  `defaultProject`/`projectForWrite` into `main.ts` drags
  `transform-version.ts` → `cursor-art.ts`'s Canvas types into
  `tsconfig.node.json`'s no-DOM pass and fails it outright. `project-
  version.ts` was already split out once for the same reason (STC-318). The
  hint file (`PROFILE_HINT_FILE`, a constant shared by both sides so the
  name cannot drift) keeps `main.ts` writing only two integers; `editor.ts`,
  already safely importing `trim.ts` under `tsconfig.browser.json` (which
  has DOM), is the one and only place a `Project` gets constructed either
  way — this was caught by the typecheck failing during this ticket, not by
  inspection, and is the reason this file exists at all rather than a
  simpler one-file version of this feature.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh
npm run typecheck && npm test
```

Neither ran in this sandbox — see above. On a Mac, both should be green;
`npm test` now includes `transform/test/recording-profile.test.ts` (14
assertions on the two profiles' sizes, evenness, and the upscale cap) and
`app/test/recording-profile-menu.test.ts` (the menu template), plus the
`settings.test.ts` additions for `recordingProfileId`'s own round-trip.

## 1. Does the pill actually read better

Launch the app (`npm run app:start`), press Record, and look at the pill
against a few different desktop backgrounds — a plain dark wallpaper, a busy
light one, a window nearly the same near-black as the pill itself.

- Is the ring/shadow visible enough to matter, or too subtle to notice at
  all? It was sized to answer "can you tell where the pill ends" without
  turning it into a bordered dialog — that balance needs a real eye.
- Does the pill still read as "a small instrument," not "a notification"?
- Hover the pill (trackpad, not a touch device) — does the tint read as
  affordance, or is it imperceptible at 26–32px?

Everything else about the pill (shape, the stop icon, the timer, the hit
target) is unchanged and already confirmed per `docs/STC-375-RUNBOOK.md`.

## 2. The recording-profile selector

With the main window NOT recording (the pill collapsed state hides
`#recprofile` entirely, same as Shot and Settings):

- Click "Profile". Does the native menu appear where expected, with "No
  profile" first and both built-ins listed?
- Pick "Instagram", reopen the app (or just refresh settings) — does the
  button's own label now read "Instagram"? Does the choice survive a
  restart?
- Pick "No profile" — does the button return to reading "Profile"?
- Start a recording with a profile selected. Confirm `#recprofile` is
  disabled the instant Record locks the other source controls
  (`lockSettings`), and confirm it is entirely absent from the pill (it
  should be, by construction — it isn't `#pill` and the collapsed-state CSS
  hides everything else in `#record-row`, but this needs a real look).

## 3. Does the profile actually land on the take

- With "4K case study" selected, record a short take on a display smaller
  than 3840px wide. Stop, open the take in the editor. The export-size
  `<select>` (`#outsize`) should show a "Custom · WxH" or a matching preset
  at the CAPTURE's own width (the cap — never invented pixels), not 3840.
- With "Instagram" selected, record another short take. Open it. `#outsize`
  should reflect ~1080px wide (evened, capture aspect preserved) rather
  than the capture's own size.
- Record a THIRD take with "No profile" selected (or after clearing it).
  Open it — this should behave exactly as it always has: `#outsize` at
  "Capture size."
- Look inside the take's folder right after it lands in the library,
  before opening it in the editor: `profile-hint.json` should be present
  for the first two takes above, absent for the third.
- Open one of the profiled takes a SECOND time (close the editor, reopen
  from the library). Confirm the size chosen the first time (now saved for
  real in `project.json`) is what shows — not the hint recomputed, and not
  a reset to capture size. The hint should still be sitting in the folder,
  unused; that's expected (see "What changed," above) rather than a leak to
  clean up.

## 4. Open

- Whether the pill's ring/shadow strength (`rgba(255,255,255,0.14)` /
  `rgba(0,0,0,0.35)`) is right, per §1 — this is the one piece of new
  visual design with no automated check at all, by nature.
- The ticket's own "possible layout changes — not yet scoped" is
  deliberately NOT addressed beyond the profile button and the pill's own
  ring/shadow: nothing about `#record-row`'s existing order, spacing, or
  the Record/Shot/Settings hierarchy changed. If a real look at §1/§2 says
  more restructuring is warranted, that is this ticket's own next
  increment, not a silent scope change here.
- Whether "Instagram" (1080px) and "4K case study" (3840px, capped) are the
  right two presets and the right numbers — they are the ticket's own
  example, taken as literally as it was written; if Patrick wants different
  named profiles or different target widths, `RECORDING_PROFILES` in
  `transform/src/recording-profile.ts` is the one place to change them.
