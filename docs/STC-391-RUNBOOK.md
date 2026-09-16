# STC-391 — the countdown, on a Mac

**First hardware pass run 2026-09-16.** What it settled, and what it changed:

- **Esc, Skip and Return work.** §1's keyboard half is confirmed.
- **The ring reads as a countdown, not a spinner.** Confirmed.
- **The panel moved to the CENTRE**, horizontally and vertically. It shipped at
  the bottom centre on the reasoning that a countdown should keep out of the
  way; watched on hardware, the centre is what reads as a countdown. Changed.
- **3 s feels right, and the duration is now choosable** — 3/5/10 s in the
  profile sheet, reversing this ticket's own "no control" call now that it has
  been used. Off is deliberately not offered (rule 1: Record always counts
  down).
- **Second display: both routes work.** §6 is confirmed.
- **The wedge is FIXED and confirmed** (§7). Interrupting a self-timer no longer
  leaves the app unable to record.
- **The "pill did not collapse" report was a MISREAD, and the correction is
  worth keeping** (§8): Record works and the pill collapses when the take is
  started from the main window. The take that did not collapse was started from
  the **menu bar**, which does not start recordings at all — it only captures
  stills. That is STC-388's whole subject, not a defect here.

**Second hardware pass, same day:** all five checks confirmed. Nothing in this
runbook is open.

What follows is the procedure, kept so it can be re-run against a later change.

Everything below assumes a build: `node app/build.mjs && npm run app:start`.

## 0. The one design claim no test here could check

The panel **takes focus when it appears**, and that is what makes Return and
Escape work without registering either as a global shortcut. Registering them
globally was rejected on purpose: a bare Return grabbed machine-wide for three
seconds would be eaten from the very dropdown the self-timer exists to
photograph.

The cost is that clicking into another app during the countdown takes the
keyboard with it. §3 is where that gets judged, and it is the item most likely
to send this back for a redesign — the way STC-381's outline went round four
times.

## 1. Record counts down

1. Open the app, Scope = Screen, press **Record**.
2. A panel appears at the **bottom centre** of the display, above the Dock: a
   ring sweeping, a number counting 3 → 2 → 1, "Recording starts in", and
   **Cancel** / **Skip**.
3. The take starts when it reaches zero — not before.

Then, three at a time:

- **Esc** — nothing is recorded. The button still says Record, the take list is
  unchanged, and there is **no alert** (a cancellation is not a failure).
- **Return**, and the **Skip** button — the take starts at once.
- **Cancel** button — same as Esc.

Judgements, all of them open:

- ~~**Is 3 s right?**~~ **Settled: 3 s feels right, and there is a control
  now** — Profile › Countdown offers 3/5/10 s. Off is not offered on purpose;
  `countdownMs: 0` is still a legitimate stored value (edit
  `~/Library/Application Support/Electron/settings.json`) and is what the test
  suite uses, it is just not something the UI invites.
- ~~**Is the bottom centre right?**~~ **Settled: centre.** It is centred on the
  display's work area, so a Dock or menu bar does not pull the apparent centre
  off true. `PANEL` in `countdown-window.ts` is the remaining dial (size). What
  is still worth a look: a 260x156 panel over the middle of the screen blocks
  clicks there for the countdown's duration — it cannot corrupt a capture, but
  check it does not sit on top of the thing you were about to click.
- ~~**Does the ring read as a countdown or as a spinner?**~~ **Settled: reads
  as a countdown.**

## 2. It is never in the frame (the ticket's requirement 3)

The hard one, and the only way to check it is to look at the pixels.

1. Set `countdownMs` to something long — 10000 — and relaunch.
2. Scope = Screen. Press Record, wait for the panel, let it run out.
3. Stop after a few seconds, open the take, **scrub to the very first frames**.

The panel must not be in any of them. It is hidden, waited out
(`HIDE_SETTLE_MS`) and destroyed before `start` is ever sent, so a frame with it
in is a real failure, not a tolerance to widen.

Repeat with the **self-timer** (§3), which is the tighter case: a still capture
is taken milliseconds after the panel goes, and the panel's window id is also
passed in `excludeWindowIds` precisely because the hide alone is a race. Look at
`frame.png`.

Also check a **floating thumbnail panel** is not in either — **first confirm
Profile › Still capture does not have "Skip it — straight to clipboard" ticked.**
With it on there is no panel by design, and its absence reads as a bug (it did,
on the first pass):

- Take two or three screenshots and leave the panels sitting there.
- Press Record. They should **settle** (save or copy, per the preference) rather
  than sit in the recording — `recorder:start` calls `closeThumbnail()`, the
  same call quit makes. Confirm the shots survived, in the library.

## 3. The self-timer, and whether it does what it is for

⌃⌥⇧⌘5, or **Capture with Self-Timer** in the menu bar.

1. From another app entirely, press ⌃⌥⇧⌘5.
2. The scope overlay opens (drag an area, or press W for a window) — the same
   overlay a plain capture uses. Confirm.
3. Only then does the countdown start. "Capturing in".
4. **While it runs, open a menu or a dropdown in another app and leave it
   open.** That is the whole feature.
5. The shot must contain the open dropdown.

What is being judged, and it is §0's claim:

- Does clicking into the other app to open that dropdown feel like it cost
  anything? The panel loses focus, so **Esc and Return stop working** from that
  moment — Cancel and Skip are still one click away.
- Is that acceptable, or does the countdown need to hold the keyboard some
  other way? If it does, the answer is probably not a global Escape; say what
  the problem actually felt like and it can be designed against.
- Is 3 s enough to get to a dropdown in another app? This is the strongest
  argument for a longer default, and the one most worth reporting a number for.

Then confirm it is **one shot, not a mode**: press ⌃⌥⇧⌘1 straight afterwards.
It must capture immediately, with no countdown.

## 4. Reduced motion

System Settings › Accessibility › Display › **Reduce motion**, on.

- Start any countdown. The **ring should be gone** and the **number should
  still count**. A panel that stopped counting would have honoured the
  preference by deleting the feature.
- Electron maps the OS setting onto `prefers-reduced-motion` in the page; if
  the ring is still there, that mapping is what to suspect first, not
  `countdown.ts` — the E2E drives the same code path with the media query
  emulated and passes.

## 5. The shortcut and the menu bar

- **Shortcuts editor** (Profile › the shortcuts list): there is a fourth row,
  **Capture with Self-Timer**, bound to ⌃⌥⇧⌘5. Rebind it, quit, reopen — it
  sticks. Unbind it — the menu-bar item shows no accelerator rather than "—".
- **Menu bar**: the item is there, in the same list as the other three, and
  fires. While a capture is in flight all four grey out.
- Press ⌃⌥⇧⌘5 **while a recording is running**. Nothing should happen — a
  capture during a take is refused the same way it always was.
- Press **Record while a self-timer is counting down**. It should refuse with
  "A capture is already in progress", not start a take underneath the panel.

## 6. Multi-display

With a second display:

- Scope = Area, pick a region on the **second** display, press Record. The
  countdown should appear on that display, not the main one.
- Scope = Window on the second display. The countdown falls back to **the
  display under the pointer** — window scope does not carry a display id, and
  looking one up would mean a second helper round trip for a bounds lookup
  nothing else needs. If that fallback puts it somewhere silly in practice,
  that is the thing to report.

## 7. The wedge, fixed — CONFIRMED 2026-09-16

Reported on the first pass: interrupting a self-timer with another capture
showed "A capture is already in progress", and **nothing could record after
that**.

Root cause found and fixed: `Session.finish()`'s teardown ran outside any
`try/finally`, so a throw there (a window destroyed in the gap after the
`isDestroyed()` check) meant `settle` was never called. The caller's promise
never resolved — `captureStill` waited on it forever with `capturing` still
true and `active` still set — so every later capture and Record was refused
for a capture that had already ended. It is in a `finally` now, and the
`active` handle is published before the session starts and cleared by identity.

To confirm by hand:

1. Start a self-timer (⌃⌥⇧⌘5), pick a scope, and while it counts down press
   **Record** and any other capture shortcut.
2. Each should refuse with a message. The self-timer should carry on and
   complete.
3. **Then record something, and capture a still.** Both must work. That is the
   half that used to be broken.

**Run and passed.** Record is refused *during* the countdown (intended — the
message says a capture is in progress) and works again the moment the
self-timer completes. The app no longer wedges.

## 8. The pill — NOT a bug, and the correction is the useful part

First reported as: after the countdown, the take started but the main window
showed the library instead of collapsing into the pill.

**Resolved on the second pass: Record from the main window collapses the pill
correctly.** The take that did not was started from the **menu bar**, and the
menu bar has never been able to start a recording — `CAPTURE_ACTIONS` is stills
only, so every menu-bar item is a still capture. Nothing was wrong with the
pill, and nothing in this ticket was in its path, which is what the first
analysis said and could not prove from Linux.

That gap is [STC-388](https://linear.app/studio-cartelli/issue/STC-388)'s
entire subject — "menu bar and hotkeys can start a recording; today they only
capture" — and STC-391 is what unblocks it: the countdown STC-388's flow needs
now exists, and `CaptureAction` already holds an action that is not an instant
still.

**The lesson worth keeping: "Record did not do X" needs the ENTRY POINT stated
with it.** Three doors reach capture and only one of them reaches recording at
all, so a report that names the symptom without the door sends the next person
looking at the mechanism rather than at which mechanism ran.

## What is deliberately not here

- **No "Off" in the duration control.** Rule 1 is that Record always counts
  down, so a control that could switch it off would contradict the feature.
  `countdownMs: 0` remains storable by hand.
- **No countdown on the menu-bar or hotkey Record.** There is no such entry
  point yet; STC-388 owns the Record flow from every door, and this ticket's
  countdown is what it will call.
- **No sound.** The shutter still plays on a completed capture, as it always
  did. Whether a tick belongs on a countdown is not this ticket's question.
