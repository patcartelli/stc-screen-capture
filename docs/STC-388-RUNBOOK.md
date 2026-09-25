# STC-388: the Record flow, post-merge hardware checks

Run these from **`master` once PR #186 has merged**. Until then, run them from
`accounts/stc-388-record-flow`:

```
git fetch origin accounts/stc-388-record-flow
git checkout accounts/stc-388-record-flow
helper/build.sh && npm run app:start
```

The flow was hardware-passed on 2026-09-18. Since then, master has been merged
in (system audio, STC-418; the library, STC-413/429; STC-444 slice 3; the
STC-449 teardown). Nothing here re-tests the design. These checks only confirm
that the merge didn't break a path no Linux test can see. The flow is fresh
scope, then the options bar on the marquee, then Record, then the countdown.
The spec is `docs/superpowers/specs/2026-09-16-stc-388-record-flow-design.md`.

Record a result for each check (pass, or what you saw) on STC-388 in Linear.

## 1. Where the bar sits

Press Record from the main window. Drag a region in each of these places, and
note where the options bar appears each time:

| region | expected (`barLayout`, `record-options.ts`) |
|---|---|
| near the **top** of the display | **below** the marquee |
| the **middle** | **below** the marquee |
| near the **bottom** (no room below) | flips **above** the marquee |
| the **full display** (drag edge to edge, or press expand) | **inside**, along the bottom |

**What this settles:** whether the bar really follows the marquee, or stays
pinned to the bottom of the screen wherever you drag. `8af3417` changed
`#bar`/`#micmenu` from `position: fixed` to `absolute` on the theory that
`fixed` pins the bar on macOS. It was reverted (`54385ce`), and this merge did
**not** re-apply it. If the bar stays at the bottom for the top and middle
regions, the bug is real. Report it on STC-447 (the bar's design pass), not
here.

Also open the mic menu from a bar near the bottom and from one near the top.
It should open on the side that has room.

## 2. Window pick

Press Record, press Space for window mode, and click a visible window.

- The bar anchors to **that window's** bounds, not to wherever the pointer was.
- Press the bar's Record. After the countdown, the take is **that window**. Open
  it in the library and check the picture and `anchors.json`'s `scope` block
  (`kind: "window"`).

## 3. System audio through the Record flow

The bar has no system-audio control yet (STC-459). Turn it on through the
stored setting instead. In the main window's DevTools console, run:

```
await recorder.setSettings({ systemAudio: true })
```

Then play some sound, make a Record-flow take (any scope), and stop it.

- The take's directory contains **`system.m4a`**, and it has the sound in it.
- Run `await recorder.setSettings({ systemAudio: false })`, make another take,
  and check that **no** `system.m4a` appears.

Behind this: `recordFlowBody`'s start-param builder in `app/src/main.ts` is
the only place a Record's `start` request is built. It reads `systemAudio`
from stored settings. `app/test/system-audio.e2e.test.ts` pins the payload
and this check pins the file.

## 4. The three doors

Each of these must open the **same** overlay, with the same crosshair and the
bar appearing on release:

1. the library window's **Record** button
2. the **menu-bar** item's Record
3. **⌃⌥⇧⌘4**

Then start a take and press **⌃⌥⇧⌘4 mid-take**. It **stops** the take and
does not open a second overlay.

## 5. The pill after the countdown

Make any Record-flow take. When the countdown ends, the main window collapses
to the pill, exactly as `docs/STC-375-RUNBOOK.md` describes (dot, timer, click
to stop). Stopping restores the window to where it was. Nothing about the
pill should look different from before.
