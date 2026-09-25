import { cleanNarration } from "@transform/narration-clean";
import type { PcmTrack } from "@transform/audio-mix";

/**
 * Narration cleanup OFF the editor's main thread (STC-454). The preview plays
 * the cleaned mic, like the export (Patrick, 2026-09-25), and cleaning is
 * about 1 s per minute of audio — long enough on a real take to stall the
 * picture and the transport if it ran where they do.
 *
 * The SAME `cleanNarration` export calls, bundled into this worker; nothing
 * here decides anything. Samples are transferred, not copied, both ways.
 */
interface Request { id: number; strength: number; track: PcmTrack }

const post = (self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, strength, track } = e.data;
  try {
    const out = cleanNarration(track, strength);
    post({ id, track: out }, out.channels.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
