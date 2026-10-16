# STC-238 runbook — the fault-injection soak

**Branch:** `accounts/stc-238-fault-injection-soak-harness`. **Not on `master` yet**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-238-fault-injection-soak-harness
npm ci
helper/build.sh
```

## Result on hardware

**2026-10-15, Patrick's Mac: 9/9 passed** (140 s). The first run that day failed 4 of 9, from three causes, all fixed on this branch:
- The camera-disconnect fault was armed when the camera opened, before it had delivered any frame. It is now armed from the camera's first written frame.
- The export harness refused a recovered take that has no `events.json`. It now reads a missing file as no cursor, the same as the app's loader.
- The supervisor pipe-close case expected `recording-lost` where `recording-ended` is correct.

## What it is

`npm run test:soak` runs `helper/test/fault-soak.soak.test.ts`. Every fault the ticket names goes into a real take, and every result is held to the same bar (`helper/test/_soak.ts`):

1. **Parseable.** `anchors.json` exists (after `recoverTake` if the helper died), and `loadSession`, the editor's own loader, accepts the directory.
2. **Watchable.** The whole take goes through the real export (`scripts/export-one.mjs`: Chrome, decode, composite, encode). The encoded file must hold every frame the export says it made, and must reach within 1 s (60 frames) of where `anchors.json` says the take stopped.
3. **On record.** For a stop: `stop.reason` plus a `stop.t` after the first frame. For a fault the take survives: a reliable-channel warning that carries its time.

| fault | how | expected record |
|---|---|---|
| display disconnect | `STC_CAPTURE_FAULT=display-gone` | stop `display-reconfigured` |
| disk full | `=disk-full` | stop `disk-full` |
| write error | `=disk-write-failed` | stop `disk-full` |
| encoder stall | `=encoder-stall` (**new**) | warning `frames-dropped` {startNs, endNs, count}; the take goes on; no frame in the file inside that span |
| camera disconnect | `=camera-disconnected`, `camera: true` | warning `camera-disconnected` with `tNs` (**new field**); the camera track ends there; `anchors.camera.endedBy` is `disconnected` (STC-237) |
| system audio stop | `=system-audio-stop`, `systemAudio: true`, a sound playing (STC-542) | warning `system-audio-stopped` with `tNs`; `system.m4a` ends there; `anchors.system.endedBy` is `stream-stopped` (anchors-14) |
| camera gap | `=camera-gap`, `camera: true` (STC-562) | no `camera-track-failed`; the camera track runs past the 3-8 s gap with no sample over 1.6 s; no `camera.endedBy` |
| camera stall | `=camera-stall`, `camera: true` (STC-553) | warning `camera-stalled` with `tNs`; one `camera.stalledSpans` span starting there (anchors-16); camera frames in the file after it ends |
| IPC pipe close | stdin closed mid-take | stop `stdin-closed`, helper exits 0 |
| helper crash | SIGKILL mid-take | recovered, `recorder-quit` |
| pipe close via the supervisor | the real `HelperSupervisor`'s child's stdin closed | `recording-ended` (not `-lost`: the helper saved it) names the take; respawn; back to idle; a second take records |
| SIGKILL via the supervisor | the same, with SIGKILL | `recording-lost` names the take, the rest the same, then `recoverTake` |

The per-fault `*.grant.test.ts` files stay as they are. They check narrower things.

## What changed in the product

- **Encoder stall used to drop frames silently.** A frame the writer would not take (`isReadyForMoreMediaData` false) only moved the `dropped` count on the lossy stats line, with no record of when. It now also sends one reliable `frames-dropped` warning per run of dropped frames (`helper/src/DropRunDecisions.swift`), closed by the next frame that goes in, or at stop. Frames refused because teardown has begun are not counted as a hole. The app logs the warning to the DevTools console and never toasts it, the same way it handles `display-refit`.
- `mic-disconnected` and `camera-disconnected` warnings now carry `tNs` (session clock), so a device unplug says when it happened.

## §1 Run it (Patrick's terminal)

The terminal needs **Screen Recording, Input Monitoring and Camera**, plus a camera attached and real Chrome installed. The camera case fails rather than skips on a machine with no camera.

```
npm run test:soak
```

Expect 9 passing tests, a few minutes in total (each one ends in a Chrome export). To soak harder:

```
STC_SOAK_ROUNDS=5 npm run test:soak
```

If one fails, the message carries the export's own log. A failure in the `frames-dropped` case's "inside the injected window" bound is the one most likely to be about this machine rather than the code: on an idle display, VFR capture writes nothing, so the first dropped frame can land later than 0.5 s. That bound only checks the run falls *inside* the window, so it should not fire. If it does, paste the warning line.

## §2 Look at one (optional)

Each take is left in `$TMPDIR/stc-soak-*` with its export beside it (`export-3600s-from0s.mp4`). Open the encoder-stall one in QuickTime. Expect a ~1.5 s freeze about half a second in, then normal motion. That freeze is the hole the warning reported.

## Not covered

- A *real* encoder falling behind. The fault reproduces the writer's refusal, not its cause. On real hardware, `frames-dropped` can now show up on its own on a loaded machine, and it is worth noting when it does.
- Mic disconnect. It needs an exact mic uid (STC-233), and `device-disconnect.grant.test.ts` already covers it.
