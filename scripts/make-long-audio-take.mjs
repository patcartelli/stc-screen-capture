/**
 * A long mic + system take for measuring preview AUDIO memory (STC-469).
 *
 * Copies a real take's video and sidecars, then writes `mic.m4a` (mono) and
 * `system.m4a` (stereo) of the requested length — a tone over hiss with
 * pauses, so narration cleanup has something to learn — encoded to AAC by
 * macOS's own `afconvert`. The display stays as short as the source:
 * `loadSession` accepts audio longer than the picture, and the audio cost
 * scales with the AUDIO's length, which is what this measures.
 *
 * Usage: node scripts/make-long-audio-take.mjs <srcTake> <minutes> <outParentDir>
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

const [src, minutesArg, outParent] = process.argv.slice(2);
const minutes = Number(minutesArg);
if (!src || !existsSync(join(src, "anchors.json")) || !(minutes > 0) || !outParent) {
  console.error("usage: node scripts/make-long-audio-take.mjs <srcTake> <minutes> <outParentDir>");
  process.exit(2);
}
const take = join(outParent, `${basename(src)}-long${minutes}m`);
mkdirSync(take, { recursive: true });
// camera.mp4 too: anchors.json may claim a camera, and loadSession refuses a
// claimed camera with no file.
for (const f of ["anchors.json", "events.json", "display.mp4", "project.json", "camera.mp4"]) {
  if (existsSync(join(src, f))) cpSync(join(src, f), join(take, f));
}

const RATE = 48_000;
/** 16-bit PCM WAV, written in one-second blocks so an hour never sits in memory. */
function writeWav(path, channels, seconds) {
  const frames = RATE * seconds;
  const dataBytes = frames * channels * 2;
  const fd = openSync(path, "w");
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * channels * 2, 28); h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  writeSync(fd, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const block = Buffer.alloc(RATE * channels * 2);
  for (let s = 0; s < seconds; s++) {
    const speaking = s % 5 < 3; // 3 s of "speech", 2 s of pause
    for (let i = 0; i < RATE; i++) {
      const t = (s * RATE + i) / RATE;
      const v = (speaking ? 0.2 * Math.sin(2 * Math.PI * 220 * t) : 0) + 0.01 * rnd();
      for (let c = 0; c < channels; c++) block.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), (i * channels + c) * 2);
    }
    writeSync(fd, block);
  }
  closeSync(fd);
}

const seconds = Math.round(minutes * 60);
for (const [name, channels] of [["mic", 1], ["system", 2]]) {
  const wav = join(take, `${name}.wav`);
  writeWav(wav, channels, seconds);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac@48000", wav, join(take, `${name}.m4a`)], { stdio: "inherit" });
  rmSync(wav);
}

const a = JSON.parse(readFileSync(join(take, "anchors.json"), "utf8"));
const lastNs = 100_000_000 + seconds * 1e9 - Math.round((1024 * 1e9) / RATE);
a.version = Math.max(a.version, 6);
a.files = { ...a.files, mic: "mic.m4a", system: "system.m4a" };
a.mic = { present: true, device: "Synthetic", sampleRate: RATE, channels: 1, firstFramePtsNs: 100_000_000, lastFramePtsNs: lastNs };
a.system = { present: true, sampleRate: RATE, channels: 2, firstFramePtsNs: 100_000_000, lastFramePtsNs: lastNs };
writeFileSync(join(take, "anchors.json"), JSON.stringify(a, null, 2));
console.log(take);
