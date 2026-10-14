# STC-530 runbook — a take the helper dies in reaches the panel

**Branch:** `accounts/stc-530-crash-take-panel` (draft PR #324). **Not on `master` yet** — run it from the branch:

```
git fetch origin
git checkout accounts/stc-530-crash-take-panel
npm ci
helper/build.sh
npm run app:start
```

## What changed

- The helper keeps `anchors.partial.json` (the stop-time anchors document minus `stop`) current from the first frame. It is rewritten atomically and coalesced, never on a timer: at each track's first sample (camera, mic, system), on pause/resume, refit, window move, and when a camera/mic disconnects. It is removed only once `anchors.json` is written.
- `recoverTake` (`app/src/recover-take.ts`) is the one recovery path: live `recording-lost`, launch recovery's `partial` kind, and a failed `anchors.json` write (STC-527). It reads where each file really ends from the media, builds the document (`recoverAnchors`), checks it with `loadSession`, and publishes `anchors.json` via a temp file (`anchors.json.recovering`) plus `link`, so it never overwrites an existing one and never exposes a half-written file. It never rejects and validates file names from the partial. A side track with no samples is dropped; a display with none refuses (the folder is left untouched).
- The new stop reason is `recorder-quit` (`schema/anchors-11.schema.json`), written only by the app. Panel line and library note come from `app/src/stop-copy.ts` (`recorder-quit` only).
- Main re-checks `quitting` after recovery. If a new take is already recording, the recovered panel is queued and shown where hidden panels come back after a capture. `recovered` sent to the renderer means "recovered on disk". The toast, when recovery fails, reads "The recorder quit while recording, and the take couldn't be recovered."

## §0 Grant tests (Patrick's terminal)

```
npm run test:capture -- helper/test/crash-partial.grant.test.ts
```

All three pass. The kill test reads the kill time from the last heartbeat, so it is lenient by up to ~200 ms; the recovered end must be within 2.5 s of the kill.

## §1 The acceptance

Start a take (Screen, ~10 s of visible motion; an on-screen clock helps). In a terminal: `pkill -9 stc-helper`.

Expect: the panel at the corner with the reason line ("Capture's recorder quit unexpectedly..."); NO "not saved" toast; Edit opens it and it plays to within ~2 s of the kill; export works. Record the gap you saw.

## §2 With mic and camera on

Same as §1 with a mic and camera chosen. Expect both tracks present and in sync up to the end. Also kill within the first second or two of a take with the camera on: the camera may be dropped, but the take must still recover.

## §3 Launch recovery

Repeat §1, but quit the app (Cmd-Q) with the panel untouched; relaunch. Expect "1 unsaved take recovered" with NO Finder sentence; Review opens the panel.

## §4 Quit during recovery

Kill the helper and press Cmd-Q immediately, before the panel appears. Expect no crash and no panel during teardown; the take is offered at the next launch (as in §3).

## §5 The deferred panel

Kill the helper, then start a new take within a second or two. The recovered panel must NOT appear while the new take records (it would be filmed). It appears after that take ends, with the other panels coming back.

## §6 The library

Save the recovered take. Its tile note reads "Recovered after the recorder quit. No cursor data."

## §7 Window drag

Window-scope take, drag the window around for 5 s, then `pkill -9 stc-helper`. The recovered take follows the window (STC-482's track survived).

## Not checked here

The disk-full panel copy (STC-531); notes for other stop reasons (STC-529).
