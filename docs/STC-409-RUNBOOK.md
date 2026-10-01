# STC-409 — Demo asset: a clean auto-zoom clip

A recording session, so a Mac and a person. **Run it from
`accounts/stc-409-demo-asset-clean-auto-zoom-clip`** (not on `master` until
merged) — it is the branch this sheet lives on.

**Done means:** one 30–60 s take, auto-zoom on, where every zoom is one you
would have chosen, exported at demo resolution, and kept. Nothing else on the
ticket.

**Why a clip and not live:** stage 2 (`zoom-change.ts`) still reacts to visual
noise (STC-405). So the whole job is a surface with none: no call UI, no
notifications, nothing moving that you did not cause.

## What the take can and cannot do

These come from `transform/src/zoom.ts` and are why the beats below look the
way they do.

- **A click or a drag opens a zoom. A plain move never does.** A whole take of
  hovering produces no zoom at all. Every zoom you want needs a click.
- Window = **300 ms before** the click to **2.5 s after** the last one. Clicks
  closer than **2.5 s** merge into ONE window — no pull-out between them.
  So: either click twice within 2.5 s on purpose (one held zoom), or leave
  **3 s+** between clicks you want as separate zooms.
- A **drag is one window**, however long. A ten-second drag stays zoomed for
  its whole length plus 2.5 s. This is the open question in `zoom.ts` — a
  *short* drag is the safe choice for this take.
- **Keystrokes do not trigger** (STC-327, not built). Typing never zooms; the
  click into the field does.
- Where it zooms comes from the change track if the take has one (none do
  today, no tool runs STC-322's pass here), else cursor clustering. Expect the
  **cursor-cluster fallback**: it frames where the cursor was. So the crop
  follows your cursor, and the UI you click should be near what you want
  seen. A crop is clamped to 50–70 % of the frame per axis.
- A cluster that already covers most of the frame becomes "don't zoom". Don't
  click at opposite corners inside one window.

## Pre-flight

1. **Freeze check** (`docs/PRE-DEMO-CHECKLIST.md`): `npm ls electron` matches
   `package.json`. No `npm install` since.
2. Launch the real app via `open`, not `npm run app:start`. System Settings →
   Privacy & Security: **Screen Recording** and **Input Monitoring** both list
   Electron, both checked. Relaunch after granting.
3. **STC-421 is Done** (cursor now follows the crop), but nobody has watched
   it on this take. Item 8 below is where you do.
4. **Pick the surface.** Needs: a screen with a few distinct controls spread
   over the frame, so a zoom has somewhere to go and the framing changes
   between zooms. The Music Network (`/lab/network?period=6month`, loaded
   first, never click a period button on camera) is the known candidate and
   STC-421 validated against it, but it is mouse-motion-heavy and its own
   graph keeps animating after a click — that animation is *change*, which is
   what stage 2 misreads. If its nodes keep drifting under the crop, use a
   static UI instead (a settings screen, a form, a docs page).
5. **Clear the noise.** Do Not Disturb on. Quit Slack, Mail, Messages, any
   menu-bar app that updates. Hide the Dock and desktop icons, close every
   window except the surface. Clock in the menu bar ticks — that is a change
   source; the transform records the display, so hide it or accept it.
   No call software, no screen-share indicator.
6. **Display and legibility.** Which display you record is the one thing you
   cannot fix afterwards (STC-318: the output width cancels). Record a display
   whose logical width puts the surface's text at **9 px or more** in the
   embed — a retina display at ~1728 points clears it, a 4K desktop at 3840
   does not. Set the **text size (pt)** in the editor to the surface's real
   base size; the app shows the figure and warns below 9.
7. **Camera off. Mic off** unless the clip is narrated. Cursor is excluded at
   capture by design; it is drawn at export.
8. **Rehearse once, off the record**, and note which clicks you will make.
   Then start the real take.

## The beats (target 45 s, ~5 zooms)

Adapt the surface; keep the timing. Each beat is a click, then **hold still
for 2 s**, so the zoom lands, holds, and eases out cleanly.

| Time | Beat | Action | Proves |
|---|---|---|---|
| 0:00–0:04 | Rest | Full frame, cursor parked, nothing moving. Poster frame. | The baseline is calm |
| 0:04–0:12 | Zoom in 1 | Cursor to a control on one side. Click it. Hold 2 s. | It finds the action |
| 0:12–0:16 | Out | Hands off. Wait for the full frame. Count 3 s from the click. | It lets go |
| 0:16–0:24 | Zoom in 2 | Click a control on the **opposite** side. Hold 2 s. | The framing moves |
| 0:24–0:28 | Out | Hands off. Wait. | |
| 0:28–0:38 | Held zoom | Two or three clicks **under 2 s apart** in one area. | Clicks merge: one zoom, no flapping |
| 0:38–0:45 | Drag | One **short** drag (under 2 s). Release, hold. | A drag is one window |
| 0:45–0:50 | Rest | Hands off, full frame, 3 s. Stop. | |

Start **post-settle**: anything still animating when you press record becomes
a false trigger source. Hands off the trackpad for the last 3 s so the take
does not end mid-zoom.

## After the take

1. Open it in the editor. Zoom lane: **one block per beat above, no extras.**
   An extra block is a false trigger — note the timestamp and what was on
   screen. A missing one means the click was inside a merge window of the
   previous.
2. **Watch it end to end at the Viewer's eye size**, preview *and* export. For
   each zoom check: the cursor stays on the control it was over through
   zoom-in, hold and zoom-out (this is STC-421's acceptance, not yet watched on
   hardware), the crop contains what you clicked and what it caused, and the
   pull-out does not land mid-gesture.
3. Wrong crop on one window: use the manual override (STC-330) — drag a
   rectangle on that block. That is a legitimate fix for a *demo asset*; say
   so in the ticket rather than hiding it, because "auto-zoom got it right
   unaided" is the claim the clip is for.
4. **Export**: Export size → `Embed 2× · 2464×1386` (on a 4K capture), per
   STC-313. Looking at it at that size is the point.
5. `node scripts/export-one.mjs <sessionDir> [seconds]` if you want a quick
   watchable file without the app.
6. **Keep the take** (it becomes a fixture for STC-319/405) — leave it in the
   library, do not delete.

## What closes the ticket

- [ ] One take of 30–60 s, no extra zoom blocks, no call UI or notifications
- [ ] Watched at embed size: cursor attached through every zoom (STC-421 on
      real hardware) — report here if it is not, that is its own ticket
- [ ] Exported at demo resolution; file and take location written on the
      Linear ticket
- [ ] Any hand-corrected window listed, if there were any

## What only a person can settle

- Whether a 2.5 s hold reads as deliberate or as lingering on this surface.
- Whether the cursor-cluster crop frames what matters, or just where the
  mouse was. If the crop is mostly *wrong*, that is a finding for STC-326,
  not a reason to hand-fix the whole clip.
- Whether the Music Network's own animation is poison here (step 4 above). If
  it is, that finding is exactly STC-405's.
