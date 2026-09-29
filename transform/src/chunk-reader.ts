/**
 * Where a video chunk's bytes come from (STC-236).
 *
 * The editor used to read a whole display.mp4 into one ArrayBuffer before
 * demuxing it: +548 MB of renderer RSS for a 458 MB take, so ~15 minutes at
 * 4K was the ceiling (STC-251). A chunk is now a REFERENCE — an offset and a
 * size in the file — and this module is the one place its bytes are fetched.
 *
 * It fetches a whole keyframe GROUP at a time, because that is the unit every
 * consumer needs: a seek decodes forward from the governing keyframe, and
 * export walks groups in order. Inside a group the samples are usually, but
 * NOT always, back to back (measured: 6 discontinuities in a real 740-frame
 * take), so a group is fetched as one read per contiguous run, never as one
 * blind range from its first byte to its last.
 *
 * Pure: no DOM, no Electron, no node. The editor supplies an IPC-backed
 * ByteSource; the harness, the gates and every test use `memorySource`.
 */

export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`, or throws. Never short, never padded. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface VideoChunkRef {
  type: "key" | "delta";
  timestampUs: number;
  /** absolute offset in the file */
  offset: number;
  size: number;
}

export function memorySource(buf: ArrayBuffer, what: string): ByteSource {
  const size = buf.byteLength;
  return {
    size,
    read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        return Promise.reject(new Error(`${what}: read [${offset}, ${offset + length}) is outside the ${size}-byte file`));
      }
      return Promise.resolve(new Uint8Array(buf, offset, length));
    },
  };
}

export class ChunkReader {
  /**
   * Two: the group being decoded and the one after it. Export prefetches the
   * next group while the current one decodes, and a seek's feed-ahead can
   * cross one boundary; neither ever needs a third. At 4K a group is a few MB
   * of ENCODED bytes, so this is the whole of what the editor holds per track.
   */
  static readonly MAX_CACHED_GROUPS = 2;

  private readonly keyStarts: number[];
  private readonly cache = new Map<number, Promise<Uint8Array[]>>();

  constructor(private readonly chunks: readonly VideoChunkRef[],
              private readonly bytes: ByteSource,
              private readonly what: string) {
    const starts = chunks.map((c, i) => (c.type === "key" ? i : -1)).filter((i) => i > 0);
    this.keyStarts = [0, ...starts];
  }

  groupOf(index: number): { start: number; end: number } {
    let lo = 0, hi = this.keyStarts.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyStarts[mid]! <= index) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return { start: this.keyStarts[best]!, end: this.keyStarts[best + 1] ?? this.chunks.length };
  }

  async read(first: number, count: number): Promise<Uint8Array[]> {
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || first + count > this.chunks.length) {
      throw new Error(`${this.what}: chunks [${first}, ${first + count}) are out of range (0..${this.chunks.length})`);
    }
    const out: Uint8Array[] = [];
    const stop = first + count;
    for (let i = first; i < stop;) {
      const g = this.groupOf(i);
      const group = await this.group(g.start, g.end);
      const until = Math.min(g.end, stop);
      out.push(...group.slice(i - g.start, until - g.start));
      i = until;
    }
    return out;
  }

  prefetch(index: number): void {
    if (index < 0 || index >= this.chunks.length) return;
    const g = this.groupOf(index);
    // A failure here is kept in the promise and surfaces on the next read of
    // this group; the no-op catch only stops it being reported as unhandled.
    this.group(g.start, g.end).catch(() => {});
  }

  private group(start: number, end: number): Promise<Uint8Array[]> {
    const hit = this.cache.get(start);
    if (hit) { this.cache.delete(start); this.cache.set(start, hit); return hit; }
    const p = this.fetchGroup(start, end);
    this.cache.set(start, p);
    while (this.cache.size > ChunkReader.MAX_CACHED_GROUPS) this.cache.delete(this.cache.keys().next().value!);
    // A failed read is not remembered: the next ask tries the file again.
    p.catch(() => { if (this.cache.get(start) === p) this.cache.delete(start); });
    return p;
  }

  private async fetchGroup(start: number, end: number): Promise<Uint8Array[]> {
    const runs: { first: number; last: number }[] = [];
    for (let i = start; i < end; i++) {
      const run = runs[runs.length - 1];
      const prev = this.chunks[i - 1];
      if (run && prev && this.chunks[i]!.offset === prev.offset + prev.size) run.last = i;
      else runs.push({ first: i, last: i });
    }
    const pieces = await Promise.all(runs.map(async ({ first, last }) => {
      const from = this.chunks[first]!.offset;
      const to = this.chunks[last]!.offset + this.chunks[last]!.size;
      const bytes = await this.bytes.read(from, to - from);
      const out: Uint8Array[] = [];
      for (let i = first; i <= last; i++) {
        const c = this.chunks[i]!;
        out.push(bytes.subarray(c.offset - from, c.offset - from + c.size));
      }
      return out;
    }));
    return pieces.flat();
  }
}
