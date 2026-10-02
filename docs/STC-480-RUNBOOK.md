# STC-480 runbook — a tap that exists but will never deliver

**Branch:** `accounts/stc-480-input-monitoring-check` until it merges, `master` after.

## What changed

STC-315 refused a take only when `CGEvent.tapCreate` returned nil. In a clean
VM (2026-09-30) it did NOT return nil with Input Monitoring off: the take
started, and `events.json` held one cursor-shape sample and no moves or
clicks — a take with no cursor anywhere, and no warning.

`begin()` (`helper/src/Capture.swift`) now also reads the grants after the tap
is created, and refuses with the same `event-tap-unavailable` error unless one
of them is present:

- **Input Monitoring** — `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)`
- **Accessibility** — `AXIsProcessTrusted()`, which also feeds a session tap.
  Without this, a machine that records correctly today through an
  Accessibility grant alone would start being refused.

If Input Monitoring has never been asked about (`unknown`), the helper also
calls `IOHIDRequestAccess` so macOS shows its prompt, which the refusal's
toast already tells the user to expect. The decision is
`decideEventTapAccess` (`CaptureDecisions.swift`), tested in
`helper/test/decisions/main.swift`.

Nothing below has been run. It was built and unit-tested from an agent shell,
which cannot hold a capture grant.

## §1 The grant test (your own terminal)

Run it in a terminal app that holds Screen Recording and Input Monitoring.
An agent's shell does not. It can run from this branch's worktree: this
file spawns `helper/build/stc-helper` directly, not through
`tools/test-host`, and the grant config's global setup rebuilds that helper
in place.

```bash
cd ~/dev/stc-screen-recorder/.claude/worktrees/stc-480-input-monitoring-check && npx vitest run --config vitest.grant.config.ts helper/test/event-tap-required.grant.test.ts
```

**`--config vitest.grant.config.ts` is not optional.** The default config
excludes `*.grant.test.ts`, so without it vitest finds no tests to run.
That outcome is easy to misread as a pass.

Expect three passes:

- `no-event-tap` — STC-315's refusal, unchanged.
- `tap-silent` — the NEW one: the tap is created for real, the grant probe is
  faked to "neither", and the start is refused with no take directory left.
- **CONTROL** — the one that matters most. It proves the REAL probe answers
  "granted" on a machine that records. If it fails with
  `event-tap-unavailable`, the probe is misreading a real grant and this
  change must not ship.

## §2 The VM — the original repro, now expected to refuse

The bug was seen in the VM, so that is where the fix is checked:
`npm run app:package`, then `bash tools/vm/fresh.sh` (clean TCC; see
`docs/VM-TESTING.md`).

1. Grant **Screen Recording** only. Leave **Input Monitoring** off.
2. Relaunch Capture, then Record → Capture Video.
3. **Expected:** no take starts. The "Nothing was recorded" toast appears, with
   its Open Input Monitoring button. On a first attempt (never asked), macOS's
   own Input Monitoring prompt appears too.
4. Grant Input Monitoring, quit and reopen Capture, Record again. **Expected:**
   the take starts, and its `events.json` holds moves and clicks.

## §3 On the host Mac — only if you want to know whether hardware does it too

The ticket's own question, which this change no longer depends on (a refusal
is correct either way):

```bash
tccutil reset ListenEvent com.studiocartelli.capture
```

Launch the packaged app with `open`, not from a terminal. Press Record.
Before this change the question was "refused, or a silent take?"; after it,
the answer must be a refusal either way.

## §4 Not checked anywhere

- **An Accessibility-only machine** (Accessibility on, Input Monitoring off).
  The code proceeds there, on the reasoning that Accessibility also feeds a
  session tap. Nobody has confirmed that the tap really delivers in that
  state.
- **Whether `IOHIDCheckAccess` reads the right identity** when the helper is a
  child of the packaged app. It should report the responsible process (Capture),
  the same identity `tapCreate` is judged by. §1's control and §2's step 4 are
  what would show it.
