# STC-483 runbook: the editor's audio lane

Run from branch `accounts/stc-483-editor-waveform-too-small-to-read-clipping-and-cluttered` (not on `master` yet).

What changed: the waveform left the ruler for an **Audio lane** below it (ruler → Audio → Clip → Zoom). The ruler is time only. A bucket whose peak reaches `CLIP_PEAK` (0.999, `transform/src/waveform.ts`) is drawn in `--wave-clip` (= the shared `--rec`). The lane's bottom edge drags to resize.

Only a Mac with real narration can settle:

1. **Clipping reads.** A take with the mic at +12 dB on loud speech: clipped peaks are red and findable against the green at the default height.
2. **Red vs green.** Does `--wave-clip` read against `--wave` (`#5fb38a`), including for colour-blind eyes? If not, change the token, not the logic.
3. **Defaults (still open with Patrick).** 56 px default, 32 px minimum, 160 px maximum, remembered per viewer (localStorage). Is 32 px tall enough to read a peak?
4. **Resize feel.** The grip is a 6 px strip on the lane's bottom edge; Up/Down on it nudges 8 px. Easy to find and grab?
5. **Is Clip activity still too busy** now the waveform is off the ruler? (Open question on the ticket.)
6. Pan/zoom: the lane follows the ruler's span like the Clip and Zoom lanes.
