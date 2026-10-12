# STC-522 — runbook

macOS's "Capture is requesting to bypass the system private window picker and
directly access your screen and audio" dialog used to appear inside the first
recording. These checks are the ones only a clean Mac can settle. Every item is
**VM** (`docs/VM-TESTING.md`), because a Mac that has answered the dialog once
never shows it again. Run them from branch `accounts/stc-522-consent-prewarm`
until it merges, then from `master`. `npm run app:package` first.

## What changed

- **Helper:** a new command, `prime-capture` (`helper/src/CapturePrime.swift`).
  It starts one ScreenCaptureKit stream (16x16 of the main display, 10 fps, no
  cursor, no audio), holds it for `holdMs` (default 1000), stops it, and answers
  `primed` with `{ frames, heldMs }`. Nothing is written. It refuses with
  `bad-state` during a take or while another prime is running. Ungranted, it
  answers `no-displays`.
- **App:** on a launch where Screen Recording was **already granted at launch**,
  and only while `settings.json`'s `capturePrimed` is not `true`, main sends
  `prime-capture` once (`permissions.ts` rule 8, `shouldPrimeCapture`). A `primed`
  answer sets `capturePrimed: true`. Any other answer is logged and retried at the
  next launch. A Record or shot asked for while the prime runs waits for it, so
  the overlay never opens over the dialog.
- **Once, not every launch.** Every stream lights the menu bar's recording
  indicator, so running at every launch would flash it each time. This was
  Patrick's call (2026-10-12). Cost: if macOS re-asks periodically, the re-ask is
  not caught.
- The panel's footnote now says "After you relaunch…" instead of "On your first
  recording…".

## Checks

| # | check | how | result |
|---|---|---|---|
| 1 | `fresh.sh` (clean). Grant both rows, then Relaunch Capture. **Within a second or two of the relaunch**, with no Record pressed, macOS shows the picker-bypass dialog. The menu bar's recording indicator flashes briefly | Patrick, by eye | |
| 2 | **The done-when.** Choose Allow, then Record a short take. The take contains no system dialog, and none appears during it | Patrick, by eye; agent watches the take over SSH | |
| 3 | After 1, `settings.json` (`~/Library/Application Support/Capture/settings.json` in the guest) has `"capturePrimed": true`, and Capture's log shows `[permissions] primed capture (N frames in 1000 ms)` | agent, SSH | |
| 4 | Quit and relaunch Capture. No recording-indicator flash, and no new `primed capture` log line | Patrick (flash); agent (log) | |
| 5 | `fresh.sh --granted`. On the first launch, the prime runs once (log line, flag set). Note whether the dialog appears there too | agent, SSH; Patrick for the dialog | |

### If check 1 fails

- **No dialog at all, and check 2 still shows it in the take:** the stream may
  stop before `replayd` asks. Raise the hold. `holdMs` is a parameter, so try
  `{"cmd":"prime-capture","holdMs":3000}` from the guest via the packaged helper,
  then change `CapturePrime.defaultHoldMs`.
- **The dialog appears but closes itself when the stream stops:** the stream has
  to outlive the answer. That is option 2's problem (nothing reports the
  answer), so it goes back to the ticket rather than getting a guessed hold.
- **`primed` logged with 0 frames:** the stream never really ran. Check the TCC
  log (`log show --predicate 'subsystem == "com.apple.TCC"'`) for `replayd`'s
  ScreenCapture request.

## What CI covers

- `app/test/permissions.test.ts`: `shouldPrimeCapture`, including a mid-run
  grant waiting for the relaunch.
- `app/test/settings.test.ts`: `capturePrimed` defaults to false and survives
  unrelated writes. `recorder:setSettings` strips it, so a renderer echoing stale
  settings cannot reset it.
- `helper/test/ipc.test.ts`: `prime-capture` answers ungranted (`no-displays`)
  and refuses a second prime while one runs.
- `helper/test/capture-prime.grant.test.ts` (`npm run test:capture`, needs a
  grant): a real stream delivers frames and leaves the helper idle and primeable.
