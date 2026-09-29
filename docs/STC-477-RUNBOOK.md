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
clamshell on an sRGB HP Z27; the swatches in §0 looked identical). The capture
records the colour space of the display it came FROM, so the stills in §2 and
§3 must be taken on the P3 screen. `system_profiler SPDisplaysDataType` lists
what is connected.

## VM or host (`docs/VM-TESTING.md`)

**Every item here is host.** None can move to the Tart VM:

| item | where | why |
|---|---|---|
| §2 control and §3 fix, colour half | host | needs a real P3 panel; the VM has one virtual 1280×800 display ("real displays" are host-only in VM-TESTING.md). On it the capture is not P3, and the script would pass while saying — in its `note:` line — that it tested nothing |
| §3 fix, scale half | host (with the colour half) | a VM could run it, but `redaction.e2e.test.ts` already pins the exact halving on CI, and it rides on the same two files as the colour check for free |
| §4 by eye | host | an eye on the P3 panel |

VM-TESTING.md's rules 1 and 2 do not apply: this PR changes no permission,
first-run, signing, bundle or startup code — `still-compose.ts` and the two
renderers that call it only.

## 0. Once: something saturated to capture

A page of P3 swatches, each beside the nearest sRGB colour — P3-only colour is
where the bug is loudest:

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
vivid; if it is not, this display cannot run this check.

Check the still settings are at their defaults for §2 — PNG, **native**
scale. With the app quit:

```
open -e ~/Library/Application\ Support/Capture/settings.json
```

In the `"still"` block, `"format"` must be `"png"` (the compare script reads
PNG only) and `"scale"` must be `"native"` or absent. §3 changes the scale.

**Why the two rounds differ in scale:** at native scale the old build's two
files come out the SAME size, so the script gets to compare their pixels — and
the pixels are where the colour bug shows, which is the half of this ticket
only hardware can test. At `1x` the old editor file is twice the size and the
pixel comparison never runs. So the control (§2) is native, and the fixed run
(§3) is `1x`, where one pair of files tests both fixes.

## 1. Where the saves land

A Save writes to the top level of your save folder — the one Settings shows;
`~/Desktop/stc` if you never chose one. Below it, `SAVE` means that folder. To
read it rather than guess:

```
SAVE=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Capture/settings.json'))).get('saveFolder') or os.path.expanduser('~/Desktop/stc'))"); echo "$SAVE"
```

The script takes the two NEWEST PNGs there, so do not save anything else
between the two saves in each round.

## 2. Control — on the pre-fix build, the check must FAIL

A check that has never failed has not been shown to check anything.

```
git checkout --detach origin/master
npm run app:start
```

1. Take a **region** still of the swatch page (all six swatches), **on the P3
   screen**.
2. On the post-capture panel, press **Save**. (Panel save = file 1.)
3. Open the library, open that still (it opens the still editor), press
   **Save** (⌘S). Do not draw a box, change the mode, or touch anything else.
   (Editor save = file 2.)
4. Quit the app, go back to the branch (the script lives there), and compare:

```
git checkout accounts/stc-465-still-editor-export-fix
node scripts/compare-still-exports.mjs --dir "$SAVE"
```

**Expected: exit 1**, with `FAIL — pixels: N of M differ …` — the colour bug,
seen by the real pipeline. Sizes match (native scale), and both files carry the
same Display P3 profile: that is exactly the bug, P3 numbers promised and sRGB
numbers delivered.

If it PASSES on the old build, stop: the check cannot see the colour bug on
this machine, and a pass in §3 would mean nothing. Report what it printed.

Move the two control files out of the way so §3's newest-two are the fixed ones:

```
mkdir -p "$SAVE/stc-477-control" && ls -t "$SAVE"/*.png | head -2 | xargs -I{} mv {} "$SAVE/stc-477-control/"
```

## 3. The fix — on the branch, at 1x, the check must PASS

Now set `"scale": "1x"` in the same `"still"` block (app quit), then:

```
npm run app:start
```

Same three steps as §2 on a fresh capture of the same page: region still,
panel **Save**, then open it from the library and **Save** in the editor. Quit.

```
node scripts/compare-still-exports.mjs --dir "$SAVE"
```

**Expected: exit 0**, `PASS — the panel and the editor exported the same
picture`, with:

- the same size for both — the `1x` preference applying in the editor too,
  not only the panel. If you framed about the same region as §2, that size is
  roughly half §2's in each dimension; the exact halving is CI's test
  (`redaction.e2e.test.ts`), so here it only has to match;
- the same profile for both, a Display P3 one (`kCGColorSpaceDisplayP3`);
- `pixels differing by more than 1: 0`;
- and NO `note:` saying the shot is not P3. If that note appears, the capture
  came from a non-P3 display and this run did not test the colour fix.

Independent of the script:

```
sips -g pixelWidth -g pixelHeight -g profile "$(ls -t "$SAVE"/*.png | sed -n 1p)" "$(ls -t "$SAVE"/*.png | sed -n 2p)"
```

## 4. By eye (corroboration)

Open all four side by side in Preview on the P3 display:

```
open "$SAVE"/stc-477-control/*.png "$(ls -t "$SAVE"/*.png | sed -n 1p)" "$(ls -t "$SAVE"/*.png | sed -n 2p)"
```

- The two **fixed** files should be indistinguishable, and their swatches should
  match the Safari page.
- The **control** editor file should look off beside the control panel file:
  the P3 top row especially. Most likely oversaturated, though the exact shift
  depends on how WebKit mapped the frame onto the sRGB canvas. The panel file is
  the reference either way.

## 5. Afterwards

Set `"scale"` back to what it was (or delete the line — `native` is the
default). Delete `$SAVE/stc-477-control` and the four stills if you do not want
them.

## Reporting back

Paste the script's output from §2 and §3. Pass is: §2 exit 1, §3 exit 0 with
no `note:` line. Anything else, including a §2 pass, goes on STC-477.
