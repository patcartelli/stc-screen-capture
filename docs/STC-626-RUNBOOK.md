# STC-626 runbook: video window takes wear the four looks

Not on `master` yet. Run from `accounts/stc-626-video-window-looks` until it merges.

```bash
git fetch origin && git checkout accounts/stc-626-video-window-looks && git pull && npm ci && helper/build.sh && npm run app:start
```

Before each take, set the look in Settings > Capture > Window look. Record a real window, stop, press Edit.

## 1. Sign-off: a clip of each look on a real window

- [ ] Just the window: the recording with nothing around it.
- [ ] Window with shadow: white background, normal shadow.
- [ ] Capture background: the last swatch you picked in the still editor.
- [ ] Desktop wallpaper: your wallpaper, not stretched.

## 2. Corners

- [ ] White: no dark wedges at the window's corners.
- [ ] Wallpaper: no dark wedges.
- [ ] Both again on a small window. Still clean?

## 3. Wallpaper

- [ ] With a dynamic wallpaper set, the take shows the picture from when you pressed Record.
- [ ] Change your wallpaper, reopen the take: it still shows the old picture.
- [ ] On a second display, the take uses that display's wallpaper.

## 4. Editor

- [ ] A window take's grid reads: Just the window, Window with shadow, Clean, Dark, Solid, Aurora, Ember, Wallpaper, Custom.
- [ ] The Wallpaper swatch shows your picture.
- [ ] A screen or area take's grid looks the same as before.
- [ ] Preview and exported MP4 look the same on Wallpaper.
- [ ] Set Window look to Clean, record, pick Wallpaper in the editor: you get today's desktop.

## 5. After a take

- [ ] The panel's Copy pastes a video wearing the look.
- [ ] Older takes open and export as before.
- [ ] A wallpaper take's GIF: is the rough background acceptable?

## 6. A failed read

```bash
STC_CAPTURE_FAULT=wallpaper-unavailable npm run app:start
```

- [ ] With Window look on Desktop wallpaper, the take comes out Clean, and the panel says "Couldn't read your wallpaper, so this take uses Clean."
- [ ] Nothing appeared during the take.

Already passing in the agent's shell: typecheck, unit tests, `gate:identity` on a wallpaper fixture (with the file missing and corrupt too, and a sabotage control that fails). The e2e tests run on CI. Nobody has seen this running on a real take yet.
