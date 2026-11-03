import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { loadSession, type LoadedSession } from "../src/session.js";
import { memorySource, type ByteSource } from "../src/chunk-reader.js";
import { PreviewPlayer } from "../src/preview.js";
import type { Project } from "../src/types.js";

/**
 * The playhead follows a drag, not the decoder (STC-632).
 *
 * The editor moves the playhead and the readout in `onTime`, and `seek()`
 * used to call it only after its frame was painted. A drag's seeks coalesce
 * into the draw in flight, whose promise settles only once no redraw is
 * wanted — so while the pointer moved faster than a 4K frame decodes, the
 * playhead did not move at all, then jumped when the pointer stopped. That is
 * scrubber rule 3 broken ("the playhead is wherever the pointer is").
 *
 * The decoder's slowness is modelled by a byte source that answers nothing
 * until released: every draw is stuck on its read, exactly as a long seek is.
 */

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

let wc: FakeWebCodecs;
beforeEach(() => { wc = installFakeWebCodecs(); });
afterEach(() => { wc.restore(); });

/** Reads wait until `release()`; after that they pass straight through. */
function gated(inner: ByteSource): { source: ByteSource; release(): void } {
  let open = false;
  const waiting: (() => void)[] = [];
  return {
    source: {
      size: inner.size,
      read: (offset, length) => open
        ? inner.read(offset, length)
        : new Promise<void>((r) => waiting.push(r)).then(() => inner.read(offset, length)),
    },
    release() { open = true; for (const r of waiting.splice(0)) r(); },
  };
}

async function slowSession(): Promise<{ session: LoadedSession; release(): void }> {
  const b = readFileSync(join(root, "fixtures/basic/display.mp4"));
  const s = await loadSession({
    anchors: load("fixtures/basic/anchors.json"),
    events: load("fixtures/basic/events.json"),
    displayMp4: memorySource(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "display.mp4"),
  });
  const g = gated(s.video.bytes);
  return { session: { ...s, video: { ...s.video, bytes: g.source } }, release: g.release };
}

/** Node has no canvas: a 2D context whose every method is a no-op is enough for composite(). */
function stubCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, {
    get: () => () => ({ width: 0 }),
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the playhead follows a drag while frames are still decoding (STC-632)", () => {
  test("onTime reports each seek's position before its frame is painted", async () => {
    const { session, release } = await slowSession();
    const project = load("fixtures/basic/project.json") as Project;
    const player = new PreviewPlayer(stubCanvas(), session, project);
    const seen: number[] = [];
    player.onTime = (tNs) => { seen.push(tNs); };

    const start = player.firstRenderableNs;
    // A drag: three pointer moves while the first frame is still being read.
    const drags = [start + 500_000_000, start + 1_000_000_000, start + 1_500_000_000];
    const pending = drags.map((t) => player.seek(t));
    await tick();

    expect(seen, "the playhead moved with every pointer move, before any frame was painted")
      .toEqual(drags);
    expect(player.stats.renderedFrames).toBe(0);

    release();
    await Promise.all(pending);
    expect(player.stats.renderedFrames, "the last position was painted").toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(drags[2]);
    player.close();
  });

  test("a seek past the end reports the clamped position, as the painted frame will be", async () => {
    const { session, release } = await slowSession();
    const project = load("fixtures/basic/project.json") as Project;
    const player = new PreviewPlayer(stubCanvas(), session, project);
    const seen: number[] = [];
    player.onTime = (tNs) => { seen.push(tNs); };

    const p = player.seek(player.durationNs + 1_000_000_000);
    await tick();
    expect(seen).toEqual([player.durationNs]);
    release();
    await p;
    player.close();
  });
});
