# STC-410 — Demo asset: the pill clip

A recording session, not a build. The clip is the backup for the live Record
step if the pill turns out to be hidden from screen shares (STC-404), and the
primary asset for async formats. **Capture cannot record its own pill** (the
helper's filter excludes the app's windows), so this is shot with an
EXTERNAL recorder.

Run it from `master` — STC-375 (the pill) and STC-447 (the pill's ring and
hover tint, #252) are both merged. Linear still lists STC-447 as a blocker;
that ticket was about the options bar plus the ring, and the ring is the part
this clip shows. Re-check the ticket before recording if the bar's look is
still moving.

**Done means a file Patrick would send to a stranger: one clean take, under
~30 s, no notification banners, no desktop clutter.** A file on disk that was
never watched back is not done.

---

## 0. Pre-flight (do all of it before pressing anything)

### The build

```
git checkout master && git pull
helper/build.sh
npm run app:start        # or the packaged .app, see "Which build" below
```

**Which build.** Use `npm run app:start` unless the clip is meant to show the
packaged app (menu-bar icon, real bundle name). The packaged one
(`npm run app:package`) is signed with a different identity, so its first
launch may re-prompt for Screen Recording / Input Monitoring — grant those
**off camera, beforehand**, then quit and relaunch.

### The machine

- [ ] **Do Not Disturb / a Focus on.** One banner mid-take ruins it, and
      Notification Center is exactly where one lands in a pill-sized clip.
- [ ] **Desktop clean.** Hide desktop icons or use a plain wallpaper; the pill is dark
      and always floats on top of whatever is behind it, so a busy light background
      is the worst case and a plain one is the best.
- [ ] **Menu bar tidy.** Quit chat apps, VPN badges, anything that updates a
      menu-bar item during the take. Auto-hide the menu bar if the clip shows
      none of it.
- [ ] **Dock** hidden or small, away from where the window sits.
- [ ] **A real appearance chosen on purpose** — light or dark, pick one and
      keep it for the whole session. If budget allows, shoot both ("Takes to bank", §1).
- [ ] **One display connected**, unless a second is the point. Mission Control
      "Displays have separate Spaces" is a setting that changes what the Space
      switch looks like; note which way it is set.
- [ ] **Two Spaces ready** for the switch beat: Space 1 holds Capture, Space 2
      holds one plain, quiet app window (a text editor or a browser on a static
      page). Nothing animating, nothing with the user's name or a private tab on it.
- [ ] **Capture's own state.** The main window at its default 520x680, placed
      where it will look good, camera and mic **off** (less to explain; the
      pill's meter is hatched either way). Library tidy or irrelevant, since it
      is out of frame once collapsed.
- [ ] **Permissions already granted** (Screen Recording, Input Monitoring).
      A permission dialog on camera is a re-shoot.

### The external recorder

Pick one and stay with it. Capture itself is not an option.

| recorder | use when | note |
|---|---|---|
| macOS **Cmd-Shift-5**, "Record Selected Portion" | default | Free, no install. Choose "Options → Show Mouse Clicks" off unless you want them. Stop with the menu-bar button or Cmd-Ctrl-Esc |
| QuickTime Player, "New Screen Recording" | same result | Slightly clunkier stop; same pixels |
| OBS / other | only if you already run it | More to configure, more to leak into frame |

- [ ] **Record the region, not the whole display**, with margin round the window
      and room above for the pill's collapse position. Whole-display is fine for
      the Space-switch variant (shot 5), since the point there is the Space.
- [ ] **Do a 5-second test first, and WATCH IT BACK.** The one thing nobody has
      verified is that an external recorder sees the pill at all. STC-404 is
      precisely the worry that it is invisible in Zoom/Meet shares. If the pill
      is missing from a Cmd-Shift-5 test, **stop: the ticket's premise changed.**
      That is a finding for STC-404, not a failed take. Write down what you saw
      (which recorder, which macOS) and put it on that ticket before anything else.
- [ ] Frame rate/resolution: native display resolution; if the recorder offers a
      choice, take the highest. This is a small clip; size is not a concern.

### Rehearse once, unrecorded

Run §1's beats end to end with the recorder off. The timings below are
targets; a rehearsal tells you where your hand is slow. In particular find the
**stop click**: the pill is the ONLY control while collapsed (no hotkey covers
stop), and its whole surface is the hit target.

---

## 1. The shot list

Target **20–30 s**. Hold every state longer than feels natural; trimming is
free, a missing frame is a re-shoot.

| # | time | beat | action | what the frame must show |
|---|---|---|---|---|
| 1 | 0:00–0:03 | **At rest** | Recorder running, Capture's main window idle, pointer parked off the window | The full window, traffic lights visible, Record button. Establishes "this is a normal app" |
| 2 | 0:03–0:04 | **Record** | Click Record (the scope overlay appears; take the default or a quick Screen pick, the choice is not the subject) | Whatever overlay shows, brief. If the countdown runs, let it. 3, 2, 1 is on-brand and is also settling time |
| 3 | 0:06–0:10 | **Collapse** | The window becomes the pill | The snap itself (it snaps, it does not animate), then the pill in its place: red dot, `mm:ss` timer moving, hatched meter, stop square. **Hold 3 s** so the timer visibly ticks |
| 4 | 0:10–0:16 | **Something happens behind it** | Move the pointer, click around the plain app window behind it | The pill staying put, always on top, not stealing focus. This is the "why a pill" beat: it stays out of your way while you work |
| 5 | 0:16–0:21 | **Space switch** *(optional)* | Three-finger swipe to Space 2 and back, or Ctrl-arrow | The pill **follows to the new Space**. Keep it only if it reads clearly (see below). Recorder must be a whole-display or a region on the right Space |
| 6 | 0:21–0:24 | **Stop** | Click the pill | The timer freezing at a plausible number. Do not hurry the click; let the pointer visibly arrive on the pill first |
| 7 | 0:24–0:28 | **Restore** | The window comes back | Back to the exact position and size it left from, traffic lights returned, the new take appearing in the library. **Hold 2 s on the restored window** |

### Keep the Space switch only if it reads

A Space switch is a lot of motion, and a 20 s clip can spend its whole
length being "a desktop sliding sideways." Judge on playback: keep it if
the pill is clearly still there, in the same corner, through the slide. Cut
it if the swipe animation dominates, or if the recorder itself got left
behind on the other Space (the classic whole-display gotcha). If it is cut,
the clip is beats 1–4, 6–7. If it is kept, ship **both** cuts: a short one
without and a longer one with.

### Takes to bank

Shoot several; the second or third usually beats the first.

| take | variation | why |
|---|---|---|
| A | Light appearance, light wallpaper | The worst case for a dark pill; the ring's job (STC-447) |
| B | Dark appearance, dark window behind | The ring should not read as a second colour |
| C | Shot A with the Space switch | The optional beat |
| D | The camera ON | Only if the camera is part of the demo story. It adds a ~1.3 s late open (STC-287) that can land on the collapse. Not needed for the pill itself |

---

## 2. What ruins a take

Check each against the playback, not against memory.

- **A banner or badge** anywhere in the region. Notification Center, a Dock bounce, an
  update nag, the menu bar clock ticking across a minute boundary is fine; a red "1" is not.
- **The pill clipping.** If it is ever drawn clipped or with controls spilling out of 26 px,
  that is a regression (it was a real bug on 2026-09-14, fixed the same day); it is a finding,
  not a retake. Note it for STC-375.
- **The ring hugging the digits.** The 2026-09-29 first look caught this once; a re-occurrence
  means `100vw`/`100vh` fell off the collapsed pill. Also a finding.
- **Restore landing somewhere else.** It must return to where it was, on the display it
  collapsed from. Anything else is a bug, not an edit.
- **A `-3805` or any capture failure** at collapse. Stop and report; see the STC-375
  runbook, §4.
- **Pointer leaving the region** or coming in from off-frame mid-beat.
- **The private bits.** Library thumbnails of older takes, window titles, tab names,
  anything under Space 2 that belongs to someone.

---

## 3. After the take

1. Watch it back **at full size and at the size it will be shared at**. The pill is
   26 px tall; if it cannot be read at the shared size, say so, because that is the real
   answer to whether the clip works as a backup.
2. Trim to the shot list's beats. No captions are needed; if one is, keep it to a
   few words.
3. Save the original untrimmed capture beside the export; do not commit a screen
   recording to this repo (no `.mov` or `.mp4` here besides fixtures). The published file lives with
   whatever consumes it, on the site side, as STC-313's demos do.
4. **Report on STC-410**: which recorder, which take was kept, whether the Space
   switch made the cut, and the answer to the §0 test: **does an external recorder see
   the pill?** If it did not, that answer matters more than the clip.

## What only a person can settle

Everything here. No automation drives a Space switch or watches a pill; the
helpful parts are the ones the checklist front-loads: the 5-second test,
the rehearsal, and the playback check against §2.
