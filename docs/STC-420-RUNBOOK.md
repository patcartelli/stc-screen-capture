# STC-420 runbook — Show clicks

The Record options bar's `clicks` slot is a live toggle now. It decides whether
the click highlight (the translucent disc under the pointer while a button is
held) is drawn in that take's preview and export. ON by default, which is what
every earlier take did.

Run from `accounts/stc-420-show-clicks` until it merges — it is not on `master`
yet.

```
git fetch origin && git checkout accounts/stc-420-show-clicks
npm run app:start
```

## How the choice reaches the picture

Bar toggle -> `Settings.showClicks` (sticky) -> when a take ends with it OFF,
`main.ts` writes a seed `project.json` (`{ version: 13, showClicks: false }` —
raw input for `parseProject`, not a full project, so it is not schema-valid
until the editor's first save; STC-232's "one parser decides a project")
into the take's temp dir -> `parseProject` -> `render()` puts `cursor.showClicks` in the
`FrameState` -> `compositor.ts` skips the disc. Nothing reads the setting at
draw time. A take recorded with it ON gets no `project.json` from this path.

## What only a Mac can settle

1. **The toggle reads as a toggle.** Record -> the bar's rightmost small icon
   (`ads_click`). On it is white; off it is dimmed to 45%. Is that visible on a
   light desktop and a dark one, next to the other icons' hover state?
2. **Off really means off.** Turn it off, record 5 s with a few clicks and a
   drag, Save -> open in the editor. No disc under the pointer during the
   clicks; the pointer itself still draws. Export it: same.
3. **On is unchanged.** Turn it on, record the same, no `project.json` in the
   take's folder until the editor saves one; the disc is there.
4. **Stickiness.** Quit and relaunch: the bar opens in the state you left it.
5. **A take whose `project.json` could not be written** (read-only temp dir) is
   the failure case: it renders with the highlight on and `main` logs
   `[record] could not write the take's project.json`. Not reproduced here.

## Not done

- No editor control to flip it after the fact. The field is in project-13 and
  `parseProject`/`projectForWrite` carry it, so adding a switch to the editor's
  Audio-style popover is one control and no new plumbing.
- `gate:identity` has no golden hashes to re-baseline: it compares preview
  against export on a take, and both sinks run the same `render()`. It needs a
  take with a `display.mp4`.
- A crash-recovered take loses the choice (the in-memory map is gone) and
  renders with the highlight on.
