import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/clean-narration-one.mjs` driven for real, on a WAV — the path
 * Linux can take (no AAC decoder here; a Mac decodes mic.m4a with
 * afconvert first). It pins that the script reads a WAV, runs the chain,
 * and writes files a person can play: same rate, channels and length, and
 * a lower noise floor than it was given. What they SOUND like is
 * docs/STC-455-RUNBOOK.md.
 */
const SCRIPT = join(__dirname, "..", "..", "scripts", "clean-narration-one.mjs");
const RATE = 48_000;

/** A float32 WAVE_FORMAT_EXTENSIBLE file, the layout afconvert writes. */
function floatWavExtensible(chs: Float32Array[]): Buffer {
  const nch = chs.length, frames = chs[0]!.length;
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0); fmt.writeUInt16LE(nch, 2); fmt.writeUInt32LE(RATE, 4);
  fmt.writeUInt32LE(RATE * nch * 4, 8); fmt.writeUInt16LE(nch * 4, 12); fmt.writeUInt16LE(32, 14);
  fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(32, 18); fmt.writeUInt32LE(0, 20);
  fmt.writeUInt16LE(3, 24); // SubFormat: IEEE float
  const data = Buffer.alloc(frames * nch * 4);
  for (let f = 0; f < frames; f++) for (let c = 0; c < nch; c++) data.writeFloatLE(chs[c]![f]!, (f * nch + c) * 4);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii"); head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4); head.write("WAVE", 8, "ascii");
  const chunk = (id: string, body: Buffer) => { const h = Buffer.alloc(8); h.write(id, 0, "ascii"); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  return Buffer.concat([head, chunk("fmt ", fmt), chunk("data", data)]);
}

describe("clean-narration-one.mjs", () => {
  test("reads a float WAV, writes original + one file per strength, and the floor goes down", () => {
    const n = RATE * 4;
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    // Phrases of a 200 Hz tone, 1 s on / 1 s off, over hiss.
    const x = Float32Array.from({ length: n }, (_, i) =>
      (Math.floor(i / RATE) % 2 === 0 ? 0.1 * Math.sin((2 * Math.PI * 200 * i) / RATE) : 0) + rnd() * 0.005);
    const dir = mkdtempSync(join(tmpdir(), "stc-narr-"));
    const wav = join(dir, "in.wav");
    writeFileSync(wav, floatWavExtensible([x, x]));
    const out = join(dir, "out");
    const log = execFileSync("node", [SCRIPT, wav, "--strengths", "0.5,1", "--out", out], { encoding: "utf8" });

    expect(readdirSync(out).sort()).toEqual(["clean-100.wav", "clean-50.wav", "original.wav"]);
    for (const name of readdirSync(out)) {
      const b = readFileSync(join(out, name));
      expect(b.readUInt16LE(22), name).toBe(2);        // channels
      expect(b.readUInt32LE(24), name).toBe(RATE);     // rate
      expect(b.readUInt16LE(34), name).toBe(24);       // bits
      expect(b.readUInt32LE(40) / 6, name).toBe(n);    // frames
    }
    const floor = (name: string) => Number(new RegExp(`${name}\\s+noise floor (-?[\\d.]+)`).exec(log)![1]);
    expect(floor("clean-50.wav")).toBeLessThan(floor("original.wav") - 10);
    expect(floor("clean-100.wav")).toBeLessThan(floor("clean-50.wav"));
  }, 60_000);

  test("refuses a strength outside (0, 1] rather than guessing", () => {
    expect(() => execFileSync("node", [SCRIPT, "x.wav", "--strengths", "2"], { stdio: "pipe" })).toThrow();
  });
});
