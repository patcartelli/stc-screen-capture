# STC-375 — the pill: what to run on the Mac

Written on a Linux session with no display server other than a bare Xvfb (no
window manager — `which fluxbox openbox icewm twm` all come back empty, and
this sandbox cannot install one). That is not a caveat about this ticket in
particular: `app/test/pill.e2e.test.ts`'s header records the measurement —
a bare `win.setSize(96, 26)` on a freshly created window, no pill code
involved, leaves `getBounds()` unchanged here, while `setResizable`/
`isResizable()` and `setAlwaysOnTop`/`isAlwaysOnTop()` toggle correctly
(Electron-internal booleans, no window manager needed). So the WIRING —
that Record locks resizing and floats the window, driven by the real
heartbeat and not the click, and that both a user Stop and an unsolicited
`recording-ended` undo it — is exercised end to end and passes. What none of
that can show is whether the window actually, visibly becomes a 26px pill
and back. That is this file's job.

## What changed

- `main.ts`'s `createWindow()` gained `titleBarStyle: "hidden"` — the native
  traffic lights stay, drawn as an inset overlay, but the drawn title-bar
  strip is gone. This was a real decision, not a default: the ticket's own
  design assumed a fully frameless window, the shipped main window was a
  normal titled one, and going frameless everywhere was the bigger of the
  two options on the table (see the PR discussion and pill.ts's header).
  `"hidden"` was chosen because it is the smaller change.
- `app/src/pill.ts` (pure decisions) and `app/src/pill-window.ts` (the real
  `BrowserWindow` mechanics) are wired into `main.ts`: Record collapses the
  window into a 26px pill; Stop, or the helper ending the take on its own,
  restores it to exactly the bounds it had before collapsing.
- `collapsePill` hides the traffic-light buttons (`setWindowButtonVisibility`)
  since there is no room for them in a 26px strip; `restorePill` brings them
  back.
- The pill's own CONTENT — the dot, the live timer, the hatched level meter —
  has no view yet. Until it does, the collapsed width is `MIN_PILL_WIDTH_PX`
  (a fixed floor), not a real measurement of anything. That is stated in code
  at the call site in `createWindow()`, not hidden.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh
npm run typecheck && npm test
```

`npm test` covers `app/test/pill.test.ts` (12 pure assertions: sizing clamp,
the collapse/restore transition, the mm:ss/h:mm:ss timer format) and
`app/test/pill.e2e.test.ts` (2 assertions: the real window's `resizable`/
`alwaysOnTop` flags toggle on Record and un-toggle on both Stop and an
unsolicited end). Nothing here needs a grant.

## 1. Does it actually look like a pill

Launch the app normally (`npm run app:start`) and press Record.

- Does the window really shrink to something pill-shaped, or does
  `titleBarStyle: "hidden"` leave a gap where the old title strip was —
  particularly at 26px tall, which is short even for an inset traffic-light
  cluster? This is the specific thing this Linux sandbox could not check at
  all (no WM to honour the resize), so this is the FIRST real look.
- Are the traffic lights actually hidden while collapsed, and do they come
  back looking normal (not misplaced, not needing a hover to reappear) once
  restored?
- Content: there is no pill view yet, so the collapsed window right now is
  just a bare, empty, 26px-tall strip at `MIN_PILL_WIDTH_PX` — this is
  expected and not a bug to report. The dot/timer/meter is separate,
  unscoped visual work.

## 2. Restore geometry

- Move or resize the main window before pressing Record (drag it somewhere,
  make it wider or taller than the 520×680 default). Record, then Stop.
  Confirm the window comes back to EXACTLY where and how big it was — not
  the ticket's original `360 × instrumentHeight` pseudocode, which this repo
  deliberately deviated from (see `pill-window.ts`'s header) because the
  real window is resizable and user-positioned.
- Do this on a SECOND display if one is available. Confirm the window
  restores on the same display it was collapsed from.

## 3. Space switch (the ticket's own stated reason for `setVisibleOnAllWorkspaces`)

Press Record, then switch to a different Space (Mission Control / a
three-finger swipe) while the pill is up.

- Does the pill follow you to the new Space, or does it stay behind on the
  Space it was collapsed on? The ticket's whole justification for
  `setVisibleOnAllWorkspaces` is that a recording session involves Space
  switches constantly — confirm the pill is actually still visible.
- Full-screen a window on the new Space (an app in full-screen occupies its
  own Space in macOS). Does the pill still float above it
  (`visibleOnFullScreen: true`)?

## 4. Trap 1 — no `-3805`

This app's own CLAUDE.md records `-3805 "application connection being
interrupted"` as the signature of two unrelated subsystems touching the
display at once. Collapse fires from the supervisor's heartbeat, strictly
after `start` has already answered — never inside it — but that is a claim
about the CODE; only a real capture proves it costs nothing.

- Record several times in a row (at least 5), each a few seconds, watching
  for `-3805` or any capture failure that coincides with the collapse.
- Record once with the camera on, to rule out an interaction between the
  camera opening (which happens off the critical path, ~1.3s after `started`
  per STC-287) and the window resize landing in the same window.

## 5. Trap 3 — the pill never outlives a stopped take

- Record, then force the takes to end WITHOUT clicking Stop: unplug the
  captured display (STC-247's own test for `stop.reason: display-reconfigured`)
  or, if reproducible, trigger a display stream failure. Confirm the pill
  restores on its own — the same assertion `pill.e2e.test.ts`'s second test
  makes with a fake stream death, now for real.
- Quit the app (Cmd-Q) while the pill is up, mid-take. `before-quit` stops
  the recording first (existing behaviour, unrelated to this ticket) —
  confirm nothing about the pill's own `attachPillToSupervisor` listener
  throws or leaves the app in a stuck state during that teardown.

## 6. Menu-bar-first interaction (trap 2)

- Close the pill window (⌘W or the traffic-light close button, now visible
  again only once restored — try closing WHILE collapsed too, if the button
  is reachable at all at that size). Confirm this behaves the same as any
  other main-window close under STC-292: Dock icon goes, menu-bar item
  stays, and reopening via the menu bar brings back a window in whatever
  state (collapsed or expanded) matches the actual recording state at that
  moment — not stale.

## Open

Snap vs. animate the resize (the ticket's own open question) — only snap is
implemented. If a real Mac makes the snap read as jarring, that is a
separate, scoped follow-up (stepping bounds on a timer in main, since CSS
cannot move a window), not a blocker on this ticket's own "Done means."
