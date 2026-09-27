/**
 * Just enough WebCodecs for the frame sources' own logic to run in Node:
 * every decoded chunk comes back, one macrotask later, as a frame carrying
 * its timestamp. It decodes nothing — the gates do that in real Chrome. What
 * it lets a Node test see is the part the gates cannot aim at: what the
 * sources feed, in what order, and what they do while waiting for bytes.
 */
export interface FakeFrame { timestamp: number; closed: boolean; close(): void }
export interface FakeWebCodecs { fed: { timestamp: number; data: Uint8Array }[]; restore(): void }

export function installFakeWebCodecs(): FakeWebCodecs {
  const g = globalThis as any;
  const saved = { VideoDecoder: g.VideoDecoder, EncodedVideoChunk: g.EncodedVideoChunk };
  const fed: FakeWebCodecs["fed"] = [];

  g.EncodedVideoChunk = class {
    type: string; timestamp: number; data: Uint8Array;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      this.type = init.type; this.timestamp = init.timestamp; this.data = new Uint8Array(init.data);
    }
  };
  g.VideoDecoder = class {
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private readonly cb: { output: (f: FakeFrame) => void; error: (e: unknown) => void }) {}
    configure() { this.state = "configured"; }
    decode(chunk: { timestamp: number; data: Uint8Array }) {
      if (this.state === "closed") {
        throw new DOMException("Cannot call 'decode' on a closed codec.", "InvalidStateError");
      }
      fed.push({ timestamp: chunk.timestamp, data: chunk.data });
      this.decodeQueueSize++;
      setTimeout(() => {
        if (this.state === "closed") return;
        this.decodeQueueSize--;
        const f: FakeFrame = { timestamp: chunk.timestamp, closed: false, close() { this.closed = true; } };
        this.cb.output(f);
      }, 0);
    }
    flush() { return new Promise<void>((r) => setTimeout(r, 1)); }
    close() { this.state = "closed"; }
  };
  return { fed, restore: () => Object.assign(g, saved) };
}
