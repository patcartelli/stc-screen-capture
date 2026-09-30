# STC-460 — the Audio pane: what to look at and feel on the Mac

**Not on `master` yet: run it from the PR branch**
`accounts/stc-460-improve-the-editors-audio-pane-polish-level-meters-slider`.

```
git fetch origin && git checkout accounts/stc-460-improve-the-editors-audio-pane-polish-level-meters-slider
npm install && npm run app:start
```

No helper rebuild: nothing here touches capture or the export.

## What changed

Presentation only. The editor's **Audio** popover (same button, same element
IDs) was redesigned:

| Part | What is there now |
|---|---|
| Layout | Still a **popover** (the ticket's default), now 360 px wide with a real fader per track. A docked panel was not built; say so if a meter you can leave open while watching is what you wanted. |
| Polish | A styled 12 px thumb on a 4 px track, `tokens.css` colours, the value in the mono face. Light and dark follow the OS. |
| As-recorded mark | A **tick** on each fader at 0 dB: 75 % on the mic, the far end on system audio. |
| Detent | A **pointer drag** within 2 % of the tick lands on it. Keys never snap. |
| Reset | **Double-click** a slider: mic and system to 0 dB, voice-cleanup strength to 50 %. |
| Fine control | **Shift+arrow** nudges the mic or system level by **0.1 dB**. The label shows a decimal only when the level is not a whole decibel ("+0.1 dB"). Landing within 0.05 dB of 0 returns to exactly 0 dB. |
| Meters | A peak bar under each track plus a clip dot. Per track, measured **after** cleanup, level and mute: what you hear and what exports. Runs only while the panel is open. |

Meters come from `mixBlock` itself (its optional `peaks` argument, measured
in the same loop that makes the sound), read back through
`PreviewAudio.meterNow()` on the audio clock. There is no second audio path;
`transform/test/audio-mix.test.ts` pins that measuring changes no sample.

## Run these

1. **Look.** Open a take with mic **and** system audio. Open the pane in light
   and dark. Does it read as part of the editor (compare with the header row)?
   Are the tick and the thumb legible at 0 dB?
2. **Meters move.** Play at 1x with the pane open and speak / play something.
   The bars should follow the sound within a frame or two, not lag it. Pause:
   they fall to empty in about two seconds.
3. **Meters follow the mix.** Drag the mic slider down while it plays: its bar
   shrinks with it. Mute a track (speaker icon): its bar dims and goes empty.
   Turn "Clean up voice" on: the mic bar should drop a little once the cleaned
   mic swaps in.
4. **Clip.** Boost the mic to +12 dB on a loud passage. The clip dot should
   light red and stay lit about 2 s after the last clipped moment. Back it off:
   it clears. If it never lights on a take you can hear clipping on, or lights
   on a clean one, that is the thing to report.
5. **The tick.** Is the tick exactly under the thumb when the slider reads
   0 dB? (If it is a pixel off on your display, the thumb width in
   `editor.html` is the dial.)
6. **The detent.** Drag the mic slowly through 75 %: does it feel like a
   catch, or like the slider sticking? (2 % is `snapToUnity`'s default radius.)
7. **Keys.** Focus a slider and press Shift+arrow (0.1 dB) and plain arrow
   (about 0.5 dB). The playhead must not move. Double-click resets.
8. **Clock.** Open, close, reopen the pane during playback: no stutter in the
   picture (the meter loop is separate from the audio clock).

## Open

- Meter ballistics (`METER_RELEASE_DB_PER_S` = 30, `CLIP_HOLD_MS` = 2000) and
  the floor (-60 dB) are a first guess; `transform/src/audio-meter.ts` holds all
  of them.
- The fixture's audio decodes to near-silence, so CI proves the wiring and the
  empty state but not a bar moving to a real voice: that is items 2-4.
