# STC-382 — the recording / still workflow, as it actually is

STC-382 holds a question and deliberately prescribes no answer: *"this ticket
exists to hold the question, not to prescribe an answer."* There are no
acceptance criteria. So this document is the point of view, not a build — it
reads the two workflows out of the code, names what actually diverges, prices
each of the ticket's three candidate directions, and recommends one.

**Everything below was read off the code on Linux.** Nothing here is a
judgement about how the window feels, because that cannot be made from this
sandbox — see §6 for what a Mac still has to settle. File references are to
`master` at the time of writing.

---

## 1. What the two paths do today

|  | **Recording** | **Still** |
|---|---|---|
| doors | 1 — the Record button | 3 — the button, three hotkeys, the menu bar |
| scope chosen | sticky, persists across launches (`settings.scope`) | per-shot, ephemeral — an overlay every time |
| scope vocabulary | a noun picker (Screen / Window / Area) | three verbs (`CAPTURE_ACTIONS`) |
| "whole screen" means | `settings.displayId`, or the helper's first | the display under the pointer |
| refuses when unset | yes — Record disables, `start` answers `no-capture-target` | n/a — it always asks |
| what happens after | lands in the library and waits | a panel appears and settles itself |
| where it ends up | the same grid, with a kind badge | the same grid, with a kind badge |

Sources: `app/src/main.ts:333-355` (recording scope), `app/src/main.ts:586-590`
(`wholeDisplay`), `app/src/hotkeys.ts:39-64` (`CAPTURE_ACTIONS`,
`DEFAULT_SHORTCUTS`), `app/src/tray-menu.ts:58-68`, `app/src/renderer.ts:328`
(Record's disabled rule), `app/src/main.ts:508` and `:820` (the two
destinations).

---

## 2. What actually diverges

The ticket names one divergence — the Scope picker applies visually to both and
is wired to one. That is correct, and it is the smallest of five. The others
were found reading the code for this study.

### A. The two actions have opposite completion models

This is the finding the rest of the document rests on, and the ticket does not
mention it.

A **still is finish-and-forget.** The shot is on disk before anything is shown;
a floating panel appears, and if it is ignored it settles *itself* after the
timeout and saves or copies per the preference (`main.ts:497-512`). Doing
nothing is a complete, successful use of the feature — that is STC-296's
"there is no path where a capture is silently lost", working as designed.

A **recording is start-a-document.** When a take ends, nothing opens. The
editor is reached only from the library's Open action
(`renderer.ts:1016` → `main.ts:820`); the sole post-take gesture is a
`reveal()` on the helper-initiated stop path (`renderer.ts:667`). Doing nothing
leaves a file you have not looked at, and trim / export / share are all still
ahead of you.

So the two buttons are not two variants of one verb. One ends a task; the other
begins one. **The equal-weight row asserts a symmetry the rest of the app does
not have** — and that, rather than the Scope wiring, is why the relationship
reads as vague.

### B. "Screen" means two different displays

A recording's Screen scope resolves to `settings.displayId` — the sticky
picker, absent meaning the helper's first (`main.ts:345-349`, STC-247). A
full-display still resolves to `screen.getDisplayNearestPoint(getCursorScreenPoint())`
— the display under the pointer, with no overlay at all (`main.ts:586-590`,
STC-292).

Both rules are individually right for what they serve. Together they mean one
word denotes two things in one app. **On a one-display Mac they coincide**,
which is why nobody has met it — and a divergence that only shows up on a
second display is precisely the shape this file has been bitten by before
(STC-247's own whole reason for existing).

Stated precisely, because it is easy to overclaim: the visible Screen/Source
pair in the window governs *recordings only*. The still's display rule is
reachable only from the hotkey and the menu bar, neither of which is in the
window. So the two rules are not currently shown side by side — they would be
the moment Scope governed stills, which is a cost of option 2 below.

### C. There are already two scope vocabularies

Stills do not lack a scope concept. They encode it as three verbs —
`region` / `window` / `display`, one hotkey and one menu item each
(`hotkeys.ts:39-64`, `tray-menu.ts:58`). Recordings encode it as a sticky noun
picker plus a source.

So the Scope picker does not merely *fail to apply* to stills. It is a second,
differently-shaped answer to a question stills already answer. Any direction
that leaves both in place leaves the app with two ways to say the same word.

### D. Doors are asymmetric three to one

A still can be taken from the button, three global hotkeys, or the menu bar. A
recording can be started only from the Record button — there is no recording
hotkey and no menu-bar Record item. CLAUDE.md already records the far side of
this from STC-375: no hotkey can *stop* a take either, which is why `#record`
stays reachable inside the collapsed pill.

This is worth naming because it cuts against reading the two buttons as peers:
one of them is the only door to its feature, the other is the least-used of
three.

### E. Small: the library heading says "Recordings"

`<h2 id="lib-heading">Recordings</h2>` (`index.html:354`) is static — nothing in
`app/src/` writes to it — and it sits above a grid that has held both kinds
since STC-294, filtered to mixed by default. One line, no behaviour, but it is
the same class of statement as the Scope picker's: a label that describes half
of what is under it.

---

## 3. The candidate directions, priced

The ticket names three. A fourth follows from finding A and is included.

### Option 1 — Scope *seeds* a still, which still confirms

Capture still opens the overlay pre-seeded with the sticky window or area; you
confirm or adjust.

*For:* Scope stops lying without taking away the per-shot framing a screenshot
usually wants. Preserves the completion model in §2A.

*Against, and this is the real cost:* pre-highlighting a stored window is a
**claim that the window still exists**, and `ScopeSettings.windowLabel`'s own
comment forbids exactly that claim — *"Cosmetic only — never sent to the
helper. A window can close or another app can retitle it."* Seeding turns a
cosmetic string into a live assertion about the window list. It also lands
directly on top of **STC-380** (open, PR #158), which is about the picker
already offering windows a person cannot actually select. Adding a second
staleness surface to the picker while the first is still in flight is the
wrong order.

*Verdict:* defensible, but not now. Sequence it after #158 lands.

### Option 2 — one Scope, governing both

Screen captures the display with no overlay; Window/Area shoot the sticky
target directly.

*For:* one vocabulary, one meaning, and finding C goes away.

*Against:* it contradicts §2A. A sticky target is right for a recording
precisely because framing is a setup decision made once per session; it is
wrong for a screenshot, where the thing being framed is different nearly every
time. This would make every screenshot as modal as a recording — you would set
scope, then shoot, and a shot of something else would cost two gestures. It
also puts finding B's two "Screen" rules side by side in one control, forcing a
choice nobody has asked for.

*Verdict:* the tidiest-looking option and the one that degrades the product.
Recommend against.

### Option 3 — leave the wiring, fix the lie visually

Scope moves under Record, or is labelled so it plainly belongs to recordings.
No behaviour change.

*For:* cheap, reversible, and truthful. Nothing that works today stops working.

*Against:* leaves finding C standing — two scope vocabularies — and does
nothing about §2A, which is the actual source of the vagueness.

*Verdict:* correct as far as it goes, and it does not go far enough on its own.

### Option 4 — stop presenting them as two peer buttons

Not "two buttons in one row" and not "two modes" in the heavyweight sense
either: give the two actions different visual weight matching what they are.
Record is a session you commit to; Capture still is a one-shot you fire and
forget. `#record` is already the only tinted control in the row
(`index.html:100`) — the point is to finish that thought rather than start it.

*For:* it addresses §2A directly, which none of the other three do.

*Against:* it is the one that needs an eye. Nothing in this sandbox can tell
whether a differentiated row reads as clearer or merely as inconsistent, and
this repo's own history is full of numbers that were reasoned and wrong until
somebody looked (STC-291's presets, STC-338's rubber band, STC-375's pill).

---

## 4. Recommendation

**Option 3 now, option 4 as the direction, option 2 declined, option 1
deferred.**

1. **Make Scope visibly belong to Record.** Group it with the Record button or
   label it for recordings. One line of truth restored, no behaviour changed,
   nothing to unwind if the bigger answer goes elsewhere. Fold in finding E
   while there — the heading is the same defect one control over.
2. **Then differentiate the two actions' weight** (option 4), so the row stops
   claiming a symmetry §2A shows does not exist. This is the part that wants a
   Mac before it is committed to.
3. **Do not make Scope govern stills** (option 2). It is the change that looks
   most like tidying up and is the one that costs the product something real.
4. **Revisit seeding** (option 1) once STC-380 has landed and window staleness
   has an owner. It is a good idea sitting behind another ticket's fix.

The through-line: the vagueness the ticket noticed is not mainly a wiring gap.
It is that two actions with opposite completion models are drawn as peers. Fix
the label because it is false; fix the weighting because it is the actual
question.

---

## 5. The Scope-and-stills question, answered

Asked directly during this session and deferred to the writeup, so it is
answered here rather than left implicit.

**Scope should not govern a still capture, and should not seed one yet.**

- *Governing* it (option 2) is refused on §2A: sticky framing is right for a
  session and wrong for a one-shot.
- *Seeding* it (option 1) is refused only on **timing**, not on merit — it
  turns `windowLabel` from a cosmetic string into a live claim, on the same
  picker STC-380 is currently repairing. It is the right second step.
- What is left is option 3: Scope keeps meaning what it already means, and the
  UI says so.

If exactly one thing is built from this document, build the label.

---

## 6. What this does not settle

Read off code on Linux. A Mac is the only instrument for:

- Whether a differentiated row (option 4) reads as clearer or as inconsistent
  — the whole of §3's option 4.
- Whether moving Scope under Record makes the second row look orphaned at a
  real window size.
- Whether finding B is ever *felt*. It needs two displays and a pointer on the
  non-primary one, and the prediction is that a full-display hotkey shot and a
  Screen-scope recording disagree about which display they mean. **Untested
  — nobody has run it.**
- Whether the door asymmetry (§2D) is a problem at all, or simply reflects how
  the two features are used.

None of these gate the option 3 work, which is why it is recommended first.
