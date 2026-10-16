# STC-561 runbook — a still screen no longer ends the take

**Branch:** `accounts/stc-561-idle-hold-frame` (not on `master` yet; run it from that branch until it merges).

```
git fetch origin
git checkout accounts/stc-561-idle-hold-frame
npm ci
helper/build.sh
```

## What was wrong

On 2026-10-16 two long takes stopped themselves with `stop.reason: "error"`. One was
25:50 long, system audio only; the other was 34:10 with mic, system audio and camera.
Both happened to be near 2.05 GB at the time, but size was not the cause. Each died
the instant the screen saver ended:

| | screen saver starts | screen saver stops | display writer fails |
|---|---|---|---|
| 13:22:55 take | 13:46:46.6 | 13:48:45.456 | 13:48:45.576 |
| 14:38:06 take | 15:09:30.2 | 15:12:16.014 | 15:12:16.091 |

(From the unified log: `loginwindow`'s ScreenSaverDaemon, and the helper's own
`FFR_Movie signalled err=-17771`.)

Capture is VFR, so nothing is written while the screen does not change. The display
input's `mediaTimeScale` is 1 ns, so a sample's duration (the gap to the next sample)
is in nanoseconds. The movie writer stores that duration in a signed 32-bit field, so
**2^31 ns = 2.147 s is the longest sample it can write**. The first frame after a longer
gap fails the writer (`-11800` over `-17771`), and STC-527 stops the take as `error`.
STC-448 saw the same failure on CI at 3 s and could not say why.

These were measured on this Mac's hardware encoder with `helper/test/fragmented-writer`:

- a 2.12 s gap writes and a 2.14 s gap fails, so the line falls between 2.137 s and 2.157 s samples;
- at a 10 MHz timescale, a 165 s gap writes;
- file size is not the cause: 2.3 GB writes fine through both passthrough and the real encoder.

## What changed

- **A hold frame** (`helper/src/HoldFrameDecisions.swift`). A timer on the
  screen-frame queue checks every 250 ms. Once the newest written frame is 1.5 s old,
  it writes the same frame again at +1 s, so no sample can get near 2.147 s.
  - The picture does not change, because the export holds the newest frame at or before `t`.
  - A still screen costs one extra, nearly empty frame per second.
  - The timescale stays 1 ns, so PTS is still exact integer nanoseconds.
- **A hold is also written during a pause (STC-240).** A pause over 2.147 s had the same
  failure on resume. The held frame repeats a frame from before the pause, never
  anything recorded during it.
- **The stop reply's stats gain `framesHeld`.** `frames` still counts real frames only.
- **Two new faults:**
  - `STC_CAPTURE_FAULT=screen-idle` throws away every complete frame from 1 s to 6 s
    after the first, as a still screen would.
  - `STC_CAPTURE_FAULT=screen-idle-unheld` does the same with holds off: the control,
    and the bug as it was.
- **Tests:**
  - `helper/test/hold-frame.test.ts` covers the pure decision.
  - `helper/test/fragmented-writer.test.ts` gets STC-448's ≥3 s rows back: the limit
    from both sides, plus held gaps up to 165 s.
  - `helper/test/idle-hold.grant.test.ts` is the grant test.
  - The fault soak gets a `screen-idle` row.

The camera writer has the same 1 ns timescale. A camera that stalls for more than
2.147 s therefore fails `camera.mp4` the same way, silently: a camera writer failure
does not stop the take. That is a separate ticket, not this one.

## §1 The grant test (your terminal; the agent's shell has no Input Monitoring grant)

```
npx vitest run --config vitest.grant.config.ts helper/test/idle-hold.grant.test.ts
```

Both tests must pass:

- **`screen-idle`**:
  - the take runs through five still seconds and stops as `user`;
  - `framesHeld` is at least 3;
  - no sample in `display.mp4` is longer than about 1.6 s.
- **CONTROL `screen-idle-unheld`**: the same take ends itself as `error`, and the
  `writer-failed` warning contains `-17771`.
  - If the control fails, the fault did not make a gap and the first test proves nothing.
  - It waits for one frame after the stillness. On a fully static screen, move the
    pointer or let something redraw.

## §2 The real thing: a screen saver mid-take (needs a person)

1. In System Settings › Lock Screen, set "Start Screen Saver when inactive" to 1 minute.
   Write down the old value so you can put it back.
2. `npm run app:start` and record the whole display. Do not touch anything for about
   3 minutes, so the screen saver starts and runs for at least a minute.
3. Wake the Mac and leave it recording for another 30 s, then stop the take.

**Pass:**

- the pill was still recording when you woke the Mac;
- the panel shows an ordinary take, with no "stopped" line;
- `anchors.json` says `"reason":"user"`;
- in the editor the timeline runs through the screen-saver period: the last frame
  before it is held, then the take carries on.

**Fail:** the take ended at the wake with `error` (the bug). Note the time and run:

```
/usr/bin/log show --style compact --last 10m --predicate 'process == "stc-helper" AND eventMessage CONTAINS "FFR_"'
```

Then try the same with the screen **locked** (⌃⌘Q) instead of the screen saver.

## §3 What only a Mac can tell, beyond pass or fail

- **What the screen saver looks like in the take.** ScreenCaptureKit may deliver the
  screen saver's own frames, or nothing at all. The 2026-10-16 takes say nothing:
  165 s with no frames. Either way the take must survive. Whether you want the screen
  saver *in* the video is a product question, not this ticket's.
- **CPU while still.** Activity Monitor on `stc-helper` during a minute of stillness
  should be no higher than before. That is one tiny frame a second.
