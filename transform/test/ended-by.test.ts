/**
 * STC-237: anchors-12's `endedBy` on `mic`/`camera`, why a track ended before the take
 * did. The loader keeps it on a track that exists and refuses it where it cannot be right.
 * render() needs nothing new for it; the PiP already ends at `lastFramePtsNs`, which the
 * last test pins on a camera that is cut half way through.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { loadSession } from "../src/session.js";
import { memorySource } from "../src/chunk-reader.js";
import { render } from "../src/render.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const rawBuf = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const mp4 = (p: string) => memorySource(rawBuf(p), p);
const compile = (p: string) => new Ajv({ allErrors: true, strict: true }).compile(load(p));

/** fixtures/pip with its camera lifted to v12 and `over` merged into the camera block. */
function pipAnchors(camera: Record<string, unknown> = {}, version = 12) {
  const a = load("fixtures/pip/anchors.json");
  return { ...a, version, camera: { ...a.camera, ...camera } };
}
const pipEvents = () => load("fixtures/pip/events.json");
const loadPip = (anchors: unknown, withCamera = true) => loadSession({
  anchors: anchors as any,
  events: pipEvents(),
  displayMp4: mp4("fixtures/pip/display.mp4"),
  ...(withCamera ? { cameraMp4: mp4("fixtures/pip/camera.mp4") } : {}),
});

describe("anchors-12 schema (STC-237)", () => {
  const mic = { present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
                firstFramePtsNs: 0, lastFramePtsNs: 1_000_000_000 };
  const withMic = (m: Record<string, unknown>, version = 12) => ({
    ...pipAnchors({ endedBy: "disconnected" }, version),
    mic: m, files: { display: "display.mp4", camera: "camera.mp4", mic: "mic.m4a" },
  });

  test("accepts endedBy on a present camera and mic", () => {
    const v = compile("schema/anchors-12.schema.json");
    for (const reason of ["disconnected", "format-mismatch"]) {
      expect(v(withMic({ ...mic, endedBy: reason })), JSON.stringify(v.errors)).toBe(true);
    }
  });

  test("refuses endedBy on a present:false block", () => {
    const v = compile("schema/anchors-12.schema.json");
    expect(v({ ...withMic(mic), mic: { present: false, endedBy: "disconnected" } })).toBe(false);
  });

  test("refuses a camera that ended by format-mismatch (a mic-only reason)", () => {
    const v = compile("schema/anchors-12.schema.json");
    expect(v(pipAnchors({ endedBy: "format-mismatch" }))).toBe(false);
  });

  test("anchors-11 refuses endedBy (it is new at 12)", () => {
    const v = compile("schema/anchors-11.schema.json");
    expect(v(pipAnchors({ endedBy: "disconnected" }, 11))).toBe(false);
    expect(v(pipAnchors({}, 11)), "the control: the same document without it is fine").toBe(true);
  });
});

describe("loadSession and endedBy (STC-237)", () => {
  test("a v12 camera that was disconnected loads with endedBy kept", async () => {
    const s = await loadPip(pipAnchors({ endedBy: "disconnected" }));
    expect(s.anchors.camera?.endedBy).toBe("disconnected");
    expect(s.cameraFrames?.length).toBeGreaterThan(0);
  });

  test("endedBy on a document older than v12 is refused", async () => {
    await expect(loadPip(pipAnchors({ endedBy: "disconnected" }, 11)))
      .rejects.toThrow(/endedBy needs anchors version 12/);
  });

  test("endedBy on a present:false camera is refused", async () => {
    await expect(loadPip({ ...pipAnchors(), camera: { present: false, endedBy: "disconnected" } }, false))
      .rejects.toThrow(/present:false/);
  });

  test("an endedBy the helper never writes is refused", async () => {
    await expect(loadPip(pipAnchors({ endedBy: "format-mismatch" })))
      .rejects.toThrow(/not one of disconnected/);
  });

  test("a version 16 anchors document is rejected by name", async () => {
    // 15 is real now (STC-562), so 16 stands in for "unknown future version".
    await expect(loadPip(pipAnchors({}, 16))).rejects.toThrow(/version 16 is not supported/);
  });

  test("a camera cut half way has a PiP before the cut and none after it", async () => {
    // The pip fixture's camera runs 1.0355 s .. 3.0245 s. A disconnect at 2 s leaves
    // `lastFramePtsNs` there; render() bounds the PiP with it plus one frame interval.
    const a = pipAnchors({ endedBy: "disconnected", lastFramePtsNs: 2_000_000_000 });
    const s = await loadPip(a);
    const project = load("fixtures/pip/project.json");
    expect(render(project, s, 1_500_000_000).pip, "before the cut").not.toBeNull();
    expect(render(project, s, 2_500_000_000).pip, "after the cut").toBeNull();
    expect(render(project, s, 2_500_000_000).frameIndex, "the screen keeps going").not.toBeNull();
  });
});

describe("anchors-14 endedBy on system audio (STC-542)", () => {
  const system = { present: true, sampleRate: 48000, channels: 2, firstFramePtsNs: 0, lastFramePtsNs: 1_000_000_000 };
  const withSystem = (sys: Record<string, unknown>, version = 14) => ({
    ...pipAnchors({}, version),
    system: sys, files: { display: "display.mp4", camera: "camera.mp4", system: "system.m4a" },
  });

  test("the schema accepts stream-stopped on a present system block", () => {
    const v = compile("schema/anchors-14.schema.json");
    expect(v(withSystem({ ...system, endedBy: "stream-stopped" })), JSON.stringify(v.errors)).toBe(true);
    expect(v(withSystem(system)), "the control: no endedBy is fine").toBe(true);
  });

  test("the schema refuses it on present:false, or with another value", () => {
    const v = compile("schema/anchors-14.schema.json");
    expect(v(withSystem({ present: false, endedBy: "stream-stopped" }))).toBe(false);
    expect(v(withSystem({ ...system, endedBy: "disconnected" }))).toBe(false);
  });

  test("anchors-13 and anchors-12 refuse it (new at 14)", () => {
    for (const n of [12, 13]) {
      const v = compile(`schema/anchors-${n}.schema.json`);
      expect(v(withSystem({ ...system, endedBy: "stream-stopped" }, n)), `anchors-${n}`).toBe(false);
      expect(v(withSystem(system, n)), `the control: anchors-${n} without it`).toBe(true);
    }
  });

  test("loadSession refuses it before v14, on present:false, and with a value the helper never writes", async () => {
    await expect(loadPip(withSystem({ ...system, endedBy: "stream-stopped" }, 13)))
      .rejects.toThrow(/system\.endedBy needs anchors version 14/);
    await expect(loadPip(withSystem({ present: false, endedBy: "stream-stopped" })))
      .rejects.toThrow(/system\.endedBy is set on a system block with present:false/);
    await expect(loadPip(withSystem({ ...system, endedBy: "disconnected" })))
      .rejects.toThrow(/system\.endedBy "disconnected" is not one of stream-stopped/);
  });
});

describe("anchors-15 writer-failed on the camera (STC-562)", () => {
  test("the schema accepts it on a present camera; 14 refuses it", () => {
    const v15 = compile("schema/anchors-15.schema.json");
    expect(v15(pipAnchors({ endedBy: "writer-failed" }, 15)), JSON.stringify(v15.errors)).toBe(true);
    expect(v15(pipAnchors({ endedBy: "disconnected" }, 15)), "disconnected is still a camera reason").toBe(true);
    expect(v15({ ...pipAnchors({}, 15), camera: { present: false, endedBy: "writer-failed" } })).toBe(false);
    const v14 = compile("schema/anchors-14.schema.json");
    expect(v14(pipAnchors({ endedBy: "writer-failed" }, 14))).toBe(false);
    expect(v14(pipAnchors({ endedBy: "disconnected" }, 14)), "the control: 14 takes the old reason").toBe(true);
  });

  test("loadSession keeps it at v15 and refuses it before", async () => {
    const s = await loadPip(pipAnchors({ endedBy: "writer-failed" }, 15));
    expect(s.anchors.camera?.endedBy).toBe("writer-failed");
    await expect(loadPip(pipAnchors({ endedBy: "writer-failed" }, 14)))
      .rejects.toThrow(/camera\.endedBy needs anchors version 15/);
    // The control: `disconnected` at 14 still loads, so the 15 is this value's alone.
    expect((await loadPip(pipAnchors({ endedBy: "disconnected" }, 14))).anchors.camera?.endedBy).toBe("disconnected");
  });

  test("a writer-failed camera ends at the file's last frame, not the helper's last append", async () => {
    // fixtures/pip's camera.mp4 ends at 3.0245 s; claim the writer took frames to 9 s.
    const s = await loadPip(pipAnchors({ endedBy: "writer-failed", lastFramePtsNs: 9_000_000_000 }, 15));
    const lastOnDisk = s.cameraFrames![s.cameraFrames!.length - 1]!;
    expect(s.anchors.camera!.lastFramePtsNs).toBe(lastOnDisk);
    const project = load("fixtures/pip/project.json");
    expect(render(project, s, 6_000_000_000).pip, "no frozen PiP past the file").toBeNull();
    // The control: a disconnected camera keeps the helper's own end.
    const d = await loadPip(pipAnchors({ endedBy: "disconnected", lastFramePtsNs: 9_000_000_000 }, 15));
    expect(d.anchors.camera!.lastFramePtsNs).toBe(9_000_000_000);
  });

  test("the PiP ends at the camera's last written frame", async () => {
    const s = await loadPip(pipAnchors({ endedBy: "writer-failed", lastFramePtsNs: 2_000_000_000 }, 15));
    const project = load("fixtures/pip/project.json");
    expect(render(project, s, 1_500_000_000).pip).not.toBeNull();
    expect(render(project, s, 2_500_000_000).pip).toBeNull();
  });
});
