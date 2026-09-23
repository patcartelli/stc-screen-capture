# Pre-demo checklist (STC-406)

Why this exists: until packaging ships (STC-401), this app has no bundle
identity of its own — macOS grants Screen Recording and Input Monitoring to
the **Electron binary**, keyed to its code signature. Reinstalling
`node_modules`, or letting `npm install`/`npm update` bump Electron, changes
that binary and can silently revoke both grants, with no error until the
next capture attempt fails. `tools/test-host` and `docs/STC-292-RUNBOOK.md`
already document the underlying fragility; this is the standing procedure
for not hitting it in front of someone.

The ticket's own wording says "accessibility grants." That is not quite
right and this doc uses the correct name: STC-315 established the second
grant this app needs is **Input Monitoring** (for the cursor event tap), not
Accessibility — nothing in this app's hotkey path (STC-292, Carbon
`RegisterEventHotKey`) needs Accessibility at all. Don't go looking for the
wrong pane in System Settings.

## The freeze (start the week before)

1. **Stop touching dependencies.** No `npm install`, no `npm update`, no
   deleting and reinstalling `node_modules`. If `node_modules` is already
   present and working, leave it alone.
2. If you must install fresh (a new checkout, a broken `node_modules`), use
   `npm ci`, never `npm install` — `npm ci` installs exactly what
   `package-lock.json` resolves and refuses to run at all if the lockfile
   and `package.json` have drifted apart, rather than silently reaching for
   a newer version.
3. Confirm the pin actually matches what's installed:
   ```
   npm ls electron
   ```
   The printed version must equal `package.json`'s `devDependencies.electron`
   (pinned exact, no `^`, as of this ticket). A mismatch here means
   something reinstalled outside the freeze — rebuild from `npm ci` before
   going further.
4. Do this once at the start of the freeze week, and again the morning of
   the demo — a `git pull` or a teammate's branch switch is enough to have
   silently changed `node_modules` underneath you.

## Day-of, before anyone is watching

1. Launch the real app via `open`, not `npm run app:start` from a terminal
   — a bare terminal launch inherits the terminal's own TCC identity and
   proves nothing about the shipped app's grants (`tools/test-host` exists
   for exactly this reason; see CLAUDE.md's "A bare CLI binary has a
   different TCC identity than a bundle").
2. Open **System Settings → Privacy & Security → Screen Recording**.
   Confirm **Electron** is listed and checked.
3. Open **System Settings → Privacy & Security → Input Monitoring**.
   Confirm **Electron** is listed and checked.
4. If either is missing or unchecked: grant it, then **quit and relaunch**
   the app (STC-315's message says this for a reason — the grant is not
   guaranteed to apply to an already-running process).
5. **Run one real take.** Record a few seconds of real screen content with
   real cursor movement, stop, and open it in the editor. Confirm:
   - the take appears in the library (not "no anchors.json — not a
     recording");
   - the cursor is visible and tracking correctly on export (a raw
     `display.mp4` never has a cursor — export or watch it in the editor,
     not QuickTime on the raw file, per CLAUDE.md's own note on this);
   - no `-3805` or `no-displays` refusal, and no Input Monitoring warning
     dialog appears mid-take.
6. If step 5 fails for any reason, do not assume it will resolve itself —
   fix it and re-run step 5 before the demo starts. A grant that silently
   reset is invisible until the exact moment it is needed.

## What this checklist deliberately does not cover

Full packaging (a real bundle ID, entitlements that survive a rebuild
without re-signing) is STC-401's job, not this one. This checklist is a
manual pre-flight for the dev-signed binary in the meantime, not a fix for
the underlying fragility.
