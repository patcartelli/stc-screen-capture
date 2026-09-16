# STC-391 — the countdown, on a Mac

Written on Linux. The component, both ways in, and the preference are built and
tested; **nothing here has been looked at**. This is what only a Mac can settle,
in the order worth doing it.

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

- **Is 3 s right?** The ticket's own Open item, answered as a default rather
  than settled. It is `countdownMs` in `~/Library/Application
  Support/Electron/settings.json` — edit it and relaunch. 0 turns it off.
  Deliberately no control in this ticket; if a number other than 3 s wins, say
  so and a control becomes worth building.
- **Is the bottom centre right?** It is over the work area, so it clears the
  Dock and the menu bar. The alternative was centre-screen, which is what
  CleanShot does and what blocks the most clicks. If it covers something that
  matters, `PANEL`/`PANEL_MARGIN` in `countdown-window.ts` are the dials.
- **Does the ring read as a countdown or as a spinner?** It sweeps 0 → full
  over the countdown; the number is the real signal and the ring is support.

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

Also check a **floating thumbnail panel** is not in either:

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

## What is deliberately not here

- **No control for the duration.** It is a real stored preference
  (`countdownMs`), hand-editable, with no UI — settled with Patrick before any
  code was written.
- **No countdown on the menu-bar or hotkey Record.** There is no such entry
  point yet; STC-388 owns the Record flow from every door, and this ticket's
  countdown is what it will call.
- **No sound.** The shutter still plays on a completed capture, as it always
  did. Whether a tick belongs on a countdown is not this ticket's question.
