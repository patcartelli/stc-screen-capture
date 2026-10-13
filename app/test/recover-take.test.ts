import { describe, test, expect } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverTake, hasPartialAnchors } from "../src/recover-take.js";

const root = join(__dirname, "..", "..");
const fixture = join(root, "fixtures/basic");

/** A take as the helper leaves it after a kill: display.mp4, a partial, no anchors.json. */
function crashedTake(opts: { events?: boolean; partial?: unknown; noVideo?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "stc-recover-"));
  if (!opts.noVideo) cpSync(join(fixture, "display.mp4"), join(dir, "display.mp4"));
  if (opts.events) cpSync(join(fixture, "events.json"), join(dir, "events.json"));
  const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
  delete a.stop;
  writeFileSync(join(dir, "anchors.partial.json"), JSON.stringify(opts.partial ?? { ...a, version: 2 }));
  return dir;
}

describe("recoverTake (STC-530)", () => {
  test("a crashed take becomes a loadable v11 take, and the partial is gone", async () => {
    const dir = crashedTake();
    expect(await hasPartialAnchors(dir)).toBe(true);
    expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.version).toBe(11);
    expect(a.stop.reason).toBe("recorder-quit");
    expect(a.stop.t).toBeGreaterThan(4_000_000_000);   // fixtures/basic is a 5 s take
    expect(existsSync(join(dir, "anchors.partial.json"))).toBe(false);
    expect(await hasPartialAnchors(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  test("disk full with events.json written: reason kept, events untouched (Review Focus 4)", async () => {
    const dir = crashedTake({ events: true });
    const before = readFileSync(join(dir, "events.json"));
    expect(await recoverTake(dir, "disk-full")).toEqual({ ok: true });
    const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(a.stop.reason).toBe("disk-full");
    expect(a.version).toBe(10);
    expect(readFileSync(join(dir, "events.json")).equals(before)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("never overwrites an existing anchors.json (Review Focus 3)", async () => {
    const dir = crashedTake();
    writeFileSync(join(dir, "anchors.json"), "ORIGINAL");
    const r = await recoverTake(dir, "recorder-quit");
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, "anchors.json"), "utf8")).toBe("ORIGINAL");
    rmSync(dir, { recursive: true });
  });

  test("recovery leaves no temp file behind, and a successful publish is a complete anchors.json", async () => {
    const dir = crashedTake();
    expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
    expect(existsSync(join(dir, "anchors.json.recovering"))).toBe(false);
    expect(() => JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"))).not.toThrow();
    rmSync(dir, { recursive: true });
  });

  test("no partial, no video, or a video with no frames: not recoverable, and nothing is deleted (Review Focus 1)", async () => {
    const noPartial = mkdtempSync(join(tmpdir(), "stc-recover-"));
    cpSync(join(fixture, "display.mp4"), join(noPartial, "display.mp4"));
    expect((await recoverTake(noPartial, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(noPartial, "display.mp4"))).toBe(true);

    const noVideo = crashedTake({ noVideo: true });
    expect((await recoverTake(noVideo, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(noVideo, "anchors.partial.json"))).toBe(true);

    const garbage = crashedTake();
    writeFileSync(join(garbage, "display.mp4"), Buffer.alloc(4096, 7));
    expect((await recoverTake(garbage, "recorder-quit")).ok).toBe(false);
    expect(existsSync(join(garbage, "anchors.partial.json"))).toBe(true);
    expect(existsSync(join(garbage, "anchors.json"))).toBe(false);
    for (const d of [noPartial, noVideo, garbage]) rmSync(d, { recursive: true });
  });

  test("a camera the partial claims but whose file is missing is dropped, the take recovers (Review Focus 2)", async () => {
    const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
    delete a.stop;
    const dir = crashedTake({ partial: {
      ...a, version: 2, files: { display: "display.mp4", camera: "camera.mp4" },
      camera: { present: true, device: "Cam", width: 1280, height: 720,
                firstFramePtsNs: 100_000_000, lastFramePtsNs: 100_000_000, frameIntervalNs: 33_333_333 },
    } });
    expect(await recoverTake(dir, "recorder-quit")).toEqual({ ok: true });
    const out = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(out.camera).toEqual({ present: false });
    expect(out.files.camera).toBeUndefined();
    rmSync(dir, { recursive: true });
  });

  test("a partial whose files block is malformed resolves { ok: false } and deletes nothing", async () => {
    const a = JSON.parse(readFileSync(join(fixture, "anchors.json"), "utf8"));
    delete a.stop;
    for (const display of [42, "../display.mp4", "a/b.mp4"]) {
      const dir = crashedTake({ partial: { ...a, version: 2, files: { display } } });
      const r = await recoverTake(dir, "recorder-quit");
      expect(r.ok).toBe(false);
      expect(existsSync(join(dir, "anchors.partial.json"))).toBe(true);
      expect(existsSync(join(dir, "display.mp4"))).toBe(true);
      expect(existsSync(join(dir, "anchors.json"))).toBe(false);
      rmSync(dir, { recursive: true });
    }
  });
});
