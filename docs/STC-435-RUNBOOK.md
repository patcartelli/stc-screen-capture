# STC-435 runbook — Reclaim space

Run from branch `accounts/stc-435-reclaim-space` until it merges, then `master`.

## What changed

- The 12-hour timer no longer touches `raw/`. Nothing removes a bundle unless
  the user presses **Reclaim space…** (profile sheet, on the "Recordings and
  shots save to" row) and confirms.
- `findOrphanedBundles` (`app/src/temp-takes.ts`) is **read-only**: no
  `.orphaned-at` marker and no 7-day age gate. A bundle whose file you deleted
  a minute ago is offered at once. The preview and the Trash replace the clock.
- The gate is per **kind** now, not per folder. An untagged image (a ⇧⌘4
  screenshot, a JPEG export) can only hide a still's file, so it blocks still
  bundles and never recordings. An untagged `.mp4` blocks recordings only.
- Nothing to offer → a toast ("Nothing to reclaim"), which **names the files**
  holding anything back. Something to offer → a native sheet listing each
  bundle (name, kind, size), the total on the button, and the held-back
  sentence if any.
- On confirm, main finds again and trashes only what is STILL orphaned — a
  file put back while the sheet was open keeps its bundle.

What the e2e test (`app/test/reclaim-space.e2e.test.ts`) already covers, with
the sheet stubbed: confirm trashes, Cancel moves nothing, the skip case is a
toast naming the file. What it cannot cover is below.

## What only a Mac can settle

Each item can be run in a `--granted` VM (`docs/VM-TESTING.md`) or on the host;
mark which.

### §1 The sheet itself — VM or host

1. In the save folder, make an orphan: delete (or move out) the finished file
   of one recording whose bundle is in `raw/`.
2. Profile → **Reclaim space…**
3. Pass: a sheet attached to the main window, reading "Move 1 unused take to
   the Trash?", the bundle listed as `<timestamp> — recording, <size>`, and the
   button reading `Move to Trash (<size>)`. **Judge:** does the detail text read
   as an explanation or as a wall? Is the size on the button the number you'd
   decide on?
4. Confirm. Pass: the bundle is in the Trash (Finder → Trash → Put Back
   restores it to `raw/`), and a toast says "Moved 1 take (<size>) to the Trash."

### §2 The skip case is visible — VM or host

1. Leave a ⇧⌘4 screenshot (or any `.jpg`) in the save folder, and make a STILL
   orphan (delete a still's finished PNG).
2. Reclaim space…
3. Pass: no sheet; a toast titled "Nothing to reclaim" naming the screenshot.
   **Judge:** is it clear what to do next?
4. Also make a RECORDING orphan and press again. Pass: the sheet offers the
   recording, and also says another take can't be checked because of that
   screenshot.

### §3 Put the file back mid-sheet — host

1. Make a recording orphan by MOVING its `.mp4` to the Desktop.
2. Reclaim space… — leave the sheet open.
3. Move the `.mp4` back into the folder, then confirm.
4. Pass: the toast says nothing was moved, and the bundle is still in `raw/`.

### §4 A large take — host

On a folder with a multi-GB orphan, check the sheet comes up promptly (the
find walks each bundle's files for its size) and that the GB figure matches
Finder's Get Info for that bundle (Finder uses decimal GB too).

## Not in scope

- Per-bundle checkboxes. The sheet is all-or-nothing; the held-back bundles are
  named and never offered.
- JPEG exports still carry no id (STC-440). They block STILL bundles only now.
