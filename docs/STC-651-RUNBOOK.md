# STC-651 — cutting a build with one command

```bash
cd ~/dev/stc-screen-recorder && git switch master && git pull
npm run release -- 1.1.0-beta.2 --dry-run   # checks only, changes nothing
npm run release -- 1.1.0-beta.2             # the real thing
```

## What it does, in order

1. **Checks** (nothing changed yet): on `master`, clean tree, HEAD equals `origin/master`, CI green on that commit, tag not taken (local or origin), version not lower than `package.json`'s.
2. **Bump.** `master` is protected, so the bump is a PR (`release/v<version>`) merged with `npm run merge`, then master is pulled and CI is checked again on the merge commit (waits up to 45 min). Skipped if `package.json` already has that version.
3. **Build.** `npm run release:dmg`: Developer ID sign, notarize, staple, `.sha256`.
4. **Tag** `v<version>`, pushed. Only after step 3 succeeded.
5. **Publish** a GitHub release with the dmg and `.sha256` (a pre-release when the version has `-beta` etc.), then reads the release back and checks both files are there at the right size. Prints the release link.

Steps 3-5 are what STC-647 did by hand; the script adds the checks, the bump and the verification.

## Where it publishes, and why not Drive

The ticket (2026-11-12) said a private Drive folder. STC-648 (2026-11-19) then shipped the tester README pointing at **GitHub releases** (`patcartelli/stc-screen-capture`), and the v1.0.1 tester build is there. The script follows what testers actually use. Note that repo is public, so a release is not private; if that matters for build 2, say so and the publish step becomes an rclone upload (Drive or R2) instead.

## Setup

- [ ] `gh auth status` is logged in with push + release rights on the repo.
- [ ] Developer ID cert and notary profile work: `xcrun notarytool history --keychain-profile capture` answers, and `security find-identity -v -p codesigning` lists one Developer ID Application.

## When it stops partway

- [ ] **Failed before the tag** (checks, bump, build, notarize): nothing is tagged or published. Fix, run the same command again. If the bump already merged, it skips the bump.
- [ ] **Tagged, publish failed:** `npm run release -- --upload 1.1.0-beta.2` publishes the files already in `release/`.
- [ ] **Red CI on the merge commit:** nothing is built. Fix master, then run again.

After a release, `docs/TESTER-README.md` still names the old version, link and checksum: swap them by hand.

## Done when (STC-651)

- [ ] Build 2 cut with `npm run release`; the release lists the dmg and `.sha256`.
- [ ] Installed on the clean-Mac check's Mac, opens with no Gatekeeper prompt (`docs/VM-TESTING.md`).

## Not run yet

Only unit-tested (`transform/test/release-plan.test.ts`: version rules, the pre-flight refusals, which CI run counts, the publish size check). The git, `gh` and Apple steps have never run end to end. The first `--dry-run` from master, then the first real build, are the test.
