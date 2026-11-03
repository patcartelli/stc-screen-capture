# STC-608: one set of looks for stills and video

Decided with Patrick, 2026-11-03. Phase B of STC-599. STC-628 (stills wallpaper) and STC-613 merged first; STC-626 (video wallpaper and window scope) follows this ticket.

## Why

A screenshot can wear seven looks (STC-599, STC-628): Window only, Window + shadow, Clean, Dark, Solid, Aurora, Ember, Wallpaper and Custom. A recording can wear only Clean, Dark and Solid, because video's background accepts one colour or a two-colour linear fill (`framing.ts`'s `FramingBackground`, `framingProblem`). Aurora and Ember are three-colour gradients, so video cannot carry them. STC-599 accepted that drift in phase A; this ticket owns closing it.

The aim: **the same look, picked in either editor, draws the same background.** Its colours are defined once.

## Goals

1. **The video editor's Frame tab offers every look that applies to video:** None, Clean, Dark, Solid, Aurora, Ember and Custom, in that order.
2. **One catalogue defines every look's colours and angle.** The still picker and the Frame tab both read it. Tuning a look is one edit.
3. **Video's validator and compositor take multi-stop linear fills,** so Aurora and Ember render in preview and export.
4. **A recording stores the colours it draws,** the way a screenshot already does. Retuning a look later does not change recordings already framed with it (Patrick).
5. **One gradient-direction function.** `framing.ts` and `still-render.ts` each have an identical copy of `gradientLine` today. Keep one, and make both the compositor and the still renderer use it.

## Non-goals

- **Wallpaper in video** stays with STC-626 (Patrick).
- **Window only / Window + shadow** have no video meaning, because a recording has no alpha window edge. Video's **None** takes their place (Patrick).
- **No shared default look** in Settings. A recording's look is picked per take in the Frame tab (Patrick).
- **Geometry is not unified.** A still grows its canvas around the capture; video fits the picture inside a fixed output size (`framing.ts`'s header explains why). Shadow units stay separate: points for stills, fractions of the short edge for video. "Same look" means the same background fill and the same shadow strength, not identical pixel geometry.
- **No new controls for padding, corners or shadow** on either side.

## Anti-goals

- **No change to any existing document's output.** An unframed recording, a recording already framed Clean/Dark/Solid, and every existing still render exactly as before. `shot-v1-frozen` stays unchanged and green, and so does the still gate. `gate:identity` stays green too, including `fixtures/pip-styled`.
- **No look without its colours in the document.** Retuning a look must never move an existing recording's background.

## The Frame tab (decided: option B)

The Background group's single "Style" row (`#framepreset`, a four-segment `pip-segmented` control, `editor.html` ~1160) is replaced by **the still editor's swatch grid**: the same component, swatch chips and order as `#lookgrid` in `still-editor.html`, laid out in two rows of four inside the 376 px inspector pane. The order is None, Clean, Dark, Solid, Aurora, Ember, Custom. It is a radio group with the same keyboard behaviour, focus ring and states as the still picker (STC-587/STC-607 rules: one `--focus` ring, reduced-motion safe).

Padding, Corners and Shadow below it are unchanged.

- **None** removes framing (today's behaviour).
- **Clean, Dark, Solid, Aurora, Ember** are fixed fills from the catalogue.
- **Custom** opens a colour row taking one colour (a solid fill) or two (a linear fill at `CUSTOM_ANGLE_DEG`), exactly like the still picker's Custom (`backgrounds.ts`'s `customBackground`).

**The per-style tint goes (Patrick, 2026-11-03).** Today `#framecolorrow` shows on every style (STC-604): the fill for Solid, the gradient's first stop for Clean and Dark (`framing-edit.ts`'s `framingColor`/`withColor`). With the swatch grid, Clean, Dark and Solid are fixed swatches, as they are for stills, and choosing your own colours is Custom's job. A recording already tinted (Solid with a non-default `color`, or Clean/Dark with an explicit two-stop background) keeps drawing exactly as it does now. The picker shows it as Custom.

**Picking a look and the Frame controls** (*my call*): a look sets the background and, for Dark, the shadow's strength (opacity 0.55). It keeps the document's padding, corners and the Shadow switch's on/off state. With the shadow on, picking Dark writes Dark's shadow, and picking any other look drops that explicit shadow back to the preset default. With the shadow off, it stays off whichever look is picked. When Dark is next picked with the shadow on, it brings 0.55.

## What a recording stores

Picking any look writes the drawn values into `project.framing`: an explicit `background` (and, for Dark, its explicit `shadow`) beside the `preset`. The picker does not rely on the preset name to supply colours at render time.

- **A new project version** lets `framing.background` be a linear fill of **2 to 8** stops (*my call on the cap*; Aurora and Ember use 3). **project-20 is already claimed** by two open PRs (#440 STC-630, #444 STC-636), so this takes the next number free when it merges; the builder wires `project-version.ts` against whichever has landed. As with every other field here, `versionFor` emits the new version only when a document needs it, meaning a linear background with more than two stops. Everything else stays at its current version.
- **An older build and the new version.** `parseProject` (`trim.ts`) returns the whole DEFAULT project when `isProjectVersion` fails. So a build from before this change opens a recording that uses a three-colour look as an unedited take (trim, zoom, levels and framing all ignored), and saving from that build would overwrite the file. This is the standing cost of every project version bump in this repo, not specific to this ticket. It is accepted, not worked around.
- **`preset` is unchanged** (`clean | dark | solid`). It still supplies padding, radius and the shadow default. A look write sets `preset` to the look's own preset for Clean, Dark and Solid, and to `clean` for Aurora and Ember. **A Custom write keeps the document's existing `preset`** (`clean` if there was none), so editing an existing Dark recording's colours does not quietly lighten its shadow (*my call*). Adding preset names would put look identity in two places; the background field is what draws.
- **Recordings framed before this change are left as they are.** They store only a preset name and keep drawing today's Clean, Dark and Solid, which is all they have ever drawn (*my call*; nothing has been retuned, so there is nothing to freeze).

### Which swatch shows selected

As for stills (`backgrounds.ts`'s `lookOf`): compare the background the document draws with each look's. Shadow is compared only for its strength while the switch is on: Dark with the shadow switched off still shows Dark. A framing with no explicit background resolves through its preset first, so pre-change recordings select Clean, Dark or Solid.

- A solid or two-stop fill that matches no look selects **Custom**, the same as stills.
- **Any other fill that matches no look selects no swatch** and keeps drawing its stored colours, also the same as stills. This covers an older Aurora recording after Aurora is retuned. Custom holds only one or two colours, so selecting it for a three-stop fill would offer a row that silently drops a stop (*my call*).

## The shared catalogue

`transform/src/backgrounds.ts` already holds the still looks and reads Clean, Dark and Solid from `FRAMING_PRESETS`. The direction flips: the **catalogue owns every look's fill** (Clean, Dark, Solid, Aurora, Ember, plus Dark's shadow opacity), and both `FRAMING_PRESETS` and the still `LOOKS` derive from it.

**Constraints on the builder:**

- `still-decorate.ts`'s `PRESET_BACKGROUND` must stay equal to Clean's fill. A test already holds this; keep it.
- **The import-graph rules still bind.** `framing.ts` is imported by the main process and by `tsconfig.node.json`'s pass. It may not pick up a DOM- or `shot.ts`-chained import it does not have today. Pick the module that owns the catalogue to fit that: `framing.ts` itself, or a new leaf module both sides import. `backgrounds.ts` imports `still-decorate.ts`, so it cannot be what `framing.ts` imports.
- Still looks keep their mapping to `decoration.mode` (Clean = `window-shadow-background` with no explicit background; the rest `window-shadow-custom-background`), so **no shot document changes and no shot version bump.**

## Rendering

- `compositor.ts` draws N stops evenly spaced (`i / (n - 1)`), the same rule `still-render.ts` already uses, through the single shared `gradientLine`.
- `framingLayout` passes the background through unchanged.
- **TRANSFORM_VERSION:** bump it only if some existing document's export changes. None should, so the expectation is no bump. If the builder finds one does, that is an anti-goal violation to raise, not a constant to bump.

## Tests and gates

- `framingProblem`: accepts 2-8 stops, refuses 1 and 9, refuses a bad hex in any position, and still refuses unknown keys.
- `versionFor` / `projectForWrite`: a two-stop or solid framing stays v15+ as before; a 3-stop one takes the new version; the schema validates both.
- Catalogue: each look's video fill equals its still fill, held by a test, so the two can never drift.
- Compositor: a 3-stop background's pixels at the gradient ends and middle match the still renderer's for the same size and angle.
- Picker: each swatch's write round-trips through `lookOf` for video. A retuned three-stop look selects nothing. A pre-change tinted Solid, Clean or Dark selects Custom and renders unchanged. Dark with the shadow off still selects Dark. A Custom edit on a Dark recording keeps `preset: dark`.
- e2e (CI via draft PR, never locally): the Frame tab's grid is a radio group, keyboard-reachable, and picking Aurora changes the preview.
- Green throughout: `shot-v1-frozen`, `npm run gate:still`, `gate:identity` (including `fixtures/pip-styled`), and all three typecheck passes.

## Done when

- Each look renders the same background in a recording and in a still.
- Preview and export agree (the gates above).
- **Patrick has signed off on screenshots of each look**, in a recording and in a still, on a real window capture with light and dark windows. Merging alone does not close the ticket. The hand-off names the branch to run from.

## Left to the builder

The catalogue module's name and exact location (within the import constraint above), how the swatch-grid markup and CSS are shared between the two editors (a shared module and stylesheet beats a copy), the colour-row markup for Custom in the pane, the e2e helpers, and the TICKET-LOG row.
