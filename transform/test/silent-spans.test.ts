/**
 * STC-528: anchors-13's `silentSpans` on `mic` — the stretches where the mic delivered no
 * signal for 10 s or more. The schema and the loader both refuse it where it cannot be
 * right. There is no mic.m4a fixture in the repo, so the loader's acceptance is shown the
 * way the checks are ordered: a good document gets PAST the span check and stops at the
 * missing mic.m4a, a bad one stops at the span check.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { loadSession } from "../src/session.js";
import { memorySource } from "../src/chunk-reader.js";
import { recoverAnchors } from "../src/recover-anchors.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const rawBuf = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const compile = (p: string) => new Ajv({ allErrors: true, strict: true }).compile(load(p));

const mic = { present: true, device: "Fixture Mic", sampleRate: 48000, channels: 1,
              firstFramePtsNs: 0, lastFramePtsNs: 30_000_000_000 };
const spans = [{ startNs: 2_000_000_000, endNs: 14_000_000_000 },
               { startNs: 18_000_000_000, endNs: 30_000_000_000 }];

/** fixtures/pip lifted to `version`, with a mic block. */
function withMic(m: Record<string, unknown>, version = 13) {
  const a = load("fixtures/pip/anchors.json");
  return { ...a, version, mic: m, files: { ...a.files, mic: "mic.m4a" } };
}
const loadPip = (anchors: unknown) => loadSession({
  anchors: anchors as any,
  events: load("fixtures/pip/events.json"),
  displayMp4: memorySource(rawBuf("fixtures/pip/display.mp4"), "display.mp4"),
  cameraMp4: memorySource(rawBuf("fixtures/pip/camera.mp4"), "camera.mp4"),
});

describe("anchors-13 schema (STC-528)", () => {
  test("accepts silentSpans on a present mic", () => {
    const v = compile("schema/anchors-13.schema.json");
    expect(v(withMic({ ...mic, silentSpans: spans })), JSON.stringify(v.errors)).toBe(true);
  });

  test("refuses silentSpans on a present:false block", () => {
    const v = compile("schema/anchors-13.schema.json");
    expect(v(withMic({ present: false, silentSpans: spans }))).toBe(false);
  });

  test("refuses an empty list (the helper writes no key instead)", () => {
    const v = compile("schema/anchors-13.schema.json");
    expect(v(withMic({ ...mic, silentSpans: [] }))).toBe(false);
  });

  test("anchors-12 refuses silentSpans (it is new at 13)", () => {
    const v = compile("schema/anchors-12.schema.json");
    expect(v(withMic({ ...mic, silentSpans: spans }, 12))).toBe(false);
    expect(v(withMic(mic, 12)), "the control: the same document without it is fine").toBe(true);
  });
});

describe("loadSession and silentSpans (STC-528)", () => {
  test("a good v13 document gets past the span check", async () => {
    await expect(loadPip(withMic({ ...mic, silentSpans: spans }))).rejects.toThrow(/no mic\.m4a was supplied/);
  });

  test("silentSpans on a document older than v13 is refused", async () => {
    await expect(loadPip(withMic({ ...mic, silentSpans: spans }, 12)))
      .rejects.toThrow(/silentSpans needs anchors version 13/);
  });

  test("silentSpans on a present:false mic is refused", async () => {
    await expect(loadPip(withMic({ present: false, silentSpans: spans }))).rejects.toThrow(/present:false/);
  });

  test("an empty list is refused", async () => {
    await expect(loadPip(withMic({ ...mic, silentSpans: [] }))).rejects.toThrow(/non-empty/);
  });

  test("spans out of order, overlapping or backwards are refused", async () => {
    for (const bad of [
      [spans[1], spans[0]],
      [{ startNs: 0, endNs: 15_000_000_000 }, { startNs: 14_000_000_000, endNs: 26_000_000_000 }],
      [{ startNs: 5_000_000_000, endNs: 5_000_000_000 }],
      [{ startNs: 1.5, endNs: 12_000_000_000 }],
    ]) {
      await expect(loadPip(withMic({ ...mic, silentSpans: bad }))).rejects.toThrow(/silentSpans\[\d\]/);
    }
  });
});

describe("recovery and silentSpans (STC-528)", () => {
  const partial = () => {
    const p = withMic({ ...mic, silentSpans: spans }) as Record<string, unknown>;
    delete p.stop;
    return p;
  };
  const media = { displayFramesNs: [0, 16_666_667], cameraFramesNs: [0, 33_333_333] };

  test("a v13 partial recovers with its spans and stays v13", () => {
    const r = recoverAnchors(partial(), { ...media, micLastNs: 29_990_000_000 }, "recorder-quit");
    expect(r.ok, r.ok ? "" : r.why).toBe(true);
    if (!r.ok) return;
    expect(r.anchors.version).toBe(13);
    expect(r.anchors.mic?.silentSpans).toEqual(spans);
  });

  test("a mic with no samples is dropped, and its spans with it", () => {
    const r = recoverAnchors(partial(), { ...media, micLastNs: null }, "recorder-quit");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchors.mic).toEqual({ present: false });
  });
});
