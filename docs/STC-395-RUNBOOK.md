# STC-395 runbook — GIF as an output format

What only a Mac can settle. Nothing here has been run: the e2e has not run anywhere yet (CI on draft PR #309 is its first run) and this runbook is unrun.

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
Judge: text crisp, no colour flicker between frames, gradient banding acceptable. Dithering is deliberately off (spec §1); if banding is not acceptable, note which content.

## §3 Time

A one-minute take at 4K capture. Time from flipping to GIF until `GIF · …` appears. Record the number here: ______
Compare against the script on the same take:

```
node scripts/gif-one.mjs <sessionDir> [fps=15] [maxWidth=960|original] [--check] [--out <dir>]
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
