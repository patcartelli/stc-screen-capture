import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakeWebCodecs, FAKE_FRAME_BYTES, type FakeWebCodecs } from "./_fake-webcodecs.js";
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

// The synthetic track's keyframes are 0, 10, 20. Before STC-635 a step back
// restarted at the keyframe and re-fed its whole group, every time.
describe("frames kept behind the playhead (STC-635)", () => {
  const ts = (video: ReturnType<typeof syntheticVideo>, i: number) => video.chunks[i]!.timestampUs;

  test("a step back to a frame the decoder passed is served without feeding anything", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    await s.frameAt(18);
    const fedBefore = wc.fed.length;
    const f = (await s.frameAt(15)) as any;
    expect(f.timestamp).toBe(ts(video, 15));
    expect(wc.fed.length).toBe(fedBefore);
    expect(s.stats.decoderGenerations).toBe(1);
    expect(s.stats.behindHits).toBe(1);
    s.close();
  });

  test("a drag that turns forward again continues the decoder rather than restarting it", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    await s.frameAt(18);
    await s.frameAt(15);
    const f = (await s.frameAt(19)) as any;
    expect(f.timestamp).toBe(ts(video, 19));
    expect(s.stats.decoderGenerations).toBe(1);
    s.close();
  });

  test("kept frames stay inside the budget, the farthest from the playhead closed first", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video, 5 * FAKE_FRAME_BYTES);
    await s.frameAt(18);
    expect(s.stats.behindFrames).toBe(5);
    expect(s.stats.peakBehindBytes).toBe(5 * FAKE_FRAME_BYTES);
    // 13..17 are the five nearest 18; 10..12 went first.
    for (const i of [10, 11, 12]) {
      expect(wc.outputs.find((o) => o.timestamp === ts(video, i))!.closed).toBe(true);
    }
    await s.frameAt(13);
    expect(s.stats.decoderGenerations).toBe(1);
    await s.frameAt(12);
    expect(s.stats.decoderGenerations).toBe(2);
    s.close();
  });

  test("a budget of zero keeps nothing, as before", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video, 0);
    await s.frameAt(18);
    expect(s.stats.behindFrames).toBe(0);
    await s.frameAt(15);
    expect(s.stats.decoderGenerations).toBe(2);
    s.close();
  });

  test("a restart into another group keeps the frame it leaves", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    await s.frameAt(18);
    await s.frameAt(5);                         // back past keyframe 10: a restart
    const fedBefore = wc.fed.length;
    const f = (await s.frameAt(18)) as any;     // the frame it was on is still there
    expect(f.timestamp).toBe(ts(video, 18));
    expect(wc.fed.length).toBe(fedBefore);
    s.close();
  });

  test("close() closes every kept frame", async () => {
    const video = syntheticVideo();
    const s = new SeekingFrameSource(video);
    await s.frameAt(18);
    await s.frameAt(5);
    s.close();
    // Let any decode still in flight land, then check nothing was left open.
    await new Promise((r) => setTimeout(r, 10));
    expect(wc.outputs.filter((o) => !o.closed)).toEqual([]);
  });
});
