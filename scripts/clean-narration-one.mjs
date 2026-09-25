/**
 * STC-455's listening test: runs `transform/src/narration-clean.ts` over a
 * real take's mic and writes WAVs a person can A/B. The chain's tests prove
 * it does what it says to synthetic signals; only an ear can say whether a
 * real voice still sounds like a person afterwards, which is why this spike
 * ships before any project field, export wiring or editor switch does.
 *
 * Usage:
 *   node scripts/clean-narration-one.mjs <takeDir | mic.m4a | file.wav>
 *        [--strengths 0.25,0.5,0.75,1] [--out <dir>]
 *
 * A take folder or an .m4a is decoded with macOS's own `afconvert` (always
 * installed on a Mac; nothing to add). A .wav is read directly — which is
 * also how this is tested on Linux, where there is no AAC decoder.
 *
 * Writes `original.wav` and one `clean-<pct>.wav` per strength, 24-bit, at
 * the mic's own rate, into `--out` — by default `~/Desktop/narration-spike/
 * <take>/`, and deliberately NOT into the take: the library scans the
 * recordings root, and a stray folder there is an "invalid" tile.
 *
 * Also prints a noise-floor estimate (the 10th percentile of 50 ms RMS
 * windows) before and after — a number to go with the listening, not a
 * substitute for it.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const strengths = (flag("--strengths") ?? "0.25,0.5,0.75,1").split(",").map(Number);
const outArg = flag("--out");
const input = args[0];
if (!input || strengths.some((s) => !(s > 0 && s <= 1))) {
  console.error("usage: node scripts/clean-narration-one.mjs <takeDir | mic.m4a | file.wav> [--strengths 0.25,0.5,0.75,1] [--out dir]");
  process.exit(2);
}

// ── find and decode the input ────────────────────────────────────────────
let source = resolve(input);
let takeName;
if (existsSync(source) && statSync(source).isDirectory()) {
  takeName = basename(source);
  source = join(source, "mic.m4a");
} else {
  takeName = basename(dirname(source));
}
if (!existsSync(source)) {
  console.error(`no such file: ${source}${source.endsWith("mic.m4a") ? " (was this take recorded with the mic on?)" : ""}`);
  process.exit(2);
}
let wavPath = source;
if (!source.toLowerCase().endsWith(".wav")) {
  wavPath = join(mkdtempSync(join(tmpdir(), "stc-narration-")), "decoded.wav");
  try {
    // LEF32 at the source's own rate: no resampling before the chain sees it.
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEF32", source, wavPath], { stdio: "inherit" });
  } catch (e) {
    console.error(`could not decode ${source} with afconvert (macOS only). On another OS, pass a .wav.\n${e.message}`);
    process.exit(2);
  }
}
const { sampleRate, channels } = readWav(readFileSync(wavPath));

// ── the chain itself, bundled from the TypeScript the app will run ─────────
const bundled = await build({
  entryPoints: [new URL("../transform/src/narration-clean.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "neutral", write: false,
});
const { cleanNarration, paramsForStrength } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const outDir = resolve(outArg ?? join(homedir(), "Desktop", "narration-spike", takeName));
mkdirSync(outDir, { recursive: true });
const seconds = channels[0].length / sampleRate;
console.log(`${source}\n  ${channels.length} ch, ${sampleRate} Hz, ${seconds.toFixed(1)} s`);

writeFileSync(join(outDir, "original.wav"), writeWav(channels, sampleRate));
console.log(`  original.wav     noise floor ${noiseFloorDb(channels, sampleRate).toFixed(1)} dBFS`);
const track = { startNs: 0, sampleRate, channels };
for (const s of strengths) {
  const t0 = performance.now();
  const out = cleanNarration(track, s);
  const ms = performance.now() - t0;
  const name = `clean-${Math.round(s * 100)}.wav`;
  writeFileSync(join(outDir, name), writeWav(out.channels, sampleRate));
  const p = paramsForStrength(s);
  console.log(
    `  ${name.padEnd(16)} noise floor ${noiseFloorDb(out.channels, sampleRate).toFixed(1)} dBFS  ` +
    `(max cut ${p.maxReductionDb} dB, de-ess ≤${p.deessMaxDb} dB; ${(ms / 1000).toFixed(1)} s)`);
}
console.log(`\nwrote ${outDir}\nopen "${outDir}"`);

// ── helpers ─────────────────────────────────────────────────────────────

/** 10th percentile of 50 ms RMS windows, skipping digital silence. */
function noiseFloorDb(chs, rate) {
  const w = Math.round(0.05 * rate);
  const levels = [];
  for (let at = 0; at + w <= chs[0].length; at += w) {
    let e = 0;
    for (const c of chs) for (let i = at; i < at + w; i++) e += c[i] * c[i];
    e /= w * chs.length;
    if (e > 1e-12) levels.push(10 * Math.log10(e));
  }
  levels.sort((a, b) => a - b);
  return levels.length ? levels[Math.floor(levels.length * 0.1)] : -Infinity;
}

/** PCM 16/24/32-bit and float32/64 WAV, including WAVE_FORMAT_EXTENSIBLE (what afconvert writes). */
function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let fmt, data;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4), size = buf.readUInt32LE(at + 4);
    if (id === "fmt ") fmt = buf.subarray(at + 8, at + 8 + size);
    if (id === "data") data = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV has no fmt or data chunk");
  let format = fmt.readUInt16LE(0);
  const nch = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  if (format === 0xfffe) format = fmt.readUInt16LE(24); // the SubFormat GUID's first two bytes
  const bytes = bits / 8, frames = Math.floor(data.length / (bytes * nch));
  const read = format === 3
    ? (o) => (bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o))
    : format === 1
      ? (o) => (bits === 16 ? data.readInt16LE(o) / 32768
        : bits === 24 ? data.readIntLE(o, 3) / 8388608
        : bits === 32 ? data.readInt32LE(o) / 2147483648
        : NaN)
      : null;
  if (!read || ![16, 24, 32, 64].includes(bits)) throw new Error(`unsupported WAV: format ${format}, ${bits}-bit`);
  const chs = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < nch; c++) chs[c][f] = read((f * nch + c) * bytes);
  return { sampleRate: rate, channels: chs };
}

/** 24-bit PCM: plays everywhere, and 144 dB is plenty for listening. Clamped. */
function writeWav(chs, rate) {
  const nch = chs.length, frames = chs[0].length, bytes = 3;
  const buf = Buffer.alloc(44 + frames * nch * bytes);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + frames * nch * bytes, 4); buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii"); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * nch * bytes, 28); buf.writeUInt16LE(nch * bytes, 32); buf.writeUInt16LE(24, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(frames * nch * bytes, 40);
  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, chs[c][f]));
      buf.writeIntLE(Math.round(v * 8388607), o, 3);
      o += 3;
    }
  }
  return buf;
}
