import { demuxTrack, NoVideoTrackError, type DemuxedVideo } from "./demux.js";
import { demuxAudioTrack, type DemuxedAudio } from "./demux-audio.js";
import type { Anchors, KeyEvent, RecordedEvent, Session, SessionEvent } from "./types.js";
import { checkKeyEvent } from "./keycast.js";
import type { Changes } from "./changes.js";
import type { ByteSource } from "./chunk-reader.js";
import { checkGeometry } from "./display-geometry.js";
import { checkWindowTrack, stabiliseEvents } from "./window-track.js";
import { checkCaptureColour } from "./capture-colour.js";
import { SessionLoadError } from "./session-error.js";

/**
 * Turns a recorded session on disk into the Session the transform consumes.
 *
 * Environment-agnostic on purpose: it takes already-read data rather than
 * paths, so the same code serves Node tests and the browser export sink.
 */

// Re-exported so every existing `from "./session.js"` import keeps working —
// the class itself lives in session-error.ts to avoid a circular import with
// display-geometry.ts (checkGeometry throws it; session.ts calls checkGeometry).
export { SessionLoadError };

export interface SessionInput {
  anchors: Anchors;
  events: { version: number; events: RecordedEvent[] };
  displayMp4: ByteSource;
  cameraMp4?: ByteSource;
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

/**
 * STC-235, found on the first real-hardware run. A refit's `startNs` is the
 * helper's own number for the first refitted frame, in the helper's clock —
 * but `geometryAt` compares it against the DEMUXED PTS of the frame being
 * shown, and display.mp4 stores the session-start gap as an empty edit
 * quantised to the 90 kHz movie timescale (the same reason `checkFrameOffset`
 * needs a tolerance at all). Every demuxed PTS therefore sits the same
 * sub-tick amount off the helper's clock — -10583 ns on that take, where the
 * refitted frame demuxed at 1260200209 against a startNs of 1260210792, so
 * geometryAt chose entry 0 for it and the first refitted frame was drawn
 * under the OLD geometry.
 *
 * So each entry i >= 1 is snapped to the FIRST demuxed frame f with
 * f >= startNs - OFFSET_TOLERANCE_NS: the frame the helper meant, read on the
 * file's clock. Entry 0 is left alone — it must keep equalling
 * capture.firstFrameNs, and geometryAt already falls back to it for any frame
 * before its startNs. An entry with no such frame (the refit landed on a frame
 * the writer then dropped at the very end) is left UNCHANGED: geometryAt can
 * never select it, which is correct, and refusing the take would turn a
 * harmless trailing entry into a recording nobody can open.
 *
 * Order: snapping is monotone non-decreasing in startNs (a larger startNs can
 * only move the "first frame >= startNs - tol" later), so snapped entries stay
 * sorted; an unsnapped entry has startNs - tol > the last frame >= every
 * snapped value, so it stays strictly after them. The one way strictness is
 * lost is two refits snapping onto the SAME frame (both happened between two
 * written frames). Then only the LATER entry is kept: that frame was produced
 * after both refits applied, so the later configuration is the one it was
 * actually captured under — and it is also what geometryAt's last-match-wins
 * scan would have chosen anyway, so dropping the earlier one changes no
 * selection, it only restores the strictly-increasing shape every other
 * reader of `geometry` assumes.
 *
 * Returns the input unchanged when there is nothing to snap; never mutates it.
 */
function snapGeometryToFrames(anchors: Anchors, framesNs: readonly number[]): Anchors {
  const g = anchors.geometry;
  if (!g || g.length < 2) return anchors;
  const out = [g[0]!];
  let fi = 0;
  for (let i = 1; i < g.length; i++) {
    const e = g[i]!;
    const floor = e.startNs - OFFSET_TOLERANCE_NS;
    while (fi < framesNs.length && framesNs[fi]! < floor) fi++;
    const snapped = fi < framesNs.length ? { ...e, startNs: framesNs[fi]! } : e;
    if (out.length > 1 && out[out.length - 1]!.startNs === snapped.startNs) out.pop();
    out.push(snapped);
  }
  return { ...anchors, geometry: out };
}

const ENDED_BY: { mic: readonly string[]; camera: readonly string[]; system: readonly string[] } = {
  mic: ["disconnected", "format-mismatch"],
  camera: ["disconnected", "writer-failed"],   // writer-failed: STC-562, v15
  system: ["stream-stopped"],   // STC-542
};

/**
 * STC-237: `endedBy` on a `mic`/`camera`/`system` block says why that track ended before the take
 * did. Refused rather than ignored when it cannot be right: before v12 (an older reader
 * would never have been handed one), on a present:false block (there is no track to have
 * ended), or with a value the helper never writes.
 */
function checkEndedBy(anchors: Anchors): void {
  for (const name of ["mic", "camera", "system"] as const) {
    const block = anchors[name];
    const endedBy = block?.endedBy;
    if (endedBy === undefined) continue;
    // mic/camera arrived at 12 (STC-237); system's came later, at 14 (STC-542).
    // A camera's `writer-failed` came later still, at 15 (STC-562).
    const since = name === "system" ? 14 : name === "camera" && endedBy === "writer-failed" ? 15 : 12;
    if (anchors.version < since) {
      throw new SessionLoadError(`anchors.${name}.endedBy needs anchors version ${since}; this document is version ${anchors.version}`);
    }
    if (block!.present !== true) {
      throw new SessionLoadError(`anchors.${name}.endedBy is set on a ${name} block with present:false — there is no track to have ended`);
    }
    if (!ENDED_BY[name].includes(endedBy)) {
      throw new SessionLoadError(`anchors.${name}.endedBy "${endedBy}" is not one of ${ENDED_BY[name].join(", ")}`);
    }
  }
}

/**
 * STC-528: `silentSpans` on the `mic` block — the stretches where the mic delivered no
 * signal. Refused when it cannot be right: before v13, on a present:false block, empty
 * (the helper writes no key rather than an empty list), or out of order. Nothing in
 * render() reads it; it is for the library's notes (STC-529).
 */
function checkSilentSpans(anchors: Anchors): void {
  const spans = anchors.mic?.silentSpans;
  if (spans === undefined) return;
  if (anchors.version < 13) {
    throw new SessionLoadError(`anchors.mic.silentSpans needs anchors version 13; this document is version ${anchors.version}`);
  }
  if (anchors.mic!.present !== true) {
    throw new SessionLoadError("anchors.mic.silentSpans is set on a mic block with present:false — there is no track to have been silent");
  }
  if (!Array.isArray(spans) || spans.length === 0) {
    throw new SessionLoadError("anchors.mic.silentSpans must be a non-empty list when present");
  }
  let prevEnd = 0;
  for (const [i, s] of spans.entries()) {
    if (!Number.isInteger(s?.startNs) || !Number.isInteger(s?.endNs) || s.startNs < prevEnd || s.endNs <= s.startNs) {
      throw new SessionLoadError(`anchors.mic.silentSpans[${i}] must be whole ns, start < end, and after the span before it`);
    }
    prevEnd = s.endNs;
  }
}

function withoutEndedBy<T extends { endedBy?: unknown }>(block: T): T {
  const { endedBy: _dropped, ...rest } = block;
  return rest as T;
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
  //
  // v7's `geometry` (STC-235) is validated here and read by render() through
  // display-geometry.ts's geometryAt.
  //
  // v10 (STC-527) adds only the `disk-full` stop reason. Nothing here reads
  // `stop`; the take loads like any other, up to where it stopped.
  // v11 (STC-530) adds only the recorder-quit stop reason, written by the app's recovery
  // (app/src/recover-take.ts), never the helper. Nothing here reads `stop`. Such a take
  // usually has no events.json; its callers pass an empty events document for it, as
  // session-io.ts already does for any take without one.
  // v12 (STC-237) adds `endedBy` on `mic`/`camera`: why that track ended before the take
  // did. Checked in checkEndedBy; render() needs nothing new, since a track's own
  // `lastFramePtsNs` already ends the PiP and the audio mix reads silence past a track.
  // v14 (STC-542) adds `endedBy` on `system`: the system-audio stream died before the take
  // did. Checked in checkEndedBy; the audio mix already reads silence past a track.
  // v15 (STC-562) adds `writer-failed` as a camera `endedBy`: camera.mp4's writer failed
  // mid-take. Checked in checkEndedBy; the camera's own `lastFramePtsNs` ends the PiP.
  // v13 (STC-528) adds `silentSpans` on `mic`: where the mic delivered no signal for 10 s
  // or more. Checked in checkSilentSpans; nothing here plays it differently.
  if (
    anchors?.version !== 1 && anchors?.version !== 2 && anchors?.version !== 3 &&
    anchors?.version !== 4 && anchors?.version !== 5 && anchors?.version !== 6 &&
    anchors?.version !== 7 && anchors?.version !== 8 && anchors?.version !== 9 &&
    anchors?.version !== 10 && anchors?.version !== 11 && anchors?.version !== 12 &&
    anchors?.version !== 13 && anchors?.version !== 14 && anchors?.version !== 15
  ) {
    throw new SessionLoadError(`anchors.json version ${anchors?.version} is not supported (expected 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 or 15)`);
  }
  checkEndedBy(anchors);
  checkSilentSpans(anchors);
  // v9's `capture.colorSpace` (STC-510): which space the pixels are in, so a sink does
  // not draw a Display P3 take into an sRGB canvas. Refused if unknown, never defaulted.
  checkCaptureColour(anchors);
  checkGeometry(anchors);
  // v8's `scope.window.track` (STC-482): a window that moved. Validated here,
  // applied below by taking its displacement out of the cursor events.
  checkWindowTrack(anchors);
  // events-2 adds the cursor-shape event; a v1 document simply has none, and
  // the sim shows the arrow throughout — which is what v1 always meant.
  // events-3 (STC-419) adds keyboard COMMANDS. They are split out below into
  // session.keys: every cursor/zoom consumer reads x/y off session.events,
  // and a key has neither.
  if (events?.version !== 1 && events?.version !== 2 && events?.version !== 3) {
    throw new SessionLoadError(`events.json version ${events?.version} is not supported (expected 1, 2 or 3)`);
  }
  const pointerEvents: SessionEvent[] = [];
  const keyEvents: KeyEvent[] = [];
  events.events.forEach((e, i) => {
    if (e.kind === "key") keyEvents.push(checkKeyEvent(e, i));
    else pointerEvents.push(e);
  });

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
  checkFrameOffset("display.mp4", anchors.capture.firstFrameNs, video.framesNs[0]!);

  // STC-541: a camera that recorded NO frames leaves a camera.mp4 with no video
  // track (seen on hardware: 20 KB, no moov) or an empty one, while the anchors
  // still claim it. That is not the two sources disagreeing — the file is there,
  // it just holds nothing — so the take loads exactly as a take without a camera
  // does (`camera.present` false, which every reader checks first; the same drop
  // STC-530's recovery makes in recover-anchors.ts) instead of refusing the whole
  // recording over its PiP. A MALFORMED file and an offset disagreement still refuse.
  let cameraVideo: DemuxedVideo | undefined;
  let cameraDropped = false;
  if (claimsCamera && input.cameraMp4) {
    try {
      cameraVideo = await demuxTrack(input.cameraMp4, "camera.mp4");
    } catch (e) {
      if (!(e instanceof NoVideoTrackError)) throw e;
    }
    if (!cameraVideo || cameraVideo.framesNs.length === 0) {
      cameraVideo = undefined;
      cameraDropped = true;
    } else {
      checkFrameOffset("camera.mp4", anchors.camera!.firstFramePtsNs, cameraVideo.framesNs[0]!);
    }
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

  // STC-562: a camera writer that FAILED kept accepting appends for a few frames
  // after the sample that killed it (measured on hardware, 2026-10-16:
  // `lastFramePtsNs` 8.0 s into the track, the file's last frame ~2 s in), and the
  // fragment in flight never reached disk. So the helper's `lastFramePtsNs` is the
  // last frame APPENDED, not the last one WRITTEN, and the PiP (which ends there)
  // would hold a frozen frame across the difference. For this reason only, the file
  // is the truth: the track ends at its last demuxed frame.
  let anchorsOut = anchors;
  if (!cameraDropped && cameraVideo && anchors.camera?.endedBy === "writer-failed") {
    const lastOnDisk = cameraVideo.framesNs[cameraVideo.framesNs.length - 1]!;
    if (lastOnDisk < anchors.camera.lastFramePtsNs) {
      anchorsOut = { ...anchors, camera: { ...anchors.camera, lastFramePtsNs: lastOnDisk } };
    }
  }

  return {
    // checkGeometry above ran on the helper's ORIGINAL document; this is the
    // same timeline read on the file's clock — see snapGeometryToFrames.
    // A dropped camera also drops its `endedBy` (STC-237): there is no track left for it
    // to describe, and anchors-12 refuses one on a present:false block.
    anchors: snapGeometryToFrames(cameraDropped ? { ...anchors, camera: withoutEndedBy({ ...anchors.camera!, present: false }) } : anchorsOut, video.framesNs),
    events: [...stabiliseEvents(anchors, pointerEvents)].sort((a, b) => a.t - b.t),
    ...(keyEvents.length > 0 ? { keys: keyEvents.sort((a, b) => a.t - b.t) } : {}),
    frames: video.framesNs,
    cameraFrames: cameraVideo?.framesNs,
    changes: input.changes,
    video,
    cameraVideo,
    micAudio,
    systemAudio,
  };
}
