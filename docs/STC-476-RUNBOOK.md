# STC-476 (MVP slice) + STC-518 — runbook

What only a clean Mac can settle for the required-grants panel and the Input
Monitoring request. Every item here is **VM** (`docs/VM-TESTING.md`): it is about
a Mac that has never run Capture. Run it from branch
`accounts/stc-476-518-required-grants` until it merges, then from `master`.

## What changed

- **Helper:** two new commands, `permissions` (reads Screen Recording,
  Input Monitoring and Accessibility; never prompts) and `request-permission`
  (`grant: "screen-recording" | "input-monitoring"`), in `helper/src/Permissions.swift`.
  Electron has no Input Monitoring API, so the helper is the one place both grants
  are read and requested. Capture.app spawns it, so TCC should charge Capture.app,
  the same way it already does for Screen Recording. §2 checks this.
- **STC-518's likely cause:** when `CGEvent.tapCreate` returned nil, the helper
  never called `IOHIDRequestAccess`. It assumed macOS would prompt on its own, and on
  the clean VM it did not. That path now asks too, but only while the state is still
  "never asked" (`decideEventTapAccess`).
- **App:** on launch, main reads both grants. If either is missing, a panel covers
  the main window (`#permissionsheet`, decisions in `app/src/permissions.ts`). While a
  grant is missing, Record (any door) and every shot bring the panel forward instead
  of opening an overlay. macOS's Screen Recording prompt used to land under the
  overlay's scrim.
- A Screen Recording grant that arrives during this run shows as "Relaunch Capture",
  never as granted. Accessibility counts as Input Monitoring, matching the helper's
  tap check.

## Checks (all VM, `npm run app:package` first)

1. `bash tools/vm/fresh.sh` (clean). **Pass:** the panel is up on launch with both
   rows "Not granted yet", and no overlay has appeared.
2. **STC-518's done-when.** Click **Grant…** on Input Monitoring. **Pass:** macOS's
   Input Monitoring prompt appears, or Capture is listed in System Settings › Privacy
   & Security › Input Monitoring with no + step. Also record whether the list shows
   **Capture** or **stc-helper**. Turn it on, return to Capture: the row reads Granted
   with no restart.
3. Click **Grant…** on Screen Recording, allow it in System Settings, and come back.
   **Pass:** the row never reads "Granted" before a relaunch. It reads
   "Relaunch Capture", or "Turn on Capture… then relaunch", with a Relaunch button.
   Click Relaunch. **Pass:** Capture comes back with no panel.
4. Press Record. **Pass:** straight to the overlay, with no Screen Recording or Input
   Monitoring prompt. Note whether macOS's "bypass the system private window picker"
   dialog appears (the panel's footnote warns about it).
5. Before step 2 (or after `tools/vm/reset-tcc.sh <vm>` and a relaunch): close the
   panel with ×, then press Record, then ⌃⌥⇧⌘4. **Pass:** the panel comes back each
   time, and no overlay or scrim opens.
6. `bash tools/vm/fresh.sh --granted`. **Pass:** no panel at all.
7. `bash tools/vm/reset-tcc.sh <vm>`, then relaunch. **Pass:** the panel comes back.

## Open questions only the VM can answer

- Does Input Monitoring take effect without a relaunch? The panel assumes it does,
  because `IOHIDCheckAccess` is live and the tap is made fresh for every take. If
  step 2's first Record still refuses, the Input Monitoring row needs Relaunch as well.
- Does `IOHIDRequestAccess` return at once, or wait for the user's answer? It runs
  on the helper's main thread. The app gives up after 5 s and re-reads, so a
  blocking call costs one stale row. Check `/tmp/stc-capture-launch.log` for a
  `[permissions] request failed` timeout or a helper respawn around step 2.
- If step 2 lists **stc-helper** rather than Capture, the attribution assumption is
  wrong. The fallback is a native addon in main. That is the route that was decided
  against on 2026-10-08.

## Not in this slice (STC-520)

Mic and camera rows, re-checking before every overlay for a grant revoked after
launch (the guard re-reads only while the last read said blocked), and the open
questions on the ticket.
