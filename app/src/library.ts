import { readdir, stat, readFile, open as openFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { takesRoot, RAW_SUBDIR } from "./takes.js";
import { parseShot, type Shot } from "@transform/shot.js";
import { probePng, probeMp4, MP4_TAIL_PROBE_BYTES, type MediaFacts } from "@transform/media-probe.js";
import { readPngCaptureId, readMp4CaptureId, readBe32 } from "@transform/media-tag.js";
import { CAPTURE_DOC_FILE, parseCaptureDoc } from "@transform/capture-doc.js";
import {
  recordingItem, stillItem, looseFileItem, applyFilter, LIBRARY_FILTERS, DEFAULT_LIBRARY_FILTER,
  THUMBNAIL_FILE, SUPPORTED_ANCHORS_VERSIONS,
  type FinishedFileInfo, type InvalidItem, type LibraryList, type StillInfo, type TakeInfo, type TakeList,
} from "./library-items.js";

// Re-exported so callers have one import for the library, not two.
export * from "./library-items.js";

/**
 * The library's one index, over both kinds of take (STC-294).
 *
 * ## Why this file exists
 *
 * A still is its own format (`shot-1`, STC-289) and a recording is what it has
 * always been. The ticket's constraint is that this stays ONE storage root and
 * ONE index: *"two formats is a decision; two libraries is not."* So the two
 * kinds meet here and nowhere else — `transform/src/shot.ts`'s own header
 * already names this file as one of exactly two seams between them.
 *
 * ## The rule this file exists to keep
 *
 * **No view component branches on kind.** That is an acceptance criterion, and
 * it is not kept by good intentions — a view reaching for `item.kind ===
 * "still"` to decide a button's label is how the seam leaks, one small
 * reasonable line at a time. So a `LibraryItem` carries no decision for a view
 * to make: the badge is TEXT the adapter wrote, the summary is a STRING the
 * adapter composed, and the buttons are a LIST the adapter chose. A view
 * renders what it is handed and dispatches by action id.
 * `app/test/library-seam.test.ts` holds the line.
 *
 * The honest cost is stated rather than hidden: `summary` and `actions` mean
 * this module knows what the UI says, which is a layering compromise. It is the
 * one the ticket asks for, and the alternative — a view switching on kind in
 * three places — is the thing it forbids. When a kind needs something this
 * interface cannot express, the instruction is to WIDEN the interface
 * deliberately, not to special-case it at the call site.
 *
 * ## Why the scan lives here and not in `takes.ts`
 *
 * One pass over the root has to classify every directory, because a second pass
 * would stat 500 directories twice and, worse, would have to agree with the
 * first about what a still is. `takes.ts` keeps the root, the naming and the
 * label; it imports nothing from here. One direction only — CLAUDE.md already
 * records what a cycle costs in ESM (a hang and exit 13, not an error).
 *
 * ## The folder is a VIEW now, not a store (STC-413)
 *
 * A finished capture is a plain FILE at the top level, renameable in Finder;
 * its raw source materials — the ones a recording's own bundle always had —
 * live one level down in `raw/`, in a directory whose own name never changes.
 * The two are linked by an opaque id embedded in both the file's own bytes
 * (`media-tag.ts`) and the bundle's `capture.json` (`capture-doc.ts`), so a
 * rename survives: nothing here EVER matches by filename.
 *
 * The scan therefore has three phases, in order: (1) every top-level media
 * FILE — read its header, probe what facts fit in a bounded window, and try
 * to read an embedded id; (2) every BUNDLE — under `raw/` (`takes.ts`'s own
 * `RAW_SUBDIR`, where new takes land as of STC-413), or, for a take made
 * before that, sitting at the top level itself — both positions must work;
 * (3) MATCH the two by id. A matched pair is one library item, not
 * two; an unmatched bundle is an "unfinished" capture (never exported, or its
 * export was later removed); an unmatched file is either foreign or one
 * whose bundle is already gone.
 *
 * **Never read a whole media file.** A 500-file library reading whole files
 * is the difference between usable and not (Task 14 measures it). PNG facts
 * need only `probePng`'s own 24-byte header; an id can sit a little further
 * in (ImageIO's colour-profile chunk can precede it), so PNG reads a bounded
 * front window instead. MP4 is the hard case: `AVAssetWriter`/`mp4-muxer`
 * both write `ftyp`, one `mdat` that can be gigabytes, THEN `moov` — reading
 * "the last N bytes" blind would start partway through raw pixel data, not a
 * box header. `locateMoovBytes` walks box HEADERS ONLY (never a payload) to
 * skip `mdat` by arithmetic and land a second, targeted read exactly on
 * `moov`'s own first byte. `fixtures/basic/display.mp4` is the proof this
 * needed doing at all: 83,894 bytes, `moov` starting at 82,619 — past
 * `MP4_TAIL_PROBE_BYTES`'s 65,536-byte window, so a naive tail slice would
 * have started 64,261 bytes into `mdat`'s own payload.
 */

/**
 * Where `raw/` lives — `takes.ts`'s own `RAW_SUBDIR` (STC-413), the module
 * that mints it and is the one that WRITES there. This file only reads it.
 */

/**
 * What rule 1 of the scan recognises as a finished capture. `.jpg`/`.jpeg`/
 * `.heic` are in scope for LISTING (a file with one of these extensions is
 * still a capture) even though nothing here can probe or id-match them —
 * see `probeFinishedFile`.
 */
const MEDIA_EXTENSIONS = new Set([".mp4", ".png", ".heic", ".jpg", ".jpeg"]);

/**
 * Undefined when no camera was asked for; otherwise what it did.
 *
 * The helper always writes an `anchors.camera` block — `present: false` when
 * there is no camera — so "no block at all" and "a camera that produced
 * nothing" are different states and must not collapse into one.
 */
function cameraSummary(anchors: any): TakeInfo["camera"] {
  const c = anchors?.camera;
  if (!c || typeof c !== "object") return undefined;
  const gapNs = Number(c.firstFramePtsNs ?? 0) - Number(anchors?.capture?.firstFrameNs ?? 0);
  return {
    present: c.present === true,
    device: typeof c.device === "string" ? c.device : undefined,
    pipStartsAfterMs: c.present === true ? Math.max(0, Math.round(gapNs / 1e6)) : 0,
  };
}

async function dirSize(dir: string, names: string[]): Promise<number> {
  let total = 0;
  for (const n of names) {
    try { total += (await stat(join(dir, n))).size; } catch { /* gone */ }
  }
  return total;
}

/** Decode `len` bytes at `at` as Latin-1/ASCII — box types, same as `media-tag.ts`'s own. */
const ascii = (b: Uint8Array, at: number, len: number): string =>
  String.fromCharCode(...b.subarray(at, at + len));

/**
 * Read exactly `length` bytes starting at `position`, never the whole file.
 * `readFile` has no range form, so this is the one place a file handle is
 * opened directly rather than through `node:fs/promises`'s convenience API.
 */
async function readRange(file: string, position: number, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  const fh = await openFile(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Peek one top-level MP4 box's HEADER at `at` within `buf`, without
 * requiring its payload to be present.
 *
 * `mp4BoxesIn` (`media-tag.ts`) refuses exactly that — correct for walking a
 * buffer that holds a box's whole span, wrong for what this needs: `mdat`
 * can be gigabytes, and all this ever asks of it is where it ENDS, so the
 * box after it (`moov`, for every writer this app uses) can be found and
 * read on its own rather than the whole file being read to reach it. A
 * second, purpose-built peek — not a second walker for the same job
 * `mp4BoxesIn` already does; see `locateMoovBytes` for why one read is not
 * enough.
 */
function peekBoxHeader(buf: Uint8Array, at: number): { type: string; size: number } | undefined {
  if (at + 8 > buf.length) return undefined;
  const declared = readBe32(buf, at);
  const type = ascii(buf, at + 4, 4);
  if (declared === 1) {
    if (at + 16 > buf.length) return undefined;
    if (readBe32(buf, at + 8) !== 0) return undefined;   // a box past 4 GiB: not this app's
    const size = readBe32(buf, at + 12);
    return size < 16 ? undefined : { type, size };
  }
  if (declared === 0) return undefined;                  // "to EOF": nothing to find past here
  return declared < 8 ? undefined : { type, size: declared };
}

/**
 * Where `moov` starts, reached by walking top-level box HEADERS only,
 * reading more of the file only when a header runs past what has already
 * been read — the whole file is never read.
 *
 * `AVAssetWriter`/`mp4-muxer` both write `ftyp`, then ONE `mdat` that can be
 * gigabytes, THEN `moov`. This app's own fixture is the proof it matters,
 * not a hypothetical: `fixtures/basic/display.mp4` is 83,894 bytes and its
 * `moov` starts at byte 82,619 — past `MP4_TAIL_PROBE_BYTES`'s 65,536-byte
 * window, so reading "the last 64 KB" blind would start 64,261 bytes into
 * `mdat`'s own payload: raw pixel bytes, not a box header, and every fact
 * and every embedded id this scan needs would silently come back undefined
 * for the app's OWN real captures. Walking the headers instead means
 * `mdat`'s multi-megabyte payload is skipped by ARITHMETIC — never read —
 * and the second read this function makes lands exactly on `moov`'s first
 * byte.
 *
 * Bounded to a handful of hops: a real top-level box list here is `ftyp`,
 * `mdat`, `moov`, optionally a trailing `uuid` tag — four. The cap is what
 * stops a malformed file from being walked forever instead of degrading.
 */
async function locateMoovBytes(file: string, fileSize: number): Promise<Uint8Array | undefined> {
  let bufStart = 0;
  let buf = await readRange(file, 0, Math.min(MP4_TAIL_PROBE_BYTES, fileSize));
  let absAt = 0;

  for (let hop = 0; hop < 8 && absAt < fileSize; hop++) {
    const localAt = absAt - bufStart;
    if (localAt < 0 || localAt + 8 > buf.length) {
      bufStart = absAt;
      buf = await readRange(file, bufStart, Math.min(MP4_TAIL_PROBE_BYTES, fileSize - bufStart));
      continue;
    }
    const box = peekBoxHeader(buf, localAt);
    if (!box) return undefined;
    if (box.type === "moov") {
      if (localAt + box.size <= buf.length) return buf.subarray(localAt);
      // moov itself runs past what this hop holds — one more targeted read,
      // bounded the same as every other read here, landing on its own start.
      return await readRange(file, absAt, Math.min(fileSize - absAt, MP4_TAIL_PROBE_BYTES));
    }
    absAt += box.size;
  }
  return undefined;
}

async function probeAndIdMp4(file: string, fileSize: number):
    Promise<{ facts?: MediaFacts; id?: string }> {
  const moov = await locateMoovBytes(file, fileSize);
  if (!moov) return {};
  // `moov` is followed immediately, within the same read, by any `uuid` tag
  // `tagMp4` appended — `readMp4CaptureId`'s own top-level walk finds it by
  // skipping over `moov` via its own declared size, exactly as it would on
  // the whole file.
  return { facts: probeMp4(moov), id: readMp4CaptureId(moov) };
}

async function probeAndIdPng(file: string, fileSize: number):
    Promise<{ facts?: MediaFacts; id?: string }> {
  // ImageIO (and `tagPng`) can write a colour-profile chunk ahead of the id
  // chunk — both land before the first IDAT — so `probePng`'s own 24-byte
  // need is not enough to REACH the id. Reusing the MP4 side's bound here
  // is a generous, still-bounded window for a real screenshot.
  const front = await readRange(file, 0, Math.min(MP4_TAIL_PROBE_BYTES, fileSize));
  return { facts: probePng(front), id: readPngCaptureId(front) };
}

/**
 * `.jpg`/`.jpeg`/`.heic` have no probe here, and that is RULED, not
 * forgotten — real header/metadata parsing for two more formats is work for
 * little return, since `probePng`/`probeMp4` (Task 4) and their id readers
 * (Tasks 2-3) are the whole interface this task was given. Such a file
 * lists with no dimensions and — because there is no reader for either
 * format's embedded metadata — is never matched to a bundle by this scan,
 * whichever app produced it.
 */
async function probeFinishedFile(file: string, ext: string, fileSize: number):
    Promise<{ facts?: MediaFacts; id?: string }> {
  if (ext === ".mp4") return probeAndIdMp4(file, fileSize);
  if (ext === ".png") return probeAndIdPng(file, fileSize);
  return {};
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;

/**
 * `takes.ts`'s own `stamp(at)` naming, parsed back into epoch ms in LOCAL
 * time — the same zone it was formatted in. Undefined for anything not
 * exactly that shape, so a caller can fall back rather than mis-sorting on
 * digits that only coincidentally look like a timestamp.
 *
 * Used only where a bundle exists but its own richer read (`readRecording`/
 * `readStill`, whose `recordedAt`/`capturedAt` stay mtime-based, unchanged
 * by this task) could not run — the fallback item built straight from a
 * matched file still needs SOME notion of when it was captured, and the
 * bundle's stamped directory name says so more reliably than any mtime,
 * which copying or restoring files does not preserve.
 */
function stampToMs(name: string): number | undefined {
  const m = STAMP_RE.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(at.getTime()) ? undefined : at.getTime();
}

/**
 * A label is decoration. Losing it must never cost the take, so a corrupt
 * take.json degrades to "no label" rather than invalidating anything. Shared
 * by both kinds deliberately: labelling is one mechanism over one interface,
 * which is what lets the rename UI be written once.
 */
async function readLabel(dir: string): Promise<string | undefined> {
  try {
    const doc = JSON.parse(await readFile(join(dir, "take.json"), "utf8"));
    if (typeof doc?.label === "string" && doc.label.trim()) return doc.label.trim();
  } catch { /* absent or malformed */ }
  return undefined;
}

interface Scan {
  takes: TakeInfo[];
  stills: StillInfo[];
  /**
   * Finished captures with no bundle-derived richness — no bundle at all, or
   * one that exists (even matched by id) but did not parse as a usable
   * recording/still. See `library-items.ts`'s `FinishedFileInfo`.
   */
  loose: FinishedFileInfo[];
  invalid: InvalidItem[];
}

/** A candidate bundle directory. */
interface BundleCandidate {
  dir: string;
  names: string[];
}

/**
 * Every directory directly inside `container`, skipping dotfiles (rule 2)
 * and anything that vanished mid-scan.
 *
 * Deliberately NOT pre-filtered on `anchors.json`/`shot.json` presence —
 * `readBundleInfo` is what decides that, and a directory carrying NEITHER
 * still needs to be REPORTED (`no anchors.json — not a recording`, the exact
 * existing behaviour `app/test/library.test.ts` pins for a directory that is
 * "neither kind"), not silently skipped. Filtering here would turn a broken
 * take into one that quietly vanished from the list, which this file's own
 * header already names as indistinguishable from a deleted one.
 *
 * Shared between `raw/`'s children and the top-level legacy scan (rule 4) —
 * one definition of "what counts as a directory worth reading here", used in
 * both positions, rather than two that could drift.
 */
async function bundleCandidatesIn(container: string, subNames: string[]): Promise<BundleCandidate[]> {
  const out: BundleCandidate[] = [];
  for (const name of subNames) {
    if (name.startsWith(".")) continue;
    const dir = join(container, name);
    let st;
    try { st = await stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    out.push({ dir, names });
  }
  return out;
}

/** A finished, top-level media file — rule 1's whole scope. */
interface FinishedFile {
  file: string;
  /** The stem: becomes the item's id when no bundle is matched to it. */
  name: string;
  ext: string;
  bytes: number;
  mtimeMs: number;
  facts?: MediaFacts;
  id?: string;
}

/**
 * Rule 1: every top-level entry with a media extension is a finished
 * capture. Its header is read, its facts probed and its id extracted —
 * never its whole content. A file the probe cannot make sense of (a
 * genuinely corrupt one, `broken.mp4`-shaped) still lists, with no facts and
 * no id, rather than being dropped: this scan degrades, it does not throw.
 */
async function scanFinishedFiles(root: string, entries: string[]): Promise<FinishedFile[]> {
  const out: FinishedFile[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;               // rule 2
    const ext = extname(name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) continue;           // rule 1's scope
    const file = join(root, name);
    let st;
    try { st = await stat(file); } catch { continue; }         // vanished mid-scan
    if (!st.isFile()) continue;                         // e.g. an oddly-named directory
    const { facts, id } = await probeFinishedFile(file, ext, st.size);
    out.push({ file, name: basename(name, ext), ext, bytes: st.size, mtimeMs: st.mtimeMs, facts, id });
  }
  return out;
}

/**
 * Rule 1's scan, addressable on its own (STC-413) — every top-level finished
 * file with whatever embedded id it carries, read once, with no `raw/`
 * walking and no bundle reading.
 *
 * `main.ts` needs exactly this twice: resolving a re-export's destination by
 * IDENTITY (a bundle's own id may already belong to a top-level file — that
 * file, renamed or not, is where a re-export must land) and resolving
 * `share:publish`'s source the same way. A second id-matching pass written
 * inline in `main.ts` would be the "second scanner" this file's own header
 * already forbids — one function, not two copies of the lookup `scanRoot`'s
 * own rule 1 already performs.
 */
export async function scanFinishedFilesAt(env: NodeJS.ProcessEnv, saveFolder: string | null):
    Promise<FinishedFile[]> {
  const root = takesRoot(env, saveFolder);
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  return scanFinishedFiles(root, entries);
}

type BundleResult =
  | { kind: "recording"; info: TakeInfo }
  | { kind: "still"; info: StillInfo }
  | { kind: "invalid"; reason: string };

/**
 * Dispatch a bundle to `readRecording`/`readStill` (unchanged — the bundle
 * path is correct, only its call site moved) and report the outcome locally
 * rather than pushing straight into a shared `invalid` list. The caller
 * decides whether a failure here is real: a bundle matched to a live
 * finished file is not broken from the user's point of view, whatever
 * happened to its own raw materials, and must not be reported as such.
 */
async function readBundleInfo(dir: string, name: string, names: string[]): Promise<BundleResult> {
  let reason = "could not be read";
  const fail = (r: string) => { reason = r; };
  if (names.includes("shot.json")) {
    const out: StillInfo[] = [];
    await readStill(dir, name, names, out, fail);
    return out[0] ? { kind: "still", info: out[0] } : { kind: "invalid", reason };
  }
  const out: TakeInfo[] = [];
  await readRecording(dir, name, names, out, fail);
  return out[0] ? { kind: "recording", info: out[0] } : { kind: "invalid", reason };
}

/**
 * One pass over the storage root, per the ticket's four scan rules
 * (`.superpowers/sdd/.../task-8-brief.md`):
 *
 * 1. A top-level media file is a finished capture (`scanFinishedFiles`).
 * 2. `raw/` and any dotfile are skipped by rule 1 — never treated as a file.
 * 3. `raw/`'s children carrying `anchors.json`/`shot.json` are bundles.
 * 4. A top-level directory carrying either is a LEGACY bundle — the whole
 *    migration story, and what keeps this task green before Task 9 moves
 *    anything: this task writes nothing, so both positions must be read.
 *
 * Matching is by embedded id, never by name — a bundle's `capture.json` and
 * a file's own tag are compared directly, so a file renamed in Finder is
 * still found. A bundle whose id matches nothing currently at top level, or
 * whose `capture.json` does not exist at all (never exported), is an
 * "unfinished" capture: `dir` set, `file` absent. A file matching no bundle
 * is either foreign or one whose bundle is already gone.
 *
 * A bundle that fails its own richer read (`readBundleInfo`'s `invalid`
 * outcome) is reported broken ONLY when nothing else stands in for it. A
 * matched finished file means the capture itself is intact, so that case
 * degrades to a `loose` item built from the FILE's own header instead —
 * reporting a working capture as broken because its now-redundant raw
 * materials rotted would be exactly the "vanishes" failure this file's own
 * header already warns against, aimed at the wrong object.
 */
async function scanRoot(env: NodeJS.ProcessEnv, saveFolder: string | null): Promise<Scan> {
  const root = takesRoot(env, saveFolder);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { takes: [], stills: [], loose: [], invalid: [] };   // no folder yet is not an error
  }

  const finished = await scanFinishedFiles(root, entries);
  const byId = new Map<string, FinishedFile>();
  for (const f of finished) if (f.id) byId.set(f.id, f);
  const matchedFiles = new Set<string>();

  const rawDir = join(root, RAW_SUBDIR);
  let rawSubNames: string[] = [];
  try { rawSubNames = await readdir(rawDir); } catch { /* no raw/ yet */ }
  const legacyNames = entries.filter((n) => n !== RAW_SUBDIR);

  const bundles = [
    ...(await bundleCandidatesIn(rawDir, rawSubNames)),
    ...(await bundleCandidatesIn(root, legacyNames)),
  ];

  const takes: TakeInfo[] = [];
  const stills: StillInfo[] = [];
  const loose: FinishedFileInfo[] = [];
  const invalid: InvalidItem[] = [];

  for (const { dir, names } of bundles) {
    const name = basename(dir);

    // A bundle's own identity, read lazily — absent for one never exported,
    // since `capture.json` is written only at export time.
    let bundleId: string | undefined;
    try {
      bundleId = parseCaptureDoc(JSON.parse(await readFile(join(dir, CAPTURE_DOC_FILE), "utf8"))).id;
    } catch { /* no capture.json, or an unreadable one: unidentified */ }
    const match = bundleId ? byId.get(bundleId) : undefined;

    const result = await readBundleInfo(dir, name, names);
    if (result.kind !== "invalid") {
      if (match) { result.info.file = match.file; matchedFiles.add(match.file); }
      // readRecording/readStill compute recordedAt/capturedAt from a
      // sidecar's mtime — unchanged, per the brief ("keep them... correct").
      // The bundle's own stamped NAME is preferred here, at the call site,
      // wherever it parses: several bundles written in the same test (or the
      // same second, on a real machine restoring from a backup) can have
      // mtimes that disagree with the order their names already encode, and
      // `listLibrary`'s sort is what a Finder rename must not be able to
      // scramble — the directory name never changes, so it is the more
      // reliable of the two.
      const stamped = stampToMs(name);
      if (stamped !== undefined) {
        if (result.kind === "recording") result.info.recordedAt = stamped;
        else result.info.capturedAt = stamped;
      }
      if (result.kind === "recording") takes.push(result.info);
      else stills.push(result.info);
      continue;
    }

    // The bundle's own richer read failed. Reported REGARDLESS of a match
    // (review round 1, Important 1): a corrupt bundle that also happens to
    // have a live finished file is still corrupt, and suppressing the report
    // used to drop it out of `listTakes` (which reads `invalid`, not
    // `loose`) with no trace at all — exactly the "vanishes" failure this
    // file's own header forbids. A matched finished file additionally gets a
    // working tile (`loose`) alongside the report, so nobody is worse off
    // than before: the playable file, AND the honest "this needs attention"
    // line.
    if (match) {
      matchedFiles.add(match.file);
      loose.push({
        file: match.file,
        id: name,                                          // the bundle's own stamped name
        dir,
        createdAt: stampToMs(name) ?? match.mtimeMs,
        bytes: match.bytes,
        width: match.facts?.width,
        height: match.facts?.height,
        durationMs: match.facts?.durationMs,
        isVideo: match.ext === ".mp4",
        note: "This capture's source files could not be read.",
      });
      invalid.push({ dir, name, reason: result.reason });
    } else if (bundleId) {
      // `capture.json` is minted LAZILY, at export time (Task 5) — its mere
      // presence PROVES this bundle was exported to something, even though
      // nothing here can say what: a JPEG/HEIC export carries no readable id
      // at all (ImageIO writes the id only into the PNG dictionary — Task 6),
      // and a PNG/MP4 export's file may simply have been moved or deleted
      // since. Either way this is NOT "never exported", so it must not be
      // reported the same way a genuinely crash-truncated take is — that
      // would be a lie about a capture that already did its job. Listed
      // instead, degraded: no `file` to point at, so `looseFileItem` keeps
      // its actions to what a bare directory can still do (Important 3).
      loose.push({
        id: name,
        dir,
        createdAt: stampToMs(name) ?? 0,
        bytes: await dirSize(dir, names),
        isVideo: !names.includes("shot.json"),
        note: "This capture was exported, but its finished file could not be linked back to it.",
      });
    } else {
      // Never exported (no capture.json) AND the bundle's own read failed —
      // genuinely broken, the crash-truncated-video shape this scanner has
      // always reported.
      invalid.push({ dir, name, reason: result.reason });
    }
  }

  for (const f of finished) {
    if (matchedFiles.has(f.file)) continue;
    loose.push({
      file: f.file,
      id: f.name,
      createdAt: f.mtimeMs,
      bytes: f.bytes,
      width: f.facts?.width,
      height: f.facts?.height,
      durationMs: f.facts?.durationMs,
      isVideo: f.ext === ".mp4",
    });
  }

  // Bundle directory names are timestamps, so name order IS chronological
  // order for THESE arrays — and it survives files being copied around,
  // which mtime does not. `listLibrary`'s own combined sort (createdAt) is
  // what a renamed FILE needs; a bundle is never renamed by the user.
  takes.sort((a, b) => b.name.localeCompare(a.name));
  stills.sort((a, b) => b.name.localeCompare(a.name));
  return { takes, stills, loose, invalid };
}

async function readRecording(dir: string, name: string, names: string[],
                             out: TakeInfo[], fail: (r: string) => void): Promise<void> {
  let anchors: any;
  try {
    anchors = JSON.parse(await readFile(join(dir, "anchors.json"), "utf8"));
  } catch (e: any) {
    fail(e?.code === "ENOENT" ? "no anchors.json — not a recording"
                              : `anchors.json is unreadable: ${e?.message ?? e}`);
    return;
  }
  if (!SUPPORTED_ANCHORS_VERSIONS.includes(anchors?.version)) {
    fail(`anchors.json version ${anchors?.version} is not supported`);
    return;
  }

  let videoBytes: number;
  try {
    videoBytes = (await stat(join(dir, anchors.files?.display ?? "display.mp4"))).size;
    if (videoBytes === 0) { fail("display.mp4 is empty — the recording never started"); return; }
  } catch {
    fail("display.mp4 is missing — the recording did not complete");
    return;
  }

  // Events are an overlay, not the recording. A take with a readable video is
  // worth listing and playing even if the cursor track is gone.
  let events = 0;
  try {
    const doc = JSON.parse(await readFile(join(dir, "events.json"), "utf8"));
    events = Array.isArray(doc?.events) ? doc.events.length : 0;
  } catch { /* absent or malformed: 0 */ }

  let recordedAt = 0;
  try { recordedAt = (await stat(join(dir, "anchors.json"))).mtimeMs; } catch { /* keep 0 */ }

  out.push({
    dir, name, recordedAt,
    durationMs: Math.round((anchors.stop?.t ?? 0) / 1e6),
    width: anchors.capture?.width ?? 0,
    height: anchors.capture?.height ?? 0,
    events,
    label: await readLabel(dir),
    camera: cameraSummary(anchors),
    bytes: await dirSize(dir, names),
  });
}

/**
 * A still, read through `parseShot` rather than by picking fields out of JSON.
 *
 * That loader REFUSES rather than defaults, deliberately — the document IS the
 * still — so a shot.json it rejects is a still that cannot be rendered, and the
 * library says so with the loader's own message instead of listing a tile that
 * would fail the moment it was opened.
 */
async function readStill(dir: string, name: string, names: string[],
                         out: StillInfo[], fail: (r: string) => void): Promise<void> {
  let shot: Shot;
  try {
    shot = parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  } catch (e: any) {
    fail(`shot.json is unreadable: ${e?.message ?? e}`);
    return;
  }

  try {
    const frameBytes = (await stat(join(dir, shot.frame.file))).size;
    if (frameBytes === 0) { fail(`${shot.frame.file} is empty — the capture never completed`); return; }
  } catch {
    fail(`${shot.frame.file} is missing — the capture did not complete`);
    return;
  }

  let capturedAt = 0;
  try { capturedAt = (await stat(join(dir, "shot.json"))).mtimeMs; } catch { /* keep 0 */ }

  out.push({
    dir, name, capturedAt,
    width: shot.frame.width,
    height: shot.frame.height,
    mode: shot.decoration.mode,
    redactions: shot.decoration.redactions.length,
    label: await readLabel(dir),
    cached: names.includes(THUMBNAIL_FILE),
    bytes: await dirSize(dir, names),
  });
}

/**
 * The library: every kind, newest first, already presented.
 *
 * Sorted by `createdAt`, not by name or id (STC-413) — a bundle's directory
 * name is still a timestamp and never changes, but a FILE'S name is now
 * whatever the user renamed it to in Finder, and renaming must not reorder
 * the library. Taken from the bundle's stamped name where there is one, and
 * from the file's own mtime where there is not.
 */
export async function listLibrary(env: NodeJS.ProcessEnv, saveFolder: string | null,
                                  filter: string = DEFAULT_LIBRARY_FILTER): Promise<LibraryList> {
  const { takes, stills, loose, invalid } = await scanRoot(env, saveFolder);
  const all = [...takes.map(recordingItem), ...stills.map(stillItem), ...loose.map(looseFileItem)];
  all.sort((a, b) => b.createdAt - a.createdAt);
  const chosen = LIBRARY_FILTERS.some((f) => f.id === filter) ? filter : DEFAULT_LIBRARY_FILTER;
  return { items: applyFilter(all, chosen), invalid, filters: LIBRARY_FILTERS, filter: chosen };
}

/**
 * Recordings only — the phase-2 view of the same scan.
 *
 * Kept because the preview player, the export path and their tests are all
 * about recordings and have no business being handed stills. It is a FILTER
 * over the one scan, never a second implementation: two scanners would be two
 * answers to "what is a take", which is exactly what the ticket's one-index
 * constraint forbids.
 */
export async function listTakes(env: NodeJS.ProcessEnv, saveFolder: string | null): Promise<TakeList> {
  const { takes, invalid } = await scanRoot(env, saveFolder);
  return { takes, invalid };
}
