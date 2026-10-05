# STC-488 runbook — copying a recording

Run from branch `accounts/stc-488-copy-recording` (not on `master` yet), in its worktree or a fresh checkout, until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-488-copy-recording
helper/build.sh && npm run app:start
```

Each item is marked **host** (needs this Mac's real apps, hardware or performance) or **VM** (a clean Tart guest can settle it; see `docs/VM-TESTING.md`). Everything here is **host** except §5.

## 0. The pasteboard test (host, your terminal, not an agent's)

Run this first:

```bash
npx vitest run --config vitest.grant.config.ts helper/test/copy-file.grant.test.ts
```

The `--config` is required: the default config excludes every `*.grant.test.ts`, so without it vitest reports "No test files found". The grant config's global setup builds and signs the helper first. Must show 2 passed (the round trip, and a missing file refused as copy-refused). A failure means the helper never put the file on the pasteboard, and nothing below will paste.

## 1. Paste targets (host)

Record 10 s of anything with the pointer moving. On the panel, press Copy and wait for "Copied, paste anywhere". Paste into each and write down what arrives:

| target | expected |
|---|---|
| Finder (a folder, Cmd-V) | the `.mp4`, named after the take's folder, cursor visible when played |
| Slack (a DM to yourself) | an uploaded video |
| Mail (a new message) | an attachment |
| Messages | a video bubble |

A target that pastes a path as text is a finding. Note which one.

Also record one take with the camera on and play the pasted copy: PiP compositing is checked by eye here, since the e2e only checks that a camera take copies.

Also record one take WITH the mic on (and system audio too, if available), Copy it, paste into Finder and play it: the narration (and the system audio) must be in the pasted file.

Try the clipboard guard: start Copy on a 60 s take, and while "Rendering..." shows, copy some text from another app. When the render finishes the card must read "Ready, press Copy to put it on the clipboard" and your text must still be on the clipboard. Press Copy again: it must paste the video at once, with no new render.

## 2. Copy, then Trash (host)

Copy, wait for "Copied", press Trash and let the undo toast expire. Paste in Finder. It must still paste the video.

## 3. A real 4K minute (host: timing is performance)

Record 60 s at full resolution. Press Copy and time "Rendering..." to "Copied". Expect around 40 s (export is about 1.5x faster than realtime). Write the number down. Does the progress bar read as progress, or look stalled at any point?

Then a take of at least 10 minutes. The encoded bytes cross IPC whole, so watch the renderer and main process memory in Activity Monitor (the copy render window's renderer and the main Electron process) for the length of the Copy, and write down the peak of each and whether the Copy finished.

## 4. Cancel (host)

Start a Copy on a 60 s take and press Trash halfway. Check that `~/Library/Application Support/<product name>/copies/` has no `.partial` and no new `.mp4`. Repeat with Cmd-Q during a render: quit should finish promptly (the copy-cancel stage of quit is bounded at 5 s).

## 5. The purge (VM or host, optional, slow)

Set a copy's mtime back 25 h (`touch -t`), copy a DIFFERENT file to the clipboard, and relaunch. After about 60 s the old copy must be gone. Repeat with the old copy itself on the clipboard: it must survive. A second Copy of a take reuses its file without touching its mtime, so the 24 h clock runs from the render.

## 6. A copy render during a new recording (host, never measured)

Start Copy on a 60 s take and press Record immediately (the render and the capture then share the GPU and the encoder). Record 30 s, stop, then open the NEW take's `anchors.json` and the stats it logged and look for dropped frames or non-monotonic PTS. Write down what you saw, even if it is nothing. If frames dropped, that is a separate decision (for example refusing to Copy while recording, or lowering the render's priority); this feature does not decide it.
