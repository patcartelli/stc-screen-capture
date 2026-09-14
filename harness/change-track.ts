import { mark } from "./mark.js";
import { demuxTrack } from "@transform/demux";
import { computeChangesForVideo, type ComputeChangesOptions } from "@transform/change-track";
import { changesForWrite } from "@transform/changes";
import { applyDecoderPreference } from "./decoder.js";

// STC-259: same reasoning as export.ts — handed in by the runner, never
// chosen here, so a wedged run's trail says which decoder it was asking for.
applyDecoderPreference();

/**
 * Thin browser wrapper for STC-322's spike, mirroring export.ts's shape: only
 * fetch and hand off to the ONE implementation
 * (`computeChangesForVideo`/`computeChangeDocument`, both in transform/src),
 * never re-derive anything here. Deliberately does not go through
 * `loadSession` — the change track only ever reads the display.mp4 track,
 * never the camera, and `loadSession` would refuse a request that supplies
 * neither camera.mp4 nor a claim of one, which this caller has no reason to
 * carry either way.
 */
(window as any).computeChanges = async (dir: string, opts: ComputeChangesOptions = {}) => {
  const displayMp4 = await fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer());
  mark("change-track: demuxTrack");
  const video = await demuxTrack(displayMp4, "display.mp4");
  mark(`change-track: computeChangesForVideo (${video.chunks.length} frames)`);
  const start = performance.now();
  const changes = await computeChangesForVideo(video, opts);
  const ms = performance.now() - start;
  mark("change-track: computeChangesForVideo returned");
  return {
    changes: changesForWrite(changes),
    frameCount: video.chunks.length,
    totalMs: ms,
    msPerFramePair: video.chunks.length > 1 ? ms / (video.chunks.length - 1) : null,
  };
};
(window as any).__changeTrackReady = true;
