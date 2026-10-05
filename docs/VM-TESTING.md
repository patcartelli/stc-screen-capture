# VM testing — route clean-Mac checks through a Tart VM

Written 2026-09-29. Scripts: `tools/vm/` (their README has the mechanics). This doc
is the handoff: **when** an agent uses the VM, **how** it drives it, and **what it
hands to Patrick**.

## The rule

If a change touches any of the following, verify it in the VM before calling it done:

1. **Permissions / first run.** TCC prompts, grant handling, onboarding, anything that
   behaves differently on a Mac that has never run Capture (e.g. STC-476, STC-475).
   The dev Mac's grants are sticky and can't show this.
2. **Packaged-app smoke test.** Every change that touches `electron-builder.yml`,
   entitlements, signing, `helper/build.sh`, bundle layout, or app startup: the
   packaged `Capture.app` must launch and keep its helper alive on a clean guest.
3. **Runbook passes.** Items in a `docs/STC-*-RUNBOOK.md` "what only a Mac can settle"
   list that a VM can settle (see *What the VM can't do* below). Mark each runbook item
   as **VM** or **host** in the runbook when you run it.

Everything else (unit tests, `npm test`, gates, typecheck) stays on the host as before.

## Division of labour

**Agents run the VM. Patrick clicks.** The agent builds, boots, installs, launches,
reads logs and tears down. It stops and hands Patrick exactly what needs a human:
approving a TCC prompt, or looking at the screen. Give him a numbered checklist with
the VM name, what to click, and what "pass" looks like. Then wait for his answer and
record it.

Agents never:
- run `setup.sh` or `make-granted.sh` (they are interactive and rebuild the golden images);
- modify, boot, or delete `stc-base`, `stc-granted`, or any VM not named `stc-run-*`;
- start a VM while another `stc-run-*` VM is running (Apple's licence allows two, and
  Patrick may be using one). Check `tart list` first; if one is running, ask.

## Procedure

All commands run on the **host Mac** from the repo root (or your worktree; the
scripts resolve paths from their own location). Tart uses Virtualization.framework,
so run these **outside any sandbox**.

```bash
# 0. preconditions
tart list                        # stc-base + stc-granted present, no stc-run-* running
npm run app:package              # -> release/mac-arm64/Capture.app (npm ci first in a fresh worktree)
                                 # or: STC_VM_APP=/abs/path/Capture.app to test another build

# 1. boot a throwaway clone. fresh.sh BLOCKS for the VM's lifetime: run it in the background.
bash tools/vm/fresh.sh            # clean TCC: permissions / first-run
bash tools/vm/fresh.sh --granted  # grants already given: smoke tests, runbook passes
#    wait for "running: stc-run-MMDD-HHMMSS" and use that name below

# 2. inspect
bash tools/vm/ssh.sh <vm> 'cat /tmp/stc-capture-launch.log'
bash tools/vm/ssh.sh <vm> 'pgrep -fl Capture'
bash tools/vm/reset-tcc.sh <vm>  # revoke grants without a new clone, then relaunch

# 3. hand Patrick the checklist, wait for results

# 4. tear down. Always, even on failure.
tart stop <vm>; bash tools/vm/clean.sh
```

What `fresh.sh` proves on its own: the signature verifies on host and guest, and
Capture plus `stc-helper` stayed alive for five seconds after a Launch Services
launch. It does **not** prove a window rendered, a recording worked, or an export
succeeded. Those need Patrick's eyes, or a check you can run over SSH on the files
a take leaves behind.

## Gotchas already paid for

- **Launch via `open`, never the binary over SSH.** Processes started from an SSH
  shell are attributed to sshd for TCC, not to `com.studiocartelli.capture`. Their
  grants and prompts tell you nothing about the app. `launch-guest.sh` already does this.
- **The app is copied as a zip over scp.** Shared folders (virtiofs) choke on the
  Electron bundle's framework symlinks ("Too many levels of symbolic links").
- **`stc-granted`'s grants are keyed to the bundle ID + the "STC Dev Signing" cert.**
  If either changes, `--granted` clones will prompt again. Tell Patrick; he re-runs
  `make-granted.sh`.
- **Screen Recording needs a relaunch after it is granted.** A test that grants and then
  immediately records is testing macOS, not Capture.
- **Gatekeeper is off in `stc-base`** (`spctl --status` → assessments disabled). A VM pass
  is not evidence that a customer's Mac will accept the build.
- **Disk is tight** (~60 GB free on the host). Clones are copy-on-write but grow as they
  run. Never leave `stc-run-*` VMs behind.
- The VM window is 1280×800 (`tart set stc-base --display`). Region/geometry tests see
  that display, not the host's.

## What the VM can't do (keep on the host)

- **Camera.** No camera passthrough in Virtualization.framework, so camera PiP can't be tested.
- **Real displays.** One virtual display. Hot-plug, scaling-mode changes and multi-display
  checks (STC-235, STC-433's display half) stay on the host.
- **Real audio hardware.** Mic device selection and CoreAudio stalls (STC-233, STC-433's mic
  half) stay on the host. System-audio capture in the guest is untested; treat it as
  host-only until someone confirms it.
- **`npm run test:capture`.** Its global setup rebuilds and signs the helper, which needs
  Command Line Tools and the signing cert in the guest. Not set up.
- **Performance.** Frame drops, encode speed and memory numbers from a VM aren't comparable
  to real hardware.

## Reporting

In the PR or ticket, add a short **VM pass** block: build commit, `fresh.sh` or
`--granted`, each check with pass/fail and who observed it (agent via SSH / Patrick
by eye), and anything deferred to the host with the reason.
