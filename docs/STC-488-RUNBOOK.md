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
npx vitest run helper/test/copy-file.grant.test.ts
```

Must show 1 passed. A failure means the helper never put the file on the pasteboard, and nothing below will paste.

## 1. Paste targets (host)

Record 10 s of anything with the pointer moving. On the panel, press Copy and wait for "Copied, paste anywhere". Paste into each and write down what arrives:

| target | expected |
|---|---|
| Finder (a folder, Cmd-V) | the `.mp4`, named after the take, cursor visible when played |
| Slack (a DM to yourself) | an uploaded video |
| Mail (a new message) | an attachment |
| Messages | a video bubble |

A target that pastes a path as text is a finding. Note which one.

Also record one take with the camera on and play the pasted copy: PiP compositing is checked by eye here, since the e2e only checks that a camera take copies.

## 2. Copy, then Trash (host)

Copy, wait for "Copied", press Trash and let the undo toast expire. Paste in Finder. It must still paste the video.

## 3. A real 4K minute (host: timing is performance)

Record 60 s at full resolution. Press Copy and time "Rendering..." to "Copied". Expect around 40 s (export is about 1.5x faster than realtime). Write the number down. Does the progress bar read as progress, or look stalled at any point?

## 4. Cancel (host)

Start a Copy on a 60 s take and press Trash halfway. Check that `~/Library/Application Support/<product name>/copies/` has no `.partial` and no new `.mp4`. Repeat with Cmd-Q during a render: quit should finish promptly (it waits at most 5 s for the cancel).

## 5. The purge (VM or host, optional, slow)

Set a copy's mtime back 25 h (`touch -t`), copy a DIFFERENT file to the clipboard, and relaunch. After about 60 s the old copy must be gone. Repeat with the old copy itself on the clipboard: it must survive. A second Copy of a take reuses its file without touching its mtime, so the 24 h clock runs from the render.
