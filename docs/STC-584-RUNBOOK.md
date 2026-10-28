# STC-584 — the Library redesign: what only a Mac can settle

The Library window is rebuilt to Capture SK 016's "Library" and "Library /
List" frames: dark only, a sticky glass title bar (count, Grid/List, the kind
filter, search, the Settings gear), a three-column grid, a list with the
frame's columns, and one visible action per item (Share) with Rename,
Duplicate (stills), Show in Finder and Delete in an overflow menu. A click
anywhere on an item opens it.

Record, Shot, the status chip, the camera and mic pickers and the model plate
left the window (Patrick, 2026-10-27). The menu bar, the hotkeys and the
record bar start a capture; the record bar picks devices. The diagnostics
table is now a strip pinned under the library, shown by Settings › Advanced ›
Show diagnostics.

Merged; run it from `master`:

```
git fetch origin master && git checkout master
npm ci && npm run app:start
```

Linux (Xvfb) has already checked the grid, the list, the overflow menu,
search and the badges against the Figma frames (screenshots), and the e2e
suite drives every action. Linux can't show any of what follows.

## §1 — the window

1. The traffic lights sit at the frame's place (20 px in, 22 px down), on the
   title bar's line and clear of "Library". The window opens with no white
   flash.
2. Dragging works from the title bar's empty space. Grid/List, the filter, the
   search box and the gear each take their own clicks rather than dragging.
3. It is dark whatever the system appearance. Check with the Mac in Light mode.
4. The gear opens Settings, the same window the menu bar's Settings… opens.
5. Resize it down to its floor (480 wide): the grid goes to two columns below
   720 px, and the list drops File and Captured, then Type and Length, never
   the name.

## §2 — the glass title bar (STC-586's CSS bar, as Settings has it)

1. Scroll the grid so tiles pass under the title bar. They blur behind the
   64 px bar and fade toward its bottom edge.
2. Turn on System Settings › Accessibility › Display › Reduce transparency
   with the window open. The bar turns solid with a hairline under it, without
   reopening the window. Turn it off and the blur comes back.

## §3 — items

1. Click a recording's name or the empty space beside its Share button: the
   editor opens. Click a still the same way: the still editor opens. Share and
   ••• do their own thing and never open the item.
2. A recording's Share opens the editor and runs its Share flow, as before.
3. A still's Share puts the decorated image on the clipboard (Patrick,
   2026-10-27) and says so in a toast. Paste it into Messages or Slack: it is
   the decorated image, at export scale, in the shot's colour (compare with the
   panel's Copy of the same shot). Nothing new appears in the save folder.
4. ••• opens Rename, Duplicate (stills only), Show in Finder, a divider, then
   Delete in red. Arrow keys move through it, Escape closes it, and so does a
   click elsewhere, a scroll or switching apps. Only one is ever open.
5. Rename edits the name in place; Return keeps it, Escape cancels.
6. Still thumbnails draw. They did not before this branch: the page's Content
   Security Policy blocked the `blob:` URL every thumbnail is drawn into.

## §4 — badges

1. A take that stopped early (fill a disk, close a recorded window) wears an
   amber badge on its thumbnail with the short cause ("Disk full", "Window
   closed"). Hover it: the full note, "Stopped early: disk full at 4:12".
2. A take with a silent mic says "No mic signal"; a camera that stalled says
   "Camera stalled"; a camera that recorded nothing says "No camera".
3. In the list the same badges sit under the name.
4. The open question the ticket asked: whether the short cause reads for
   someone who does not know what a stop reason is. Judge it on a real take.

## §5 — search and the view

1. Type in Search: the grid narrows on every key, and the count reads "3 of
   42". Escape clears it. A name with no match says so and offers to clear.
2. Switch to List and quit. Relaunch: it opens in List. A fresh profile opens
   in Grid.
3. The Captured column says "Today 1:12 PM", "Yesterday", "Oct 22" in the
   Mac's own time zone.

## §6 — what went with the old top of the window

1. With no Record button in the library, the menu bar's Record and the hotkey
   still record, and a refusal (no grant, say) still shows a toast.
2. A camera that opens and then sends nothing still says so, in a toast while
   the take runs and as a "No camera" badge after. There is no device row any
   more to say it at a glance (Patrick, 2026-10-27: the toast is enough).
3. Settings › Advanced › Show diagnostics shows the strip under the library
   (pid, frames, dropped, events, elapsed) and live numbers during a take.

## What this does not do

- **GIFs.** The ticket's filter has a GIFs chip. A saved GIF is untagged and
  outside the library's scan (STC-395), so the chip would always be empty; it
  is left out until the library can list GIFs (follow-up ticket).
- **Poster frames.** A recording's tile still shows the play mark, not a frame
  (Patrick, 2026-10-27: thumbnails unchanged).
- **Sorting.** Newest captured first only, as the frames draw it.
