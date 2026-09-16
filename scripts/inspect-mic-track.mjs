#!/usr/bin/env node
// STC-233: diagnostic for the mic.m4a frame-offset disagreement
// ("mic.m4a frame-time offset disagreement: helper measured N ns, file
// yields 0 ns"). demux-audio.ts's edit-list reading is copied verbatim from
// demux.ts's video path, which works — this dumps the RAW mp4box structure
// for a real mic.m4a's audio track so the disagreement can be diagnosed from
// the actual file rather than reasoned about blind. Never merged into the
// transform; run by hand: `node scripts/inspect-mic-track.mjs <path-to-mic.m4a>`
import { readFileSync } from "node:fs";
import MP4BoxNS from "mp4box";

const MP4Box = MP4BoxNS.default ?? MP4BoxNS;
const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-mic-track.mjs <path-to-mic.m4a>");
  process.exit(1);
}

const buf = readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
ab.fileStart = 0;

const file = MP4Box.createFile();
file.onError = (e) => { console.error("mp4box error:", e); process.exit(1); };
file.onReady = (info) => {
  const track = info.audioTracks[0];
  if (!track) { console.error("no audio track found"); process.exit(1); }

  const trak = file.getTrackById(track.id);
  const movieTimescale = file.moov.mvhd.timescale;

  console.log("=== movie ===");
  console.log("moov.mvhd.timescale:", movieTimescale);

  console.log("\n=== audio track ===");
  console.log("track.id:", track.id);
  console.log("track.timescale:", track.timescale);
  console.log("track.codec:", track.codec);
  console.log("track.nb_samples:", track.nb_samples);
  console.log("track.duration:", track.duration);

  console.log("\n=== trak.edts (raw) ===");
  console.log(JSON.stringify(trak.edts, (k, v) => (k === "data" ? `<${v?.length ?? 0} bytes>` : v), 2));

  console.log("\n=== trak.tkhd (raw, first-sample-time-adjacent fields) ===");
  if (trak.tkhd) {
    console.log("tkhd.duration:", trak.tkhd.duration);
    console.log("tkhd.creation_time:", trak.tkhd.creation_time);
  } else {
    console.log("(no tkhd)");
  }

  const collected = [];
  file.onSamples = (_id, _user, samples) => {
    collected.push(...samples);
    if (collected.length < track.nb_samples) return;
    console.log("\n=== first 5 samples ===");
    for (const s of collected.slice(0, 5)) {
      console.log({ cts: s.cts, dts: s.dts, timescale: s.timescale, duration: s.duration });
    }
    console.log(`\n(${collected.length} samples total, cts range ${collected[0]?.cts} .. ${collected[collected.length - 1]?.cts})`);
    process.exit(0);
  };
  file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
  file.start();
};
file.appendBuffer(ab);
file.flush();
