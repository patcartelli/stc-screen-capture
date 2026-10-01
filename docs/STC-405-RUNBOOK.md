# STC-405 — auto-zoom against a live screen share

Run this from the branch `accounts/stc-405-test-auto-zoom-against-a-live-screen-share`
(**not on `master` yet**). The audit script and its tests live only there.

```
git fetch origin
git checkout accounts/stc-405-test-auto-zoom-against-a-live-screen-share
npm ci
```

## What you are testing, and what you are NOT

Stage 1 (`zoom.ts`) opens a zoom window **only on a click or a drag**. A video
tile, a toast or the active-speaker border cannot open one. So on a Meet share
noise does not cause zooms; it damages **where a real click's zoom lands**.
"A false trigger" on this ticket therefore means one of:

| finding | meaning |
|---|---|
| `suppressed` | the change track said "don't zoom" where the cursor alone would have framed the click — noise swallowed a real zoom |
| `misdirected` | the zoom's crop does not contain the click — the picture zoomed to something else on screen |
| `drifted` | the crop contains the click but its centre is >0.1 of the frame from the cursor's own answer |
| `no-coverage` | `changes.json` does not reach the window (should not happen; report it) |

**Two gaps to know about.** (1) No take has a `changes.json` unless you write
one (step 3); without it every window takes the cursor fallback, which pixels
cannot mislead, and there is nothing to audit. (2) The app does not write the
sidecar itself yet, so the audit is offline, after the take.

## 1. Set up

* Real Mac, Screen Recording + Input Monitoring granted (`docs/PRE-DEMO-CHECKLIST.md` §0).
* Auto-zoom **on** (it is by default). Leave the preset at `standard`.
* Two participants, not one. A call with only you has no video tiles and
  proves nothing. A second device on your phone or another account is enough;
  have that person turn their **camera on and move** (a still face is a weak tile).
* Share **the entire screen** in Meet, and record the **same display**.
  Do one take per Meet share mode if you have time: *entire screen*, then
  *a window* (Chrome will show the "You're sharing" bar).
* Put something to click on the shared screen: a doc, a dashboard, a code editor.
  The clicks are the test; the call is the noise.

## 2. Record — provoke the noise, on purpose

One take, ~3 minutes. Click something real every 10–15 s, and while **each
click's 2.5 s window is open**, let the call do something. Say the provocation
out loud in the take so you can find it again later ("now a chat message").

| # | noise source | how |
|---|---|---|
| a | active-speaker tile switches | have the other person talk, then you, alternating |
| b | their camera | they wave / move continuously |
| c | your self-view tile | leave it on, move a little |
| d | chat toast | they send a message just after your click |
| e | reaction animation | they send an emoji reaction |
| f | "someone joined / left" toast | have a third person join, or rejoin on the phone |
| g | the sharing bar / Meet's control bar auto-hiding | leave the mouse still for 5 s, then click |
| h | an OS notification | send yourself a Messages or calendar alert |
| i | a **control** click | click once on Meet's own UI (mute, chat) — a click that *should* zoom to call chrome |
| j | a quiet click | one click with the call fully idle (no one moves, no toasts) |

Row **j** is your control: if it comes back `misdirected`, the problem is not
the noise. Keep one take with **no** provocation at all (5 clicks, call idle) for
the same reason.

Then repeat once on **Zoom** (the ticket names both): same table, same steps.
Zoom's noise differs: it has a gallery/speaker view switch, a floating
thumbnail strip while sharing, and a "You are screen sharing" bar.

## 3. Write the change track, then audit

Needs real Chrome installed (it decodes H.264; the Linux sandbox cannot).

```bash
# Reveal the take in Finder from the library, then:
node scripts/change-track-one.mjs "<take folder>"
node scripts/zoom-audit-one.mjs "<take folder>" --out ~/Desktop/stc-405-meet.md
```

`change-track-one` prints its ms per frame pair. **Write that number down**
(STC-322's cost question is still open for a real 4K take).

The report has three parts:

* **Zoom windows** — one row per click, with the finding and both crops
  (change crop vs. the cursor's). The last column, *judged (you)*, is yours.
* **Noise floor** — how much changed outside any window, and an ASCII
  map of which grid cells were active most of the take (Meet's tiles should
  glow).
* **Bursts** — every stretch of outside-window change above 2%, with
  `near a window = yes` where it fell within 1 s of a click. Match them to your
  spoken provocations.

## 4. Judge by looking, too

The audit says where a crop landed, not whether it reads well. For every
window it flags **and two it calls clean**: open the take in the editor, scrub
to the window's time, and confirm by eye. A `clean` that looks wrong is a
finding the audit cannot see — note it.

## 5. What to bring back

For each take: the report file, plus one line per false trigger, in this shape,
which is what STC-319/320 consume:

```
<time>  <finding>  noise source (table row a–j)  what the crop framed instead
```

Then the three answers the studies need:

1. Which noise sources got through the classifier as survivors (table rows)?
2. Was any false trigger a **continuous** source the ambient rule should have
   caught, or a **brief** one (toast, reaction) no per-cell rule can separate from
   a real reaction to the click? The second kind is the argument for a
   temporal filter; the first is a threshold bug (`AMBIENT_FRAME_FRACTION`).
3. Did `suppressed` ever fire, and on which source? That is the worst failure
   here: it makes a real click not zoom at all.

Post the summary as a comment on STC-319 and STC-320, and in the ticket's
`docs/TICKET-LOG.md` row.

## What this runbook cannot settle

* Whether the `0.1` drift threshold and `0.2` far-cell distance in
  `transform/src/zoom-audit.ts` are the right lines. They are provisional, like
  every number in `zoom-change.ts`. A drifted window you think looks fine
  means the line is too tight.
* Anything about Zoom or Meet versions beyond the ones you ran.
