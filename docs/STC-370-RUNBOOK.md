# STC-370 — region and window scope for recordings: what to run on the Mac

Written on a Linux session with no `swiftc` and no ScreenCaptureKit, so
**nothing below has run against a real display, a real window, or real
hardware.** The Swift is compiled for the first time by CI or by `helper/build.sh`
on a Mac. Every claim about how ScreenCaptureKit actually behaves — whether a
window filter really follows a moving window, whether a resize changes frame
dimensions mid-stream or simply keeps delivering the old ones, whether
`CGWindowListCopyWindowInfo` reliably reports a closed window as absent rather
than stale — is a *design decision made from documentation and the still
path's own experience (STC-289)*, not a measurement. This runbook is what
turns each one into a measurement.

## What changed

- `start` accepts `region` (`{x, y, width, height}`, display-local points,
  like `capture-still`'s `crop`) or `windowId` (a `CGWindowID`, from the
  `windows` verb) in addition to the existing `displayId`. All three are
  optional and mutually exclusive between `region`/`windowId`; no scope
  fields at all is the unchanged phase-1 behaviour (the whole display SCK
  lists first, or the named `displayId`).
- `anchors.json` gains a `scope` block (**version 3**) for a region or window
  take, naming what was actually captured — display-local points for a
  region, id/app/title/bounds for a window. A whole-display take is
  unaffected and still writes version 2 with no `scope` block at all
  (`anchorsDocument` emits the minimum version that can express the
  document, the same rule `projectForWrite`/`shotForWrite` already use).
- A window-scope take polls its own window once a second
  (`CaptureSession.windowWatchIntervalSeconds`) via `CGWindowListCopyWindowInfo`.
  A size change past half a point ends the take cleanly with
  `stop.reason: "window-resized"`; the window no longer being found ends it
  with `"window-closed"`. A pure move is ignored — the design decision is
  that `SCContentFilter(desktopIndependentWindow:)` follows the window as it
  moves, so the frames should keep arriving at the same pixel size. **This is
  the one claim in this ticket a Mac can prove wrong outright** — if a real
  window move causes SCK to reframe or resize its output, the watcher's
  "moves are safe" assumption is false and needs revisiting.
- `chooseDisplayForWindow` (which display a window belongs to) is now shared
  between the still path and the recording path, replacing a second inline
  copy that used to live in `Still.swift`.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh && tools/test-host/build.sh
npm run typecheck && npm test
```

`npm test` runs:
- the decisions harness (`parseStartRequest`, `chooseDisplayForWindow`,
  `decideWindowWatch`) — pure, no display needed;
- the anchors harness, building region-scope and window-scope documents and
  validating them against `schema/anchors-3.schema.json` with Ajv;
- `capture.test.ts`'s new request-validation cases (region+windowId
  together, a non-positive region, a malformed windowId) — these answer
  before ScreenCaptureKit is touched, so they need no grant either.

None of that proves the SCK calls themselves work. That is what is left.

## 1. Region scope, by hand

```
mkdir -p /tmp/stc-region && \
(echo '{"cmd":"start","dir":"/tmp/stc-region","region":{"x":100,"y":100,"width":800,"height":600},"seq":1}'; \
 sleep 3; echo '{"cmd":"stop","seq":2}') | helper/build/stc-helper 3>&1 | jq .
```

Expect `started` naming a `capture` roughly 800×600 (times the display's
backing scale, evenly floored) — NOT the whole display's size. After it
stops, `cat /tmp/stc-region/anchors.json | jq .scope` should show
`{"kind": "region", "region": {"x": 100, "y": 100, "width": 800, "height": 600}}`
and `.version` should be `3`. Open `display.mp4` — it must show only the
800×600 region of the screen, positioned where you asked, with no scaling
artifacts.

## 2. Window scope, by hand

```
(echo '{"cmd":"windows","seq":1}'; sleep 1) | helper/build/stc-helper 3>&1 | jq '.windows[] | select(.title != null)'
```

Pick an `id` for a real window (Finder, a browser, anything titled). Then:

```
mkdir -p /tmp/stc-window && \
(echo "{\"cmd\":\"start\",\"dir\":\"/tmp/stc-window\",\"windowId\":<ID>,\"seq\":1}"; \
 sleep 3; echo '{"cmd":"stop","seq":2}') | helper/build/stc-helper 3>&1 | jq .
```

Expect `anchors.json`'s `scope.window.id` to match, `scope.window.bounds` to
match the window's real on-screen size, and `display.mp4` to show **only**
that window — alpha is not the point here (that is the still path's
`window-only` mode; a recording still writes an opaque frame), but the
window's content should fill the frame with no desktop bleeding in around it.

## 3. The mid-take window watcher

**3a — resize, for real.** Start a window-scope recording of a resizable
window (a Finder window, a browser). While it is recording, drag a corner to
resize it. Expect: the take stops on its own within ~1 s of the resize,
`anchors.json`'s `stop.reason` is `"window-resized"`, and `display.mp4` plays
back cleanly up to that point (no corrupted trailing frames, no crash). This
is the step that tests the "moves are safe, resizes are not" design decision
for real — if SCK behaved differently before this fires (delivering
oddly-sized or torn frames), that shows up in the video.

**3b — close, for real.** Start a window-scope recording, then quit or close
the window's app. Expect the same clean stop, with `stop.reason:
"window-closed"`.

**3c — the grant test's fault-injected version, which needs no manual
resize/close at all:**

```
npx vitest run --config vitest.grant.config.ts helper/test/region-window-scope.grant.test.ts
```

The last two tests in that file use `STC_CAPTURE_FAULT=window-resized` /
`=window-closed` to make the watcher's REACTION fire deterministically
(`Capture.swift`'s `armWindowFault`, the same idiom
`stream-died.grant.test.ts` already uses for a stream that dies mid-take).
They prove the stop/sidecar-writing path works; they do NOT prove a real
resize or close is detected in the first place — 3a/3b are what prove that.

## 4. A window that moves but does not resize

Start a window-scope recording, then drag the window to a different part of
the screen (or a different display) WITHOUT resizing it. Expect the
recording to continue uninterrupted and `display.mp4` to keep showing the
window's content — this is the "moves are ignored" decision from the design
note above. If the take instead glitches, freezes on the old position, or
stops, that decision was wrong and `decideWindowWatch`/the watcher need a
size-AND-position check, not size alone.

## Open questions only a Mac can answer

- Does `SCContentFilter(desktopIndependentWindow:)` really follow a moving
  window with no code needed here at all (§4), or does it need something
  this ticket did not add?
- Does a resize actually arrive as the watcher expects — a window whose
  reported bounds changed size — or does ScreenCaptureKit itself notice
  first and do something (freeze, distort, silently keep the old frame
  size) that the polling watcher is too slow to catch cleanly?
- Is 1 Hz (`windowWatchIntervalSeconds`) fast enough that a resize is caught
  before very many wrong-sized or corrupted frames could even exist, or does
  this need to be faster?
