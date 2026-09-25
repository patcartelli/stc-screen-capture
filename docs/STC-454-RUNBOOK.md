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

**Result (2026-09-25, Patrick): everything worked.** Part 1 merged as #228.

---

# Part 2 — mic level, and the Audio popover

**Run from `claude/optimistic-ride-ed374b` until it merges** (same commands as
at the top).

## What changed

Patrick's decisions (2026-09-25):

| Question | Answer |
|---|---|
| Can the mic be made louder? | **Yes, up to +12 dB.** Narration is usually recorded well below system audio. The hard limit that was already in the mix catches peaks. |
| Where do the controls live? | **In an "Audio" popover** at the right end of the timecode row. It holds Mic, System audio and Clean up voice, with room for part 3's mutes. The row had filled up. |
| Default? | **As recorded**, so existing takes and exports are unchanged. |

- The **mic slider** marks "as recorded" (0 dB) at 75%. Below that it falls in
  dB, and 0% mutes. Above it, it boosts up to +12 dB at 100%. The value is
  saved as `micLevel` on the take (project-11), and it is heard live in the
  preview and in the export.
- **Both sliders show dB now**, so the panel speaks one unit: "0 dB",
  "−24 dB", "+6 dB", "Muted". The System audio slider's positions and saved
  values did not change; only its label did (it used to show %).
- A mic-only take with a level other than 0 dB exports through the mixer, as
  48 kHz stereo, the same as a cleaned one. At 0 dB it takes the old path,
  unchanged.

## §4 — the Audio popover

1. Open a take with a mic. **Audio** appears at the right of the timecode row.
   Click it: the panel shows Mic and Clean up voice. Escape, or a click
   outside, closes it. A take with system audio also shows System audio. A
   take with neither has no Audio button.
2. Does the panel open in a sensible place (above the button, or below it if
   there is no room)? Is it readable in light and dark mode?

## §5 — the mic level, by ear

1. On a take where your voice is quiet against system audio, play at 1x and
   raise Mic. The voice should get louder in the preview within about half a
   second.
2. Push it to +12 dB on a loud passage. Harsh clipping at the peaks is the
   hard limit doing its job; note how bad it sounds. If it is common at
   +6 dB or so, a limiter that is softer than a hard clip is the follow-up.
3. Export at +6 dB and at 0 dB. The first should be louder, and the second
   should match an export from before this change.
4. Close and reopen the take: Mic is where you left it.

## In the app (Linux-verified, not heard)

- `transform/test/audio-mix.test.ts`: the gain applies to the mic only,
  boost is capped at +12 dB, a boosted peak is hard-limited, the taper sits
  at 75% = 0 dB, every position round-trips, the dB labels, and the export
  path choice.
- `transform/test/trim.test.ts`: project-11 parses, writes and validates, v11
  is a superset of v10, and the parser, the schema and the mixer agree on the
  ceiling.
- `app/test/mic-level.e2e.test.ts`:
  - the button and rows appear per track, and the popover opens and closes
    on Escape;
  - a boost saves at v11, and returning to 0 dB drops the key;
  - a reopened take shows the saved level;
  - arrow keys on the focused slider change the level, not the playhead
    (mutation-checked).
- The existing voice-clean and system-audio e2e suites open the popover
  first now; the system-audio suite also expects dB labels.

**Result (2026-09-25, Patrick): "looks good".** Part 2 merged as #229. The
Audio pane's look and feel is its own follow-up, STC-460.

---

# Part 3 — mute per track

**Run from `claude/optimistic-ride-ed374b` until it merges** (same commands as
at the top).

## What changed

Patrick's decisions (2026-09-25):

| Question | Answer |
|---|---|
| How is a mute stored? | **As its own field** (project-12 `micMuted` / `systemAudioMuted`), not as level 0. Un-muting brings back exactly the level you had. |
| Per take, or a default for new takes? | **Per take only.** Every new take starts un-muted. |
| Every track muted? | **No audio track** in the export, the same as a take recorded without sound. Not a silent track. |
| The control? | **A speaker before each track's name** in the Audio popover. It shows a cross when muted; the slider and its dB value dim but stay where they were. |

- A muted track is **left out of the export**, not mixed in at zero. A take
  whose other track is untouched therefore exports exactly as it would have
  without the muted track: a mic-only take with system audio muted takes the
  same path as a take that never recorded system audio.
- The **preview** hears a mute at once. The muted track plays at zero, so the
  picture's audio clock does not change under a mute.
- The header's speaker (part 1) is still the **app-wide** preview mute. It
  never touches the take or the export. The per-track speakers do both.

## §6 — the mutes, by ear

1. Open a take with a mic and system audio. Open **Audio**: each track has a
   speaker before its name. Play at 1x and mute System audio. It should go
   silent within about half a second, with the voice carrying on and the
   picture not stuttering. Un-mute it: it returns at the level the slider
   shows.
2. Move the Mic slider to +6 dB, mute the Mic, and close and reopen the take.
   The speaker should still be crossed, with the slider still at +6 dB.
   Un-mute: +6 dB is back.
3. Export with **System audio muted**, and play the file. It should hold only
   the voice.
4. Export with **both muted**, and open the file in QuickTime and Finder's
   Get Info. There should be no audio track at all: no volume control in the
   player, and only "H.264" under Codecs.
5. Is the speaker easy to hit, and does the crossed state read as "muted" at a
   glance, in light and in dark mode?

## In the app (Linux-verified, not heard)

- `transform/test/audio-mix.test.ts`:
  - a muted system track sends the mic down the untouched path, unless the
    mic itself asks for the mixer;
  - a muted mic is neither cleaned nor leveled;
  - everything muted means no audio at all;
  - muting a track the take doesn't have changes nothing.
- `transform/test/trim.test.ts`:
  - project-12 parses, writes and validates, and only a real `true` mutes;
  - a mute keeps both levels and everything else v11 carries.
- `app/test/mic-level.e2e.test.ts`:
  - muting saves at v12 with the slider unmoved, and un-muting drops the key;
  - system audio has its own mute;
  - a reopened take shows its mute;
  - Space on the focused speaker toggles it without starting playback
    (mutation-checked);
  - with every track muted the exported MP4 has no `mp4a` or `soun`. With
    the mute not passed to the export plan (mutation-checked), the same export
    fails trying to encode the placeholder mic.

# Part 4 — the waveform on the ruler

**Stacked on part 3.** Until #230 merges, run this from
`claude/magical-cori-9p47kd`, not `claude/optimistic-ride-ed374b`:

```
git fetch origin claude/magical-cori-9p47kd
git checkout claude/magical-cori-9p47kd && git pull
npm install && npm run app:start
```

## What changed

Patrick's decisions (2026-09-25):

| Question | Answer |
|---|---|
| Where does it go? | **On the ruler**, like Clip activity: no new lane (STC-444 found three lanes cluttered). |
| What does it show? | **The export's mix**: the mic (cleaned when cleanup is on) plus system audio at their levels, a muted track contributing nothing, hard-limited. |

- A second toggle sits on the ruler's left edge, beside Clip activity's. It
  shows only for a take with audio, starts **off** each time the editor opens,
  and is never saved (the same rule Clip activity follows). Pressed, it
  turns green.
- The waveform is drawn mirrored about the ruler's middle on a **linear**
  scale: full height is full scale, where the mix's hard limit clips. So a
  -12 dB move shrinks it to a quarter of its height.
- It is computed from `mixBlock`, the same function the export encodes and
  the preview plays (`transform/src/waveform.ts`). A level, a mute or a
  finished voice cleanup redraws it. The work runs in 8 ms slices, taking
  about 1.5 s per 10 minutes of two-track audio (measured in Node). Until
  the new drawing lands, the old one stays up.

## §7 — the waveform, by eye

1. Open a take with narration. Turn the waveform on. Do the shapes line up
   with the voice: a word starting where the waveform rises, a pause lying
   flat? Play at 1x and watch the playhead cross a loud word as you hear it.
2. Open **Audio** and drag the Mic slider down to about -20 dB, then release.
   The waveform should shrink. Mute the mic: on a mic-only take it goes flat;
   with system audio, only the system audio's shape stays.
3. Push the Mic to +12 dB on a loud take. Peaks that hit the top and bottom
   edges are where the export clips. Is that useful, or does it just read as
   "the waveform got taller"?
4. Turn Clip activity on as well. Can the two still be told apart, or is it
   one or the other?
5. Zoom the timeline right in (scroll on the ruler). The waveform
   has 1024 points across the whole take, so on a long take zoomed far in it
   turns blocky. Is it still useful there?
6. Open a 10-minute take. Does the waveform appear within a few seconds of
   the picture, and does playback stay smooth while it computes?
7. Light and dark mode: is the green legible against the ruler, and does it
   stay out of the way of the ticks and playhead?

## In the app (Linux-verified, not seen)

The fixtures' audio decodes to silence, and there is no AAC encoder here, so
no waveform with any height has been drawn anywhere.

- `transform/test/waveform.test.ts`:
  - agrees with `mixBlock`'s own output, sample for sample, over a whole
    timeline with two offset tracks, both levels and an odd block size;
  - buckets by session time, and catches a single-sample spike;
  - applies levels and the hard limit; a level-0 (muted) track contributes
    nothing;
  - yields once per block.
- `app/test/waveform.e2e.test.ts`:
  - no toggle without audio;
  - the toggle starts off; the peaks are computed once the audio decodes;
    pressing it shows the overlay;
  - muting the mic recomputes the peaks (mutation-checked: without the
    recompute, the test fails);
  - Space on the focused toggle flips it without starting playback
    (mutation-checked).
