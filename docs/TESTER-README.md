# Capture: tester guide

Thanks for testing Capture. This page is everything you need to install it,
let it record your screen, and send us a useful report. You don't need to know
anything about the code.

## What you need

- A Mac with **Apple Silicon** (M1 or later). Intel Macs are not supported.
- **macOS 26** or later.
- About 280 MB free for the app, plus room for recordings. Recordings get
  large quickly: a few minutes of screen can be several hundred MB.

## Install

1. Download **Capture-1.0.1-arm64.dmg** from https://github.com/patcartelli/stc-screen-capture/releases/tag/v1.0.1.
2. Check the download (see [Check the download](#check-the-download)).
3. Open the .dmg and drag **Capture** into **Applications**.
4. Open Capture from Applications. It should open without a warning, because
   this build is signed and notarized by Apple.

If macOS refuses to open it, don't work around it. Tell us what the message
says (see [Report a problem](#report-a-problem)).

### Check the download

Each release has a checksum next to the .dmg. It is a short line of letters
and numbers that proves the file is exactly the one we built. In Terminal,
from the folder you downloaded to:

```bash
shasum -a 256 Capture-1.0.1-arm64.dmg
```

The output must match this value exactly:

```
be05c9b82deeb1fd54e276996d2b5ccb4eb60c4320303b7fccdbb1b36ac4baf1
```

If it doesn't match, delete the file and download it again. If it still
doesn't match, don't open it, and tell us.

## Permissions

Capture asks for four permissions. Each one is for one thing.

| Permission | What it is for | Where to grant it |
|---|---|---|
| **Screen Recording** | Seeing the pixels on your screen. Without it there is nothing to record. | System Settings > Privacy & Security > Screen Recording |
| **Input Monitoring** | Knowing where the mouse is and when you click or press keys, so the cursor and clicks can be drawn in the video. Capture does not record what you type. | System Settings > Privacy & Security > Input Monitoring |
| **Camera** | Only if you turn on the camera bubble. | System Settings > Privacy & Security > Camera |
| **Microphone** | Only if you turn on the microphone. | System Settings > Privacy & Security > Microphone |

Notes:

- Capture asks for Input Monitoring the first time you start a video
  recording, not at launch, so expect that prompt then. It is **not** under
  Accessibility. If a recording has no cursor, check this one first.
- After you grant **Screen Recording**, macOS may ask you to quit and reopen
  Capture. Do that. The grant does not take effect until you do.
- If you turn a permission off later, you may need to grant it again.

## What to try

Work through these in order. Each one takes a minute or two.

1. **Capture an area.** Choose a region on screen and take a still.
2. **Capture a window.** Pick one window and take a still.
3. **Record a video** of the whole screen, with the picture-in-picture camera
   bubble on. Talk for a few seconds, click a few things, then stop.
4. **Find the take** in the Library and open it in the editor.
5. **Export** the take to an .mp4 file and watch it.
6. **Pick a color.** Choose Pick Color and click any pixel on screen.
7. **Capture Text.** Choose Capture Text, select an area with text, and paste the result somewhere. Capture Text is off until you give it a shortcut: Settings > Shortcuts > Tools.

## Known issues in this build

- **Permission prompt stays after you grant it.** Clear the old entries and grant again:
  ```bash
  tccutil reset ScreenCapture com.studiocartelli.capture
  tccutil reset ListenEvent com.studiocartelli.capture
  ```
  Then open Capture, grant both permissions, and relaunch.
- **Stopping from the menu-bar menu gets recorded.** If you stop a recording
  by clicking Capture's menu-bar item while it is over the area being
  recorded, that click is recorded as a click and starts an automatic zoom at
  the end of your video. Stop with the **pill** or the **keyboard shortcut**
  instead.
- **Crash when choosing "Relaunch Capture".** Seen once during testing and not reproduced since. If it happens, note the time and send us the log output from the report section below.

## How to update

1. Quit Capture.
2. Delete the old Capture from Applications.
3. Go to the same place as before, https://github.com/patcartelli/stc-screen-capture/releases,
   and download the newest .dmg (the top one).
4. Check it against the checksum shown on that release (see [Check the download](#check-the-download)).
5. Install it as you did the first time.

Your settings and recordings carry over. Settings live outside the app, and
recordings are saved to a folder you choose (by default on your Desktop, in
`stc`). Deleting the app does not delete either. [VERIFY ON THE VM, this is
from the code, not yet run.]

## Report a problem

Use the feedback form: https://github.com/patcartelli/stc-screen-capture/issues/new?template=tester-feedback.yml
(you need a free GitHub account to submit it).

Please include:

- What you were doing, and what you expected to happen.
- What happened instead, and roughly when.
- Your macOS version (Apple menu > About This Mac).
- The diagnostics: open the Library window, choose **Show diagnostics**, and
  attach a screenshot of the table it shows. Capture writes no log file, so
  this is where to look.
- A screenshot if you can take one.

Please **don't** send a recording of something private unless you have
checked it first. A bug report can describe the problem without the video.
