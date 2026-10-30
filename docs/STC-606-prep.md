# STC-606 prep: Editor build 4/5, section overlays

Written 2026-10-29 by a scheduled prep run, after both blockers were Done in Linear (STC-604 completed 19:26, STC-605 completed 19:49). This is read-only research: no branch was cut, nothing was claimed (`npm run ticket` was not run) and Linear was not touched.

**Repo state.** Code was read from `origin/master` at `bbbebaa` (the STC-605 merge, #412). The local `master` checkout is one commit behind and has two untracked handoff docs, so it was not moved. Line numbers below are from `origin/master`. Two PRs are still open: #413 (STC-604 follow-up: Export Length and Folder rows) and #414 (STC-605 ticket-log row).

**Sources.** Linear STC-606 (with relations) and the descriptions and comments of STC-604 and STC-605. The Figma v2 frames (file `bUFLOIAxW8Mun8AtEcf72R`), read through the Figma MCP with metadata and screenshots. `docs/STC-604-RUNBOOK.md`, `docs/STC-605-RUNBOOK.md`, `docs/HANDOFF-2026-09-24-STC-444.md`, CLAUDE.md and AGENTS.md.

## Decisions (Patrick, 2026-10-29)

- **Zoom chip:** builds on STC-619 (PR #415). Once #415 merges, the chip's In/Out/Both picks which side its speed control edits (Both = linked), using 619's fields. Plumbing, Camera, Export and Frame go first.
- **Audio ceiling:** stays in STC-606, built last, with its own schema bump after 619's project-17.
- **Export bars:** the full-height bars and the strip range readout show only while Export is active. Other sections keep today's Clip-lane trim handles.
- **Camera:** restyle only. The resize handle, section gating and readout already landed in STC-604.

**Zoom chip note (Patrick, 2026-10-30).** The chip holds the amount, In / Out / Both, a Slow / Med / Fast control, and delete. In / Out / Both picks which side the speed sets; Both sets both, and with two different sides lights none. Pressing the lit speed returns that side to the project default. The Ease in / Ease out rows stay and follow the chip.
- **Edits:** the open block's draft (`draftRect`, `draftEasing`), the same as the Zoom section's rows. The amount is editable: it is the region's size (frame ÷ longer side), so changing it resizes the region about its centre and slides it back inside the frame. An Auto block starts from the region stage 2 would zoom to. The range, 1.1× to 4×, is this ticket's call. An Amount slider is added to the Zoom section, as in the frame.
- **Saves to the project:** yes, through `committedOverrides`, with no new field. The easing uses STC-619's fields (project-17 only when the sides differ). Delete uses the existing paths: a manual block is deleted, and an auto block is marked removed.
- **Tests:** unit tests for the side and speed rule and for resizing to an amount. The e2e tests cover: the chip shows only in Zoom with a block open, above the block and never over the Clip lane; speeds and the amount are saved; the arrow keys stay with the chip; delete removes the block; a press on the chip never grabs the playhead.

**Audio note (Patrick, 2026-10-30).** Limit peaks and Ceiling.
- **Edits:** a new setting, `peakLimit` (`{ enabled, ceilingDb }`), off at −1 dB by default, ranging from −12 to 0 dB. With Limit peaks on, the mix is hard-limited at the ceiling instead of at full scale. This is STC-418's rule, just lower, and it applies in the preview, the export and the waveform alike. Either way, the ceiling is the lane's guide.
- **Peaks over:** counted per burst. Consecutive waveform buckets at or over the ceiling make one peak, with one marker.
- **Saves to the project:** yes, as project-18, but only when the setting is not the default. An untouched take mixes and saves exactly as before. A mic-only take goes through the mixer when Limit peaks is on.
- **Where it shows:** the ceiling line and its drag handle sit on the Audio lane, with red markers in the gap above it. The readout ("Ceiling −1 dB · N peaks over ●") is in the transport row. All of it shows only in Audio. Limit peaks and Ceiling sit under Cleanup, which now shows for any take with audio; the voice rows stay mic-only.
- **Tests:** unit tests for the setting, the mix limit, the burst count, project-18 and the schema. The e2e tests cover gating, the readout's placement, the slider, the handle and keys, and saving.

## Summary

STC-606 adds one set of overlays per inspector section, each shown only while its section is active:

- **Zoom:** a dashed region with a readout on the preview, and a chip above the selected block.
- **Camera:** an outlined box with a resize handle and a shape · size · anchor readout.
- **Audio:** a draggable ceiling line, peak markers and a "peaks over" readout.
- **Export:** in/out handles across the lanes, dimmed trimmed ends and a range readout.
- **Frame:** a hover tooltip (timecode, clicks, keys) with a hairline through the lanes.

Part of this is restyle and part is new behavior, and the new behavior reuses the existing gestures: rect drawing and zoom block editing (STC-328 series), PiP drag and snap, and trim handles (STC-241). It stays one ticket. If one overlay's new behavior slips, the ticket is blocked on purpose; nothing is cut silently.

**Done when** Patrick signs off on a screenshot of each overlay next to its Figma frame, and the new behavior works.

## Constraints from the ticket

- **Zoom chip placement.** The chip lives in the reserved overlay strip between the ruler and the first lane (`#overlay-strip`, 36 px, added in STC-605), so it never covers the Clip waveform.
- **Audio readout placement.** The readout does not sit on the lane. It goes in the inspector pane or the transport readout. Peak markers stay on the lane.
- **Audio colour.** The ceiling line and the peak markers are red. The readout text is neutral, with a red dot or bar.
- **Red is also destructive.** The Remove button and the chip's delete icon stay red.
- **Scope.** One ticket, and nothing is cut silently.
- **Carried over from STC-605.** The scrubber's ten rules (`app/src/scrubber.ts` L15–89) and the e2e element IDs in `docs/HANDOFF-2026-09-24-STC-444.md` (`#clock`, `#scrub`, `#trim-in`/`#trim-out`, `#ticks`, `#triminfo`, `#markin`/`#markout`/`#resettrim`, and others) stay, unless the design changes one on purpose and the tests move with it. Keep every `#timeline.getBoundingClientRect()` reader working.

## Shared plumbing (needed by every overlay)

- **Active-section hook.** The active section is only a module variable: `let paneSection` (`app/src/editor.ts:2932`), changed by `selectSection()` (`editor.ts:2934`). No data attribute and no event exist.
  - Suggestion: set `data-section` on the editor root inside `selectSection`, and gate overlays in CSS or one `layoutOverlays()`.
  - Camera already does this gating in `layoutPipOverlay()` (`editor.ts:2289`), using `pipPanelOpen() || pipDrag`, and serves as the model.
- **Strip interactivity.** `#strip-content` has `pointer-events:none` and takes the ruler's pan/zoom transform (`applySpanTransform`). A clickable chip has to opt back in, the way `.zoomblock` does.
- **Playhead grab.** A capture-phase pointerdown within `PLAYHEAD_GRAB_PX` (6) of the playhead drags the playhead unless the target matches `NOT_THE_PLAYHEAD` (`editor.ts:1957`). Every new interactive element (chip, ceiling handle, range readout) must join that selector.
- **Strip contents today.** The only things in the strip are bookmark lines (`#strip-bookmarks`, `renderBookmarks()` `editor.ts:672`).

## Per overlay

The notes marked **DRAFT** are the per-item notes the ticket requires before each new-behavior item is built. Patrick should confirm or correct them before that item starts.

### 1. Zoom (Figma `171:561`)

**What the frame draws:**
- **Preview:** a dashed brass region with corner handles (`171:576`) and a readout chip above it reading `2.2× · 412×232` (`171:579`).
- **Strip:** a chip (`171:986`, 203×32) above the selected block, containing `2.2×`, a segmented In/Out/Both control, and a red trash icon.
- **Lane:** the selected block is outlined, with edge handles.
- **Inspector rows:** Amount (slider), Ease (In/Out/Both), Starts, Ends, Follow cursor, Draw region, and a red Remove block.

**Restyle:**
- the dashed region and the region readout over the existing `#rectoverlay`/`#overridebox`;
- the selected-block outline and edge handles over the existing `.zoomblock` and `#manualdraft` handles.

**New behavior:** the strip chip, with amount, In/Out/Both and delete.

**Code to reuse:**
- Rect drawing: `#rectoverlay` (editor.html L704), the gesture handlers (`editor.ts` ~L1503–1540) and `rectFromGesture` (`transform/src/zoom-override.ts:308`).
- Blocks: `layoutOverrideBlocks()` (`editor.ts:1195`), `openOverrideEditorUI()` (`:1313`), `commitCurrentEdit()` (`:1334`), `closeOverrideEditor()` (`:1367`), `deleteDerivedWindow()` (`:1385`), `createManualWindow()` (`:1452`) and `onManualHandleDown()` (`:1476`).
- Commit rule: `committedOverrides()` (`app/src/override-edit.ts:80`).
- Label helpers: `zoomAmountLabel` and `formatBlockTime` in `app/src/timeline-activity.ts`.
- Delete: the existing `#overrideclear` path (sets `draftRect = null`, then closes) and `deleteDerivedWindow` (writes `{kind:"removed"}`).

> **DRAFT note: Zoom chip.**
>
> - **Edits:** the selected block's override, through the same draft and commit path as the inspector (`commitCurrentEdit` → `committedOverrides`). Delete reuses `#overrideclear` / `deleteDerivedWindow`.
> - **Saves to the project:** yes, `overrides[]` in project-16. **But In/Out/Both has no field.** `overrides[].easing` is `calm | standard | snappy` (a spring preset), not an ease direction, and the amount is read-only today (`#zoomamount`). The STC-604 runbook §7 lists Ease In/Out/Both and an Amount slider as left out for exactly this reason. Building them needs a project-17 schema bump, a new field (or fields) on geometry and manual overrides, and `render.ts` / `zoom.ts` honouring them. That last part is a `TRANSFORM_VERSION` bump, and `render()` must stay pure.
> - **Tests:** unit tests in `app/test/override-edit.test.ts` and `transform/test/` for the new field, including the migration from project-16. E2E (extend `zoom-override*.e2e.test.ts`): selecting a block shows the chip in `#overlay-strip`; the chip never overlaps the Clip lane's rect; changing the ease writes the project; delete removes the block; a press on the chip near the playhead does not drag the playhead.
> - **Decision needed:** whether In/Out/Both and Amount become real fields here, or whether the chip shows only what exists (amount read-only, delete). See Open questions 1.

### 2. Camera (Figma `171:1066`)

**What the frame draws:**
- the PiP box outlined in clay (`171:1078`, 190×118);
- a readout above it reading `Rounded · 190 · Bottom right` (`171:1082`);
- a small square resize handle at the bottom-right;
- inspector rows Shape, Size, Border, Anchor and Snap to edges.

**Mostly already built (landed in STC-604, `928dd29`):**
- `#pipoverlay` > `.pipbox` > `#piplabel` + `#piphandle` (editor.html L707);
- `layoutPipOverlay()` already shows it only while Camera is active;
- `#piplabel` is `pipSummary()` (`app/src/pip-inspector.ts:47`), which outputs `Shape · width px · Anchor`, the exact format of the frame;
- the resize drag is wired (`pipDrag = target.id === "piphandle"`, `editor.ts:2319`) through `resizeFromCorner()` (`transform/src/pip-style.ts:349`);
- drag and snap use `dragCenter` / `snapCenter` (`pip-style.ts:310`, `:295`), `PIP_SNAP_MARGIN_PX` 32 and `PIP_SNAP_THRESHOLD_SCREEN_PX` 12;
- the anchor comes from `anchorOf()` (`:339`).

**Restyle:** the clay outline, the square handle (today a dot, pip-inspector.css L41), and the readout chip placed above the box in the readout face.

**New behavior:** probably none left. Confirm against the frame.

> **DRAFT note: Camera resize handle and readout.**
>
> - **Edits:** `pip.style.width` (resize) and `center` (drag). The anchor is derived, not stored.
> - **Saves to the project:** yes, `pip.style`, already the case through `editPipStyle`. No schema change.
> - **Tests:** existing `pip-editor.e2e.test.ts` and `transform/test/pip-style.test.ts` cover the drag, snap and resize. Add assertions that the overlay is hidden outside Camera, and that the readout text matches `pipSummary` after a resize.
> - If Patrick agrees this is already done, the Camera item becomes restyle-only. Say so in the ticket rather than dropping it silently.

### 3. Audio (Figma `171:1546`)

**What the frame draws:**
- a red ceiling line across the Audio lane, with a round handle at its right end (`171:2045`);
- red diamond peak markers just above the lane;
- red clipped columns in the waveform;
- a readout chip in the **transport row**, left of Export (`171:2046`): `Ceiling −1 dB` · `18 peaks over` · a red dot;
- inspector rows Limit peaks (switch) and Ceiling (slider, −1 dB) under Cleanup.

**Restyle:** the peak columns. Today `drawAudioLane()` (`editor.ts:840`) draws columns of 3 px red squares where `isClipped` (`CLIP_PEAK = 0.999`, `transform/src/waveform.ts:49`).

**New behavior (all of it):**
- the ceiling line and handle;
- the peak markers relative to the ceiling;
- the "peaks over" count;
- the Limit peaks and Ceiling inspector rows that back them.

**Code to reuse:**
- Waveform: `scheduleWaveform()` (`editor.ts:801`) and `mixPeaks` (`transform/src/waveform.ts`).
- Mix: `mixBlock()` (`transform/src/audio-mix.ts:222`), which hard-clamps at ±1 (L258). `MixPeaks.mix` is measured pre-clamp, so the data for "peaks over the ceiling" is nearly there.
- Lane resize: `#audio-resize` (it already sits in `NOT_THE_PLAYHEAD`).
- Readout: the transport `.readout` / `#clock` (editor.html L748–750, `setClock()` `editor.ts:1895`). `#clock` textContent must stay "current / duration", so the chip has to be a **sibling**, not a child.

> **DRAFT note: Audio ceiling, markers and readout.**
>
> - **Edits:** a new ceiling level in dB, plus a Limit peaks on/off, set by dragging the line or the inspector slider.
> - **Saves to the project:** yes, and it needs a **new field.** Per the STC-605 comment (2026-10-29), making the ceiling a setting means:
>   - a project field (project-17);
>   - a ceiling parameter in the mix, used by export and preview through the same `mixBlock`;
>   - the waveform's clip display reading the ceiling instead of `CLIP_PEAK`.
>
>   Also update the "Clipping: the mix hit its hard limit" titles on `#micclip`/`#sysclip`.
> - **Tests:**
>   - unit tests in `transform/test/audio-mix.test.ts`: the ceiling applies in `mixBlock`; off equals today's ±1 clamp; export and preview match;
>   - `waveform` unit tests: the over-ceiling count;
>   - e2e in `waveform.e2e.test.ts` / `audio-pane-feel.e2e.test.ts`: dragging the handle updates the slider, the count and the project; the line and markers are hidden outside Audio; the readout sits in the transport row and not on the lane.
>
>   The handle must be excluded from the playhead grab.
> - **Note:** this is the largest item. STC-605's comment says that if it isn't built here, "say so and it becomes its own ticket". STC-606's own text says nothing is cut silently, so a split needs Patrick's explicit call.

### 4. Export (Figma `171:2050`)

**What the frame draws:**
- brass in/out bars spanning **all three lanes** (from the strip down through Audio);
- everything outside the range dimmed, including Audio;
- a range readout in the overlay strip (`171:2556`, 172×25): `In 0:02.8  Out 0:44.2  0:41`.

**Restyle:** the trim handles (`#trim-in`/`#trim-out`, today on the Clip lane's `#timeline`) drawn as full-height brass bars.

**New behavior:**
- dimming extends to the Audio lane and the strip; today `updateTrimUI()` (`editor.ts:521`) dims Clip and Zoom only, through `#cut-head`/`#cut-tail` and `#zoom-cut-head`/`#zoom-cut-tail`;
- the range readout chip.

**Code to reuse:**
- `onHandleDown()` (`editor.ts:3345`) for the handles;
- `setTrim()` (`:621`);
- `clampTrimFrame` (`app/src/scrubber.ts:348`), `MIN_TRIM_FRAMES` 2 and the rubber band;
- `transform/src/trim.ts` (`clampTrim`, `exportWindow`);
- the `.trimbar` / `#triminfo` text, which already formats the range.

> **DRAFT note: Export dim and range readout.**
>
> - **Edits:** nothing new. It displays `trim.{startNs,endNs}`, which the existing handles already edit.
> - **Saves to the project:** no new field. The handles keep writing `trim` on release through `persistProject()`.
> - **Tests:** e2e in `scrubber.e2e.test.ts`: the Audio lane and the strip are dimmed outside the range; the readout text equals `#triminfo`'s range; the handles keep the IDs `#trim-in`/`#trim-out`; rules 4–6 of the scrubber (dimmed not fenced, rubber band, two-frame minimum) still hold. Decide whether the full-height bars show only in Export or always (see Open questions 4).

### 5. Frame (Figma `171:78`)

**What the frame draws:**
- a hover tooltip (`171:496`, 120×43) over the Clip lane: `0:33.6` and `2 clicks · 14 keys`;
- a 1 px hairline through all lanes at the hover x;
- inspector rows Style, Colour, Padding, Corners and Shadow, already built in STC-604.

**New behavior:** both the tooltip and the hairline. Nothing like them exists today; the only hover text is native `title`s and `aria-label`s.

**Code to reuse:**
- the timecode format from `formatReadout` / `formatBlockTime`;
- click and key counts from `session.events` and `Session.keys` (`transform/src/keycast.ts`), which hold commands only;
- for the hairline geometry, the playhead's placement in `updateRulerPlayhead()` and the span transform.

> **DRAFT note: Frame hover tooltip and hairline.**
>
> - **Edits:** nothing. It is display only.
> - **Saves to the project:** no.
> - **Tests:**
>   - a unit test for a pure helper, e.g. `countsInBucket(session, startNs, endNs)` in `timeline-activity.ts` (which bucket width counts: one frame, or one tick of the Clip activity?);
>   - e2e: hovering a lane in the Frame section shows the tooltip and hairline, and leaving hides them; nothing shows in other sections; the tooltip never steals the scrub or playhead press (`pointer-events:none`).
>
>   Keys are counted only from commands that already reached disk. Typing never does (STC-419), so the count can't leak it.

## Open questions and risks

1. **Zoom ease In/Out/Both doesn't exist.** The chip and the inspector both draw In/Out/Both, but the model has spring presets `calm | standard | snappy` (`overrides[].easing`). The amount is also read-only. Either:
   - add new fields (project-17, plus a transform change), or
   - map In/Out/Both onto something that exists.

   Settle this before the chip is built.
2. **Audio ceiling is a new feature, not an overlay.** It needs a project field, a mix parameter shared by preview and export, and the clip display reading it. That is the largest piece of STC-606 and touches `render`/export paths. STC-605 parked the decision here.
3. **STC-604 is Done in Linear, but its final comment lists open items.** Patrick's per-section screenshot sign-off is still pending (`docs/STC-604-RUNBOOK.md`), and so is the Zoom section compared with a block selected. The STC-604 and STC-605 runbooks also still name pre-merge branches. If the 604 sign-off isn't done, the overlay screenshots for 606 will be judged against an unsigned pane.
4. **Export handles: frame vs STC-605.** STC-605 kept the trim row under the lanes ("the trim row stays under the lanes, restyled") and the handles on the Clip lane. The Export frame draws full-height bars across all lanes. Do the bars appear only while Export is active, with the Clip-lane handles otherwise? And does `#timeline`'s rect stay the hit area (`getBoundingClientRect` readers)?
5. **Camera may already be done.** Settled: restyle only (see Decisions).
6. **Peak markers: "on the lane" vs the frame.** The frame draws the diamonds just above the Audio lane, in the 8 px gap below Zoom; the ticket says markers stay on the lane. Treat the gap as part of the lane, or move them inside it?
7. **Stale "hatched" peaks.** The `:root` comment in editor.html (L31–33) and the STC-609 ticket-log row say peaks are hatched; the code draws columns of red squares, and the frame matches the squares. Fix the comment while in the file.
8. **Tooltip covers the Clip waveform.** The Frame tooltip in the frame sits over the Clip lane. It is transient, so it is probably fine, but it is the one overlay that breaks the "never cover the waveform" idea.
9. **Open PRs #413 and #414 aren't merged.** #413 touches the Export section rows next to where the Export overlay work goes. Merge or rebase it first to avoid conflicts.
10. **Strip height.** The 36 px exists only in CSS (`.striprow`, editor.html L423), and the chip is 32 px. Consider a named CSS variable so the chip and the strip can't drift.

## Suggested build order

1. **Plumbing:** the `data-section` hook in `selectSection`, the strip's interactive layer (pointer-events opt-in, `NOT_THE_PLAYHEAD` entries) and a strip-height token. Small and test-only, with no project change.
2. **Camera:** restyle and confirm it is done. It is the quickest screenshot, and it validates the gating pattern.
3. **Export:** extend the dimming to Audio and the strip, then the range readout in the strip and the full-height brass bars. No schema change, and the strip chip pattern gets proven here first.
4. **Frame:** the hover tooltip and hairline. Display only, with one new pure helper.
5. **Zoom:** the region restyle, then the strip chip with amount and delete over existing paths, then In/Out/Both and Amount once Open question 1 is decided (which may add a project-17 field).
6. **Audio:** the ceiling field (project-17, shared with Zoom's bump if both land), the `mixBlock` parameter, the waveform reading it, the inspector rows, then the line, handle, markers and transport-row readout.

Do 5 and 6 last because they carry the schema and transform risk. If both need fields, make one project-17 bump, not two.

Before any code: run `npm run ticket -- STC-606`, set the ticket In Progress with branch `accounts/stc-606-editor-build-45-section-overlays`, and work in a worktree (`EnterWorktree`), per CLAUDE.md. At the end, add a `docs/TICKET-LOG.md` row and a `docs/STC-606-RUNBOOK.md` with the screenshot checklist.
