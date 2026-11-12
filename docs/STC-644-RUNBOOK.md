# STC-644 runbook: the selection scrim

Run from branch `accounts/stc-644-selection-scrim` until it merges, then `master`.

**Passed on the Mac 2026-11-12: all 15 checks.**

```bash
git fetch origin && git checkout accounts/stc-644-selection-scrim && npm run app:start
```

Open the overlay with Shot (⇧⌘ hotkey or the menu bar) unless a line says Record.
Do each check once over a **light** desktop and once over a **dark** one.

## Checks (yes/no)

1. Area mode, before you drag: a thin horizontal and vertical line follow the pointer, with no lag.
2. Press the button: the lines are gone at once, and stay gone while you drag.
3. Space to Window mode: the dim stays the same strength. Only the target changes.
4. Window mode: no guide lines.
5. Window mode over a window half hidden by another: only the visible part is undimmed, and the window in front stays dimmed.
6. Window mode: the cutout's own corners are rounded, and the edge where another window cuts it is square.
7. Start a selection inside a white window: the edge is visible all the way round.
8. Same over a dark desktop: the edge is visible.
9. While dragging, the legend (and the bar, from Record) goes faint, and comes back on release.
10. Opening: the dim fades in quickly. The desktop never flashes before it.
11. Closing (Esc, and a capture): the overlay fades out quickly. No flash, nothing left behind.
12. Press Esc the instant the overlay appears: it closes and nothing is stuck on screen.
13. The captured still has no trace of the dim (open it from the library).
14. System Settings > Accessibility > Display > Reduce motion ON: open and close the overlay. No fade either way.
15. Two displays, if you have them: the display without the pointer is dimmed and shows no guide lines.

## Sign-off

Take a screenshot of checks 1, 5 and 7 over a light and a dark desktop for Patrick.
`node scripts/scrim-shots.mjs <dir>` renders the same states headless (after `npm run app:build`), for comparison only.

## Known limits

- The window cutout is rounded at 10 pt for every window (`WINDOW_CUTOUT_RADIUS`, `app/src/scrim.ts`). Windows with a different radius show a sliver of dim or tint at the corner.
- The dark line of the edge is `--handle-edge` (.55 black), not the study's .35. It is the token the handles already use for the same job.
