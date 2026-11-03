# STC-575 runbook — Open Image…

Run from `accounts/stc-575-open-an-existing-image-in-the-still-editor` until it merges. Needs a Mac.

CI settles the document an import writes, the copy, the cleanup on failure and the menu item (`app/test/image-import.test.ts`, `tray-menu.test.ts`). Below is what it cannot.

1. Menu bar > **Open Image…** (glyph beside it, between Open Latest in Editor and Settings…). Is the glyph legible in light and dark?
2. Pick a PNG from Downloads. Does the still editor open on it, whole image, no crop?
3. Is the original file untouched, and is there a new tile in the Library?
4. Draw a redaction, Done. Does the tile show it? Does the export carry it?
5. Repeat with a JPEG. Same result?
6. Cancel the picker. Nothing happens?
7. Pick a `.heic` or `.gif`. The dialog filter hides them; drag one in through "All Files" if the picker allows. Does it say it cannot open it, and leave nothing in the Library?
8. Pick a retina (2x) screenshot from elsewhere. It opens as a large 1x picture (scale is unknown). Is that acceptable, or should the editor guess 2x?
9. Pick a P3 PNG, export. Is the colour kept? (A JPEG is re-encoded and loses its profile; that is expected.)

Not built: drag-and-drop onto the window or the menu-bar icon (the ticket's third open item).
