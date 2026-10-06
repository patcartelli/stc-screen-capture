# STC-477 runbook — the still editor's export, on a P3 Mac

**Branch:** `accounts/stc-465-still-editor-export-fix` (PR #245) until it merges, then `master`.
§2 also uses `origin/master` as it was BEFORE this merged, as the control.

```
git fetch origin
git checkout accounts/stc-465-still-editor-export-fix
npm ci
```

If git says the branch "is already used by worktree at …", an agent's worktree
holds it: `cd` there and run everything from that folder instead (`npm ci`
there too — a fresh worktree's `node_modules` is empty, and would otherwise
quietly borrow your main checkout's).

**Keep a copy of this file open somewhere else before §2.** It exists only on
this branch until it merges, and §2 checks out the pre-fix build, which does
not have it (or the compare script — §2 switches back before running that).

## What this settles, and what CI already did

The still editor ("Redact") exported through its own copy of "composite, then
export", and that copy had drifted from the post-capture panel's:

- it ignored the output-scale preference (a `1x` save came out at native size), and
- it composited on an untagged, sRGB canvas while the file was still tagged
  Display P3 — so saturated colour came out wrong on a P3 screen.

CI proves the canvas now **asks** for `display-p3` and that a `1x` Save halves
the size (`redaction.e2e.test.ts`). It cannot prove what the real pipeline —
a real P3 capture, WebKit's colour management, ImageIO's encode — actually
writes. That is this runbook.

**The test is a comparison, not a judgement.** The panel's export was never
wrong; after the fix the editor's export of the SAME shot must be the same
picture. `scripts/compare-still-exports.mjs` checks size, profile and every
pixel. The eye check in §4 is corroboration.

**Needs:** a P3 display — a recent Mac laptop's built-in screen, a Studio
Display, a Pro Display XDR. **Many external monitors are not P3**, and a Mac
running lid-closed on one has no P3 display at all even though the Mac itself
has one — found the first time this was run (2026-09-29: a MacBook Pro in
clamshell on an sRGB HP Z27; the swatches in §0 looked identical). Take every
still here on the P3 screen. `system_profiler SPDisplaysDataType` lists what is
connected.

## Two rounds, and why only one can run today

The first hardware run (2026-09-29) found that **the colour half of this
ticket cannot show on a real capture yet**: the helper does not record a P3
still as P3 — **STC-478**. `frame.png` is tagged Display P3, but `shot.json`
has no `display.colorSpace` (the helper writes one only when CoreGraphics
gives the image's colour space a NAME, and this one has none), so the panel
and the editor BOTH treat every real shot as sRGB. The editor's colour bug
fires only for a shot that says P3, which no real shot does until STC-478
lands. CI covers it meanwhile (`redaction.e2e.test.ts`, with the fake helper
saying P3).

So:

- **Round A — scale (§2, §3). Runs today.** Both at `1x`. The old editor
  ignored `1x`, so its file is twice the panel's size: the control fails on
  SIZE. The fix makes them match.
- **Round B — colour (§5). After STC-478 has merged.** Control at native
  scale, where sizes match and the pixel comparison runs; fix at `1x`.

## VM or host (`docs/VM-TESTING.md`)

**Every item here is host.** None can move to the Tart VM:

| item | where | why |
|---|---|---|
| Round A (§2, §3) | host | a VM could capture and compare, but `redaction.e2e.test.ts` already pins the halving on CI; the point of this round is the real pipeline on the real machine |
| Round B (§5) | host | needs a real P3 panel; the VM has one virtual 1280×800 display ("real displays" are host-only in VM-TESTING.md) |
| §4 by eye | host | an eye on the P3 panel |

VM-TESTING.md's rules 1 and 2 do not apply: this PR changes no permission,
first-run, signing, bundle or startup code — `still-compose.ts` and the two
renderers that call it only.

## 0. Once: something saturated to capture, and 1x

A page of P3 swatches, each beside the nearest sRGB colour:

```
cat > /tmp/stc-477-p3.html <<'EOF'
<!doctype html><title>P3 swatches</title>
<style>body{margin:40px;background:#fff;display:grid;grid-template-columns:repeat(3,200px);gap:16px}
div{height:140px;border-radius:8px}</style>
<div style="background:color(display-p3 1 0 0)"></div>
<div style="background:color(display-p3 0 1 0)"></div>
<div style="background:color(display-p3 0 0 1)"></div>
<div style="background:#ff0000"></div>
<div style="background:#00ff00"></div>
<div style="background:#0000ff"></div>
EOF
open -a Safari /tmp/stc-477-p3.html
```

Top row is P3, bottom row sRGB. On a P3 display the top row is visibly more
vivid (green most of all); if it is not, you are not looking at a P3 screen.

**Quit Capture completely** (it lives in the menu bar — closing the window is
not quitting), then:

```
open -e ~/Library/Application\ Support/Capture/settings.json
```

In the `"still"` block: `"format": "png"` (the compare script reads PNG only)
and `"scale": "1x"` (add it if missing). Save. Edit this file only while the app
is quit — it writes the file itself.

## 1. Where the saves land

A Save writes to the top level of your save folder — the one Settings shows;
`~/Desktop/stc` if you never chose one. `SAVE` below means that folder. Set it
in the SAME shell you run the script from (an unset `SAVE` reaches the script
as `--dir ""`):

```
SAVE=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Capture/settings.json'))).get('saveFolder') or os.path.expanduser('~/Desktop/stc'))"); echo "$SAVE"
```

The script takes the two NEWEST PNGs there, so save nothing else between the
two saves of a round.

## 2. Round A control — pre-fix build, 1x: the check must FAIL

A check that has never failed has not been shown to check anything.

```
git checkout --detach origin/master
npm run app:start
```

(Once PR #245 has merged, `origin/master` HAS the fix; use the commit before
it instead: `git checkout --detach "$(git log origin/master --grep='(#245)' --format=%H -1)^"`.)

1. Take a **region** still of the swatch page (all six swatches), on the P3
   screen.
2. On the post-capture panel, press **Save**. (Panel save = file 1.)
3. Open the library, open that still (it opens the still editor), press
   **Save** (⌘S). Do not draw a box, change the mode, or touch anything else.
   (Editor save = file 2.)
4. Quit Capture, go back to the branch (the script lives there), and compare:

```
git checkout accounts/stc-465-still-editor-export-fix
node scripts/compare-still-exports.mjs --dir "$SAVE"
```

**Expected: exit 1**, `FAIL — size: panel WxH, editor 2Wx2H (editor is 2.00x
the panel …)` — the scale bug, on the real pipeline. A `note:` about the shot's
colour space is expected until STC-478 (see above) and does not matter to this
round.

If it PASSES, stop and report what it printed: the check cannot see the scale
bug here, and §3 would mean nothing.

Move the two control files aside so §3's newest two are the fixed ones:

```
mkdir -p "$SAVE/stc-477-control" && ls -t "$SAVE"/*.png | head -2 | xargs -I{} mv {} "$SAVE/stc-477-control/"
```

## 3. Round A fix — this branch, 1x: the check must PASS

Still at `1x`:

```
npm run app:start
```

Same three steps on a fresh capture of the same page: region still on the P3
screen, panel **Save**, then open it from the library and **Save** in the
editor. Quit Capture.

```
node scripts/compare-still-exports.mjs --dir "$SAVE"
```

**Expected: exit 0**, `PASS — the panel and the editor exported the same
picture`: the same size for both (the editor honouring `1x` like the panel),
the same profile, and `over 4 in flat areas: 0`. The STC-478 `note:` is
expected here too.

Some pixels WILL differ, and that is not a failure: at `1x` each window's canvas
resamples the 2x capture itself, and Chromium does not promise the two agree
bit for bit. The first real run (2026-09-29) had 8,647 of 727,800 pixels
differing, every one above 4 on an edge (swatch borders, text), 0 in flat
areas, swatch centres identical. So the rule is: flat areas within 4 (that is
where a colour error shows), edges free up to 1% of the picture (that is where
resampling noise lives). The script prints both counts. If you framed about the same region as §2, the size is
about half §2's editor file in each dimension.

Independent of the script:

```
sips -g pixelWidth -g pixelHeight -g profile "$(ls -t "$SAVE"/*.png | sed -n 1p)" "$(ls -t "$SAVE"/*.png | sed -n 2p)"
```

## 4. By eye (optional, today)

```
open "$SAVE"/stc-477-control/*.png "$(ls -t "$SAVE"/*.png | sed -n 1p)" "$(ls -t "$SAVE"/*.png | sed -n 2p)"
```

The control editor file is twice the size of everything else; the other three
should look alike. The colours will NOT match the Safari page's P3 row in any of
them — that is STC-478 (every export is sRGB), not this ticket.

## 5. Round B — colour. Only after STC-478 has merged

Needs a helper that records P3 and an app from BEFORE this PR's fix — and those
never existed together in one commit. They don't have to: the helper binary is
built into `helper/build/`, which git ignores, and `npm run app:start` never
rebuilds it, so it survives a checkout.

```
git checkout --detach origin/master          # has STC-478 (and #245, if merged)
helper/build.sh                              # a helper that records P3
git checkout --detach "$(git log origin/master --grep='(#245)' --format=%H -1)^"   # app before the fix
```

(If #245 has NOT merged yet, `origin/master` is itself "before the fix": skip
the third line.)

Set `"scale"` to `"native"` (app quit) — at native, the old build's two files
are the same size and the pixel comparison runs; at `1x` it stops at the size.
Then `npm run app:start`, the same capture / panel Save / editor Save, quit, and
compare from a checkout that has the script:

```
git checkout --detach origin/master          # or the branch, if #245 has not merged
node scripts/compare-still-exports.mjs --dir "$SAVE"
```

**Expected: exit 1**, `FAIL — pixels: N in FLAT areas differ by more than 4 …`, with NO `note:` line.
If the note appears, STC-478 did not take: stop. Two things made it appear on 2026-10-06, check both
before blaming the helper:

- **The capture was not on a P3 display.** With the Mac's lid closed on an external monitor the only
  display is that monitor (an HP Z27, sRGB), and `shot.json`'s `display.id` is its id. Look at
  `display.id` and `sips -g profile frame.png` in the newest `raw/<stamp>/` before comparing.
- **STC-511.** On the real built-in screen the helper once recorded no colour space either, because
  it named the profile by its description ("Display") instead of its colorants. Fixed in STC-511;
  a helper built before it prints the `note:` on a genuine P3 capture.
- **`thumbnail.skip` (straight to clipboard) must be off.** With it on there is no panel, so no panel
  Save: one PNG appears, not two, and the script compares the wrong pair.

Move those aside as in §2. Then the fix, on whatever has #245 (`origin/master`
once merged, or the branch), at `1x`, with the same `helper/build/stc-helper`:
capture, both Saves, compare. **Expected: exit 0, no `note:` line**, both files
`kCGColorSpaceDisplayP3`. Opened in Preview, their P3 swatches should now match
the Safari page's top row.

## 6. Afterwards

Set `"scale"` back to what it was (or delete the line — `native` is the
default). Delete `$SAVE/stc-477-control` and the stills if you don't want them.

## Reporting back

Paste the script's output. **Today (Round A):** §2 exit 1 on size, §3 exit 0 —
that is enough to merge #245. **Round B:** §5 control exit 1 on pixels, fix exit
0, neither with a `note:` — closes the last box on STC-477, recorded there and on
STC-478.
