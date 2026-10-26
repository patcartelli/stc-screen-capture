# STC-586 — can the title bar alone get native macOS 26 glass?

**Answer (provisional, from the source and a Linux run): no. Ship the CSS bar.**
The Mac run below must confirm it with a screenshot of each approach before
the ticket closes. Run it from `claude/brave-brown-z2zjmb` until that merges,
then from `master`.

## The question, restated

STC-581's Settings window has a sticky title bar that the pane **scrolls
under**, blurred. The ticket's rule: ship native glass only if it works on a
region, without a transparent full window, and without private APIs.

## What was found

### 1. Electron 43.4.1 has no glass, and no region effect of any kind

`electron.d.ts` (43.4.1) offers `vibrancy` / `setVibrancy(type)` and
`visualEffectState`, and nothing else. That is one `NSVisualEffectView`
covering the whole window, with the older material list (`titlebar`,
`sidebar`, `header`, …). There is no `NSGlassEffectView` option and no way to
give either view a rect.

### 2. electron-liquid-glass is whole-window only, by construction

Read from the repo itself (`Meridius-Labs/electron-liquid-glass`, v1.1.1, MIT):

- `AddGlassEffectView` (`src/glass_effect.mm`) makes **one** view at
  `container.bounds` with width+height autoresizing, behind the window's
  content view. The JS API takes only `cornerRadius`, `tintColor`, `opaque`.
  It has no rect, no resize and no remove call ("Remove and update existing
  glass views" is still on its roadmap). A region would mean forking the
  native code.
- It requires `transparent: true` and `vibrancy` unset.
- The README calls `NSGlassEffectView` private. It is public AppKit in the
  macOS 26 SDK. Runbook §1 checks this against the installed headers. The
  genuinely private parts are the `unstable_setVariant` / `unstable_setScrim` /
  `unstable_setSubdued` setters (`set_variant:` and friends via `objc_msgSend`),
  which the spike does not call.
- Maturity: 571 lines in total, the last code change was 2025-09-30 (an
  Electron 36 to 38 dependency bump), and the changelog entries are all
  "Release x.y.z". It ships prebuilt N-API binaries for arm64/x64.

### 3. The real blocker: a native view can't sit between the page's layers

This is what decides the ticket, and it holds for the library, for Electron's
`vibrancy` and for a hand-rolled `NSVisualEffectView`/`NSGlassEffectView`
addon alike.

All of a window's web content is ONE Chromium surface. A native view can sit
**behind** that surface or **in front of** it, never between the pane and the
bar's own HTML:

| native view | what the bar shows | cost |
|---|---|---|
| behind the page (library, `vibrancy`, an addon) | the **desktop** behind the window, blurred. The pane's own content has to stop at the bar's edge (`--layout=below`). If it scrolls under (`--layout=under`), it is drawn **sharp, over** the effect (`linux-native-under` below) | the design's "content scrolls under" is lost |
| in front of the page (an addon) | the page blurred, including the bar's own HTML title and button, under the glass | the bar's text is fogged and its button gets no clicks unless the view overrides `hitTest:` |
| between them | the design | needs two webContents (the pane, plus a transparent bar `WebContentsView` on top) with a native view inserted between their NSViews. Electron exposes no NSView handle for a `WebContentsView`, so this is a fork-level addon, not a half-day |

CSS `backdrop-filter` blurs exactly what the design asks for, the pane
scrolling under the bar, because it runs inside the one surface.

### 4. Against the decision rule

| approach | region? | no transparent window? | no private API? | the designed effect? |
|---|---|---|---|---|
| electron-liquid-glass | no (whole window) | **no** (`transparent: true`) | yes, if `unstable_*` stays unused | no (§3) |
| Electron `vibrancy: "titlebar"` | no (whole window, page masks it) | yes | yes | no (§3) |
| hand-rolled addon, behind | yes | yes (the page is transparent only in the bar) | yes | no (§3) |
| hand-rolled addon, in front | yes | yes | yes | no: fogs the bar's own HTML |
| CSS `backdrop-filter` | yes | yes | yes | **yes** |

No native approach meets the rule and also gives the designed bar, so the CSS
version ships.

### 5. Reduce Transparency, for the CSS bar

Main reads `nativeTheme.prefersReducedTransparency` (Electron 43, darwin; it
maps to `accessibilityDisplayShouldReduceTransparency`) and listens to
`nativeTheme`'s `updated` event. With it on, the bar is the opaque window
colour with a hairline underneath. The spike also carries the
`prefers-reduced-transparency` media query, and the diagnostics box prints
whether Chromium itself reports it (`css true/false`). Runbook §4 settles
whether the media query alone is enough. For STC-581, the CSS bar should key
off one of the two, not both.

## The spike

`scratch/stc-586-glass/` is throwaway and not part of the app build, the tests
or the typecheck. `main.mjs` holds the three window configurations and
`page.html` holds a 760 × 560 Settings stand-in: a 52 px bar, a 180 px sidebar,
colour swatches, inputs to take focus, and a WebGPU (WGSL) canvas that scrolls
under the bar. A diagnostics box in the corner shows the mode, `transparent`,
`hasShadow`, both Reduce Transparency readings, WebGPU status, focus and the
scroll offset.

```
npx electron scratch/stc-586-glass/main.mjs --mode=css|vibrancy|library \
  [--layout=under|below] [--scroll=80] [--shot=out.png]
```

`--shot` writes `screencapture -l <CGWindowID>`, which is the window as the
window server composites it, glass and shadow included (`capturePage()` would
miss a native view), and then quits. On Linux it falls back to `capturePage()`.

Linux (Xvfb, no GPU) run, 2026-10-26: all three modes launch. In css mode the
bar renders over the scrolled pane. In vibrancy at `--layout=under`, the pane's
rows are drawn sharp through the bar region with nothing behind them, which is
§3's first row. Electron has no vibrancy on Linux and the library is a no-op
there, so neither native screenshot means anything until it is taken on the Mac.

## Runbook (Mac, macOS 26+)

From the repo root, on the branch above, after `npm ci`.

**§1 — is `NSGlassEffectView` public?**
`grep -l NSGlassEffectView "$(xcrun --show-sdk-path)"/System/Library/Frameworks/AppKit.framework/Headers/*.h`
A header hit means public. Record the result. It changes the library's "private
API" line, not the answer.

**§2 — the three screenshots** (the ticket's "done when"). Grant Screen
Recording to your terminal if `screencapture` asks.

```
mkdir -p ~/stc-586
npx electron scratch/stc-586-glass/main.mjs --mode=css --scroll=80 --shot=$HOME/stc-586/css.png
npx electron scratch/stc-586-glass/main.mjs --mode=vibrancy --scroll=80 --shot=$HOME/stc-586/vibrancy-below.png
npx electron scratch/stc-586-glass/main.mjs --mode=vibrancy --layout=under --scroll=80 --shot=$HOME/stc-586/vibrancy-under.png
npm i --no-save electron-liquid-glass
npx electron scratch/stc-586-glass/main.mjs --mode=library --scroll=80 --shot=$HOME/stc-586/library-below.png
npx electron scratch/stc-586-glass/main.mjs --mode=library --layout=under --scroll=80 --shot=$HOME/stc-586/library-under.png
```

Put something colourful behind the window first, so the native modes have a
desktop to blur. What each must show:
- `css`: the orange-to-blue swatch, blurred, under the bar's lower half.
- `*-below`: the desktop blurred in the bar, and the pane's content never in it.
- `*-under`: the pane's rows sharp in the bar, on top of the glass. This is the
  screenshot that says no.

If a `*-under` shot shows the pane **blurred** under the bar, §3 is wrong, so
stop and report it: that would reopen the question.

**§3 — what the transparent window costs** (library mode, launched without `--shot`):
- Shadow: is the window's shadow there, and does it follow the 560 px outline
  or only the painted parts? Compare it with the css window side by side.
- Hit-testing: click "Bar button" and check the count goes up. Drag the window
  by the bar. Then click a row through the bar region in `--layout=under`.
- Focus ring: Tab into "Focus me" and check the blue ring is drawn, including
  on a row scrolled under the bar.
- WebGPU: the canvas row animates (diagnostics `webgpu running`). Scroll it
  under the bar in every mode and look for tearing, a black rectangle or a
  stale frame.

**§4 — Reduce Transparency**: System Settings › Accessibility › Display ›
Reduce transparency, toggled while each window is open.
- css: the bar turns opaque with a hairline. Note which diagnostic flipped
  (`main` always should, `css` only if Chromium reports the media query).
- vibrancy and library: screenshot each with it on. `NSVisualEffectView` is
  expected to go opaque grey. `NSGlassEffectView` is reported to have no
  opacity control.

Attach `css.png` and one `*-under.png` to STC-586 with a one-line yes or no.
A no (expected) closes STC-586, and STC-581 builds the CSS bar.
