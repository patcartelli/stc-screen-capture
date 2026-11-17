# STC-657 runbook: a packaged build ignores the test seams

Run from branch `accounts/stc-657-test-seams-are-live-in-the-packaged-app` until it merges, then `master`.

**Not run on a Mac.** Written and unit-tested on Linux. The three fuse checks and the signed-build check can only be settled on a packaged build.

## What changed

- `app/src/seams.ts` + `seams-boot.ts`: a packaged build deletes every `STC_*` from its environment before anything reads it. `main.ts` imports `seams-boot` first. The helper inherits the same cleaned environment, so `STC_CAPTURE_FAULT` and `STC_KEY_INJECT` never reach it either. Names removed are logged to stderr as `[seams] packaged build ignores ...` (names only, never values).
- `helper-path.ts`: a packaged build ignores `STC_HELPER_BIN` even if the scrub were skipped.
- `electron-builder.yml` `electronFuses`: `runAsNode`, `enableNodeOptionsEnvironmentVariable` and `enableNodeCliInspectArguments` are off. electron-builder flips them after packaging and before signing.

**Deliberately not done:** `onlyLoadAppFromAsar` and ASAR integrity validation. Both are worth having and both change how the app loads, so they want their own ticket and their own packaged-build check.

## Build

```bash
git fetch origin && git checkout accounts/stc-657-test-seams-are-live-in-the-packaged-app
npm ci && npm run app:package
```

For the dmg route (check 6), `npm run release:dmg -- --skip-notarize` is enough.

## Checks (yes/no)

Use the packaged `release/mac-arm64/Capture.app`, in the VM (`bash tools/vm/fresh.sh`, clean, no grants) or on the Mac. `APP=release/mac-arm64/Capture.app/Contents/MacOS/Capture`.

1. **Fuses read off.** `npx @electron/fuses read --app release/mac-arm64/Capture.app` lists RunAsNode, EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments as Disabled.
2. **RunAsNode.** `ELECTRON_RUN_AS_NODE=1 $APP -e "console.log('NODE')"` does not print `NODE`. It starts Capture, or does nothing. (Control: the same line against an unpackaged `npx electron` prints it.)
3. **NODE_OPTIONS.** `echo 'require("fs").writeFileSync("/tmp/stc657-node-options","x")' > /tmp/pre.js`, then `NODE_OPTIONS="--require /tmp/pre.js" $APP`. `/tmp/stc657-node-options` does not exist after launch.
4. **Inspect.** `$APP --inspect=9229` prints no `Debugger listening` line, and nothing listens on 9229.
5. **The seams.** On a clean VM with no grants:
   - `STC_ASSUME_PERMISSIONS=granted $APP`: the permissions panel still covers the window, and stderr names `STC_ASSUME_PERMISSIONS` as ignored.
   - A stand-in helper: `printf '#!/bin/sh\ntouch /tmp/stc657-helper\nexec sleep 60\n' > /tmp/fake-helper && chmod +x /tmp/fake-helper`, then `STC_HELPER_BIN=/tmp/fake-helper $APP`. `/tmp/stc657-helper` does not exist, and the app still works with its own helper.
   - `STC_CAPTURE_FAULT=no-event-tap $APP`, then start a take (grants on): the take records its cursor. The fault did nothing.
6. **Signed build.** After `npm run release:dmg`, `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Capture.app` passes and `spctl -a -vv` accepts it (a notarized build). The fuses were flipped before signing; if this fails, that order is the first thing to look at.
7. **Nothing else broke.** Launch normally, grant permissions, record 10 s with the camera, stop, edit, export. Quit from the menu bar.
8. **Unpackaged still works.** `npm run app:start` with `STC_RECORDINGS_DIR=/tmp/x` writes takes to `/tmp/x`, and `npm run test:e2e` is unchanged.

## If a check fails

- 2, 3 or 4 fail but 1 reads Disabled: the fuses were flipped on a different bundle than the one you ran. Check `release/` for a stale `mac-arm64` next to the dmg's.
- 5 fails: look at stderr first. No `[seams]` line means `seams-boot` did not run first; `seams.test.ts` should have caught that, so it is an esbuild ordering problem worth a bug.
- 7 fails with a crash at launch and 1 reads Disabled: the app may have relied on `ELECTRON_RUN_AS_NODE` for a child process. A `grep` found no `fork`, `utilityProcess` or `execPath` use in `app/src`, so this is not expected.
