# STC-237 runbook — a mic or camera lost mid-take

**Branch:** `accounts/stc-237-device-loss`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-237-device-loss
npm ci
helper/build.sh
npm run app:start
```

## What changed

- **anchors-12** adds `endedBy` on `mic` and `camera`: why that track ended before the take did.
  `disconnected` is an unplug (STC-433's teardown). `format-mismatch` is the mic's STC-485 guard.
  The track's own `lastFramePtsNs` is when. It is written only on a `present: true` track, and
  only then is the take v12.
- **No toast** for `mic-disconnected`, `camera-disconnected` or `mic-format-mismatch` (Patrick,
  2026-10-14). The collapsed pill shows **Mic lost** / **Camera lost** in place of its timer for
  2 s (`PILL_NOTICE_MS`), then goes back to the timer. The button stays Stop the whole
  time, and nothing about the window moves.
- **The panel** adds a sentence after the stop's own line, e.g. "The mic disconnected at 1:10,
  so the rest of the take has no mic audio."
- `camera-started` now carries the resolved camera's `uid`, so an automatic camera's unplug
  no longer gets the generic "A capture device was disconnected" toast either.
- Crash recovery (STC-530) accepts a v12 partial. Until this branch it refused anything above
  v10, so a crashed take that had lost its mic would have been unrecoverable.
- The library note is **not** here. It is STC-529's `libraryNote`.

## §1 — the simulated faults, from your terminal (grant tests)

```
npm run test:capture -- helper/test/device-disconnect.grant.test.ts helper/test/mic-format.grant.test.ts
```

Must show: the mic cases write `mic.endedBy: "disconnected"` and version 12, including the one
that stops straight after the unplug (the stop waits for the teardown). The camera case writes
`endedBy` when the camera got frames before the fault's 0.5 s, and no `endedBy` when it did not.

## §2 — the pill and the panel, by eye (deferred: a real unplug)

**Deferred until Patrick has time (2026-10-14).** STC-433 runbook §4 and §5 are the same real
unplugs; run them on this build and check, in addition:

1. Record with a USB mic selected. Unplug it at about 0:10. The pill reads **Mic lost** for
   about 2 s, the dot keeps pulsing, and the stop square stays. Then the timer comes back,
   still counting. No toast.
2. Stop at about 0:20. The panel's line ends with "The mic disconnected at 0:10, so the rest of
   the take has no mic audio."
3. Play the export. There is audio up to 0:10 and silence after, for the full length.
4. Repeat with the camera (once an explicit pick, once automatic). The pill reads **Camera
   lost**, no toast appears in either case, and the export's PiP disappears at the unplug.

What only an eye can say: whether "Mic lost" in place of the timer reads as news or as a fault
with the recording, and whether 2 s is long enough to notice on a pill in the corner.
