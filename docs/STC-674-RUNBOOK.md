# STC-674 runbook: a click on the pill is not a click in the take

Not on `master` yet. Run from branch `accounts/stc-674-pill-clicks-helper` until it merges, then `master`.

**Run on the Mac 2026-11-13 (Patrick), window takes only: takes 1, 2 and 4 pass.** Pill clicks, a pill drag and the Stop click left no press in `events.json`; real window clicks did. Take 3 was recorded as a window take, so **a display take is still unrun**. Take 4 found STC-678: a click on Capture's menu-bar menu over the window is recorded.

```bash
cd ~/dev/stc-screen-recorder && git fetch origin && git checkout --detach origin/accounts/stc-674-pill-clicks-helper && helper/build.sh && npm run app:start
```

The helper must be rebuilt (`helper/build.sh` above): `app:start` does not rebuild it.

## Setup

Record a **window** (Record, Space for Window mode, pick a window that sits under the top centre of the screen, so the pill floats over it). Auto zoom on. After each take press Edit and look at the Zoom lane.

## Checks (yes/no)

Take 1, about 10 s:

1. Click once in the window, away from the pill. Wait 3 s.
2. Click ON the pill, on its timer (not the Stop button, and not next to the pill: a click next to it is a real click). Wait 3 s.
3. Press Stop.
4. In the editor: there is ONE Auto zoom block, at the click from step 1.
5. There is no block at the pill click from step 2, and none at the end of the take.
6. Play the export preview: the cursor still travels to the pill and back, with no jump.

Take 2, about 10 s:

7. Drag the pill to another place over the window. Wait 3 s.
8. Click on the pill at its NEW place (on the timer). Wait 3 s.
9. Click in the window where the pill USED to be. Wait 3 s. Stop.
10. In the editor: ONE Auto zoom block, at the click from step 9. None for the drag or for step 8.

Take 3, a display take (Record, whole screen), about 10 s:

11. Click on the desktop or in an app, then on the pill's timer, then Stop.
12. In the editor: one block, at the first click only.

Take 4, the menu-bar move:

13. Start a window take. Menu bar icon > Move Pill > Bottom Center. Wait 1 s, click the pill's timer, wait 3 s, click in the window, Stop.
14. In the editor: no block at the pill click. (Until STC-678 is fixed there is also a block at the menu item's click, if the menu hung over the window.)

## If a check fails

Send the take folder's `events.json` and say which step. The count of recorded presses is:

```bash
grep -o '"kind":"down"' events.json | wc -l
```

## Grant tests (the event path changed)

From your own terminal, not an agent's:

```bash
cd ~/dev/stc-screen-recorder && npm run test:capture
```

## Known limits

- The pill's place is read 5 times a second, not on each click. A click on the pill within 0.2 s of a menu-bar move can still be recorded. A drag is read again the moment it ends.
- A press that starts in the window and is released on the pill is a real click, and is recorded.
