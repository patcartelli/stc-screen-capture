import type { DemuxedAudio } from "./demux-audio.js";
import { withTimeout, TimeoutError } from "./timeout.js";
import { cleanNarration } from "./narration-clean.js";
import { trackFromChunks, type PcmChunk, type PcmTrack } from "./audio-mix.js";

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
 * Decoded `AudioData` → one contiguous planar track for audio-mix.ts, closing
 * each `AudioData` as soon as it has been copied out (PHASE-0 §4b.3's rule),
 * so the decoded track is held once, not twice. Shared by export's mix and
 * the editor's preview audio (STC-454), so both hear the same samples.
 */
export function pcmTrackOf(decoded: AudioData[], label: string): PcmTrack | null {
  const chunks: PcmChunk[] = [];
  try {
    for (const d of decoded) {
      const channels = Array.from({ length: d.numberOfChannels }, (_, ch) => {
        const plane = new Float32Array(d.numberOfFrames);
        d.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
        return plane;
      });
      chunks.push({ timestampUs: d.timestamp, sampleRate: d.sampleRate, channels });
    }
  } finally {
    for (const d of decoded) d.close();
  }
  return trackFromChunks(chunks, label);
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
  const track = pcmTrackOf(await decodeAllAudio(audio), "mic.m4a");
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
  return pcmTrackOf(await decodeAllAudio(audio), "system.m4a");
}
