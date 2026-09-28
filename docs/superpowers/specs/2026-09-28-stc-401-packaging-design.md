# STC-401: real packaging (bundle ID + signing that survives a rebuild)

## Why

Split off STC-397 (see `docs/TICKET-LOG.md`'s STC-397 row). There is no
packaging step in this repo today — the app runs as bare `electron .`, and
its TCC identity is Electron's own `com.github.Electron`, shared with every
other unpackaged Electron app on the machine. `docs/PRE-DEMO-CHECKLIST.md`
exists only because of this gap ("until packaging ships (STC-401), this app
has no bundle identity of its own"), and the README's "Name and identity"
section states the gap outright.

## Scope

**Dev-machine packaging, not distribution.** This ticket gives the app its
own signed bundle identity so Screen Recording / Input Monitoring grants
survive a rebuild — the same problem `helper/build.sh` already solved for
the Swift helper with the self-signed "STC Dev Signing" identity. It does
**not** cover notarization, a DMG, an installer, or anything meant to leave
this machine. If real distribution is ever needed, that is a separate
ticket requiring a paid Apple Developer Program membership and a Developer
ID Application certificate — out of scope here.

## Architecture

Add `electron-builder` as a devDependency and configure it for macOS only:

- `appId: com.studiocartelli.capture` — same namespace `tools/test-host`
  already established (`com.studiocartelli.stcsigningprobe`).
- `productName` reused from `package.json` (`"Capture"`) — already correct
  there since STC-397.
- `mac.identity`: the existing "STC Dev Signing" identity
  (`D9EA4803BB048060EB87E3EF6BF50D9A1ABAB52C`), the same certificate
  `helper/build.sh` signs with. A stable, non-ad-hoc identity is what keeps
  TCC grants alive across rebuilds (PHASE-1.md → Signing); ad-hoc signing
  is cdhash-keyed and silently revokes grants on every rebuild.
- `mac.target: dir` — just the `.app`, no DMG/zip. Nothing here is handed
  to anyone else.
- `mac.hardenedRuntime: true` with `build/entitlements.mac.plist` /
  `entitlementsInherit` — electron-builder's standard entitlements for any
  Electron app (JIT, allow-unsigned-executable-memory,
  disable-library-validation, allow-dyld-environment-variables). Nothing
  specific to this repo; this is what every packaged Electron app needs
  regardless of notarization.
- `mac.extendInfo`: `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`
  strings, reusing the exact copy `tools/test-host/STCTestHost.app`'s
  `Info.plist` already uses.
- No `mac.icon` — none exists in this repo. electron-builder falls back to
  Electron's default icon when omitted. Cosmetic; deliberately out of scope
  for a TCC-identity fix, same pattern this repo already uses elsewhere for
  a ticket's explicitly-deferred edges (e.g. STC-397's own split note).
- `directories.output: release/` (new, gitignored) — kept separate from
  `app/dist` (the esbuild bundle output) and `scratch/out`.
- No notarization (`notarize` omitted/false). Nothing here ever picks up a
  quarantine flag, so Gatekeeper's network-download check never fires.

## Scripts

New script: `npm run app:package` → runs `app:build` (existing esbuild
bundle step) then `electron-builder --mac dir --publish never`.

`app:start` is untouched — it stays the fast, unpackaged dev loop.
Packaging is an explicit, occasional step for whoever needs a
stable-identity bundle to grant permissions to, not part of every dev
cycle.

## CI

No CI changes. Packaging is not part of the test/gate suite. The repo has
already flagged its macOS Actions-minute budget as tight (STC-302's note:
"macOS bills 10x on private repos and burned ~42% of a monthly allowance in
one day" — this repo is public now, but the minutes discipline still
applies); adding a packaging step to every CI run buys nothing since no
grant needs to survive in CI.

## Documentation

`README.md`'s "Name and identity" section gets rewritten: the "no packaging
step exists" framing becomes wrong once this lands. Troubleshooting's
`tccutil reset ScreenRecording com.github.Electron` /
`tccutil reset ListenEvent com.github.Electron` become
`com.studiocartelli.capture` **for the packaged app** — the unpackaged
`app:start` path still shows as Electron under Privacy & Security, and the
README needs to say so explicitly rather than leaving one bundle ID as the
only answer when there are now two valid ones depending on how the app was
launched.

`docs/PRE-DEMO-CHECKLIST.md` is NOT rewritten by this ticket. It already
says "until packaging ships (STC-401)" and correctly scopes packaging as
someone else's job; updating its procedure to reference the new packaged
build is a natural fast-follow but not required for STC-401 to be done, and
bundling it in risks scope creep on a ticket already scoped as a
machine-day job. Flag it as a follow-up rather than doing it inline.

## Verification (real hardware available this session)

Unlike several other tickets in this repo, this session has Xcode, a real
`codesign`, and the "STC Dev Signing" identity installed — so this can be
verified end-to-end here rather than only typechecked:

1. `npm run app:package` produces a `.app` that launches.
2. `codesign --verify --deep --strict release/mac-arm64/Capture.app`
   passes.
3. `codesign -dvv` on the built app reports `Identifier=com.studiocartelli.capture`
   and the "STC Dev Signing" identity.
4. **The no-op-rebuild trap** (`docs/CORRECTNESS-TRAPS.md`: "A no-op
   rebuild is a vacuous TCC test" — swiftc/codesign are deterministic, so
   an unchanged-source rebuild produces the *same* CDHash even under
   ad-hoc signing, making a naive "did the grant survive" check pass for
   the wrong reason). This ticket avoids that trap by building twice with
   a real source change in between (not a no-op) and confirming the
   CDHash **changes** while the signing identity and bundle ID stay
   constant. That is a necessary condition for grant survival, not a
   sufficient one — see the manual step below for the sufficient one.
5. Launch via `open release/mac-arm64/Capture.app`, confirm it requests
   Screen Recording / Input Monitoring under `com.studiocartelli.capture`
   (visible in System Settings → Privacy & Security) rather than
   `com.github.Electron`.
6. Run one real take through the packaged app (record a few seconds,
   stop, confirm it appears in the library and exports) — the same "one
   real take" check `docs/PRE-DEMO-CHECKLIST.md` already prescribes,
   proving the packaged bundle is not just launchable but functional.
7. **The claim that actually matters — grant survives a rebuild — needs a
   manual step this session will attempt but may not be able to complete
   unattended**: grant Screen Recording once, rebuild with a real source
   change, relaunch, and confirm no new prompt appears and capture still
   works. Clicking the system TCC dialog needs either an interactive human
   or computer-use tooling with the user's live approval; if that proves
   impractical in this session, this step is hand-off to Patrick rather
   than silently skipped — matching this repo's existing convention for
   grant-dependent checks (`test:capture` already only runs from his
   terminal, per `docs/CORRECTNESS-TRAPS.md`).

## Explicitly out of scope

- Notarization, DMG, installer, auto-update — distribution concerns not
  needed for a dev-machine bundle.
- An app icon.
- Rewriting `docs/PRE-DEMO-CHECKLIST.md`'s procedure (flagged as a
  follow-up).
- CI packaging.
