# STC-642 runbook — a default PiP framing in Settings > Camera

Run from the branch (not on `master` yet):

```
git fetch origin && git checkout accounts/stc-642-settings-camera-a-default-pip-framing
helper/build.sh && npm run app:start
```

Open Settings > Camera with a camera connected. Answer yes or no.

**Framing in Settings**
1. Once the picture shows, **Reframe** and **Zoom** become usable (before it, both are greyed). Yes / no
2. Drag **Zoom** to about 2×: the picture in the PiP gets closer, and the readout says `2.0×`. Yes / no
3. Press **Reframe**: the PiP gets a ring and the note under the preview changes. Yes / no
4. Drag on the PiP: the PICTURE moves under the shape, the PiP itself stays put. Yes / no
5. Scroll on the PiP while reframing: it zooms. Yes / no
6. Arrow keys on the focused PiP move the picture (Shift = bigger steps). Yes / no
7. Turn on **Thirds guides**: the lines show while reframing, and not after Escape. Yes / no
8. With **Mirror** on, the picture still moves the way you drag it. Yes / no
9. Pick **Circle**, then Rect: the framing still looks right in each shape. Yes / no

**It reaches the take**
10. Record a short camera take: the PiP frames you as Settings did. Yes / no
11. Open that take, Reframe it differently, close it, then reopen Settings: Settings' framing is unchanged. Yes / no
12. An older take opened in the editor looks the same as before this build. Yes / no
13. Press **Reset** in Settings, record again: the camera is centred and unzoomed, as before. Yes / no
