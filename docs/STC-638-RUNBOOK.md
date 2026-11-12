# STC-638 runbook — the camera menu's live view

Run from the branch (not on `master` yet):

```
cd /Users/pcartelli/dev/stc-screen-recorder/.claude/worktrees/stc-638-spike
helper/build.sh && npm run app:start
```

Start a recording (hotkey or menu bar), draw an area, open the options bar. Answer yes or no.

**The view**
1. Open the **camera menu**: a picture of you appears at the top of the menu. Yes / no
2. It reads "Starting camera…" first, then the picture (a USB camera takes about 3 s). Yes / no
3. Pick a **different camera** in the menu: the picture changes to it. Yes / no
4. Pick **Off**: the picture goes, and the camera's light goes off. Yes / no
5. Close the menu (click elsewhere on the bar, or Esc): the light goes off. Yes / no
6. Open the **mic menu** instead: no picture, no light. Yes / no
7. With the camera menu open, press **Capture Video** (the first press only closes the menu), press it again: the take starts and the PiP is in it. Yes / no

**Guides and mirror**
8. With `framingGuides` on (editor's guides button), the camera menu's picture shows thirds lines you can see over a dark and a light background. Yes / no
9. With the PiP default's Mirror on (Settings > Camera), the picture is mirrored. Yes / no

**Edge cases**
10. Camera access off in System Settings: the menu says "Camera access is off", and the camera never lights. Yes / no
11. Unplug a USB camera with its menu open: "Camera disconnected". Yes / no
12. On a display whose bottom is close, the taller menu flips above the bar and stays on screen. Yes / no

**Settings > Camera (slice 3)**

Run from `accounts/stc-638-settings-camera-live-view` (not on `master` yet): `helper/build.sh && npm run app:start`, then open Settings > Camera.

13. The little camera box on the sample screen shows **you**, not a silhouette, about 3 s after you open the pane (a USB camera). Yes / no
14. Switch to another pane (or click another app): the picture goes and the camera's light goes off. Come back: it returns. Yes / no
15. Drag the box, change Shape, Size, Mirror: the picture follows and stays cropped to the shape. Yes / no
16. Open the record bar (hotkey) with Settings still open: the bar's camera menu still shows its own picture. Close the bar: Settings' picture comes back. Yes / no
17. Camera access off in System Settings: the box keeps its silhouette, and hovering it says "Camera access is off". Yes / no
