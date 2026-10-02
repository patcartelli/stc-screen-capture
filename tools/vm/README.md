# tools/vm — test Capture in a throwaway macOS VM (Tart)

Why: TCC grants on the dev Mac are sticky, so first-run and permission flows
can't be re-seen without `tccutil` surgery. A VM clone gives a clean slate in
seconds, keeps junk takes off the host, and gives scripted runs a known state.

Runs on the host Mac. Builds happen on the HOST (`npm run app:package`) — the
guest runs a copy of the signed `release/mac-arm64/Capture.app` in
`/Applications`. The app is zipped and copied over SSH; no host folder is mounted.
Set `STC_VM_APP` to an absolute `Capture.app` path to test another packaged build.

## One-time
```
tools/vm/setup.sh          # installs Tart, pulls macOS 26 Tahoe, makes stc-base (asks for guest pw "admin" once)
npm run app:package
tools/vm/make-granted.sh   # clone -> stc-granted; you click the grants once in the VM window
```

## Repair an existing base
Run `tools/vm/setup.sh` again with `stc-base` stopped. It reuses the existing
image and private key, installs the public key if necessary, verifies key-only
SSH and passwordless sudo, and waits for a clean guest shutdown. Enter the guest
password (`admin`) if asked. It does not rebuild the app or reset TCC.

Create a NEW disposable clone afterward: existing clones do not inherit repairs.
If `stc-granted` predates the repair, recreate it with `make-granted.sh` after
retiring the old image. Do not clone a golden image while it is running.

## Every day
```
npm run app:package              # host build, as usual
tools/vm/fresh.sh                # clean TCC state: watch the permission/onboarding flow
tools/vm/fresh.sh --granted      # grants already given: straight to recording
tools/vm/ssh.sh stc-run-XXXX     # shell in / run a command
tools/vm/reset-tcc.sh stc-run-XXXX
tools/vm/clean.sh                # delete every stc-run-* VM
```

`fresh.sh` stays attached to the VM runner while you test. Keep that terminal
open; close the VM window or press Ctrl+C to stop. This also prevents agent
process supervisors from reaping an orphaned VM after the launch command exits.
The clone remains on disk until you run `clean.sh`.

## Golden images
| VM | contents | rebuild when |
|---|---|---|
| `stc-base` | Tahoe base image + SSH key | new macOS target |
| `stc-granted` | stc-base + Capture's grants | bundle ID or "STC Dev Signing" cert changes |

Clones are APFS copy-on-write, so `stc-run-*` VMs cost almost no disk until they diverge.

## Limits
- Apple's license allows 2 macOS VMs running at once; Tart enforces it.
- No camera passthrough in Apple's Virtualization framework — camera PiP can't be tested here.
- `npm run test:capture` rebuilds the helper with swiftc and signs with "STC Dev Signing",
  so it does not run in the guest as-is (needs Command Line Tools + the cert imported in the guest).

## What success means
`fresh.sh` verifies the app signature on the host and again after extraction in
the guest. It launches through macOS Launch Services, then requires the same
Capture process and Swift helper to stay alive for five seconds before printing
`running`. This checks startup only: it does not prove the window rendered or a
recording/export succeeded. Grant prompts still need your interaction.

The guest launch log is `/tmp/stc-capture-launch.log`; failures print its contents
and the paths of Capture crash reports. Read it with:
```
tools/vm/ssh.sh stc-run-XXXX 'cat /tmp/stc-capture-launch.log'
```
The host's VM boot log is `/tmp/stc-run-XXXX.log`. SSH commands fail instead of
waiting indefinitely for a password; setup is the only password bootstrap step.

## Gatekeeper and test scope
On 2026-09-29, the existing `stc-base` reported `assessments disabled` from
`spctl --status`. Setup reports that state and does not change it. This base is
for application behavior and TCC testing, not evidence that a customer Mac's
Gatekeeper will accept the package. Use a separate stock-security image and the
intended distribution-signed/notarized build for that test.
