# STC-615 runbook — GIF as the editor's export Type

Stacked on STC-616 (PR #427). Run from branch `accounts/stc-615-editor-export-choose-gif-as-the-output-type` (not on `master` yet) until both merge. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-615-editor-export-choose-gif-as-the-output-type
helper/build.sh && npm run app:start
```

Everything is **host** (real paste targets, real playback). The e2e (`app/test/editor-gif.e2e.test.ts`) runs on CI and proves the wiring, not what a viewer shows. STC-616's runbook §0 (the pasteboard test) comes first for Copy.

## 1. The controls

Open a take, open Export. **Type** reads MP4. Choose GIF: Size goes, **Frame rate** and **Max width** appear with the app's current values (Settings > Output), the note under them reads like "960×540 · 15 fps", and the button reads **Export GIF**. Choose MP4 again: everything returns. Compare the rows with the Figma Export frame (171:2050) and write down what differs.

## 2. The options are Settings'

Change Frame rate in the editor, open Settings > Output: the same value. Change Max width in Settings, come back to the editor and reopen Export: it shows the new one.

## 3. Export a GIF

Trim the take to a few seconds, choose GIF, **Export GIF**. The status reads "Saved <name>.gif — N frames, X MB". Check:

- the file is in the save folder beside the exports, named after the take, and plays in Finder, a browser and Slack;
- it covers the trimmed window, and the cursor, framing and any zoom match the MP4 export;
- it shows in the Library under the GIFs filter, and Reclaim space does not offer it;
- export again: a `-2` file appears and the first is unchanged;
- Cancel halfway: "Cancelled.", no new `.gif` and no `.partial`.

## 4. Copy as a GIF

With Type GIF press **Copy to clipboard**, paste into Finder, Slack, Messages: an animated `<take>-edit.gif`. Past versions pasted fine in other apps; note any target that now does not.

## 5. Not changed, to confirm

Share to site with Type GIF still publishes the MP4 (and says so if there is no export yet). Type is not remembered: close and reopen the take and it reads MP4. `project.json` has no GIF field.

## 6. Time and memory

Time a GIF export of a 60 s 4K take at "Original", and one at 960 px. At "Original" the palette pass holds up to eight full-size frames (about 33 MB each at 4K); watch the renderer in Activity Monitor and write down the peak.
