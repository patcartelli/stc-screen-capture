# STC-577 runbook: a lost display says "Display lost", not "Source lost"

**Branch:** `claude/gracious-bardeen-b73qwz`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout claude/gracious-bardeen-b73qwz
npm ci
helper/build.sh
npm run app:start
```

## What changed

On 2026-10-23 (STC-532's run of the STC-505 runbook, Findings item 1) a display take lost its
display twice: once with the laptop lid closed and once with an external HP Z27 unplugged. Both
takes stopped as `stream-stopped` ("Source lost"). ScreenCaptureKit reports the dead stream at once,
and the display-change watcher waits `DISPLAY_CHANGE_SETTLE_MS` (250 ms) before it decides, so the
stream's death won the race.

Now `stream(_:didStopWithError:)` checks the display on a display or region take, the same way
STC-531 made it check the window on a window take:

- It asks CoreGraphics whether the captured `displayID` is still in the **active** display list
  (`CaptureSession.displayIsActive`). It asks once immediately and once more after 0.3 s
  (`streamDeathWindowRecheckSeconds`).
- If the display is gone, the take stops as `display-reconfigured`: the pill reads "Display lost",
  the panel reads "The display you were recording was disconnected." and the tile reads
  `Stopped early: display disconnected at m:ss`.
- This applies to a **region** take too, not only a whole-display take. A region take on a lost
  display is `display-reconfigured`, not `region-out-of-bounds` (Patrick, 2026-10-26).
- If the display is still there, the take stops as `stream-stopped`, as before. The only
  difference is that it now stops 0.3 s later, after the re-check.

The pure decision is `decideStreamDeath(windowGone:displayGone:)` (`helper/src/CaptureDecisions.swift`),
tested in `helper/test/decisions/main.swift`. Two faults drive it on the real binary
(`helper/test/stream-died.grant.test.ts`):

- `STC_CAPTURE_FAULT=stream-died-display-gone` kills the stream with the presence check reading
  "gone", and must give `display-reconfigured`.
- `STC_CAPTURE_FAULT=stream-died` kills it with the display really there, and must still give
  `stream-stopped`. This is the control.

## §0 Grant tests

```
npm run test:capture -- helper/test/stream-died.grant.test.ts
```

All three tests pass. If the first one reads `display-reconfigured`, the presence check is
calling a real, present display gone. That would turn every unexplained stream death into
"Display lost", so stop and report it.

## §1 Unplug a second display (needs a second display)

1. Record the **external** display (Screen scope). After 5 s or so, unplug it.
2. **Pass:** the panel says *The display you were recording was disconnected.* and the tile says
   `Stopped early: display disconnected at m:ss`. The pill is on the lost display, so it probably
   cannot be seen. Where the pill goes in that case is STC-532's open check, not this one.
3. Repeat with an **Area** take on the external display. Same result. "Area lost" here is a fail.
4. In the `npm run app:start` terminal, look for
   `stream: died with its display gone; stopping as display-reconfigured`, or the same line ending
   in `(on the re-check)`. Note which one appears. If the re-check is the one that catches it,
   0.3 s is close to the edge.

## §2 Close the laptop lid (the unverified one)

With an external display attached, record the **built-in** display, then close the lid.

- **Pass:** the same result as §1.
- **Fail, still "Source lost":** a closed lid may leave the built-in display "active but asleep"
  for longer than the 0.3 s re-check. Then the CoreGraphics check says "present". Report which log
  line appeared (`stream:` or `refit:`), and whether the take stopped at all. The next thing to try
  is a longer re-check, or `CGDisplayIsAsleep`, but only once this run shows which one is needed.

## §3 Nothing else changed

Record a window, then close it. The take still reads "Window closed" (STC-531).

## When it is done

When §1 and §2 pass, add them as one step to `docs/STC-505-RUNBOOK.md` §5. That runbook is on PR
#368's branch and is not on `master` yet. Then close STC-577.
