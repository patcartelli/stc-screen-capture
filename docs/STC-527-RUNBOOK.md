# STC-527 runbook — disk full mid-take

**Branch:** `master` (merged in #319 and #321).

```
git fetch origin
git checkout master && git pull
npm ci
helper/build.sh
```

## What changed

- **Two ways the helper learns the disk is full** (`helper/src/DiskDecisions.swift`):
  - a **watch** polls free space on the take's volume every second and stops the take
    while **64 MiB** is still free, so the writer can still finish the file;
  - the **frame path** notices the display writer has `.failed`. Measured on a real
    16 MB volume: AVFoundation reports `-11807 Disk Full` over POSIX `ENOSPC`, and the
    writer just stops saying it is ready. Before this ticket that looked like an endless
    run of dropped frames and the take kept "recording".
- Either way the take ends through `App.stop` with **`stop.reason = "disk-full"`**, and
  `anchors.json` is written at **v10** (`schema/anchors-10.schema.json`). A display
  writer that fails for any other reason now ends the take too, with the reserved
  `error` reason, instead of recording nothing forever.
- An **8 MiB reserve** (`.sidecar-reserve` in the take folder) is written at the start
  and deleted just before the sidecars, so `anchors.json` and `events.json` have room
  even when the writer, not the watch, found the disk full. A sidecar write that still
  fails now sends a `sidecar-write-failed` warning instead of failing silently.
- Faults: `STC_CAPTURE_FAULT=disk-full` (the watch reads 0 bytes free) and
  `STC_CAPTURE_FAULT=disk-write-failed` (the frame path's reaction, with the real error).
- Also fixed: the loader refused `geometry` on anything but exactly v7, so a P3 take
  (v9) that refitted mid-take could not be opened. It now accepts v7 or later.

**Not in this ticket:** the copy. The app shows the raw code ("The recorder reported a
problem: disk-full", then "Recording stopped by the recorder (disk-full)") until STC-531
adds the wording, and the panel's **Reclaim space** action is not wired yet.

## §1 The grant test (your terminal; it cannot get a grant from the agent's shell)

```
npm run test:capture -- helper/test/disk-full.grant.test.ts
```

All three must pass:
- both faults: one `disk-full` warning, an unsolicited `stopped` with `disk-full`, no
  `stopWarning`, all three files, `anchors.json` v10 and valid, no `.sidecar-reserve` left;
- the control: no fault, 2.5 s of a real take on your real disk does NOT stop, the
  reserve is exactly 8 MiB while recording and gone after a user stop.

## §2 A real full disk, in the app

Make a small volume and point the app's temp root at it. 256 MB gives roughly 20–40 s
at full motion; play a video on screen so the encoder has something to spend bits on.

```
hdiutil create -size 256m -fs APFS -volname StcSmall /tmp/stc-small.dmg
```

```
hdiutil attach /tmp/stc-small.dmg -mountpoint /tmp/stc-small
```

Check the volume before anything else. The device must NOT be your main disk, and the size
must be about 244Mi:

```
df -h /tmp/stc-small
```

Three traps, each hit on 2026-10-13:
- **Make the image with `hdiutil create`, as above.** `diskutil image create blank` makes an
  ASIF image, which `hdiutil attach` refuses ("image format not supported"; it needs
  `diskutil image attach --mountPoint /tmp/stc-small /tmp/stc-small.dmg`).
- **If the attach fails, `/tmp/stc-small` is just a folder on your real disk**, and the app
  will happily write a take there. A take that shows no `Used` growth in
  `df -h /tmp/stc-small` in the first seconds is on the wrong disk.
- **`STC_TEMP_TAKES_DIR` only counts at launch.** An app already running keeps writing to
  `~/Library/Application Support/Capture/temp-takes/`. Quit it and start it with the
  variable on the same line, below.

```
STC_TEMP_TAKES_DIR=/tmp/stc-small npm run app:start
```

In a second terminal tab, watch the free space (start it BEFORE recording, or the stop's
reading is lost):

```
while true; do df -h /tmp/stc-small | tail -1; sleep 1; done
```

Record the whole screen with a video playing. Watch for:

1. **The take stops by itself** before the volume is completely full (`df -h /tmp/stc-small`
   should still show roughly 60 MB free).
2. **An alert** reading "Recording stopped by the recorder (disk-full)…" (STC-531's copy
   has landed; this ticket only supplies the reason).
3. **The corner panel appears** for the take. Open it in the editor: it plays from the
   start to the moment it stopped, with the cursor.
4. In the take folder under `/tmp/stc-small`, `anchors.json` has `"version": 10` and
   `"stop": {"reason": "disk-full", ...}`, and there is no `.sidecar-reserve`.

Then the harder case, the writer path: fill the volume from outside while recording, faster
than one watch poll.

```
dd if=/dev/zero of=/tmp/stc-small/filler bs=1m
```

Run that a few seconds into a fresh take (after deleting the first take's folder and any
old `filler`). `dd` writes until the volume is completely full and then reports "No space
left on device", which is expected. The
take should still stop with `disk-full`, and `anchors.json` should still be there: this is
what the 8 MiB reserve is for. If `anchors.json` is missing, the reserve was not enough
and the take went down the crash path. Note what was in the folder and its sizes.

Re-recording on a volume already under the 64 MiB floor stops after about a second with
`disk-full`: that is the floor working, not a fault. Clear the volume between runs.

Clean up:

```
hdiutil detach /tmp/stc-small && rm /tmp/stc-small.dmg
```

## §2 result, 2026-10-13: the watch never fired (fixed)

Run on the host Mac from `master` @ `6114340`: a 256 MB volume, the whole 4K screen with
a video playing, system audio and a camera. Two takes, the same both times: `anchors.json`
v10 with `stop.reason = "disk-full"` and no `.sidecar-reserve` left, but the take ran until
the disk was **full**. About 5 MiB was free at the stop (13 MiB once the reserve was
released), `display.mp4` was ~240 MiB, and system audio's last sample came 2.4-2.9 s
before `stop.t`. The **writer path** ended both takes, and the reserve did its job for real.

The watch never fired because `freeBytes()` read `.volumeAvailableCapacityKey` from the
same stored URL every tick. Foundation caches resource values on a URL until a run loop
turns, and the watch's `DispatchSourceTimer` on a global queue never turns one, so every
tick returned the first tick's number. Fixed by `volumeFreeBytes(at:)`
(`helper/src/DiskVolume.swift`), which clears the cache on every read.
`helper/test/disk-full/` now reads, writes 4 MiB and reads again from a background queue,
using the uncleared read as its control. It was confirmed to fail with the clear removed.
`STC_CAPTURE_FAULT=disk-full` could never have caught this: it returns 0 before the read.

## §1 and §2 on the fixed build, 2026-10-13: pass

Host Mac, `master` @ `312851a` (#319 + #321), helper rebuilt.

- **§1:** `disk-full.grant.test.ts` 3/3, the control included.
- **§2, the watch:** a 244Mi volume, the whole 4K screen with a video playing. `Used` climbed
  10 → 169 MiB over about 35 s, then 177 MiB at the stop, with **66 MiB free** once the
  reserve was released (the last growth sample, 74 MiB free, was still above the floor), where
  the pre-fix take ended at about 5 MiB. Samples move in 16 MiB steps, so that is the
  resolution. `anchors.json` v10, `stop.reason = "disk-full"`, no `.sidecar-reserve`. The
  alert showed, the take reached the corner panel, was saved, and plays.
- **§2, the `dd` case:** the take stopped with `disk-full`, `anchors.json` v10 present, no
  reserve, 13 MiB free afterwards. It stopped 1.2 s in, so this run cannot say whether the
  watch or the writer path caught it; the writer path is covered by CI's
  `STC_CAPTURE_FAULT=disk-write-failed` and by the pre-fix run above.

## What only a Mac can settle

- Whether 64 MiB is the right floor beyond one 4K display with video: §2's reading (stop at
  ~66 MiB free) says it was enough here. Too low and a VBR spike reaches `ENOSPC` before the
  next poll; too high and it stops a take someone had room for.
- Whether the raw free count stops too early on a disk whose space is mostly purgeable.
  The watch deliberately ignores purgeable space; on a nearly full real system disk,
  compare `df -h /` with Finder's "Available". Filed as STC-537.
- Whether a crash leaves `.sidecar-reserve` behind in a recovered take (8 MiB of zeros).
  STC-530's crash-recovery panel is where that would be cleaned up.
