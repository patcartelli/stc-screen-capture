# STC-605 runbook: the timeline as an instrument

Editor build 3/5 (parent STC-602). Run from `accounts/stc-605-editor-build-35-timeline-as-an-instrument`. Until it merges, a checkout of `master` tests the old timeline.

STC-605 is done when Patrick signs off on a timeline screenshot (before from `master`, after from this branch) next to Figma Capture-SK-016, frame "B3 / 4 · Slate + brass" v2 (node 171:78; the timeline group is 171:93). Do not close it on merge alone. The same screenshot is STC-601's before/after.

## Run it

```
cd /Users/pcartelli/dev/stc-screen-recorder/.claude/worktrees/stc-605-timeline
npm run app:start
```

Open a take with audio, clicks and a couple of bookmarks (M at the playhead).

## What changed, against the frame

All values are the frame's own, read from node 171:116.

- **Rows.** A 64 px label column, then the 22 px ruler, the 36 px overlay strip, and Clip 56 / Zoom 64 / Audio 44 with 8 px between lanes. Each lane is a 4% white well with a 6 px radius. Audio moved from first to last.
- **Overlay strip.** Empty and reserved for STC-606's zoom chip, so nothing sits on the Clip lane. Bookmark lines run through it. The window opens at 1280 × 892 (it was 856) to make room.
- **Ruler.** Ticks at 25% white with a 9 px mono label at the major ticks that have room for one. Bookmarks are clay pennants under the ticks.
- **Clip.** Teal activity bars (3 px on a 5 px pitch) are back on the lane. The 2026-09-24 declutter pass had moved them onto the ruler behind a toggle. The toggle is gone, and so is the 4 px kept track. The trim brackets are bone.
- **Zoom.** Each window is its own silhouette with its own smooth brass gradient (0.5 at the top edge to 0.04 at the floor) and a 2 px brass top edge at 0.85. There is no dither.
- **Audio.** Teal bars, 2 px on a 4 px pitch. A clipped peak is a column of 3 px red squares, so it does not rely on colour alone.
- **Playhead.** One 2 px bone line from the ruler's top to the last lane, with a 10 × 6 cap. `#scrub` still does the seeking. Its thumb is now a transparent grab area.
- **Transport row.** 18 px glyphs on a 22 px pitch, and play is a 32 px bone tile. Mute preview and Copy frame stay just left of Export, which is 30 px tall.

## Decisions Patrick made on 2026-10-29 (before the build)

- **The overview zoom strip is gone.** −, + and Fit sit in the ruler's label cell. The ruler is the pan handle: drag it, scroll it, or focus it and use ←/→. `#ruler` is now the slider the strip was (`aria-valuetext`, `data-span-left`, `data-span-width`).
- **The trim row stays under the lanes**, restyled as quiet slate buttons. The frame does not draw it.
- **Mute preview and Copy frame stay** left of Export.

## What to look at

CI checks ids and behaviour, not looks.

1. **At rest, against the frame.** Screenshot the timeline card and put it beside node 171:93.
2. **Zoom in a long way** (⌘= several times, or ⌘-scroll). Ticks, labels, pennants and bookmark lines must keep their on-screen size. The playhead disappears when you pan past it and comes back.
3. **Pan by keyboard.** Tab to the ruler and press ←/→. The span moves and the playhead does not.
4. **Scrub.** Drag anywhere on the Clip lane, then drag a trim bracket. Both should feel as they did. The scrubber's rules are unchanged: `#scrub` is the same range input, now the lane's full height.
5. **Audio.** Drag the lane's bottom edge (32–160 px), and look at a take that clips: the red squares must read as a different texture from the bars.
6. **A take with no audio.** The Audio row and its label disappear, and the playhead ends at the Zoom lane.

## What only a Mac can settle

- Whether the 9 px ruler labels and the 10 px lane labels are legible at 1x.
- Whether the bone playhead competes with the bone play button.
- Whether the brass gradient reads as smooth on a real display, with no banding.
