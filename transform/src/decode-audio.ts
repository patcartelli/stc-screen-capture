import type { DemuxedAudio } from "./demux-audio.js";
import { withTimeout, TimeoutError } from "./timeout.js";

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
