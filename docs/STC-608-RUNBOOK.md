# STC-608 runbook: one set of looks for stills and video

Run from `accounts/stc-608-unify-backgrounds` until it merges.

```bash
git fetch origin && git checkout accounts/stc-608-unify-backgrounds && git pull && npm ci && helper/build.sh && npm run app:start
```

## 1. Same look in a still and a recording: PASSED (Patrick, 2026-11-03)

For each look, compare a window screenshot with a recording of the same window wearing that look. Only the background should match; padding and corners may differ.

- [x] Clean, Dark, Solid, Aurora, Ember, Custom (one colour and two colours)

## 2. Older recordings still look the same

- [ ] A recording framed Clean, Dark or Solid on `master` opens with that swatch selected and exports unchanged.
- [ ] A tinted one (Solid with your own colour, or a Clean/Dark tint) shows **Custom** and exports unchanged.

## 3. Keyboard and Custom

- [ ] On both grids: Tab lands on the selected swatch, the arrow keys move the focus, and Enter picks.
- [ ] Video Custom saves when you press Enter or leave the field (the still editor saves as you type). Does that feel deliberate?

## 4. How it looks

- [ ] The swatch grid and the Custom row fit the Frame pane without crowding Padding, Corners and Shadow.

Already passing in the agent's shell: typecheck, unit tests, `gate:still`, `gate:identity`. The e2e tests run on CI.
