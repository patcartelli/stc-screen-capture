# STC-603 runbook: the editor's window shell and layout

Editor build 1/5 (parent STC-602). Run from `accounts/stc-603-editor-build-15-window-shell-and-layout`. It is **not on `master` yet**, so a checkout of `master` tests the old editor.

STC-603 is done when Patrick signs off on a screenshot of the editor at rest next to Figma Capture-SK-016, frame "B3 / 4 · Slate + brass" (node 171:78, v2). Do not close it on merge alone.

## Run it

The branch is checked out in a worktree, so `git checkout <branch>` in the main checkout fails. Use the worktree:

```
cd /Users/pcartelli/dev/stc-screen-recorder/.claude/worktrees/stc-603-editor-shell
npm run app:start
```

Open any recording from the Library (double-click, or Edit on its panel).

## What to look at

CI cannot judge any of this; it checks ids and behaviour, not looks.

1. **At rest, against the Figma frame.** Open a take, do not touch anything, screenshot the editor window, and put it beside node 171:78. Compare:
   - the preview and timeline on the left, a fixed 376 px pane on the right;
   - the title bar (take name centred, `W×H · fps` on the right, close-preview at the far right);
   - the preview's letterboxing, and the timeline card's border and radius.
2. **Window size.** It opens 1280 × 856, centred, and stays 856 tall at rest. Before 3c9f2c0 it grew 24 px on every fit request, so watch it for a few seconds after opening. It must not creep. The minimum is 960 × 640.
3. **Title bar glass.** Scroll or drag content under it: it should read as the Library's bar (blur over the content, drag region, traffic lights at 20/22). Turn on System Settings → Accessibility → Display → Reduce transparency and reopen the editor: the bar must be opaque.
4. **Preview geometry.** The stage letterboxes inside its box for a wide take and a tall one. Open Camera, choose Circle, and drag the PiP. The overlay boxes must sit exactly on the picture, with no offset at any window size. This is the part most likely to be subtly wrong, because the overlays and the pointer maths assume the stage canvas fills its wrapper.
5. **The pane.** A "Take" section holds Camera, Clicks, Audio and Keys. Camera and Audio open their popovers **inside the pane's column**, never over the preview. Their contents are STC-604's; only their placement is in scope here.
6. **Narrow widths.** Drag the window down to the minimum. The header row and the timeline must not clip or overlap (the `@container` rules at 680/820 px still drive the header).
7. **Export.** The button now reads "Export". It was an icon only.

## Decisions I made that need a yes or a no

- `#closepreview` moved to the title bar.
- Export has a visible label (`scrubber.e2e.test.ts` updated to match: the icons-only assertion allows it).
- Camera, Clicks, Audio and Keys sit in the pane until STC-604 redoes it.

## Deliberately not here

- The pane's contents (STC-604), the timeline's look including the filled brass play button (STC-605), and overlays (STC-606).

## What only a Mac can settle

- Whether the glass bar reads as the Library's, in light-on-dark and over a busy recording.
- Whether 12 px between the preview and the timeline card, and the 59/16/33/23 px gutters, match the frame by eye. They were measured from the frame, not eyeballed.
- Whether the window opens sensibly on a small laptop display and on a second display (it centres on the display under the cursor).
