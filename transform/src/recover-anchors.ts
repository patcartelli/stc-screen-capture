/**
 * A take the recorder quit on, made whole again (STC-530).
 *
 * The helper writes anchors.json only at a clean stop, so a helper that dies mid-take
 * leaves a playable fragmented display.mp4 (STC-394) and nothing describing it. Since
 * STC-530 it also keeps `anchors.partial.json` current while recording: the stop-time
 * document minus `stop`, built by the same Swift function, rewritten whenever something
 * it describes changes. This turns that partial into an anchors document.
 *
 * What the partial cannot know is when things ENDED — every track's `lastFramePtsNs`, and
 * the stop time. Those come from the media themselves (`RecoveredMedia`, read by
 * `app/src/recover-take.ts`), never from the partial's stale values.
 *
 * Refuses rather than guesses, the repo's loader rule — with one deliberate exception: a
 * camera, mic or system track whose file yielded nothing is DROPPED (`present: false`,
 * file key removed) rather than refusing the take. Refusing would cost the whole take for
 * a missing first fragment of a side track, and the parent spec's first rule is that a
 * failure never discards a take. `present: false` is also exactly the schema's meaning:
 * asked for, yielded no track.
 *
 * Pure: no fs, no DOM. Tested in transform/test/recover-anchors.test.ts.
 */
import type { Anchors } from "./types.js";

export const PARTIAL_ANCHORS_FILE = "anchors.partial.json";

/** Written only by this recovery (anchors-11). */
export const RECOVERY_STOP_REASON = "recorder-quit";

/** What the media files say, read by the I/O half. `null` = the file was missing or yielded nothing. */
export interface RecoveredMedia {
  /** display.mp4's demuxed PTS grid, session-relative ns (demuxTrack's `framesNs`). */
  displayFramesNs: readonly number[];
  /** camera.mp4's demuxed grid. Only read when the partial claims a camera. */
  cameraFramesNs?: readonly number[] | null;
  /** The last mic sample, session-relative (after `rebaseMicAudio`). */
  micLastNs?: number | null;
  /** The last system-audio sample, session-relative. */
  systemLastNs?: number | null;
}

export type Recovery = { ok: true; anchors: Anchors } | { ok: false; why: string };

/** The newest version the HELPER writes. A partial claiming more is not one it wrote. */
const MAX_PARTIAL_VERSION = 10;
const REQUIRED = ["timebase", "t0Ns", "display", "capture", "files"] as const;

function medianDelta(xs: readonly number[]): number | undefined {
  if (xs.length < 2) return undefined;
  const d = xs.slice(1).map((x, i) => x - xs[i]!).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

export function recoverAnchors(partial: unknown, media: RecoveredMedia, reason: string): Recovery {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) {
    return { ok: false, why: "anchors.partial.json is not an object" };
  }
  const p = partial as Record<string, any>;
  if ("stop" in p) return { ok: false, why: "anchors.partial.json already has a stop block — it is not a partial" };
  if (!Number.isInteger(p.version) || p.version < 1 || p.version > MAX_PARTIAL_VERSION) {
    return { ok: false, why: `anchors.partial.json version ${String(p.version)} is not one the helper writes` };
  }
  for (const k of REQUIRED) {
    if (p[k] === undefined || p[k] === null) return { ok: false, why: `anchors.partial.json has no ${k}` };
  }
  const frames = media.displayFramesNs;
  if (frames.length === 0) return { ok: false, why: "display.mp4 has no frames" };

  const doc: Record<string, any> = JSON.parse(JSON.stringify(p));
  const files: Record<string, string> = { ...doc.files };

  if (doc.camera?.present === true) {
    const cf = media.cameraFramesNs;
    if (!cf || cf.length === 0) {
      doc.camera = { present: false };
      delete files.camera;
    } else {
      doc.camera = { ...doc.camera, lastFramePtsNs: cf[cf.length - 1],
                     frameIntervalNs: medianDelta(cf) ?? doc.camera.frameIntervalNs };
    }
  }
  if (doc.mic?.present === true) {
    if (media.micLastNs == null) { doc.mic = { present: false }; delete files.mic; }
    else doc.mic = { ...doc.mic, lastFramePtsNs: media.micLastNs };
  }
  if (doc.system?.present === true) {
    if (media.systemLastNs == null) { doc.system = { present: false }; delete files.system; }
    else doc.system = { ...doc.system, lastFramePtsNs: media.systemLastNs };
  }
  doc.files = files;
  doc.stop = { t: frames[frames.length - 1], reason };

  // The minimum version that can express the document, the rule anchorsDocument follows.
  let version: number = doc.version;
  if (reason === "disk-full" || reason === "disk-full-timeout") version = Math.max(version, 10);
  if (reason === RECOVERY_STOP_REASON) version = Math.max(version, 11);
  if (reason === "screen-recording-revoked" || reason === "screen-recording-revoked-timeout") {
    version = Math.max(version, 12);
  }
  doc.version = version;
  return { ok: true, anchors: doc as unknown as Anchors };
}
