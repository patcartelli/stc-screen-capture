# STC-628 — Window shot looks, with desktop wallpaper

Status: design, agreed with Patrick 2026-11-02. Branch `accounts/stc-628-window-shot-looks`.

## Why

A window shot has no choice of look at the moment it is taken: the helper writes
every window shot as `window-only` (`helper/src/StillDecisions.swift:485`), and the
only way to dress one is to open the still editor afterwards (STC-599's picker).
The goal is that capturing a window already looks the way the user wants, with a
saved default so the quick path stays one click, and that the look most people
want from a tool like this — the window framed by their own desktop picture, as
CleanShot does it — exists at all.

Patrick's reference is a CleanShot window shot: a terminal window, rounded corners
and a soft wide shadow, sitting centred on the macOS wallpaper, with an even margin
of wallpaper all round. **"The background acts as a frame."**

## Goals

1. Four looks for a window shot:

   | Look | What it draws |
   |---|---|
   | Just the window | `window-only` (STC-291) |
   | Window with drop shadow | `window-shadow` (STC-291) |
   | Capture backgrounds | the STC-599 swatches (`clean`, `dark`, `solid`, `aurora`, `ember`, `custom`) |
   | Desktop wallpaper | **new** — the user's wallpaper behind the window, no icons, no other windows |

2. A default look set in **Settings**, applied the moment the shot is taken.
3. **The out-of-the-box default is Desktop wallpaper** (Patrick). This applies to
   existing users too: no one has a saved look yet, so their window shots change
   from "Just the window" to Wallpaper. That is intended.
4. **"Capture backgrounds" reuses the last swatch the user picked in the still
   editor** (Patrick). Settings does not show a swatch picker. Never picked one: `clean`.
   A last pick of Custom carries its colours.
5. Wallpaper is one more choice in the still editor's picker, so the look can be
   changed after the shot.

## How the wallpaper look is drawn (decided)

- The **whole wallpaper**, scaled to **cover** the canvas (no stretching, centre
  crop), centred. Not the patch of desktop that was physically behind the window.
- The window sits centred on it with **the same margin, corner radius and shadow as
  the Capture backgrounds looks**. The margin is the frame. Today that margin is
  `paddingPct` 0.09 of the short edge (`still-decorate.ts`). CleanShot's measures
  about 13%. Do **not** give wallpaper its own margin: switching between Wallpaper
  and a swatch should change only what is behind the window. If 9% reads thin in
  the sign-off screenshots, that is Patrick's call to make then, for both looks together.
- Canvas: `natural` (window + margin), as the background looks already are.
- Shadow: **Clean's** (`PRESET_SHADOW`), always — not the last swatch's. Dark's
  heavier shadow belongs to Dark. *(Claude's call.)*
- `still-render.ts` draws a supplied image stretched to the canvas
  (`drawImage(image, 0, 0, width, height)`); it must change to cover-crop for this
  kind. Stills carry no `TRANSFORM_VERSION`; the still gate is what holds it.

## Speed (Claude's call)

Wallpaper is now the default for every window shot, so it is on the quick path.
**Gate 3's budgets (`STILL_BUDGET_MS` 200, `STILL_END_TO_END_MS` 400) do not move,
and the wallpaper read is timed inside them.** If a full read-and-encode per shot
cannot fit, cache the wallpaper per display (invalidate when the picture or the
Space changes) so each shot only copies a file. Report the measured time in the PR.
If even that can't fit, stop and bring it back. Don't loosen the gate.

## Where the wallpaper comes from (decided)

- Read **at capture time**, from the **Space the window is on**. That Space's
  wallpaper wins over the main display's. In practice a pickable window is on a
  visible Space, so this is the wallpaper of the display the window is on, as currently shown.
- **Dynamic and aerial wallpapers** that don't resolve to one still image use **the
  frame currently showing**.
- The picture is **copied into the shot's own folder** and named by
  `decoration.background.file`, as the STC-300 format audit requires ("a file beside
  this document"). The shot then renders the same after the wallpaper changes, and on
  another Mac. Never store a path into the user's home or `/System`.
- **If the wallpaper cannot be read at all**, the shot uses the **Clean**
  background, and the floating panel says so in one visible line (e.g. "Couldn't
  read your wallpaper, so this shot uses Clean."). It never fails silently. The
  shot is still taken and saved.
- **With "When a shot is taken" set to "Copy to clipboard"**, the shot is still
  copied, but a fallback **shows the panel anyway** (with that line), overriding
  the silent path for that one shot only (Patrick, 2026-11-02). A shot whose
  wallpaper was read stays silent as before. Today the silent path is main's
  `silent: true` presentation (`app/src/main.ts` ~2306).
- In the still editor, picking Wallpaper on a shot that has no wallpaper file
  reads the wallpaper **as it is now**, from the display named in the shot's own
  `display`, with the same fallback and message.

## Format (decided: no version bump)

`shot.json`'s `decoration.background.kind` already includes `wallpaper` and `image`,
with `file` for a file beside the document (shot-1 onward). `still-render.ts`
already draws a supplied image for those kinds and falls back to the first colour
when none is supplied. Nothing in the app ever supplies it today (STC-300 audit §4).
So this ticket is **wiring, not format**:

- A wallpaper shot is `mode: "window-shadow-custom-background"`,
  `background: { kind: "wallpaper", file: "<name>", colors: [<Clean's first colour>] }`.
  The colour is there so a renderer without the file still draws something sensible.
- `shotForWrite`'s minimum-version rule decides the version, and should keep it at v1/v2.
  If anything about this forces a bump, stop and say why.
- `shot-v1-frozen` must not change. `still-gate` must stay green.
- The look must be **recoverable from the document** the way the other looks are
  (`backgrounds.ts`'s `lookOf`): a document with `kind: "wallpaper"` selects the
  Wallpaper swatch in the picker.

## Settings

- One row in **Settings → Capture**, in a new **"Window shots"** section (or beside
  "After a shot"; builder's call): label "Window shot look", four choices.
- Must have default, hover, focus-visible (the shared `--focus` ring), active and
  disabled states, work by keyboard, and announce the selected state. Use the
  existing Settings control patterns (STC-581/587): a `.dropdown` built from
  `settings-dropdown.ts`, or a `.segmented` radio group if four labels fit at 760 px.
  Builder's call, judged by fit.
- Stored in `settings.json` as a new field (name builder's call). The last swatch
  picked in the still editor is a second field. Main writes it when the editor
  commits a pick. Neither field may be written by an arbitrary `recorder:setSettings`
  payload unless validated, following the existing settings validation.

## Non-goals

- Video/record window-scope backgrounds (STC-626).
- Desktop icons or other windows in the background.
- Display-crop and area shots (no alpha; they stay `selected-area`).
- Tier-3 abstract backgrounds (STC-610) as a look.
- A per-shot look choice at capture time (an overlay control). The default lives in Settings only.
- Unifying still and video background models (STC-608, which this ticket blocks).

## Anti-goals (would be a failure even if it works)

- A wallpaper shot that silently comes out as a flat colour.
- A shot that depends on a file outside its folder.
- Preview and export disagreeing (the editor, the panel and the exported PNG/HEIC/JPEG must show the same pixels).
- The quick path growing a step: a default capture stays one click.
- The wallpaper showing anything but the wallpaper (icons, the Dock, other windows).

## Left to the builder

- **How the helper reads the wallpaper.** Two candidates, to be measured:
  ScreenCaptureKit capturing the system wallpaper window for that display on its own
  (that gives the frame currently showing for dynamic and aerial wallpapers, with
  no icons), or `NSWorkspace.desktopImageURL(for:)`, which returns a file and
  is wrong for dynamic and aerial wallpapers. Prefer whichever honours "frame currently
  showing". A fallback chain is fine if each step is logged.
- Whether the wallpaper is fetched inside `capture-still` (one round trip) or by
  a new helper command the editor can also call. The editor needs it on its own anyway.
- Where the look is applied: helper-side in `shotDocument`, or main-side right after
  capture through the same `lookWrite`/`applyLook` the editor uses. One path for both is preferred.
- File name and format of the copied wallpaper (PNG vs HEIC, resolution cap).
  Keep the display's colour space.
- Wording of the fallback line, through `design:ux-copy` or matching existing panel copy.

## Done when

- Each of the four looks exports correctly. Preview and export agree. `still-gate`
  green, `shot-v1-frozen` unchanged.
- Unit tests for the pure parts: look ↔ document round trip including wallpaper,
  settings validation, the fallback decision.
- A runbook (`docs/STC-628-RUNBOOK.md`) covering what only a Mac can settle: a
  dynamic wallpaper, an aerial wallpaper, two displays with different wallpapers, and
  the fallback message.
- **Patrick signs off on screenshots of all four looks on a real capture, light and
  dark windows.** Do not close the ticket on merge alone.
