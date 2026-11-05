# STC-626: video window takes wear the same four looks

Status: draft for Patrick's review, 2026-11-03. Branch `accounts/stc-626-video-window-looks`.

## Why

STC-628 gave a window SHOT a look the moment it is taken: Just the window, Window with shadow, Capture background, or Desktop wallpaper (the default). A window RECORDING has none of that: it opens plain, and the wallpaper look does not exist for video at all. Shot and Record should behave alike, so someone who sets one look in Settings gets it on both.

STC-608 already did the fill half: video framing draws every Capture look (Clean, Dark, Solid, Aurora, Ember, Custom) from the shared catalogue, `transform/src/looks.ts`. What is left is the default at record time, a shadow look video can actually draw, and an image background.

## Corners

A recording's frames are opaque, so the window's corners rely on the look's clip (1.2% of the output's short edge), not on real transparency as a still does. Reading the code suggested dark wedges could show there. Patrick watched framed window recordings during STC-608's sign-off and the corners looked fine (2026-11-03), so this design changes nothing. White and wallpaper are new backgrounds for this, so the runbook checks corners on each, including a small window, where the clip's radius is smallest.

## Goals

- A new window-scope take starts wearing the look chosen in Settings (`windowShotLook`).
- The video Frame control offers all four looks on a window-scope take.
- Preview and export of a wallpaper take agree, held by `gate:identity`.

## Non-goals

- Display-scope and area-scope recordings: their default (no framing) and their Frame grid do not change.
- Older takes: nothing is rewritten, and each still opens and exports as it did.
- Stills and selection behaviour (STC-625, STC-628).
- Transparent video. MP4 has no alpha.

## Anti-goals

- Delaying the take's first frame to read a wallpaper.
- A toast or notice mid-take: it would be filmed.
- A second place that knows how to turn a look into a background. `window-look.ts` stays the one mapping for both capture types.
- A sink reading a live setting or the live desktop at draw time. `render()` is pure.

## Decided by Patrick (2026-11-03)

1. **Window with shadow sits on plain white.** An MP4 cannot be transparent, so the shadow needs something to fall on. White (`#ffffff`), the normal video padding and shadow. It reads as "no background" on a white page, and shows as a white box on a dark page; that cost is accepted.
2. **New window takes wear the Settings look**, including the out-of-box default, Desktop wallpaper. An untouched window recording therefore comes out inset by 6% with smaller text. The existing legibility warning already accounts for the inset through `contentFraction`.

## The four looks on video

| Setting | What a new window take is seeded with |
|---|---|
| Just the window | No framing, so no `project.json` field at all. Same as today. |
| Window with shadow | `framing`: preset `clean`, `background` solid `#ffffff`, preset padding, corners and shadow. |
| Capture background | `framing` built from `lastBackgroundLook`, the last swatch picked in the still editor; Clean if there is none. |
| Desktop wallpaper | `framing` with the new wallpaper background and the preset padding, corners and shadow. Clean if the read failed. |

**The mapping lives in `app/src/window-look.ts`**, beside `captureLook` and its parallel: a pure `recordingLook(look, lastBackground, wallpaper)` returning `{ framing?: Framing; notice?: string }`.

Builder's call within this: a still's background can be a kind video cannot draw (`radial`, `mesh`). A `lastBackgroundLook` of such a kind maps to Clean rather than failing. Today's picker cannot produce one, but `parseLookWrite` accepts them.

**A pick in the video Frame control does not update `lastBackgroundLook`.** It stays "the last swatch picked in the still editor", which is what the Settings row already means. (My call; flagged below.)

## Wallpaper

**Fixed for the take** (settles the ticket's open question). Read once and stored in the take folder as `wallpaper.jpg`, so preview and export read the same bytes forever, whatever the desktop later does. Following a mid-take change would need a timeline of desktop changes in the document, for little gain.

**Read when the countdown starts, finished before `start` is called.** In `recordFlowBody`, beside the camera warm-up, only for a window take whose Settings look is Desktop wallpaper. The read costs roughly 150-175 ms on a 5K display (STC-628), against a 3 s countdown. It reads only the wallpaper window, so the countdown and pill are not in the picture. "The frame showing at record start" therefore means the moment the countdown began.

Why not after `start`, which was the first draft: the single `project.json` write has to stay right after `start` so a crash keeps Show Clicks and the PiP style (STC-493), and it never overwrites. A read still in flight at that point would force a second write, or let Stop reach the panel and its background Copy before the look existed. With the read done first, the seed knows its answer the moment it is written, with no race and no amendment. It also keeps the verb's own `SCShareableContent` call from overlapping `start`'s (STC-470).

**The mechanics:**
- The helper creates the take's folder itself during `start` and removes it on a failed start, so the read goes to a scratch folder beside the temp takes (the verb creates it). Main moves `wallpaper.jpg` into the take right after `start` succeeds and before the seed is written.
- `start` awaits the read, bounded by the verb's own timeout. With the countdown set to off, that awaits about 170 ms before the take begins. Nothing is recording yet, so no frame is late.
- A cancelled countdown or a failed start removes the scratch folder.
- A capture asked for mid-prime already waits for it (STC-522); the read follows the same rule.

**Which wallpaper:** the display the window is on. A pickable window is on screen (STC-625), so that display's current wallpaper is its Space's. The display id comes from the take's start result (`anchors.display`'s id, or whichever the start answer already carries; builder to confirm).

**Failure** (`STC_CAPTURE_FAULT=wallpaper-unavailable` drives it): the take uses Clean, and the post-take panel says so. Same rule as stills: never a surprise, and never mid-take. Main keeps the notice against the take dir and shows it on the panel; a take recovered after a crash loses it, which is acceptable. The copy needs its own sentence, since `WALLPAPER_NOTICE` says "this shot".

**Picking Wallpaper in the editor on a take with no file:** same as the still editor's `still:fetchWallpaper`. A file already in the take is kept and never replaced; otherwise read it now from the take's display; on failure, Clean with the notice shown in the Frame pane. So a take recorded under another look can still choose Wallpaper later, and gets today's desktop. Only a take whose Settings look was Desktop wallpaper has the picture from record start.

## The document

`schema/project-22.schema.json` (next free number): `framing.background` gains a third kind.

```json
{ "kind": "wallpaper", "file": "wallpaper.jpg", "color": "#e9edf2" }
```

`color` is the fill drawn when the image cannot be, Clean's first stop, the same fallback a still's wallpaper carries. `file` must equal `WALLPAPER_FILE` exactly, the same rule `stillFrameNameAllowed` applies. Minimum-version rule: v22 only when the background is this kind, so all other documents keep their version. `framingProblem` validates it, so main's write gate refuses a bad one and `parseProject` drops it, as for every other framing field.

**The record-time seed stays a seed** (`take-project.ts`): raw `{ version, framing, ... }`, written only when a look applies. A window-only take with Show Clicks on still writes nothing. `version` is the higher of the choices it carries: 15 for a fill, 21 for a look of more than two stops, 22 for wallpaper. Video's rule that framing is per take does not change: the seed is a starting value and the editor owns it after.

`recordTimeProject` applies only to `scope.kind === "window"`. The other scopes pass no framing.

## Drawing it

The rule is that `composite()` stays a pure draw of what it is handed, and `render()` stays free of I/O.

- **`framingLayout`** passes the wallpaper background through in `FramingLayout`. It knows nothing about pixels.
- **`composite()`** gains one parameter, the decoded background image or null (builder's call on the exact shape; every call site listed by `grep "composite("` must pass it, including `harness/sink-identity.ts`). `drawChrome` draws the image cover-cropped when it has one, else `color`.
- **The cover crop** reuses `coverRect` from `still-render.ts`, the still's own pure function, so there is one rule.
- **One loader:** `app/src/session-io.ts`'s `loadTake` is already the ONE take loader used by the editor and by the hidden copy-render window, so it reads and decodes the file once and hands it on. Preview, export, Copy and GIF all draw from that. `TAKE_FILES` (main.ts) gains `wallpaper.jpg`, or the reader follows `stillFrameNameAllowed`'s rule.
- **A file that will not load or decode** draws `color` in every sink alike, so a missing file degrades without breaking preview-equals-export. The take is never refused for it.
- **Colour:** both sinks must decode through the same call with the same options, and the canvas colour rules that already apply (P3 canvases, GIF's forced sRGB per STC-510) apply unchanged. A P3 wallpaper in an sRGB export is converted by the browser, and `gate:identity` proves only that the sinks agree. A person judges the colour.

`TRANSFORM_VERSION` stays 20: only a v22 document reaches the new draw path, so no existing document renders differently. STC-608 and STC-630 set the precedent.

## The Frame control

On a window-scope take the swatch grid reads:

Just the window, Window with shadow, Clean, Dark, Solid, Aurora, Ember, Wallpaper, Custom.

"Just the window" is the existing None, relabelled for window takes. Display and area takes keep today's grid and labels exactly.

- `VIDEO_LOOKS` becomes scope-aware (`app/src/framing-edit.ts`), and `withLook` / `videoLookOf` learn `shadow` and `wallpaper`. `videoLookOf` selects Window with shadow when the fill is `#ffffff` solid at the base shadow.
- Opening a display-scope take that somehow carries a wallpaper background still draws it: the grid hides a pick, the renderer does not refuse a document.
- All three rows below the grid (Padding, Corners, Shadow) keep working on every look, wallpaper included.
- The wallpaper swatch shows the take's own picture when it has one; a neutral placeholder otherwise.
- Keyboard and focus follow the grid's existing behaviour (STC-608).

**Settings:** one setting now covers both, so the row stops saying "shot". `Window shots` / `Window shot look` become `Windows` / `Window look`, with helper text saying it covers screenshots and recordings. The stored key `windowShotLook` keeps its name.

## Files that must keep working

Things a new file in a take folder or a seeded project can trip, each to be checked while building:

- `findOrphanedBundles` / Reclaim: `.jpg` is in `MEDIA_EXTENSIONS` and "an untagged image can only hide a still's export" (STC-435). `wallpaper.jpg` inside a recording's folder must not block or confuse that take's orphan proof. This is the one most likely to bite; add a test with a control, as STC-592 did for GIFs.
- `duplicateTake`, promotion from temp, Trash and undo: `wallpaper.jpg` travels with the take.
- The panel's unedited Copy renders the saved project, so a window take's Copy now wears its look. That is the decision working as intended, and worth a runbook line.
- `gif-export`: the palette is sampled across the take, so a wallpaper photo spends palette entries, and only smooth gradients get dithered. Expect a rough-looking GIF background. Accepted for now; a runbook line, no code.
- Framing hold (`framing-hold.ts`): the override editor sets framing aside and restores it, which should need nothing, since it holds the whole object.
- `stop-copy.ts` is unaffected: a failed wallpaper read is not a stop.

## Tests

- **Pure, unit:** `recordingLook` for each look and each fallback; `framingProblem` on the new kind, including a `file` with a path in it; the cover crop; `withLook` and `videoLookOf` round trips; `recordTimeProject`'s version for each look and its window-only null; `projectForWrite` staying under v22 without the kind; the orphan rule above, with a control.
- **`gate:identity`:** a new `fixtures/wallpaper-framed/` (a `project.json` and a small committed `wallpaper.jpg`, media copied the way `fixtures/pip-styled` does it). Preview equals export byte for byte. A control with the file missing must also agree, drawing `color`.
- **e2e, on CI only:** a window take through `_record-flow.ts` with the fake helper opens with the Settings look selected; a display take opens with None and today's grid. Never run locally.
- **Grant test (Patrick's terminal):** a window take with the wallpaper look leaves a valid `wallpaper.jpg` and a seed, with a `wallpaper-unavailable` control that seeds Clean.

## Sign-off

`docs/STC-626-RUNBOOK.md`, short yes/no lines, run from the branch until it merges. A clip of each of the four looks on a real window (the ticket's done-when), wallpaper with a dynamic wallpaper set, Copy wearing the look, and the failed-read panel line.

## Calls made in this document (not Patrick's)

- A video pick does not update `lastBackgroundLook`.
- The wallpaper is read when the countdown starts and is finished before `start`, so "at record start" means up to one countdown earlier.
- A take not recorded under the wallpaper look can still pick Wallpaper later and gets today's desktop.
- Settings' row is renamed to `Windows` / `Window look`.
- A failed read tells you on the post-take panel.
