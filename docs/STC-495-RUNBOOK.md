# STC-495 runbook — Copy a recording instantly

Run from branch `accounts/stc-495-copy-instantly-background-render` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-495-copy-instantly-background-render
helper/build.sh && npm run app:start
```

What changed: a fresh recording's copy now renders in the background the moment its panel appears, at the embed width (1232 px, 1x, never larger than the capture). Copy pressed before it finishes waits for it (progress bar, then the pasteboard). **Save and Edit are never locked**; they cancel the render, since the panel closes with them. A GIF pick also cancels it (Copy in Video mode re-renders on demand). Export and Save output are unchanged.

All items are **host** (real hardware, real apps, performance).

## 1. Instant Copy (host)

Record 30 s with the pointer moving, stop, and wait ~10 s without touching the panel. Press Copy. It must say "Copied, paste anywhere" at once, with no progress bar. Paste into Slack and Finder; the cursor must be visible and the video ~1232 px wide.

Write down: how long after the panel appeared did Copy become instant (the render time for a 30 s take)?

## 2. Copy before the render finishes (host)

Record 60 s, stop, press Copy immediately. The bar must show the remaining progress (not restart from 0 after the first second), then "Copied". Paste works.

## 3. Save and Edit never wait (host)

Record 60 s, stop, press Save at once. It must save with no wait and no "still rendering" message; `~/Library/Application Support/<product name>/copies/` must have no `.partial` afterwards. Repeat with Edit.

## 4. Trash, dismiss, quit (host)

Stop a take and press Trash (let the undo toast expire) / close the panel / Cmd-Q while the render runs. Same checks as STC-488 §4: no `.partial`, no new `.mp4`, quit prompt.

## 5. The measurement the ticket asks for (host)

Stop a 60 s take, and press Record again at once. Record 30 s. Open the new take's `anchors.json` and the stats it logged: dropped frames or non-monotonic PTS? Write down what you saw, even if it is nothing. Every take now overlaps the next one's start, so repeat 3 times. If frames drop, that is a separate decision (cancel the background render when a new recording starts, or lower its priority); this ticket does not make it.

## 6. Size (host)

Is 1232 px wide right for Slack, or does text in the pasted copy look soft? If soft, a dedicated "chat" preset (or 2x) is a one-line change in `copy-render.ts`.

## 7. Copies folder (host)

After ten takes, `copies/` holds ten small files. The 24 h purge and the clipboard guard are unchanged; check the folder size is acceptable.
