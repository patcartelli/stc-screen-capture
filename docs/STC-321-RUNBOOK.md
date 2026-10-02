# STC-321 — Demo #2: the Vividly walkthrough, narrated

A recording session: a Mac and a person. **It needs STC-419 (keystrokes),
[#273](https://github.com/patcartelli/stc-screen-capture/pull/273).** Run it
from `master` once #273 has merged. Until then, run it from
`accounts/stc-419-show-keystrokes`. This sheet lives on
`accounts/stc-321-vividly-runbook`.

**Done means:** published, reachable by whoever can reach the case study, and
made in **one working day** from first recording to live embed. That day is
the v1.5 measurement, so log it (see the end of this sheet).

---

## What the page actually is (checked 2026-10-02, `patcartelli/studio-cartelli`)

The ticket was written against the planned **hierarchical product filter**.
That filter was **cut** (STC-57); its Phase 27 planning docs describe a design
that does not ship. What ships is this:

| thing | where |
|---|---|
| Page | `/work/vividly-strategic-reporting` ("From Flat Tags to Hierarchies: Rebuilding Vividly's Reporting"). `/work/strategic-reporting` 301s here |
| Sections (h2) | Overview · Understanding the Problem · Design Process · **Solution** · Impact & Outcomes · Reflection |
| The demo | End of **Solution**, under "Aggregated analytics help users analyze performance at any level of the business". A read-only `role="treegrid"` plus a **3-step Back/Next stepper**: S0 "Regional rollup", S1 "Expand North", S2 "ROI recalc vs. naive average" (North 2.16x vs a naive 2.01x) |
| Data | Hand-authored mock (`src/data/vividly-hierarchy.ts`): fictional customers, irregular dollar figures. Not client data |
| Source | `src/scripts/pivot-table.ts`, `src/components/case-study/PivotTable.astro`, `src/lib/vividly-demo-states.ts` |

### The keyboard model, which is what the keycast will show

| Key | Does |
|---|---|
| **Tab** | Enters the treegrid once, onto the first visible row (North at S0). Tab again leaves. One tab stop |
| **↓ / ↑** | Next / previous visible row. Skips collapsed children. No wrap |
| **Home / End** | First / last visible row |
| **→ / ←** | **Only on the stepper's Next/Back buttons:** next / previous step. They do not expand rows |
| Enter / Space on a row | **Nothing, deliberately** (the a11y checklist says Enter must not free-expand the tree). **Never press them on camera:** the keycast would show a key that visibly does nothing |

Expanding and collapsing happen only through the stepper. Rows show a 2 px
brand-colour focus outline (`:focus-visible`), so focus is visible on camera.

The demo hydrates lazily when scrolled near. It is ready when the live region
reads **"Step 1 of 3"**. Do not start the keyboard beat before that.

---

## Decide the gate before publishing (the ticket's open question)

The ticket says decide "when this ticket starts, with a real recording in
hand". So make the take first, then choose. What the site's code makes of
each option:

**The gate does not cover static files.** `/work/*` is gated by SSR
middleware (`src/middleware.ts`, an HMAC `work_auth` cookie set by
`/unlock`). Files under `public/` are served as static assets **without** that
middleware. That was read from the code, not tested against the deployed
site, so curl it once to confirm. A video in `public/` embedded in the gated
page would play for **anyone who has its URL**. No gated video route exists:
`src/pages/work/demo/[name].ts` serves gated HTML demos, not video.

| Option | What it costs |
|---|---|
| **A. Truly behind the gate** | New site work: a gated video route under `/work/` (it does not stream video today) plus an embed component. The case study has no `<video>` pattern at all, and `/lab`'s `LabVideo` + `lab-demos.ts` are keyed to `/lab` slugs. That is its own ticket on `studio-cartelli`, and it lands on the "one working day" clock |
| **B. Public, with redaction review** | Becomes the v2 gate artifact (the ticket says so) and the scope grows. The mock data needs nothing. Review the page's screenshots (`vividly-analytics.png`, `vividly-views.png`, `vividly-folders.png`, `vividly-pa-before/after.png`) for real client data, and redact with STC-297 if any shows. Fits `/lab`'s existing machinery |
| **C. Public file, linked only from the gated page** | Zero new site work, but it is **not gated**, only unlisted. Choose it only knowing that, and say so on the ticket |

Recommendation: record now, look at the take, and if anything on screen is
sensitive, A or B. If nothing is, C is honest only if it is called "unlisted"
rather than "behind the gate".

---

## Pre-flight

1. **Freeze check** (`docs/PRE-DEMO-CHECKLIST.md`): `npm ls electron` matches
   `package.json`, and there has been no `npm install` since.
2. **Grants:** Screen Recording, Input Monitoring and Microphone. Keys need no
   more than that: STC-419 confirmed on hardware that Input Monitoring alone
   covers them, with nothing in "Device Control and Data Access" on macOS 27.
3. **Unlock the page once, beforehand:**
   `/unlock?next=/work/vividly-strategic-reporting`. The cookie lasts 7 days.
   Never type the password on camera: it is typing, so the keycast would not
   show it, but the field and the page would.
4. **Load the page, scroll to the Solution demo, and wait for "Step 1 of 3"**
   before starting. Start **post-settle**, at S0.
5. **Mic.** Pick the mic **explicitly** in the bar's mic menu. There is no
   automatic mic (STC-233). Do a 10 s test take, play it back, and check the
   level before the real one. Not a Bluetooth mic.
6. **Clear the noise.** Do Not Disturb on. Quit Slack, Mail and Messages.
   Hide the Dock and desktop icons. Close every window but the browser.
7. **Rehearse the keyboard beat once**, off the record. The rows have to
   respond to arrows exactly as the table above says.

### Scope and legibility: the decision you cannot fix afterwards

**The case study column is narrower than `/lab`'s.** Content is at most
**1128** CSS px. The inline demo spans 10 of 12 columns, about **936** CSS px
at 1600+ viewports and about 863 at 1440. The app's legibility figure assumes
`/lab`'s **1232**, so it reads about 25% optimistic for this page. Do the sum
yourself:

> text px in the embed = `textPt × 936 / recorded point width`, need **≥ 9**

The page's table text is roughly 14 CSS px, so the recorded width must be
**≤ about 1450 points**. A full 4K desktop (3840) gives about 3.4 px, which is
unreadable.

So **record a WINDOW, not the full display.** Size the browser window to about
**1280 × 800 points** and pick it with the overlay's window mode (STC-370).
That fits Patrick's model in `docs/STC-382-WORKFLOW-STUDY.md`: one subject
means a focused scope. The ticket said "full display", and the arithmetic
above is why this sheet departs from it. **Do not resize or close that window
mid-take.** A window resize ends the take, by design (STC-382).

---

## The script (DRAFT, Patrick's to rewrite)

Length is decided before recording: **3:00**. Shoot for it, don't trim to it.
This draft follows the page's own sections. Rewrite the words; keep the timing
and the actions.

| Time | Section | Action | Say (gist) |
|---|---|---|---|
| 0:00–0:15 | Overview | Hero in frame, still. Poster frame | What Vividly is, what this rebuild was |
| 0:15–0:45 | Understanding the Problem | Slow scroll | Flat tags vs how CPG teams actually think about regions |
| 0:45–1:15 | Design Process | Slow scroll | How hierarchies were arrived at |
| 1:15–1:30 | Solution | Scroll to the demo. Stop at S0. **Wait for "Step 1 of 3"** | "Here it is, live" |
| 1:30–1:55 | Solution: keyboard | **Tab** in (North). **↓ ↓** to West, **↑**, **End**, **Home** | It's a real treegrid: focus moves by row, collapsed rows skipped |
| 1:55–2:30 | Solution: the steps | **Click Next** (S1, Expand North), then with focus on Next, **→** (S2) | Why North's ROI is 2.16x, not the naive 2.01x |
| 2:30–2:45 | Solution: back | **←** once, then **→** | The stepper goes both ways, by key |
| 2:45–3:00 | Impact & Reflection | Scroll to Impact, stop, hold 3 s | The outcome, one line. Cut |

Narration is **live**, on the same clock as everything else (STC-233). Narrate
after (record silent, voice against playback) is v2, not this ticket.

---

## Recording

- **Keys ON** in the Record bar (the ⌘ icon). Expect `events.json` v3 with
  Tab, ↓, ↑, Home, End, →, ←, and no letters ever. **Clicks on** (default).
- **Mic on**, the one picked in pre-flight. **System audio off.** **Camera
  off.**
- The cursor is excluded at capture by design and drawn at export from
  `events.json`. A raw `display.mp4` never has one; only an export does.

---

## Edit

1. **Trim** head and tail only. If it needs more than that, re-shoot. A
   3:00 shot for 3:00 should not need a cut in the middle.
2. **Keycast.** Watch the keyboard beat. The pill should read `Tab`, then
   `↓ ×2`, then `↑`, `End`, `Home`, then `→` and `←` at the stepper. The
   editor's **Keys** switch hides it if a stray key spoils a moment; hiding
   never edits `events.json`. **This is the take that judges whether the
   overlay reads.** Note on the ticket whether it does, and whether 1.2 s of
   hold (`KEYCAST_HOLD_TICKS`) is right at this pace.
3. **Zoom.** Auto-zoom fires on clicks and drags only (STC-325), so the
   **keyboard beat gets no automatic zoom**: arrows, Tab and Home/End are not
   triggers, and STC-327 stays declined. The Next click does get one.
   - For the treegrid, add **one manual zoom window** (STC-331) spanning
     1:30–2:45, rect on the demo frame, so the framing follows focus, not
     the pointer. That is the "honest test of framing that has to follow
     focus" the ticket names: do it by hand, and say so on the ticket.
   - Check the Next click's auto window doesn't fight it. If it does, delete
     the derived one (STC-330).
4. **Audio.** Editor → **Audio**:
   - **Clean up voice** on. Start at strength 0.5 and A/B it by ear (STC-455).
   - Set the mic level so speech peaks well under the limiter.
   - Listen once start to end at 1×. The preview plays the export's mix.
5. **Legibility.** Set **text size (pt)** to the page's table text (about 14)
   and read the figure, remembering it assumes 1232, not 936 (see above).
   Then check **Viewer's eye** by eye.

---

## Export and publish

1. **Export size → `Embed 2× · 2464×…`.** That is 2× `/lab`, a little over 2×
   the case study's 1128, so it is never upscaled. There is no case-study
   preset; that is fine.
2. Watch the export at about 936 px wide in a browser, not full screen.
3. **Publish per the gate decision above.**
   - **B or C:** Share to site (STC-242). Site folder… →
     `<studio-cartelli>/public/lab/videos`, slug `vividly`, then wire the embed
     into the case study by hand. No case-study video component exists yet, so
     either reuse `LabVideo` in the MDX or write a small one. That is a
     `studio-cartelli` change.
   - **A:** stop here and file the gated-video-route ticket on
     `studio-cartelli`. The "one working day" is then over for this attempt;
     say so on the ticket.
4. **Poster frame:** scrub to the 0:00 hero, use **Save frame**, then
   `sips -s format jpeg -s formatOptions 80 frame.png --out vividly.jpg`.

---

## The one-day log (the v1.5 measurement)

Write these on the Linear ticket as they happen:

| moment | time |
|---|---|
| first take started | |
| take kept | |
| edit done (trim, zoom, audio) | |
| export done | |
| gate decided (A / B / C) | |
| live embed loads for someone signed out (B/C) or after unlock (A) | |

---

## What closes the ticket

- [ ] One 3:00 take, narrated live, Keys on, no Enter/Space on rows
- [ ] Keycast judged: does it read at about 936 px? Hold length right? Written on the ticket
- [ ] Treegrid framing done by a manual zoom window, and said so
- [ ] Gate decided and the choice written down, with "unlisted" called unlisted if C
- [ ] Published and loading as the chosen audience would see it
- [ ] The one-day log filled in
- [ ] Take kept in the library

## What only a person can settle

- Whether the keycast pill reads at the case-study width, and whether the
  pill or the treegrid's own focus ring carries the keyboard beat.
- Whether the narration needs Clean up voice at all, and at what strength.
- The gate (above). It is a judgement about the screenshots and the audience,
  and no code here can make it.
