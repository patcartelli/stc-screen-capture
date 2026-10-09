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

## §4 Large warning

A long take (2+ minutes, lots of motion) at 1280 / 30 fps.
Must: `… — large for a GIF; Video is smaller` in the warning colour; Copy and Save still work.

## §5 Save

Save in GIF mode. The take appears in the library as before, `<take>.gif` sits in the save folder, and "Show in Finder" selects it. Then open the take in the editor and Export an MP4: the GIF must be untouched.

## §6 Settings

Change frame rate or width on the profile sheet. A GIF already showing `ready` on an open panel does not change; a new flip uses the new settings.

## Not here

A GIF tile in the library and GIF from the editor's Export are out of scope.
