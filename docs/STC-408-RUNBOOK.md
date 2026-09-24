# STC-408 — do ORDINARY, uncrashed takes still stitch cleanly, on a Mac

Written on Linux (no `swiftc`, no ScreenCaptureKit, no real Chrome) — this
ticket is a verification ticket by its own wording ("Record normal takes...
and check the final file"), and most of that cannot be done from here. What
follows is what could be checked without a Mac, and an exact list of what is
still open.

```
npx vitest run helper/test/fragmented-writer.test.ts   # needs swiftc — see below
npm run gate:identity                                  # needs real Chrome
npm run app:start                                      # needs a Mac, full stop
```

## What this ticket is actually asking

STC-394 (movieFragmentInterval) answered "does a crash leave a playable
file" and, along the way, established that a CLEANLY finished fragmented
file is byte-shape-identical to today's output — no `moof` boxes survive a
normal `finishWriting`, so "normal-stop output is unchanged" already holds
by construction (`docs/STC-394-RUNBOOK.md`, "The finding this ticket rests
on"). STC-408 exists because that claim was never checked against the two
things that make a take NOT be a trivial straight-through recording:
auto-zoom (does the fragmented capture file feed anything auto-zoom-shaped
differently) and pause/resume (does a real span with the writer sitting
idle — which is what a pause looks like to `AVAssetWriter` — survive
crossing several fragment boundaries with no crash at all).

## What was checked from Linux this session

**Auto-zoom cannot interact with capture-time fragmentation, and that is
structural, not measured.** `grep -ri zoom helper/src` turns up exactly two
hits, both comments referencing the TRANSFORM's `zoom.ts` (one in
`Capture.swift` about the brief's rule 2, one in `PauseDecisions.swift`
about a held-button release) — never a real reference. Auto-zoom is a
render/export-time stage over `project.json` + `events.json` +
`session.changes` (`transform/src/zoom.ts`, `zoom-change.ts`,
`zoom-override.ts`); it has no hook into `Capture.swift`, never touches
`AVAssetWriter`, and cannot know or care whether the source `display.mp4`
was written with `movieFragmentInterval` set at all. So "with auto-zoom
running" changes nothing about whether a take finalizes cleanly — the two
features are on opposite sides of the capture/export boundary. Worth one
eye-check on real hardware for completeness (see §2 below), but there is no
mechanism here to distrust.

**Pause/resume is NOT fully available yet, and the ticket's own wording
("once available") was accurate when filed and still is.** STC-240 is
marked Done in Linear, but only **PR A** — the helper protocol
(`pause`/`resume` IPC commands, `PauseGate`, `anchors-5`'s `pauses` array)
— has landed (`c74e717`, merged). Confirmed by reading
`docs/STC-240-PLAN-A.md`'s own "What PR A deliberately does not do":
*"Nothing user-facing can pause. There is no UI, no hotkey, and the
transform does not act on `pauses` yet."* Checked against the tree:
`grep -rn pause app/src` turns up no real hit (`dotPaused` in `pill.ts` is
an unrelated CSS color name, `mediaplaypause` in `hotkeys.ts` is a media-key
string) and `grep -rn pauses transform/src/render.ts transform/src/trim.ts`
is empty — `session.ts`'s own comment confirms it explicitly: *"v5's
`pauses`... is ACCEPTED AND IGNORED here — this is PR A of STC-240, the
helper half only... a paused take degrades to 'recorded through the pause'
rather than failing to load."* So today, a paused take:
- drops every sample while paused, at the writer, camera, mic, tap and
  cursor-sampler level (`PauseGate`, gated in all five places) — nothing
  paused ever reaches disk;
- but has no UI or hotkey to trigger a pause at all, and its export HOLDS
  the last frame through the paused span rather than cutting it (PR B, not
  yet built) — which is documented, deliberate degradation, not a bug.

The closest thing to "record with pause/resume" reachable at all right now
is `helper/test/capture.grant.test.ts`'s STC-240 `describe` block, driving
`pause`/`resume` directly over the helper's stdin protocol — it already
needs a Mac (`npm run test:capture`) and already asserts the disk
invariant. Its pause is a plain 2s sleep against the DEFAULT 2s
`movieFragmentIntervalSec` (`helper/src/CaptureDecisions.swift`) — close to
exactly one fragment boundary, not several, so it has never been run against
a pause that crosses more than one.

**The gap test, and what CI's macOS runner found with it.**
`helper/test/fragmented-writer/main.swift` and `fragmented-writer.test.ts`
now model an UNCRASHED take with a gap where nothing was appended. This is
exactly what `PauseGate` does to this writer: paused samples are dropped
outright, not held or re-timed, so the next real sample's PTS jumps by the
real elapsed pause. The test writes 300 frames with a gap after frame 120,
finishes NORMALLY, and asserts that all 300 frames survive, the PTS grid is
exact on both sides, and the gap demuxes intact rather than being collapsed
or rebased. That last point matters because the transform's frame-selection
rule ("greatest PTS ≤ t") is what holds the picture through a paused span.

This sandbox has no `swiftc`, so CI's runner was the instrument. Three runs
swept gap sizes and encoder settings (run 35902771313 has the full table):

| gap | fragmented? | result on CI |
|---|---|---|
| 0.5 s, 1 s, 2 s | no | ok: every frame, gap intact |
| 2 s | yes (1 s interval) | ok, identical to unfragmented |
| 3 s, 5 s | no | append fails 5-14 frames after resume (`-11800` / `-17771`) |
| 5 s | yes, and yes + real-time pacing | same failure |
| 5 s | no `AVVideoExpectedSourceFrameRateKey`, or `expectsMediaDataInRealTime = false` | same failure |

**STC-408's own answer is in the top two rows: fragmentation does not
change what a gap does.** The 2 s fragmented gap crosses two fragment
boundaries and comes through exactly like the unfragmented one. Those rows
are what the test asserts.

**The failure at 3 s and above is not a fragmentation property, and it is
now STC-448.** It fails identically without `movieFragmentInterval`, and no
setting tried moves the 2-3 s threshold. It has only been seen on CI's
encoder, the paravirtualized one STC-259 measured behaving unlike real
hardware. STC-240's grant test passed a 2 s pause on a real Mac, which is
below the threshold and says nothing either way. Those rows are not
asserted in this ticket's test. The harness keeps every knob used above
(`STC_FRAG_GAP_SEC`, `STC_FRAG_REALTIME`, `STC_FRAG_NO_EXPECTED_RATE`,
`STC_FRAG_NOT_REALTIME`), so STC-448 re-adds them as one line each.

## What only a Mac can settle

### §1 — the harness's new test, for real

Run `npx vitest run helper/test/fragmented-writer.test.ts` (needs `swiftc`,
present on any Mac with Command Line Tools per `CLAUDE.md`'s Toolchain
section). All four tests pass on CI's runner. On real hardware, the gap test
should print the same `ok` table to stderr.

While you are there, run STC-448's rows too: add
`{ name: "nofrag-5s", gapSec: 5 }` (and a 3 s row) to `CASES` and run the
file once. **A 5 s gap that comes through intact on hardware means STC-448 is
CI-only. A failure means it is real, and §3's 8-10 s pause will lose the
rest of the take's video.** Report either result on STC-448, not here.

### §2 — real takes, end to end

1. Record a SHORT take (10-15s) and a LONG one (past several minutes, well
   beyond the default 2s fragment interval many times over), both stopped
   cleanly. `node scripts/export-one.mjs <dir>` each, watch in QuickTime:
   correct duration, no stutter or visible seam at any point, audio (if mic
   is on) in sync throughout.
2. Repeat the short take with auto-zoom enabled (`project.zoom.enabled`) and
   at least one click/drag to trigger a window. Per the structural finding
   above this should be indistinguishable from a non-zoomed take at the
   capture level — the point of this pass is to confirm that reasoning
   against a real file, not to look for a new failure mode.
3. Compare `anchors.json`'s `stop.t` / the container's own reported duration
   against a stopwatch — STC-394's runbook never checked this for a NORMAL
   stop, only that the file plays.

### §3 — real pause/resume, hand-driven (no UI yet)

Since there is no button or hotkey, drive the protocol directly, the same
shape `capture.grant.test.ts`'s STC-240 test already does, but with a REAL
pause spanning several fragment intervals rather than one:

1. `helper/build/stc-helper` (or via `tools/test-host` for a granted
   identity), send `start`, wait a few seconds, send `pause`, wait **at
   least 8-10 seconds** (several multiples of the 2 s default fragment
   interval), send `resume`, wait a few more seconds, `stop`. If STC-448
   reproduced in §1, expect `display.mp4` to end a few frames after the
   resume. That is STC-448's failure, not a fragmentation one; report it
   there.
2. Confirm `anchors.json` is v5 with exactly one `pauses` entry, and that
   `events.json` has no event inside `[startNs, endNs)` — already asserted
   by the existing grant test at the 2s scale; re-confirm it still holds at
   8-10s.
3. Open `display.mp4` in QuickTime directly: does it play cleanly across the
   seam where the pause was, with no corruption or truncation at the
   fragment boundary the gap crossed? This is the literal STC-408 question
   for pause/resume, and nothing here has run it against a real encoder.
4. `node scripts/export-one.mjs <dir>` and watch the exported preview:
   confirm it degrades exactly as documented (the picture holds/freezes
   through the paused span rather than jumping or glitching) — PR B not
   having landed means a cut is NOT expected yet; a freeze is correct, a
   visible artifact is not.
5. If camera and/or mic were recording, repeat step 3 for `camera.mp4` and
   `mic.m4a` — they share the identical `movieFragmentInterval` change and
   the same `PauseGate`, but (per `docs/STC-394-RUNBOOK.md`'s own §3) have
   never been watched surviving a real gap, paused or crashed.

### §4 — once PR B lands

STC-408's own to-do explicitly wants pause/resume "in progress" checked. If
STC-240 PR B (the transform cut) merges before this ticket is picked back
up, re-run §3 step 4 and confirm the paused span is actually CUT from the
exported timeline rather than held, and that the cut lands exactly at the
fragment-crossing gap with no residual frame from inside the paused span
leaking through (the same invariant the STC-240 grant test already checks
for `events.json`, extended to what the viewer actually sees).

## What is deliberately not here

- No new fault-injection for the app-level pause hotkey/UI, because it does
  not exist yet — that is PR C's ticket, not this one.
- No attempt to test the crash+pause combination (a pause open at the
  moment of a kill). STC-394 already covers "crashed, no pause" and this
  ticket covers "paused, no crash"; the intersection is a real question but
  is not what either ticket's acceptance criteria ask for.
