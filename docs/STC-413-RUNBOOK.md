# STC-413 runbook — what only a Mac with real captures can settle

The library is a view over a user-chosen folder now: finished captures are
plain files at the top level, source bundles live in `raw/`, and each finished
file carries an opaque id in its own bytes so a rename or move in Finder cannot
break the link back to its source.

Everything below was written on this machine and is verified as far as unit and
e2e tests can reach. What is left needs real captures, a real folder, and eyes.

Run the sections in order — §1 produces the material §2-§6 need.

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

---

## §4 QuickTime — a file that parses is not a file a player accepts

Open a tagged export in QuickTime and watch a few seconds.

The id is appended as a trailing top-level `uuid` box. Conforming readers skip
unknown top-level boxes, and the box is spec-legal — but this repo does not
make claims about software it has not run. Task 3 already paid a fix round for
a trailing-box mistake that every in-module test passed.

Also drag one into Slack or Mail and confirm it previews.

---

## §5 The IO half of the scan measurement

`app/test/library-scan.test.ts`'s 500-file test pins **per-file overhead** —
`readdir`, open, header parse, id extract — on ~300-byte fixtures, where the
64 KB tail read is really a whole-file read.

Against 500 real 4K exports the same scan does roughly **32 MB of scattered
IO** on top of that, and none of it is exercised.

To settle it: put a few hundred real exports in a folder (copies are fine —
copy one export 300 times under different names) and open the library. It must
feel instant. If it does not, the fix is the probe strategy, not the backstop.

---

## §6 Migration — an existing folder must still work

Point the save folder at a pre-STC-413 folder, one with `<stamp>/` directories
at the top level.

- Every old take still lists.
- One with a buried `export-*.mp4` lists as **finished** and Share does not say
  "not exported yet".
- Nothing moved on disk. Migration is non-destructive by design; if anything
  was relocated, that is a bug.

---

## §7 The sweep, if it survives review

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

## §8 Gates and grant-only tests

Not run on the machine this was built on:

```
npm run test:capture     # needs a Screen Recording grant
npm run gate:identity    # the transform's pixel fingerprint
npm run test:slow
```

`gate:identity` is the one to care about. This branch does not change what
`render()` draws, but it does change `export.ts`'s buffer handling, and the
gate is the only thing that proves two independent exports still agree.

---

## Known limitations, stated rather than discovered later

- **A JPEG still carries no readable id.** ImageIO writes the id into the PNG
  dictionary only. A JPEG export is therefore never matched to its bundle: it
  lists as a loose file and its bundle lists separately. HEIC, unexpectedly,
  *does* carry the id — that half is closable cheaply if wanted. The standing
  alternative is making stills PNG-only, which dissolves this entirely.
- **A corrupt `capture.json`** on a capture that was already exported leaves
  two tiles until one is deleted. The app warns on stderr. Refusing to export
  instead would cost a take over a bookkeeping file.
- **The 4000 ms scan backstop is calibrated on one Mac**, measured inside the
  full suite (227-748 ms). CI's runner is slower and has never run it. Read the
  printed `ms/file` before changing the number.
