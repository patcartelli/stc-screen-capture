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
