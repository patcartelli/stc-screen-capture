# STC-454 — preview audio: what to listen for on the Mac

**Run this from the branch, not `master`, until it merges:**

```
git fetch origin claude/optimistic-ride-ed374b
git checkout claude/optimistic-ride-ed374b && git pull
npm install && npm run app:start
```

No helper rebuild is needed: nothing here touches capture.

## What changed

The editor's preview **plays sound now**. Before this, only an export could be
heard. It plays the export's own mix (`audio-mix.ts`'s `mixBlock`), so what
you hear in the editor is what the export will contain:

- the mic, **cleaned** when "Clean up voice" is on (STC-455);
- system audio at the level its slider sets (STC-418).

Patrick's decisions (2026-09-25):

| Question | Answer |
|---|---|
| When is there sound? | **At 1x only.** Reverse and 2/4/8x shuttle are silent. |
| Dragging the playhead? | **Silent.** During playback, the sound comes back once the playhead has been still for 150 ms. |
| How to silence it? | **The speaker button** in the header's right-hand group. It is an app setting, remembered across takes and restarts, and never saved into a take or an export. |
| Cleanup in the preview? | **Cleaned, after a short wait.** A change to the switch or strength re-cleans in the background (~1 s per minute of audio). Until it finishes, the previous version keeps playing. |

**How it stays in sync.** While sound plays, the picture follows the audio
device's own clock instead of the system timer, so the two cannot drift
apart over a long take. Sound is scheduled in 100 ms chunks, 0.4 s ahead. If
a chunk would start late, its late part is dropped rather than played late.

## §1 — sync, by ear and eye

Use a take where you **clap on camera** (or tap the mic where the video shows
it), with the camera PiP on.

1. Open it in the editor and play from the start at 1x.
2. Does the clap sound when the hands meet? Try again from the middle
   (click the ruler, then play) and near the end.
3. Let a 5+ minute take play through. Is it still in sync at the end? This is
   the case the single clock exists for.

Record whether any offset is visible, and roughly how much ("a frame or two
late" is useful). The first sample is scheduled 60 ms after Play, and the
picture holds on the first frame until that sample is heard.

## §2 — the rules

1. **1x only.** Press L while playing: the sound stops and the picture runs at
   2x. Press K, then Space: sound again. J (reverse) is silent.
2. **Dragging.** Drag the playhead while playing. It should be silent during
   the drag, and the sound should resume shortly after you let go. Clicks,
   pops or a stutter during the drag are findings.
3. **Mute.** Click the speaker: it shows a cross, and the sound stops without
   the picture pausing. Close the editor, quit, relaunch, and reopen a take:
   the speaker should still be muted. Unmute it.
4. **Levels live.** While playing a take that has system audio, move the
   System audio slider. The change should be heard within about half a
   second.
5. **Cleanup live.** On a noisy take, turn "Clean up voice" on while it plays.
   You hear the raw voice until the clean version is ready (hover the speaker:
   its tooltip says "cleaning up the voice…"), then the cleaned one. Move the
   strength and release: the same thing happens again.

## §3 — what could go wrong

| You hear / see | Likely cause |
|---|---|
| No sound at all, and the speaker isn't dimmed | The AudioContext is not running. Say so: the window's autoplay policy is meant to allow it. |
| The speaker is dimmed with a strike, and its tooltip says unavailable | The audio did not decode. The export is unaffected. Send the tooltip text. |
| Crackle or clicks at a steady ~10 per second | Chunk joins are not seamless. That is a bug, not tuning. |
| The picture stutters at 1x but not at 2x | Following the audio clock is too coarse. Send which take and how often. |
| The editor freezes briefly when cleanup turns on | The cleanup is running on the main thread instead of the worker. That is a bug. |
| Memory climbs a lot on a long take | Decoded audio is held in memory: ~11 MB per minute of stereo 48 kHz system audio, plus the mic, plus a cleaned copy. Note the take length. |

## What Linux verified

- **Scheduling** (`transform/test/preview-audio.test.ts`), unit-tested:
  - which chunks go when, and that sync is exact (`anchor + from / 48000`);
  - that a late chunk loses only its late head, and a wholly late one is
    dropped;
  - that the clock never steps backwards;
  - that chunks mixed one by one are the same samples as the window mixed at
    once.
- **The wired app** (`app/test/preview-audio.e2e.test.ts`, a real
  AudioContext under Xvfb):
  - there's no speaker for a take with no audio;
  - with sound ready, 1x runs on the **audio** clock and 2x on the wall clock
    (mutation-checked);
  - a mic that will not decode leaves the picture playing on the wall clock,
    with the speaker marked unavailable;
  - mute survives a restart, and the button's click flips its state;
  - the cleanup worker loads under the editor's CSP and cleans a track sent
    to it.
- **Nothing has been heard.** The fixtures' audio is placeholder AAC. §1–§3
  are the first time anyone listens.
