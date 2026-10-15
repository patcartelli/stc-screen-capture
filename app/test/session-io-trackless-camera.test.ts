/**
 * STC-541. A camera that recorded no frames leaves a camera.mp4 with no video
 * track (seen on hardware 2026-10-14: 20 KB, no moov) while anchors.json still
 * claims the camera. `loadTake` is the one loader the editor, export and a
 * recording's Copy render share, so the background Copy STC-530 starts failed
 * on it ("camera.mp4 is not a readable MP4 — no track information found").
 * Such a take must load, and render, exactly as a take with no camera does.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTake, type TakeIO } from "../src/session-io.js";
import { render } from "../../transform/src/render.js";

const root = join(__dirname, "..", "..");
const fixture = (name: string) => new Uint8Array(readFileSync(join(root, "fixtures", "pip", name)));

/** ftyp + free + an mdat of junk, and no moov — what a writer that never got a sample leaves. */
function tracklessMp4(): Uint8Array {
  const box = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const ftyp = box("ftyp", new TextEncoder().encode("mp42\0\0\0\0isommp42"));
  const free = box("free", new Uint8Array(0));
  const mdat = box("mdat", new Uint8Array(20_000).fill(0xab));
  const out = new Uint8Array(ftyp.length + free.length + mdat.length);
  out.set(ftyp, 0); out.set(free, ftyp.length); out.set(mdat, ftyp.length + free.length);
  return out;
}

function memoryIO(files: Record<string, Uint8Array>): TakeIO {
  const get = (name: string) => {
    const f = files[name];
    if (!f) return Promise.reject(new Error(`ENOENT ${name}`));
    return Promise.resolve(f);
  };
  return {
    read: async (name) => (await get(name)).slice().buffer,
    size: async (name) => (await get(name)).byteLength,
    chunk: async (name, offset, length) => (await get(name)).slice(offset, offset + length).buffer,
  };
}

const take = (camera: Uint8Array, extra: Record<string, Uint8Array> = {}) => memoryIO({
  "anchors.json": fixture("anchors.json"),
  "events.json": fixture("events.json"),
  "display.mp4": fixture("display.mp4"),
  "camera.mp4": camera,
  ...extra,
});

describe("a take whose camera.mp4 has no video track (STC-541)", () => {
  test("the control: the real camera.mp4 loads with its PiP", async () => {
    const { session, project } = await loadTake(take(fixture("camera.mp4")));
    expect(session.cameraFrames?.length).toBeGreaterThan(0);
    expect(project.pip?.enabled).toBe(true);
    expect(render(project, session, 2_000_000_000).pip).not.toBeNull();
  });

  test("a trackless camera.mp4 loads as a take with no camera, and renders", async () => {
    const { session, project } = await loadTake(take(tracklessMp4()));
    expect(session.anchors.camera?.present).toBe(false);
    expect(session.cameraVideo).toBeUndefined();
    expect(session.cameraFrames).toBeUndefined();
    expect(project.pip).toBeUndefined();
    const fs = render(project, session, 2_000_000_000);
    expect(fs.pip).toBeNull();
    expect(fs.frameIndex).not.toBeNull();
  });

  test("an empty (0-byte) camera.mp4 loads the same way", async () => {
    const { session } = await loadTake(take(new Uint8Array(0)));
    expect(session.anchors.camera?.present).toBe(false);
    expect(session.cameraVideo).toBeUndefined();
  });

  test("a saved project with the PiP on still renders no PiP", async () => {
    const { session, project } = await loadTake(take(tracklessMp4(), { "project.json": fixture("project.json") }));
    expect(render(project, session, 2_000_000_000).pip).toBeNull();
  });

  test("a camera unplugged before its first frame (v12 endedBy) loads the same way, without endedBy", async () => {
    // STC-237: the helper only writes endedBy on a present track, but a camera unplugged
    // before it delivered a frame can still leave a trackless camera.mp4. The demotion
    // to present:false drops endedBy rather than leaving a combination anchors-12 refuses.
    const a = JSON.parse(new TextDecoder().decode(fixture("anchors.json")));
    const v12 = { ...a, version: 12, camera: { ...a.camera, endedBy: "disconnected" } };
    const { session } = await loadTake(take(tracklessMp4(), {
      "anchors.json": new TextEncoder().encode(JSON.stringify(v12)),
    }));
    expect(session.anchors.camera?.present).toBe(false);
    expect(session.anchors.camera).not.toHaveProperty("endedBy");
  });

  test("a MALFORMED camera.mp4 still refuses the take", async () => {
    // A box declaring fewer bytes than its own header is a broken file, not an
    // empty camera; guessing past it would hide a real fault.
    const broken = new Uint8Array(16);
    new DataView(broken.buffer).setUint32(0, 4);
    broken.set(new TextEncoder().encode("ftyp"), 4);
    await expect(loadTake(take(broken))).rejects.toThrow(/could not parse camera\.mp4/);
  });
});
