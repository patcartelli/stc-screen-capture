# STC-455 — clean narration: what to run on the Mac

**Run this from the branch, not `master`, until it merges:**

```
git fetch origin claude/optimistic-ride-ed374b
git checkout claude/optimistic-ride-ed374b && git pull
npm install
npm run app:start          # §4 only; §1–§3 need no build
```

No helper rebuild is needed: nothing here touches capture.

## What this is

Patrick's order (2026-09-25): **sound first, plumbing second.** The chain
(`transform/src/narration-clean.ts`) was tuned by ear over two rounds (§1–§3,
results at the end) before anything in the app used it. **It is wired in
now:** the editor has a "Clean up voice" switch and strength (§4). The
setting is saved on the project and applied at export.

The listening script still works and is the fastest way to compare
strengths:

```
node scripts/clean-narration-one.mjs ~/Desktop/test/raw/<take>
```

It decodes the take's `mic.m4a` with macOS's own `afconvert` and writes these
files to `~/Desktop/narration-spike/<take>/`:

- `original.wav`: the mic as recorded
- `clean-25.wav`, `clean-50.wav`, `clean-75.wav`, `clean-100.wav`: the same
  mic through the chain at those strengths

Each file's printed noise floor is a number to go with your ears, not a
replacement for them. `--strengths 0.4,0.6` writes other strengths.

**Listen on headphones.** STC-418 §8 already found that the speakers leak
into the mic, and here that leak sounds exactly like "room".

## The chain (one strength moves all of it)

| Stage | Aimed at | What strength changes |
|---|---|---|
| High-pass, 80 Hz | rumble, desk thumps, HVAC boom | on for any strength above 0 |
| Noise reduction (a decision-directed Wiener gain; the profile is learned from the take's own pauses) | fan, hiss, room tone | the deepest cut goes from 8.5 dB (25%) to 16 dB (100%) |
| De-esser, 4.5–9 kHz | harsh "s" and "t" sounds | the deepest cut goes from 3 dB (25%) to 6 dB (100%) |

**There is no echo stage.** It was tried in both rounds and could not be
heard. It is split out as STC-458.

## §1 — record the reference take

This is the fixture the ticket asked for.

1. Headphones on. No system audio. The mic you normally narrate with.
2. **Start with 3 seconds of silence.** The noise profile is learned from the
   quiet stretches, so a take with no pauses at all gives it nothing to
   learn from.
3. Read ~30 s of normal narration with natural pauses. Include some "s"
   sounds: *"Six simple steps: select the session, set its scope, and save."*
4. Record in the room and at the distance you actually use, fan on if it is
   usually on. The point is to catch the real problem, not a clean one.

## §2 — listen, in this order

Open `original.wav`, then each `clean-*.wav`. For each one, write down:

1. **Hiss and fan in the pauses.** Gone, quieter, or unchanged?
2. **The voice itself.** Natural, or thin, underwater, lispy, or robotic? The
   classic failure is **"musical noise"**: a watery chirping in the pauses.
   Note the lowest strength where you hear it.
3. **Pumping.** Does the level swell between words?
4. **Harshness.** Are "s" sounds softer? Do they sound lispy ("th")?
5. **Which file would you ship?** That strength becomes the slider's default
   once the switch is built.

## §3 — what each answer changes

| You hear | What changes in code |
|---|---|
| Hiss still there at 100% | Raise `maxReductionDb` in `paramsForStrength` |
| Bubbling or chirping still in the pauses | Raise `DD_WEIGHT` toward 0.99, or raise `noiseOversubtract` |
| Voice thin or underwater | Lower `maxReductionDb`; possibly a lower `NOISE_PERCENTILE` if the take has few pauses |
| Consonant onsets sound soft or smeared | Lower `DD_WEIGHT` toward 0.95 (the trade-off against bubbling) |
| Words sound clipped or pumped | Lower `maxReductionDb`; the gain is dropping too far between words |
| Lispy "s" | Lower `deessMaxDb` or `DEESS_EXPONENT` |
| Harshness is not the "s" but the whole voice (2–4 kHz) | Needs a static EQ stage, which this spike does not have. Say so. |

**Send the take folder name as well as what you heard.** Tuning happens
against the same file, with the same script, so that before and after can be
compared.

## §4 — in the app

1. Open a take that recorded the mic (the one from §1 is ideal) in the
   editor. **"Clean up voice"** sits in the timecode row above the ruler,
   left of "System audio" when that is there too. It is OFF, and its
   strength slider sits dimmed at 50%. It does not appear at all for a take
   with no mic.
2. Export once with it off. Then turn it on, leave it at 50%, and export
   again. The first file is the old export; the second is the cleaned
   narration. Since STC-454 the preview plays the cleaned voice too, so you
   can also compare them in the editor (see `docs/STC-454-RUNBOOK.md`).
3. Move the strength to 30% and export, then 80% and export. Compare against
   §2's WAVs: the exported file at N% should sound like `clean-N.wav`.
4. Turn it off. The slider dims and keeps its value. Close and reopen the
   take: the switch and strength are where you left them.
5. Use a take with **system audio** as well: the mix still works, the mic is
   cleaned, and the system audio is untouched.
6. Time the export of a long take (5+ minutes) with it on. Cleaning runs on
   the editor window before encoding starts, at ~1 s per minute of audio in
   Node. Write down whether the window visibly freezes at the start of the
   export.

Record for each step: does it hold? Also record anything that sounds
different from §2's WAV at the same strength. That would mean the export
path differs from the script, and it must not.

## Results

### Round 1 (2026-09-25, Patrick): bubbling at every strength

> "all have a sort of 'digital bubbling' in the background, but 75 + 100
> affect the voice narration the most"

Follow-up answers: the bubbling was **in the pauses**; **50% removed about the
right amount** of hiss; the **echo sounded no different** at any strength.

- **Bubbling** is musical noise: the first chain used power spectral
  subtraction, which leaves isolated spectral peaks flickering in the pauses.
  Measured as the pauses' spectral kurtosis (log ratio after/before; ~0 is a
  plain quieter hiss, above ~0.5 is audible): **1.2 at 25% up to 2.9 at
  100%.** Noise reduction is now a decision-directed Wiener gain, which leans
  on the previous frame's clean estimate so one noisy frame cannot open a bin:
  **0.04 up to 0.12**. A test pins it below 0.3, and it fails (0.92) with the
  smoothing switched off.
- **Voice damage at 75/100%**: the slider is rescaled, and **100% is now
  roughly the old 50%**. On the synthetic phrase, the voice changes by 0.7 dB
  at 25% and 1.3 dB at 100%.
- **Echo**: the old 1.5× weight cut the tail 6 dB and still couldn't be heard,
  while it cost the voice. It is now its own gentler gain: about 3 dB off the
  tail at 100%. **If echo is the problem you want solved, this stage is not
  going to get there.** Say so, and we can decide between a stronger method
  and dropping the stage.

**Round 2: re-run the script on the same take**, and send the take name. For
each file, is the bubbling gone, is the hiss low enough, and does the voice
sound natural? Which strength would you ship?

### Round 2 (2026-09-25, Patrick, same take)

Bubbling "*slightly* noticeable if you look for it"; the hiss is low enough;
"at higher numbers it starts to sound like the voice is affected"; **ship
~50**. Follow-ups: go ahead
and wire it in, keep the 0–100 range with **50 as the default**, and drop the
echo stage (**STC-458**). At 50% that stage could cut at most 4.5 dB, and
round 1 couldn't hear it even when it was stronger, so removing it should not
change what you heard. §4 step 3 checks that.

## What Linux verified

- On synthetic signals, 17 unit tests (`transform/test/narration-clean.test.ts`)
  check each stage on its own:
  - **No bubbling:** the pauses' kurtosis log ratio stays below 0.3 at 25%,
    50% and 100%.
  - At 50%, steady hiss in the pauses drops to within 1 dB of the 11 dB floor,
    while a voiced phrase's level holds within 1 dB.
  - The de-esser cuts an "s" ≥3 dB and leaves a vowel within 0.1 dB.
  - The 80 Hz high-pass cuts 30 Hz rumble by ≥15 dB.
  - Strength 0 is bit-for-bit identity.
  - With every gain at 1, the STFT hands back its input to within 1e-6.
  - The output is deterministic.
- The script runs end to end on a WAV (`clean-narration-script.test.ts`),
  including the WAVE_FORMAT_EXTENSIBLE float layout `afconvert` writes.
- Speed: ~1.1 s per minute of 48 kHz mono in Node.

## In the app (Linux-verified, not heard)

- **project-10** `narrationCleanup: { enabled, strength }`, default off at
  0.5. It is written only when it differs from that default, so an untouched
  take keeps its version. A bad strength never cancels a deliberate "on".
  Tested in `trim.test.ts`, including v10 being a superset of v9.
- **Export** (`exportAudioPlan` in `audio-mix.ts`, unit-tested): cleanup on
  sends the mic through `cleanNarration`, then the mixer (stereo 48 kHz),
  **mic-only takes included**. Cleanup off, or on at strength 0, keeps the old
  mic-only path byte for byte. The WHOLE mic track is cleaned before the
  export window is cut, so a trimmed export cleans exactly as the full one
  would.
- **Editor**: `voice-clean.e2e.test.ts` covers four things:
  - hidden with no mic
  - off at 50% by default
  - on / strength / off saved, with the strength kept while off
  - reopen restores it, and Space and arrow keys on the controls don't move
    the playhead (mutation-checked)
- **No export with cleanup has been encoded anywhere**: Linux Chromium has no
  AAC encoder. §4 is the first time.
