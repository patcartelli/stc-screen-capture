# STC-395 runbook — GIF as an output format

What only a Mac can settle. The e2e has passed on CI (run 37943538767, 9/9 `gif-panel` tests). This runbook is partly run: §1, §5 and §6 pass; §2 found gradient banding, fixed since by gradient-only dither (re-check below); §3 was slow on a MacBook display and the 4K take is still to do; §4 has not been run.

## §0 Branch

Not on `master` yet. Run from `accounts/stc-395-gif-output`:

```
git fetch origin && git checkout accounts/stc-395-gif-output && npm ci && npm run app:start
```

Once merged, use `master`. The save folder on this Mac is `~/Desktop/test`.

## §1 Paste targets

Record about 10 s, flip the panel to GIF, Copy, and paste into Slack, a GitHub comment box, Messages and Mail.
Must: it animates inline in each, and the filename is `<take>.gif`.

## §2 Look

Default settings (15 fps, 960). Try a text-heavy window (an editor, a settings pane) and something with a gradient.
Judge: text crisp, no colour flicker between frames, gradient banding acceptable.

First pass found gradients a little posterized. The encoder now dithers smooth gradients only (spec §1: ordered 4x4 Bayer, never on edges or flat fills). Before/after on any take, without writing into it:

```
node scripts/gif-one.mjs <sessionDir> --check --out /tmp/stc-395-dither/on
node scripts/gif-one.mjs <sessionDir> --check --no-dither --out /tmp/stc-395-dither/off
```

`--check` also prints `dithered: frame 0 …%, overall …%`. Measured on the 2026-10-09_15-31-44 take (22.53 s, 338 frames at 960x694): off 3.62 MB in 8.6 s; `DITHER_SPREAD` 16 was 4.18 MB in 13.5 s, judged too strong, and 8 (current) is 3.93 MB in 13.7 s, 5.4% of pixels dithered; 12 was 4.04 MB and 10 4.00 MB (all about 13.6 s). Open both side by side. Judge: gradients and shadows smoother with dither on; text and icons exactly as crisp as off; flat areas free of a stipple; no shimmer or crawling pattern on a still gradient while something else moves. The three constants in gif-encode.ts are starting values: a stipple on flat areas means `SMOOTH_MIN` is too low (but on a slow, dark wallpaper 3 brought the banding back); grain on gradients means `DITHER_SPREAD` is too high; bands that remain mean it is too low or `SMOOTH_MAX` is too small.

## §3 Time

A one-minute take at 4K capture. Time from flipping to GIF until `GIF · …` appears. Record the number here: ______
Compare against the script on the same take:

```
node scripts/gif-one.mjs <sessionDir> [fps=15] [maxWidth=960|original] [--check] [--no-dither] [--out <dir>]
```

Reference: a real 2162x1300, 8 s take gave 120 frames at 960x578, 2.21 MB, in 4.6 s. P3 readback is forced to sRGB and may cost extra per frame at 4K.

Known limit (not fixed): pass 1 (the palette) reports progress only once per palette sample, and between samples it still decodes every frame. On an hour-plus 4K take one gap can run past the render's 120 s inactivity watchdog, and the GIF fails with `render timeout: no progress for 120000ms`. If you see that, write down the take's length and capture size here: ______

## §4 Large warning

A long take (2+ minutes, lots of motion) at 1280 / 30 fps.
Must: `… — large for a GIF; Video is smaller` in the warning colour; Copy and Save still work.

## §5 Save

Save in GIF mode. The take appears in the library as before, `<take>.gif` sits in the save folder, and "Show in Finder" selects it. Then open the take in the editor and Export an MP4: the GIF must be untouched.

## §6 Settings

Settings are read once, when a conversion starts (spec §3). This section checks that changing one never re-renders a GIF that is already ready.

1. Flip a panel to GIF and wait for `GIF · <size>`. Note the size.
2. On the profile sheet, change the frame rate AND the width (e.g. 10 fps, 480).
3. Press Copy on that panel. It must be instant: no `GIF N%`, no progress bar, status goes straight to `Copied GIF, paste anywhere`, and the size shown has not changed. Paste it: it is the OLD settings' GIF (the old width; check with Finder's Get Info or Preview's inspector).
4. Same with Save on a second ready panel (changed settings again first): the take saves at once, and `<take>.gif` in the save folder is the old settings' GIF.
5. On a third ready panel, flip to Video, then back to GIF. That is a NEW flip: it converts again (`GIF N%`), and the result has the NEW frame rate and width.

Fail if step 3 or 4 shows any conversion, if the status sits on `Copying GIF…`, or if Edit or Video Save then refuse with "a copy is still rendering": that was the bug the final review found.

## Not here

A GIF tile in the library and GIF from the editor's Export are out of scope.
