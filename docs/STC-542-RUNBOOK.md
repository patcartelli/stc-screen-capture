# STC-542 runbook — system audio that stops mid-take

**Branch:** `accounts/stc-542-system-audio-stops-mid-take-record-why-show-it-on-the-pill`, cut from
`accounts/stc-237-device-loss`. **Not on `master` until STC-237 is**, so run it from the branch:

```
git fetch origin
git checkout accounts/stc-542-system-audio-stops-mid-take-record-why-show-it-on-the-pill
npm ci
helper/build.sh
npm run app:start
```

## What changed

- `Capture.handleSystemAudioStopped` is the mic's `handleMicDisconnected` for system audio. It
  finalises `system.m4a` **at the death** through `midTakeTeardowns`, so a stop straight after
  still gets the track. Before this the writer stayed open until the take's own stop.
- `SystemAudioCapture` drops every sample after a death, so `anchors.system.lastFramePtsNs`
  is the cut even when the stream behind it kept delivering (it does under the injected fault).
- **anchors-14** adds `endedBy: "stream-stopped"` on `system` (12 had shipped with STC-237 and 13 is
  STC-528's), written only on a `present: true` block, and only then is the take v14. A stream that dies before its first sample leaves
  `present: false` and no `endedBy`; the pill still says it, the panel stays silent (as the mic).
- The pill shows **System lost** for 2 s over the timer; the button stays Stop. The panel adds
  "System audio stopped at 1:10, so the rest of the take has no system audio." No toast.
- Export: a system track that ends at 50% mixes to silence past the cut (`audio-mix.test.ts`).

## What kills the stream on real hardware

Not known, and not hunted (Patrick, 2026-10-16): any death takes the same path. An output-device
change (headphones, AirPods) is the first guess and may not end the stream at all.

## §1 — the injected fault, from your terminal (grant test)

```
npm run test:capture -- helper/test/device-disconnect.grant.test.ts
```

Needs Screen Recording; plays a stock sound so the stream has samples before the 0.5 s fault.
Must show: the `system-audio-stopped` warning, the take still recording 2 s later, `system.m4a`
finalised, `system.endedBy: "stream-stopped"`, `lastFramePtsNs` well before `stop.t`, version 14.

The fault soak (`npm run test:soak`, STC-238) has the same fault as a row.

## §2 — by eye (deferred: a real trigger)

1. Play music, record with System audio on, plug in or out headphones at about 0:10. If the
   pill reads **System lost** for about 2 s with no toast, the stream died; if nothing happens,
   the output change does not end the stream (worth a line in `docs/STC-418-RUNBOOK.md`).
2. Stop at 0:20. The panel's line ends with "System audio stopped at 0:10, so the rest of the
   take has no system audio."
3. Play the export: music up to 0:10, silence after, for the full length.
