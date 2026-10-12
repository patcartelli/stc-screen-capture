# STC-395 — GIF is an output format chosen at the panel, after recording

Design approved section by section with Patrick, 2026-10-08. Branch
`accounts/stc-395-gif-output`. Builds on STC-488 (#272: a recording's Copy
renders, in a hidden window, into `copiesRoot`) and STC-487 (recordings get
the panel).

## 0. The ticket, and what it left open

You often can't tell whether a take should be a GIF or a video until you've
seen it, so you record once and pick the format on the floating panel. There
is no GIF hotkey and no GIF button on the Record bar. The requirements:

1. A **GIF / Video** toggle on the panel for recordings. It doesn't close the
   panel and it sets the format for Copy and Save.
2. GIF conversion runs after recording, with GIF settings (frame rate, scale)
   applied at conversion time.
3. Progress shows on the panel while converting; Copy/Save wait for it.
4. A non-blocking warning when a GIF is very large.

Decisions made while designing (Patrick, 2026-10-08):

| question | decision |
|---|---|
| What does Save mean in GIF mode? Today Save keeps the take and writes no video at all. | **Keep the take exactly as today, and also write a `.gif`.** Video-mode Save is unchanged. |
| Encoder | **A pure-JS encoder (`gifenc`, MIT) in STC-488's hidden render window.** No ffmpeg: no binary to sign and notarize, no LGPL/GPL, no second pass. gifski was ruled out (AGPL vs PolyForm Noncommercial). |
| GIF settings | **App preferences** (`settings.ts`), defaults 15 fps / 960 px max width, on the profile sheet. The panel gets the toggle and nothing else. |
| When conversion starts | **On flipping to GIF**, so Copy/Save are usually instant. |
| Toggle memory | **Every panel starts on Video.** GIF is chosen after seeing the take, and nothing converts unasked. |
| Large-GIF warning | **The real size after encoding, over 10 MB** (decimal). Never an estimate. |
| Where a saved GIF lives relative to the library | **A plain output file, not the take's finished file** (approach 1, §3). |

## 1. How a GIF is made

**Where.** In STC-488's hidden render window, one window per job.
`copy-render-window.ts`'s job gains `format: "mp4" | "gif"`, which keeps one
job manager, one cancel-by-destroy and one `.partial` + rename write. Progress
is the existing `copy:progress(done, total)`.

**Frames come from the one transform.** The loop at the heart of
`exportSession` (`render()` → `frameAt` → `composite()` onto an
OffscreenCanvas) is extracted into one shared async generator in
`transform/src/export.ts`. The MP4 encoder and the GIF sink both iterate it.
The loop holds the frame-selection rule; a second copy of it would be this
repo's "one value, two copies" defect, and would break the non-negotiable that
sinks may not fork the transform. `gate:export` and `gate:identity` must show
**unchanged hashes** after the extraction.

**Size.** The GIF renders at its own output size, `outputSizeFor(capture,
min(maxWidth, capture width))` from `output-size.ts` (aspect kept, even
dimensions, never upscaled). It renders through a copy of the project whose
`output` is that size, so the cursor and keycast are drawn at GIF scale rather
than downscaled afterwards.

**Rate.** `EXPORT_FPS` is 60 (`time.ts`). A GIF at `fps` takes export frames
`k = 0, N, 2N, …` with `N = 60 / fps`, so every GIF frame is an exact frame of
the export grid. Allowed rates are the divisors that make sense: **10, 12, 15,
20, 30**. GIF delays are whole centiseconds, so 15 fps (6.67 cs) can't be
exact; delays are rounded **cumulatively** (frame `i` ends at
`round((i+1) × 100 / fps)` cs), which at 15 fps gives 7, 6, 7, 7, 6, 7, … and a total that never
drifts from the take's duration. The trim (`exportWindow`) applies exactly as
it does for an MP4.

**Encoder (`transform/src/gif-encode.ts`, pure).**
- **One global palette**, quantized from a sample of frames spread evenly
  across the take. Per-frame palettes flicker, and screen content has few
  colours.
- **Dither only smooth gradients.** The first hardware pass (runbook §2) found
  gradients a little posterized with no dither at all. A pixel whose largest
  per-channel step to a 4-neighbour is small but real (`SMOOTH_MIN <= d <=
  SMOOTH_MAX`, measured on the original frame) and that has no edge
  (`d > SMOOTH_MAX`) anywhere in its 3x3 neighbourhood gets an ordered 4x4
  Bayer offset, equal on R, G and B, before palette indexing. Edges (text,
  icons, borders), the ring beside them (an anti-aliased fringe), flat fills
  and one-level codec noise on a flat fill are never dithered, so they stay
  exactly as crisp and clean as before. `SMOOTH_MIN`, `SMOOTH_MAX` and
  `DITHER_SPREAD` are starting values, to be tuned by eye in runbook §2. Ordered, not error-diffusion (Floyd-Steinberg): diffusion
  carries error from pixel to pixel, so one changed pixel reshuffles its
  neighbours' indices, which shimmers between frames and defeats the
  transparency diff below. The Bayer offset depends only on position and the
  mask only on the 3x3 neighbourhood, so an unchanged pixel in an unchanged
  neighbourhood gets the same index every frame (one beside a moving edge can
  switch for a frame). The palette is still built
  from the undithered frames.
- **Unchanged pixels are transparent** relative to the previous frame (one
  palette slot reserved as the transparent index). On a screen recording this
  is the biggest size saving, since most of the screen is still most of the
  time.
- Loops forever (NETSCAPE2.0 extension).
- Audio is dropped. A GIF has none; no warning needed.

The encoder takes RGBA frames and returns bytes; the canvas readback lives in
the render window, so the encoder is Node-testable.

## 2. The panel

**Where the toggle appears.** Only on a **fresh recording's** panel, the one
place STC-488's recording Copy exists (`panel:copyRecording` refuses anything
outside the temp root). Never on a shot, never on a library re-open (no Save,
no recording Copy there). One predicate, `offersFormat(kind, origin)` in
`panel-actions.ts`, answers it for the renderer, the context menu and main.

**The control.** A two-segment `Video | GIF` switch. It never closes the
panel and always starts on **Video**. The panel has had no auto-dismiss timer since STC-392, so nothing can close it mid-encode except Trash, dismiss or quit — each of which cancels the job.

**States (`app/src/gif-panel.ts`, a pure reducer, no DOM):**

| state | shows | Copy / Save |
|---|---|---|
| `video` | nothing extra | STC-488 Copy (mp4 render) / keep the take, as today |
| `converting` | progress, `GIF 42%` | pressing either **waits**: the button shows it's pending and fires when the job settles |
| `ready` | size, `GIF · 3.4 MB` | Copy puts the cached `.gif` on the clipboard as a file URL; Save keeps the take and writes the `.gif` |
| `ready`, over 10 MB | `GIF · 14 MB — large for a GIF; Video is smaller`, in the warning colour; never blocks | as `ready` |
| `failed` | `GIF failed — <reason>`, with the switch back to Video | disabled in GIF mode; flipping back to Video restores them |

**Transitions.** GIF → Video while `converting` **cancels** the job (window
destroyed, partial removed). Video → GIF starts a job, or goes straight to
`ready` when the cached file matches the current settings (§3).

**With STC-488's Video Copy.** A take has at most one render at a time.
While a Video Copy renders, the switch is disabled: that job can't be
cancelled without losing a Copy someone asked for. While a GIF converts,
Video-mode Copy is unreachable, since you'd flip back first and that cancels
the GIF. `lockedWhileCopying` covers the GIF job too, so Edit waits on it as it
waits on an mp4 copy, and Trash, dismiss and quit cancel it the same way
(quit bounded by `COPY_CANCEL_AT_QUIT_MS`).

**Save in GIF mode, in order:**
1. Wait for `ready`.
2. Promote the take (`promoteIntoLibrary`, unchanged).
3. Copy the cached `.gif` to `<save folder>/<take name>.gif`, unique-named if
   that exists, through `.partial` + rename.
4. Toast: `Saved GIF · Show in Finder`.

If step 3 fails after step 2 succeeded, the take is kept and the toast says
so: `Saved the take; the GIF couldn't be written: <reason>`. A take is never
lost because its GIF failed.

**Copy in GIF mode** puts the `.gif` on the pasteboard as an NSURL through the
helper's existing `copy-file`, as STC-488 does for the mp4. Copy doesn't
promote the take.

## 3. Files, cache, purge, settings

**The cache.** `copiesRoot/<take leaf>.gif`, written through `.partial` +
rename beside STC-488's `<take leaf>.mp4`. The name is what a paste shows, so
no settings are encoded in it.

**Reuse.** Main records `{ path, fps, maxWidth }` per take in memory. Flipping
to GIF reuses the file only when that record matches the current settings;
otherwise it re-renders and overwrites. A restart forgets the record, so the
next flip re-renders.

**Settings are read once, when a conversion starts.** Changing a setting never
re-renders a GIF that is already `ready` on an open panel.

**Purge.** `purgeDecision` (`recording-copy.ts`) learns `.gif` and
`.gif.partial` beside `.mp4`, with the same rules: 24 h from the render, the
clipboard's file spared, a partial older than an hour removed, nothing deleted
when the clipboard can't be read. STC-488's hourly timer covers both.

**The saved file is not the take's finished file.** Since STC-413 the save
folder's top-level finished files each carry an embedded id pairing them with
exactly one bundle in `raw/`, and the editor's Export overwrites that one file.
A saved GIF is written **untagged**, and `.gif` stays outside
`MEDIA_EXTENSIONS`. So:
- the library, Reclaim and the editor's Export are unchanged;
- Export can never overwrite a GIF;
- Reclaim never reads a GIF as proof a bundle was exported;
- the GIF has no tile of its own. You find it in Finder, and the Save toast
  links there.

Two tests pin `.gif` as neither a library media type nor a Reclaim blocker, so
adding it to `MEDIA_EXTENSIONS` fails loudly and points at the alternative:
making the GIF the take's finished file (one file per bundle, so a later MP4
export would retire it). That alternative, and multiple finished files per
bundle, are out of scope here.

**Settings.** `settings.ts` gains `gif: { fps, maxWidth }`, default
`{ fps: 15, maxWidth: 960 }`, validated on read; an unknown value falls back
to the default.
- `fps` ∈ {10, 12, 15, 20, 30}
- `maxWidth` ∈ {480, 640, 960, 1280, "original"}. `"original"` is the
  capture's own width, still through `output-size.ts`.

The profile sheet gets one "GIF" row beside the still-capture preferences,
with two compact selects: *Frame rate* and *Max width*.

**The threshold.** `GIF_LARGE_BYTES = 10_000_000` (decimal, so it matches what
Finder shows), in `gif-panel.ts` beside the warning sentence and the size
formatting.

## 4. Tests, gates, runbook

**Unit (`npm test`):**
- `gif-encode`: synthetic RGBA frames in, bytes out, decoded with `omggif`
  (MIT, dev dependency only). Asserts the `GIF89a` header, size, loop
  extension, frame count, the delay total against the duration, one global
  palette of at most 256 colours, transparency on unchanged pixels, and
  decoded pixels matching the input within the palette's error.
- Timing: cumulative delays (15 fps gives 7, 6, 7, 7, 6, 7, … — frames end at 7, 13, 20 cs; the total never
  drifts); an fps that doesn't divide `EXPORT_FPS` is refused.
- Size: even, aspect kept, never upscaled, `"original"` at the take's own
  size.
- `gif-panel` reducer: every row of §2's table; the threshold boundary
  (10,000,000 doesn't warn, 10,000,001 does); `offersFormat` true only for a
  fresh recording.
- `purgeDecision`: `.gif` and `.gif.partial` rows.
- Settings: valid values round-trip, invalid ones fall back to 15 / 960.
- The drift guard: `.gif` is not a library media type, not a Reclaim blocker.

**Gates (real Chrome):** `npm run gate:export` and `gate:identity` show
unchanged hashes after the loop extraction. New `scripts/gif-one.mjs
<sessionDir>`, on `export-one.mjs`'s model, writes a GIF to look at and prints
the encode time and size.

**E2E (`app/test/gif-panel.e2e.test.ts`),** on a fixture take's panel:
- flip to GIF → progress → `ready` with the size shown;
- Copy puts `copiesRoot/<take>.gif` on the clipboard (asserted as STC-488's
  e2e does);
- Save promotes, writes `<take name>.gif` to the save folder, shows the toast;
- flipping back mid-encode cancels and leaves no partial;
- Trash mid-encode cancels.

Run in the Tart VM first (`docs/VM-TESTING.md`), then on CI.

**De-risk first.** The plan's first task measures gifenc's quantize + encode
speed at 960 px on the fixture and on one real take, before any panel UI. If a
one-minute take converts too slowly, the defaults or the approach change then.

**Runbook (`docs/STC-395-RUNBOOK.md`),** naming its branch:
- pasting into Slack, a GitHub comment, Messages and Mail;
- how text-heavy UI and a gradient look at the default settings;
- the conversion time of a one-minute 4K take;
- the warning's wording on a long take;
- that the panel stays put during an encode.

**Docs:** a `docs/TICKET-LOG.md` row and `CLAUDE.md` table rows for
`gif-encode.ts`, `gif-panel.ts` and the runbook.

## 5. Out of scope

- A GIF tile in the library, renaming a GIF in the app, and multiple finished
  files per bundle (§3).
- GIF from the editor's Export dialog. This ticket is the panel.
- Per-take GIF settings, a sticky toggle, a size estimate before encoding.
- The toggle on a library re-open's panel (no recording Copy there; STC-488).
