# STC-614 runbook — the editor's MP4 Frame rate (30 / 60)

Run from branch `accounts/stc-614-editor-export-frame-rate-30-60` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-614-editor-export-frame-rate-30-60
npm run app:start
```

The e2e (`app/test/editor-rate.e2e.test.ts`) runs on CI and proves the wiring and the frame counts, not what a viewer sees. Everything below is **host**: real playback.

## What it is

**Frame rate is an export-time choice, not a project field** (Patrick, 2026-11-02), like STC-615's Type: it never reaches `project.json`, and a take opens at 60. 30 fps encodes every other frame of the same 60 fps grid (`transform/src/export-rate.ts`), so its frames are exactly 60 fps's even frames and the transform is unchanged. Copy follows it, as it follows Type. A GIF keeps its own Frame rate row (the app's GIF setting).

## 1. The controls

Open a take, open Export. Under Size, **Frame rate** reads 60 fps. Choose GIF: it is replaced by the GIF's Frame rate and Max width. Back to MP4: it returns at what you left it. Compare with the Figma Export frame (171:2050) and write down what differs.

## 2. Export at both rates

Trim to ~10 s of cursor movement, ideally with a zoom. Export at 60, then at 30 (the second replaces the first, as any re-export does, so rename the first in Finder in between). Check:

- QuickTime's Movie Inspector says 30 fps for the 30 file and 60 for the other, and both are the same length;
- the 30 file's status line reads half the frames ("Done — N frames");
- the cursor, zoom and PiP land in the same places in both; 30 is only less smooth, never shifted or late;
- audio is in sync at the end of the 30 file as well as the start;
- the export manifest (`export-<take>.json` beside it) has `"rate": 30`.

## 3. Copy at 30

With Frame rate 30, **Copy to clipboard** and paste into Finder: the `-edit.mp4` is 30 fps in the Movie Inspector.

## 4. Not changed, to confirm

Close and reopen the take: Frame rate reads 60. `project.json` has no rate field. The library's own Copy (the panel) is 60 fps as before.
