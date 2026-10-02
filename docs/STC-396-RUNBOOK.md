# STC-396 — video framing presets: what to run on the Mac

**Not on `master` yet. Run this from `accounts/stc-396-video-framing-presets`:**

```
git fetch && git checkout accounts/stc-396-video-framing-presets && npm run app:start
```

Spec: `docs/superpowers/specs/2026-10-02-stc-396-video-framing-design.md`.

## What shipped

A background, padding, rounded corners and a shadow around the recording, chosen in the export dialog: None, Clean, Dark, Solid (with a colour). The frame is an INSET: the output size is unchanged and the picture is fitted inside it, so no output-size rule moved. Padding is 6% of the output's short edge, radius about 1.2%, shadow 3% blur / 1.2% offset / 0.32 opacity (Dark 0.55); the gradient stops are in `transform/src/framing.ts`. The camera PiP is anchored to the picture, not the canvas, and the pointer and the zoom crop live inside the picture too, so a zoom still lands the cursor on its target. Keycast stays on the canvas. Framing None is identical to a v13/v14 render (nothing is drawn or moved). `TRANSFORM_VERSION` 14. Data: `schema/project-15.schema.json` (`framing`, written at the minimum version that can express it). The legibility line counts the inset (it now reads "inside the frame").

## What was run and seen on this Mac (the controller, 2026-10-02)

Stated plainly, and only this:

- `scripts/export-one.mjs` on a scratch copy of the real take `2026-09-23_10-27-09` (3326x2160 capture, camera present, auto-zoom on), with `project.json` framing `{"preset":"clean"}` (4 s from t=2 s) and `{"preset":"solid","color":"#b04a2f"}` (2 s). A decoded frame of each was LOOKED AT: padded inset picture, rounded corners, soft shadow, light gradient (Clean) / flat terracotta (Solid), the camera PiP inside the picture's bottom-right with its normal margin, the pointer on the picture.
- `npm run gate:framing` passed locally for all three presets. Its first run found a real dark seam at the anti-aliased rounded corner, from an opaque shadow core; fixed in 118f096 (the shadow is drawn from an off-canvas shape, so no core shows). The tightened corner check was proven able to fail: restoring the core made it fail on clean, dark and solid.
- The framed sink-identity run (`STC_IDENTITY_FRAMING=clean`, the pip fixture recipe) passed with 0 mismatches.

**NOT run, NOT looked at:**

- The Dark preset's export, and any Embed-size (1232 px) export. Nobody has watched them.
- The editor's Frame control (`#framepreset`, `#framecolor`) was never opened or clicked: no app was run.
- Two e2e additions were written and typechecked but NEVER RUN (disruptive on the host): `app/test/preview-write-project.e2e.test.ts` (refuses malformed framing; writes a project-15) and `app/test/framing-editor.e2e.test.ts` (the control). Run them in the VM (`docs/VM-TESTING.md`) or:
  ```
  npx vitest run app/test/preview-write-project.e2e.test.ts app/test/framing-editor.e2e.test.ts
  ```
  The reviewer noted `framing-editor.e2e.test.ts`'s `isVisible`/`isHidden` checks on `#framecolor`, right after the project.json poll, may flake; switch them to `expect.poll` / auto-waiting the first time they run.

## What only a person can still judge

1. **The preset values are provisional.** 6% padding, about 1.2% radius, the shadow and the gradient stops were reasoned, not made. Judge each preset at 4K and at Embed size.
2. **Is a 6% inset too generous for a small embed?** At 1232 px the picture loses 12% of its width. If it is, lower `paddingPct` in `framing.ts`, re-pin the fingerprint, re-run `gate:framing`.
3. **Does the inset hurt legibility?** Read the legibility line in the export dialog with Frame on and off on a take with small text.
4. **Is the shadow visible at Embed size, and clean at the rounded corner in the ENCODED file** (not just the pre-encode canvas the gate reads)?
5. **The cursor staying on its target under a real zoom** in the framed export.
6. **The Frame control** matches the existing export dialog's controls. It is NOT a Figma-matched design.

## Hand-authoring an override

Presets are a starting point; explicit fields win. Edit a take's `project.json` (version 15) and run `node scripts/export-one.mjs <sessionDir> 10`:

```json
{
  "version": 15,
  "framing": {
    "preset": "solid",
    "color": "#b04a2f",
    "paddingPct": 0.04,
    "radiusPct": 0.02,
    "shadow": { "offsetYPct": 0.012, "blurPct": 0.03, "opacity": 0.4 }
  }
}
```

Merge this into the existing document rather than replacing it. Ranges: `paddingPct` 0..0.25, `radiusPct` 0..0.1, shadow `offsetYPct` 0..0.1, `blurPct` 0..0.2, `opacity` 0..1, `color` `#rrggbb`. A malformed value is refused, not defaulted.

## Commands

```
npm run typecheck
npx vitest run transform/ scripts/
STC_STILL_GATE_BROWSER=~/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell npm run gate:framing
```
