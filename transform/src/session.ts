import { demuxTrack, type DemuxedVideo } from "./demux.js";
import { demuxAudioTrack, type DemuxedAudio } from "./demux-audio.js";
import type { Anchors, Session, SessionEvent } from "./types.js";
import type { Changes } from "./changes.js";

/**
 * Turns a recorded session on disk into the Session the transform consumes.
 *
 * Environment-agnostic on purpose: it takes already-read data rather than
 * paths, so the same code serves Node tests and the browser export sink.
 */

export class SessionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLoadError";
  }
}

export interface SessionInput {
  anchors: Anchors;
  events: { version: number; events: SessionEvent[] };
  displayMp4: ArrayBuffer;
  cameraMp4?: ArrayBuffer;
  /** STC-233. mic.m4a, when anchors.mic.present is true. */
  micM4a?: ArrayBuffer;
  /** STC-418. system.m4a, when anchors.system.present is true. */
  systemM4a?: ArrayBuffer;
  /** already-parsed (parseChanges), same as anchors/events — this loader reads data, not paths. Absent on every take today (STC-322's browser pass has never run on a real recording). */
  changes?: Changes;
}

export interface LoadedSession extends Session {
  video: DemuxedVideo;
  cameraVideo?: DemuxedVideo;
  /** STC-233. Present only when anchors.mic.present is true and micM4a was supplied. */
  micAudio?: DemuxedAudio;
  /** STC-418. Present only when anchors.system.present is true and systemM4a was supplied. */
  systemAudio?: DemuxedAudio;
}

/**
 * How far the offset recovered from the file may differ from the offset the
 * helper measured. The file stores it as an empty edit quantised to the movie
 * timescale (90 kHz), and AVAssetWriter truncates rather than rounds, so a
 * full tick of disagreement is normal. Anything larger means the reader and the
 * writer disagree about time itself.
 */
const OFFSET_TOLERANCE_NS = 50_000;

/**
 * The helper wrote down what it measured; the file only preserves a
 * timescale-quantised version of it (an empty edit, 90 kHz). Comparing the
 * two turns a whole class of silent clock bugs into a loud one — on the
 * display track a few frames of desync looks like a rendering fault; on the
 * camera track (~1 s empty edit) an unchecked gap is seconds of PiP desync,
 * invisible in a still frame. Shared by both video tracks so the two checks
 * cannot drift apart.
 *
 * NOT used for mic.m4a (STC-233) — the file has no empty edit to compare
 * against at all, so there is nothing to check. See the mic-loading block
 * below for why, and what happens instead.
 */
function checkFrameOffset(what: string, measuredNs: number | undefined, demuxedFirstNs: number): void {
  if (typeof measuredNs !== "number") return;
  const drift = Math.abs(demuxedFirstNs - measuredNs);
  if (drift > OFFSET_TOLERANCE_NS) {
    throw new SessionLoadError(
      `${what} frame-time offset disagreement: helper measured ${measuredNs} ns, file yields ` +
      `${demuxedFirstNs} ns (${(drift / 1e6).toFixed(1)} ms apart). Render would desync by that amount.`,
    );
  }
}

/**
 * STC-233. mic.m4a cannot carry the session-start gap the way display.mp4/
 * camera.mp4 do — confirmed on real hardware (2026-09-16) against a take
 * where display.mp4's video track had a real two-entry edit list (an empty
 * edit for the startup gap, then the actual content) while mic.m4a's
 * `trak.edts` was entirely absent. `MicCapture.swift` retimes every sample
 * buffer to a session-relative PTS before appending it, but
 * `AVAssetWriter`'s real-time AAC pipeline resets the track's own timeline
 * to whichever sample it first receives rather than preserving that PTS as
 * a recoverable offset. So unlike video there is nothing in the file to
 * independently corroborate `anchors.mic.firstFramePtsNs` against —
 * `checkFrameOffset`'s "helper vs file, they should agree" design would
 * throw on every take with a mic, since the file's own first sample always
 * lands near its own zero regardless of how late the mic actually opened.
 *
 * `anchors.mic.firstFramePtsNs` is therefore the ONLY source for where this
 * track sits in session time, and every demuxed timestamp is REBASED onto
 * it rather than merely checked against it. The shift is measured against
 * the file's OWN first sample (not assumed to be exactly 0), so this is a
 * no-op if a future macOS version starts writing a real edit list for
 * audio — it would simply come out near zero.
 *
 * `chunks[i].timestampUs` is RECOMPUTED from the shifted `framesNs[i]`
 * (not the old timestampUs plus a separately-rounded shift), to preserve
 * demux-audio.ts's own invariant since STC-394: `timestampUs` is always
 * exactly `Math.round(framesNs / 1000)`, never a value that could drift
 * from it by a rounding unit through a second, independent rounding path.
 */
export function rebaseMicAudio(raw: DemuxedAudio, measuredFirstNs: number): DemuxedAudio {
  const shiftNs = measuredFirstNs - raw.framesNs[0]!;
  const framesNs = raw.framesNs.map((ns) => ns + shiftNs);
  return {
    ...raw,
    framesNs,
    chunks: raw.chunks.map((c, i) => ({ ...c, timestampUs: Math.round(framesNs[i]! / 1000) })),
  };
}

export async function loadSession(input: SessionInput): Promise<LoadedSession> {
  const { anchors, events } = input;

  // v1 through v5 differ only by additions the transform treats as optional
  // (camera track, pip geometry, `scope` for a region/window take — STC-370,
  // a `mic` block — STC-233, and now `pauses` — STC-240 PR A), so an older
  // document loads as a v5 with the newer fields absent. `scope` absent
  // means the whole display, same as v1/v2 always meant; nothing here reads
  // it yet (that is STC-374's picker and whatever consumes it), so every
  // version is accepted on the same terms v2 was.
  //
  // v5's `pauses` (session-relative `[startNs, endNs)` spans the four
  // capture-side writers gated on) is ACCEPTED AND IGNORED here — this is
  // PR A of STC-240, the helper half only. Loading a v5 document today reads
  // it exactly like a v2 with no gaps: the exported timeline still plays the
  // paused span back as held frames, since nothing in `render()` consults
  // `pauses` yet. PR B is what makes the export CUT those spans out; until
  // it lands, a paused take degrades to "recorded through the pause" rather
  // than failing to load, which is the documented, deliberate PR A behaviour
  // (see docs/STC-240-DESIGN.md and docs/STC-240-PLAN-A.md).
  //
  // v6's `system` block (STC-418) is a second audio track, loaded below on
  // exactly the mic's terms. Nothing downstream consumes `systemAudio` yet —
  // export's weighted sum with the mic is a later PR of the same ticket.
  if (
    anchors?.version !== 1 && anchors?.version !== 2 && anchors?.version !== 3 &&
    anchors?.version !== 4 && anchors?.version !== 5 && anchors?.version !== 6
  ) {
    throw new SessionLoadError(`anchors.json version ${anchors?.version} is not supported (expected 1, 2, 3, 4, 5 or 6)`);
  }
  // events-2 adds the cursor-shape event; a v1 document simply has none, and
  // the sim shows the arrow throughout — which is what v1 always meant.
  if (events?.version !== 1 && events?.version !== 2) {
    throw new SessionLoadError(`events.json version ${events?.version} is not supported (expected 1 or 2)`);
  }

  // A claimed camera with no file supplied, and a file supplied with no
  // claim, are both cases where the two sources disagree about what was
  // recorded — guessing which one is right is worse than refusing. Silently
  // loading either mismatch as camera-less would leave render() reporting
  // pip: null for a take that has one, or vice versa.
  const claimsCamera = anchors.camera?.present === true;
  if (claimsCamera && !input.cameraMp4) {
    throw new SessionLoadError(
      "anchors.camera.present is true but no camera.mp4 was supplied for this take. " +
      "Refusing to silently drop the PiP.",
    );
  }
  if (input.cameraMp4 && !claimsCamera) {
    throw new SessionLoadError(
      "a camera.mp4 was supplied but anchors.camera.present is not true — the anchors and " +
      "the file disagree about whether this take has a camera track.",
    );
  }

  // STC-233: identical reasoning to the camera check above, one track over.
  const claimsMic = anchors.mic?.present === true;
  if (claimsMic && !input.micM4a) {
    throw new SessionLoadError(
      "anchors.mic.present is true but no mic.m4a was supplied for this take. " +
      "Refusing to silently drop the audio.",
    );
  }
  if (input.micM4a && !claimsMic) {
    throw new SessionLoadError(
      "a mic.m4a was supplied but anchors.mic.present is not true — the anchors and " +
      "the file disagree about whether this take has a mic track.",
    );
  }

  // STC-418: the same check again, for the system-audio track.
  const claimsSystem = anchors.system?.present === true;
  if (claimsSystem && !input.systemM4a) {
    throw new SessionLoadError(
      "anchors.system.present is true but no system.m4a was supplied for this take. " +
      "Refusing to silently drop the audio.",
    );
  }
  if (input.systemM4a && !claimsSystem) {
    throw new SessionLoadError(
      "a system.m4a was supplied but anchors.system.present is not true — the anchors and " +
      "the file disagree about whether this take has a system-audio track.",
    );
  }

  const video = await demuxTrack(input.displayMp4, "display.mp4");
  if (video.framesNs.length === 0) {
    throw new SessionLoadError("display.mp4 contains no frames");
  }
  checkFrameOffset("display.mp4", (anchors.capture as { firstFrameNs?: number }).firstFrameNs, video.framesNs[0]!);

  let cameraVideo: DemuxedVideo | undefined;
  if (claimsCamera && input.cameraMp4) {
    cameraVideo = await demuxTrack(input.cameraMp4, "camera.mp4");
    if (cameraVideo.framesNs.length === 0) {
      throw new SessionLoadError("camera.mp4 contains no frames");
    }
    checkFrameOffset("camera.mp4", anchors.camera!.firstFramePtsNs, cameraVideo.framesNs[0]!);
  }

  let micAudio: DemuxedAudio | undefined;
  if (claimsMic && input.micM4a) {
    const rawMicAudio = await demuxAudioTrack(input.micM4a, "mic.m4a");
    if (rawMicAudio.framesNs.length === 0) {
      throw new SessionLoadError("mic.m4a contains no samples");
    }
    // NOT checkFrameOffset — see rebaseMicAudio's own header for why.
    micAudio = rebaseMicAudio(rawMicAudio, anchors.mic!.firstFramePtsNs);
  }

  // STC-418. Written by the same real-time AAC AVAssetWriter path as the mic,
  // so it carries no edit list either, and is rebased on the same terms.
  let systemAudio: DemuxedAudio | undefined;
  if (claimsSystem && input.systemM4a) {
    const rawSystemAudio = await demuxAudioTrack(input.systemM4a, "system.m4a");
    if (rawSystemAudio.framesNs.length === 0) {
      throw new SessionLoadError("system.m4a contains no samples");
    }
    systemAudio = rebaseMicAudio(rawSystemAudio, anchors.system!.firstFramePtsNs);
  }

  return {
    anchors,
    events: [...events.events].sort((a, b) => a.t - b.t),
    frames: video.framesNs,
    cameraFrames: cameraVideo?.framesNs,
    changes: input.changes,
    video,
    cameraVideo,
    micAudio,
    systemAudio,
  };
}
