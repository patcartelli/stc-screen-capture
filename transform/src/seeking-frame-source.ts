import type { DemuxedVideo } from "./demux.js";
import { withTimeout } from "./timeout.js";
import { decoderPreference } from "./decoder-preference.js";
import { ChunkReader } from "./chunk-reader.js";

/**
 * Random-access frame source for the preview sink.
 *
 * The opposite access pattern to ForwardFrameSource, and far more dangerous.
 * PHASE-0 §4b was written from a harness that repeatedly killed the tab doing
 * exactly this, and each of its lessons is load-bearing here:
 *
 *  1. ONE in-flight request. A slider drag fires dozens of input events, and
 *     overlapping decodes against one decoder reset it mid-flight and leak 4K
 *     frames until the tab dies. Requests are serialised and superseded ones
 *     resolve null rather than racing.
 *  2. NEVER "reset on overshoot". The original loop submitted a target, saw an
 *     empty output queue, concluded it had overshot, reset, and repeated — an
 *     infinite loop allocating a fresh VideoDecoder every spin. This decodes
 *     forward from the governing keyframe with a strictly advancing counter and
 *     resets only when the target is genuinely unreachable by going forward.
 *  3. Close frames in the output callback path, retaining at most one. At 4K a
 *     frame is ~30 MB, so even a short backlog is hundreds of megabytes.
 *     STC-635 relaxes this one deliberately, and only behind a byte cap: the
 *     frames the decoder already passed are kept (`behind`), up to
 *     the source's byte budget, because a step backward is otherwise a restart at
 *     the keyframe that re-decodes the whole group to keep its last frame.
 */
export class SeekingFrameSource {
  private decoder: VideoDecoder | null = null;
  private readonly pending: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private currentIndex = -1;
  private nextFeed = 0;
  private nextOutIndex = 0;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private ticket = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly keyIndices: number[];
  private peakBuffered = 0;
  private decoderGenerations = 0;
  /** Every frame the decoder emitted, wanted or not: a seek mid-group decodes its way there. */
  private framesDecoded = 0;
  /** Flushes mid-seek; each leaves the decoder needing a keyframe, so the next seek restarts. */
  private flushes = 0;
  /** A flushed decoder refuses delta chunks until it sees a keyframe again. */
  private needsKeyframe = false;

  /**
   * How far past the target to feed: H.264's largest decoded-picture buffer,
   * 16 frames (STC-632). The capture's stream carries no reorder hint, so a
   * decoder may hold that many frames before emitting one, and VideoToolbox
   * does. At 8 the target never came out without a flush, a flushed decoder
   * needs a keyframe, and so every seek, one frame forward included,
   * re-decoded its whole group: 15 painted frames/s on a drag. Measured on a
   * 2226x1884 take with scripts/scrub-timing-one.mjs: 12 still flushed on
   * most seeks, 16 never did, and forward drags painted at 60/s.
   */
  private static readonly FEED_AHEAD = 16;

  /**
   * How many bytes of already-decoded frames a source may keep (STC-635).
   * A backward drag restarts at the keyframe on every step and re-decodes the
   * group to keep its last frame: on a 10-minute 4K take that was 25 frames
   * and 80 ms per painted frame, 13 painted/s. Kept frames turn every step
   * back within reach into a lookup, so a drag restarts once per stretch the
   * cache covers, not once per step.
   *
   * 512 MiB is about 41 frames at 4K (NV12, 12.4 MB each), just under one
   * keyframe group of the capture's 45. The camera's is a quarter of that,
   * the same ~41 frames at 1080p. Measured on the Mac, 2026-11-03, with
   * scripts/scrub-timing-one.mjs: a backward drag at playback speed on a
   * 10-minute 4K take went from 13 to 51 painted/s.
   */
  static readonly DISPLAY_BEHIND_BYTES = 512 * 1024 * 1024;
  static readonly CAMERA_BEHIND_BYTES = 128 * 1024 * 1024;
  private readonly behind = new Map<number, VideoFrame>();
  private behindBytes = 0;
  private frameBytes = 0;
  private behindHits = 0;
  private peakBehindBytes = 0;
  private readonly reader: ChunkReader;

  constructor(private readonly video: DemuxedVideo,
              private readonly behindBudgetBytes = SeekingFrameSource.DISPLAY_BEHIND_BYTES) {
    this.keyIndices = video.chunks
      .map((c, i) => (c.type === "key" ? i : -1))
      .filter((i) => i >= 0);
    if (this.keyIndices.length === 0) throw new Error("no keyframes: cannot seek");
    this.reader = new ChunkReader(video.chunks, video.bytes, "video");
  }

  /**
   * The decoded frame for `index`, requested in any order. Resolves null when a
   * newer request superseded this one — a scrub only cares about the latest.
   * Out-of-range indices clamp, matching "hold, never interpolate".
   */
  frameAt(index: number): Promise<VideoFrame | null> {
    const mine = ++this.ticket;
    const run = this.chain.then(() => {
      if (mine !== this.ticket) return null;          // superseded while queued
      const clamped = Math.max(0, Math.min(index, this.video.chunks.length - 1));
      return this.seek(clamped, mine);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private governingKey(index: number): number {
    let lo = 0, hi = this.keyIndices.length - 1, best = this.keyIndices[0]!;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyIndices[mid]! <= index) { best = this.keyIndices[mid]!; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  private async seek(index: number, mine: number): Promise<VideoFrame | null> {
    if (this.failure) throw this.failure;
    if (index === this.currentIndex && this.current) return this.current;
    // A kept frame leaves the decoder where it is, so a drag that turns
    // forward again continues from there rather than from the keyframe.
    const kept = this.behind.get(index);
    if (kept) { this.behindHits++; return kept; }

    const key = this.governingKey(index);
    // Forward from here is only valid if we are already past the governing
    // keyframe and have not gone beyond the target. Anything else restarts at
    // the keyframe — decided from position, never from "the queue looked empty".
    const canContinue = this.decoder !== null && !this.needsKeyframe &&
                        this.currentIndex < index && this.nextOutIndex > key;
    if (!canContinue) this.restartAt(key, index);

    while (this.currentIndex < index) {
      if (mine !== this.ticket) return null;          // a newer seek wants the decoder
      if (this.failure) throw this.failure;

      if (this.pending.length > 0) {
        const next = this.pending.shift()!;
        if (this.current) this.keepBehind(this.current, this.currentIndex, index);
        this.current = next;
        this.currentIndex = this.nextOutIndex - this.pending.length - 1;
        continue;
      }
      if (!(await this.pump(index, mine))) break;
    }
    return this.current;
  }

  /**
   * Keep a frame the decoder has moved past, then evict down to the budget,
   * farthest from `target` first: a drag wants what is next to the playhead,
   * on either side, since it may turn round.
   */
  private keepBehind(frame: VideoFrame, index: number, target: number): void {
    if (this.behind.has(index)) { frame.close(); return; }
    if (this.frameBytes === 0) {
      // A format allocationSize() cannot size is counted as RGBA, the
      // largest it could be, so the cap errs towards keeping fewer.
      try { this.frameBytes = frame.allocationSize(); }
      catch { this.frameBytes = frame.codedWidth * frame.codedHeight * 4; }
    }
    this.behind.set(index, frame);
    this.behindBytes += this.frameBytes;
    while (this.behindBytes > this.behindBudgetBytes && this.behind.size > 0) {
      let far = index, farDist = -1;
      for (const i of this.behind.keys()) {
        const dist = Math.abs(i - target);
        if (dist > farDist) { far = i; farDist = dist; }
      }
      this.behind.get(far)!.close();
      this.behind.delete(far);
      this.behindBytes -= this.frameBytes;
    }
    this.peakBehindBytes = Math.max(this.peakBehindBytes, this.behindBytes);
  }

  private restartAt(key: number, target: number): void {
    if (this.current) this.keepBehind(this.current, this.currentIndex, target);
    this.current = null;
    for (const f of this.pending.splice(0)) f.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.pending.push(frame);
        this.nextOutIndex++;
        this.framesDecoded++;
        this.peakBuffered = Math.max(this.peakBuffered, this.pending.length + (this.current ? 1 : 0));
        this.wake?.();
      },
      error: (e) => { this.failure = e instanceof Error ? e : new Error(String(e)); this.wake?.(); },
    });
    this.decoder.configure({
      codec: this.video.codec,
      codedWidth: this.video.codedWidth,
      codedHeight: this.video.codedHeight,
      description: this.video.description,
      ...decoderPreference(),
      // A scrub wants the frame it asked for NOW, not the throughput a batch
      // decode would prefer. Without this the decoder buffers several frames
      // before its first output, which is the wrong trade for random access.
      optimizeForLatency: true,
    });
    this.decoderGenerations++;
    this.needsKeyframe = false;
    this.nextFeed = key;
    this.nextOutIndex = key;
    this.currentIndex = key - 1;
  }

  private async pump(target: number, mine: number): Promise<boolean> {
    const d = this.decoder!;
    // Feed up to a bounded distance PAST the target. Bounding by nextFeed and
    // not by nextOutIndex matters: before the first output, nextOutIndex has
    // not moved, so an output-based bound cannot limit anything.
    const feedLimit = target + SeekingFrameSource.FEED_AHEAD;
    const upto = Math.min(this.video.chunks.length, feedLimit + 1,
                          this.nextFeed + Math.max(0, SeekingFrameSource.FEED_AHEAD - d.decodeQueueSize));
    if (upto > this.nextFeed) {
      const from = this.nextFeed;
      let datas: Uint8Array[];
      try {
        datas = await this.reader.read(from, upto - from);
      } catch (e) {
        // A read failure is as fatal as a decoder error and surfaces the same
        // way: every later request throws it too, rather than a frozen frame.
        this.failure = e instanceof Error ? e : new Error(String(e));
        throw this.failure;
      }
      // The await is a window a newer seek can use. It cannot touch this
      // decoder — the chain serialises seeks, so it is still queued behind
      // this one — but it has asked for a different frame, and feeding ones
      // nobody wants only delays it. Feed nothing and let seek() see the new
      // ticket and resolve null.
      if (mine !== this.ticket) return true;
      // The await is also a window for close() (the preview closing a take
      // mid-scrub), and close() is the ONLY thing that can reach `d` here:
      // it does not go through the chain. Feeding a closed decoder would
      // throw InvalidStateError, so feed nothing and let seek() unwind. The
      // `this.decoder !== d` half is defensive — by the argument above no
      // restartAt can run in this window — kept so that a future path which
      // replaces the decoder off the chain fails safe rather than feeding a
      // dead one.
      if (this.decoder !== d || d.state === "closed") return false;
      datas.forEach((data, k) => {
        const c = this.video.chunks[from + k]!;
        d.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: data as BufferSource }));
      });
      this.nextFeed = upto;
    }
    if (this.pending.length > 0) return true;

    const exhausted = this.nextFeed >= this.video.chunks.length || this.nextFeed > feedLimit;

    // The decoder has swallowed everything and produced nothing. Waiting here
    // deadlocks — no output means no wake-up ever comes. More input is what
    // unblocks it, so loop and feed; only flush once there is nothing left to
    // feed. This is the failure the first gate run caught: queue drained to 0,
    // pending 0, waiting forever with a perfectly healthy decoder.
    if (d.decodeQueueSize === 0) {
      if (!exhausted) return true;
      await withTimeout(d.flush(), 30_000, "decoder flush at end of stream")
        .catch((e) => { this.failure = e instanceof Error ? e : new Error(String(e)); });
      this.needsKeyframe = true;
      this.flushes++;
      return this.pending.length > 0;
    }

    // BOUNDED wait. The queue was full when we checked above and may drain to
    // nothing without emitting, and an unbounded wait then parks forever on a
    // perfectly healthy decoder — exactly what the gate caught. Re-looping
    // re-evaluates: feed more if there is more, flush if there is not.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, 50);
      this.wake = () => { this.wake = null; clearTimeout(timer); resolve(); };
    });
    return true;
  }

  close(): void {
    this.current?.close();
    this.current = null;
    for (const f of this.behind.values()) f.close();
    this.behind.clear();
    this.behindBytes = 0;
    for (const f of this.pending.splice(0)) f.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  /** Gate instrumentation: what the source is stuck on, if anything. */
  get debug() {
    return {
      decoderState: this.decoder?.state ?? "none",
      decodeQueueSize: this.decoder?.decodeQueueSize ?? -1,
      pending: this.pending.length,
      nextFeed: this.nextFeed,
      nextOutIndex: this.nextOutIndex,
      currentIndex: this.currentIndex,
      needsKeyframe: this.needsKeyframe,
      failure: this.failure ? String(this.failure) : null,
      waiting: this.wake !== null,
    };
  }

  /** Gate instrumentation. */
  get stats() {
    return {
      peakBuffered: this.peakBuffered,
      decoderGenerations: this.decoderGenerations,
      framesDecoded: this.framesDecoded,
      flushes: this.flushes,
      liveFrames: this.pending.length + (this.current ? 1 : 0) + this.behind.size,
      behindHits: this.behindHits,
      behindFrames: this.behind.size,
      peakBehindBytes: this.peakBehindBytes,
    };
  }
}
