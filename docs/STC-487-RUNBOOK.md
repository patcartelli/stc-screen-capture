# STC-487 — recordings get the panel (STC-392 Phase B)

**Not on `master` yet.** Run this from `accounts/stc-487-recordings-get-the-panel`:

```
git fetch origin accounts/stc-487-recordings-get-the-panel
git checkout accounts/stc-487-recordings-get-the-panel
npm ci
npm run app:start
```

Design: `docs/superpowers/specs/2026-09-30-stc-487-recording-panel-design.md`.
What CI already settles (`app/test/recording-panel.e2e.test.ts`, against the fake
helper): a clean stop puts up a recording card (no picture, no Copy, Edit
present), nothing is promoted until Save or Edit, a panel already on screen is
hidden for the take and returns behind the new one, Trash then Undo restores a
recording's panel, and `thumbnail.skip` does not make a recording vanish. This
runbook is only what a person on a real Mac has to judge.

## 1. The card at the corner

Record 10-20 s of the whole screen, then Stop.

- A panel appears at the corner, in front of anything already stacked there.
- It shows **a duration and a scope** (`0:14 · Screen`) and no picture.
- Buttons: Save, Edit, Trash — and **no Copy** (Copy on a recording is STC-395).
- Does the card read as a take you can decide on, or as an unfinished still?

Repeat with a **window** take (scope reads the app's name, e.g. `Safari`) and an
**area** take (`Area`).

**Judgement call:** is *duration · scope* enough to tell two takes apart when
two are stacked? If not, the poster-frame follow-up (STC-392 plan, D2) needs
filing now, not later.

## 2. A hidden panel is really absent from the take

The fake helper captures nothing, so this is the one check CI cannot make.

1. Take a still (a panel appears). Leave it up.
2. Record 5 s, Stop, then scrub the first frames of that take in the editor.
3. The still's panel must **not appear anywhere in the recording**, including its
   first frames. After Stop it comes back, behind the recording's panel.

Then record, but make the start fail (revoke Screen Recording first, or start
with no display): the hidden panel must come back, not stay hidden.

## 3. Nothing is saved until you say so

- After Stop, open the library: the take is **not there**.
- Click Save on the panel: it appears in the library and the panel closes.
- Record again, Stop, click Edit: the editor opens on it (Edit promotes).
- Record again, Stop, ignore the panel, quit (Quit Anyway): relaunch offers it
  back through the recovery prompt, and **Review** puts its panel up (it used to
  be saved outright).

## 4. A take the helper stops on its own

Record, then change the display's resolution mid-take (or close the window of a
window take). The alert reads "...is waiting in the panel at the corner of the
screen. Save it to keep it." — **not** "was saved" — and the panel is there.
The library does not change and Finder does not open.

## 5. Trash

Trash a recording's panel: an undo toast appears. Undo brings the **recording**
card back (not a blank still). Let it run out instead: the take goes to the Trash.

## 6. `thumbnail.skip`

Turn "skip the panel" on in preferences. Record and Stop: a recording still gets
its panel (skip is a still-only shortcut to the clipboard and a recording has no
Copy yet).
