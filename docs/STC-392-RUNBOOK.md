# STC-392 — what only a Mac, and a real logout, can settle

Task 5c (D8, quitting with unhandled takes) is written and tested on a
sandbox that cannot safely perform its one genuinely open action — logging
the machine out. This is the runbook for the person who can.

```
npm run app:start
```

---

## §1 — does `powerMonitor`'s `shutdown` event actually fire on a real logout?

`app/src/main.ts`'s `before-quit` handler decides whether to warn about
unsaved takes using `quitDecision({ unhandled, systemInitiated })`
(`app/src/quit-guard.ts`). `systemInitiated` comes from a module-level flag,
`systemShuttingDown`, set only by `powerMonitor.on("shutdown", ...)`.

**What was checked, and how, before this task shipped:** this build's own
bundled Electron type declarations (`node_modules/electron/electron.d.ts`,
searched for the `powerMonitor` `'shutdown'` event) are annotated
`@platform linux,darwin` — darwin support is present in this Electron
version, which is newer information than the "documented for Linux and
Windows only" belief the ticket started from. That is a claim about the
DOCS. Nobody has watched the event actually fire on this app, on this
machine, because doing that needs a real logout or restart, and the
development session that wrote this code was running on the same machine —
triggering one would have ended the session along with the app being tested,
which is not a trade a reviewer should make unasked either, but IS the one
thing this task could not settle from inside itself.

**What "it doesn't fire" costs, by design, so this is safe to leave open:**
`systemShuttingDown` starts `false` and nothing here ever sets it except that
one callback. If the event never arrives — wrong platform build, a macOS
version that behaves differently, anything — every quit is treated as
user-initiated and the app warns every time a take is unsaved, INCLUDING
during a real logout. That is the ticket's own documented fallback ("warn
every time" is a smaller fault than blocking a shutdown), not a guess dressed
up as a check.

**What to actually do:**

1. Build and launch the app normally (`npm run app:start`), or via `open` on
   the packaged bundle if one exists by the time you read this.
2. Take a screenshot or start a recording and leave its post-capture panel
   open, undecided (so `unsavedTakeDirs().length > 0`).
3. Add a one-line `console.log("[power] shutdown event fired")` inside the
   `powerMonitor.on("shutdown", ...)` callback in `main.ts` (or watch the
   Console.app log if the app is launched as a bundle), then log out of the
   Mac (**) — Apple menu → Log Out, or `osascript -e 'tell application
   "System Events" to log out'` from a terminal you are prepared to lose.
4. **What confirms the event fires:** the log line appears in the moments
   before the session actually ends, and — if the app is still alive long
   enough to observe it — no warning dialog blocks the logout.
5. **What confirms it does NOT fire, or fires unreliably:** no log line, or
   a warning dialog appears and sits on screen during the logout. Per the
   design above this is not a crash — the OS will eventually force the app
   closed either way — but it means the fallback is doing all the work and
   is worth knowing.
6. Repeat once for a restart and once for a shutdown if the first result is
   surprising; the three are documented as behaving alike but only logout is
   cheap to test repeatedly.

Update this section with the result — replace "nobody has watched it fire"
with what was actually seen — rather than adding a second, newer claim beside
the old one.

(** — save any other work before doing this. A real logout will end
whatever session is reading this runbook too.)

---

## What to write down

If the event turns out not to fire reliably on this macOS version, the
honest fix is to delete the `powerMonitor` wiring rather than leave dead code
implying a check that isn't happening — `quitDecision` itself does not care
where `systemInitiated` comes from, so removing the listener only changes
the app from "warns every time, with an unused best-effort exception" to
"warns every time," which is already its own fallback behaviour today.

---

## §2 — Task 6, the timed undo toast: written and E2E-tested on Linux, so
## its LOOK and FEEL are unseen

`panel:trash` on a fresh take no longer deletes anything on the spot — it
promises to (`pending-trash.ts`), closes the panel, and shows a small toast
in the same corner the panel was in, with an 8 s (`UNDO_WINDOW_MS`) progress
bar and an Undo button. Everything MECHANICAL is proven end to end by
`app/test/panel-waits.e2e.test.ts`'s "Trash is a promise you can take back"
block: the toast appears, Undo re-presents the panel with the take intact,
and letting it run out empties temp storage. None of that says whether it
READS right.

**What to look at:**

1. Trash a fresh capture (self-timer off is fine) and watch the toast land —
   does it appear where the panel just was, or does it jump? `positionFor`
   uses the same corner and the same `positionFor` call the panel does, so it
   should not jump, but nobody has watched it happen on a real display.
2. **Does the toast steal focus?** It should not — `showInactive()`
   (`toast-window.ts`) is deliberate, so clicking into another app right
   after pressing Trash should keep working normally, and the toast should
   never come frontmost over whatever you click into next. If it DOES read as
   taking focus, that is `ruling 1` failing on real hardware in a way no test
   here can see (this sandbox cannot observe OS key status at all — see the
   STC-391 follow-up entry in CLAUDE.md for the identical gap on the
   countdown panel, found only by a person on a Mac).
3. **Does the progress bar actually reach empty right as the file goes?**
   The bar's `animation-duration` and the timer that calls `shell.trashItem`
   are two different mechanisms driven by the same `UNDO_WINDOW_MS` constant
   (ruling 2) — they SHOULD look synchronized, but the bar is CSS running in
   the toast's own renderer and the commit is `main.ts`'s 1 s sweep interval,
   so there is up to ~1 s of slop nothing here measures.
4. Press Undo at various points — right away, and right at the last moment
   before the bar empties — and confirm the panel that comes back looks and
   behaves like a fresh one (Copy/Save/Trash all present and working), not a
   half-restored one.
5. Trash several captures in a row before any toast expires, and confirm
   only ONE toast is ever on screen (`showUndoToast`'s "one instance"
   design) — the earlier promise should still be kept on schedule even
   though its own toast never got to finish.
