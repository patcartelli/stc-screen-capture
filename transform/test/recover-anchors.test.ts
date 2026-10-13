import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { recoverAnchors, RECOVERY_STOP_REASON } from "../src/recover-anchors.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema = (v: number) => new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, `schema/anchors-${v}.schema.json`), "utf8")));

/** fixtures/basic's anchors as the helper's partial would hold them: no stop, a camera and a mic that had started. */
function partial(over: Record<string, unknown> = {}): Record<string, any> {
  const a = JSON.parse(readFileSync(join(root, "fixtures/basic/anchors.json"), "utf8"));
  delete a.stop;
  return {
    ...a, version: 4,
    files: { display: "display.mp4", camera: "camera.mp4", mic: "mic.m4a" },
    camera: { present: true, device: "Cam", width: 1280, height: 720,
              firstFramePtsNs: 1_000_000_000, lastFramePtsNs: 1_000_000_000, frameIntervalNs: 16_666_667 },
    mic: { present: true, device: "Mic", sampleRate: 48000, channels: 1,
           firstFramePtsNs: 900_000_000, lastFramePtsNs: 900_000_000 },
    ...over,
  };
}
const frames = [0, 16_666_667, 33_333_334, 3_000_000_000];
const media = { displayFramesNs: frames, cameraFramesNs: [1_000_000_000, 1_033_000_000, 1_066_000_000, 2_900_000_000], micLastNs: 2_950_000_000 };

describe("recoverAnchors (STC-530)", () => {
  test("stop.t is the display's last frame, the reason is recorded, and recorder-quit is v11", () => {
    const r = recoverAnchors(partial(), media, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.stop).toEqual({ t: 3_000_000_000, reason: "recorder-quit" });
    expect(r.anchors.version).toBe(11);
    expect(schema(11)(r.anchors), JSON.stringify(schema(11).errors)).toBe(true);
  });

  test("each present track's end comes from its own file; the camera's interval is the median delta", () => {
    const r = recoverAnchors(partial(), media, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.camera).toMatchObject({ present: true, lastFramePtsNs: 2_900_000_000, frameIntervalNs: 33_000_000 });
    expect((r.anchors as any).mic).toMatchObject({ present: true, lastFramePtsNs: 2_950_000_000 });
  });

  test("disk-full keeps its own version floor (10), not 11", () => {
    const r = recoverAnchors(partial(), media, "disk-full");
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.version).toBe(10);
    expect(r.anchors.stop?.reason).toBe("disk-full");
  });

  test("a display with no frames is not recoverable (Review Focus 1)", () => {
    const r = recoverAnchors(partial(), { ...media, displayFramesNs: [] }, RECOVERY_STOP_REASON);
    expect(r).toEqual({ ok: false, why: expect.stringMatching(/no frames/) });
  });

  test("a track whose file yielded nothing is dropped, not the take (Review Focus 2)", () => {
    const r = recoverAnchors(partial(), { ...media, cameraFramesNs: null, micLastNs: null }, RECOVERY_STOP_REASON);
    if (!r.ok) throw new Error(r.why);
    expect(r.anchors.camera).toEqual({ present: false });
    expect((r.anchors as any).mic).toEqual({ present: false });
    expect(r.anchors.files).toEqual({ display: "display.mp4" });
    expect(schema(11)(r.anchors), JSON.stringify(schema(11).errors)).toBe(true);
  });

  test("refuses what is not a partial", () => {
    expect(recoverAnchors(null, media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors([], media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors({ ...partial(), stop: { t: 1, reason: "user" } }, media, RECOVERY_STOP_REASON).ok).toBe(false);
    expect(recoverAnchors({ ...partial(), version: 11 }, media, RECOVERY_STOP_REASON).ok).toBe(false);
    const { capture, ...noCapture } = partial();
    expect(recoverAnchors(noCapture, media, RECOVERY_STOP_REASON).ok).toBe(false);
  });

  test("does not mutate its input", () => {
    const p = partial();
    const before = JSON.stringify(p);
    recoverAnchors(p, media, RECOVERY_STOP_REASON);
    expect(JSON.stringify(p)).toBe(before);
  });
});
