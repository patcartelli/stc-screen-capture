#!/usr/bin/env node
// Throwaway diagnostic (not part of the repo's own scripts), STC-233. Reads
// an exported mp4 (mp4-muxer output, NOT a captured session) and dumps its
// track structure via mp4box.js so a malformed container can be inspected
// without ffmpeg. Usage: node scripts/inspect-export.mjs <path-to-export.mp4>
import { readFileSync } from "node:fs";
import * as MP4BoxNS from "mp4box";

const MP4Box = MP4BoxNS.default ?? MP4BoxNS;

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-export.mjs <path-to-export.mp4>");
  process.exit(1);
}

const buf = readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
ab.fileStart = 0;

const file = MP4Box.createFile();
let sawReady = false;
let sawError = null;

file.onError = (e) => { sawError = e; };
file.onReady = (info) => {
  sawReady = true;
  console.log("=== mp4box info ===");
  console.log(JSON.stringify(info, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
};

file.appendBuffer(ab);
file.flush();

if (sawError) {
  console.log("mp4box onError:", sawError);
}
if (!sawReady && !sawError) {
  console.log("mp4box called neither onReady nor onError — the file never registered as readable at all.");
}

console.log("\n=== raw box walk ===");
// Low-level: list every top-level box and, for moov, every child, with size —
// this survives a file mp4box.js's own onReady refuses to fire for at all.
function walk(bytes, offset, depth, limit) {
  let o = offset;
  while (o < limit) {
    if (o + 8 > bytes.length) { console.log("  ".repeat(depth) + `(truncated at ${o}, buffer is ${bytes.length})`); break; }
    const view = new DataView(bytes.buffer, bytes.byteOffset + o, 8);
    let size = view.getUint32(0);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    let headerSize = 8;
    if (size === 1) {
      const big = new DataView(bytes.buffer, bytes.byteOffset + o + 8, 8);
      size = Number(big.getBigUint64(0));
      headerSize = 16;
    } else if (size === 0) {
      size = limit - o;
    }
    console.log("  ".repeat(depth) + `${type} size=${size} @${o}`);
    if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(type)) {
      walk(bytes, o + headerSize, depth + 1, o + size);
    }
    if (size <= 0) { console.log("  ".repeat(depth) + "(non-positive size, stopping)"); break; }
    o += size;
  }
}
walk(buf, 0, 0, buf.length);
