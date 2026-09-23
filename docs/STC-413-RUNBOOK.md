# STC-413 runbook — what only a Mac with real captures can settle

The library is a view over a user-chosen folder now: finished captures are
plain files at the top level, source bundles live in `raw/`, and each finished
file carries an opaque id in its own bytes so a rename or move in Finder cannot
break the link back to its source.

Everything below was written on this machine and is verified as far as unit and
e2e tests can reach. What is left needs real captures, a real folder, and eyes.

Run the sections in order — §1 produces the material §2-§6 need.

## Status, 2026-09-23

| § | what | state |
|---|---|---|
| §1 | record and export three takes | **needs a person** |
| §2 | does the folder read as browsable | **needs eyes** — no test can answer it |
| §3 | rename in Finder | **needs a person** (and now a HEIC too) |
| §4 | QuickTime, Slack/Mail preview | **needs a person** |
| §5 | the IO half of the scan | **RUN — measured, see below** |
| §6 | migration from a pre-STC-413 folder | **RUN — passes, both cases** |
| §7 | the sweep | superseded — being replaced, STC-435 |
| §8 | gates and grant-only tests | **RUN — `gate:identity` PASS** |

§§5, 6 and 8 were run without a person because this machine had the material
for them: one real 46 MB take, and a save folder that is itself a genuine
pre-STC-413 layout. §§1-4 cannot be — they need a capture made now and a
judgement about how it looks.

---

## §0 First, the one thing that makes the rest meaningful

Point the save folder at a folder you would **actually use** — a project
folder, something in Dropbox, not an empty scratch directory. Half of this
ticket's open questions are about how the folder feels when it has other things
in it, and an empty folder answers none of them.

Settings → Save folder.

---

## §1 Record and export three takes

One short (~10 s), one **over two minutes**, one with the camera on.

The long take is not padding. `moov` grows ~11-14 bytes per sample, so it
passes 64 KB at roughly 4,600-5,800 samples — **80-95 s at 60 fps**. A bug
here cost this branch a Critical, and takes shorter than that never reach it.

Then take two stills: one full-screen, one window.

**What each must show**

- Five items in the library, no duplicates. **Two tiles for one capture is the
  failure mode this ticket exists to prevent** — if you see it, note which
  capture and stop.
- Each exported file sits at the TOP LEVEL of your folder, not inside a
  subdirectory.
- `raw/` holds one bundle per capture.

---

## §2 The thing no automated test can check: does the folder read as browsable?

Open the save folder in Finder and look at it.

- Do the captures read as files you could send someone, or as machine debris?
- Does `raw/` read as "source material I can ignore", or as clutter?
- With your other files in there, is the capture set still findable?

This is the ticket's whole premise and there is no test for it. If the answer
is no, say so — the layout is cheaper to change now than after anyone relies
on it.

---

## §3 Rename in Finder — the headline promise

Rename an exported file to something meaningful (`login-bug.mp4`). Then:

1. Reopen the app. The tile's title must be **`login-bug`**, not the timestamp.
2. Open it in the editor. It must load — that proves the id in the bytes found
   its bundle.
3. Re-export it. It must **overwrite `login-bug.mp4`**, not create a second
   `<stamp>.mp4` beside it.
4. Rename a **still** the same way and repeat 1-3.

Step 4 is called out because stills go through an entirely different writer
(ImageIO → XMP in an `iTXt` chunk, not the MP4 `uuid` box). It was broken for
every still until the final review caught it, so it deserves its own check
rather than being assumed to follow from the video case.

**A HEIC is a third writer path again** and was broken for the same reason
until 2026-09-23 — the bytes carried the id, and `library.ts` dispatched a
reader only for `.mp4` and `.png`. If you can produce one (`still.format` in
`settings.json`; there is no UI for it), run steps 1-3 on it too. A JPEG will
still fail step 1 and that is expected — STC-440.

---

## §4 QuickTime — a file that parses is not a file a player accepts

Open a tagged export in QuickTime and watch a few seconds.

The id is appended as a trailing top-level `uuid` box. Conforming readers skip
unknown top-level boxes, and the box is spec-legal — but this repo does not
make claims about software it has not run. Task 3 already paid a fix round for
a trailing-box mistake that every in-module test passed.

Also drag one into Slack or Mail and confirm it previews.

---

## §5 The IO half of the scan measurement — **RUN 2026-09-23, and the answer is a real number**

`app/test/library-scan.test.ts`'s 500-file test pins **per-file overhead** —
`readdir`, open, header parse, id extract — on ~300-byte fixtures, where the
64 KB tail read is really a whole-file read and every block is already cached.

Measured against **500 byte-distinct copies of a real 46 MB take** (23 GB
total, deliberately more than the page cache will hold, so the first pass is
genuinely cold-ish; APFS clones were rejected because shared extents would
have made all 500 reads hit the same physical blocks and measured nothing):

| | total | per file |
|---|---|---|
| synthetic fixtures, in-suite | 129-156 ms | 0.26-0.31 ms |
| **500 real exports, first pass** | **1,551-1,655 ms** | **3.10-3.31 ms** |
| 500 real exports, repeat | 91-101 ms | 0.18-0.20 ms |

Two runs, consistent to within 7%.

**So the IO half is real and is ~10x the per-file cost the fixture test
measures.** That is the honest answer to the question this section asked, and
it is the number to reason from.

What it does and does not mean:

- **The 4000 ms in-suite backstop is not at risk.** It guards the *fixture*
  test, which still runs at 129-156 ms — 25x headroom, unchanged.
- **A cold 500-capture library takes ~1.6 s to open.** That is not "instant".
  It is a one-time cost per cold cache and drops to ~0.1 s warm, which is why
  this is recorded rather than filed as a bug — but if a spinner is ever
  wanted anywhere, this is where.
- Measured on a fast local SSD. A network or spinning-disk save folder would
  be worse, and nothing here has tested one.

---

## §6 Migration — an existing folder must still work — **RUN 2026-09-23, PASSES**

Point the save folder at a pre-STC-413 folder, one with `<stamp>/` directories
at the top level.

- Every old take still lists.
- One with a buried `export-*.mp4` lists as **finished** and Share does not say
  "not exported yet".
- Nothing moved on disk. Migration is non-destructive by design; if anything
  was relocated, that is a bug.

**Run against this machine's own `~/Desktop/stc`** — a genuine legacy folder
(one `2026-09-23_10-27-09/` bundle at the top level, no `raw/`, no
`capture.json`), copied first so the only real take was never at risk. Every
fixture in the suite was *authored* to look like this; none of them **is** one.

```
items: 1, invalid: 0
  id=2026-09-23_10-27-09  badge=Recording  dir=/2026-09-23_10-27-09  file=(none)
    summary: 0:13 · 3326×2160 · 414 events · 57.5 MB
    actions: open, rename, reveal, delete
```

- Lists, with correct facts read from the real container.
- **Byte-identical file snapshot before and after** — same names, same sizes,
  nothing added. The scan is a read.
- A stray `.DS_Store` was present and correctly ignored: not an item, not an
  `invalid` entry. No fixture has one.

The buried-export bullet needed CONSTRUCTING, because this take was never
exported — an `export-<stamp>.mp4` was placed inside the bundle on a second
copy. It lists as **one** item pointing at the buried file
(`file=…/export-2026-09-23_10-27-09.mp4`, size 103.6 MB, i.e. the bundle plus
the export), so Share has something to share. STC-413 I2's promise holds.

Still unrun: a legacy folder with a legacy **still** bundle (`shot.json`), and
one large enough to hold many old takes at once.

---

## §7 The sweep — **superseded, being replaced (STC-435)**

The question below was answered by deciding rather than by waiting a week: the
automatic sweep is being replaced by a user-initiated "Reclaim space" that
shows what it would remove. Filed as STC-435. The observation that prompted it
stands and is worth keeping:

`sweepOrphanedBundles` reclaims `raw/` bundles whose finished file is gone.
It is deliberately conservative: it does nothing at all unless **every**
top-level media file yielded a readable id.

In a real folder that almost certainly means it **never fires** — one
⇧⌘4 screenshot or downloaded image is enough to block a pass.

So the honest check is: after a week of use, has `raw/` reclaimed anything? If
not, that is the design working as specified, and the open question is whether
an automatic timer is the right shape at all, or whether this should be a
user-initiated "Reclaim space" that shows what it would remove.

---

## §8 Gates and grant-only tests — **RUN 2026-09-23**

```
npm run test:capture     # needs a Screen Recording grant
npm run gate:identity    # the transform's pixel fingerprint
npm run test:slow
```

`gate:identity` is the one to care about. This branch does not change what
`render()` draws, but it does change `export.ts`'s buffer handling, and the
gate is the only thing that proves two independent exports still agree.

**`gate:identity` — PASS**, against this machine's own real take
(`2026-09-23_10-27-09`, 3326×2160, camera on):

```
60 sampled t across 788 output frames
export order: ascending    preview order: shuffled
mismatches: 0
seeking source: peak buffered 9, decoder generations 55
camera track present: true
PiP: 51 of 60 sampled frames have one, drawn on 51
zoom: 2 sampled frame(s) meaningfully zoomed
IDENTITY GATE: PASS
```

Not a vacuous run: the PiP and the zoom crop were both asserted to actually
change pixels, so the take exercised the paths rather than merely having them
available.

**`npm run test:capture` — 28 passed, 4 environment failures, none a
regression.** Three are `tools/test-host/STCTestHost.app` missing, which is an
artefact of running from a **git worktree** (the signed bundle is built in the
main checkout and was verified present there); the fourth is `SKIP-DISPLAYS`
on a one-display machine, STC-247's own honest refusal. Re-run from the main
checkout to cover the three, and see CLAUDE.md on why the test deliberately
does not auto-build it (codesign can block forever on a hidden dialog).

**`npm run test:slow` — 3 passed, 2 files, 83 s.** The cross-implementation
export identity check (the app's Electron against the CLI's Chrome) agrees.

---

## Known limitations, stated rather than discovered later

- **A JPEG still carries no readable id — and that is now the ONLY format that
  does not** (measured 2026-09-23; see STC-440). Encoding one buffer three
  times through the real helper with the same id: PNG carries it, **HEIC
  carries it**, JPEG does not. `kCGImagePropertyPNGDictionary` reads as
  PNG-only and is not — ImageIO normalises the description into XMP and HEIF
  carries XMP as an item. So a JPEG lists as a loose file while its bundle
  lists separately. **The HEIC half is CLOSED**: `readHeicCaptureId` +
  `library.ts`'s `.heic` dispatch arm. §3 step 4 is worth running for a HEIC
  as well as a PNG.
- **A corrupt `capture.json`** on a capture that was already exported leaves
  two tiles until one is deleted. The app warns on stderr. Refusing to export
  instead would cost a take over a bookkeeping file. Filed as STC-436.
- **The 4000 ms scan backstop is calibrated on one Mac**, measured inside the
  full suite (227-748 ms). CI's runner is slower and has never run it. Read the
  printed `ms/file` before changing the number. It guards the FIXTURE test and
  is unaffected by §5's real-file measurement — the two are different
  quantities and must not be compared, which is the mistake STC-383 already
  paid for one gate over.
