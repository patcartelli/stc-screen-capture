# STC-300 — the still editor (v1: Redact only)

Written on Linux — the whole window has never been seen. `docs/STC-300-FORMAT-AUDIT.md`'s
"own window" answer is what this builds; its own gate ("wanting to nudge a redaction
rectangle") is what fired it, from real hardware feedback on STC-426's runbook.

Edit now opens a real, resizable window (`still-editor-window.ts`/`still-editor-renderer.ts`)
for a shot, the same way it already did for a recording. Its only job today is the
redaction tool that used to grow the post-capture panel in place (`REDACT_SIZE`, STC-297) —
drag a box, Undo takes the last one back, Done closes the window. The panel's Style
picker was not moved here or anywhere; it was removed as redundant in the compact
card, so there is still no control anywhere for changing a shot's decoration mode
after capture.

Edit promotes the take before opening the editor (unchanged behaviour, now shared by
both kinds) — by the time the window appears, the shot is already in the library and
the panel that opened it is already gone.

## Check on the Mac

1. Capture a still, click Edit. A new window should open (not the compact panel
   growing) sized around 900x700, showing the capture. The panel should be gone.
2. Drag a box over something in the capture. It should turn into a solid fill,
   near-black on light content and near-white on dark, matching STC-297's existing
   rule — nothing about the fill colour changed here.
3. Resize the window smaller and larger. The picture should refit itself — smaller
   on shrink, without ever cropping any edge of the capture (unlike the panel's own
   resting-view crop, STC-426 — every edge has to stay reachable here).
4. Draw two boxes, click Undo once. The first box should remain, the second gone.
5. Click Done. The window should close. Reopen the take from the library (or via
   Edit's own action again, if reachable) and confirm the redaction is still there.
6. Press Escape instead of Done. Same result — the window closes, nothing is lost.
7. Open Edit on a shot with an existing redaction from a previous session. It should
   appear on open, and should be draggable/undoable the same as a fresh one.
8. Right-click a fresh capture's panel. The context menu should offer Edit (not
   Redact) in the same slot the take's own actions sit in, and no separate "Redact…"
   row below the separator any more.
9. With the "controls show on hover" panel behaviour (STC-426) in effect, confirm
   Edit is reachable the same way Copy/Save/Trash already are — hover reveals it,
   and it is not disabled unless another action (Copy) is mid-flight.

None of this can be judged from Linux: whether 900x700 is a good default, whether the
crosshair cursor and the drag feel right on a real trackpad, and whether the window's
plain dark styling reads as intentional next to the rest of the app.

## What is deliberately not here

Everything else STC-300's own format audit flagged as needed before a FULLER
inspector (padding, background, shadow controls) could be honest: a normalised
`decoration.crop`, a guarded write path for the whole `decoration` block, and
sourcing a background image. None of those are needed for a redact-only v1, since
`still:writeShot` already only ever touches `redactions` (and, unused by this window,
`mode`). If a future ticket grows this editor past Redact, start there.

**Moving or resizing an EXISTING box is out of scope for v1, by decision rather than
oversight** — asked and answered on the first hardware pass (2026-09-21): drag adds a
new box, Undo removes the last one, and that is the whole vocabulary, matching the
original panel's own redact mode exactly (which never supported repositioning one
either). A mis-placed box today is fixed by Undo and redrawing it, not by dragging it
into place. Revisit if this becomes a real annoyance, the same signal that gated the
editor's own existence.
