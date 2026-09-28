# STC-235 — display hot-swap: what to run on the Mac

Written on Linux with no `swiftc`/ScreenCaptureKit for Tasks 1-9. **Task 10's
Swift (`helper/src/Capture.swift`, `DisplayChangeDecisions.swift`) compiled
and typechecked but never ran against a real `SCStream`.** Task 11 (this
runbook plus `helper/test/display-refit.grant.test.ts` and the frame probe)
ran on a Mac, but **that Mac has no Screen Recording grant**, so even here
the grant test only got as far as `SKIP-GRANT` (`-3801`, "The user declined
TCCs…") — see §0. Everything below this line is still owed to a machine that
holds the grant. Nothing here has been watched.

## Branch — both PRs are unmerged

Run this from `accounts/stc-235-helper`, stacked on PR 1's
`accounts/stc-235-display-hot-swap`. Neither has merged yet (Controller
Ruling 2: PR 1 opened, not merged; the helper work is a stacked branch).

```
git fetch origin
git checkout accounts/stc-235-helper
git pull
```

If PR 1 has since merged into `master` and PR 2 (this branch) has not, rebase
onto `master` before running any of this rather than assuming the stack is
still current — check `git log --oneline -5` matches what you expect first.

## 0. Build and the grant

```
helper/build.sh
```

This take needs **both** grants, not just Screen Recording — since STC-315
the helper refuses to start any capture without Input Monitoring too
(`docs/STC-315-RUNBOOK.md` §0). For `npm run test:capture`, both grants
belong to the **terminal** you run it from (PHASE-0 §6: a bare CLI binary
inherits its launching process's TCC identity):

- System Settings › Privacy & Security › **Screen Recording** → your terminal app
- System Settings › Privacy & Security › **Input Monitoring** → your terminal app

Then:

```
npm run test:capture -- helper/test/display-refit.grant.test.ts
```

Expected with both grants: **5 passed** — `refit`, `refit while paused`,
`paused from the start` (the geometry-unrepresentable stop), `display-gone`,
and the no-fault `control`. The paused-from-start case starts the helper with
`STC_CAPTURE_START_PAUSED=1`, which engages the take's own `pause()` before the
stream exists, so no frame can beat it — the first hardware run showed a
`pause` COMMAND never could (the first frame was always written first), so the
old measure-and-retry version never tested anything. It waits for the helper's
`refit: geometry armed` stderr line before resuming. Without the grant(s), every test
throws `SKIP-GRANT` (Screen Recording) or the Input Monitoring variant of the
same message, naming which one — that is what this session's own run showed
(`code: "no-displays"`, `-3801`), and it is not a code finding, only an
environment one.

`npx vitest run --project unit helper/test/frame-probe.test.ts` runs with NO
grant at all — it is the mechanism check, on `fixtures/basic/display.mp4`,
and passed here.

## 1. Whether `updateConfiguration` survives a real mode change

Run the grant test (§0) and read its stdout/fd3 for the `display-refit`
warning's `path` field (`refitLanded`, `Capture.swift`): `"update"` means
`updateContentFilter`/`updateConfiguration` both answered without error;
`"restart"` means one of them errored and `restartStream` ran instead. The
injected fault only exercises the SAME display staying present with a forced
pillarbox, so it says nothing about which path a REAL resolution change
takes — that is what this section is actually for. Trigger a real change
(System Settings › Displays, change the resolution or scaling of the
recorded display) mid-take and read the same field.

What to look at: the `display-refit` warning's `"path"`. **What sends this
back:** neither path erroring — i.e. `apply` hitting `failRefit` and the take
stopping with `display-reconfigured` for what should have been a survivable
mode change.

## 2. The real seam length

`geometry[1].startNs` minus the PTS of the frame immediately before it (the
last frame under the OLD configuration) is the gap nothing was captured for.
Get both from the demuxed sample table — `transform/src/demux.ts`'s
`demuxTrack` (as the grant test itself does), or `node scripts/export-one.mjs
<take> 20`'s own probe output — never by eye from the exported video, which
can hide a short gap inside a held frame.

```js
const { demuxTrack } = await import("./transform/src/demux.js");
const { memorySource } = await import("./transform/src/chunk-reader.js");
// read display.mp4 into an ArrayBuffer, then:
const video = await demuxTrack(memorySource(ab, "display.mp4"), "display.mp4");
const seamStart = video.framesNs.filter(t => t < geometry[1].startNs).at(-1);
console.log("seam (ns):", geometry[1].startNs - seamStart);
```

What to look at: the seam in milliseconds, for both an `"update"`-path refit
and a `"restart"`-path one (§1) — a restart should read meaningfully longer,
since it tears down and rebuilds the SCStream rather than reconfiguring it in
place. **What sends this back:** a seam long enough that the exported video
in §3 shows a visible freeze or stutter rather than a clean cut.

## 3. THE ACCEPTANCE — a real scaled-resolution change mid-take, watched

This is the one section that actually answers "does STC-235 work":

```
mkdir -p /tmp/stc-refit && \
(echo '{"cmd":"start","dir":"/tmp/stc-refit","seq":1}'; \
 sleep 5; \
 echo "-- now change System Settings > Displays > scaling by hand --" ; \
 sleep 10; \
 echo '{"cmd":"stop","seq":2}') | helper/build/stc-helper 3>&1 | jq .
```

While it is recording (between the two `sleep`s), open System Settings ›
Displays and change the scaled resolution of the display being recorded.
Then:

```
node scripts/export-one.mjs /tmp/stc-refit 20
```

**Watch it.** Expect: the take did NOT stop — it is one continuous
`display.mp4`/export; `anchors.json` has `version: 7` and a two-entry
`geometry`; the letterbox appears exactly where `geometry[1].contentRect`
says (§8 checks the unit); the cursor tracks correctly on BOTH sides of the
seam — before the change it fills the frame, after it the cursor's on-screen
position still matches the (now letterboxed) picture; playback timing stays
continuous through the seam (no visible pause beyond what §2 measured).

**What sends this back:** any visible desync between the cursor and the
picture on either side of the seam, a letterbox that does not match
`contentRect`, a visible corruption at the seam, or the take stopping instead
of continuing.

**Also watch the seam itself, frame by frame** (scrub the export across
`geometry[1].startNs`). Two things nothing off-hardware can answer:

- **(a) Does SCK deliver frames in the NEW mode through the OLD
  configuration during the seam?** Between the physical change and the
  refit landing there is roughly 0.3–0.5 s: the 250 ms debounce, the
  `SCShareableContent` fetch, then the `updateConfiguration` round trip. If
  SCK keeps delivering in that gap, those frames are the new mode's pixels
  squeezed through the old config — they are recorded under `geometry[0]`,
  and would show as a squashed or wrongly-letterboxed picture with a
  misplaced cursor for a few frames right before the seam. Note how many
  frames, and whether it is visible at normal playback speed. A few frames
  may be acceptable; a visible jolt is worth its own ticket.
- **(b) Does `SCShareableContent`, fetched 250 ms after the last CG
  callback, still report the OLD `SCDisplay` size?** If it does, the refit
  fits the old size and the letterbox is wrong for the whole rest of the
  take. Check: `geometry[1].display`'s `pointWidth`/`pointHeight`/
  `pixelWidth`/`pixelHeight` in `anchors.json` against the mode you actually
  selected in System Settings. If they are the old mode's numbers, it sends
  this back: the settle delay is too short, or the refit needs to re-fetch
  until the size changes.

**Deviation from the spec: there is no quiet "Display changed — recording
continues" note.** The spec asked for one; it was not built (Ruling 12). The
pill still showing the take running is the only sign the take survived.
Do not report its absence as a bug.

## 4. Unplug an UNRELATED display mid-take

With two displays connected, record the one you are NOT about to unplug,
then physically disconnect (or use System Settings to turn off mirroring
for) the other one. Expect: the take continues; `stop.reason` never fires.
CG calls back for every display, so the refit path DOES run — but
`refitNeeded` (`DisplayChangeDecisions.swift`) compares the result with what
the stream is already configured for:
- if nothing about the captured display changed, nothing happens at all:
  no SCK call, no `display-refit` warning, and `anchors.json` stays at its
  usual version (≤ 6) with no `geometry` key. stderr logs `refit: nothing
  this take depends on changed`.
- if the captured display's own origin shifts (macOS can reflow display
  arrangement when one disappears), the stream is still left alone, but a
  `geometry` entry records the new origin (the cursor needs it), with a
  `display-refit` warning whose `path` is `"record"` — Task 10's departure 4 notes this can be recorded late on a very
static screen, since an idle SCK sample (no pixel buffer) satisfies the
refit's liveness check but the geometry entry itself waits for the next
COMPLETE, non-paused frame. **What sends this back:** the take stopping for
an unplug that never touched the captured display at all, or a `"update"`/
`"restart"` refit (a reconfigured stream) for one that only moved it.

## 5. Unplug the CAPTURED display

Record a display, then disconnect it (or, on a laptop, close the lid with an
external captured — whichever actually removes it from
`SCShareableContent`). Expect: the take stops cleanly, `stop.reason:
"display-reconfigured"`, `anchors.json` has no `geometry` key (this is a stop,
not a refit — matches the `display-gone` fault case the grant test drives
directly, §0). **What sends this back:** a hang, a crash, or a stop reason
other than `display-reconfigured`.

## 6. A region near the edge, then a scaling change that shrinks the display

Start a `region`-scope take (`{"cmd":"start","dir":...,"region":{"x":...,
"y":...,"width":...,"height":...}}`) positioned near the current display's
far edge. While recording, shrink the display's scaled resolution enough
that the region no longer fits entirely inside the new point bounds. Expect:
the take stops cleanly, `stop.reason: "region-out-of-bounds"`
(`decideDisplayChange`'s region-fit check, `DisplayChangeDecisions.swift`).
**What sends this back:** the take continuing with a region silently clamped
or shifted, rather than stopping — the spec is explicit that clamping would
silently record a different area than the one picked.

## 7. Whether system audio survives the change

If the machine has system audio wired up (STC-418), record with it on and
trigger a real display change mid-take. System audio's `SCStream` is its own
whole-display audio-only stream (`SystemAudioCapture.swift`), separate from
the display video stream this ticket refits — it is NOT part of the refit
path at all. Expect one of two outcomes: it keeps recording through the
change unaffected, or it dies and the take already has its existing
`system-audio-stopped` warning (STC-418) for that. **Fixing a system-audio
death here is explicitly NOT this ticket** — only record which outcome
happened, for whoever picks that up.

## 8. Whether SCK's `contentRect` attachment agrees with the computed fit rect

`refitLanded` (`Capture.swift`) computes `contentRect` itself
(`fitRect`) and separately compares it against SCK's own `contentRect`
sample-buffer attachment, checked under BOTH a raw reading and a
`× scaleFactor` reading, since the attachment's documented unit ("points")
is ambiguous against a pixel-space capture (plan deviation 2). A mismatch
under both never changes what gets recorded — the computed rect is always
what lands in `anchors.json` — it only emits a second warning,
`display-refit-rect-mismatch`, so this is a read-only check.

Run the acceptance take in §3 (or the grant test in §0) and check whether
`display-refit-rect-mismatch` appears in the output at all:

```
... | jq 'select(.code == "display-refit-rect-mismatch")'
```

**What to look at:** if it fires, its `computed`/`reported`/`scaleFactor`
fields — read whether `reported` matches `computed` under the raw reading or
only under `× scaleFactor` (or neither). **What this settles:** which unit
SCK's attachment is actually in on real hardware, which nothing in this
ticket's write-up nailed down. It does NOT send anything back by itself —
the computed rect is authoritative either way — but a mismatch under BOTH
readings on real hardware is worth its own follow-up ticket to understand,
since it would mean the diagnostic can never fire true and is dead code.

## Notes and expected/known behaviour (not bugs)

- **A take paused from its very start, refitted before its first frame, now
  STOPS with `display-reconfigured` instead of continuing.**
  `anchors-7.schema.json`'s `geometry[0]` must be the take's FULL, unrefitted
  capture frame (`startNs === capture.firstFrameNs`, a full-frame
  `contentRect`) — it cannot describe a first frame that is already
  letterboxed. So if the very first frame a paused take would ever write is
  already under a refit, `Capture.swift` drops it
  (`geometryUnrepresentable`) and the take stops with
  `display-reconfigured` rather than writing a `geometry[0]` that lies about
  what capture actually started as. This is a genuinely new stop case the
  original spec's outcome table does not list (Task 10 departure 9) — expect
  it, do not "fix" it as a bug. Reachable only by pausing immediately at
  start and triggering a refit before ever resuming; ordinary use (recording
  running, then paused later) does not hit it. The grant test's
  `paused from the start` case drives it (§0).
- **CHECK: does a real display-mode change make SCK report
  `didStopWithError` on the CURRENT stream, before the 250 ms refit debounce
  (`DISPLAY_CHANGE_SETTLE_MS`) ever gets to run `refit()`?** If SCK treats a
  mode change as a stream death rather than something `updateConfiguration`
  can absorb, the take would end via the pre-existing STC-306 path
  (`stop.reason: "stream-stopped"`) before this ticket's refit logic is ever
  reached — which would defeat the whole point of STC-235. What to look for
  while running §1/§3: `anchors.json`'s `stop.reason` (should be absent — the
  take should NOT have stopped) and whether a `stream-stopped` warning
  appears in the fd3/stdout log at all. **If `stream-stopped` fires instead
  of a `display-refit` warning, this sends the whole ticket back** — it would
  mean the refit path is unreachable for the one case (a real resolution/
  scaling change) it exists for, and `STC-370-RUNBOOK.md` §3b's own finding
  (a window close is usually won by the SAME `didStopWithError` race,
  beating the newer detection path to the punch) is the precedent for
  exactly this failure mode.

## What is still open after this runbook

Everything above, until it is actually run on a Mac holding both grants.
This session confirmed only: the Swift compiles and runs (frame probe, §0's
mechanism check); `helper/build.sh` signs cleanly; the grant test's five
cases fail with a classified `SKIP-GRANT`, not a crash or a hang, which is
the expected shape of "no grant" rather than a code finding.
