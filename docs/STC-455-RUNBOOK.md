# STC-455 — clean narration, the SPIKE: what to listen to on the Mac

**Run this from the spike's branch, not `master`, until it merges:**

```
git fetch origin claude/optimistic-ride-ed374b
git checkout claude/optimistic-ride-ed374b && git pull
npm install
```

No helper rebuild and no app build are needed. The script only reads a take.

## What this is

Patrick's order (2026-09-25): **sound first, plumbing second.** The chain is
built and tested (`transform/src/narration-clean.ts`), but **nothing in the
app calls it yet.** There is no project field, no export wiring and no editor
switch. Those come after one of these files is approved by ear. The script
writes the files for that judgement:

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
| Noise reduction (profile learned from the take's own pauses) | fan, hiss, room tone | how hard it subtracts; the deepest cut goes from 12 dB (25%) to 24 dB (100%) |
| Late-reverb suppression (assumes a 0.5 s room) | the echo tail after each word | how much tail it assumes |
| De-esser, 4.5–9 kHz | harsh "s" and "t" sounds | the deepest cut goes from 4.75 dB (25%) to 10 dB (100%) |

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
3. **Echo.** Is the tail after a word shorter? Does the voice sound
   "pumped", with a level that swells between words?
4. **Harshness.** Are "s" sounds softer? Do they sound lispy ("th")?
5. **Which file would you ship?** That strength becomes the slider's default
   once the switch is built.

## §3 — what each answer changes

| You hear | What changes in code |
|---|---|
| Hiss still there at 100% | Raise `noiseOversubtract` or `maxReductionDb` in `paramsForStrength` |
| Watery chirping | Raise `POWER_SMOOTH_S`, or lower the deepest cut |
| Voice thin or underwater at 50% | Weaker noise subtraction; possibly a lower `NOISE_PERCENTILE` if the take has few pauses |
| Echo unchanged | Your room is longer than 0.5 s: raise `ASSUMED_RT60_S` |
| Words sound clipped or pumped | Your room is shorter than 0.5 s: lower `ASSUMED_RT60_S` or `reverbWeight` |
| Lispy "s" | Lower `deessMaxDb` or `DEESS_EXPONENT` |
| Harshness is not the "s" but the whole voice (2–4 kHz) | Needs a static EQ stage, which this spike does not have. Say so. |

**Send the take folder name as well as what you heard.** Tuning happens
against the same file, with the same script, so that before and after can be
compared.

## What Linux verified

- On synthetic signals, 17 unit tests (`transform/test/narration-clean.test.ts`)
  check each stage on its own:
  - At 50%, steady hiss in the pauses drops ≥12 dB while a voiced phrase's
    level holds within 1 dB.
  - At 100%, a 0.5 s room's tail drops ≥5 dB (measured: 6.0 dB) while a
    STEADY vowel loses <2 dB (1.7 dB). A steady vowel is the worst case.
  - The de-esser cuts an "s" ≥3 dB and leaves a vowel within 0.1 dB.
  - The 80 Hz high-pass cuts 30 Hz rumble by ≥15 dB.
  - Strength 0 is bit-for-bit identity.
  - With every gain at 1, the STFT hands back its input to within 1e-6.
  - The output is deterministic.
- The script runs end to end on a WAV (`clean-narration-script.test.ts`),
  including the WAVE_FORMAT_EXTENSIBLE float layout `afconvert` writes.
- Speed: ~1.1 s per minute of 48 kHz mono in Node.

**Not verified anywhere:** how a real voice sounds after the chain, and
whether `afconvert` decodes `mic.m4a` the way the script expects. Nobody has
run it on a Mac.
