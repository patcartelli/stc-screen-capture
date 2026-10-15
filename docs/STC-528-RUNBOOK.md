# STC-528 runbook — the pill's live mic level and silent spans

**Branch:** `accounts/stc-528-live-mic-level`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-528-live-mic-level
npm ci
helper/build.sh
npm run app:start
```

## What changed

- **The helper measures the mic.** `MicCapture` takes each buffer's peak (the format is pinned
  float32 since STC-485) and sends a `level` reading on the LOSSY stdout channel, at most 15 a
  second (~13 with 512-frame buffers). Never fd3: a meter must not be able to back-pressure the
  take. The rules are pure, in `helper/src/MicSignalDecisions.swift`.
- **Silence:** every buffer's peak under **-60 dBFS**. After **10 s** of it the reading says
  `silent: true`. A pause ends any silent stretch, and paused time never counts.
- **The pill's meter is live.** Hatched until the first reading (so a take with no mic, or a mic
  that never delivers, stays hatched), a bar on a -60..0 dB scale while there is signal, and after
  10 s of silence a flat baseline with an **amber dot** at its end, tooltip "No mic signal for
  10 s" (Patrick, 2026-10-15). It clears the moment signal returns. A lost mic (STC-237) puts it
  back to hatched. **Warn only:** no toast, no sound, no offer to stop.
- **anchors-13** adds `mic.silentSpans: [{startNs, endNs}]`, each from where the silence began to
  the first moment there was signal again, a pause, or the end of the track. Written only when
  there is one, so only then is the take v13. `anchors.partial.json` is rewritten when a span
  starts and when it ends, so a crashed take keeps it; crash recovery accepts a v13 partial.
- **Fault:** `STC_CAPTURE_FAULT=mic-silent` zeroes the MEASURED level only. The audio written to
  `mic.m4a` is untouched.
- The library note ("No mic signal from 1:10 to 4:30") is **not** here. It is STC-529's.

## §1 — the fault, from your terminal (grant test)

```
npm run test:capture -- helper/test/mic-signal.grant.test.ts
```

Needs Screen Recording, Input Monitoring and Microphone for the terminal. Must show: with the
fault, readings on stdout only, `silent` only after ~10 s of them, no mic warning, the take
running to its stop, anchors v13 with ONE span starting at the mic's first sample, and
`mic.m4a` decoding to the span it recorded. The control (no fault) must show at least one
non-zero reading and no span.

## §2 — the meter, by eye

1. Record with a mic selected and talk. The bar in the pill moves with your voice. Normal speech
   should sit around the middle; a clap should fill it.
2. Stop talking for 15 s. Around 10 s in, the bar flattens to a line and the amber dot appears.
   Hover the pill: "No mic signal for 10 s". Start talking: the dot goes and the bar comes back
   at once.
3. Record with **no** mic. The meter stays hatched the whole take.
4. Record with a mic and pause for 15 s in silence, then resume. No dot while paused (the bar
   reads empty), and no span in `anchors.json` for the pause.
5. Mute the mic's input in System Settings → Sound → Input (volume to zero) and record 15 s.
   The dot appears after ~10 s. `anchors.json` has `"version": 13` and a `silentSpans` entry.

What only an eye can say: whether a white bar next to the red dot reads as a level or as noise;
whether the amber dot at 4 px is visible on a pill in the corner; and whether the meter's
motion (~13 Hz, 60 ms easing) looks live or jittery.

## §3 — tuning the threshold (the ticket's open item)

The two numbers are guesses: `MicSignal.silenceFloorDbfs` (-60) and `MicSignal.silentSpanMinNs`
(10 s), both in `helper/src/MicSignalDecisions.swift`. The pill's tooltip and floor are read from
there by `app/test/pill.test.ts`, so change them in the Swift and the test tells you what else to
move.

1. Record a real narration take, 3-5 min, with natural pauses: thinking, a breath, reading
   something on screen.
2. Open its `anchors.json`. **`mic.silentSpans` should be absent**, or hold only pauses you
   really took longer than 10 s. A span over a breath or a short pause means the duration is
   too short.
3. Record 30 s in your quietest room with the mic live and nobody talking. If that makes a span,
   the room's noise floor is under -60 dBFS on this mic, and a real "nobody is talking" stretch
   will read as "no mic signal". Decide whether that is right (it may be: no voice is no signal
   for the person watching) or whether the floor should drop to -70.
4. With the mic muted (§2.5) the span must still appear: digital silence is far under either
   floor.

Report back the narration take's spans and the quiet-room result; the change, if any, is one
constant.
