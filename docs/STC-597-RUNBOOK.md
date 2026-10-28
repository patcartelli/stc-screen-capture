# STC-597 runbook: menu bar item icons

Run from the branch `accounts/stc-597-menu-bar-item-icons-assess-libraries-then-add-to-the-tray`
(not on `master` until the PR merges).

```
git fetch origin && git checkout --detach origin/accounts/stc-597-menu-bar-item-icons-assess-libraries-then-add-to-the-tray
npm ci && npm run app:start
```

`--detach`, because the branch is checked out in the session's worktree
(`.claude/worktrees/stc-597-menu-icons`) and git refuses a second checkout of
it. That worktree already has `node_modules`, so running `npm run app:start`
from inside it works too.

## Result (Patrick, 2026-10-28)

§1 CONFIRMED: the template icons follow light and dark. §2 CONFIRMED: Patrick
reviewed the open menu in both appearances and signed off. The sections below
are kept as the procedure, and the note under "What was and was not checked"
about nothing having been seen is as of the build session, before this.

## What was and was not checked

Checked in code (`app/test/tray-menu.test.ts`): which items carry a glyph and
which glyph, that Record swaps to a stop glyph mid-take, and that every glyph's
16 px and 32 px alpha mask is real anti-aliased ink, is the same drawing at both
sizes, and has no stroke cut by its box.

**Never seen in a real menu.** The session that built this had no Screen
Recording grant, so a screenshot of the popped menu came back as bare
wallpaper. Nothing here has been looked at on a menu bar, which is what the
ticket's last "done when" line needs.

## 1. Do template images follow the menu (the ticket said confirm this)

`tray.ts` sets `setTemplateImage(true)` on each item's icon and expects macOS to
paint it black or white to match the menu. Electron documents that for the
menu-bar glyph; for a menu ITEM's icon it is the thing to confirm.

1. Click the menu-bar item in **light** appearance. Icons should be dark.
2. System Settings, Appearance, **Dark**. Click it again. Icons should be white.
3. Hover an item. The icon should invert with its label on the highlight.

If an icon stays black in dark mode, template-ness is not reaching the item: say
so, and the fallback is to ship a second, white set and pick by
`nativeTheme.shouldUseDarkColors`.

## 2. Screenshots for sign-off (both appearances, 1x and 2x)

Open menu, light and dark, on a Retina display. The 1x case needs an external
non-Retina display or the Displays "Low resolution" scaled mode.

Judge:

- **Crispness.** Material's w300 stroke is ~1 px at 16 pt, so at 1x some
  strokes land on a pixel boundary and go soft. That is the known cost of
  keeping the app's own icon family (see the header of `scripts/vendor-icons.mjs`
  for the assessment). If 1x is too soft to ship, the answer is a hand-hinted
  16 px set for the few offenders, not a different library.
- **Weight against the label.** The icons should sit under the text, not over it.
- **Group consistency.** The Settings and About group has an icon on Settings
  only. macOS's own menus usually give every item in a group an icon or none.
  If it reads as ragged, either give About a glyph (`info`) or drop Settings'.
  The ticket defaulted About and Quit to none, so this is Patrick's call.
- **Glyph meaning.** Area is `screenshot_region` (corner brackets with a cursor),
  Window is `web_asset`, Display is `desktop_windows`, Timer is `timer`,
  Library is `video_library`, Editor is `movie_edit`, Settings is `tune`.
- **Mid-take.** Start a take and open the menu: Record becomes "Stop Recording"
  with a stop glyph.
