import { loadSession } from "@transform/session";
import { memorySource } from "@transform/chunk-reader";
import { parseProject } from "@transform/trim";
import { PreviewPlayer } from "@transform/preview";
import { applyDecoderPreference } from "./decoder.js";

applyDecoderPreference();

/**
 * Replays playhead drags over a real take through the editor's own
 * PreviewPlayer (STC-632), and reports where each painted frame's time went.
 *
 * A drag is what the editor does on pointermove: an un-awaited `seek()` per
 * event, at the display's 60 Hz. Nothing here waits for a frame between
 * events, because the person dragging does not either.
 */
export interface DragSpec { name: string; fromNs: number; toNs: number; ms: number }

const MOVE_MS = 1000 / 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(window as any).runScrub = async (dir: string, projectRaw: unknown, drags: DragSpec[] | null) => {
  const [anchors, events, displayMp4] = await Promise.all([
    fetch(`${dir}/anchors.json`).then((r) => r.json()),
    fetch(`${dir}/events.json`).then((r) => (r.ok ? r.json() : { version: 1, events: [] })),
    fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
  ]);
  const cameraMp4 = anchors.files?.camera
    ? await fetch(`${dir}/${anchors.files.camera}`).then((r) => r.arrayBuffer())
    : undefined;
  // Unused here, but loadSession refuses a claimed track that was not supplied.
  const micM4a = anchors.files?.mic
    ? await fetch(`${dir}/${anchors.files.mic}`).then((r) => r.arrayBuffer())
    : undefined;
  const systemM4a = anchors.files?.system
    ? await fetch(`${dir}/${anchors.files.system}`).then((r) => r.arrayBuffer())
    : undefined;
  const session = await loadSession({
    anchors, events,
    displayMp4: memorySource(displayMp4, "display.mp4"),
    cameraMp4: cameraMp4 && memorySource(cameraMp4, "camera.mp4"),
    micM4a, systemM4a,
  });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
                               session.anchors.camera?.present === true);
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const player = new PreviewPlayer(canvas, session, project);
  await player.seek(player.firstRenderableNs);

  const keys = session.video.chunks.filter((c) => c.type === "key").length;
  const take = {
    durationS: durationNs / 1e9,
    frames: session.frames.length,
    capture: `${anchors.capture.width}x${anchors.capture.height}`,
    output: `${project.output.width}x${project.output.height}`,
    meanGop: session.video.chunks.length / keys,
    camera: !!cameraMp4,
    zoomBlocks: (project.overrides ?? []).length,
  };

  const mid = durationNs / 2;
  const span = Math.min(10e9, durationNs / 4);
  const plan: DragSpec[] = drags ?? [
    { name: "forward 10 s in 2 s", fromNs: mid - span, toNs: mid, ms: 2000 },
    { name: "backward 10 s in 2 s", fromNs: mid, toNs: mid - span, ms: 2000 },
    { name: "slow forward 2 s in 2 s", fromNs: mid, toNs: mid + 2e9, ms: 2000 },
    { name: "slow backward 2 s in 2 s", fromNs: mid + 2e9, toNs: mid, ms: 2000 },
    { name: "whole take in 2 s", fromNs: 0, toNs: durationNs, ms: 2000 },
  ];

  const results = [];
  for (const d of plan) {
    await player.seek(d.fromNs);
    const before = player.stats;
    const moves = Math.max(1, Math.round(d.ms / MOVE_MS));
    const started = performance.now();
    let last: Promise<void> = Promise.resolve();
    for (let i = 1; i <= moves; i++) {
      last = player.seek(d.fromNs + ((d.toNs - d.fromNs) * i) / moves);
      await sleep(MOVE_MS);
    }
    const lastMoveAt = performance.now();
    await last;
    const settledAt = performance.now();
    const after = player.stats;
    const painted = after.renderedFrames - before.renderedFrames;
    const per = (k: "render" | "decode" | "composite") =>
      painted ? (after.drawMs[k] - before.drawMs[k]) / painted : 0;
    results.push({
      name: d.name,
      moves,
      painted,
      paintedPerS: painted / ((lastMoveAt - started) / 1000),
      settleMs: settledAt - lastMoveAt,
      renderMs: per("render"),
      decodeMs: per("decode"),
      compositeMs: per("composite"),
      maxDecodeMs: after.drawMs.maxDecode,
      decodedPerPaint: painted ? (after.display.framesDecoded - before.display.framesDecoded) / painted : 0,
      flushes: after.display.flushes - before.display.flushes,
      decoderRestarts: after.display.decoderGenerations - before.display.decoderGenerations,
      lateFrames: after.lateFrames - before.lateFrames,
      peakBuffered: after.display.peakBuffered,
    });
  }
  player.close();
  return { take, results };
};

(window as any).__scrubReady = true;
