import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFakeWebCodecs, type FakeWebCodecs } from "./_fake-webcodecs.js";
import { loadSession, type LoadedSession } from "../src/session.js";
import { memorySource, type ByteSource } from "../src/chunk-reader.js";
import { PreviewPlayer } from "../src/preview.js";
import type { Project } from "../src/types.js";

/**
 * A read failure in the preview must reach the person (STC-236 final review).
 *
 * The frame sources already poison themselves and reject, but every caller
 * that mattered was `void this.draw()` or `void player.seek()`: the canvas
 * froze on the last frame, the playhead kept moving, and the only trace was a
 * console line. Newly reachable once the editor reads by range — deleting a
 * take from the library while it is open makes every later `preview:chunk`
 * throw "no take is open".
 *
 * Node has no canvas, so the player is given the minimum it touches before a
 * frame is decoded: `width`/`height` and a `getContext("2d")` that returns an
 * empty object. A failing read never gets as far as `composite()`, which is
 * the only thing that would call into the context. `requestAnimationFrame` is
 * stubbed with a timer so `play()` can run.
 */

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

let wc: FakeWebCodecs;
const g = globalThis as any;
const savedRaf = { r: g.requestAnimationFrame, c: g.cancelAnimationFrame };
beforeEach(() => {
  wc = installFakeWebCodecs();
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
});
afterEach(() => {
  wc.restore();
  g.requestAnimationFrame = savedRaf.r;
  g.cancelAnimationFrame = savedRaf.c;
});

async function failingSession(): Promise<LoadedSession> {
  const b = readFileSync(join(root, "fixtures/basic/display.mp4"));
  const s = await loadSession({
    anchors: load("fixtures/basic/anchors.json"),
    events: load("fixtures/basic/events.json"),
    displayMp4: memorySource(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "display.mp4"),
  });
  // The index loaded; the bytes behind it are gone — what a take deleted
  // from under an open editor looks like to the frame source.
  const gone: ByteSource = {
    size: s.video.bytes.size,
    read: () => Promise.reject(new Error("display.mp4: no take is open")),
  };
  return { ...s, video: { ...s.video, bytes: gone } };
}

function stubCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
}

describe("PreviewPlayer reports a failed draw once (STC-236)", () => {
  test("seek() on a failing source fires onError exactly once, naming the file, and pauses", async () => {
    const session = await failingSession();
    const project = load("fixtures/basic/project.json") as Project;
    const player = new PreviewPlayer(stubCanvas(), session, project);
    const errors: Error[] = [];
    let playingWhenReported: boolean | null = null;
    player.onError = (e) => { errors.push(e); playingWhenReported = player.isPlaying; };

    player.play(1);
    expect(player.isPlaying).toBe(true);
    await player.seek(player.firstRenderableNs);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/display\.mp4/);
    expect(playingWhenReported, "paused BEFORE the hook ran").toBe(false);
    expect(player.isPlaying).toBe(false);

    // The source stays poisoned; later draws fail too but are not re-reported.
    await player.seek(player.firstRenderableNs + 100_000_000);
    await player.seek(player.firstRenderableNs + 200_000_000);
    expect(errors).toHaveLength(1);
    player.close();
  });

  test("captureFrame() refuses rather than returning the stale canvas", async () => {
    const session = await failingSession();
    const project = load("fixtures/basic/project.json") as Project;
    const player = new PreviewPlayer(stubCanvas(), session, project);
    player.onError = () => {};
    await expect(player.captureFrame()).rejects.toThrow(/display\.mp4/);
    player.close();
  });
});
