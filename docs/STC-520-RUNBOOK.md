# STC-520 — mic and camera permission rows, runbook

What only a clean Mac can settle. Run from branch
`accounts/stc-520-permissions-panel-remainder-miccamera-rows-guarded-record` until it
merges, then from `master`. Everything here is **VM** (`docs/VM-TESTING.md`) except the
last row.

## What changed

- **Helper:** `permissions` also reports `microphone` and `camera`
  (`authorized | denied | restricted | notDetermined`). `request-permission` accepts
  `microphone` and `camera` and replies after the person has answered.
- **App:** `app/src/permissions.ts` rule 8. A Microphone or Camera row exists only while
  that device is chosen and not authorized. Record waits on it; a shot never does. "Don't
  use" clears the choice. `main.ts` re-reads the grants before every overlay, and asks for
  a chosen, never-asked device after the overlay closes and before the countdown.

## Why STC-475 happened

Nothing asked. The capture classes read `authorizationStatus` and failed unless it was
`.authorized`. A read never prompts and never adds a row under Privacy & Security.

## Checks (clean VM, `npm run app:package` first)

| # | check | pass looks like |
|---|---|---|
| 1 | `fresh.sh`; grant Screen Recording and Input Monitoring; choose a mic in the main window; press Record | The panel returns with ONE new row, Microphone, "Not granted yet". macOS has not prompted yet |
| 2 | Click **Grant…** on Microphone | macOS prompts; after Allow the row reads Granted and the panel closes |
| 3 | Reset the mic (`tccutil reset Microphone com.studiocartelli.capture`), then choose a mic **on the overlay bar** and press Capture Video | The overlay closes, then macOS's mic prompt appears (not under a scrim); Allow, and the take starts with a mic track |
| 4 | Same as 3, choose Don't Allow | The panel appears with "Turn on Capture in System Settings." and **Don't use**. No take started |
| 5 | In 4, click **Open System Settings** | Microphone pane opens, and Capture is listed |
| 6 | In 4, click **Don't use** | The panel closes, the mic reads Off in the main window, Record works |
| 7 | Repeat 1–6 with Camera. **This is STC-475's repro**: Camera was never listed before | Capture appears under Privacy › Camera after Grant… |
| 8 | With everything granted, revoke Input Monitoring in System Settings (leave Capture running), press Record | The panel appears before any overlay. Before this, the stale grant was caught only after a refusal |
| 9 | Restricted (MDM) | Not testable in the VM. The row offers only **Don't use**; reading the copy is the check |

**VM pass 2026-10-12** (clean clone `stc-run-1012-144423`, packaged build from this branch):
rows 1–8 all **pass** (Patrick, by eye). Row 9 is not testable in a VM. Not read back from
TCC.db by the agent.

Row 3 is the one most likely to send this back: it is the only place macOS's prompt
meets a flow that has just closed an overlay.
