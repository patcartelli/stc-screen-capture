# STC-236 runbook — streaming the preview

Branch: `accounts/stc-236-n-minute-segmentation` until merged, then `master`.

## What changed

The editor reads display.mp4/camera.mp4 by range: the sample index at open, then one keyframe
group at a time (`transform/src/chunk-reader.ts`, `transform/src/mp4-boxes.ts`). Audio is still
read whole.

## Measured here (2026-09-26, 46 MB display.mp4 + 11 MB camera.mp4 take)

| build | display-only RSS growth | display+camera RSS growth |
|---|---|---|
| master | +222 MB | +223 MB |
| this branch | +143 MB | +142 MB |

This is a SHORT (~12 s) take, so fixed decoder cost dominates both sides — do not read the
absolute numbers as what a long take costs, only that growth after < growth baseline, which is
what the range-read change predicts. Ratios (4.8x / 3.1x file size) are not meaningful here; see
`docs/CORRECTNESS-TRAPS.md`.

`scripts/measure-preview-memory.mjs` needed a fix first: it clicked `#takes >> text=Preview` and
waited for `#player` in the MAIN window, a selector that predates STC-373, which moved the player
into its own editor `BrowserWindow`. It now opens the editor the way
`app/test/_editor-fixture.ts`'s `openEditorFromLibrary` does and reads pixels from the editor
window's `#stage`. It also filters the `window` event on a URL containing `editor.html` rather
than taking the first new window unconditionally — on a machine with no helper permissions the
supervisor can pop a toast window ("the recorder keeps failing to start") that races the editor
window open and would otherwise be mistaken for it, which is what actually happened on the first
baseline run here.

## What only a person with a Mac can settle

1. **A long take.** Record ≥ 15 min at 4K (the old ceiling), then
   `node scripts/measure-preview-memory.mjs <takeDir>`. Pass: growth within ~2x of the short-take
   number above, not ~1.2x the file size.
2. **Scrub feel.** On that take, drag the scrubber fast end to end, then small back-and-forth
   drags. Pass: no worse than a short take. Fail: a visible lag on crossing keyframes (each group
   is one IPC read).
3. **Export time.** Export the long take. Pass: within ~10% of the same take on master.
   That take sits at master's old memory ceiling, so master may not open it at all. If it
   cannot, write that down as the result — master failing to open a take this branch opens is
   itself the evidence §1 is after — and compare export time on the longest take BOTH can open
   instead, recording its length beside the two times.
4. **A file removed while open.** Open a take, move its folder to the Trash in Finder, then
   scrub. Pass: a visible error ("The preview stopped: …", naming the file) and the transport
   paused. Fail: a frozen frame with no message. Deleting the take from the library while the
   editor has it open reaches the same path ("no take is open").
