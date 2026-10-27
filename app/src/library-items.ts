/**
 * The library's item contract and its presentation — pure, and shared across
 * the process line (STC-294).
 *
 * `library.ts` does the scanning and imports node; this file must not, because
 * `renderer.ts` and `library-view.ts` need these types and these strings, and
 * the browser typecheck pass follows an import even when the emitted bundle
 * would have erased it. That pass caught exactly this the first time the grid
 * was wired up, which is what it is for.
 *
 * So the split is the same one this repo uses everywhere else — `selection.ts`
 * beside `overlay-session.ts`, `thumbnail.ts` beside `thumbnail-window.ts`,
 * `still-decorate.ts` beside `still-render.ts`: the decisions live where they
 * can be tested with no filesystem, and the I/O lives next door.
 *
 * This is STC-345, the fourth and last study in STC-338's series (scrubber →
 * selection overlay handles → floating thumbnail motion → take library).
 * STC-294 already built and tested the library — one scan, a grid, delete
 * with no orphans — so this study's job is the same as the second and third:
 * write the vocabulary down, and do an adversarial pass over logic that
 * shipped believing it correct. Rule 9 is what that pass found.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE RULES
 * ════════════════════════════════════════════════════════════════════════
 *
 * **1. No view branches on kind — that is the interface, not a convention
 * kept by discipline.** The badge is TEXT this module wrote, the readout is a
 * STRING it composed, and the actions are a LIST it chose; a view renders
 * what it is handed and dispatches by action id. When a kind needs something
 * the interface cannot express, the instruction is to WIDEN `LibraryItem`
 * deliberately, never to special-case it at the call site. `library-view.ts`
 * may not mention `kind` at all, and `library-seam.test.ts` greps for it.
 *
 * **2. A thumbnail's SOURCE is not its KIND, and the two must not share a
 * name.** `LibraryThumbnail`'s discriminant is `source` on purpose — a view
 * legitimately switches on where a picture comes from (cached file, render
 * on demand, none), and if that field were also called `kind` no reader, and
 * no grep, could tell the legitimate branch from the one rule 1 forbids.
 *
 * **3. One scan classifies every directory; nothing gets a second opinion.**
 * `shot.json` present is a still, `anchors.json` present is a recording,
 * neither is reported invalid — never thrown, never silently dropped. A take
 * that silently disappears from the list is indistinguishable from one that
 * was deleted, and a second scanner would be a second answer to "what is a
 * take", which the ticket's one-index constraint forbids outright.
 *
 * **4. The directory name is identity AND the sort key; a label is neither.**
 * Renaming a directory would scramble chronological order, break an open
 * preview and invalidate a path already handed out for an export — so a
 * label lives beside the take (`take.json`) and never touches the name a
 * take is found by. Losing a label costs nothing but itself: a corrupt
 * `take.json` degrades to "no label", never to an invalid take.
 *
 * **5. A cached thumbnail lives INSIDE the take directory, so an orphan is
 * unreachable rather than merely unlikely.** Deleting a take deletes its
 * directory, which is what makes "no orphaned thumbnail" true by
 * construction; a cache anywhere else would need its own eviction, which is
 * the orphan the criterion names.
 *
 * **6. An unknown filter shows everything, never nothing.** A stale stored
 * preference — a filter id from a version that no longer exists — must not
 * be how a library reads as empty. `applyFilter` falls back to "all" for
 * anything it does not recognise, silently and without complaint.
 *
 * **7. Laziness must not be load-bearing.** 500 tiles cannot each read an
 * IPC round trip and render a picture before the first frame, so a tile
 * paints only once it is scrolled into view — except the first screenful,
 * painted outright with no timer and no geometry sampled, because a laziness
 * mechanism that can silently fail to fire (a missing `IntersectionObserver`
 * under a test runner) must default to correct pictures rather than to
 * empty boxes forever.
 *
 * **8. A version list this scanner reads must stay in step with the
 * transform's, and neither file may assume the other.** `SUPPORTED_ANCHORS_
 * VERSIONS` drifted from `transform/src/session.ts` once already — the
 * transform widened to accept a new anchors version and the library did not,
 * so a brand-new recording would have been UNSUPPORTED in the one place a
 * person goes to find it while playing back perfectly everywhere else.
 * `app/test/take-list.test.ts` pins the two lists together now.
 *
 * **9. A destination this scanner is about to CREATE must be claimed before
 * anything async, not merely computed from a snapshot.** Found reviewing
 * this module for the study: `still:duplicate` read the directory listing,
 * derived a fresh timestamped name, and `mkdir`'d it — three steps with two
 * gaps, and `mkdir(..., {recursive:true})` does not throw when the directory
 * already exists. Two duplicates racing (a double-click, or two tiles
 * duplicated inside the same second) could compute the SAME destination and
 * both copy into it, interleaving two unrelated shots' files with nothing
 * to say so — the result still parses as some shot. The same shape of defect
 * as the scrubber's rubber-band sign bug, the selection overlay's resize
 * floor and the thumbnail's discard race, one study each, and the same fix
 * this repo has now reached for three times: claim the name in-process
 * before the first `await`, release it in a `finally`. `duplicateTake` in
 * `takes.ts` is where it lives now; `app/test/takes.test.ts` proves two
 * concurrent duplicates — of the same take, and of two different ones —
 * never share a destination.
 *
 * **10. This module owns PRESENTATION and must not read a raw, I/O-shaped
 * document.** A second, byte-for-byte copy of `library.ts`'s `cameraSummary`
 * sat here, unreachable, taking a raw `anchors.json` blob as its input — the
 * exact thing this file's own header already forbids ("library.ts does the
 * scanning and imports node; this file must not"). Nothing was wrong with
 * the live behaviour, because nothing ever called the copy; the risk was a
 * bug fixed in the real one tomorrow with no reason for anyone to know a
 * second existed. Deleted; `library-seam.test.ts` now asserts `cameraSummary`
 * lives in exactly one file.
 */

import type { DecorationMode } from "@transform/shot.js";
import { libraryNote, silenceNote, stallNote, stopBadge } from "./stop-copy.js";

export type LibraryKind = "recording" | "still";

/** What a tile can be told to do. The view dispatches on this, never on kind. */
export type LibraryActionId = "open" | "share" | "copy-image" | "rename" | "duplicate" | "reveal" | "delete";

/**
 * Where an action is drawn (STC-584). `tile` is the whole tile or row, which
 * has no label of its own; `primary` is the one visible button; `menu` is the
 * overflow. Chosen here, so the view draws every item the same way.
 */
export type ActionPlace = "tile" | "primary" | "menu";

export interface LibraryAction {
  id: LibraryActionId;
  /** The button's text. Chosen here so "Preview" vs "Open" is not a view's branch. */
  label: string;
  place: ActionPlace;
}

/**
 * Something about this capture the user should know before opening it
 * (STC-529, drawn as STC-584's amber badge). `label` is the badge, a few
 * words; `detail` is the full sentence, shown on hover.
 */
export interface LibraryAlert { label: string; detail: string }

/**
 * The list view's columns (STC-584), already formatted. "–" where a kind has
 * nothing to say (a still's length), so no column is ever blank.
 */
export interface LibraryColumns {
  /** "Recording" or "Shot". */
  type: string;
  /** "0:42", or "–". */
  length: string;
  /** Pixels: "1080p", or "2560 × 1440". "–" when unknown. */
  size: string;
  /** Bytes on disk: "2.4 MB". */
  file: string;
}

/**
 * How a tile gets its picture.
 *
 * `file` names a cached image INSIDE the take directory when one is already
 * there; `render` says the renderer must produce it (and, having produced it,
 * hand it back to be cached). `none` is a kind with no picture yet — a
 * recording, in this slice — and the view draws its placeholder without asking
 * why.
 *
 * The discriminant is `source` rather than `kind` ON PURPOSE: a view legitimately
 * switches on where a picture comes from, and if that field were also called
 * `kind` no reader — and no guard — could tell it apart from the one branch this
 * design forbids. `library-seam.test.ts` greps for `.kind`, so the two names
 * had to differ for the grep to mean anything.
 */
export type LibraryThumbnail =
  | { source: "file"; file: string }
  | { source: "render" }
  | { source: "none" };

/**
 * The narrow interface the ticket asks for: id, kind, created, label,
 * thumbnail, delete — plus the presentation each kind owns.
 */
export interface LibraryItem {
  /**
   * Stable identity and the EXPORT NAME — the bundle's timestamped name when
   * there is a bundle, else the finished file's stem.
   *
   * No longer the sort key. It was, while every item was a directory whose
   * name was a timestamp; a user who renames `2026-09-22_14-30.mp4` to
   * `login-bug.mp4` in Finder destroys that ordering, and renaming in Finder
   * is the whole point of STC-413.
   */
  id: string;
  kind: LibraryKind;
  /**
   * The kind, as a word ("Recording", "Shot"). The list's Type column, and
   * `data-type` on every tile. Data, not a branch.
   */
  badge: string;
  /** Its source bundle in `raw/`. Absent for a foreign file with none. */
  dir?: string;
  /** The finished capture on disk. Absent for a bundle never exported. */
  file?: string;
  createdAt: number;
  bytes: number;
  label?: string;
  /**
   * The readout line under a grid tile's name, in the readout face:
   * "1080p  ·  2.4 MB" (STC-584).
   */
  readout: string;
  columns: LibraryColumns;
  /**
   * The chip on the thumbnail's corner: a recording's duration, a still's
   * format ("PNG"). Undefined when there is nothing true to put there.
   */
  chip?: string;
  /** Amber badges (STC-529, STC-584): on the tile, and under the name in a row. */
  alerts: LibraryAlert[];
  /**
   * Facts worth stating that are not warnings (the camera a take used), shown
   * as the tile's tooltip. STC-287's camera notes live here.
   */
  notes: string[];
  thumbnail: LibraryThumbnail;
  actions: LibraryAction[];
}

/** A directory that looks like a take but is not usable, and why. */
export interface InvalidItem {
  dir: string;
  name: string;
  reason: string;
}

/**
 * Whether the library's folder could be listed at all (STC-521). `ok` covers
 * both a folder with things in it and an empty one: whether anything is IN it
 * is `items`' business, whether it can be READ is this.
 */
export type FolderStatus =
  | { state: "ok" }
  | { state: "missing" | "unreadable"; path: string };

export interface LibraryList {
  items: LibraryItem[];
  invalid: InvalidItem[];
  /** Absent only on a list built before the folder was asked about. */
  folder?: FolderStatus;
  /** The chips to draw, and which one is on. Data, so the view chooses nothing. */
  filters: readonly LibraryFilter[];
  filter: string;
}

export interface LibraryFilter { id: string; label: string }

/**
 * The kind filter, as data.
 *
 * This exists here rather than in the view for the same reason `badge` and
 * `actions` do, and it is the case that nearly got away: "filters by kind" is a
 * scope bullet, and the obvious implementation is `items.filter((i) => i.kind
 * === selected)` in the renderer — which is exactly the branch the fourth
 * acceptance criterion forbids, arrived at by doing what the ticket asked for.
 * Mixed is FIRST and is the default: a demo session produces both kinds and
 * they belong together.
 */
export const LIBRARY_FILTERS: readonly LibraryFilter[] = [
  { id: "all", label: "All" },
  { id: "recording", label: "Recordings" },
  // "Shots", STC-398's word for the artefact. STC-584's frames say "Stills";
  // the library keeps "Shot" like the rest of the app (Patrick, 2026-10-27).
  { id: "still", label: "Shots" },
];

export const DEFAULT_LIBRARY_FILTER = "all";

/** An unknown filter id shows everything rather than nothing — a stale preference must not empty the library. */
export function applyFilter(items: readonly LibraryItem[], id: string): LibraryItem[] {
  if (id === "recording" || id === "still") return items.filter((i) => i.kind === id);
  return [...items];
}

/**
 * Anchors document versions this build can read.
 *
 * MUST stay in step with `transform/src/session.ts`. They drifted once: STC-232
 * widened the transform to accept v2 and left this scanner at v1, so once the
 * helper emitted v2 every new recording would have been listed as unsupported
 * while the transform loaded it happily — the take library wrong, the transform
 * right, and the two disagreeing about what a recording is.
 *
 * The two cannot share a constant: this runs in the Electron main process and
 * imports only node builtins, while the transform is bundled for the renderer.
 * `app/test/take-list.test.ts` pins them together instead.
 */
export const SUPPORTED_ANCHORS_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** The cached decorated thumbnail, beside the document it was rendered from. */
export const THUMBNAIL_FILE = "thumb.png";

/** A recording that can be listed, played and exported. */
export interface TakeInfo {
  dir: string;
  name: string;
  recordedAt: number;      // epoch ms
  durationMs: number;
  width: number;
  height: number;
  events: number;
  bytes: number;
  /** User-chosen display name. Never the identity, never the sort key. */
  label?: string;
  /**
   * What the camera actually did, when one was asked for (STC-287).
   *
   * `present: false` with a camera requested is the silent failure: the device
   * opened, wrote no frames, and the take looks camera-less with no reason
   * given. `pipStartsAfterMs` is the gap the viewer sees — the camera opens off
   * the critical path, so the PiP arrives after the picture does, measured at
   * 1.26-1.39 s across five real takes.
   */
  camera?: { present: boolean; device?: string; pipStartsAfterMs: number };
  /** How the take stopped, when anchors.json says (STC-530). Read for the library note; STC-529 extends it. */
  stop?: { t: number; reason: string };
  /** Stretches the mic delivered no signal (anchors-13, STC-528), for the library note (STC-529). */
  silentSpans?: { startNs: number; endNs: number }[];
  /** Where the camera stalled (anchors-16, STC-553), for the library note. */
  stalledSpans?: { startNs: number; endNs: number }[];
  /**
   * The matching finished export at top level, when this bundle and a
   * top-level file are linked by an embedded capture id (STC-413). Absent
   * for a bundle never exported, or whose export was later removed.
   */
  file?: string;
}

export interface TakeList {
  takes: TakeInfo[];
  invalid: InvalidItem[];
}

/** What a still tile needs, over and above the shared fields. */
export interface StillInfo {
  dir: string;
  name: string;
  capturedAt: number;
  /** Capture pixels, not output pixels — the decoration decides the output. */
  width: number;
  height: number;
  mode: DecorationMode;
  redactions: number;
  bytes: number;
  label?: string;
  /** Whether a decorated thumbnail is already cached beside the document. */
  cached: boolean;
  /** See `TakeInfo.file` — the same link, for a still's bundle (STC-413). */
  file?: string;
}

export const fmtBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
};

export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** What a column with nothing to say holds, so no cell is ever blank. */
export const NO_VALUE = "–";

/** The heights a video's size is named by ("1080p"), as the frames name them. */
const NAMED_VIDEO_HEIGHTS: ReadonlySet<number> = new Set([480, 720, 1080, 1440, 2160]);

/**
 * A capture's pixel size, the way the frames write it (STC-584): a recording
 * at a standard 16:9 height is "1080p"; anything else, and every still, is
 * "2560 × 1440". An area take is rarely 16:9, so "567p" would describe
 * nothing a person recognises.
 */
export function pixelSizeLabel(width: number | undefined, height: number | undefined, video: boolean): string {
  if (!width || !height) return NO_VALUE;
  if (video && NAMED_VIDEO_HEIGHTS.has(height) && width * 9 === height * 16) return `${height}p`;
  return `${width} × ${height}`;
}

/** A file's format for the thumbnail chip: "PNG", from its extension. */
export function formatChip(file: string | undefined): string | undefined {
  const ext = file?.match(/\.([A-Za-z0-9]+)$/)?.[1];
  return ext ? ext.toUpperCase() : undefined;
}

/** The grid tile's readout line: its pixel size and its bytes. */
const readoutLine = (size: string, bytes: number): string =>
  size === NO_VALUE ? fmtBytes(bytes) : `${size}  ·  ${fmtBytes(bytes)}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The list's Captured column (STC-584): "Today 1:12 PM", "Yesterday",
 * "Oct 22", and the year once it is not this one. Local time, from the same
 * clock the user reads. `now` is passed in so the rule can be tested.
 */
export function capturedLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days === 0) {
    const h = d.getHours();
    return `Today ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  if (days === 1) return "Yesterday";
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === today.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/**
 * The title bar's count (STC-584): "42 captures", or "3 of 42" while a search
 * narrows the list.
 */
export function countLabel(shown: number, total: number): string {
  if (shown !== total) return `${shown} of ${total}`;
  return `${total} capture${total === 1 ? "" : "s"}`;
}

/**
 * The search box (STC-584): every word must appear in the name, the label or
 * the id, ignoring case. An empty query is everything. Pure, and over what
 * the adapter already wrote, so the view does not decide what matches.
 */
export function applySearch(items: readonly LibraryItem[], query: string): LibraryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((i) => {
    const hay = `${i.label ?? ""} ${i.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * The overflow menu every item with a bundle or a file shares (STC-584):
 * Rename, Show in Finder, then Delete. `duplicate` is a still's only, so it
 * goes in where the caller says.
 */
const menuActions = (withDuplicate: boolean): LibraryAction[] => [
  { id: "rename", label: "Rename", place: "menu" },
  ...(withDuplicate ? [{ id: "duplicate", label: "Duplicate", place: "menu" } as const] : []),
  { id: "reveal", label: "Show in Finder", place: "menu" },
  { id: "delete", label: "Delete", place: "menu" },
];

/**
 * A recording's length in ms, from its `anchors.json` (`stop.t` is session
 * nanoseconds). The ONE derivation: the library's scan and the recording
 * panel (STC-487) both call it, so two windows cannot disagree on how long a
 * take ran.
 */
export const recordingDurationMs = (anchors: { stop?: { t?: number } } | undefined): number =>
  Math.round((anchors?.stop?.t ?? 0) / 1e6);

/**
 * What a recording was pointed at, in the record flow's own vocabulary
 * (Screen / Window / Area). Read from the take's own `anchors.json` because
 * scope is decided per take now (STC-388), not stored as a setting. A window
 * with no recorded app name is just "Window".
 */
export function recordingScopeLabel(
  anchors: { scope?: { kind?: string; window?: { app?: string } } } | undefined,
): string {
  const scope = anchors?.scope;
  if (scope?.kind === "region") return "Area";
  if (scope?.kind === "window") return scope.window?.app || "Window";
  return "Screen";
}

/** How each decoration mode reads to a person. */
const MODE_LABELS: Readonly<Record<DecorationMode, string>> = {
  "selected-area": "Selected area",
  "window-only": "Window",
  "window-shadow": "Window + shadow",
  "window-shadow-background": "Window + background",
  "window-shadow-custom-background": "Window + custom background",
};

/**
 * One recording, as a library item.
 *
 * A recording has no thumbnail in this slice and says so structurally rather
 * than by the view knowing which kinds have pictures. Decoding a poster frame
 * for every recording is the WebCodecs path CLAUDE.md documents as tab-killing
 * at scale (one in-flight request, ~30 MB per `VideoFrame`), so it is a
 * deliberate follow-up, not an oversight.
 */
export function recordingItem(t: TakeInfo): LibraryItem {
  const notes: string[] = [];
  const alerts: LibraryAlert[] = [];
  if (t.camera) {
    if (!t.camera.present) {
      alerts.push({ label: "No camera",
                    detail: "Camera: recorded no frames — this take has no picture-in-picture" });
    } else {
      const who = t.camera.device ?? "camera";
      notes.push(t.camera.pipStartsAfterMs > 0
        ? `Camera: ${who} · picture-in-picture starts ${(t.camera.pipStartsAfterMs / 1000).toFixed(1)}s in`
        : `Camera: ${who}`);
    }
  }
  const stopNote = libraryNote(t.stop);
  const stopLabel = stopBadge(t.stop);
  if (stopNote && stopLabel) alerts.push({ label: stopLabel, detail: stopNote });
  const silence = silenceNote(t.silentSpans);
  if (silence) alerts.push({ label: "No mic signal", detail: silence });
  const stall = stallNote(t.stalledSpans);
  if (stall) alerts.push({ label: "Camera stalled", detail: stall });
  const size = pixelSizeLabel(t.width, t.height, true);
  const length = fmtDuration(t.durationMs);
  return {
    id: t.name,
    kind: "recording",
    badge: "Recording",
    dir: t.dir,
    file: t.file,
    createdAt: t.recordedAt,
    bytes: t.bytes,
    label: t.label,
    readout: readoutLine(size, t.bytes),
    columns: { type: "Recording", length, size, file: fmtBytes(t.bytes) },
    chip: length,
    alerts,
    notes,
    thumbnail: { source: "none" },
    actions: [
      { id: "open", label: "Preview", place: "tile" },
      // The take editor's own Share button (STC-242) is what this reaches.
      { id: "share", label: "Share", place: "primary" },
      ...menuActions(false),
    ],
  };
}

/**
 * One still, as a library item.
 *
 * `open` re-opens it into the post-capture panel with its decoration intact,
 * which is the payoff of keeping the decoration in JSON; `duplicate` is what
 * lets a second decoration be tried without re-capturing. Neither exists for a
 * recording, and the view learns that from this list rather than from the kind.
 */
export function stillItem(s: StillInfo): LibraryItem {
  const notes = [MODE_LABELS[s.mode]];
  if (s.redactions > 0) notes.push(`${s.redactions} redaction${s.redactions === 1 ? "" : "s"}`);
  const size = pixelSizeLabel(s.width, s.height, false);
  return {
    id: s.name,
    kind: "still",
    badge: "Shot",
    dir: s.dir,
    file: s.file,
    createdAt: s.capturedAt,
    bytes: s.bytes,
    label: s.label,
    readout: readoutLine(size, s.bytes),
    columns: { type: "Shot", length: NO_VALUE, size, file: fmtBytes(s.bytes) },
    chip: formatChip(s.file),
    alerts: [],
    notes: [notes.join(" · ")],
    // A cached file is named; otherwise the renderer is asked to make one. The
    // cache lives in the take directory precisely so that deleting the take
    // deletes it too — an orphan is impossible rather than merely unlikely.
    thumbnail: s.cached ? { source: "file", file: THUMBNAIL_FILE } : { source: "render" },
    actions: [
      // The still editor, the tile's own door (STC-300, STC-584).
      { id: "open", label: "Edit", place: "tile" },
      // A still's Share copies the decorated image (Patrick, 2026-10-27): the
      // same render the panel's Copy makes. A different id from a
      // recording's "share", because it is a different action.
      { id: "copy-image", label: "Share", place: "primary" },
      ...menuActions(true),
    ],
  };
}

/**
 * A finished capture with no bundle-derived richness to draw on (STC-413) —
 * one of three shapes, all missing what a healthy bundle would supply:
 *
 * 1. Genuinely no bundle at all — a foreign file dropped into the folder, or
 *    one whose bundle was already swept. `dir` absent.
 * 2. A bundle exists, is linked by id, but did not parse as a usable
 *    recording/still. `dir` AND `file` both set.
 * 3. A bundle exists and carries `capture.json` — proof it WAS exported,
 *    minted lazily at export time (Task 5) — but nothing here can say to
 *    WHICH file: a JPEG export carries no readable id at all (measured
 *    2026-09-23 — see `readHeicCaptureId`; PNG and HEIC both do), or the
 *    linked file has moved or been deleted since. `dir` set, `file` absent.
 *    Reviewed round 1: this
 *    must not be reported as broken (`capture.json`'s presence means "never
 *    exported" is already false) and must not be confused with case 1's
 *    genuinely-untethered file.
 *
 * Deliberately NOT `TakeInfo`/`StillInfo` with more fields made optional.
 * Those two describe what a HEALTHY bundle knows about itself — camera,
 * event count, redactions, decoration mode — and widening them so every
 * field could be missing would let a real, working bundle quietly degrade
 * the same way a broken one does. This is a separate, honestly sparse shape:
 * what the FILE's own header and stat (or, lacking a file, the bundle's own
 * directory) can say, nothing more.
 */
export interface FinishedFileInfo {
  /** Absent only for case 3 above — a bundle proven exported but unlinkable. */
  file?: string;
  /** The export name — see `LibraryItem.id`'s own doc comment. */
  id: string;
  createdAt: number;
  bytes: number;
  /** From the file's own header, when the probe could read one. */
  width?: number;
  height?: number;
  durationMs?: number;
  /** Extension-derived: `.mp4` is a recording, an image extension a still. */
  isVideo: boolean;
  /** Present exactly when a bundle exists for this item, however degraded. */
  dir?: string;
  /** A fact worth stating when the bundle exists but could not be read. */
  note?: string;
}

/**
 * A loose file, as a library item.
 *
 * Rule 1's "widen the interface, never special-case the call site" is why
 * `actions` differs by whether `dir` is set rather than by a second type —
 * but a `looseFileItem` with `dir` set is ALWAYS a bundle whose own read
 * FAILED (`library.ts`'s scan never routes a healthy bundle through here,
 * matched or not), so `open`/`duplicate` are withheld even then. Reviewed
 * round 1, Important 3: `thumbnail.source` is unconditionally `"none"`
 * below, and `renderer.ts`'s `openItem` dispatches "open" on exactly that
 * field to decide which editor to open — a broken STILL bundle would
 * therefore route to the RECORDING editor if "open" were offered here.
 * `reveal`/`delete` need nothing more than whichever of `file`/`dir` this
 * item has, so those are what a degraded bundle gets regardless.
 *
 * `rename` is UNCONDITIONAL now (STC-413 Task 13), and that is a real change
 * from this rule's original shape: it used to require `dir` too, because
 * renaming wrote `take.json` beside the bundle and a genuinely bundle-less
 * file (case 1 above) had nowhere to write one. Now that a rename operates
 * on the FILE directly (`takes.ts`'s `renameCapture`) when there is one, a
 * bundle is no longer what rename needs — every shape `FinishedFileInfo` can
 * take carries at least a `file` or a `dir`, so rename is always offered and
 * `renderer.ts`'s handler is what decides which of the two it acts on.
 */
export function looseFileItem(f: FinishedFileInfo): LibraryItem {
  const kind: LibraryKind = f.isVideo ? "recording" : "still";
  const size = pixelSizeLabel(f.width, f.height, f.isVideo);
  const length = f.isVideo && f.durationMs !== undefined ? fmtDuration(f.durationMs) : undefined;
  return {
    id: f.id,
    kind,
    // "Shot", not "Still" — STC-398 renamed the artefact and STC-407 cleaned
    // up the residue (and STC-584 kept it, see LIBRARY_FILTERS).
    badge: kind === "recording" ? "Recording" : "Shot",
    dir: f.dir,
    file: f.file,
    createdAt: f.createdAt,
    bytes: f.bytes,
    readout: readoutLine(size, f.bytes),
    columns: { type: kind === "recording" ? "Recording" : "Shot", length: length ?? NO_VALUE,
               size, file: fmtBytes(f.bytes) },
    chip: length ?? formatChip(f.file),
    alerts: [],
    notes: f.note ? [f.note] : [],
    // Nothing here has a picture to show: a foreign file was never decorated
    // by this app, and a bundle too broken to parse has nothing
    // `renderThumbnail` could read (that needs `shot.json` and `frame.file`,
    // exactly what "did not parse" means).
    thumbnail: { source: "none" },
    // No tile action and no Share: both need a bundle that read (rule above).
    actions: menuActions(false),
  };
}

// ── what the library shows when it has nothing to show (STC-521) ────────────

/** An update that finishes inside this is never announced — a flash is worse than silence. */
export const UPDATING_SHOW_AFTER_MS = 300;

export const UPDATING_NOTE = "Checking for new captures…";

export type PlaceholderAction = "retry" | "choose-folder";

export interface LibraryPlaceholder {
  state: "loading" | "empty" | "filtered" | "missing" | "unreadable";
  title: string;
  body: string;
  /** The folder's path when the sentence is about it, shown on its own line. */
  path?: string;
  actions: PlaceholderAction[];
}

export interface PlaceholderContext {
  /** Resolved save folder, for the sentence that says what the folder is. */
  folder: string;
  /** Already formatted for display ("⌃⌥⇧⌘3"); null when the action is unbound. */
  shotKey: string | null;
  recordKey: string | null;
}

/** A search that matches nothing (STC-584), over a library that is not empty. */
export function searchPlaceholder(query: string): LibraryPlaceholder {
  return { state: "filtered", title: `No captures match “${query.trim()}”`,
           body: "Try another name, or clear the search.", actions: [] };
}

/** The first paint, before any list has come back. */
export const LOADING_PLACEHOLDER: LibraryPlaceholder = {
  state: "loading", title: "Loading your captures…",
  body: "Reading the folder.", actions: [],
};

/**
 * The sentence for a library with nothing to draw, or null when there is a
 * grid to draw instead. A folder that cannot be read wins over "empty": an
 * empty-looking library over a lost folder says the captures are gone.
 */
export function placeholderFor(list: LibraryList, ctx: PlaceholderContext): LibraryPlaceholder | null {
  const f = list.folder;
  if (f && f.state !== "ok") {
    return f.state === "missing"
      ? { state: "missing", title: "This folder can’t be found",
          body: "It was moved, renamed or deleted, or the drive it’s on isn’t connected. Your captures haven’t been removed.",
          path: f.path, actions: ["retry", "choose-folder"] }
      : { state: "unreadable", title: "This folder can’t be opened",
          body: "Capture doesn’t have permission to read it. Allow access in System Settings → Privacy & Security → Files and Folders, or choose another folder.",
          path: f.path, actions: ["retry", "choose-folder"] };
  }
  if (list.items.length || list.invalid.length) return null;
  if (list.filter !== "all") {
    return { state: "filtered", title: "Nothing of this kind yet", body: "Choose All to see everything.", actions: [] };
  }
  const keys = [
    ctx.shotKey ? `${ctx.shotKey} takes a screenshot` : null,
    ctx.recordKey ? `${ctx.recordKey} starts a recording` : null,
  ].filter((k): k is string => k !== null);
  return {
    state: "empty", title: "No captures yet",
    body: `Screenshots and recordings you make are saved to this folder, a plain folder you can also open in Finder.${
      keys.length ? ` ${keys.join(", ")}.` : " Use Record or Shot to make the first one."}`,
    path: ctx.folder, actions: [],
  };
}

