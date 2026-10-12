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

## Checks — VM pass 2026-10-12, build `46687a9`, `fresh.sh` (clean TCC)

| # | check | how | result |
|---|---|---|---|
| 1 | Grant both rows, then relaunch. **Within a second or two of the relaunch**, with no Record pressed, macOS shows the picker-bypass dialog. The menu bar's recording indicator flashes briefly | Patrick, by eye; agent from `replayd`'s log | **pass.** `replayd` started the prime's stream at 17:17:34.608 and showed the alert at 17:17:34.949 (`SCAlert showAlertWithTitle…`). Patrick saw it and accepted it without reading it. See the note below |
| 2 | **The done-when.** Record a short take. The take contains no system dialog, and none appears during it | agent from `replayd`'s log; Patrick by eye | **pass (log).** The take's stream ran 17:25:33.764–17:25:40.199. `replayd` ran `requireAlert…` and showed **no** alert. Patrick did not separately report what he saw during the take |
| 3 | `settings.json` (`~/Library/Application Support/Capture/settings.json` in the guest) has `"capturePrimed": true`. Before the grants, the file did not exist | agent, SSH | **pass** |
| 4 | Quit and relaunch Capture. No recording-indicator flash, and no new stream | Patrick (flash); agent (`replayd` log stream) | **pass.** Patrick saw no flash. The relaunched Capture (new PIDs) started no stream |
| 5 | `fresh.sh --granted`. On the first launch, the prime runs once (log line, flag set). Note whether the dialog appears there too | agent, SSH; Patrick for the dialog | **not run** |

The app's log is no help after the panel's Relaunch: `app.relaunch()` drops
`launch-guest.sh`'s `--stdout`, so `[permissions] primed capture` never reaches
`/tmp/stc-capture-launch.log`. The evidence is the flag plus `replayd`'s own log,
read with `log show --predicate 'process == "replayd"'`, or `log stream` during a
check. Pipe the script into the guest (`ssh.sh <vm> bash -s < script`); `ssh.sh`
loses nested quotes.

**The alert's answer was logged as "user acknowledgement refused"** (17:17:36.459,
0.7 s after the prime's stream stopped), even though Patrick accepted it. The take
still got no alert, so either path counts for `replayd`'s `SCAlertStatsManager`
(it records `lastAlertedDate`). Whether that log line means "Allow" or "dismissed
because its stream ended" is not settled. Either way the done-when holds.

There were two relaunches after the grants (helper PIDs 1237, then 1258 at
17:17:54). The prime ran in the first, so the second correctly did not prime.
Patrick watched the second and saw no dialog in it, which looks like a failure
but is not.

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
