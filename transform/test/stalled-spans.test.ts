/**
 * STC-553: anchors-16's `stalledSpans` on `camera` — the stretches where a camera that had
 * delivered frames delivered none for 3 s or more. The schema and the loader both refuse it
 * where it cannot be right. fixtures/pip has a real camera.mp4, so a good document loads
 * all the way through.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { loadSession } from "../src/session.js";
import { memorySource } from "../src/chunk-reader.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const rawBuf = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const compile = (p: string) => new Ajv({ allErrors: true, strict: true }).compile(load(p));

// Inside fixtures/pip's camera track (1.0355 s to 3.0245 s).
const spans = [{ startNs: 1_500_000_000, endNs: 2_000_000_000 },
               { startNs: 2_500_000_000, endNs: 3_000_000_000 }];

/** fixtures/pip lifted to `version`, with `camera` merged over its own block. */
function withCamera(c: Record<string, unknown>, version = 16) {
  const a = load("fixtures/pip/anchors.json");
  return { ...a, version, camera: { ...a.camera, ...c } };
}
const loadPip = (anchors: unknown) => loadSession({
  anchors: anchors as any,
  events: load("fixtures/pip/events.json"),
  displayMp4: memorySource(rawBuf("fixtures/pip/display.mp4"), "display.mp4"),
  cameraMp4: memorySource(rawBuf("fixtures/pip/camera.mp4"), "camera.mp4"),
});

describe("anchors-16 schema (STC-553)", () => {
  const v = compile("schema/anchors-16.schema.json");

  test("accepts stalledSpans on a present camera", () => {
    expect(v(withCamera({ stalledSpans: spans })), JSON.stringify(v.errors)).toBe(true);
  });

  test("refuses stalledSpans on a present:false block", () => {
    const a = withCamera({});
    expect(v({ ...a, camera: { present: false, stalledSpans: spans } })).toBe(false);
  });

  test("refuses an empty list (the helper writes no key instead) and a span with no end", () => {
    expect(v(withCamera({ stalledSpans: [] }))).toBe(false);
    expect(v(withCamera({ stalledSpans: [{ startNs: 1_500_000_000 }] })),
      "an open span belongs only in anchors.partial.json; recovery closes it").toBe(false);
  });

  test("anchors-15 refuses stalledSpans (it is new at 16)", () => {
    const v15 = compile("schema/anchors-15.schema.json");
    expect(v15(withCamera({ stalledSpans: spans }, 15))).toBe(false);
    expect(v15(withCamera({}, 15)), "the control: the same document without it is fine").toBe(true);
  });
});

describe("loadSession and stalledSpans (STC-553)", () => {
  test("a good v16 document loads and keeps its spans", async () => {
    const s = await loadPip(withCamera({ stalledSpans: spans }));
    expect(s.anchors.camera?.stalledSpans).toEqual(spans);
  });

  test("stalledSpans on a document older than v16 is refused", async () => {
    await expect(loadPip(withCamera({ stalledSpans: spans }, 15)))
      .rejects.toThrow(/stalledSpans needs anchors version 16; this document is version 15/);
  });

  test("on a present:false camera, empty, or out of order, it is refused", async () => {
    const a = withCamera({});
    await expect(loadPip({ ...a, camera: { present: false, stalledSpans: spans }, files: { display: "display.mp4" } }))
      .rejects.toThrow(/present:false — there is no track to have stalled/);
    await expect(loadPip(withCamera({ stalledSpans: [] }))).rejects.toThrow(/non-empty list/);
    await expect(loadPip(withCamera({ stalledSpans: [spans[1], spans[0]] })))
      .rejects.toThrow(/stalledSpans\[1\] must be whole ns/);
    await expect(loadPip(withCamera({ stalledSpans: [{ startNs: 2_000_000_000, endNs: 2_000_000_000 }] })))
      .rejects.toThrow(/stalledSpans\[0\] must be whole ns, start < end/);
  });

  test("a camera demoted for having no video track drops its spans with it (STC-541)", async () => {
    const s = await loadSession({
      anchors: withCamera({ stalledSpans: spans }) as any,
      events: load("fixtures/pip/events.json"),
      displayMp4: memorySource(rawBuf("fixtures/pip/display.mp4"), "display.mp4"),
      cameraMp4: memorySource(tracklessMp4(), "camera.mp4"),
    });
    expect(s.anchors.camera).toMatchObject({ present: false });
    expect(s.anchors.camera).not.toHaveProperty("stalledSpans");
  });
});

/** ftyp + free + an mdat of junk, and no moov — STC-541's trackless camera.mp4. */
function tracklessMp4(): ArrayBuffer {
  const box = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const parts = [box("ftyp", new TextEncoder().encode("mp42\0\0\0\0isommp42")),
                 box("free", new Uint8Array(0)), box("mdat", new Uint8Array(20_000).fill(0xab))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}
