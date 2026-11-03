# STC-613 runbook — the editor's MP4 Quality and File size estimate

Run from branch `accounts/stc-613-export-quality-size-estimate` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-613-export-quality-size-estimate
npm run app:start
```

The e2e (`app/test/editor-quality.e2e.test.ts`) runs on CI and proves the wiring: the estimate moves with Quality and Frame rate, the encoder is asked for the Quality's bitrate, Copy follows it, nothing is saved on the take. It cannot say whether the levels look right or whether the estimate is close. Everything below is **host**.

## What it is

**Quality is an export-time choice, not a project field** (Patrick, 2026-11-02), like Type and Frame rate: a take opens at High and `project.json` never holds it. A level is **bits per pixel per frame** (Patrick, 2026-11-02): bitrate = width × height × rate × bpp, with Low 0.04, Medium 0.07, High 0.1 (`transform/src/export-quality.ts`). Before this the encoder asked for a flat 12 Mbps at every size and rate. High at 1080p60 is ~12.4 Mbps, so that export is what it was; larger sizes now get more bits, smaller sizes and 30 fps fewer.

**File size** = (video bitrate + the audio track's: 192k mixed, 128k mic only, 0 with none or all muted) × the trimmed Length. WebCodecs encodes at a variable bitrate, and a still screen costs far less than its budget, so a real file should come in **under** the estimate. It's a ceiling, shown with "≈".

## 1. The controls

Open a take, open Export. Under Frame rate, **Quality** reads High. The Estimate group shows **File size** above Length. Drag Quality: the word and the File size follow the thumb. Change Size, Frame rate (30 halves the video part), the trim, and mute every audio track: File size follows each. Choose GIF: Quality and File size both go. Compare with the Figma Export frame (171:2050) and write down what differs.

## 2. Is the estimate close?

For three takes (a mostly still screen, one with steady scrolling, one with video playing in it), export at High and note the File size against Finder's size. Write down the ratio. If real files come in much smaller (under ~40% on all three), the estimate is honest but unhelpful. Say so, and we decide whether to scale it down or relabel it "up to".

## 3. Do the levels look right?

Export the same ~10 s of small text scrolling at Low, Medium and High (rename between exports). At 100% in QuickTime:

- High should look like today's export;
- Medium: is text still crisp while it scrolls?
- Low: is the blockiness acceptable for a quick share, or is Low too low?

If a level is wrong, the dial is `QUALITY_BPP` in `export-quality.ts`.

## 4. 4K

On a capture-size export of a retina take, High is now several times the old bitrate (e.g. 3024×1964 at 60 fps is ~36 Mbps against 12). Check that it exports without error and plays smoothly in QuickTime.

## 5. Not changed, to confirm

Close and reopen the take: Quality reads High. `project.json` has no quality field. The library panel's own Copy is High.
