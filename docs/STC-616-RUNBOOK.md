# STC-616 runbook — Copy to clipboard in the editor

Run from branch `accounts/stc-616-editor-export-copy-to-clipboard` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-616-editor-export-copy-to-clipboard
helper/build.sh && npm run app:start
```

Everything here is **host** (a real pasteboard and real paste targets). The e2e (`app/test/editor-copy.e2e.test.ts`) runs on CI against the fake helper and proves the wiring, not what a paste target accepts.

## 0. The pasteboard test (host, your terminal, not an agent's)

Same as STC-488's. If it fails, nothing below will paste.

```bash
npx vitest run --config vitest.grant.config.ts helper/test/copy-file.grant.test.ts
```

## 1. The basic Copy

Open a take in the editor, open Export, press **Copy to clipboard**. The bar under the section shows frames; when it ends, the row reads "Copied. Paste anywhere." Paste into Finder, Slack, Mail and Messages. Expected: an `.mp4` named `<take>-edit.mp4`, cursor visible. Write down which target, if any, pastes a path as text.

## 2. It is the edited take, not the panel's copy

1. Record a take, let the panel's background copy finish (STC-495), then **Edit**.
2. In the editor drag the out point in to about half, and choose a smaller Size.
3. Copy to clipboard, paste into Finder, play it.

It must be the trimmed length at the chosen size. The same take's panel copy (`<take>.mp4` in `~/Library/Application Support/<product>/copies/`) must be unchanged: same mtime.

## 3. Edits made a moment before Copy

Change the framing style, then press Copy at once. The pasted video must show the new framing (Copy persists the project before it renders). Repeat with a zoom block open for editing (Done not pressed): it is committed first, as Export's is.

## 4. Cancel and teardown

- Press Copy on a long take and **Cancel** halfway: the row reads "Cancelled.", Export and Copy come back, `copies/` has no `.partial` and no new `-edit.mp4`, and the clipboard is as it was.
- Press Copy and close the editor window: same folder check.
- Press Copy and Trash the take from the library (it is open in the editor): the render ends, no error dialog.
- Cmd-Q mid-render: quit finishes promptly (STC-488's bounded stage).

## 5. Export and Copy against each other

While a Copy renders, Export, Size and the Frame controls are disabled; while an Export renders, Copy is. Confirm that, and that both come back after a failure.

## 6. Time and memory at the project's size (host, performance)

The panel renders at the embed width; this renders at the project's output size. On a 60 s 4K take, time "Rendering…" to "Copied" for Copy and for Export and write both numbers down. On a take of 10 minutes or more, watch the render window's renderer and the main process in Activity Monitor (the encoded bytes cross IPC whole) and write down the peaks and whether it finished. If it is a problem, the filed decision is a size cap for Copy.

## 7. The purge

`<take>-edit.mp4` is purged after 24 h like any copy, except the one on the clipboard. STC-488 §5's procedure applies unchanged.
