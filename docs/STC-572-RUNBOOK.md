# STC-572 runbook: Capture Text (OCR)

Run from branch `accounts/stc-572-capture-text-ocr` (not on `master` yet) until it merges. Then `master`.

```bash
git fetch origin && git checkout accounts/stc-572-capture-text-ocr
helper/build.sh && npm run app:start
```

Sections 2-4 are **host**: they need a real display and a Screen Recording grant. Section 5 is best done on the **packaged app in the VM**, because it needs a helper binary Vision has never seen.

## What was built

- **Action:** "Capture Text", unbound by default (Settings > Shortcuts > Tools, under Pick Color), and in the menu bar. It opens the same overlay as Shot Area (`selectRegionOrWindow`, region mode; the overlay's own toggle still reaches window mode).
- **Helper:** `recognize-text` takes `capture-still`'s scope (`parseTextRequest`, sharing `parseScope` with `parseStillRequest`), captures through the same `StillCapture`, then runs Vision on the frame in memory (`TextRecognize.swift`: `.accurate`, language correction, automatic language detection). **No directory, nothing written**, so nothing can reach the library.
- **App:** `app/src/ocr-text.ts` is the pure step: Vision's lines, in Vision's order, trailing whitespace off, blank lines dropped, joined with `\n`. Never reflowed (Patrick, 2026-11-03). Recognised text goes on the clipboard with a toast showing the first line (cut at 80 characters). Nothing recognised says "No text copied" and does **not** touch the clipboard. A failure says "Couldn't capture text" and why.
- **Warm-up:** main sends `warm-text` whenever a helper comes up (Patrick, 2026-11-03), because of §1.

## 1. The cold-Vision measurement (done, 2026-11-03, this Mac)

| what | time |
|---|---|
| first Vision call by a new binary (standalone probe, 1200x100 sentence) | 42.6 s, 45.1 s (5 s CPU; the ANE compiler) |
| the next call, same process | 0.07 s |
| the next run of that binary, new process | 0.19 s |
| the helper's first `recognize-text` after a rebuild, before any warm-up | `still-timeout` at the old 10 s bound |
| warm helper, real 800x400 pt selection | 0.35-0.66 s total |

So without a warm-up, the first Capture Text after every app update would fail. `recognize-text` now has its own 60 s bound (`StillCapture.textTimeoutSeconds`; client 65 s, `TEXT_REQUEST_TIMEOUT_MS`), held together by `still-bounds.test.ts`.

**Not established:** exactly what the cache is keyed on. Several later rebuilds were not cold, so the end-to-end check (warm-up on a truly cold binary, then a fast first Capture Text) is §5's job, not a measured fact.

## 2. Bind it and capture (host)

Settings > Shortcuts > Tools > Capture Text: record a key. Press it from another app.

| check | expected |
|---|---|
| the overlay appears | the same overlay as Shot Area |
| drag over a paragraph | toast "Text copied" with the first line; paste shows every line, breaks kept |
| first use after a fresh `helper/build.sh` | "Reading text…" appears after ~1.5 s, then "Text copied" replaces it |
| drag over empty desktop | toast "No text copied"; the clipboard still holds what it held before |
| Esc on the overlay | no toast, clipboard unchanged |
| press the key while the overlay is up | nothing (one overlay at a time) |
| menu bar > Capture Text | same as the key |
| during a recording | works, and the take is unaffected |
| the library afterwards | nothing new in it |

## 3. Where it misreads (host)

The ticket asks for notes. Try each and write down what came back wrong:

- **UI text:** a Settings pane, a menu, a toolbar with small labels.
- **Code:** an editor with indentation. Vision does not return leading whitespace, so indentation is expected to be lost; say whether anything else is (`0`/`O`, `l`/`1`, quotes, `->`).
- **Low-contrast dark mode:** grey text on a dark background.
- **Two columns:** check that Vision's order reads one column, then the other.
- A non-English paragraph, to see the automatic language detection work.

## 4. Toast and overlay (host)

- The toast's first line is readable, and a long one ends with "…".
- Shot Area, Shot Window and the self-timer still work exactly as before (the overlay is shared with STC-569 and STC-570 too).

## 5. First use after an update (VM, packaged app)

`npm run app:package`, then a clean VM (`docs/VM-TESTING.md`), grant Screen Recording and Input Monitoring.

1. Launch. The terminal (or `log`) should show `[text] Vision warmed in N ms`. On a fresh binary N should be tens of seconds.
2. After that line, Capture Text over some text: it should answer in under a second.
3. Relaunch: the warm-up line should now say well under a second.
4. Capture Text **before** the warmed line appears: it should still answer, just slowly (inside 60 s), never "Couldn't capture text".
