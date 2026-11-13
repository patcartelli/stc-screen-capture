# STC-624: e2e crash-at-quit triage (2026-11-12)

The review on 2026-11-12 counted 37 of 49 `test` jobs printing
`died from SIGSEGV while closing`. Nobody had separated them. This sorts every
one since the `[tray]` log landed (#432, 2026-11-02 17:54 UTC) into a crash
class, using the job logs and the `ips-summary` blocks.

## Corpus

- 163 `test` jobs from 175 CI runs, 2026-11-02 17:54 to 2026-11-12 (82 success,
  31 failure, 49 cancelled, 1 null).
- **196 crashes at quit in 111 jobs.** All are `SIGSEGV` as `closeApp` reports
  them. The 37 was an undercount: one job can hold up to 3.
- 93 `Electron-*.ips` summaries. The step that collects them runs only on
  failed or cancelled jobs, so most crashes have a window log and no report.
  All 93 carry Electron Framework UUID `4c4c4442-5555-3144-a1e9-1c53c30304e8`,
  which is byte-identical to `node_modules/electron` 43.4.1. So the local
  framework can be disassembled at CI's offsets.

## Step 1 from the review: does a `set-menu` follow the tray `destroy`?

**In none of the 196.** 194 end `[tray] destroy … <- runQuitTeardown`, then
`[window]` lines, then the crash. The other 2 crashed before the destroy line was
written. By the review's test, no crash matches this ticket. Native evidence
says some do, though, so the test is wrong. See class B.

## The two classes

Grouped by the faulting thread's top frames (`@` = offset in Electron Framework):

| class | reports | windows at quit | top frames | what it is |
| -- | -- | -- | -- | -- |
| **A** | 89 | **every one has a `thumbnail.html` panel**, usually the focused one | `@0x1ff6f88 > @0x21d8c10 > @0x21d8b40`, then `@0x21d8b0c` from `-[NSWindow becomeKeyWindow]` (45), or `@0x2a0b0f4` from an `NSNotificationCenter` post in `-[NSWindow resignKeyWindow]` (44). Reached through `NSApplication _handleActivatedEvent:`/`_handleDeactivateEvent:` | **STC-534 / electron/electron#54860**: AppKit moves key status onto or off a window that is being torn down |
| **B** | 4 | **every one has `pill.html`**, i.e. quit mid-recording | `objc_msgSend+32 > @0x2a19f84 > @0x28f31d0 > @0x28f598c`, fault at `0x10` | **this ticket**: `Tray::SetContextMenu` |

Class A reports split 45 `becomeKeyWindow` and 44 `resignKeyWindow`.

Window-log census for all 196 crashes (most have no `.ips`):
187 had a `thumbnail.html` panel open (class A's shape). 9 had a `pill.html` open
(class B's shape; one also had a toast). 4 of those 9 have a report, and all 4
are class B. 186 of the 196 crash right after a panel window's
`destroyed: closed`. The library is the window AppKit hands key status to next.

By test file: `recording-copy.e2e` 113, `thumbnail.e2e` 63, the rest 20. Those
two files are the ones that quit with a panel up.

## Class A: an app fix is available

`runQuitTeardown` → `closeThumbnail()` → `dismissNow()` hides **and destroys in
the same tick** (`thumbnail-window.ts`, the `hide(); destroy();` pair). That is
the same move STC-588 found in `countdown.e2e`: destroying a window that is
still key makes AppKit move key status mid-teardown. The countdown's own fix is
to hide, wait `HIDE_SETTLE_MS`, then destroy. At quit, the panels have nothing
like it.

So the high crash rate is not a regression in the STC-534 fix. It is the same
bug reached by a path that fix never covered.

**Done on this branch:** `closeThumbnail` now hides every panel, waits
`HIDE_SETTLE_MS` (40), then destroys. It re-reads the panel list after the wait,
so a panel presented during it closes too. That is the order
`countdown-window.ts`'s `finish()` and the pill already use.
`app/test/thumbnail-quit-order.test.ts` pins the order at the source and has a
control showing the old body fails it. The trigger is a timing coincidence on
CI's window server, so the evidence is the crash count in `recording-copy.e2e`
and `thumbnail.e2e` falling over the next ~20 jobs, not one green run.

## Class B: symbolicated by disassembly; caller still unknown

Disassembled against the local framework (same UUID as CI):

- `@0x28f31d0` is inside the JS binding `Tray::SetContextMenu`. It holds the
  `"Must pass Menu or null"` literal and calls `0x2a19f2c`.
- `@0x2a19f2c` (frame 1 returns to `+0x58`) is `TrayIconCocoa::SetContextMenu`:
  `[[MenuController alloc] initWithModel:… useDefaultAccelerator:NO]`, then
  `objc_msgSend` to the object at `this+0x40` (the status-item view). That
  receiver's `isa` reads as zero, so the fault is at `0x10`: freed, zeroed memory.
- `@0x28f23a4`, called first by `SetContextMenu`, is `Tray::CheckAlive`: it
  proceeds only when `tray_icon_` (`this+0x50`) is non-null and otherwise throws
  `"Tray is destroyed"`.
- `@0x28f2358` is `Tray::Destroy`: it stores null to `this+0x50`.

**The consequence:** `setContextMenu` on the Tray that `runQuitTeardown` destroyed
cannot reach the crash. It would throw `Tray is destroyed`. The Tray that crashed
still had its `tray_icon_`, and its status-item view was gone. Yet each report
lands 100–150 ms *after* the logged destroy (`.542→.641`, `.304→.454`,
`.369→.496`, `.595→.721`), and no `create` or `set-menu` line follows it.
`installTray` is the only `new Tray` and the only `setContextMenu` in `app/src`,
and `reconcileIcons` returns once `quitting` is set, which nothing resets.

Two explanations remain, and the logs cannot tell them apart:

1. A Tray was created and given its menu during the quit, all in one tick (the
   way `installTray` does it), and its two `[tray]` lines were lost. On macOS
   Node writes to a pipe asynchronously, and the process died in the same
   synchronous call.
2. The JS `Tray` wrapper is not ours, or Electron calls `setContextMenu` itself
   at quit. Nothing found supports this.

The trigger condition is new and testable: **all 9 pill-open crashes quit 3–50 ms
after `[tray] set-menu recording via … reconcileTrayRecording`**. That means the
app quit while the take was starting and the tray had just swapped to the
recording menu. Neither `record-flow`, `mic-picker` nor `countdown` waits for the
take to settle before closing.

## What a person quitting can hit

- Class A needs a thumbnail panel that is key at the moment of quit. A real user
  can do that: shoot, click the panel, ⌘Q. STC-650's clean-Mac quit should
  include that case and not only "quit from the menu bar with nothing open".
- Class B needs a quit within about 50 ms of a take starting. That is unlikely by
  hand. Not ruled out.

## Next steps

1. Class A: the fix is built (above). Count crashes in
   `recording-copy.e2e`/`thumbnail.e2e` over the next ~20 jobs once it merges.
   Re-run this triage's classifier to check.
2. Class B: make `[tray]` writes synchronous (e.g. `fs.writeSync(2, …)` in
   `logTray`) so a line written in the crashing tick survives. Add a repro test:
   start a take, quit at once, loop it.
3. Frames 8–23 are JIT and cannot be symbolicated. Electron's published
   `-symbols.zip` (128 MB) would name class A's three Electron frames properly.
   It was not downloaded here.

Raw data, in this session's scratchpad only: 163 job logs, `crashes.json`
(per crash: run, job, pid, file, window/tray block) and `ips.json` (per report:
frames and UUID).
