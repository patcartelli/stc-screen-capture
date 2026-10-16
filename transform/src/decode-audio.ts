import type { DemuxedAudio } from "./demux-audio.js";
import { withTimeout, TimeoutError } from "./timeout.js";
import { cleanNarration } from "./narration-clean.js";
import { PcmTrackBuilder, type PcmTrack } from "./audio-mix.js";

/** One constant, so the bound and the message it prints cannot disagree — decode.ts's own rule. */
const FLUSH_MS = 60_000;

/**
 * Decode-all for the mic track (STC-233), the audio twin of decode.ts's
 * `decodeAll`. Audio has no per-frame memory hazard the way 4K `VideoFrame`s
 * do (a stereo 48 kHz `AudioData` is kilobytes, not megabytes), so unlike the
 * video path's `ForwardFrameSource` there is no bounded scrubbing cache here
 * — the whole track decodes up front, the same simplification a still
 * capture's frame already gets.
 *
 * `AudioData` MUST be closed once copied out, exactly as `decodeAll` closes
 * every `VideoFrame` in its output callback (PHASE-0 §4b.3's rule, extended
 * to the type WebCodecs uses for audio).
 */
export async function decodeAllAudio(audio: DemuxedAudio): Promise<AudioData[]> {
  const out: AudioData[] = [];
  let rejectAll: (e: Error) => void;
  const failure = new Promise<never>((_, rej) => { rejectAll = rej; });

  const decoder = new AudioDecoder({
    output: (data) => { out.push(data); },
    error: (e) => rejectAll(e),
  });
  decoder.configure({
    codec: audio.codec,
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.numberOfChannels,
    description: audio.description,
  });
  for (const c of audio.chunks) {
    decoder.decode(new EncodedAudioChunk({
      type: "key", timestamp: c.timestampUs, data: c.data as BufferSource,
    }));
  }
  try {
    await withTimeout(Promise.race([decoder.flush(), failure]), FLUSH_MS, "audio decoder flush");
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    throw new Error(
      `audio decoder flush did not complete within ${FLUSH_MS}ms — submitted ${audio.chunks.length} chunks, ` +
      `emitted ${out.length}, decodeQueueSize=${decoder.decodeQueueSize}, state=${decoder.state}, ` +
      `codec=${audio.codec} ${audio.sampleRate}Hz x${audio.numberOfChannels}ch`);
  }
  decoder.close();
  if (out.length !== audio.chunks.length) {
    for (const d of out) d.close();
    throw new Error(`decoded ${out.length} audio chunks, expected ${audio.chunks.length}`);
  }
  return out;
}

/**
 * Decodes a whole track straight into one contiguous planar `PcmTrack` for
 * audio-mix.ts (STC-491): each `AudioData` is copied into its place and
 * closed INSIDE the output callback (PHASE-0 §4b.3's rule), so the track is
 * the only full copy of the audio that ever exists. Placement, refusals and
 * every sample are `trackFromChunks`'s — `PcmTrackBuilder` is that function,
 * fed one chunk at a time — and the track's length is sized up front from
 * the demuxed sample table rather than from chunks held until the flush.
 *
 * `decodeAllAudio` stays for the one caller that needs `AudioData` itself
 * (export.ts's mic-only passthrough re-encodes them).
 */
async function decodeToTrack(audio: DemuxedAudio, label: string): Promise<PcmTrack | null> {
  if (audio.chunks.length === 0) return null;
  const builder = new PcmTrackBuilder(label, {
    firstUs: audio.chunks[0]!.timestampUs,
    lastUs: audio.chunks[audio.chunks.length - 1]!.timestampUs,
  });
  let emitted = 0;
  let failed = false;
  let rejectAll: (e: Error) => void;
  const failure = new Promise<never>((_, rej) => { rejectAll = rej; });

  const decoder = new AudioDecoder({
    output: (d) => {
      emitted++;
      try {
        if (!failed) {
          builder.add(d.timestamp, d.sampleRate, d.numberOfChannels, d.numberOfFrames,
            (ch, dst) => d.copyTo(dst, { planeIndex: ch, format: "f32-planar" }));
        }
      } catch (e) {
        failed = true;
        rejectAll(e as Error);
      } finally {
        d.close();
      }
    },
    error: (e) => { failed = true; rejectAll(e); },
  });
  try {
    decoder.configure({
      codec: audio.codec,
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.numberOfChannels,
      description: audio.description,
    });
    for (const c of audio.chunks) {
      decoder.decode(new EncodedAudioChunk({
        type: "key", timestamp: c.timestampUs, data: c.data as BufferSource,
      }));
    }
    try {
      await withTimeout(Promise.race([decoder.flush(), failure]), FLUSH_MS, `${label} decoder flush`);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      throw new Error(
        `audio decoder flush did not complete within ${FLUSH_MS}ms — submitted ${audio.chunks.length} chunks, ` +
        `emitted ${emitted}, decodeQueueSize=${decoder.decodeQueueSize}, state=${decoder.state}, ` +
        `codec=${audio.codec} ${audio.sampleRate}Hz x${audio.numberOfChannels}ch`);
    }
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  if (emitted !== audio.chunks.length) {
    throw new Error(`decoded ${emitted} audio chunks, expected ${audio.chunks.length}`);
  }
  return builder.finish();
}

/**
 * The ONE way a mic `PcmTrack` is made for playing or mixing (STC-469): the
 * export, the editor and the narration worker all call this, so a track made
 * in one of them is sample-for-sample the track any other would make — which
 * is what lets the export reuse the preview's (audio-mix.ts `reusableTracks`).
 * `cleanStrength` null is the raw mic; a number is that track through
 * `cleanNarration`, on the WHOLE take (STC-455: the noise profile is learned
 * from every pause).
 */
export async function decodeMicForMix(audio: DemuxedAudio, cleanStrength: number | null): Promise<PcmTrack | null> {
  const track = await decodeToTrack(audio, "mic.m4a");
  return track && cleanStrength !== null ? cleanNarration(track, cleanStrength) : track;
}

/**
 * The ONE way a system-audio `PcmTrack` is made for playing or mixing
 * (STC-469), `decodeMicForMix`'s twin: the export and the editor both call
 * this, so the track the preview holds is sample-for-sample the track the
 * export would decode — which is what lets the export reuse it (audio-mix.ts
 * `reusableTracks`) by construction rather than by two call sites agreeing.
 * There is no cleaning stage; system audio is never cleaned.
 */
export async function decodeSystemForMix(audio: DemuxedAudio): Promise<PcmTrack | null> {
  return decodeToTrack(audio, "system.m4a");
}
