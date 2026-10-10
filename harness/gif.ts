import { mark } from "./mark.js";
import { loadSession } from "@transform/session";
import { memorySource } from "@transform/chunk-reader";
import { exportGif } from "@transform/gif-export";
import type { GifSettings } from "@transform/gif-options";
import { parseProject } from "@transform/trim";
import type { Project } from "@transform/types";
import { applyDecoderPreference } from "./decoder.js";

applyDecoderPreference();

/**
 * Thin browser wrapper: fetch a session, then call the ONE GIF implementation
 * the app also uses. `projectRaw` is the take's project.json as read from
 * disk, or null — parseProject decides every default, exactly as in export.ts.
 */
(window as any).exportGif = async (dir: string, projectRaw: unknown, settings: GifSettings,
                                 opts: { dither?: boolean } = {}) => {
  const [anchors, events, displayMp4] = await Promise.all([
    fetch(`${dir}/anchors.json`).then((r) => r.json()),
    fetch(`${dir}/events.json`).then((r) => r.json()),
    fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
  ]);
  const cameraMp4 = anchors.files?.camera
    ? await fetch(`${dir}/${anchors.files.camera}`).then((r) => r.arrayBuffer())
    : undefined;
  // A GIF has no audio, but loadSession refuses a take whose anchors claim a
  // track it was not handed ("refusing to silently drop the audio").
  const micM4a = anchors.files?.mic
    ? await fetch(`${dir}/${anchors.files.mic}`).then((r) => r.arrayBuffer())
    : undefined;
  const systemM4a = anchors.files?.system
    ? await fetch(`${dir}/${anchors.files.system}`).then((r) => r.arrayBuffer())
    : undefined;
  mark("gif: loadSession (demux + VideoDecoder.configure)");
  const session = await loadSession({
    anchors, events,
    displayMp4: memorySource(displayMp4, "display.mp4"),
    cameraMp4: cameraMp4 && memorySource(cameraMp4, "camera.mp4"),
    micM4a, systemM4a,
  });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project: Project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );
  mark("gif: exportGif");
  const r = await exportGif(session, project, { settings, dither: opts.dither });
  mark("gif: exportGif returned");
  let s = "";
  for (let i = 0; i < r.bytes.length; i += 0x8000) s += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
  return { base64: btoa(s), frames: r.frames, width: r.width, height: r.height, durationCs: r.durationCs, elapsedMs: r.elapsedMs,
           ditherStats: r.ditherStats };
};
(window as any).__gifReady = true;
