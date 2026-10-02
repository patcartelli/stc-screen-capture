# STC-492 — the editor's Clicks switch: what to run on the Mac

**Not on `master` yet — run it from `accounts/stc-492-editor-showclicks-switch` (PR #284).**

```
git fetch && git checkout accounts/stc-492-editor-showclicks-switch && npm run app:start
```

## What this ticket does

A **Clicks** button in the editor's timecode row, in front of Audio and Keys, toggles `project.showClicks` (project-13; absent means on). A click repaints the current frame and saves through `persistProject()`. `render()` already hands `showClicks` to the compositor for both sinks, so the transform is unchanged: no `TRANSFORM_VERSION` bump, nothing to re-baseline. The button is always present once a take is open, since someone may want a disc on a take recorded with clicks off.

Placement is a judgement, not a measurement: it follows the Keys switch (STC-419) as the other per-take picture switch, and the Audio popover was ruled out as the wrong home for a picture setting.

## Verified without a Mac

- `transform/test/show-clicks-render.test.ts` — 3/3: absent is on, the switch flips what the compositor is handed both ways, nothing else in the frame changes.
- `npm run typecheck` — all three passes.

- `app/test/show-clicks-editor.e2e.test.ts` — 1/1, run on the HOST (2026-10-02), not in the VM: the VM harness launches the packaged app and has no vitest/Playwright in the guest. It toggles both ways and checks `project.json`.

## 1. Does the control read clearly (the eye-check the ticket asks for)

Open a take with at least one click. Look at the timecode row, right side:

- **Clicks**, **Audio**, **Keys** read as one group of three, spaced evenly, with Clicks the leftmost of the three.
- On: accent colour. Off: dimmed, like Keys. Is the difference obvious without reading the tooltip?
- Take with no audio and no keys: Clicks alone sits at the right edge, not floating mid-row.
- Narrow the window to its minimum. Does the row still fit, or does Clicks collide with the clock/shuttle?
- Light and dark appearance both.

## 2. It changes the picture, in the preview and the export

1. Seek to a frame with a button held. With Clicks on, the disc is under the cursor. Click Clicks: the disc disappears at once, with no scrub needed.
2. Click again: it returns.
3. Turn it off, export a short range, and watch it. No disc anywhere. Turn it on, export, and the disc is there. (Preview and export both call `render()`, so they should agree; this is the by-eye confirmation.)

## 3. Both directions of the take's own state

- A take **recorded with Clicks off** in the Record bar: the editor opens with Clicks dimmed, and turning it on adds a disc to the picture.
- A take recorded with Clicks on: opens lit; turning it off hides the disc.

## 4. It saves, and cleans up after itself

- Turn it off, close the editor, reopen the take: still off. `project.json` has `"showClicks": false`.
- Turn it back on and reopen: lit. `showClicks` is absent or true; either is correct, since absent means on.
- `events.json` is untouched in both directions.

## Open questions only a person can settle

- Is "Clicks" the right label next to "Keys", or does it want to say "Click highlight"?
- Is first-of-three the right order, or should Audio keep its place at the edge?
