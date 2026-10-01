import { decodeMicForMix } from "@transform/decode-audio";
import type { DemuxedAudio } from "@transform/demux-audio";

/**
 * Narration cleanup OFF the editor's main thread (STC-454). The preview plays
 * the cleaned mic, like the export (Patrick, 2026-09-25), and cleaning is
 * about 1 s per minute of audio — long enough on a real take to stall the
 * picture and the transport if it ran where they do.
 *
 * STC-469: it is sent the COMPRESSED mic (~1 MB/min, structured-cloned — the
 * session keeps using its own) and decodes it here, through the same
 * `decodeMicForMix` the export calls, so the editor never has to keep a raw
 * decoded copy just to have something to send. Nothing here decides
 * anything. The cleaned samples are transferred back, not copied.
 */
interface Request { id: number; strength: number; audio: DemuxedAudio }

const post = (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage.bind(self);

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, strength, audio } = e.data;
  try {
    const track = await decodeMicForMix(audio, strength);
    post({ id, track }, track ? track.channels.map((c) => c.buffer as ArrayBuffer) : []);
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
