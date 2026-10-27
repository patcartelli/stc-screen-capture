# STC-594 — a native glass sidebar for Settings

**Decided 2026-10-27 (Patrick): no. The Settings sidebar stays solid `--side`.**
The flag and its code were removed. They are in this PR's history
(`e621e0d`..`6abd0ea`) if the question comes back.

## Why the sidebar, when STC-586 said no to the title bar

STC-586's blocker was that a native view sits behind or in front of the page's
one Chromium surface, never between the pane and the bar. So a glass bar could
only blur the desktop, never the pane scrolling under it. Nothing scrolls under
the sidebar. Its glass shows the desktop behind the window, which is exactly
what a macOS sidebar does. So the spike used only public API: Electron's
`vibrancy: "sidebar"` (one `NSVisualEffectView` behind the page), with no
`transparent: true` window and no electron-liquid-glass.

## What was built and run

The flag was `STC_GLASS_SIDEBAR=clear|tint` (macOS only). With it set:

- The Settings window got `vibrancy: "sidebar"`, `visualEffectState:
  "followWindow"` and a clear background.
- The page left only the 180 px sidebar unpainted.
- `tint` added a 55% dark wash, because the material follows the system's
  Light/Dark appearance and Settings is dark-always.

## What the Mac showed

- **It works.** Run with `clear` over a white page, the logs showed the
  window got vibrancy (Reduce Transparency off). The page painted nothing over
  the sidebar (html, body and sidebar all `rgba(0, 0, 0, 0)`; only `#panes`
  opaque).
- **It is faint.** The sidebar shows the desktop through it, but only just.
- **The first try looked like nothing happened.** That run was `tint`, over an
  ordinary desktop. In Dark mode the material is already close to opaque
  near-black, and a 55% wash on top made it indistinguishable from the solid
  sidebar.

That is not worth the code and the Light-mode risk (the material goes light
under a dark-only window's text), so it was dropped.

## Library

STC-584's spec has no sidebar. Its filter and search live in a sticky glass
title bar, which STC-586 already answered (CSS). Nothing here applies to it.

## If this is ever reopened

- Vibrancy reads as glass only over a bright, busy desktop. Test over one.
- A tinted wash makes the glass disappear in Dark mode.
- A louder material (`under-window`, `hud`) was not tried.
