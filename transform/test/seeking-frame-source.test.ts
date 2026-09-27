import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { syntheticVideo, gated } from "./_synthetic-track.js";
import { SeekingFrameSource } from "../src/seeking-frame-source.js";

let wc: FakeWebCodecs;
beforeEach(() => { wc = installFakeWebCodecs(); });
afterEach(() => wc.restore());

describe("SeekingFrameSource over a ByteSource (STC-236)", () => {
  test("returns the requested frame, fed with that chunk's own bytes", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    const f = (await s.frameAt(14)) as any;
    expect(f.timestamp).toBe(video.chunks[14]!.timestampUs);
    const fed14 = wc.fed.find((x) => x.timestamp === video.chunks[14]!.timestampUs)!;
    expect(fed14.data.every((b) => b === 14 % 251)).toBe(true);
    expect(fed14.data.byteLength).toBe(video.chunks[14]!.size);
    s.close();
  });

  test("superseded while awaiting bytes: resolves null and feeds nothing for it", async () => {
    let g!: ReturnType<typeof gated>;
    const video = syntheticVideo((buf) => (g = gated(buf)).src);
    const s = new SeekingFrameSource(video);
    const first = s.frameAt(4);
    // The second request must arrive while the first is INSIDE its read. Asked
    // any earlier, the first is superseded while still queued on the chain and
    // resolves null before reading anything — a pass that proves nothing.
    await vi.waitFor(() => expect(g.started()).toBeGreaterThan(0));
    const second = s.frameAt(25);
    g.release();
    expect(await first).toBeNull();
    const f = (await second) as any;
    expect(f.timestamp).toBe(video.chunks[25]!.timestampUs);
    // Nothing from group 0 reached the decoder: the first seek never fed.
    expect(wc.fed.some((x) => x.timestamp < video.chunks[10]!.timestampUs)).toBe(false);
    s.close();
  });

  test("a failed read poisons the source: this request and the next reject, naming the file", async () => {
    const video = syntheticVideo(() => ({ size: 1e6, read: () => Promise.reject(new Error("synthetic.mp4: read [0, 91) failed")) }));
    const s = new SeekingFrameSource(video);
    await expect(s.frameAt(3)).rejects.toThrow(/synthetic\.mp4/);
    await expect(s.frameAt(3)).rejects.toThrow(/synthetic\.mp4/);
    s.close();
  });

  test("closed while awaiting bytes: resolves without throwing and feeds nothing", async () => {
    let g!: ReturnType<typeof gated>;
    const video = syntheticVideo((buf) => (g = gated(buf)).src);
    const s = new SeekingFrameSource(video);
    const p = s.frameAt(4);
    await vi.waitFor(() => expect(g.started()).toBeGreaterThan(0));
    s.close();
    g.release();
    await expect(p).resolves.toBeNull();
    expect(wc.fed.length).toBe(0);
  });
});
