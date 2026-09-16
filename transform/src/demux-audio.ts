import * as MP4BoxNS from "mp4box";

// mp4box ships CJS+ESM; normalize the default-export interop once — same as demux.ts.
const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

/**
 * The audio twin of demux.ts's `demuxTrack` (STC-233): mic.m4a's own sample
 * table, read the same way display.mp4/camera.mp4's is, so the audio track's
 * PTS grid is session-relative ns on the identical convention the video
 * tracks already use — no separate correction term for audio.
 *
 * A parallel implementation rather than a shared one: `demuxTrack` is
 * load-bearing, exercised by every gate in this repo, and this file's whole
 * subject (an mp4box audio track, an `esds` box instead of an `avcC` one) has
 * never run against a real browser from this checkout — see this repo's own
 * "the WGSL leg has never run on a GPU" precedent (STC-320). Generalising the
 * two into one function would have risked the untested half regressing the
 * proven one for a saving that is mostly boilerplate.
 */
export interface DemuxedAudio {
  /** source-sample PTS grid, session-relative integer ns */
  framesNs: number[];
  /** e.g. "mp4a.40.2" (AAC-LC) — what AudioDecoder.configure() wants as `codec` */
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig bytes, from the esds box — AudioDecoder.configure()'s `description` */
  description: Uint8Array;
  chunks: { timestampUs: number; data: Uint8Array }[];
}

export function demuxAudioTrack(buf: ArrayBuffer, what: string): Promise<DemuxedAudio> {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    let sawReady = false;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const fail = (msg: string) => finish(() => reject(new Error(msg)));

    // Same backstop demux.ts carries, same reason: mp4box signals a malformed
    // file by never calling back at all.
    const watchdog = setTimeout(
      () => fail(`timed out reading ${what} — the file may be truncated or not an MP4`),
      15_000,
    );

    file.onError = (e: unknown) => { clearTimeout(watchdog); fail(`mp4box reading ${what}: ${String(e)}`); };
    file.onReady = (info: any) => {
      sawReady = true;
      const track = info.audioTracks[0];
      if (!track) { clearTimeout(watchdog); fail(`no audio track in ${what}`); return; }

      // AudioSpecificConfig: the AAC decoder's own config bytes, nested two
      // descriptors deep in the esds box's ES_Descriptor
      // (DecoderConfigDescriptor -> DecoderSpecificInfo). mp4box.js exposes
      // this as `esds.esd.descs[0].descs[0].data` — the same "read the box,
      // strip nothing" idiom demux.ts uses for `avcC`, just one layer deeper
      // because esds is itself a descriptor tree rather than a flat box.
      const trak = file.getTrackById(track.id);
      const entries = trak.mdia.minf.stbl.stsd.entries;
      const esds = entries.map((e: any) => e.esds).find(Boolean);
      if (!esds) { clearTimeout(watchdog); fail(`no esds box in ${what}`); return; }
      const configDesc = esds.esd?.descs?.[0]?.descs?.[0];
      if (!configDesc?.data) { clearTimeout(watchdog); fail(`no AudioSpecificConfig in ${what}'s esds box`); return; }
      const description = new Uint8Array(configDesc.data);

      // Presentation time = media time + edit-list offset — identical
      // reasoning to demux.ts's video path: AVAssetWriter records the
      // start-to-first-sample gap as an empty edit, not a shifted CTS.
      const movieTimescale = file.moov.mvhd.timescale;
      const editOffsetNs = Math.round(
        (trak.edts?.elst?.entries ?? [])
          .filter((e: any) => e.media_time === -1)
          .reduce((sum: number, e: any) => sum + (e.segment_duration / movieTimescale) * 1_000_000_000, 0),
      );

      const collected: any[] = [];
      file.onSamples = (_id: number, _user: unknown, samples: any[]) => {
        collected.push(...samples);
        if (collected.length < track.nb_samples) return;
        // demux.ts's video twin asserts this SUM is already an integer, because
        // Capture.swift/CameraCapture.swift force mediaTimeScale to exactly
        // 1_000_000_000 on every video input, making scale === 1 always. Audio
        // cannot do that: AVFoundation rejects mediaTimeScale on any
        // audio-media-type input outright (the STC-233 crash this repo's own
        // CLAUDE.md records), so an AAC track's own sample grid is its CODEC
        // RATE — 48000 Hz here, 1024-sample frames — and cts*scale is a real
        // number on real hardware (cts=1024, timescale=48000 -> 21.333... ms).
        // Rounding is the right answer, not a refusal: the worst case is under
        // 1/48000 s (~20.8 us), two orders of magnitude inside session.ts's own
        // OFFSET_TOLERANCE_NS (50 us) and three inside this app's measured
        // camera<->mic sync tolerance (1.8 ms median, MicCapture.swift's header).
        const framesNs = collected.map((s) => {
          const scale = 1_000_000_000 / s.timescale;
          return Math.round(s.cts * scale + editOffsetNs);
        });
        clearTimeout(watchdog);
        finish(() => resolve({
          framesNs,
          codec: track.codec,
          sampleRate: track.audio?.sample_rate ?? 0,
          numberOfChannels: track.audio?.channel_count ?? 0,
          description,
          chunks: collected.map((s) => ({
            timestampUs: Math.round((s.cts * (1_000_000_000 / s.timescale) + editOffsetNs) / 1000),
            data: s.data as Uint8Array,
          })),
        }));
      };
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
    };
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    try {
      file.appendBuffer(ab);
      file.flush();
    } catch (e) {
      clearTimeout(watchdog);
      fail(`could not parse ${what}: ${String(e)}`);
      return;
    }

    if (!sawReady) {
      clearTimeout(watchdog);
      fail(`${what} is not a readable MP4 — no track information found`);
    }
  });
}
