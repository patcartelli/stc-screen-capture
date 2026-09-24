# STC-443 — editor polish: what to check on the Mac

**CONFIRMED on real hardware, 2026-09-24** — run through this checklist and
approved: the shared tokens, light/dark in all three windows, and the still
editor's icon toolbar all work as built.

Written on a Linux session with no Xcode/swiftc at all, not even the Command
Line Tools this repo's other runbooks assume — so nothing here could be built
or launched at implementation time, only read and typechecked (`npm run
typecheck`, clean). CI (`macos-15`) went green first; this checklist is what
closed the gap between "compiles and the wired e2e tests pass" and "it looks
right".

## 1. One token set — verify light and dark in all three windows

`app/renderer/tokens.css` is now the only place the fonts, type ramp and
light/dark color tokens are declared; main (`index.html`), the video editor
(`editor.html`) and the still editor (`still-editor.html`) all `<link>` it
and no longer keep their own copies.

- Toggle the OS appearance (System Settings → Appearance) with all three
  windows open and confirm each one actually redraws — background, text,
  borders, the accent color on Record/Export/Done.
- The still editor is the one that changed the most here: it used to force
  `color-scheme: dark` unconditionally (Patrick, confirmed before this
  ticket started) and now follows the OS preference like the other two.
  Check that a light-mode Redact window is legible and doesn't fight the
  screenshot it's showing — it never had a light appearance before, so this
  is a genuinely new combination nobody has looked at.
- The video editor's `--warn` token used to be a static `#b34` with no dark
  variant; it now resolves to the shared token (which does have one). Check
  the trim handle's held state (drag a handle) and the legibility warning
  (Export dialog, text below 9pt) in both modes.
- `--clip`/`--zoom` (the video editor's own timeline lane colors) are
  deliberately unchanged and constant across both modes, same as before —
  confirm they still read fine against the now-slightly-different `--bg`/
  `--surface` values in both light and dark (the shared tokens are close to
  but not byte-identical to editor.html's old local ones).

## 2. Editor window title

Both the main window and the video editor now read "Capture" (`PRODUCT_NAME`)
in the title bar, the Dock, and Cmd-`~`/Window-menu window switching — the
ticket's own literal instruction ("Editor window title reads 'Capture'").
Confirm this isn't confusing in practice: with both windows open, can you
tell them apart in Cmd-`~` and the Window menu (traffic-light chrome and
content should still make it obvious at a glance), or does anything actually
need a distinguishing suffix ("Capture — take name" or similar)? Nobody has
looked at two same-titled windows side by side yet.

## 3. Still editor icon toolbar

`#undo`/`#save`/`#done` are hairline icon buttons now (32×32, 1px hairline
border, inline SVG glyphs) rather than labeled text buttons. Check on real
hardware:

- **Legibility at a glance** — are the undo (curved arrow), save (tray +
  down arrow) and done (checkmark) glyphs immediately readable at 16px, or
  do any read as ambiguous without the tooltip?
- **Undo disabled state** — open a shot with no redactions yet: Undo should
  be visibly dimmed and inert. Drag one box: it should become active
  immediately. Undo the only box: it should dim again.
- **Tooltips** — hover each button and confirm the native tooltip shows and
  names the shortcut (Undo "⌘Z", Save "⌘S", Done "Esc").
- **Shortcuts actually fire** — ⌘Z undoes the last box (and does nothing,
  not even a beep, with none left), ⌘S saves without a browser save dialog
  ever appearing, Esc still closes the window. All three are new bindings
  for Undo/Save; Esc→close already existed.
- **States** — hover, focus-visible (Tab to a button), and active/pressed
  (mouse down) on all three; Done's primary (accent-colored) treatment reads
  as the one weighted action next to the two neutral ones.
- **The hint text** ("Drag a box over anything private.") still reads fine
  now that it sits in a bar styled from the shared tokens rather than a
  window that was always dark.

## Verified

All three sections above — confirmed on real hardware, 2026-09-24. This
ticket was implemented and typechecked without ever running the app (no
Xcode toolchain existed in the session's environment); the existing e2e
coverage (`app/test/redaction.e2e.test.ts`) already drove `#undo`/`#save`/
`#done` by id, and this pass is what checked how it actually looks and
feels — light/dark in all three windows, the icon toolbar's states and
shortcuts, and the "Capture" title on two windows.
