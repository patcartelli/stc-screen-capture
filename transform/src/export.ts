import { render } from "./render.js";
import { exportFrameTimeNs } from "./time.js";
import { ForwardFrameSource } from "./frame-source.js";
import { composite } from "./compositor.js";
import type { LoadedSession } from "./session.js";
import type { Project } from "./types.js";
import { exportWindow, availableFrames } from "./trim.js";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { withTimeout } from "./timeout.js";
import { decodeAllAudio } from "./decode-audio.js";
import { tagMp4 } from "./media-tag.js";

/**
 * The export sink. ONE implementation, called by both the CLI gates and the
 * app — if the UI had its own copy, the gate comparing them would be comparing
 * two programs rather than verifying one.
 *
 * A sink behind the transform: every output frame is render() composited by the
 * shared compositor, the same two functions preview calls.
 */

export interface ExportOptions {
  fromFrame?: number;
  maxFrames?: number;
  /** Pre-encode hashing. Gate-only: it costs a full pixel read-back per frame. */
  hash?: boolean;
  /** Forces software rasterisation. Both backends are byte-identical; software is slower. */
  softwareRaster?: boolean;
  encode?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /**
   * The bundle's stable identity (STC-413), embedded in the trailing bytes so
   * a finished file can be traced back to its source after being renamed or
   * moved. This module stays pure of node: the CALLER resolves the id (which
   * needs `node:fs`, via `ensureCaptureId`) and hands it in as a plain
   * string. Omitted entirely for a caller with no bundle to identify — the
   * gate/harness drivers, which export straight from a fixture.
   */
  captureId?: string;
}

export interface ExportResult {
  frames: number;
  hash: string;
  encodedBytes: number;
  encoded?: Uint8Array;
  peakBufferedFrames: number;
  decodedFrames: number;
  /**
   * Camera frames decoded. Zero for a camera-less take — and zero for a take
   * that HAS one means the PiP never drew, which no hash comparison can see:
   * two sinks that both ignore the camera agree perfectly.
   */
  cameraDecodedFrames: number;
  /** STC-233. Audio chunks HANDED to the encoder; 0 for a take with no mic track. */
  micEncodedChunks: number;
  /**
   * Diagnostic (2026-09-18): audio chunks the encoder actually PRODUCED and
   * passed to `muxer.addAudioChunk`. Should equal `micEncodedChunks` when
   * things are working; a real hardware export sent 504 chunks IN and
   * produced a completely empty audio track (`nb_samples: 0`) with no error
   * anywhere, so this number is what tells apart "the encoder never emitted
   * anything for what it was fed" from "it emitted, but muxing it produced
   * no written sample" — two different bugs with the identical symptom.
   */
  audioOutputChunks: number;
  durationMs: number;
  cancelled: boolean;
}

export class ExportCancelled extends Error {
  constructor() { super("export cancelled"); this.name = "ExportCancelled"; }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportSession(
  session: LoadedSession, project: Project, opts: ExportOptions = {},
): Promise<ExportResult> {
  const t0 = performance.now();
  const source = new ForwardFrameSource(session.video);
  // A SECOND decoder, never a shared one. PHASE-0 §4b's one-in-flight rule is
  // per decoder, and ForwardFrameSource serialises internally, so two instances
  // are correct by construction.
  //
  // Forward-only is safe for the camera too: pip.frameIndex is monotonic in t
  // exactly as the display index is, because pipStateAt() returns null outside
  // the track's bounds rather than clamping backwards into it.
  const cameraSource = session.cameraVideo ? new ForwardFrameSource(session.cameraVideo) : null;
  // STC-233. Unlike the camera, the mic track has no per-frame relationship
  // to render() at all — it is clipped to the export window and muxed in,
  // never read by the compositor — so it needs no frame source, only the
  // decoded track itself.
  const micAudio = session.micAudio;
  const { width, height, fps } = project.output;
  const wantHash = opts.hash ?? false;

  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    alpha: false,
    willReadFrequently: opts.softwareRaster ?? wantHash,
  }) as OffscreenCanvasRenderingContext2D;

  const lastFrameNs = session.frames[session.frames.length - 1]!;
  // The same formula exportWindow uses, from the same module. A second copy
  // here agreed with it by inspection only, and "one value, two copies" is
  // this repo's most repeated defect.
  const available = availableFrames(lastFrameNs, fps);
  const clip = exportWindow(project, lastFrameNs);
  const from = Math.max(0, Math.min(opts.fromFrame ?? clip.fromFrame, available - 1));
  const total = Math.min(opts.maxFrames ?? clip.maxFrames, available - from);
  // An exported clip is its own file and its timeline starts at zero. render()
  // still receives SESSION time — cursor state depends on where we are in the
  // recording, not where this clip begins.
  const originNs = exportFrameTimeNs(from);

  // Decoded UP FRONT, before the muxer/encoder are configured — not where the
  // audio used to be decoded (after the video loop). The container's own
  // `mp4a` sample-entry header (demux-audio.ts's `sampleRate`/
  // `numberOfChannels`) is a SEPARATE claim from what the AAC bitstream
  // actually decodes to, and AVAssetWriter's own files have been observed
  // disagreeing between the two — the container header said stereo for a
  // mono capture. `AudioEncoder.encode()` throws "Input audio buffer is
  // incompatible with codec parameters" the instant a real `AudioData`'s
  // channels/sampleRate differ from what `configure()` was told, so
  // configuring the encoder from the container header while feeding it
  // decoder output is exactly the "one value, two copies" shape this file
  // keeps finding — except here the second copy is Chromium's decoder, not
  // a second line of our own. Decoding first and reading the REAL values off
  // the decoded `AudioData` closes that gap by construction: whatever the
  // encoder is configured with is what it will actually receive.
  const encode = opts.encode ?? true;
  const decodedAudio = micAudio && encode ? await decodeAllAudio(micAudio) : null;

  let muxer: Muxer<ArrayBufferTarget> | undefined;
  let encoder: VideoEncoder | undefined;
  let encoderError: Error | null = null;
  let audioEncoder: AudioEncoder | undefined;
  let audioEncoderError: Error | null = null;
  let audioOutputChunks = 0;
  // A track with no samples has nothing to encode and nothing to trust for
  // its own real parameters — treated the same as no mic track at all.
  const audioParams = decodedAudio && decodedAudio.length > 0
    ? { sampleRate: decodedAudio[0]!.sampleRate, numberOfChannels: decodedAudio[0]!.numberOfChannels }
    : null;
  // Configuring from chunk 0 assumes the decoded track is UNIFORM — observed
  // on real hardware NOT always to be: mic.m4a can decode with a DIFFERENT
  // channel count or sample rate partway through than its own first chunk
  // reports (a Bluetooth mic switching A2DP/HFP profile mid-take is one
  // candidate; unconfirmed — see docs/STC-233-RUNBOOK.md). Configuring the
  // encoder from chunk 0 and then feeding it a later, disagreeing chunk hits
  // the exact same "Input audio buffer is incompatible with codec
  // parameters" this file exists to avoid, just later and with the two
  // wrong values happening to have swapped which one is "the container's".
  // Scanning here fails fast, at decode time, with the actual chunk index
  // and values that diverge — instead of failing part way through encoding
  // with only the last chunk's shape to go on.
  if (decodedAudio && audioParams) {
    for (let i = 1; i < decodedAudio.length; i++) {
      const d = decodedAudio[i]!;
      if (d.numberOfChannels !== audioParams.numberOfChannels || d.sampleRate !== audioParams.sampleRate) {
        throw new Error(
          `mic.m4a's decoded track is not uniform: chunk 0 is ` +
          `${audioParams.numberOfChannels}ch/${audioParams.sampleRate}Hz, chunk ${i} of ` +
          `${decodedAudio.length} is ${d.numberOfChannels}ch/${d.sampleRate}Hz ` +
          `(chunk 0 timestamp ${decodedAudio[0]!.timestamp}us, chunk ${i} timestamp ${d.timestamp}us)`,
        );
      }
    }
  }
  if (encode) {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height },
      // STC-233: an audio track option on the SAME muxer, not a second file —
      // mp4-muxer already supports this; nothing about the video half changes.
      ...(audioParams
        ? { audio: { codec: "aac" as const, numberOfChannels: audioParams.numberOfChannels, sampleRate: audioParams.sampleRate } }
        : {}),
      fastStart: "in-memory",
      // mp4-muxer's DEFAULT is "strict": every track's FIRST sample must
      // have timestamp exactly 0 or addChunk throws. Video's always does —
      // its first frame is `exportFrameTimeNs(from) - originNs === 0` by
      // construction — but audio's first INCLUDED sample almost never lands
      // exactly on `originNs`, so every retimed audio chunk's timestamp is a
      // small positive number. That made EVERY `addAudioChunk` call throw,
      // silently: the throw happens inside the AudioEncoder's own async
      // `output` callback, outside this function's try/catch entirely, so
      // nothing here ever saw it — the export reported success, the audio
      // track's stsd was written correctly (synthesized from this Muxer
      // config, not from any successfully-added sample), and `nb_samples`
      // stayed 0. Confirmed on a real export: audioOutputChunks (507) far
      // exceeded the audio track's actual sample count (0). "cross-track-
      // offset" is mp4-muxer's own documented answer for exactly this
      // shape — both tracks' timestamps already come from the SAME clock
      // (`originNs`), so it offsets both by whichever track's first sample
      // is earliest (video's, already 0), which is a no-op for video and
      // leaves audio's true relative offset intact rather than "offset"'s
      // per-track behaviour, which would independently zero audio's first
      // sample and quietly shift it out of sync with the video.
      firstTimestampBehavior: "cross-track-offset",
    });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
    });
    // High @ L5.2 (PHASE-0 §8). NOT L4.0: its 2 Mpixel coded-area cap rejects 4K.
    encoder.configure({ codec: "avc1.640034", width, height, framerate: fps, bitrate: 12_000_000 });

    if (audioParams) {
      audioEncoder = new AudioEncoder({
        // Counted separately from `micEncodedChunks` (which only counts
        // calls INTO the encoder) so a hardware run can tell "the encoder
        // never produced output for what it was handed" apart from "it
        // produced output but muxer.addAudioChunk didn't result in a
        // written sample" — two very different bugs that look identical
        // from the export's own success/failure alone.
        output: (chunk, meta) => { audioOutputChunks++; muxer!.addAudioChunk(chunk, meta); },
        error: (e) => { audioEncoderError = e instanceof Error ? e : new Error(String(e)); },
      });
      // AAC-LC, matching what MicCapture.swift already wrote at capture time
      // (kAudioFormatMPEG4AAC) — re-encoded rather than remuxed because the
      // clip is a TIME WINDOW of the mic track, not the whole thing, and a
      // compressed AAC stream cannot be cut at an arbitrary sample boundary
      // the way the video's own GOP-aware muxing does not need to worry
      // about here either (every export frame is its own VideoFrame).
      audioEncoder.configure({
        codec: "mp4a.40.2", sampleRate: audioParams.sampleRate,
        numberOfChannels: audioParams.numberOfChannels, bitrate: 128_000,
      });
    }
  }

  const rolling = new Uint8Array(32);
  let peakBuffered = 0;
  let cancelled = false;

  try {
    for (let k = 0; k < total; k++) {
      if (opts.signal?.aborted) { cancelled = true; break; }
      if (encoderError) throw encoderError;

      const tNs = exportFrameTimeNs(from + k);
      const fs = render(project, session, tNs);
      // Frame selection is render()'s answer, not the sink's to re-derive: a
      // sink that recomputed it would keep the old rule if render()'s ever
      // changed, and the two would disagree silently.
      const idx = fs.frameIndex;
      const frame = idx === null ? null : await source.frameAt(idx);
      const cameraFrame = fs.pip && cameraSource ? await cameraSource.frameAt(fs.pip.frameIndex) : null;
      peakBuffered = Math.max(peakBuffered, source.bufferedCount + (cameraSource?.bufferedCount ?? 0));
      composite(ctx, frame, cameraFrame, fs, width, height);

      if (wantHash) {
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const h = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba as unknown as BufferSource));
        for (let i = 0; i < 32; i++) rolling[i]! ^= h[i]! + ((k * 31 + i) & 0xff);
      }

      if (encoder) {
        const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round((tNs - originNs) / 1000) });
        encoder.encode(vf, { keyFrame: k % fps === 0 });
        vf.close();
        // Bounded. An encoder that stops draining — no hardware encoder on the
        // machine, a codec it cannot actually service — would otherwise spin
        // here forever. Observed on a CI runner: 21 of 300 frames, then ten
        // minutes of nothing. Fail with a reason instead.
        const queueDeadline = performance.now() + 30_000;
        while (encoder.encodeQueueSize > 30) {
          if (opts.signal?.aborted) break;
          if (performance.now() > queueDeadline) {
            throw new Error(
              `encoder stopped draining at frame ${k} of ${total} ` +
              `(queue stuck at ${encoder.encodeQueueSize}) — no usable H.264 encoder?`,
            );
          }
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      // Yield periodically so a cancel click and the progress bar are not
      // starved by a loop that can run for minutes.
      if (k % 10 === 0) {
        opts.onProgress?.(k + 1, total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    let micEncodedChunks = 0;
    if (audioEncoder && decodedAudio && audioParams && !cancelled) {
      // The encoder's error callback fires ASYNCHRONOUSLY and names no
      // offending chunk — "Input audio buffer is incompatible with codec
      // parameters" gives no way to tell a sample-rate/channel mismatch from
      // a format one. It can also surface AFTER the loop below, as a
      // rejection of flush(), once several chunks are already queued — so a
      // single checked `audioEncoderError` can miss it. The whole block is
      // wrapped instead: whatever throws is enriched with what was actually
      // sent and what the encoder was configured for, so a failure here is a
      // diagnosis, not a second blind guess.
      let lastSent: string | undefined;
      try {
        if (audioEncoderError) throw audioEncoderError;
        // The export window in the SAME session-relative ns every other
        // track in this file uses — `endNs` is one past the last included
        // video frame, the export's own timeline boundary, not a separate
        // audio cut.
        const endNs = exportFrameTimeNs(from + total);
        // Already decoded up front, above, so the encoder could be
        // configured from the real thing it is about to receive.
        for (const data of decodedAudio) {
          // AudioData.timestamp is MICROSECONDS on the same session-relative
          // origin demux-audio.ts produced — clip to the export window and
          // retime to clip-relative, exactly as the VideoFrame above.
          const sampleNs = data.timestamp * 1000;
          if (sampleNs >= originNs && sampleNs < endNs && !audioEncoderError) {
            const retimed = retimeAudioData(data, Math.round((sampleNs - originNs) / 1000));
            lastSent = `format=${retimed.format} sampleRate=${retimed.sampleRate} ` +
              `numberOfChannels=${retimed.numberOfChannels} numberOfFrames=${retimed.numberOfFrames}`;
            audioEncoder.encode(retimed);
            retimed.close();
            micEncodedChunks++;
          }
        }
        if (audioEncoderError) throw audioEncoderError;
        // Same reasoning as the video encoder's own unbounded final flush
        // below: an encoder that never finishes would hang the export at 100%.
        await withTimeout(audioEncoder.flush(), 60_000, "audio encoder flush at end of export");
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new Error(
          `${cause} — encoder configured for mp4a.40.2 ${audioParams.sampleRate}Hz ` +
          `x${audioParams.numberOfChannels}ch; ${micEncodedChunks} chunk(s) encoded before this` +
          (lastSent ? `; last chunk sent: ${lastSent}` : "; no chunk was sent"),
        );
      }
    }

    let encodedBytes = 0;
    let encoded: Uint8Array | undefined;
    if (encoderError) throw encoderError;
    if (audioEncoderError) throw audioEncoderError;
    if (encoder && muxer && !cancelled) {
      // The per-frame back-pressure loop is bounded; this final flush was not.
      // An encoder that accepts every frame and then never finishes would hang
      // the export at 100% with the file unwritten — the worst moment to hang.
      await withTimeout(encoder.flush(), 120_000, "encoder flush at end of export");
      muxer.finalize();
      // STC-413: identity goes in the bytes, appended AFTER finalize so no
      // chunk offset moves — stco/co64 point into mdat, which does not shift.
      const raw = new Uint8Array((muxer.target as ArrayBufferTarget).buffer);
      const tagged = opts.captureId ? tagMp4(raw, opts.captureId) : raw;
      const buf = tagged.buffer.slice(tagged.byteOffset,
                                      tagged.byteOffset + tagged.byteLength) as ArrayBuffer;
      encodedBytes = buf.byteLength;
      encoded = new Uint8Array(buf);
    }
    if (encoder && encoder.state !== "closed") encoder.close();
    if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
    opts.onProgress?.(total, total);

    return {
      frames: cancelled ? 0 : total,
      hash: wantHash && !cancelled ? await sha256Hex(rolling) : "",
      encodedBytes, encoded,
      peakBufferedFrames: peakBuffered,
      decodedFrames: source.decodedCount,
      cameraDecodedFrames: cameraSource?.decodedCount ?? 0,
      micEncodedChunks: cancelled ? 0 : micEncodedChunks,
      audioOutputChunks: cancelled ? 0 : audioOutputChunks,
      durationMs: Math.round(performance.now() - t0),
      cancelled,
    };
  } finally {
    source.close();
    cameraSource?.close();
    if (decodedAudio) for (const d of decodedAudio) d.close();
    if (encoder && encoder.state !== "closed") encoder.close();
    if (audioEncoder && audioEncoder.state !== "closed") audioEncoder.close();
  }
}

/**
 * A copy of `data` with a different `timestamp`, same samples. There is no
 * WebCodecs call to retime an `AudioData` in place — the timestamp is
 * immutable — so a clip-relative export needs a fresh one, the way a clipped
 * `VideoFrame` above is a fresh `VideoFrame` over the same canvas at a
 * different timestamp.
 *
 * Handles both interleaved formats (one plane) and planar formats (one plane
 * per channel — AAC decode commonly yields `f32-planar`) by copying
 * `numberOfChannels` planes when the format ends in `-planar` and one
 * otherwise, each sized by `allocationSize` rather than assumed, since a
 * wrong size here is a wrong sample count, not merely a wrong timestamp.
 */
function retimeAudioData(data: AudioData, timestampUs: number): AudioData {
  const format = data.format!;
  const planar = format.endsWith("-planar");
  const numPlanes = planar ? data.numberOfChannels : 1;
  const planeSizes = Array.from({ length: numPlanes },
    (_, p) => data.allocationSize({ planeIndex: p, format }));
  const total = planeSizes.reduce((a, b) => a + b, 0);
  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  let offset = 0;
  for (let p = 0; p < numPlanes; p++) {
    data.copyTo(bytes.subarray(offset, offset + planeSizes[p]!), { planeIndex: p, format });
    offset += planeSizes[p]!;
  }
  return new AudioData({
    format, sampleRate: data.sampleRate, numberOfFrames: data.numberOfFrames,
    numberOfChannels: data.numberOfChannels, timestamp: timestampUs, data: buf,
  });
}
