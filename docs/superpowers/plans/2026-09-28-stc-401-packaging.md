# STC-401 packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a real, signed bundle identity (`com.studiocartelli.capture`) that survives a rebuild, with the Swift helper shipping inside the bundle as the load-bearing piece that makes the packaged app actually work.

**Architecture:** `electron-builder` (new devDependency) packages `app/dist/` into an unsigned-for-distribution, dev-machine-only `.app`, signed with the existing "STC Dev Signing" identity `helper/build.sh` already uses. The Swift helper binary is copied into the bundle via `extraResources` and explicitly re-signed by electron-builder (`mac.binaries`); `app/src/main.ts`'s helper-path resolution is extracted into a small pure function (`app/src/helper-path.ts`) so the packaged/unpackaged branch is unit-testable without spinning up Electron.

**Tech Stack:** electron-builder, codesign, the existing esbuild bundle (`app/build.mjs`), vitest.

**Spec:** [docs/superpowers/specs/2026-09-28-stc-401-packaging-design.md](../specs/2026-09-28-stc-401-packaging-design.md)

## Global Constraints

- Dev-machine packaging only — no notarization, no DMG/zip/installer, no auto-update, no CI changes.
- `appId: com.studiocartelli.capture`; `productName: Capture` (already correct in `package.json`).
- Signing identity: `"STC Dev Signing"` (SHA-1 `D9EA4803BB048060EB87E3EF6BF50D9A1ABAB52C`) — the same certificate `helper/build.sh` already signs with. Never ad-hoc.
- No app icon — electron-builder's default is acceptable; do not source or generate one.
- `app:start` (the unpackaged dev loop) must keep working exactly as before — packaging is additive, never a replacement for it.
- Output goes to a new top-level `release/` directory, gitignored, separate from `app/dist/` and `scratch/out`.

## Review Focus

- **The packaged app launches to a blank/broken window because a runtime file `files` didn't include (a preload script, a renderer bundle) is missing from `app/dist/**/*`'s copy** — a person would expect the exact same UI as `npm run app:start`, not a silently truncated one. Covered by actually opening the packaged app and visually confirming the main window renders (Task 4), not just that the process starts.
- **The bundled helper exists but isn't validly signed**, so it fails to launch as a child process under Gatekeeper/hardened runtime the moment someone tries to record — a person would expect Record to simply work, the same as the dev build. Covered by `codesign -dvv`/`--verify` directly on the embedded `stc-helper`, not just the outer `.app` (Task 3).
- **The helper's TCC prompts appear as a second, separate entry** (e.g. under its own name) instead of rolling up under Capture — a person granting permissions once would expect one prompt, not a confusing second one they don't recognize. Covered explicitly in Task 4's launch verification.
- **`app.isPackaged` misdetection breaks the unpackaged dev loop** (e.g. `resolveHelperPath` returns the packaged-style path when running via `npm run app:start`) — a developer would expect their normal dev loop untouched by a packaging change. Covered by a unit test asserting the unpackaged branch's exact output path, plus manually re-running `npm run app:start` after the change (Task 1 and Task 3).
- **userData double-migrates or resolves to a third location** once launched from a packaged bundle for the first time — a person would expect their existing settings and unsaved takes to just be there, not silently reset. Covered by confirming `app.getName()` and `app.getPath("userData")` from the packaged app match the existing dev-build values before ever launching it against a real profile (Task 4).

---

## Task 1: Pure helper-path resolution (`helper-path.ts`)

Splits the packaged/unpackaged branching decision out of `main.ts` into a pure, unit-testable function — following this repo's existing pattern of pulling pure decisions out of Electron-coupled files (e.g. `selection.ts`, `countdown.ts`).

**Files:**
- Create: `app/src/helper-path.ts`
- Create: `app/test/helper-path.test.ts`
- Modify: `app/src/main.ts:75-76` (in Task 3, not this task — this task only creates the new module; main.ts keeps its current inline logic until Task 3 wires the new function in, so the dev loop is never broken mid-task)

**Interfaces:**
- Produces: `resolveHelperPath(opts: { isPackaged: boolean; resourcesPath: string; hereDir: string; override?: string }): string` — exported from `app/src/helper-path.ts`. Task 3 imports and calls this from `main.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/test/helper-path.test.ts
import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { resolveHelperPath } from "../src/helper-path.js";

describe("resolveHelperPath", () => {
  test("unpackaged: resolves relative to hereDir, two levels up into helper/build", () => {
    const hereDir = "/checkout/app/dist";
    const result = resolveHelperPath({ isPackaged: false, resourcesPath: "/unused", hereDir });
    expect(result).toBe(join(hereDir, "..", "..", "helper", "build", "stc-helper"));
  });

  test("packaged: resolves inside resourcesPath, flat", () => {
    const result = resolveHelperPath({
      isPackaged: true,
      resourcesPath: "/Applications/Capture.app/Contents/Resources",
      hereDir: "/Applications/Capture.app/Contents/Resources/app.asar/app/dist",
    });
    expect(result).toBe(join("/Applications/Capture.app/Contents/Resources", "stc-helper"));
  });

  test("override wins regardless of isPackaged", () => {
    const withOverride = (isPackaged: boolean) =>
      resolveHelperPath({
        isPackaged, resourcesPath: "/r", hereDir: "/h", override: "/custom/stc-helper",
      });
    expect(withOverride(true)).toBe("/custom/stc-helper");
    expect(withOverride(false)).toBe("/custom/stc-helper");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/test/helper-path.test.ts`
Expected: FAIL — `Cannot find module '../src/helper-path.js'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// app/src/helper-path.ts
/**
 * Where the Swift helper binary lives (STC-401).
 *
 * Unpackaged (`electron .`), the helper sits in the checkout at
 * `helper/build/stc-helper`, two directories up from this file's compiled
 * output (`app/dist/`). Packaged, `app/dist/main.mjs` ships inside the
 * bundle's `app.asar` and that relative path resolves to nothing outside
 * it — the helper instead ships flat under `Resources/` via
 * electron-builder's `extraResources`, reached through `process.resourcesPath`
 * rather than a path relative to this file.
 */
import { join } from "node:path";

export function resolveHelperPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  hereDir: string;
  override?: string;
}): string {
  if (opts.override) return opts.override;
  return opts.isPackaged
    ? join(opts.resourcesPath, "stc-helper")
    : join(opts.hereDir, "..", "..", "helper", "build", "stc-helper");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/test/helper-path.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (this file falls under `tsconfig.node.json`'s `app/src/**/*.ts` glob automatically — no config change needed).

- [ ] **Step 6: Commit**

```bash
git add app/src/helper-path.ts app/test/helper-path.test.ts
git commit -m "STC-401: extract helper-path resolution into a pure, tested function"
```

---

## Task 2: electron-builder config producing a signed, unpackaged-for-distribution `.app`

Gets a real `.app` building and correctly signed before touching `main.ts` at all — isolates "does packaging work" from "does the helper ship correctly" (Task 3).

**Files:**
- Modify: `package.json` (add `electron-builder` devDependency, add `app:package` script)
- Create: `electron-builder.yml`
- Create: `build/entitlements.mac.plist`
- Modify: `.gitignore` (add `release/`)

**Interfaces:**
- Consumes: `app/dist/**/*` (existing `app:build` output), `package.json`'s `productName`.
- Produces: `release/mac-arm64/Capture.app` when `npm run app:package` is run. Task 3 and Task 4 both consume this path.

- [ ] **Step 1: Install electron-builder**

```bash
npm install --save-dev electron-builder
```

- [ ] **Step 2: Confirm the exact config field names against the installed version**

This repo's own `docs/CORRECTNESS-TRAPS.md` exists because guessed config shapes silently produce the wrong thing. Before writing `electron-builder.yml`, check the installed version's own type definitions rather than relying on memory:

```bash
grep -n "binaries" node_modules/app-builder-lib/out/options/macOptions.d.ts
grep -n "hardenedRuntime\|entitlements\b\|entitlementsInherit" node_modules/app-builder-lib/out/options/macOptions.d.ts
```

Confirm `mac.binaries: Array<string> | null` (paths of extra binaries to sign, relative to the built app's `Contents/MacOS` or absolute) and the entitlements field names exist as expected. If the installed version's shape differs from what's written below, use the installed version's actual field names — note the discrepancy in the commit message for this task.

- [ ] **Step 3: Write the entitlements file**

```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 4: Write the electron-builder config**

```yaml
# electron-builder.yml — STC-401. Dev-machine packaging only: this produces
# a signed .app for local use, keeping TCC grants alive across rebuilds the
# same way helper/build.sh already does for the Swift helper. No
# notarization, no DMG/zip, no auto-update — see the design spec.
appId: com.studiocartelli.capture
productName: Capture
directories:
  output: release
files:
  - app/dist/**/*
  - package.json
mac:
  target:
    - target: dir
  identity: "STC Dev Signing"
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  extendInfo:
    NSCameraUsageDescription: "Capture records a camera picture-in-picture alongside the screen."
    NSMicrophoneUsageDescription: "Capture records a microphone track alongside the screen."
```

(`mac.binaries` and `extraResources` for the helper are added in Task 3, not here — this task only proves the Electron shell itself packages and signs correctly.)

- [ ] **Step 5: Add the npm script**

Edit `package.json`'s `"scripts"` block, adding after `"app:start"`:

```json
"app:package": "npm run app:build && electron-builder --mac dir --publish never",
```

- [ ] **Step 6: Gitignore the output directory**

Add to `.gitignore`, in the "build output" section near `app/dist/`:

```
release/
```

- [ ] **Step 7: Build and verify**

```bash
npm run app:package
```

Expected: succeeds, produces `release/mac-arm64/Capture.app` (arch directory name may differ — use whatever electron-builder actually names it).

```bash
codesign --verify --deep --strict release/mac-arm64/Capture.app && echo VERIFY_OK
codesign -dvv release/mac-arm64/Capture.app 2>&1 | grep -E "Identifier|Authority|TeamIdentifier"
```

Expected: `VERIFY_OK`, `Identifier=com.studiocartelli.capture`, an `Authority=STC Dev Signing` line.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json electron-builder.yml build/entitlements.mac.plist .gitignore
git commit -m "STC-401: package a signed .app with electron-builder"
```

---

## Task 3: Ship the helper inside the bundle

The load-bearing task per the ticket — without this, the packaged app from Task 2 launches but Record does nothing, because `main.ts` can't find the helper.

**Files:**
- Modify: `electron-builder.yml` (add `extraResources`, `mac.binaries`)
- Modify: `app/src/main.ts:68-76` (replace the inline `HELPER` computation with `resolveHelperPath`)

**Interfaces:**
- Consumes: `resolveHelperPath` from Task 1 (`app/src/helper-path.ts`).

- [ ] **Step 1: Wire `main.ts` to the new function**

Replace (around `app/src/main.ts:68-76`):

```typescript
const here = dirname(fileURLToPath(import.meta.url));
/**
 * Overridable for the same reason STC_RECORDINGS_DIR is: the E2E suite needs to
 * drive the real start path against a stand-in, because the real helper cannot
 * record without a Screen Recording grant and CI has no way to give one. Also
 * useful for pointing the app at a debug build.
 */
const HELPER = process.env.STC_HELPER_BIN
  || join(here, "..", "..", "helper", "build", "stc-helper");
```

with:

```typescript
const here = dirname(fileURLToPath(import.meta.url));
/**
 * Unpackaged vs packaged resolution lives in `resolveHelperPath`
 * (STC-401) so it's unit-testable without Electron. Overridable via
 * STC_HELPER_BIN for the same reason STC_RECORDINGS_DIR is: the E2E suite
 * needs to drive the real start path against a stand-in, because the real
 * helper cannot record without a Screen Recording grant and CI has no way
 * to give one. Also useful for pointing the app at a debug build.
 */
const HELPER = resolveHelperPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  hereDir: here,
  override: process.env.STC_HELPER_BIN,
});
```

Add the import near the other local imports (alongside `capture-identity.js`):

```typescript
import { resolveHelperPath } from "./helper-path.js";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes — `app.isPackaged` and `process.resourcesPath` are both already-imported/ambient Electron/Node types.

- [ ] **Step 3: Confirm the unpackaged dev loop still works**

```bash
npm run app:start
```

Expected: app launches exactly as before (same as pre-change behavior — this is a regression check, not a new feature). Quit the app when confirmed.

- [ ] **Step 4: Add the helper to the packaging config**

Edit `electron-builder.yml`, adding under the top-level keys (alongside `files`):

```yaml
extraResources:
  - from: helper/build/stc-helper
    to: stc-helper
```

And under `mac:` (exact key path confirmed against the installed version's types in Task 2 Step 2):

```yaml
mac:
  # ...existing keys...
  binaries:
    - Resources/stc-helper
```

(If Task 2's type check found `mac.binaries` expects a different path shape — e.g. relative to `Contents/` rather than `Contents/Resources/` — use that shape instead; this is exactly the kind of guess CORRECTNESS-TRAPS.md warns against, so verify against Step 5's actual signature output rather than trusting the YAML alone.)

- [ ] **Step 5: Build and verify the embedded helper is present and correctly signed**

```bash
helper/build.sh   # make sure helper/build/stc-helper exists and is current
npm run app:package
ls release/mac-arm64/Capture.app/Contents/Resources/stc-helper
codesign -dvv release/mac-arm64/Capture.app/Contents/Resources/stc-helper 2>&1 | grep -E "Identifier|Authority"
```

Expected: the file exists, and `codesign -dvv` reports an `Authority=STC Dev Signing` line (the same identity as the outer app, from Task 2 Step 7) — not ad-hoc (`Signature=adhoc`) and not the CLI-checkout's own leftover signature from `helper/build.sh`'s direct run.

- [ ] **Step 6: Commit**

```bash
git add app/src/main.ts electron-builder.yml
git commit -m "STC-401: ship the Swift helper inside the packaged bundle"
```

---

## Task 4: Real-hardware verification (launch, permissions, one real take)

This is the task that actually proves the ticket's acceptance criteria, not just that the pieces compile. Run these on this machine, which has real signing tools and the "STC Dev Signing" identity installed.

**Files:** none (verification only; may produce a short findings note appended to this plan's PR description, not a new doc).

- [ ] **Step 1: Confirm Spotlight/Raycast indexing**

```bash
mdimport release/mac-arm64/Capture.app
sleep 2
mdfind "kMDItemCFBundleIdentifier == 'com.studiocartelli.capture'"
```

Expected: the query returns the `.app` path. (Acceptance: "Spotlight and Raycast find it by typing `capture`" — Raycast reads the same Spotlight index, so this is the checkable proxy for both.)

- [ ] **Step 2: Confirm `app.getName()` / userData consistency before ever touching a real profile**

```bash
STC_HELPER_BIN=$(pwd)/helper/build/stc-helper open -W -n release/mac-arm64/Capture.app --args --user-data-dir=/tmp/stc-401-userdata-check
```

If `open --args` doesn't pass through to the Electron process cleanly, instead launch directly and inspect logs:

```bash
release/mac-arm64/Capture.app/Contents/MacOS/Capture --user-data-dir=/tmp/stc-401-userdata-check &
sleep 3
ls /tmp/stc-401-userdata-check
kill %1
```

Expected: a `Capture` folder-worth of contents appears at that path (confirms `app.getName()` reports "Capture" from the packaged bundle, same as the unpackaged dev build already does — per `app/src/product.ts` and `rename-migration.e2e.test.ts`'s existing coverage of this exact property, just now exercised from the packaged binary instead of `electron .`).

- [ ] **Step 3: Launch for real and check for one Privacy & Security entry, not two**

```bash
open release/mac-arm64/Capture.app
```

Manually (this step needs a human or computer-use with live approval — see the spec's verification section): try to Record. When the Screen Recording / Input Monitoring / Camera / Microphone prompts appear, grant them. Then check:

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
```

Expected: **Capture** is listed (not Electron, not a second "stc-helper" entry). Repeat the check for Privacy_ListenEvent (Input Monitoring), Privacy_Camera, Privacy_Microphone panes.

- [ ] **Step 4: Run one real take through the packaged app**

Record a few seconds of real screen content with cursor movement, stop, open it in the editor. Confirm (matching `docs/PRE-DEMO-CHECKLIST.md`'s existing "one real take" check):
- the take appears in the library;
- the cursor is visible and tracking correctly on export;
- no `-3805` or `no-displays` refusal, no Input Monitoring warning mid-take.

- [ ] **Step 5: Rebuild-identity check (the no-op-rebuild trap)**

```bash
codesign -dvv release/mac-arm64/Capture.app 2>&1 | grep CDHash > /tmp/cdhash-1.txt
# Make a real, trivial source change so this isn't a no-op rebuild:
echo "// STC-401 rebuild check $(date +%s)" >> app/src/main.ts
npm run app:package
codesign -dvv release/mac-arm64/Capture.app 2>&1 | grep CDHash > /tmp/cdhash-2.txt
diff /tmp/cdhash-1.txt /tmp/cdhash-2.txt && echo "SAME CDHASH — rebuild was a no-op, this check proves nothing" || echo "CDHash changed as expected"
codesign -dvv release/mac-arm64/Capture.app 2>&1 | grep Authority
git checkout app/src/main.ts   # revert the throwaway comment
```

Expected: "CDHash changed as expected", and the `Authority=STC Dev Signing` line is unchanged between the two builds — the necessary condition for a rebuild not to revoke TCC grants. (The sufficient condition — an actual granted permission surviving — is Step 3/4 combined with a rebuild; if time allows, redo Step 3's grant check after this rebuild without re-granting anything, to close the loop for real. If that additional pass isn't practical in this session, say so plainly rather than claiming it was proven.)

- [ ] **Step 6: Record findings**

No code changes in this task beyond the reverted throwaway line — note the outcome of each step (especially Step 5's closing-the-loop attempt) in the task's own commit message or PR description, not silently.

---

## Task 5: README corrections

**Files:**
- Modify: `README.md` (the "Name and identity" section and "Download and Install" section, lines ~53-56 and ~174-232 per the current file — re-check exact line numbers before editing, since Tasks 1-4 don't touch this file but earlier commits in this branch might shift other sections)

- [ ] **Step 1: Rewrite "Name and identity"**

Replace the section's claim that "there is no packaging step in this repo" and the `com.github.Electron`-only framing with: packaging now exists (`npm run app:package`, electron-builder), the packaged app's real identity is `com.studiocartelli.capture`, and — this is the part that must not get simplified away — **the unpackaged `npm run app:start` dev loop still shows up as Electron / `com.github.Electron`** under Privacy & Security, because that path never runs through electron-builder at all. State both identities and when each applies, rather than replacing one wrong single answer with a new, differently wrong single answer.

Update the `tccutil reset` examples in Troubleshooting to show both forms:

```bash
# Packaged app (npm run app:package):
tccutil reset ScreenRecording com.studiocartelli.capture
# Unpackaged dev loop (npm run app:start):
tccutil reset ScreenRecording com.github.Electron
```

(Same pairing for `ListenEvent`.)

- [ ] **Step 2: Fix "Download and Install"**

Replace the claim that a `.dmg` exists on GitHub Releases with an accurate statement: the app is built from source today (`npm run app:package` after cloning), no signed release is published, and why (dev-machine-only signing identity — see the design spec if a fuller explanation is wanted; the README itself should stay short here, not re-explain the whole ticket).

- [ ] **Step 3: Proofread**

```bash
grep -n "com.github.Electron\|com.studiocartelli.capture\|GitHub Releases\|\.dmg" README.md
```

Read every matched line in context; confirm nothing still asserts something that isn't true after this ticket (a dangling DMG reference, a Troubleshooting step that now points at the wrong bundle ID for its own context).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "STC-401: README reflects real packaging (bundle ID, no DMG yet)"
```

---

## Final: whole-branch check

- [ ] **Run the full suite before calling this done**

```bash
npm run typecheck
npm test
```

Expected: both pass, with no new failures relative to `master`. (`npm run app:package`'s real-hardware verification in Task 4 is not part of this — it needs a Mac with the signing identity installed, same category as `npm run test:capture`.)
