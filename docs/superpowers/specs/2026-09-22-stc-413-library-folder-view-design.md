# STC-413: Library as a view over a folder — design

The library stops being a store the app owns and becomes a view over a
user-chosen folder on disk. The folder is the source of truth; the app layers on
what Finder cannot show.

Brainstormed 2026-09-22. STC-412 shipped as `a8d0c99` (#197), so this ticket's
stated blocker — *"waits for STC-412 to fully ship"* — is cleared, and
`settings.saveFolder` is the folder this design reads.

---

## Two deviations from the ticket, decided live

Both were taken deliberately in the 2026-09-22 session and should be pushed back
to Linear so the ticket does not contradict what ships.

**1. Metadata is EMBEDDED in the media file, not carried in a sidecar.** The
ticket's `Scope decided (2026-09-21)` says *"a new dedicated sidecar type for
library metadata, versioned like `changes-1`/`zoom-1`"*. That was reversed after
a tension surfaced: **Obsidian does not actually use sidecars.** Its metadata is
frontmatter *inside* the `.md` file, which is why it survives being moved —
there is only one object. A sidecar is a second object, so the ticket's own
stated reason for preferring sidecars over an index ("sidecars survive the user
moving, renaming, or reorganizing files in Finder") holds only if the user moves
both halves. Embedding is the faithful analogue of frontmatter and is the only
option that survives rename, move and sync unconditionally.

**2. `take.json` / `setTakeLabel` is retired for finished captures.** The
filename *is* the label. Renaming `2026-09-22_14-30.mp4` to `login-bug.mp4` in
Finder renames the capture. One name, one place, editable from either side.

---

## What the folder looks like

```
~/Desktop/stc/
├── login-bug.mp4                  finished recording — filename is the label, id embedded
├── 2026-09-22_14-33-02.mp4        finished, never renamed → default is the stamp
├── error-state.png                finished still, id embedded
├── holiday-clip.mp4               foreign file — listed, reduced metadata, no "Edit again"
└── raw/
    └── 2026-09-22_14-30-01/       the bundle behind login-bug.mp4
        ├── anchors.json           + id
        ├── display.mp4            raw, cursorless — source, never the deliverable
        ├── events.json            pointer track
        ├── project.json           trim / zoom — re-editable
        └── thumb.png              grid cache
```

**Three rules carry the design.** Every library signal falls out of one of them:

- **Top level means finished.** A file up there is a deliverable.
- **The filename is the name.** No label sidecar.
- **`raw/` holds source material.** Bundles the app owns.

### Why a recording cannot be one file

The pointer does not exist in the captured pixels — `showsCursor` is off by
design and the transform draws the cursor from `events.json` at export time. So
`display.mp4` + `events.json` + `anchors.json` is an irreducible bundle, and the
only genuinely double-clickable recording artifact is the **export**.

Flipping `showsCursor` on in the helper is not an escape: the synthetic pointer
carries click highlights, cursor scale and auto-zoom, so a baked-in hardware
cursor would either double-draw in the export or cost those features outright.

This is why the model is *"top level = finished"* rather than *"one file per
capture"*. An unexported recording is raw material, and saying so is honest.

### Why this is smaller than it looks

The still path **already works this way**. `still-io.ts`'s `destinationDir`
returns `saveFolder` directly for a save, so still exports already sit flat at
the top level, beside the bundle directories. Today's folder is simply
inconsistent — a still's deliverable is already flat, a recording's is buried at
`<stamp>/export-<stamp>.mp4`. This design finishes a split half the codebase
already made.

---

## What gets embedded: one immutable id

Walking the ticket's own "metadata worth carrying" against this layout collapses
nearly all of it:

| Wanted | Where it comes from | Works for foreign files? |
|---|---|---|
| Duration, dimensions | **Intrinsic** — read from the container header | yes, free |
| Capture kind | **The extension** — `.mp4` recording, `.png`/`.heic` still | yes |
| Edited status | **Location** — top level means finished | yes |
| Link back to the raw bundle | **Not derivable.** The only app-exclusive fact | no — degrades |

So exactly one thing is embedded: **a stable, opaque source id**, written once at
export, never rewritten. This kills both costs that normally make embedding
expensive:

- **No per-edit rewrite.** The id is immutable, so changing trim or zoom never
  touches the finished file.
- **Clean privacy degrade.** If `stripMetadata` suppresses it, the file still
  lists with full duration and dimensions — it just loses "Edit again".

**Format:** `cap_<26-char Crockford base32>`, a ULID-shaped opaque token. No
timestamp, no path, no user data. Versioned by a `v` field in the embedded
payload so a future format change is readable rather than ambiguous.

**Write seams — both already exist:**

- **PNG** — `helper/src/StillEncode.swift:225` already passes a properties
  dictionary to `CGImageDestinationAddImage`. The id becomes one key, written as
  a `tEXt` chunk.
- **MP4** — `transform/src/export.ts:340` already holds the entire file as an
  `ArrayBuffer` before writing. The id is appended as a top-level ISO-BMFF
  `uuid` box. Readers skip unknown top-level atoms, and because it goes at the
  **end**, there are **no chunk-offset fixups** — `stco`/`co64` entries point
  into `mdat`, which does not move. No in-place file patching, no dependency.

---

## Components

Five units, each understandable and testable alone.

### 1. `transform/src/capture-id.ts` — pure

Mints, formats and validates a capture id. No IO, no format knowledge, no DOM,
no node. Exists as its own module so both the id's shape and its validation have
exactly one owner — this repo's most-repeated defect is one value with two
copies.

### 2. `transform/src/media-tag.ts` — pure, `Uint8Array → Uint8Array`

Reads and writes the id in an MP4 (`uuid` box) or a PNG (`tEXt` chunk). Pure
buffer transformation with no DOM and no node, so it typechecks in all three
passes and is unit-testable without a browser or a Mac — which matters, because
the Swift half cannot be run on most checkouts.

Round-trip and tamper tests live here: write then read must be the identity, and
a truncated or corrupt box must return "no id" rather than throw. A malformed
tag is a file with reduced metadata, never a crash.

### 3. `transform/src/media-probe.ts` — pure

Duration and dimensions from **header bytes only**, never a whole file. This is
the constraint that keeps a 500-file scan affordable:

- **PNG** — `IHDR` is the first 24 bytes. Trivial.
- **MP4** — needs `mvhd`, inside `moov`. `AVAssetWriter` and `mp4-muxer` both
  put `moov` at the **end**, so the probe tail-reads ~64 KB and falls back to a
  front walk if `moov` is not found there (a remuxed or faststart file).

Returns `undefined` rather than throwing for anything it cannot parse — a file
it does not understand is still a file worth listing.

### 4. `app/src/library.ts` — rewritten scan

One pass over the folder (media files by extension → finished items) plus one
over `raw/` (bundles → unfinished items), merged into the **existing**
`LibraryItem` contract.

`library-items.ts`, `library-view.ts` and the no-view-branches-on-kind seam are
**untouched**. The adapter boundary STC-294 built is exactly what lets the
storage model change underneath it, and `library-seam.test.ts` keeps holding the
line for free. If a new state needs expressing, WIDEN the adapter interface
deliberately — do not special-case at the call site.

### 5. Two writers

- `helper/src/StillEncode.swift` — one key added to the dictionary it already
  passes.
- `transform/src/export.ts` — tags the buffer it already holds, then writes to
  the top level instead of inside the bundle.

---

## Data flow

```
capture  →  bundle written to raw/<stamp>/, id minted into anchors.json / shot.json
export   →  media file at TOP LEVEL, id embedded in the bytes
scan     →  top-level media files (finished) + raw/ bundles (unfinished) → one list
"Edit"   →  read id out of the file → find its bundle in raw/ by id
            ↳ works however the file has been renamed or moved
            ↳ no id (foreign / stripped) → listed, reduced metadata, no Edit
            ↳ id present but bundle gone → listed, reduced metadata, no Edit
```

Both failure paths degrade to the same well-defined state the ticket already
blessed for no-sidecar files. There is no path where a capture vanishes.

---

## Migration: nothing moves

The scanner accepts a bundle in **either** position — `raw/<stamp>/` or a legacy
top-level `<stamp>/` — by the same test it already uses (`anchors.json` →
recording, `shot.json` → still). New captures write to `raw/`; existing folders
keep working untouched on day one.

A legacy bundle holding an `export-*.mp4` lists as finished, pointing at the
buried file. Re-exporting lands it at top level.

No batch move, no "tidy my folder" step, nothing lost on a downgrade. The cost
is stated rather than hidden: a folder that predates this ticket keeps its old
shape until each take is re-exported, so the Finder-browsability win arrives
per-capture rather than all at once.

---

## Lifecycle: two objects, one capture

**In-app Delete removes both**, to the Trash — the finished file and its bundle
together. One capture, one action.

**Finder deletes orphan the bundle**, and `raw/` gets a sweep reusing STC-393's
purge shape — but with one correction that matters.

The sweep condition is **orphaned AND aged**, never aged alone.
`purgeStaleTempTakes` derives a take's age from its own directory *name*
(`temp-takes.ts:150`), which is right for transient temp takes and wrong here:
applied naively to `raw/`, the bundle behind a capture made eight days ago would
be swept while its finished file still sits at top level. The file survives and
silently stops being editable — which contradicts the whole point of keeping the
bundle. So:

- A bundle is **orphaned** when no top-level media file carries its id. The scan
  already reads every id, so this costs nothing extra.
- An orphaned bundle is removed once it is also older than the threshold.

Requiring both is safer than either alone: a file temporarily moved out of the
folder does not lose its source on the next scan, because the age clock gives it
a grace period. And reaping is deliberately **not** done at scan time on orphan
status alone — a read operation must not delete data.

Finished top-level files are **never** touched by the sweep. Cost, stated
plainly: re-editability of a capture you deleted in Finder expires after the
threshold.

---

## Knock-on changes

| File | Why |
|---|---|
| `app/src/share.ts` | `planPublish` builds `from: join(takeDir, exportMediaName(name))`. The export moves to top level, so that path is wrong. Update with its grep test. |
| `app/src/takes.ts` | `newTakeDir` targets `raw/`. `setTakeLabel` retired for finished captures. `insideTakesRoot`'s traversal and sibling guards now apply one level deeper — both tests still hold, verify rather than assume. |
| `app/src/temp-takes.ts` | `promoteTake` lands in `raw/`, not the root. |
| `app/src/main.ts` | `TAKE_FILES` allowlist and the take-dir handlers resolve through `raw/`. |
| e2e fixtures | ~24 files set `STC_RECORDINGS_DIR`; those asserting on directory layout need restating to the new shape, not loosening. |

---

## Open decisions

1. **Does `stripMetadata` suppress the id?** The id is opaque — no timestamp, no
   path, no user data — so it leaks nothing STC-293 was protecting. Recommend
   **exempting** it, so a privacy-stripped export stays editable. Needs
   confirming before implementation.
2. **`raw/` as a name.** Visible and honest, which suits "nothing locked in the
   app". A user who already has a folder called `raw` in their save folder
   collides with it. Accepted as an edge case; `.stc-raw` is the alternative if
   it proves real.
3. **Default export filename.** Recording exports become `<stamp>.mp4`, dropping
   the `export-` prefix — location now says "finished", so the prefix is
   redundant. Stills keep their existing `{app} {date} at {time}` template.
   Worth confirming the two defaults are allowed to differ.
4. **Orphan grace period.** The sweep needs to know how long a bundle has been
   orphaned, and "age from the directory name" measures something else — a
   bundle orphaned yesterday may have been created months ago. Simplest honest
   mechanism is to stamp the bundle with a marker the first time it is observed
   orphaned, and sweep on that. Alternative is to accept creation-age as a proxy
   and set the threshold long. Needs deciding before implementation; the
   suggested default is STC-393's 7 days measured from the orphan marker.

## Suggested phasing

The work splits cleanly and each half is independently shippable:

- **Phase 1 — the id and the tag.** `capture-id.ts`, `media-tag.ts`,
  `media-probe.ts`, plus the two writers. Entirely pure except the writers, and
  verifiable without changing where a single file lands.
- **Phase 2 — the layout.** `raw/`, the scan rewrite, migration coexistence,
  delete semantics and the sweep. Depends on phase 1 for identity.

---

## Explicitly out of scope

- **Hover-scrub on recording thumbnails.** Deferred by the ticket's own scope
  decision.
- **Auto-export on clean stop.** Considered and rejected: export measured at
  1.52x realtime, so a 5-minute take would pin a core for ~7.5 minutes after
  every stop, and it commits trim and zoom before the user has decided either.
- **Batch migration of existing folders.** Non-destructive coexistence instead.
- **A central index.** Rejected by the ticket and by this design.

---

## Testing

**Pure, runs everywhere:**

- `media-tag` round-trip for both formats; corrupt and truncated tags return "no
  id" rather than throwing. Mutation: a tag writer that silently no-ops must
  fail the round-trip test.
- `media-probe` against committed fixtures, including a file it cannot parse.
- `capture-id` format and validation.
- `library.ts` scan against a temp folder: finished files, foreign files, legacy
  top-level bundles, `raw/` bundles, and a bundle with no finished file — one
  case per row of the flow table above.

**Needs Electron (e2e):** delete removes both objects; a renamed file still
opens its bundle; a foreign file lists without an Edit affordance.

**Needs a Mac:** the PNG `tEXt` key actually surviving `CGImageDestination`, and
a tagged MP4 still opening cleanly in QuickTime — the `uuid` box is spec-legal
and skipped by conforming readers, but this repo does not make claims about
software it has not run.

**Measured, not assumed:** the 500-file scan. STC-294's own acceptance criterion
is 500 takes; the probe strategy above is designed for it but the number has to
be observed.
