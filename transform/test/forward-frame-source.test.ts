import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { syntheticVideo, gated } from "./_synthetic-track.js";
import { ForwardFrameSource } from "../src/frame-source.js";

let wc: FakeWebCodecs;
beforeEach(() => { wc = installFakeWebCodecs(); });
afterEach(() => wc.restore());

describe("ForwardFrameSource over a ByteSource (STC-236)", () => {
  test("every frame in order, each fed with its own bytes", async () => {
    const video = syntheticVideo();
    const s = new ForwardFrameSource(video);
    for (let i = 0; i < video.chunks.length; i++) {
      expect(((await s.frameAt(i)) as any).timestamp).toBe(video.chunks[i]!.timestampUs);
    }
    expect(wc.fed.map((x) => x.timestamp)).toEqual(video.chunks.map((c) => c.timestampUs));
    wc.fed.forEach((x, i) => expect(x.data.every((b) => b === i % 251)).toBe(true));
    s.close();
  });

  test("a failed read rejects frameAt and every later call", async () => {
    const video = syntheticVideo(() => ({ size: 1e6, read: () => Promise.reject(new Error("synthetic.mp4: gone")) }));
    const s = new ForwardFrameSource(video);
    await expect(s.frameAt(0)).rejects.toThrow("synthetic.mp4: gone");
    await expect(s.frameAt(1)).rejects.toThrow("synthetic.mp4: gone");
    s.close();
  });

  test("closed while awaiting bytes: resolves without throwing", async () => {
    let g!: ReturnType<typeof gated>;
    const video = syntheticVideo((buf) => (g = gated(buf)).src);
    const s = new ForwardFrameSource(video);
    const p = s.frameAt(0);
    await vi.waitFor(() => expect(g.started()).toBeGreaterThan(0));
    s.close();
    g.release();
    await expect(p).resolves.toBeNull();
    expect(wc.fed.length).toBe(0);
  });
});
