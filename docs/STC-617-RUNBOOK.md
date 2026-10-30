# STC-617 runbook: a zoom block that follows the cursor

Run from `accounts/stc-617-zoom-block-follow-cursor-mode` until it merges, then `master`:

```
git fetch origin
git checkout accounts/stc-617-zoom-block-follow-cursor-mode
npm run app:start
```

## What was built

Patrick's calls (2026-10-30, on the ticket):

- **Dead zone.** The crop holds still while the pointer moves around its middle, and pans only once the pointer leaves the middle `FOLLOW_DEAD_ZONE_FRACTION` (0.5) of the crop on that axis. It pans just far enough to put the pointer back on the dead zone's edge.
- **One fixed spring.** The pan is critically damped at `FOLLOW_OMEGA` (8 rad/s, settling in about 0.6 s), the same for every block. Ease in and Ease out still govern only the zoom in and the zoom out.
- **Size only.** Amount sets the crop's size and the cursor sets where it is. The crop opens centred on the pointer at the block's start, clamped inside the frame. Dragging a region on the preview still sets the size; its position is ignored while Follow is on.
- **A field on the block.** The flag is `follow: true` on the geometry or manual override, and it makes the document project-19. Switching Follow on for an Auto block (one with no region drawn) gives it the region stage 2 would zoom to, the same way Amount does.

After the block ends, the crop stops chasing, so the zoom out relaxes from a still crop. Both constants live in `transform/src/zoom-follow.ts`. `TRANSFORM_VERSION` is 18.

**One departure from the ticket text, confirmed by Patrick (2026-10-30):** the crop is *not* held to stage 2's `[0.5, 0.7]` viewport limits. A following block keeps the size its Amount gives it (1.1x to 4x), exactly as a fixed block does, so that the Amount slider still means something with Follow on. It is held inside the frame.

## What was checked here

- Unit tests (`transform/test/zoom-follow.test.ts`). They cover:
  - the crop opens on the cursor;
  - jitter inside the dead zone never pans it;
  - a pointer leaving the dead zone is followed, through a spring rather than a jump, to the zone's edge;
  - the crop stays inside the frame while chasing the pointer into corners;
  - it is frozen after the block ends;
  - seeking and stepping agree bit for bit across checkpoints;
  - render() follows for geometry and manual blocks;
  - the project-19 write, parse and schema.
- `npm run gate` and `npm run gate:identity` pass. `gate:identity` was also run on a copy of a real take with a following block, and preview (shuffled seeks) matched export on every sampled frame.
- `app/test/zoom-override.e2e.test.ts` has a Follow case. It runs on CI and was not run locally.

## What only a Mac can settle

### §1 The switch

1. Open a take that has an auto zoom block. Select the block, and in the Zoom section turn on **Follow cursor**.
   - The dashed region should appear at stage 2's place.
2. Press Done, then play across the block.
   - The zoomed picture should open where the pointer is, and keep the pointer in view as it moves.
3. Reopen the block.
   - The switch should still be on.
4. Turn it off and press Done.
   - The block should go back to a fixed crop.

### §2 The feel (the two constants)

Record a take: click once, then move the pointer slowly across the screen for a few seconds, then quickly, then wiggle it in one place. Turn Follow on for that block and watch the preview.

- **Wiggling in place should not move the picture.** If small moves pan it, raise `FOLLOW_DEAD_ZONE_FRACTION`.
- **A slow move should pan smoothly, never lurch.**
- **A quick move may run the pointer briefly off the zoomed picture.** That is the cost of a calm pan. If it reads as lost, raise `FOLLOW_OMEGA` (for example to 12). If the pan feels jittery or seasick, lower it.

Changing either constant is a new transform: bump `TRANSFORM_VERSION`, add a `TRANSFORM_HISTORY` entry and re-pin the fingerprint.

### §3 Export

Export the take. The exported pan should match what the preview showed.
