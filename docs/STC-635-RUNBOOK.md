# STC-635 runbook: backward playhead drag

Run from `accounts/stc-635-backward-playhead-drag` until it merges.

```
git fetch origin && git checkout accounts/stc-635-backward-playhead-drag && npm ci && npm run app:start
```

Open your longest 4K take in the editor. Each line is yes or no.

1. Drag the playhead slowly backward (about playback speed). Does the picture keep up with the pointer?
2. Drag it quickly backward across several seconds. Does it lag no worse than before? (Expected: still behind the pointer at speed; see "Known" below.)
3. Drag forward, then back over the same stretch. Does the backward part keep up?
4. Let go mid-drag. Does the picture land on the playhead's frame straight away?
5. Scrub back and forth for a minute, then open Activity Monitor. Has the editor's renderer process grown by no more than about 0.7 GB since you opened the take (512 MiB display + 128 MiB camera)?

## Numbers (the Mac, 2026-11-03, `node scripts/scrub-timing-one.mjs <take> --headed`)

Painted frames per second; `kept` paints came from a frame already decoded behind the playhead.

| take | drag | before | after |
| -- | -- | -- | -- |
| 10.3 min, 3840x2160 (`2026-11-03_10-02-52`) | slow backward, cold | 13.0 | 51.0 |
| | slow backward, over a stretch just played | 13.0 | 54.3 |
| | backward 10 s in 2 s | 12.9 | 19.4-21.5 |
| | forward 10 s in 2 s | 57.5 | 57.0-57.5 |
| 31 min, 3840x2160 (`2026-10-16_14-38-06`) | slow backward, cold | — | 50.2 |
| | backward 10 s in 2 s | — | 18.9 |
| 12.1 s, 2226x1884 (`2026-10-27_10-26-17`) | backward 10 s in 2 s | 23.1 | 57.7 |
| | slow backward | 23.2 | 58.0 |

## Budget

The display keeps at most 512 MiB of decoded frames (about 41 at 4K, just under one 45-frame keyframe group); the camera keeps 128 MiB. The script's `keptMB` column prints the peak, so a change that keeps more shows.

## Known

A fast backward drag on 4K is still decoder-bound at about 20 painted/s. It crosses a keyframe group every ~150 ms and each new group is decoded from its keyframe. Kept frames cannot help with a group nothing has decoded yet; only decoding the previous group ahead of the drag would.
