# STC-576 runbook: keyboard paths for the pill and the redaction canvas

**§1 and §2 APPROVED on a Mac by Patrick, 2026-11-02**, with one change:
the spot labels say "Center", not "Centre". Kept for a re-run.

Run from `master`, or from `accounts/stc-576-keyboard-paths` while it is
unmerged. If that branch is checked out in a worktree, run from that folder:
git will not check out a branch a worktree already holds. Quit any other
Capture first: two can run at once, and the menu bar then has two items.

```
npm run app:start
```

## What changed

- **The pill** moves from the menu bar: mid-take the menu-bar menu gains
  **Move Pill ▸** (Top Left / Top Center / Top Right / Bottom Left / Bottom
  Center / Bottom Right), right under Stop Recording. Not arrow keys on the
  pill: it is `focusable: false` (STC-550), and focusing it would deactivate
  the app being recorded on camera (decided with Patrick, 2026-11-02). A spot
  is a jump, so there is no motion for reduced motion to remove.
- **The redaction canvas** is a Tab stop. Return or Space places a centred box;
  `]`/`[` select the next/previous box; arrows move it (⇧ 10%), ⌥ arrows resize
  it from the bottom-right (⇧ 10%); Delete or ⌫ removes it. The selected box
  is outlined in `--focus` while the canvas has the focus, and the hint line
  (a polite live region) says what the keys do. ⌘Z, ⌘S, Tab and Esc are
  unchanged.

Typecheck and `vitest --project unit` pass; the e2e case
(`redaction.e2e.test.ts`, "the keyboard alone…") passed on CI.

## 1. Move Pill, from the keyboard only

1. Start a recording. Press ⌃F8 (or Fn-⌃F8) to focus the menu bar's status
   items, arrow to Capture's, press Return.
   - **Must show:** Move Pill under Stop Recording, with a submenu of six spots.
2. Pick each spot in turn.
   - **Must show:** the pill jumps there, on the display it was on, 8 px from
     the edges it sits against. Top Center is where a take's pill opens.
   - **Must NOT happen:** the recorded app's windows go inactive (title bars
     dim), or the library/editor comes forward.
3. Drag the pill somewhere, then pick a spot mid-drag (hard; try right after a
   release). The pill must not drift back toward the pointer.
4. On a second display: record it, pick Bottom Right. It stays on that display.
5. Stop the take. Open the menu again: Move Pill is gone.

## 2. Keyboard redaction

Open a still in the editor (library → a shot, or a panel's Edit).

1. Press Tab. **Must show:** a `--focus` ring around the canvas, and the hint
   says "Return places a box."
2. Return. A box appears in the middle, outlined. Hold → for a second.
   **Must show:** the box slides and stops at the right edge; nothing lags far
   behind the key repeat. Close and reopen the shot: the box is where you left
   it (the write is coalesced; the last position must land).
3. ⌥↓ and ⌥← resize; it cannot shrink to nothing or grow past the frame.
4. Place a second box, `[` back to the first, Delete. The other box survives
   and becomes the selected one.
5. With VoiceOver on, step through 1–4. The canvas announces its keys; each
   action reads the hint line.
6. Is a 20% × 10% starting box and a 1% step right on a real 4K shot? Say if
   either should change (`KEYBOARD_REDACTION_SIZE`, `REDACTION_STEP` in
   `transform/src/still-redact.ts`).

## Known gap

With "Show icon in" set so the menu-bar item is hidden, the pill has no
keyboard path. The Dock menu could carry the same submenu if that matters.
