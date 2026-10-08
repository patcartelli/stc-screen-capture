# STC-476 (MVP slice) + STC-518 — runbook

What only a clean Mac can settle for the required-grants panel and the Input
Monitoring request. Every item here is **VM** (`docs/VM-TESTING.md`): it is about
a Mac that has never run Capture. Run it from branch
`accounts/stc-476-518-required-grants` until it merges, then from `master`.

## What changed

- **Helper:** two new commands in `helper/src/Permissions.swift`.
  - `permissions` reads Screen Recording and Input Monitoring. It never prompts and
    **never reads Accessibility**.
  - `request-permission` takes `grant: "screen-recording" | "input-monitoring"`.

  Electron has no Input Monitoring API, so the helper is the one place both grants
  are read and requested. tccd charges the helper's calls to Capture.app as the
  responsible process (seen in the VM's TCC log), and the grants land on
  `com.studiocartelli.capture`.
- **App:** on launch, main reads both grants. If either is missing, a panel that
  cannot be closed covers the main window (`#permissionsheet`, decisions in
  `app/src/permissions.ts`). While a grant is missing, Record (every door) and every
  shot bring the panel forward instead of opening an overlay. macOS's Screen
  Recording prompt used to land under the overlay's scrim.
- A Screen Recording grant that arrives during this run shows as "Relaunch Capture",
  never as Granted.

## Why STC-518 happened: three faults, found in four VM passes (2026-10-08)

Each was read from tccd's own log (`log show --predicate 'subsystem ==
"com.apple.TCC"'` in the guest). `preflight=no` means a real request, and
`preflight=yes` means a read.

1. **`IOHIDRequestAccess` never asked.** From the helper it produced only reads,
   never a request. The helper now asks with `CGRequestListenEventAccess()`, in one
   place (`Permissions.requestListenEvent`).
2. **"Denied" doesn't mean "already asked".** On a Mac that has never asked,
   `IOHIDCheckAccess` reports **denied**, even though TCC.db has no Input Monitoring
   row for the app. The old rule asked only while the state was "unknown", so nothing
   ever asked. Both the panel and the tap now ask whenever the grant is missing.
   macOS prompts at most once per app, so asking again does nothing.
3. **Reading Accessibility blocks the prompt.** On a never-asked Mac,
   `AXIsProcessTrusted()` writes a *denied* Accessibility row for Capture. With that
   row present, tccd answered the first real Input Monitoring request with an instant
   denial (`authReason=4`) and no prompt. The panel's read no longer touches
   Accessibility. The event tap asks for Input Monitoring first and reads
   Accessibility only afterwards, when Input Monitoring is still missing.

   Cost: a Mac that records through Accessibility alone now sees the Input
   Monitoring row. One Grant… click settles it, and the tap still accepts
   Accessibility.

## Checks (all VM, `npm run app:package` first) — VM pass 2026-10-08, build `9baa447`

| # | check | result |
|---|---|---|
| 1 | `fresh.sh` (clean): the panel is up on launch, both rows "Not granted yet", no overlay, no close button | **pass** (Patrick) |
| 2 | **STC-518's done-when.** Click **Grant…** on Input Monitoring. Pass: macOS prompts, Capture is listed with no + step, and the row turns Granted | **pass**, VM 4 (Patrick). TCC.db: `kTCCServiceListenEvent / com.studiocartelli.capture / allowed` (agent, SSH) |
| 3 | Grant Screen Recording. The row never reads Granted before a relaunch. Relaunch, then no panel | **pass** (Patrick) |
| 4 | Record goes straight to the overlay, with no SR or IM prompt | **pass** (Patrick). The take had 357 events, 9 clicks (agent, SSH). macOS's "bypass the system private window picker" dialog still appears once a stream starts. See below |
| 5 | With a grant missing, Record (⌃⌥⇧⌘4) keeps the panel up and opens no overlay or scrim | **pass** (Patrick) |
| 6 | `fresh.sh --granted`: no panel at all | **pass** (Patrick) |
| 7 | `reset-tcc.sh <vm>` + relaunch: the panel comes back | **pass** (Patrick) |

To re-run 2 on a VM that has already asked: `reset-tcc.sh` clears the grants, but
`CGRequestListenEventAccess` asks only once per process, so relaunch Capture
before clicking Grant… again.

## Still open

- **The picker-bypass consent** ("Capture is requesting to bypass the system private
  window picker…") appears when the first stream starts, so it lands in the first
  take. It's raised at stream start, not by the window list, so the panel can't
  trigger it in advance without a throwaway stream. Filed as STC-522.
- Does `CGRequestListenEventAccess` block the helper until the user answers? It
  didn't visibly stall in VM 4. The app gives up after 5 s anyway.

## Not in this slice (STC-520)

Mic and camera rows, re-checking before every overlay for a grant revoked after
launch (the guard re-reads only while the last read said blocked), and the open
questions on the ticket.
