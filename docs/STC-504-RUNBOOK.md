# STC-504 — token parity for the countdown, floating panel and selection overlay

Branch: `accounts/stc-504-token-parity` (not on `master` yet — run it from there).

Values only, no layout or behaviour. The three surfaces now read colour,
radius, spacing, duration and type from `app/renderer/tokens.css`, and each
declares `<html data-surface="dark">`.

## Decisions (also written into `tokens.css`)

| Surface | Sits on | Theme |
|---|---|---|
| Selection overlay | the user's screen | dark always |
| Countdown | the user's screen | dark always |
| Floating panel | a desktop corner, over someone else's content | **dark always** (the ticket's "decide") |
| Video editor | — | dark always (STC-444); its pasted copy of the dark block is gone, it uses `data-surface` and overrides only `--bg` |

Countdown digits: were never Silkscreen (a 34px system-sans). Not elapsed take
time, so they stay out of `--font-pixel`; they are Geist now via `--type-count`.

## What changed on screen (all small; this is what to look for)

- **Floating panel + countdown:** font is Geist, not the system sans. Panel card radius 14 → 16, background alpha .82 → .86 (one shared `--card-bg`).
- **Overlay window-pick outline:** was a one-off light blue; now `--accent` / `--accent-soft`, so it matches the rest of the app.
- **Overlay bar text:** `#fff` → `--text` (`#f1f1ee`), and the dimmed states use `--text-dim` (.64) where they were .72. Legend background alpha .82 → .86.
- **Editor:** drop shadows are `--shadow-card` (.35) where they were .18/.25; lane dim and export backdrop share `--scrim` (.42).
- **Warn alert in the editor** uses `--warn` instead of its own red-orange.

## Deliberately left

- `index.html`'s pill colours (`#0b0b0c`, `#f5f5f5`, `#ff3b30`, `#3a3a3c`, `#17171a`) — `pill.ts`'s `PILL_THEME` is the owner and says "fixed, not a token"; the two are mirrors, moving one alone would split them.
- `editor.html`'s own data colours (`--clip`, `--zoom`, …) and `<input type=color value>` default.
- Off-scale one-off paddings (5px, 7px, 9px) and the 8px card `inset` (it is coupled to the window size in `*-window.ts`).

## Gate

`app/test/token-parity.test.ts` (runs in `npm test`): no raw colour in the three
pages; `data-surface="dark"` equals the `prefers-color-scheme: dark` block;
countdown not Silkscreen; and in headless Chrome each page is dark under a light
OS and its pixels change when `--accent` changes.

## Only a Mac can settle

1. Run a self-timed still and a Record: does the countdown read as before, and is Geist at 34px/600 as legible as the old system sans?
2. Capture a still over a bright window and a dark one: is the panel card readable on both (alpha .86)?
3. Window-mode overlay: is `--accent` outline visible over a bright window? (It was a lighter blue.)
4. Do the screenshot-test pixels agree with your eye — i.e. change `--accent` in `tokens.css` and watch all three change in the real app.
