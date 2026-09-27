import * as MP4BoxNS from "mp4box";
import { walkTopLevelBoxes } from "./mp4-boxes.js";
import type { ByteSource, VideoChunkRef } from "./chunk-reader.js";

// mp4box ships CJS+ESM; normalize the default-export interop once.
const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

/**
 * The one shared demux module (PHASE-1: sinks derive the frame PTS grid from
 * display.mp4's sample table via shared code — never from "latest decoded
 * frame" or per-sink parsing that could disagree).
 */
export interface DemuxedVideo {
  /** source-frame PTS grid, session-relative integer ns — this IS Session.frames */
  framesNs: number[];
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC payload for VideoDecoder.configure */
  description: Uint8Array;
  /** where each sample lives in the file; ChunkReader fetches the bytes (STC-236) */
  chunks: VideoChunkRef[];
  bytes: ByteSource;
}

/**
 * Reads the sample INDEX, never the samples (STC-236). Every top-level box is
 * handed to mp4box whole except an mdat, which gets only its header: mp4box
 * then skips to the next box, and builds trak.samples (offset, size, sync,
 * duration) from moov — plus every moof, for a crash-recovered fragmented
 * file. Measured on a real 46 MB take: 10.9 KB read, 740 samples, every
 * sample's bytes identical to the old whole-file demux.
 *
 * No watchdog any more. It existed because mp4box reports a malformed file by
 * never calling back; parsing is now driven by this loop, so that silence
 * shows up synchronously as "no track information found" after the last box.
 */
export async function demuxTrack(src: ByteSource, what: string): Promise<DemuxedVideo> {
  const walk = await walkTopLevelBoxes(src, what);

  const file = MP4Box.createFile();
  file.discardMdatData = true;
  let info: any;
  let parseError: string | null = null;
  file.onReady = (i: any) => { info = i; };
  file.onError = (e: unknown) => { parseError = String(e); };

  for (const b of walk.boxes) {
    const bytes = await src.read(b.offset, b.type === "mdat" ? b.headerSize : b.size);
    const ab = bytes.slice().buffer as ArrayBuffer & { fileStart: number };
    ab.fileStart = b.offset;
    try {
      file.appendBuffer(ab);
    } catch (e) {
      throw new Error(`could not parse ${what}: ${String(e)}`);
    }
  }
  file.flush();
  if (parseError) throw new Error(`mp4box reading ${what}: ${parseError}`);
  if (!info) throw new Error(`${what} is not a readable MP4 — no track information found`);

  const track = info.videoTracks[0];
  if (!track) throw new Error(`no video track in ${what}`);

  // avcC description: serialize the box, strip the 8-byte box header.
  // NB PHASE-0 §4b.5: DataStream must come off the module export in use.
  const trak = file.getTrackById(track.id);
  const entries = trak.mdia.minf.stbl.stsd.entries;
  const avcC = entries.map((e: any) => e.avcC).find(Boolean);
  if (!avcC) throw new Error(`no avcC box in ${what}`);
  const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  avcC.write(ds);
  const description = new Uint8Array(ds.buffer, 8, ds.position - 8);

  // Presentation time = media time + edit-list offset. AVAssetWriter records
  // the gap between "recording started" and "first frame arrived" as an
  // EMPTY EDIT (media_time -1) and leaves sample CTS starting at zero, so
  // reading the sample table alone reports every frame too early by that
  // gap. Measured at 231.7 ms on a real capture — about 14 frames of cursor
  // desync, small enough to look like a rendering bug rather than a clock one.
  const movieTimescale = file.moov.mvhd.timescale;
  //
  // Rounded, not exact: segment_duration is expressed in the MOVIE timescale
  // (600 Hz by default), which cannot represent an arbitrary nanosecond —
  // a real capture yielded 213333333.33... ns. Rounding is deterministic and
  // the residue is a constant sub-frame shift of the whole track, bounded by
  // half a movie tick. The writer raises the movie timescale to shrink that
  // bound; anchors.capture.firstFrameNs records the exact value the helper
  // measured, so the recovered offset can be checked rather than trusted.
  const editOffsetNs = Math.round(
    (trak.edts?.elst?.entries ?? [])
      .filter((e: any) => e.media_time === -1)
      .reduce((sum: number, e: any) => sum + (e.segment_duration / movieTimescale) * 1_000_000_000, 0),
  );

  // A crash-recovered file's last fragment can be cut short (the kill landed
  // inside it): its moof describes samples whose bytes never reached disk.
  // They are dropped — but only as a SUFFIX. A sample past EOF followed by one
  // inside it means the table itself is wrong, and a reader must never have to
  // guess which frames are trustworthy.
  const all = trak.samples as any[];
  let kept = all.findIndex((s) => s.offset + s.size > src.size);
  if (kept === -1) kept = all.length;
  if (all.slice(kept).some((s) => s.offset + s.size <= src.size)) {
    throw new Error(`${what}: sample ${kept} points past the end of the file but a later one does not — the sample table is corrupt`);
  }
  const samples = all.slice(0, kept);

  // Chained from durations, not read from each sample's own `cts`
  // (STC-394). A crash mid-recording leaves a fragmented file whose
  // FIRST fragment lives in the initial moov's own sample table (a
  // clean finish consolidates everything back into that same shape —
  // measured directly, a finished movieFragmentInterval file has no
  // moof boxes at all, which is why this bug is unreachable on the
  // normal-stop path) while every fragment AFTER the crash lives in a
  // real `moof`/`tfdt`. mp4box.js's own cross-fragment accumulation
  // (`first_traf_merged`) is keyed on having seen a `traf`, which the
  // stbl-derived first segment never is — so the FIRST real fragment's
  // `tfdt.baseMediaDecodeTime` (0) is read as an absolute base instead
  // of continuing the running total, and every sample from there on
  // reports a PTS reset back near zero. Reproduced directly: 181
  // recovered samples from a synthetic crash, `cts` resetting to 0
  // exactly at sample 61 (the first real fragment boundary) —
  // `helper/test/fragmented-writer.test.ts`.
  // Each sample's OWN `duration` is a per-sample delta, never an
  // accumulated base, so it is not subject to this reset — chaining
  // through it reconstructs the true grid regardless. `cts` alone (not
  // `dts`) still anchors the very first sample, and the two are
  // guaranteed equal throughout because the writer sets
  // `AVVideoAllowFrameReorderingKey: false` (no B-frames): decode order
  // is presentation order, so there is no composition offset to lose
  // by not reading it per-sample.
  let cumulative = samples.length ? (samples[0].cts as number) : 0;
  const framesNs = samples.map((s, i) => {
    if (i > 0) cumulative += samples[i - 1].duration;
    const scale = 1_000_000_000 / s.timescale;
    const pts = cumulative * scale + editOffsetNs;
    if (!Number.isInteger(pts)) throw new Error(`non-integer ns PTS: cts=${cumulative} timescale=${s.timescale}`);
    return pts;
  });

  return {
    framesNs,
    codec: track.codec,
    codedWidth: track.track_width,
    codedHeight: track.track_height,
    description,
    chunks: samples.map((s, i) => ({
      type: s.is_sync ? "key" : "delta",
      timestampUs: Math.round(framesNs[i]! / 1000),
      offset: s.offset as number,
      size: s.size as number,
    })),
    bytes: src,
  };
}
