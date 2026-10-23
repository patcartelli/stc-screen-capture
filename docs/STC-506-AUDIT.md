# STC-506 — focus and reduced-motion audit

**Status: audit done, fixes pushed (the table below is the BEFORE state).**

## After the fix pass

Decisions (Patrick): pill uses tokens; overlay bar becomes real buttons;
keyboard alternatives for the pill drag and the redaction canvas are a
follow-up, not this ticket.

| Finding | Now |
|---|---|
| 1. Overlay bar not Tab-reachable | `button.ctl`; disabled ones `aria-disabled` + `tabindex=-1`; Return/Space press the focused control; mic/camera menu opened from the keyboard takes focus, rows take ↑/↓ + Return/Space, and focus returns to the trigger when it closes. A press no longer moves focus onto a button (so click-Expand then Return still means Capture) |
| 2. Panel actions invisible to focus | `#card:focus-within` reveals them; format radios are one tab stop with arrow keys |
| 3. Countdown Return on Cancel | `decideCountdownKey` leaves Return to a focused button (`onButton`); unit-tested |
| 4. Missing rings | one zero-specificity `:focus-visible` rule in `tokens.css` on `--focus`; overlay `.ctl` and menu rows, pill Stop (was hard-coded), panel and countdown buttons get it |
| 5. Missing reduced motion | panel (fade only, discard fades in place), marquee Expand (fade), profile sheet (fade + `visibility`), editor `#framestatus`/`#ruler-activity-wrap`/`#overridebox`/`#zoomreadout`/`#overview-window`, still-editor `:active` scale |
| 6. Pill hard-coded colours | hover → `--surface-deep-hover`, ring → `--focus`. `PILL_THEME.hover` in `pill.ts` is now unused by the CSS |
| `:active` gaps | added on overlay `.ctl`, countdown and panel buttons, pill Stop |

**axe** (`npm run axe:renderers`, WCAG 2.0/2.1 A+AA, light and dark, preload
bridges stubbed): after adding `lang`, every page is clean **except three
colour-contrast failures, all from `--text-faint`/`--text-dim` at 10-12px**:
`index.html` (`#modelcode`, every `.subhead`, `#pipsettingshint`,
`#shortcuthint`; 2.2-2.6:1 light, 3.7:1 dark), `still-editor.html` `#hint`
(2.8:1 light, 4.0:1 dark), `countdown.html` `#cancel kbd` (4.2:1). Not fixed:
the fix is a darker token or a different text colour, which is a visual
decision. Hidden-until-state UI (overlay bar, open menus, expanded panel) is
not audited by axe.

**Not run:** the Electron e2e suite (this sandbox runs as root, which Electron
refuses without `--no-sandbox`, and the Swift helper cannot build on Linux).
The overlay pointer/focus interplay and the Return/Space handling are therefore
typechecked only. **(Mac)**: click a bar control, then Return, and check it
still captures; Tab through the bar; open the mic menu from the keyboard.


**How this was made.** A static read of every `app/renderer/*.html`/`*.css` and the
matching `app/src/*-renderer.ts` key handlers, at `4cfb1c6`. Nothing was launched,
no axe run, no screenshot taken (this sandbox has no macOS and no window manager).
So a cell says what the *source* does. Anything only an eye or axe can settle is
marked **(Mac)** or **(axe)**, and the acceptance box "axe pass at zero" is **not
claimed** by this document.

The ticket text is stale in three places (it was written at `bd78d63`):
`pill.html` now exists and has `:focus-visible` plus a reduced-motion rule; the
countdown has `prefers-reduced-motion` handling; STC-504 has moved the
countdown/panel/overlay onto `tokens.css`. Rows below reflect `4cfb1c6`.

Legend: **ok** = present and uses a token · **GAP** = missing, fix in the next pass ·
**n/a** = the surface has no such state (reason given) · **native** = drawn by
macOS, not by us.

## Table

| Surface (file) | hover | focus-visible | active | disabled | loading | keyboard path | reduced motion |
|---|---|---|---|---|---|---|---|
| **Menu bar menu** (`tray-menu.ts`) | native | native | native | native (items carry `enabled`) | n/a — static template | native: macOS menu navigation; accelerators drawn, live only where `tray-menu.ts` says | n/a — no animation of ours |
| **Selection overlay** (`overlay.html`, `overlay.ts`) | ok `.ctl:hover` (token fill); handles have none | **GAP** — no rule. The only focus style is the size input's underline `box-shadow`, hard-coded to `--text-dim`, not `--focus` | **GAP** — no `:active` on `.ctl` or record | ok `.ctl[data-enabled="0"]` dims and kills hover | n/a — nothing loads | **partial.** Esc / Return / Space / arrows work via the reducer. **GAP:** every bar control is a `div.ctl` with no `tabindex`, no `button` role (only `ctl-keys`/`ctl-clicks` have `role=switch`), so the bar is **unreachable by Tab**; the 8 handles are pointer-only (arrows nudge the marquee instead) | **GAP** — `#marquee.expand-transition` animates left/top/width/height over `--dur-move` with no `@media` guard |
| **Options bar** (`overlay.html` `#bar`, `record-options.ts`) | ok | **GAP** — same as overlay; `#menu` rows (`device-menu.css`) have no `:focus-visible` either | **GAP** | ok (`data-enabled`) | n/a | **GAP** — see overlay: not Tab-reachable. Mic/camera menu closes on Esc (ok) but its rows are not arrow-navigable from the source I read **(Mac to confirm)** | ok — no transition on the bar or menu |
| **Countdown** (`countdown.html`, `countdown-renderer.ts`) | ok `button:hover` | **GAP** — no rule, buttons fall back to the UA ring | **GAP** | n/a — buttons are never disabled | n/a | **BUG.** Esc → cancel and Return → skip are handled in `decideCountdownKey`, and `preventDefault` runs for every key it claims. So Return with **Cancel focused** (after Tab) *skips* instead of pressing Cancel. Tab order is Cancel → Skip. Space on a focused button still works | partial — ring hidden and `#sweep` transition off when reduced; the count keeps counting, which is correct (rule 5). No crossfade needed: nothing moves |
| **Pill** (`pill.html`, `pill-renderer.ts`) | ok `#pill-stop:hover` (**hard-coded `#17171a`**, not a token) | ok `#pill-stop:focus-visible` — but **hard-coded `#f5f5f5` 1px**, not `--focus` (deliberate: pill is dark-always, STC-550) | **GAP** — no `:active` | ok `[disabled]` during the dwell | n/a | ok — Stop is the one button; the pill itself is pointer-drag only and has no keyboard drag **(decide: out of scope?)** | ok — dot pulse off, drag places directly, no show/hide transition. Meter width `60ms` is a level reading, not movement |
| **Floating panel** (`thumbnail.html`, `thumbnail-renderer.ts`) | ok | **GAP** — no `:focus-visible` anywhere in the file; `#dismiss`, Copy/Save/Edit/✕, format radios all fall back to the UA ring | **GAP** | ok `button:disabled` | ok (`#copyprogress`, `#giflabel`) | **partial.** ⌘C / ⌘S / ⌘E / ⌘⌫ and Esc exist, gated by `SETTLE_KEYS_MS` (300 ms). **GAP:** `#actions button[data-action]` are `opacity: 0` until `#card:hover`, so a keyboard user who Tabs onto Copy lands on an **invisible** button. Format radios (`role=radio`) have no arrow-key handling | **GAP** — `#card` scale 0.92→1 + fade over `--dur-base` (160 ms) and the swipe fly-off have no `@media` guard; `#actions` fade-in also moves nothing but is opacity-only (fine) |
| **Library** (`index.html`, `renderer.ts`, `library-view.ts`) | ok | ok `.libthumb.clickable`, `button`, `.devicepicker-trigger` all use `--focus` | partial — buttons have hover only | ok `:not([disabled])` guards | ok `.libspinner` + `aria-busy` | ok — real buttons; tiles are `.clickable` with focus ring **(axe: confirm tile role)** | ok — spinner animation off; no other motion |
| **Video editor** (`editor.html`, `editor.ts`) | ok | ok on all controls (`--focus` / `--accent`). Ring uses `--accent` on the timeline controls, `--focus` elsewhere — inconsistent but present. `#framemenu`, `.rulerbookmark`, `#audio-resize` use `outline: none` + a fill instead of a ring **(GAP if the fill is the only cue; Mac)** | partial — `.icon:active` only | ok | ok `#previewaudio[data-state=loading]` | ok — scrubber rules 1-10 (`scrubber.ts`), tested by `scrubber.e2e` | **partial.** `#overridebox` and `#zoomreadout` are wrapped in `no-preference` (ok). **GAP — unwrapped:** `#framestatus` opacity `.4s`, `#ruler-activity-wrap` opacity `.12s`, `#overview-window` transform/colour `.12s`, `.timeline .handle` transform `.12s`. The comment at line ~325 says "no transition runs under reduced-motion" — true for the zoom readout, **not** for these four |
| **Still editor** (`still-editor.html`) | ok `.iconbtn:hover` | ok `.iconbtn:focus-visible` (`--focus`) | ok (`scale(.93)` — **a movement**, see motion) | ok | n/a | ok — ⌘Z / ⌘S / Esc, Tab to three buttons. The redaction canvas is pointer-only **(decide: out of scope?)** | **GAP** — `.iconbtn:active { transform: scale(.93) }` has no guard (tiny, but it is movement) |
| **Preferences / profile sheet** (`index.html` `#profilesheet`, `permissionsheet`) | ok | ok (shares `button:focus-visible`) | partial | ok | n/a | ok — Esc closes (`renderer.ts` keydown); X is a real button | **GAP** — `transform: translateX(100%)` → 0 over `.18s` with no guard. Rule says crossfade ≤120 ms, so under reduced motion: no transform, opacity only |
| **Toasts** (`toast.html`, `toast-renderer.ts`) | ok | ok `button:focus-visible, #close:focus-visible` (`--focus`) | **GAP** — hover only | ok `button:disabled` | n/a | ok — close is a button | ok, and noted in the file: reduced motion is applied from `toast-renderer.ts` because inline styles outrank an `@media` block |

## Findings, ranked

1. **Overlay options bar is not keyboard-reachable** — `div.ctl` ×9, no `tabindex`.
   The largest single gap against "overlay fully keyboard-operable". Fix is to make
   them `button`s (or `tabindex=0` + Enter/Space), which then needs focus rings and
   a decision about Return, since Return already means *Capture* on this surface.
2. **Floating panel actions are invisible to keyboard focus** (`opacity:0` until
   hover). Needs `:focus-within`/`:focus-visible` to reveal, in addition to the ring.
3. **Countdown: Return on a focused Cancel skips.** A behaviour bug, not a style gap.
4. **Focus ring missing outright** in overlay, countdown, floating panel (matches
   the ticket), plus overlay menu rows.
5. **Reduced-motion missing** on the panel's open/swipe, the marquee expand, the
   profile sheet slide, four editor transitions, and the still-editor `:active` scale
   (the ticket named three of these; the last three are new).
6. **Hard-coded colours in the pill** (`#f5f5f5`, `#17171a`) where the ticket asks for
   "a token" — deliberate per the file's comment (dark-always), but it's a decision
   to confirm, not assume.

## Proposed rule for the fix pass

- One ring: `outline: 2px solid var(--focus); outline-offset: 1px` on `:focus-visible`,
  declared once in `tokens.css` for `button`, `[role=button|radio|switch|menuitem]`,
  `[tabindex]`, with surfaces overriding only the offset. STC-504 already put these
  three windows on `tokens.css`.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` swaps each movement for
  `opacity` over `--dur-quick`, **not** `transition: none`. Check `--dur-quick` is
  ≤120 ms before relying on it.

## Open questions for review

1. Pill drag and the still editor's redaction canvas are pointer-only. Keyboard
   alternatives are real design work — in scope for STC-506, or a follow-up?
2. Pill: keep the dark-always hard-coded colours, or add `--pill-*` tokens?
3. Overlay bar: OK to turn the `div.ctl` into real buttons? That changes the DOM the
   `overlay-*.e2e` tests select on.
4. Seven open blockers are linked on the ticket (STC-453, 484, 483, 550, 479, 553,
   542). STC-550 and 484 are visibly already in the tree; the rest I did not check.

## Not done

axe on each renderer HTML; any run of the app; hover/active cells for the native
menu; the "Mac" cells above.
