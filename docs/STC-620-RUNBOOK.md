# STC-620 runbook — the Zoom lane's curve resolution

Run from `accounts/stc-620-zoom-lane-curve-resolution` until it merges (not on
`master` yet). Quit any running Capture first (⌘Q): Electron keeps one instance and a
second launch hands off to the old build. Then, from that checkout:

```
npm run app:start
```

You need a **long take** (the ticket's was 11:53) with a few dozen zoom blocks. A short
fixture take cannot show what this fixes.

What CI covers: the sim's one-pass read matches `amountAt` bit for bit
(`transform/test/zoom.test.ts`), the sampler matches `render().zoom.amount` exactly
across presets, intensity, off, separate In/Out speeds and a manual window
(`transform/test/zoom-amount-sampler.test.ts`), the sample times cover a Fast ramp and
the drawn polygon stays within 0.02 of the sim at every tick for all three presets
(`app/test/timeline-activity.test.ts`), and on the 5 s fixture In and Out Slow vs Fast
move the drawn edge by 8+ px (`app/test/zoom-lane-curve.e2e.test.ts`). What only a Mac
with a long take can settle:

1. **Nothing is missing at full zoom.** Open the long take at Fit. Every block that is
   in the Clip lane's activity should have a mark in the Zoom lane, including short
   ones. Before, a block shorter than ~1.5 s could fall between two samples and not
   draw at all.
2. **Slow vs Fast resolve on zoom-in, not before.** At Fit, a block's ramps are about a
   pixel or less, so In = Slow / Out = Fast and Medium / Medium will look the SAME there.
   That is by decision (Patrick, 2026-11-02), not a bug. Zoom to about a minute around
   one block: the rising and falling edges should now be visibly different slopes, and
   changing a speed in the chip and pressing Done should redraw the lane at once.
3. **Pan and zoom still feel immediate.** Wheel-pan and ⌘-scroll the zoomed lane on the
   long take with dozens of blocks. The lane is redrawn on every change; measured on a
   synthetic take it is ~10 ms at 100 blocks across the whole take and under 1 ms at a
   minute, against 27-40 ms before. If it stutters on a real take, the dials are
   `ZOOM_LANE_DENSE_STEP_NS` (the dense run's spacing) and `ZOOM_LANE_REACH_NS`.
4. **The edges sit where the blocks do.** The curve's rise should start at the gold
   block's left edge and the fall at its right, at any zoom. The samples are snapped to
   120 Hz ticks, so there should be no visible lag between the lane and the frame.
5. **A tail is never clipped.** A Slow Out ramp (the slowest) should fade smoothly to the
   floor, not end in a vertical cut ~2 s after the block. (A test pins the 2 s reach
   against the presets, so this only fails if a preset slower than Slow is added.)
6. **Zoom off and intensity.** Turn auto-zoom off in the Zoom section: the lane should be
   empty. Lower the intensity: the blocks' heights should scale with it.

Not built, and the alternatives if the full-zoom lane should show the speeds: a minimum
on-screen ramp width at coarse zoom (schematic, ramp edges exaggerated by a few px), or a
Slow/Med/Fast marker on each block edge.
