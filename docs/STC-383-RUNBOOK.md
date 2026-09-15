# STC-383 — gate 3's latency budget, on a Mac

Written on Linux. No `swiftc`, no display, no Screen Recording grant, so
**nothing in this change has been run**. The whole of it is a test file and two
doc sections; no helper source is touched, so there is nothing new to compile —
but the gate itself can only run on a Mac with a grant, which is the point of
this file.

The finding, in one line: gate 3 was holding STC-289's "200 ms from verb to
**buffer**" against the wall clock of verb to **answer**, which also carries a
PNG encode that is ~55-60% of the request on a large display. It now budgets
each quantity separately, and takes STC-341's better steady-state statistic. Full reasoning in `docs/STC-301-GATES.md` → "Reading gate
3's output"; the phase measurements are in `docs/STC-289-RUNBOOK.md` §latency.

```
npm run test:capture
```

Needs Screen Recording **and** Input Monitoring for the process running the
tests (see `docs/STC-315-RUNBOOK.md` §0 — every capture test needs both now,
not just the cursor ones).

---

## §1 — gate 3 passes, and says what it measured

Expected, on the 6016x3384 machine this was diagnosed on:

```
[gate 3] sample 0: wall 336.9 ms | content enum 36.8 | screenshot 145.1 | PNG encode 137.1 | shot.json 0.4 || verb-to-buffer 181.9
[gate 3] sample 1: wall 250.9 ms | content enum 30.6 | screenshot 68.1 | PNG encode 139.2 | shot.json 0.3 || verb-to-buffer 98.7
...
[gate 3] frame encoded: 6016x3384 px (20.4 MP) — the PNG encode scales with this area, ...
[gate 3] verb to buffer (captureMs, early ones warm up): 181.9, 98.7, ... (overall median ..., worst 181.9, STEADY median ~98 of ..., budget 200)
[gate 3] verb to answer (wall, early ones warm up): 336.9, 250.9, ... (overall median ..., worst 336.9, STEADY median ~251 of ..., budget 400)
```

**What must be true:**

1. **The test passes.** It has never passed on hardware before — that is the
   whole ticket, so this is the result, not a formality.
2. **`frame encoded:` names your display's full backing-store size.** This is
   the line STC-383 asked for ("log the actual pixel dimensions of the PNG
   being encoded"). Gate 3 captures the whole display with no crop, so on a
   2x Retina display expect points x 2 in each axis. If it reports something
   much smaller, the hypothesis that frame area explains the cost is wrong and
   the rest of this change needs rethinking rather than accepting.
3. **PNG encode is the largest phase.** If content enumeration or the
   screenshot dominates instead on your machine, say so — the conclusion in
   both doc files is written from one display's steady state. STC-341's
   hardware disagrees about the *screenshot* phase (it measured ~145 ms where
   this one measures ~65-73) while agreeing closely about the encode
   (~133 vs ~137-141), so the encode's dominance is the better-supported half
   of the claim.

**What is NOT a failure:** the early samples being larger than the rest. Both
budgets are applied to the median of the SETTLED HALF (samples 5–9 of 10), not
to the whole run: the first call pays for `SCShareableContent` enumeration that
no later one does, and STC-341 measured a second warming phase after it
(334.3 → 232.3, 232.1 → 209.8, 209.9). STC-383's own run shows no such second
phase, which is exactly why the statistic has to be robust to it either way.

## §2 — the numbers against the two budgets

The interesting comparison is not pass/fail, it is headroom:

| | budget | expected steady median | headroom |
|---|---|---|---|
| verb to buffer (`captureMs`) | 200 ms | ~98 ms | ~2x |
| verb to answer (wall) | 400 ms | ~251 ms | ~1.6x |

**Both of those are from ONE display (6016x3384), and the buffer figure is the
one to hold loosely.** STC-341's run on different hardware (5120x2880 source,
3840x2160 capture) reported a `captureMs` of **187 ms** — inside the 200 ms
budget by 13 ms, not by a factor of two. That reading is from a single
full-display still and so reads as a COLD sample (STC-383's own cold
`captureMs` was 181.9 against a 92-101 steady), which would put its steady
value far below 200. But that is an inference, not a measurement: nobody has
recorded a steady-state `captureMs` on that display. **If your run shows the
buffer budget with materially less headroom than the table claims, the table
is what is wrong, and it is worth saying so rather than treating 200 as
comfortable.**

If **verb to buffer** comes back anywhere near 200, that is a real regression
in the screenshot or in content enumeration and the split has bought us a
sharper instrument exactly where it was wanted — look at the per-sample
`content enum` and `screenshot` columns.

If **verb to answer** comes back near 400 while verb-to-buffer is fine, check
the `frame encoded:` megapixels first. The 400 was calibrated against ~20.4 MP;
the encode scales with area, so a materially larger display is a reason to
revisit the constant (`STILL_END_TO_END_MS` in
`helper/test/still-gates.grant.test.ts`, which documents its own derivation)
rather than a regression to hunt.

## §3 — the one thing that would change the decision

STC-383 offered a faster PNG encode as option (a) and it was **not taken**,
because ImageIO has no compression-level knob for PNG. If the numbers above
land very differently on your hardware — in particular if the encode is a much
smaller share of a much smaller total — then the budget split is still correct
(it measures the right quantities either way) but the 400 is calibrated against
the wrong machine, and it should be re-derived from your own run.

Record whatever you get. The old worked example in `docs/STC-301-GATES.md` was
never measured, and believing it is part of how this went unnoticed; the ones
there now are real, and should only ever be replaced by other real ones.

## What is deliberately not here

- **Nothing about gate 6.** Untouched by this change.
- **No helper change to verify.** `helper/src/Still.swift` is not modified —
  the frame dimensions were already in the reply, the gate just never printed
  them.
- **No CI story.** Gates 3 and 6 still cannot run on GitHub's runners, for the
  reason `docs/STC-301-GATES.md` → "Disagreement 1" gives at length. This
  change does not alter that and does not try to.
